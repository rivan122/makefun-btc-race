# cbBTC 24h Race Bot

![competition](https://make.fun/badge/btc-race-24h-20261118-1444.svg)
![rank](https://make.fun/badge/btc-race-24h-20261118-1444/rivan122/makefun-btc-race/rank.svg)
![reward](https://make.fun/badge/btc-race-24h-20261118-1444/rivan122/makefun-btc-race/reward.svg)

Entry for [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261118-1444) on make.fun.

## Strategy

A selective, long-only cbBTC/USDC bot that speaks `agent-fun/bars-replay/v1`
(hello once, then one batch per minute; orders decided on a bar fill at the
next bar's open). All signals run on 5-minute bars aggregated from the
1-minute bars, using EMA 9/21/30, RSI(14), MACD(12,26,9), ATR(14) and
Bollinger(20, 2σ):

- **A — pullback in uptrend:** EMA9 above EMA21, RSI dipped below 50 within
  the last 3 bars and rising again, close back within 0.15% of EMA9.
- **B — momentum breakout:** close above the highest close of the prior 12
  bars with a positive, rising MACD histogram.
- **C — mean reversion (half size):** RSI below 28 under the lower Bollinger
  band, confirmed by an up close, while EMA30 is not falling steeply.

Trend entries require the tape not to be in a strong downtrend (close above
EMA30 or EMA21 rising, EMA30 not sliding, MACD histogram not deeply negative
on pullbacks, and positive momentum after minute 960). Positions are
risk-sized at 1% of the 1,000 USDC start against an ATR stop (entry −
max(1.2×ATR, 0.45%)), take profit at +2.5R, trail at 1×ATR past +1R, and exit
on an EMA9/EMA21 cross down, two negative MACD histogram bars, or a
90-minute time stop. Account rules: flat the first 2 hours, no entries after
minute 1320, flatten by minute 1380, 30-minute cooldown after exits, a
120-minute pause after 2 consecutive losses, size caps at the +$50/+$75
profit milestones, and a full stop at −5% equity or +$100 net PnL. Fully
deterministic: no clock, no network, no randomness.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib only).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK shim.
