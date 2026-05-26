'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { UseBotReturn, BotStatus } from '@/hooks/use-bot';

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: BotStatus }) {
  switch (status) {
    case 'idle':
      return <Badge variant="outline" className="font-normal text-muted-foreground">Idle</Badge>;
    case 'running':
      return <Badge className="bg-emerald-500 text-white animate-pulse">● Running</Badge>;
    case 'stopped_take_profit':
      return <Badge className="bg-emerald-600 text-white">✓ Take Profit hit</Badge>;
    case 'stopped_stop_loss':
      return <Badge className="bg-red-500 text-white">✗ Stop Loss hit</Badge>;
    case 'stopped_max_losses':
      return <Badge className="bg-amber-500 text-white">⚠ Max losses hit</Badge>;
    case 'stopped_drawdown':
      return <Badge className="bg-amber-600 text-white">⚠ Max drawdown hit</Badge>;
    case 'stopped_error':
      return <Badge variant="destructive">Error — stopped</Badge>;
  }
}

function PnL({ value }: { value: number }) {
  const cls = value > 0 ? 'text-emerald-500 font-bold' : value < 0 ? 'text-red-500 font-bold' : 'font-bold text-muted-foreground';
  return <span className={cls}>{value > 0 ? '+' : ''}{value.toFixed(2)} USD</span>;
}

// ─── Main component ───────────────────────────────────────────────────────────

interface BotPanelProps extends UseBotReturn {
  isAuthenticated: boolean;
  proposalReady: boolean;
}

export function BotPanel({
  botStatus,
  isRunning,
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
  isAuthenticated,
  proposalReady,
}: BotPanelProps) {
  const [showSettings, setShowSettings] = useState(false);

  const canStart = isAuthenticated && proposalReady && !isRunning;

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2 pt-3 px-3 sm:px-4 sm:pt-4">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm sm:text-base font-semibold flex items-center gap-2 flex-wrap">
            🤖 Auto Bot
            <StatusBadge status={botStatus} />
          </CardTitle>
          <button
            onClick={() => setShowSettings(s => !s)}
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            {showSettings ? 'Hide' : 'Settings'}
          </button>
        </div>
      </CardHeader>

      <CardContent className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-3">

        {/* ── Settings panel ── */}
        {showSettings && (
          <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3 text-sm">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Bot-Only Settings</p>

            {/* Take Profit / Stop Loss */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="bot-tp" className="text-xs text-muted-foreground">Take Profit (USD)</Label>
                <Input
                  id="bot-tp"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={settings.takeProfit}
                  onChange={e => updateSettings({ takeProfit: parseFloat(e.target.value) || 0 })}
                  onKeyDown={e => ['e', 'E', '+', '-'].includes(e.key) && e.preventDefault()}
                  labelRight="$"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bot-sl" className="text-xs text-muted-foreground">Stop Loss (USD)</Label>
                <Input
                  id="bot-sl"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={settings.stopLoss}
                  onChange={e => updateSettings({ stopLoss: parseFloat(e.target.value) || 0 })}
                  onKeyDown={e => ['e', 'E', '+', '-'].includes(e.key) && e.preventDefault()}
                  labelRight="$"
                />
              </div>
            </div>

            {/* Risk controls */}
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground font-medium">Risk Controls</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="bot-mcl" className="text-xs text-muted-foreground">Max consec. losses <span className="text-muted-foreground/60">(0=off)</span></Label>
                  <Input
                    id="bot-mcl"
                    type="number"
                    min={0}
                    step={1}
                    value={settings.strategy.maxConsecutiveLosses}
                    onChange={e => updateSettings({ strategy: { maxConsecutiveLosses: parseInt(e.target.value) || 0 } })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="bot-cd" className="text-xs text-muted-foreground">Loss cooldown ticks</Label>
                  <Input
                    id="bot-cd"
                    type="number"
                    min={0}
                    step={1}
                    value={settings.strategy.lossCooldownTicks}
                    onChange={e => updateSettings({ strategy: { lossCooldownTicks: parseInt(e.target.value) || 0 } })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="bot-md" className="text-xs text-muted-foreground">Max drawdown (USD) <span className="text-muted-foreground/60">(0=off)</span></Label>
                  <Input
                    id="bot-md"
                    type="number"
                    min={0}
                    step={0.5}
                    value={settings.strategy.maxDrawdown}
                    onChange={e => updateSettings({ strategy: { maxDrawdown: parseFloat(e.target.value) || 0 } })}
                    labelRight="$"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="bot-win" className="text-xs text-muted-foreground">Analysis window (ticks)</Label>
                  <Input
                    id="bot-win"
                    type="number"
                    min={10}
                    max={100}
                    step={5}
                    value={settings.strategy.windowSize}
                    onChange={e => updateSettings({ strategy: { windowSize: parseInt(e.target.value) || 20 } })}
                  />
                </div>
              </div>
            </div>

            <p className="text-[10px] text-muted-foreground italic leading-relaxed">
              Stake, duration, symbol and barrier are shared with the manual panel.
              The bot sets the contract type and barrier automatically while running.
            </p>
          </div>
        )}

        {/* ── Status bar ── */}
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 flex items-center justify-between gap-4 text-xs">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Session P&amp;L</span>
              <PnL value={sessionPnL} />
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <span>Consec. losses: <strong className="text-foreground">{consecutiveLosses}</strong></span>
              <span>Active: <strong className="text-foreground">{activeTrades}</strong></span>
            </div>
          </div>
          {tradeLog.length > 0 && (
            <button onClick={clearLog} className="text-[10px] text-muted-foreground hover:text-foreground underline shrink-0">
              Clear
            </button>
          )}
        </div>

        {/* ── Last signal ── */}
        {lastSignal && isRunning && (
          <div className="rounded-md bg-primary/5 border border-primary/20 px-3 py-2 text-xs space-y-0.5">
            <p className="font-medium text-primary">
              Last signal: {lastSignal.side === 'DIGITOVER' ? 'Over' : 'Under'} {lastSignal.barrier}
              <span className="ml-2 text-muted-foreground">({(lastSignal.confidence * 100).toFixed(0)}% conf.)</span>
            </p>
            <p className="text-muted-foreground">{lastSignal.reason}</p>
          </div>
        )}

        {/* ── Notices ── */}
        {!isAuthenticated && (
          <p className="text-xs text-muted-foreground">Log in to enable the bot.</p>
        )}
        {isAuthenticated && !proposalReady && !isRunning && (
          <p className="text-xs text-amber-500">⏳ Waiting for proposal…</p>
        )}
        {botError && (
          <p className="text-xs text-destructive">{botError}</p>
        )}
        {isRunning && (
          <p className="text-[10px] text-muted-foreground">
            ⚙ Contract type and barrier are locked while the bot is running.
          </p>
        )}

        {/* ── Start / Stop ── */}
        <Button
          className="w-full h-9 rounded-full text-sm"
          variant={isRunning ? 'destructive' : 'default'}
          disabled={isRunning ? false : !canStart}
          onClick={isRunning ? stopBot : startBot}
        >
          {isRunning ? '⏹ Stop Bot' : '▶ Start Bot'}
        </Button>

        {/* ── Trade log ── */}
        {tradeLog.length > 0 && (
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="px-3 py-1.5 bg-muted/30 border-b border-border">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                Trade Log ({tradeLog.length})
              </p>
            </div>
            <div className="max-h-44 overflow-y-auto divide-y divide-border">
              {tradeLog.map(t => (
                <div key={t.id} className="flex items-center justify-between px-3 py-1.5 text-[11px]">
                  <span className="text-muted-foreground font-mono w-16 shrink-0">
                    {new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className="text-muted-foreground flex-1 px-2 truncate" title={t.reason}>
                    {t.side === 'DIGITOVER' ? 'Over' : 'Under'} {t.barrier}
                  </span>
                  <span className="shrink-0 font-medium">
                    {t.outcome === 'pending'
                      ? <span className="text-muted-foreground animate-pulse">…</span>
                      : t.outcome === 'win'
                        ? <span className="text-emerald-500">+{(t.payout - t.buyPrice).toFixed(2)}</span>
                        : <span className="text-red-500">-{t.buyPrice.toFixed(2)}</span>
                    }
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

      </CardContent>
    </Card>
  );
}
