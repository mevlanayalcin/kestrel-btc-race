# Kestrel BTC Race (`kestrel-btc-race`)

[![Competition](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/competitions/btc-race-24h-20261123-0511)
[![Rank](https://make.fun/badge/btc-race-24h-20261123-0511/mevlanayalcin/kestrel-btc-race/rank.svg)](https://make.fun/competitions/btc-race-24h-20261123-0511)
[![Reward](https://make.fun/badge/btc-race-24h-20261123-0511/mevlanayalcin/kestrel-btc-race/reward.svg)](https://make.fun/competitions/btc-race-24h-20261123-0511)

Deterministic, long-only `cbBTC/USDC` 1-minute trading bot built for the [make.fun 24-Hour Live BTC Race (`btc-race-24h-20261123-0511`)](https://make.fun/competitions/btc-race-24h-20261123-0511) on `agent-fun/bars-replay/v1`.

## Strategy Architecture

`kestrel-btc-race` combines a two-regime alpha core with constant-product pool-depth execution slicing tailored to Orca Whirlpool `cbBTC/USDC` (`4 bps` swap fee + `2 bps` slippage + `a / D` price impact):

1. **Vol-Scaled Liquidation-Flush Reversion (`LFR`):** Detects rapid 60m–180m downside dislocations scaled to 60-minute realized volatility (`vol60`), waits for multi-bar stabilization and rebound confirmation off the 15-minute low to avoid catching falling knives, and holds for mean-reversion recovery with a catastrophe stop, profit-gated trailing stop, and a hard daily LFR stop-out cap.
2. **Session-Filtered Structural Impulse Breakout (`SIB`):** Enters confirmed directional breakouts above session open and session TWAP with high Kaufman efficiency ratio (`ER`) near 120-minute highs, riding trend expansion with a profit-tightening trailing stop and avoiding dead-cat bounces in downtrends.
3. **Depth-Adaptive TWAP Execution (`<= 0.6–0.8 bps` impact/bar):** Slices entries, exits, and end-of-window unwinds across consecutive bars proportionally to live `c_depth`, cutting constant-product round-trip impact by >85% compared to single-bar full-size execution.
4. **Hard Risk & Eligibility Guards:** Enforces an 8% daily drawdown circuit breaker (well below the 25% guardrail), resilient missing-bar handling, and a bounded late-window compliance probe if no high-conviction signal triggered during a flat or straight-down session.

## Local Execution & Verification

- Runtime: Node 22 (`node main.ts`), zero external dependencies, byte-identical vendored `vendor/makefun-bars.ts`.
- Strictly deterministic: no wall clock, no randomness, no network, no external filesystem access.
- License: MIT (`SPDX-License-Identifier: MIT`).
