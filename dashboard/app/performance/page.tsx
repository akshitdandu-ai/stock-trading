import PageHeader from '@/components/PageHeader';
import LineChart from '@/components/LineChart';
import { Empty, SetupNeeded, Stat } from '@/components/ui';
import { dbConfigured, sql } from '@/lib/db';
import { loadPortfolio } from '@/lib/queries';
import { drawdownSeries, rebase, tradeStats } from '@/lib/engine';
import { inr, inrSigned, num, pct } from '@/lib/format';

export const dynamic = 'force-dynamic';

type Snap = { snap_date: string; cash: number; equity: number; open_pnl: number; realized_pnl: number; bench_close: number | null };
const TARGET_TRADES = 20;

export default async function PerformancePage() {
  if (!dbConfigured()) return <><h1>Performance</h1><SetupNeeded /></>;
  const db = sql();
  const p = await loadPortfolio(db);
  const snaps = await db<Snap[]>`
    select snap_date, cash, equity, open_pnl, realized_pnl, bench_close from equity_snapshots order by snap_date`;

  const stats = tradeStats(p.closed.map((t) => t.pnl));
  const dates = snaps.map((s) => s.snap_date);
  const eq = rebase(snaps.map((s) => s.equity), 100);
  const bench = rebase(snaps.map((s) => s.bench_close), 100);
  const dd = drawdownSeries(snaps.map((s) => s.equity));
  const lastEq = [...eq].reverse().find((v) => v !== null) ?? null;
  const lastBench = [...bench].reverse().find((v) => v !== null) ?? null;
  const maxDd = dd.length ? Math.min(...dd) : null;
  const closedN = p.closed.length;

  return (
    <>
      <PageHeader title="Performance" />

      <div className="stats">
        <Stat label="Equity" value={inr(p.equity)} hint={`${pct((p.equity / p.settings.capital - 1) * 100, 1, true)} vs capital ${inr(p.settings.capital, 0)}`} />
        <Stat label="Cash" value={inr(p.cash)} />
        <Stat label="Open P&L" value={inrSigned(p.openPnl)} tone={p.openPnl} hint="unrealised, before exit charges" />
        <Stat label="Booked P&L" value={inrSigned(p.realizedTotal)} tone={p.realizedTotal} hint="closed trades + partial sells, net of charges" />
        <Stat label="Est. STCG tax" value={inr(p.tax)} hint={`${p.settings.stcg_rate_pct}% + ${p.settings.cess_pct}% cess on net booked gains`} />
        <Stat label="Net after tax" value={inrSigned(p.netAfterTax)} tone={p.netAfterTax} hint="equity - capital - estimated tax" />
      </div>

      <h2>Closed trades: {closedN} / {TARGET_TRADES}</h2>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={TARGET_TRADES} aria-valuenow={Math.min(closedN, TARGET_TRADES)} aria-label="Closed trades toward 20">
        <span style={{ width: `${Math.min(100, (closedN / TARGET_TRADES) * 100)}%` }} />
      </div>
      <p className="small muted">
        {closedN >= TARGET_TRADES
          ? 'You have 20 or more closed trades: the statistics below start to mean something.'
          : `${TARGET_TRADES - closedN} more closed trade${TARGET_TRADES - closedN === 1 ? '' : 's'} before the statistics below are worth trusting.`}
      </p>

      {closedN === 0 ? (
        <Empty title="No closed trades yet"><p>Win rate, expectancy and profit factor appear after your first trade is closed.</p></Empty>
      ) : (
        <div className="stats">
          <Stat label="Win rate" value={pct(stats.winRate === null ? null : stats.winRate * 100, 0)} hint={`${stats.wins} wins, ${stats.losses} losses`} />
          <Stat label="Average win" value={inr(stats.avgWin)} tone={stats.avgWin} />
          <Stat label="Average loss" value={inr(stats.avgLoss)} tone={stats.avgLoss} />
          <Stat label="Expectancy / trade" value={inrSigned(stats.expectancy)} tone={stats.expectancy} hint="average net P&L per closed trade" />
          <Stat label="Profit factor" value={stats.profitFactor === null ? '—' : stats.profitFactor === Infinity ? '∞' : num(stats.profitFactor)} hint="gross wins / gross losses" />
        </div>
      )}

      <h2>Equity vs Nifty Smallcap 250</h2>
      {snaps.length < 2 ? (
        <Empty title="Not enough history for a curve yet">
          <p>The daily job writes one equity snapshot per evening. The chart appears from the second snapshot.</p>
        </Empty>
      ) : (
        <div className="card">
          <LineChart
            dates={dates} kind="num" label="Equity versus Nifty Smallcap 250, both rebased to 100"
            series={[
              { name: 'Your paper equity', color: 'var(--series-1)', values: eq },
              { name: 'Nifty Smallcap 250', color: 'var(--series-2)', values: bench },
            ]}
            baseline={100}
          />
          <p className="small muted">
            Both start at 100. You: {lastEq === null ? '—' : num(lastEq, 1)}
            {lastBench !== null ? <> · Smallcap 250: {num(lastBench, 1)}</> : <> · benchmark not available</>}
          </p>
        </div>
      )}

      <h2>Drawdown</h2>
      {snaps.length < 2 ? (
        <Empty title="No drawdown to show yet" />
      ) : (
        <div className="card">
          <LineChart
            dates={dates} kind="pct" area baseline={0} label="Drawdown from equity peak"
            series={[{ name: 'Drawdown', color: 'var(--neg)', values: dd }]}
          />
          <p className="small muted">Worst drawdown so far: {pct(maxDd, 1)}</p>
        </div>
      )}
    </>
  );
}
