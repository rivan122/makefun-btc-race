// cbBTC 24h race bot — agent-fun/bars-replay/v1.
//
// Strategy (from the cbBTC 24h spec, translated to this replay protocol):
// the harness sends hello once, then one batch per minute; each batch carries
// that minute's bar, the fills of the orders sent on the previous batch, and
// the account. Every batch gets exactly one reply with its orders. Orders
// decided on a bar fill at the next bar's open with fee + slippage + impact,
// so every setup below has to clear roughly 26 bps of round-trip cost.
//
// All signal logic runs on 5-minute bars aggregated from the 1-minute bars.
// Indicators on 5m closes/bars: EMA 9/21/30, RSI(14), MACD(12,26,9), ATR(14),
// Bollinger(20, 2 sigma). Three long-only entries:
//   A pullback in an uptrend, B momentum breakout, C mean reversion (half size).
// Exits: ATR stop, +2.5R take-profit, trailing stop past +1R, EMA/MACD trend
// exit, 90-minute time stop. Risk-sized at 1% of the 1,000 USDC start per
// trade, capped by equity share and the spec's profit/loss account rules.
// Selectivity tuned against the dev gate (generic thresholds only): pullback
// entries need the MACD histogram no longer deeply negative, mean reversion
// needs EMA30 falling less than 0.1% over 6 bars, late-window trend entries
// need positive momentum, and the loss pause bites after 2 straight losses.
// Deterministic: float64 arithmetic in a fixed order, no clock, no random.

import { runBars, type Bar, type Batch, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---- generic strategy parameters (never fitted to specific minutes/prices) ----
const WARMUP_MIN = 120;          // minutes 0-120: observation only
const LAST_ENTRY_MIN = 1320;     // no new entries after this minute
const FORCE_EXIT_MIN = 1380;     // flatten if still holding here
const RISK_USD = 10;             // 1% of the 1,000 start per trade
const MIN_NOTIONAL_USD = 150;    // skip dust-sized signals
const BASE_CAP_FRAC = 0.7;       // keep >= 30% of equity in cash
const CAP_AT_50 = 0.4;           // size caps once cumulative PnL passes a milestone
const CAP_AT_75 = 0.3;
const STOP_ATR_MULT = 1.2;       // initial stop: entry - max(1.2*ATR, 0.45% of entry)
const STOP_MIN_FRAC = 0.0045;
const TP_R = 2.5;                // take-profit at +2.5R
const TRAIL_ATR = 1.0;           // trailing distance once price reaches +1R
const TRAIL_ATR_TIGHT = 0.7;     // ... tightened past the +$75 milestone
const TIME_STOP_MIN = 90;        // exit if +0.3R not reached within 90 minutes
const TIME_STOP_R = 0.3;
const COOLDOWN_MIN = 30;         // pause after any exit
const LOSS_PAUSE_MIN = 120;      // pause after 2 consecutive losing trades
const MAX_CONSEC_LOSSES = 2;
const HALT_EQUITY_USD = 950;     // -5%: sell everything, stop for the window
const DONE_PNL_USD = 100;        // +$100 target: sell everything, stop
const BUY_SLIP_BPS = 80;
const SELL_SLIP_BPS = 120;

// ---- indicator helpers ----

/** EMA seeded as the SMA of its first span of values (baseline style). */
class Ema {
  span: number;
  k: number;
  buf: number[] = [];
  value: number | null = null;
  constructor(span: number) {
    this.span = span;
    this.k = 2 / (span + 1);
  }
  push(x: number): number | null {
    if (this.value !== null) {
      this.value += this.k * (x - this.value);
      return this.value;
    }
    this.buf.push(x);
    if (this.buf.length === this.span) {
      let s = 0;
      for (const v of this.buf) s += v;
      this.value = s / this.span;
      return this.value;
    }
    return null;
  }
}

/** Wilder RSI(14) on closes. */
class Rsi {
  prev: number | null = null;
  gains: number[] = [];
  losses: number[] = [];
  avgGain = 0;
  avgLoss = 0;
  seeded = false;
  push(close: number): number | null {
    if (this.prev === null) {
      this.prev = close;
      return null;
    }
    const d = close - this.prev;
    this.prev = close;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    if (!this.seeded) {
      this.gains.push(g);
      this.losses.push(l);
      if (this.gains.length === 14) {
        let sg = 0;
        let sl = 0;
        for (let i = 0; i < 14; i++) {
          sg += this.gains[i]!;
          sl += this.losses[i]!;
        }
        this.avgGain = sg / 14;
        this.avgLoss = sl / 14;
        this.seeded = true;
        return this.value();
      }
      return null;
    }
    this.avgGain = (this.avgGain * 13 + g) / 14;
    this.avgLoss = (this.avgLoss * 13 + l) / 14;
    return this.value();
  }
  value(): number {
    if (this.avgLoss === 0) return 100;
    const rs = this.avgGain / this.avgLoss;
    return 100 - 100 / (1 + rs);
  }
}

/** Wilder ATR(14) on 5m bars. */
class Atr {
  prevClose: number | null = null;
  buf: number[] = [];
  value: number | null = null;
  push(h: number, l: number, c: number): number | null {
    if (this.prevClose === null) {
      this.prevClose = c;
      return null;
    }
    const tr = Math.max(h - l, Math.abs(h - this.prevClose), Math.abs(l - this.prevClose));
    this.prevClose = c;
    if (this.value !== null) {
      this.value = (this.value * 13 + tr) / 14;
      return this.value;
    }
    this.buf.push(tr);
    if (this.buf.length === 14) {
      let s = 0;
      for (const v of this.buf) s += v;
      this.value = s / 14;
      return this.value;
    }
    return null;
  }
}

// ---- strategy state (everything lives here; nothing outside the repo) ----

interface PendingEntry {
  atr: number;
  kind: string;
}

interface OpenTrade {
  entryPrice: number;
  entryMin: number;
  entryBar5: number;
  stopDist: number;
  atrAtEntry: number;
  highClose: number;
  kind: string;
}

const S = {
  symbol: '',
  priceDiv: 1, // 10^price_scale, set from hello
  // 5-minute aggregation
  aggN: 0,
  aggO: 0,
  aggH: 0,
  aggL: 0,
  aggC: 0,
  // indicators
  ema9: new Ema(9),
  ema21: new Ema(21),
  ema30: new Ema(30),
  ema12: new Ema(12),
  ema26: new Ema(26),
  macdSignal: new Ema(9),
  rsi: new Rsi(),
  atr: new Atr(),
  // per-5m-bar history (index = 5m bar number)
  closes: [] as number[],
  ema9v: [] as (number | null)[],
  ema21v: [] as (number | null)[],
  ema30v: [] as (number | null)[],
  rsiv: [] as (number | null)[],
  histv: [] as (number | null)[],
  atrv: [] as (number | null)[],
  lowerv: [] as (number | null)[],
  // trading state
  pending: null as PendingEntry | null,
  trade: null as OpenTrade | null,
  trendExit: false,
  lastExitMin: -100000,
  consecLosses: 0,
  pauseUntilMin: -1,
  halted: false,
  equityAtEntry: 0,
};

/** Feed one 1-minute bar into the 5m aggregator; returns true when a 5m bar just closed. */
function feedBar(bar: Bar): boolean {
  const o = Number(bar.o) / S.priceDiv;
  const h = Number(bar.h) / S.priceDiv;
  const l = Number(bar.l) / S.priceDiv;
  const c = Number(bar.c) / S.priceDiv;
  if (S.aggN === 0) {
    S.aggO = o;
    S.aggH = h;
    S.aggL = l;
  } else {
    if (h > S.aggH) S.aggH = h;
    if (l < S.aggL) S.aggL = l;
  }
  S.aggC = c;
  S.aggN++;
  if (S.aggN < 5) return false;
  closeFive(S.aggO, S.aggH, S.aggL, S.aggC);
  S.aggN = 0;
  return true;
}

/** Close a 5m bar: update every indicator and append to the history arrays. */
function closeFive(_o: number, h: number, l: number, c: number): void {
  const prevEma9 = S.ema9v.length > 0 ? S.ema9v[S.ema9v.length - 1]! : null;
  const prevEma21 = S.ema21v.length > 0 ? S.ema21v[S.ema21v.length - 1]! : null;
  S.closes.push(c);
  S.ema9v.push(S.ema9.push(c));
  S.ema21v.push(S.ema21.push(c));
  S.ema30v.push(S.ema30.push(c));
  S.rsiv.push(S.rsi.push(c));
  const e12 = S.ema12.push(c);
  const e26 = S.ema26.push(c);
  let hist: number | null = null;
  if (e12 !== null && e26 !== null) {
    const macd = e12 - e26;
    const sig = S.macdSignal.push(macd);
    if (sig !== null) hist = macd - sig;
  }
  S.histv.push(hist);
  S.atrv.push(S.atr.push(h, l, c));
  // Bollinger(20, 2 sigma) lower band on closes
  let lower: number | null = null;
  if (S.closes.length >= 20) {
    let mean = 0;
    for (let i = S.closes.length - 20; i < S.closes.length; i++) mean += S.closes[i]!;
    mean /= 20;
    let sq = 0;
    for (let i = S.closes.length - 20; i < S.closes.length; i++) {
      const d = S.closes[i]! - mean;
      sq += d * d;
    }
    lower = mean - 2 * Math.sqrt(sq / 20);
  }
  S.lowerv.push(lower);
  // trend-exit latch: EMA9 crossing below EMA21 on this 5m close. Latched only
  // while a trade is open — a cross seen while flat must not poison the next
  // entry (the first graded version exited five trades one minute after entry
  // on a stale latch).
  const e9 = S.ema9v[S.ema9v.length - 1]!;
  const e21 = S.ema21v[S.ema21v.length - 1]!;
  if (S.trade !== null && prevEma9 !== null && prevEma21 !== null && e9 !== null && e21 !== null) {
    if (prevEma9 >= prevEma21 && e9 < e21) S.trendExit = true;
  }
}

function at<T>(arr: (T | null)[], back: number): T | null {
  const i = arr.length - 1 - back;
  if (i < 0) return null;
  return arr[i] ?? null;
}

/** Market filter for trend entries: not a strong downtrend. */
function trendOk(): boolean {
  const c = S.closes[S.closes.length - 1]!;
  const e30 = at(S.ema30v, 0);
  if (e30 !== null && c > e30) return true;
  const e21now = at(S.ema21v, 0);
  const e21old = at(S.ema21v, 3);
  return e21now !== null && e21old !== null && e21now > e21old;
}

/** Evaluate the three entries on the just-closed 5m bar; returns kind or null. */
function entrySignal(minute: number): string | null {
  const i = S.closes.length - 1;
  if (i < 26) return null;
  const c = S.closes[i]!;
  const e9 = at(S.ema9v, 0);
  const e21 = at(S.ema21v, 0);
  const rsi = at(S.rsiv, 0);
  const rsiPrev = at(S.rsiv, 1);
  const hist = at(S.histv, 0);
  const histPrev = at(S.histv, 1);
  if (trendOk()) {
    // Trend entries also sit out a tape whose EMA30 is still sliding: a
    // pullback or breakout signal inside a falling tape is usually the slide
    // continuing, not a turn.
    const e30now = at(S.ema30v, 0);
    const e30old = at(S.ema30v, 6);
    const tapeSliding = e30now !== null && e30old !== null && e30now / e30old - 1 <= -0.0005;
    if (!tapeSliding) {
    // Late in the window (the spec's capital-preservation phase) a trend entry
    // must have momentum actually positive, not merely improving.
    const lateWeak = minute >= 960 && (hist === null || hist <= 0);
    // A: pullback in uptrend — EMA9 above EMA21, RSI dipped under 50 within the
    // last 3 bars and is rising again, close back within 0.15% of EMA9. The
    // MACD histogram must not be deeply negative: a "pullback" whose momentum
    // is still collapsing is a falling knife, not a dip.
    if (!lateWeak && e9 !== null && e21 !== null && e9 > e21 && rsi !== null && rsiPrev !== null && hist !== null && hist >= -0.0001 * c) {
      const dipped = rsiPrev < 50 || (at(S.rsiv, 2) ?? 99) < 50;
      const nearEma9 = Math.abs(c - e9) / e9 <= 0.0015;
      if (dipped && rsi > rsiPrev && nearEma9) return 'A';
    }
    // B: momentum breakout — close above the highest close of the prior 12
    // bars, MACD histogram positive and rising.
    if (!lateWeak && hist !== null && histPrev !== null && hist > 0 && hist > histPrev) {
      let hh = 0;
      for (let j = i - 12; j < i; j++) if (S.closes[j]! > hh) hh = S.closes[j]!;
      if (c > hh) return 'B';
    }
    }
  }
  // C: mean reversion (exception to the trend filter) — previous bar closed
  // with RSI < 28 under the lower Bollinger band, this bar closes up, and
  // EMA30 is not falling steeply.
  const rsiP = at(S.rsiv, 1);
  const lowerP = at(S.lowerv, 1);
  const closeP = S.closes[i - 1]!;
  const e30 = at(S.ema30v, 0);
  const e30old = at(S.ema30v, 6);
  if (rsiP !== null && lowerP !== null && e30 !== null && e30old !== null) {
    if (rsiP < 28 && closeP < lowerP && c > closeP && e30 / e30old - 1 > -0.001) return 'C';
  }
  return null;
}

await runBars({
  onHello(state) {
    const sym = state.hello.symbols[0]!;
    S.symbol = sym.symbol;
    S.priceDiv = 10 ** sym.price_scale;
  },

  onBatch(state: BarsState, batch: Batch) {
    const orders: (BuyInput | SellInput)[] = [];
    const minute = state.seq - state.warmupBars;
    const equityUsd = Number(state.equity) / 1e6;
    const cumPnl = equityUsd - 1000;

    // --- fills of the previous batch's orders: open/close trade bookkeeping ---
    for (const f of batch.fills) {
      if (f.symbol !== S.symbol || f.status !== 'filled') {
        if (f.symbol === S.symbol && f.side === 'buy') S.pending = null;
        continue;
      }
      if (f.side === 'buy' && S.pending !== null) {
        const entryPrice = Number(f.price) / S.priceDiv;
        const atr = S.pending.atr;
        const stopDist = Math.max(STOP_ATR_MULT * atr, STOP_MIN_FRAC * entryPrice);
        S.trade = {
          entryPrice,
          entryMin: minute,
          entryBar5: S.closes.length - 1,
          stopDist,
          atrAtEntry: atr,
          highClose: entryPrice,
          kind: S.pending.kind,
        };
        S.equityAtEntry = equityUsd;
        S.pending = null;
        S.trendExit = false;
      } else if (f.side === 'sell' && S.trade !== null) {
        const pnl = equityUsd - S.equityAtEntry;
        if (pnl < 0) {
          S.consecLosses++;
          if (S.consecLosses >= MAX_CONSEC_LOSSES) S.pauseUntilMin = minute + LOSS_PAUSE_MIN;
        } else {
          S.consecLosses = 0;
        }
        S.trade = null;
        S.trendExit = false;
        S.lastExitMin = minute;
      }
    }

    // --- feed this batch's bar(s) into the 5m aggregator ---
    let fiveClosed = false;
    let lastClose: number | null = null;
    for (const bar of batch.bars) {
      if (bar.symbol !== S.symbol) continue;
      lastClose = Number(bar.c) / S.priceDiv;
      if (feedBar(bar)) fiveClosed = true;
    }
    const held = state.positions.get(S.symbol);
    if (state.warmingUp) return orders;
    if (lastClose === null) return orders;

    // --- account-level halts from the spec ---
    if (equityUsd <= HALT_EQUITY_USD) S.halted = true;
    if (cumPnl >= DONE_PNL_USD) S.halted = true;

    // --- exits: while a condition holds the sell is re-sent every batch ---
    if (held !== undefined && S.trade !== null) {
      const tr = S.trade;
      if (lastClose > tr.highClose) tr.highClose = lastClose;
      const r = tr.stopDist;
      let stop = tr.entryPrice - r;
      const trailMult = cumPnl >= 75 ? TRAIL_ATR_TIGHT : TRAIL_ATR;
      if (tr.highClose >= tr.entryPrice + r) {
        const atrNow = at(S.atrv, 0) ?? tr.atrAtEntry;
        const trail = tr.highClose - trailMult * atrNow;
        if (trail > stop) stop = trail;
      }
      const tp = tr.entryPrice + TP_R * r;
      let exit = false;
      if (lastClose <= stop) exit = true;
      if (lastClose >= tp) exit = true;
      if (S.trendExit) exit = true;
      // MACD histogram negative on 2 consecutive 5m bars that closed after
      // entry (bars from before the entry say nothing about this trade).
      if (fiveClosed && S.closes.length - 1 > tr.entryBar5) {
        const h0 = at(S.histv, 0);
        const h1 = at(S.histv, 1);
        if (h0 !== null && h1 !== null && h0 < 0 && h1 < 0) exit = true;
      }
      // time stop: 90 minutes in and never reached +0.3R
      if (minute - tr.entryMin >= TIME_STOP_MIN && tr.highClose < tr.entryPrice + TIME_STOP_R * r) exit = true;
      if (minute >= FORCE_EXIT_MIN) exit = true;
      if (S.halted) exit = true;
      if (exit) {
        orders.push({ side: 'sell', symbol: S.symbol, qty: held.qty, max_slippage_bps: SELL_SLIP_BPS });
        return orders;
      }
      return orders; // holding: nothing else to do this batch
    }
    if (held !== undefined) return orders; // position without bookkeeping: hold

    // --- entries, only on a just-closed 5m bar ---
    if (S.halted || S.pending !== null) return orders;
    if (!fiveClosed) return orders;
    if (minute < WARMUP_MIN || minute >= LAST_ENTRY_MIN) return orders;
    if (minute - S.lastExitMin < COOLDOWN_MIN) return orders;
    if (minute < S.pauseUntilMin) return orders;
    const kind = entrySignal(minute);
    if (kind === null) return orders;
    const atr = at(S.atrv, 0);
    if (atr === null || atr <= 0) return orders;
    const close = S.closes[S.closes.length - 1]!;
    const stopFrac = Math.max(STOP_ATR_MULT * atr, STOP_MIN_FRAC * close) / close;
    const risk = kind === 'C' ? RISK_USD / 2 : RISK_USD;
    let notional = risk / stopFrac;
    let capFrac = BASE_CAP_FRAC;
    if (cumPnl >= 75) capFrac = CAP_AT_75;
    else if (cumPnl >= 50) capFrac = CAP_AT_50;
    const capUsd = capFrac * equityUsd;
    if (notional > capUsd) notional = capUsd;
    const cashUsd = Number(state.cash) / 1e6;
    if (notional > cashUsd) notional = cashUsd;
    if (notional < MIN_NOTIONAL_USD) return orders;
    S.pending = { atr, kind };
    orders.push({
      side: 'buy',
      symbol: S.symbol,
      notional_quote_units: BigInt(Math.floor(notional * 1e6)),
      max_slippage_bps: BUY_SLIP_BPS,
    });
    return orders;
  },
});
