'use client';

/**
 * useBot — Execution layer that automates the shared manual trading environment.
 *
 * Architecture constraints (strictly enforced):
 *  ✓  NO new tick subscriptions     — reads currentTick + prices props directly
 *  ✓  NO new proposal subscriptions — reads the single shared proposal prop
 *  ✓  NO new WS connections         — uses tradingWs passed from useDigitsTrading
 *  ✓  Aligns UI via setContractMode + setSelectedDigit (same setters the UI uses)
 *  ✓  Locks those controls while running so proposal stays aligned
 *  ✓  Per-trade proposal_open_contract subscription for settlement (temporary, auto-closes)
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Tick, ProposalInfo, DerivWS } from '@deriv/core';
import type { ContractMode } from '@/lib/types';
import {
  DigitDominanceStrategy,
  DEFAULT_STRATEGY_CONFIG,
} from '@/strategies/digit-dominance-strategy';
import type { StrategyConfig, TradeRecord, TradeSignal } from '@/strategies/digit-dominance-strategy';

// ─── Public types ──────────────────────────────────────────────────────────────

export interface BotSettings {
  /** Stop bot when session P&L reaches this positive amount (USD). */
  takeProfit: number;
  /** Stop bot when session P&L drops by this amount (USD). */
  stopLoss: number;
  /** Risk / strategy controls (delegated to DigitDominanceStrategy). */
  strategy: StrategyConfig;
}

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  takeProfit: 10,
  stopLoss: 5,
  strategy: DEFAULT_STRATEGY_CONFIG,
};

export type BotStatus =
  | 'idle'
  | 'running'
  | 'stopped_take_profit'
  | 'stopped_stop_loss'
  | 'stopped_max_losses'
  | 'stopped_drawdown'
  | 'stopped_error';

export interface BotTradeEntry {
  id: string;
  contractId: number;
  side: 'DIGITOVER' | 'DIGITUNDER';
  barrier: number;
  buyPrice: number;
  payout: number;
  outcome: 'pending' | 'win' | 'loss';
  pnl: number;
  reason: string;
  timestamp: number;
}

export interface UseBotReturn {
  botStatus: BotStatus;
  isRunning: boolean;
  isLocked: boolean;
  settings: BotSettings;
  sessionPnL: number;
  consecutiveLosses: number;
  activeTrades: number;
  tradeLog: BotTradeEntry[];
  lastSignal: TradeSignal | null;
  botError: string | null;
  startBot: () => void;
  stopBot: () => void;
  updateSettings: (patch: Partial<BotSettings>) => void;
  clearLog: () => void;
}

interface UseBotParams {
  ws: DerivWS | null;
  isConnected: boolean;
  isAuthenticated: boolean;
  currentTick: Tick | null;
  prices: number[];
  pipSize: number;
  /** The single shared proposal — bot reads id + askPrice, no new sub created. */
  proposal: ProposalInfo | null;
  /** UI setter — bot calls this to align the proposal contract type to the signal. */
  setContractMode: (mode: ContractMode) => void;
  /** UI setter — bot calls this to align the barrier digit to the signal. */
  setSelectedDigit: (digit: number) => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useBot({
  ws,
  isConnected,
  isAuthenticated,
  currentTick,
  prices,
  pipSize,
  proposal,
  setContractMode,
  setSelectedDigit,
}: UseBotParams): UseBotReturn {

  const [settings, setSettings] = useState<BotSettings>(DEFAULT_BOT_SETTINGS);
  const [botStatus, setBotStatus] = useState<BotStatus>('idle');
  const [tradeLog, setTradeLog] = useState<BotTradeEntry[]>([]);
  const [lastSignal, setLastSignal] = useState<TradeSignal | null>(null);
  const [botError, setBotError] = useState<string | null>(null);
  const [sessionPnL, setSessionPnL] = useState(0);
  const [consecutiveLosses, setConsecutiveLosses] = useState(0);
  const [activeTrades, setActiveTrades] = useState(0);

  // Refs so async callbacks always read current values without stale closures
  const statusRef = useRef<BotStatus>('idle');
  const settingsRef = useRef<BotSettings>(settings);
  const activeTradesRef = useRef(0);
  const sessionPnLRef = useRef(0);
  const isBuyingRef = useRef(false);
  const prevTickEpochRef = useRef<number | null>(null);

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Strategy instance — created once, config kept in sync
  const strategy = useMemo(() => new DigitDominanceStrategy(DEFAULT_STRATEGY_CONFIG), []);
  useEffect(() => { strategy.updateConfig(settings.strategy); }, [settings.strategy, strategy]);

  // ── Internal helpers ───────────────────────────────────────────────────────

  const setStatus = useCallback((s: BotStatus) => {
    statusRef.current = s;
    setBotStatus(s);
  }, []);

  const patchLog = useCallback((id: string, patch: Partial<BotTradeEntry>) => {
    setTradeLog(prev => prev.map(e => e.id === id ? { ...e, ...patch } : e));
  }, []);

  // ── Settlement via proposal_open_contract ─────────────────────────────────
  // One temporary subscription per trade. Closes automatically on settlement.
  // This is the ONLY subscription the bot opens — and only after a buy.

  const subscribeSettlement = useCallback((
    contractId: number,
    entryId: string,
    fallbackBuyPrice: number,
    fallbackPayout: number,
    side: 'DIGITOVER' | 'DIGITUNDER',
    barrier: number,
  ) => {
    if (!ws || !isConnected) return;

    let unsubscribeFn: (() => void) | null = null;

    ws.subscribe(
      { proposal_open_contract: 1, contract_id: contractId },
      (data: Record<string, unknown>) => {
        const poc = data.proposal_open_contract as Record<string, unknown> | undefined;
        if (!poc) return;

        const status = poc.status as string | undefined;
        if (status !== 'won' && status !== 'lost') return;

        // Settled — unsubscribe immediately
        unsubscribeFn?.();

        const won = status === 'won';
        const rawPayout = poc.payout as number | undefined;
        const pnl = won
          ? parseFloat(((rawPayout ?? fallbackPayout) - fallbackBuyPrice).toFixed(2))
          : -fallbackBuyPrice;

        patchLog(entryId, { outcome: won ? 'win' : 'loss', pnl });

        strategy.recordResult({
          side, barrier,
          buyPrice: fallbackBuyPrice,
          payout: fallbackPayout,
          won, pnl,
          timestamp: Date.now(),
        } as TradeRecord);

        activeTradesRef.current = Math.max(0, activeTradesRef.current - 1);
        setActiveTrades(activeTradesRef.current);

        sessionPnLRef.current = parseFloat((sessionPnLRef.current + pnl).toFixed(2));
        setSessionPnL(sessionPnLRef.current);

        const newConsec = strategy.getState().consecutiveLosses;
        setConsecutiveLosses(newConsec);

        // Check stop conditions
        const s = settingsRef.current;
        if (sessionPnLRef.current >= s.takeProfit) { setStatus('stopped_take_profit'); return; }
        if (sessionPnLRef.current <= -s.stopLoss) { setStatus('stopped_stop_loss'); return; }
        if (s.strategy.maxConsecutiveLosses > 0 && newConsec >= s.strategy.maxConsecutiveLosses) {
          setStatus('stopped_max_losses'); return;
        }
        if (s.strategy.maxDrawdown > 0 && sessionPnLRef.current <= -s.strategy.maxDrawdown) {
          setStatus('stopped_drawdown'); return;
        }
      }
    )
      .then(sub => { unsubscribeFn = sub.unsubscribe; })
      .catch(() => {
        activeTradesRef.current = Math.max(0, activeTradesRef.current - 1);
        setActiveTrades(activeTradesRef.current);
      });
  }, [ws, isConnected, patchLog, strategy, setStatus]);

  // ── Core tick loop ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!currentTick) return;
    if (currentTick.epoch === prevTickEpochRef.current) return; // deduplicate
    prevTickEpochRef.current = currentTick.epoch;

    if (statusRef.current !== 'running') return;
    if (!isAuthenticated || !ws || !isConnected) return;
    if (isBuyingRef.current) return; // one buy at a time

    // ── Strategy evaluation ────────────────────────────────────────────────
    const signal = strategy.evaluate(prices, pipSize);
    if (!signal) return;

    setLastSignal(signal);

    // ── Align the UI / proposal to the signal ──────────────────────────────
    // These calls use the SAME setters as the UI, keeping everything in sync.
    setContractMode(signal.side as ContractMode);
    setSelectedDigit(signal.barrier);

    // Wait for the shared proposal to reflect the new contract type & barrier.
    // If it isn't aligned yet, skip this tick — the proposal will update next tick.
    if (!proposal) return;

    const aligned =
      (signal.side === 'DIGITOVER' && proposal.longcode?.toLowerCase().includes('over')) ||
      (signal.side === 'DIGITUNDER' && proposal.longcode?.toLowerCase().includes('under'));
    if (!aligned) return;

    // ── Execute buy via shared ws.send — same call useBuy makes ───────────
    isBuyingRef.current = true;

    const entryId = `${Date.now()}-${signal.side}`;
    const entry: BotTradeEntry = {
      id: entryId,
      contractId: 0,
      side: signal.side,
      barrier: signal.barrier,
      buyPrice: proposal.askPrice,
      payout: proposal.payout,
      outcome: 'pending',
      pnl: 0,
      reason: signal.reason,
      timestamp: Date.now(),
    };

    setTradeLog(prev => [entry, ...prev].slice(0, 100));
    activeTradesRef.current += 1;
    setActiveTrades(activeTradesRef.current);

    ws.send<{ buy?: { contract_id: number; buy_price: number; payout: number } }>({
      buy: proposal.id,
      price: String(proposal.askPrice),
    })
      .then(response => {
        isBuyingRef.current = false;

        if (!response.buy) {
          // Server rejected the buy
          activeTradesRef.current = Math.max(0, activeTradesRef.current - 1);
          setActiveTrades(activeTradesRef.current);
          setTradeLog(prev => prev.filter(e => e.id !== entryId));
          return;
        }

        const contractId = response.buy.contract_id;
        patchLog(entryId, { contractId });

        // Subscribe to settlement (temporary stream, not a permanent subscription)
        subscribeSettlement(
          contractId, entryId,
          response.buy.buy_price,
          response.buy.payout,
          signal.side,
          signal.barrier,
        );
      })
      .catch(err => {
        isBuyingRef.current = false;
        activeTradesRef.current = Math.max(0, activeTradesRef.current - 1);
        setActiveTrades(activeTradesRef.current);
        setTradeLog(prev => prev.filter(e => e.id !== entryId));
        setBotError(err instanceof Error ? err.message : 'Buy failed');
        setStatus('stopped_error');
      });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTick]);

  // ── Controls ───────────────────────────────────────────────────────────────

  const startBot = useCallback(() => {
    if (!isAuthenticated) { setBotError('Log in to start the bot.'); return; }
    setBotError(null);
    isBuyingRef.current = false;
    activeTradesRef.current = 0;
    sessionPnLRef.current = 0;
    setActiveTrades(0);
    setSessionPnL(0);
    setConsecutiveLosses(0);
    setLastSignal(null);
    strategy.reset();
    setStatus('running');
  }, [isAuthenticated, setStatus, strategy]);

  const stopBot = useCallback(() => {
    isBuyingRef.current = false;
    setStatus('idle');
    setBotError(null);
  }, [setStatus]);

  const updateSettings = useCallback((patch: Partial<BotSettings>) => {
    setSettings(prev => ({
      ...prev,
      ...patch,
      strategy: patch.strategy ? { ...prev.strategy, ...patch.strategy } : prev.strategy,
    }));
  }, []);

  const clearLog = useCallback(() => {
    setTradeLog([]);
    setSessionPnL(0);
    sessionPnLRef.current = 0;
    setConsecutiveLosses(0);
  }, []);

  const isRunning = botStatus === 'running';

  return {
    botStatus,
    isRunning,
    isLocked: isRunning,
    settings,
    sessionPnL,
    consecutiveLosses,
    activeTrades,
    tradeLog,
    lastSignal,
    botError,
    startBot,
    stopBot,
    updateSettings,
    clearLog,
  };
}
