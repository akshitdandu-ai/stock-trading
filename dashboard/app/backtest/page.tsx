import PageHeader from '@/components/PageHeader';
import LineChart from '@/components/LineChart';
import { Empty, SetupNeeded } from '@/components/ui';
import { dbConfigured, sql } from '@/lib/db';
import { dateLabel, dateTimeLabel, inr, inrSigned, num, pct, pnlClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

type Metrics = Record<string, number | null | undefined>;
type CurvePoint = { d: string; equity: number; bench?: number | null };
type BtTrade = {
  symbol: string; entry_date: string; entry_price: number; exit_date: string; exit_price: number;
  qty: number; pnl: number; ret_pct?: number; reason?: string;
};
type Run = {
  id: number; created_at: string; label: string; filter_on: boolean; params: Record<string, unknown>;
  period_start: string | null; period_end: string | null; metrics: Metrics; equity_curve: CurvePoint[];
  trades: BtTrade[]; notes: string | null;
};

const METRIC_ROWS: { key: string; label: string; fmt: (v: number) => string }[] = [
  { key: 'trades', label: 'Trades', fmt: (v) => String(v) },
  { key: 'win_rate', label: 'Win rate', fmt: (v) => pct(v, 1) },
  { key: 'avg_win', label: 'Average win', fmt: (v) => inr(v) },
  { key: 'avg_loss', label: 'Average loss', fmt: (v) => inr(v) },
  { key: 'expectancy', label: 'Expectancy / trade', fmt: (v) => inrSigned(v) },
  { key: 'expectancy_r', label: 'Expectancy (R)', fmt: (v) => num(v) },
  { key: 'profit_factor', label: 'Profit factor', fmt: (v) => num(v) },
  { key: 'max_drawdown_pct', label: 'Max drawdown', fmt: (v) => pct(v, 1) },
  { key: 'cagr_pct', label: 'CAGR', fmt: (v) => pct(v, 1) },
  { key: 'total_return_pct', label: 'Total return', fmt: (v) => pct(v, 1, true) },
  { key: 'start_capital', label: 'Start capital', fmt: (v) => inr(v, 0) },
  { key: 'final_equity', label: 'Final equity', fmt: (v) => inr(v, 0) },
];

async function latestRun(filterOn: boolean): Promise<Run | null> {
  const rows = await sql()<Run[]>`
    select id, created_at, label, filter_on, params, period_start, period_end, metrics, equity_curve, trades, notes
    from backtest_runs where filter_on = ${filterOn} order by created_at desc, id desc limit 1`;
  return rows[0] ?? null;
}

function RunColumn({ run, title }: { run: Run | null; title: string }) {
  if (!run) return <div className="card"><h3>{title}</h3><p className="muted">No run stored.</p></div>;
  const curve = Array.isArray(run.equity_curve) ? run.equity_curve : [];
  const trades = Array.isArray(run.trades) ? run.trades : [];
  return (
    <div className="card">
      <h3>{title}</h3>
      <p className="small muted">
        {dateLabel(run.period_start)} to {dateLabel(run.period_end)} · run {dateTimeLabel(run.created_at)}
      </p>
      {curve.length >= 2 ? (
        <LineChart
          dates={curve.map((c) => c.d)} kind="inr" label={`${title}: equity curve versus benchmark`}
          series={[
            { name: 'Strategy', color: 'var(--series-1)', values: curve.map((c) => c.equity) },
            ...(curve.some((c) => c.bench !== null && c.bench !== undefined)
              ? [{ name: 'Nifty Smallcap 250', color: 'var(--series-2)', values: curve.map((c) => c.bench ?? null) }]
              : []),
          ]}
          height={240}
        />
      ) : <p className="muted">No equity curve stored.</p>}

      <h3>Parameters</h3>
      <dl className="kv">
        {Object.entries(run.params ?? {}).map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}><dt>{k.replace(/_/g, ' ')}</dt><dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></div>
        ))}
      </dl>

      <details className="section" style={{ marginTop: 10 }}>
        <summary>Trades ({trades.length})</summary>
        {trades.length === 0 ? <p className="muted">No trades.</p> : (
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>Symbol</th><th>Entry</th><th>Exit</th><th className="r">Qty</th><th className="r">P&amp;L</th><th className="r">Ret</th><th>Reason</th></tr></thead>
              <tbody>
                {trades.map((t, i) => (
                  <tr key={i}>
                    <td><b>{t.symbol}</b></td>
                    <td>{dateLabel(t.entry_date)} @ {num(t.entry_price)}</td>
                    <td>{dateLabel(t.exit_date)} @ {num(t.exit_price)}</td>
                    <td className="r">{t.qty}</td>
                    <td className={`r ${pnlClass(t.pnl)}`}>{inrSigned(t.pnl)}</td>
                    <td className={`r ${pnlClass(t.ret_pct)}`}>{t.ret_pct !== undefined ? pct(t.ret_pct, 1, true) : '—'}</td>
                    <td>{t.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </div>
  );
}

export default async function BacktestPage() {
  if (!dbConfigured()) return <><h1>Backtest</h1><SetupNeeded /></>;
  const [on, off] = await Promise.all([latestRun(true), latestRun(false)]);

  return (
    <>
      <PageHeader title="Backtest" subtitle="The same rules replayed on history, with the market filter on and off." />
      {!on && !off ? (
        <Empty title="Backtest hasn't been run">
          <p>GitHub Actions → Backtest → Run workflow. It stores a run with the market filter ON and one with it OFF, and they appear here.</p>
        </Empty>
      ) : (
        <>
          {[on?.notes, off?.notes].filter((n, i, a): n is string => !!n && a.indexOf(n) === i).map((n, i) => (
            <div key={i} className="banner warn" role="note">
              <strong>Read this before trusting the numbers</strong>
              <span style={{ whiteSpace: 'pre-wrap' }}>{n}</span>
            </div>
          ))}

          <h2>Metrics</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Metric</th><th className="r">Market filter ON</th><th className="r">Market filter OFF</th></tr></thead>
              <tbody>
                {METRIC_ROWS.map((m) => {
                  const cell = (r: Run | null) => {
                    const v = r?.metrics?.[m.key];
                    if (typeof v === 'number') return m.fmt(v);
                    if (m.key === 'profit_factor' && typeof r?.metrics?.trades === 'number' && r.metrics.trades > 0) return '∞ (no losses)';
                    return '—';
                  };
                  return (
                    <tr key={m.key}><td>{m.label}</td><td className="r">{cell(on)}</td><td className="r">{cell(off)}</td></tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h2>Curves, parameters and trades</h2>
          <div className="grid cols-2">
            <RunColumn run={on} title="Market filter ON" />
            <RunColumn run={off} title="Market filter OFF" />
          </div>
        </>
      )}
    </>
  );
}
