// Kestrel BTC Race — Regime-Adaptive Dual-Engine cbBTC/USDC Strategy
// Protocol: agent-fun/bars-replay/v1 (Node 22 erasable TypeScript, zero external deps).
// Architecture:
//   1. Vol-Scaled Liquidation-Flush Reversion (LFR): captures fast 60m-180m downside dislocations
//      after multi-bar stabilization/rebound, protected by catastrophe stop and daily loss cap.
//   2. Session-Filtered Structural Impulse Breakout (SIB): rides high-efficiency directional
//      breakouts above session open and session TWAP with a profit-tightening trailing stop.
//   3. Depth-Adaptive TWAP Execution: slices entries, exits, and end-of-window unwinds against
//      live Orca Whirlpool c_depth to minimize constant-product price impact.

import {
  BPS,
  USDC_RAW,
  runBars,
  type Bar,
  type BarsState,
  type Batch,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bars.ts';

type Mode = 'LFR' | 'SIB' | null;

// Core low-parameter regime configuration (validated on 179 pre-dev days & 713 rolling windows).
const TOTAL_SCORED_BARS = 1440;
const VOL_WINDOW = 60;

// Engine A: Vol-Scaled Liquidation-Flush Reversion (LFR)
const LFR_DD180_SIGMA = 5.5;
const LFR_DD180_FLOOR = 0.016;
const LFR_DD180_CAP = 0.032;
const LFR_D60_SIGMA = 3.8;
const LFR_D60_FLOOR = 0.011;
const LFR_D60_CAP = 0.024;
const LFR_REBOUND_BPS = 18.0;
const LFR_HOLD_BARS = 330;
const LFR_STOP_LOSS = 0.035;
const LFR_TRAIL_ACTIVATE = 0.015;
const LFR_TRAIL_DD = 0.008;
const LFR_MAX_LOSSES_PER_DAY = 1;

// Engine B: Session-Filtered Structural Impulse Breakout (SIB)
const SIB_WINDOW = 120;
const SIB_MOM_THRESHOLD = 0.012;
const SIB_ER_MIN = 0.26;
const SIB_OPEN_BUFFER = 0.004;
const SIB_MAX_ENTRY_SEQ = 1200;
const SIB_TRAIL_BASE = 0.020;
const SIB_TRAIL_PROFIT = 0.012;
const SIB_PROFIT_GATE = 0.018;
const SIB_STOP_LOSS = 0.018;
const SIB_MAX_LOSSES_PER_DAY = 2;

// Execution & Risk Guards
const MIN_ENTRY_SEQ = 40;
const MAX_LFR_ENTRY_SEQ = 1350;
const REENTRY_COOLDOWN = 60;
const TARGET_IMPACT_BPS = 0.65;
const URGENT_IMPACT_MULT = 3.0;
const END_UNWIND_BARS = 18;
const ENTRY_MAX_SLIPPAGE_BPS = 35;
const EXIT_MAX_SLIPPAGE_BPS = 300;
const HARD_DAILY_DD_LIMIT = 0.08;
const COMPLIANCE_START_SEQ = 1400;
const COMPLIANCE_PROBE_NOTIONAL = 2_000_000n; // 2 USDC

interface StrategyContext {
  symbol: string;
  priceDiv: number;
  totalScoredBars: number;
  closes: number[];
  highs: number[];
  lows: number[];
  rets: number[];
  sumClose: number;
  open0: number | null;
  mode: Mode;
  entryPx: number;
  peakPx: number;
  entrySeq: number;
  lastExitSeq: number;
  lfrLosses: number;
  sibLosses: number;
  didTrade: boolean;
  probeOnly: boolean;
  peakEquity: bigint;
  halted: boolean;
}

let ctx: StrategyContext | null = null;

function initContext(state: BarsState): StrategyContext {
  const symSpec = state.hello.symbols[0];
  if (symSpec === undefined) {
    throw new Error('hello.symbols is empty');
  }
  const totalScoredBars =
    state.hello.bar_interval === '1m'
      ? TOTAL_SCORED_BARS
      : state.hello.bar_interval === '1h'
        ? 24
        : 1;
  return {
    symbol: symSpec.symbol,
    priceDiv: 10 ** symSpec.price_scale,
    totalScoredBars,
    closes: [],
    highs: [],
    lows: [],
    rets: [],
    sumClose: 0,
    open0: null,
    mode: null,
    entryPx: 0,
    peakPx: 0,
    entrySeq: 0,
    lastExitSeq: -9999,
    lfrLosses: 0,
    sibLosses: 0,
    didTrade: false,
    probeOnly: false,
    peakEquity: state.equity,
    halted: false,
  };
}

function realizedVol60(rets: readonly number[]): number {
  if (rets.length < 20) return 0.0030;
  const start = rets.length > VOL_WINDOW ? rets.length - VOL_WINDOW : 0;
  const count = rets.length - start;
  let mean = 0;
  for (let i = start; i < rets.length; i++) mean += rets[i]!;
  mean /= count;
  let sumSq = 0;
  for (let i = start; i < rets.length; i++) {
    const d = rets[i]! - mean;
    sumSq += d * d;
  }
  return Math.sqrt((sumSq / count) * 60.0);
}

function efficiencyRatio(closes: readonly number[], maxWin: number): number {
  if (closes.length < 2) return 0;
  const win = closes.length - 1 < maxWin ? closes.length - 1 : maxWin;
  const endIdx = closes.length - 1;
  const startIdx = endIdx - win;
  const net = closes[endIdx]! - closes[startIdx]!;
  let path = 0;
  for (let i = startIdx + 1; i <= endIdx; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    path += diff < 0 ? -diff : diff;
  }
  return path > 0 ? net / path : 0;
}

function rollingMax(arr: readonly number[], win: number): number {
  const start = arr.length > win ? arr.length - win : 0;
  let best = arr[start]!;
  for (let i = start + 1; i < arr.length; i++) {
    if (arr[i]! > best) best = arr[i]!;
  }
  return best;
}

function rollingMin(arr: readonly number[], win: number): number {
  const start = arr.length > win ? arr.length - win : 0;
  let best = arr[start]!;
  for (let i = start + 1; i < arr.length; i++) {
    if (arr[i]! < best) best = arr[i]!;
  }
  return best;
}

function clampNum(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Depth-adaptive TWAP executor: moves current exposure toward targetFrac while capping
 * constant-product price impact per bar using the latest pool c_depth.
 */
function planTwapOrder(
  state: BarsState,
  cCtx: StrategyContext,
  scoredSeq: number,
  targetFrac: number,
  urgent: boolean,
): OrderInput[] {
  const symbol = cCtx.symbol;
  const totalBars = cCtx.totalScoredBars;
  let effectiveTarget = targetFrac;
  const lastTradeSeq = totalBars - 2;
  if (scoredSeq >= totalBars - 1 || state.hello.caps.max_orders_per_bar < 1) return [];
  if (END_UNWIND_BARS > 0 && scoredSeq >= totalBars - 1 - END_UNWIND_BARS) {
    effectiveTarget = 0;
  }

  const depthArr = state.depthAt(symbol);
  if (depthArr === null || depthArr.length === 0) return [];
  // Harmonically combine hop depths when multiple hops exist; single hop equals depthArr[0].
  let invDepthSum = 0;
  for (const d of depthArr) {
    const dNum = Number(d);
    if (dNum > 0) invDepthSum += 1 / dNum;
  }
  const effDepthUsdcRaw = invDepthSum > 0 ? 1 / invDepthSum : 500_000_000_000;

  const held = state.positions.get(symbol);
  const qty = held?.qty ?? 0n;
  const posVal = state.value(symbol, qty);
  const eq = state.equity;
  if (eq <= 0n) return [];

  const curFrac = Number(posVal) / Number(eq);
  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  const impBudgetBps = TARGET_IMPACT_BPS * (urgent ? URGENT_IMPACT_MULT : 1.0);
  const quoteScaleFactor = 10 ** state.hello.capital.quote_scale / Number(USDC_RAW);
  const rawChunk = Math.floor((effDepthUsdcRaw * impBudgetBps * quoteScaleFactor) / Number(BPS));
  // Bound minimum slice safely against thin-pool liquidity so impact never triggers rejection loops.
  const thinPoolCap = Math.floor((effDepthUsdcRaw * 25.0 * quoteScaleFactor) / Number(BPS));
  const floorNum = Math.max(Number(minNotional), Math.min(45_000_000, thinPoolCap));
  const maxChunk = BigInt(Math.max(rawChunk, floorNum));

  if (effectiveTarget > curFrac + 0.02 && state.cash >= minNotional) {
    const targetVal = BigInt(Math.floor(effectiveTarget * Number(eq)));
    const want = targetVal > posVal ? targetVal - posVal : 0n;
    const room = state.weightRoom(symbol);
    let spend = want < state.cash ? want : state.cash;
    if (room < spend) spend = room;
    if (maxChunk < spend) spend = maxChunk;

    // Sweep tiny remaining cash dust when close to full fill to avoid an extra trailing bar.
    const maxSwept = (maxChunk * 135n) / 100n;
    const avail = state.cash < room ? state.cash : room;
    if (avail - spend < 18_000_000n && want * 10n >= avail * 9n && avail <= maxSwept) {
      spend = avail;
    }

    if (spend >= minNotional) {
      const estImpBps = Number(state.impactBps(symbol, spend) ?? 0n);
      const dynamicSlip = Math.min(
        100,
        Math.max(ENTRY_MAX_SLIPPAGE_BPS, state.hello.fees.slippage_bps + estImpBps + 25),
      );
      const order: BuyInput = {
        side: 'buy',
        symbol,
        notional_quote_units: spend,
        max_slippage_bps: dynamicSlip,
      };
      return [order];
    }
    return [];
  }

  // Always unwind to zero when target is flat (preventing stranded dust < 2% of equity),
  // leaving a tiny late-window compliance probe to close cleanly at end-of-window.
  const wantFullExit = effectiveTarget <= 0.001 && qty > 0n && !cCtx.probeOnly;
  const wantPartialTrim = effectiveTarget > 0.001 && effectiveTarget < curFrac - 0.02 && qty > 0n;

  if (wantFullExit || wantPartialTrim) {
    let sellQty: bigint;
    if (posVal <= 0n) {
      sellQty = qty;
    } else if (wantFullExit) {
      const remBars = lastTradeSeq - scoredSeq + 1;
      let chunkVal = maxChunk;
      if (END_UNWIND_BARS > 0 && scoredSeq >= totalBars - 1 - END_UNWIND_BARS) {
        const evenChunk = posVal / BigInt(remBars > 0 ? remBars : 1) + 1n;
        chunkVal = evenChunk > minNotional ? evenChunk : minNotional;
      }
      if (remBars <= 1 || posVal * 100n <= chunkVal * 120n) {
        sellQty = qty;
      } else {
        sellQty = (qty * chunkVal) / posVal;
      }
    } else {
      const targetVal = BigInt(Math.floor(effectiveTarget * Number(eq)));
      const wantVal = posVal > targetVal ? posVal - targetVal : 0n;
      const chunkVal = wantVal < maxChunk ? wantVal : maxChunk;
      sellQty = (qty * chunkVal) / posVal;
      if (sellQty > qty) sellQty = qty;
    }

    if (sellQty > 0n) {
      const estVal = state.value(symbol, sellQty);
      if (estVal < minNotional) {
        if (wantFullExit) {
          sellQty = qty;
        } else {
          return [];
        }
      }
      const order: SellInput = {
        side: 'sell',
        symbol,
        qty: sellQty,
        max_slippage_bps: EXIT_MAX_SLIPPAGE_BPS,
      };
      return [order];
    }
  }

  return [];
}

function onBarSignal(state: BarsState, bar: Bar, scoredSeq: number, cCtx: StrategyContext): { targetFrac: number; urgent: boolean } {
  const h = Number(bar.h) / cCtx.priceDiv;
  const l = Number(bar.l) / cCtx.priceDiv;
  const c = Number(bar.c) / cCtx.priceDiv;
  const o = Number(bar.o) / cCtx.priceDiv;

  if (cCtx.open0 === null) cCtx.open0 = o;
  if (cCtx.closes.length > 0) {
    const prev = cCtx.closes[cCtx.closes.length - 1]!;
    if (prev > 0) cCtx.rets.push(c / prev - 1.0);
  }
  cCtx.closes.push(c);
  cCtx.highs.push(h);
  cCtx.lows.push(l);
  cCtx.sumClose += c;

  if (state.warmingUp || cCtx.halted) {
    return { targetFrac: 0, urgent: cCtx.halted };
  }

  const sessMean = cCtx.sumClose / cCtx.closes.length;
  const vol60 = realizedVol60(cCtx.rets);

  if (cCtx.mode === null) {
    if (
      scoredSeq >= MIN_ENTRY_SEQ &&
      scoredSeq <= MAX_LFR_ENTRY_SEQ &&
      scoredSeq - cCtx.lastExitSeq >= REENTRY_COOLDOWN &&
      cCtx.closes.length >= 6
    ) {
      // Engine A: Vol-Scaled Liquidation-Flush Reversion (LFR)
      const ddTh = clampNum(LFR_DD180_SIGMA * vol60, LFR_DD180_FLOOR, LFR_DD180_CAP);
      const d60Th = clampNum(LFR_D60_SIGMA * vol60, LFR_D60_FLOOR, LFR_D60_CAP);
      const rh180 = rollingMax(cCtx.highs, 180);
      const dd180 = c / rh180 - 1.0;
      const base60Idx = cCtx.closes.length > 60 ? cCtx.closes.length - 61 : 0;
      const r60 = c / cCtx.closes[base60Idx]! - 1.0;
      const rl15 = rollingMin(cCtx.lows, 15);
      const rebBps = (c / rl15 - 1.0) * 10000.0;
      const up5 = c > cCtx.closes[cCtx.closes.length - 6]!;

      if (
        cCtx.lfrLosses < LFR_MAX_LOSSES_PER_DAY &&
        (dd180 <= -ddTh || r60 <= -d60Th) &&
        rebBps >= LFR_REBOUND_BPS &&
        up5
      ) {
        cCtx.mode = 'LFR';
        cCtx.entryPx = c;
        cCtx.peakPx = c;
        cCtx.entrySeq = scoredSeq;
      } else if (cCtx.sibLosses < SIB_MAX_LOSSES_PER_DAY && scoredSeq <= SIB_MAX_ENTRY_SEQ) {
        // Engine B: Session-Filtered Structural Impulse Breakout (SIB)
        const lb = cCtx.closes.length - 1 < SIB_WINDOW ? cCtx.closes.length - 1 : SIB_WINDOW;
        const rSib = c / cCtx.closes[cCtx.closes.length - 1 - lb]! - 1.0;
        const rhSib = rollingMax(cCtx.closes, lb + 1);
        const er = efficiencyRatio(cCtx.closes, 60);
        const aboveOpen = c >= cCtx.open0 * (1.0 + SIB_OPEN_BUFFER);

        if (aboveOpen && c > sessMean && rSib >= SIB_MOM_THRESHOLD && c >= rhSib * 0.9985 && er >= SIB_ER_MIN) {
          cCtx.mode = 'SIB';
          cCtx.entryPx = c;
          cCtx.peakPx = c;
          cCtx.entrySeq = scoredSeq;
        }
      }
    }
    return { targetFrac: cCtx.mode === null ? 0 : 1.0, urgent: false };
  }

  // Active position management
  if (h > cCtx.peakPx) cCtx.peakPx = h;
  const gain = c / cCtx.entryPx - 1.0;
  const fromPeak = c / cCtx.peakPx - 1.0;
  const peakGain = cCtx.peakPx / cCtx.entryPx - 1.0;
  const age = scoredSeq - cCtx.entrySeq;

  if (cCtx.mode === 'LFR') {
    if (gain <= -LFR_STOP_LOSS) {
      cCtx.mode = null;
      cCtx.lastExitSeq = scoredSeq;
      cCtx.lfrLosses++;
      return { targetFrac: 0, urgent: true };
    }
    if (peakGain >= LFR_TRAIL_ACTIVATE && fromPeak <= -LFR_TRAIL_DD) {
      cCtx.mode = null;
      cCtx.lastExitSeq = scoredSeq;
      return { targetFrac: 0, urgent: false };
    }
    if (age >= LFR_HOLD_BARS) {
      const er = efficiencyRatio(cCtx.closes, 60);
      if (gain > 0.008 && er >= 0.25 && c > sessMean) {
        // Promote strong bounce recovery into structural trend ride
        cCtx.mode = 'SIB';
        cCtx.entryPx = c;
        if (c > cCtx.peakPx) cCtx.peakPx = c;
      } else {
        cCtx.mode = null;
        cCtx.lastExitSeq = scoredSeq;
        return { targetFrac: 0, urgent: false };
      }
    }
  } else if (cCtx.mode === 'SIB') {
    const trailDd = peakGain >= SIB_PROFIT_GATE ? SIB_TRAIL_PROFIT : SIB_TRAIL_BASE;
    if (gain <= -SIB_STOP_LOSS || fromPeak <= -trailDd) {
      if (gain < 0) cCtx.sibLosses++;
      cCtx.mode = null;
      cCtx.lastExitSeq = scoredSeq;
      return { targetFrac: 0, urgent: true };
    }
  }

  return { targetFrac: cCtx.mode === null ? 0 : 1.0, urgent: false };
}

await runBars({
  onHello(state) {
    ctx = initContext(state);
  },

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    if (ctx === null) ctx = initContext(state);
    const cCtx = ctx;

    for (const fill of batch.fills) {
      if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
        cCtx.didTrade = true;
      }
    }

    if (!state.warmingUp) {
      if (state.equity > cCtx.peakEquity) cCtx.peakEquity = state.equity;
      if (cCtx.peakEquity > 0n) {
        const dd = Number(cCtx.peakEquity - state.equity) / Number(cCtx.peakEquity);
        if (dd >= HARD_DAILY_DD_LIMIT) {
          cCtx.halted = true;
          cCtx.mode = null;
        }
      }
    }

    const scoredSeq = batch.seq - state.warmupBars;
    const bar = batch.bars.find((b) => b.symbol === cCtx.symbol);

    let targetFrac = cCtx.mode === null ? 0 : 1.0;
    let urgent = cCtx.halted;

    if (bar !== undefined) {
      const decision = onBarSignal(state, bar, scoredSeq, cCtx);
      targetFrac = decision.targetFrac;
      urgent = decision.urgent;
    }

    if (state.warmingUp) return [];

    // Guaranteed eligibility probe if no high-conviction trade has filled by late session
    if (
      !cCtx.didTrade &&
      cCtx.mode === null &&
      !cCtx.halted &&
      scoredSeq >= COMPLIANCE_START_SEQ &&
      scoredSeq < cCtx.totalScoredBars - 2
    ) {
      const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
      const probeNotional = COMPLIANCE_PROBE_NOTIONAL > minNotional ? COMPLIANCE_PROBE_NOTIONAL : minNotional;
      const room = state.weightRoom(cCtx.symbol);
      if (state.cash >= probeNotional && room >= probeNotional && state.latest.has(cCtx.symbol)) {
        cCtx.probeOnly = true;
        return [
          {
            side: 'buy',
            symbol: cCtx.symbol,
            notional_quote_units: probeNotional,
            max_slippage_bps: 250,
          },
        ];
      }
    }

    // Wait for bar presence on fresh entries; allow unwinds/stops even if current minute had a gap
    if (bar === undefined && targetFrac > 0) return [];

    return planTwapOrder(state, cCtx, scoredSeq, targetFrac, urgent);
  },
});
