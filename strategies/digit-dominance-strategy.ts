/**
 * DigitDominanceStrategy
 *
 * Pure trading-logic module. Contains zero knowledge of:
 *  - WebSocket connections
 *  - React state / hooks
 *  - UI components
 *  - Proposal lifecycle
 *
 * Called on every tick; returns a TradeSignal or null.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type TradeSide = 'DIGITOVER' | 'DIGITUNDER';

export interface TradeSignal {
  side: TradeSide;
  /** Barrier digit (0–9) the strategy wants to trade at. */
  barrier: number;
  /** Confidence 0–1 for display. */
  confidence: number;
  /** Human-readable reason string shown in the UI. */
  reason: string;
}

export interface StrategyConfig {
  /** Rolling window of recent ticks to analyse. Default: 20. */
  windowSize: number;
  /** Digit must appear in ≥ this fraction of the window. Default: 0.35. */
  dominanceThreshold: number;
  /** Minimum confidence (0–1) before emitting a signal. Default: 0.55. */
  minConfidence: number;
  /** Ticks to skip after a loss before the next signal. Default: 3. */
  lossCooldownTicks: number;
  /** Halt after this many consecutive losses (0 = disabled). */
  maxConsecutiveLosses: number;
  /** Halt when session drawdown exceeds this USD amount (0 = disabled). */
  maxDrawdown: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  windowSize: 20,
  dominanceThreshold: 0.35,
  minConfidence: 0.55,
  lossCooldownTicks: 3,
  maxConsecutiveLosses: 5,
  maxDrawdown: 0,
};

export interface StrategyState {
  consecutiveLosses: number;
  cooldownTicksRemaining: number;
  sessionPnL: number;
  totalTrades: number;
  totalWins: number;
}

export interface TradeRecord {
  side: TradeSide;
  barrier: number;
  buyPrice: number;
  payout: number;
  won: boolean;
  pnl: number;
  timestamp: number;
}

// ─── Strategy class ───────────────────────────────────────────────────────────

export class DigitDominanceStrategy {
  private config: StrategyConfig;
  private state: StrategyState = {
    consecutiveLosses: 0,
    cooldownTicksRemaining: 0,
    sessionPnL: 0,
    totalTrades: 0,
    totalWins: 0,
  };
  private history: TradeRecord[] = [];

  constructor(config: Partial<StrategyConfig> = {}) {
    this.config = { ...DEFAULT_STRATEGY_CONFIG, ...config };
  }

  updateConfig(patch: Partial<StrategyConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  getState(): Readonly<StrategyState> {
    return { ...this.state };
  }

  getHistory(): Readonly<TradeRecord[]> {
    return [...this.history];
  }

  reset(): void {
    this.state = {
      consecutiveLosses: 0,
      cooldownTicksRemaining: 0,
      sessionPnL: 0,
      totalTrades: 0,
      totalWins: 0,
    };
    this.history = [];
  }

  /** Call once settlement is confirmed by proposal_open_contract. */
  recordResult(record: TradeRecord): void {
    this.history = [record, ...this.history].slice(0, 200);
    this.state.totalTrades += 1;
    this.state.sessionPnL = parseFloat((this.state.sessionPnL + record.pnl).toFixed(2));

    if (record.won) {
      this.state.totalWins += 1;
      this.state.consecutiveLosses = 0;
    } else {
      this.state.consecutiveLosses += 1;
      this.state.cooldownTicksRemaining = this.config.lossCooldownTicks;
    }
  }

  /**
   * Evaluate the shared price buffer on each tick.
   * Returns a TradeSignal when conditions pass, or null to skip this tick.
   */
  evaluate(prices: number[], pipSize: number): TradeSignal | null {
    // ── Blocked states ──────────────────────────────────────────────────────
    if (this.state.cooldownTicksRemaining > 0) {
      this.state.cooldownTicksRemaining -= 1;
      return null;
    }

    const { maxConsecutiveLosses, maxDrawdown } = this.config;
    if (maxConsecutiveLosses > 0 && this.state.consecutiveLosses >= maxConsecutiveLosses) return null;
    if (maxDrawdown > 0 && this.state.sessionPnL <= -maxDrawdown) return null;

    // ── Need enough history ─────────────────────────────────────────────────
    const { windowSize } = this.config;
    if (prices.length < windowSize) return null;

    const window = prices.slice(-windowSize);

    // ── Digit frequency over window ─────────────────────────────────────────
    const counts = new Array<number>(10).fill(0);
    for (const price of window) {
      const d = this.lastDigit(price, pipSize);
      counts[d] += 1;
    }

    let maxCount = 0;
    let dominantDigit = 0;
    for (let d = 0; d <= 9; d++) {
      if (counts[d] > maxCount) { maxCount = counts[d]; dominantDigit = d; }
    }

    const ratio = maxCount / windowSize;
    if (ratio < this.config.dominanceThreshold) return null;

    // ── Direction ───────────────────────────────────────────────────────────
    // Low digit dominant → OVER (barrier just below the cluster)
    // High digit dominant → UNDER (barrier just above the cluster)
    let side: TradeSide;
    let barrier: number;
    if (dominantDigit <= 4) {
      side = 'DIGITOVER';
      barrier = Math.max(0, dominantDigit - 1);
    } else {
      side = 'DIGITUNDER';
      barrier = Math.min(9, dominantDigit + 1);
    }

    // ── Confidence ──────────────────────────────────────────────────────────
    const confidence = Math.min(
      1,
      (ratio - this.config.dominanceThreshold) / (1 - this.config.dominanceThreshold)
    );
    if (confidence < this.config.minConfidence) return null;

    return {
      side,
      barrier,
      confidence,
      reason: `Digit ${dominantDigit} seen ${maxCount}/${windowSize} ticks (${(ratio * 100).toFixed(0)}%)`,
    };
  }

  private lastDigit(price: number, pipSize: number): number {
    return Math.round(price * Math.pow(10, pipSize)) % 10;
  }
}
