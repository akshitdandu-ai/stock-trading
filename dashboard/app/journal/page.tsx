import PageHeader from '@/components/PageHeader';
import NotesForm from '@/components/NotesForm';
import { Empty, SetupNeeded } from '@/components/ui';
import { dbConfigured, sql } from '@/lib/db';
import { loadPortfolio } from '@/lib/queries';
import { scoreBucket, tradeStats } from '@/lib/engine';
import { dateLabel, inr, inrSigned, pct, pnlClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

const REASON_LABEL: Record<string, string> = {
  target: 'Target (1/3 booked)', stop: 'Stop', trail: 'Trail', time_stop: 'Time stop', manual: 'Manual',
};
const BUCKETS = [
  { key: '0–3', label: 'Checklist 0–3' },
  { key: '4–5', label: 'Checklist 4–5' },
  { key: '6–7', label: 'Checklist 6–7' },
  { key: 'none', label: 'No checklist done' },
] as const;

export default async function JournalPage() {
  if (!dbConfigured()) return <><h1>Journal</h1><SetupNeeded /></>;
  const p = await loadPortfolio(sql());
  const closed = [...p.closed].sort((a, b) => (b.exit_date ?? '').localeCompare(a.exit_date ?? '') || b.id - a.id);

  const exitPrice = (t: (typeof closed)[number]) => {
    const sells = t.fills.filter((f) => f.side === 'sell');
    const q = sells.reduce((a, f) => a + f.qty, 0);
    return q ? sells.reduce((a, f) => a + f.qty * f.price, 0) / q : null;
  };

  const reasons = [...new Set(closed.map((t) => t.exit_reason ?? 'unknown'))];
  const byReason = reasons.map((r) => ({ key: r, stats: tradeStats(closed.filter((t) => (t.exit_reason ?? 'unknown') === r).map((t) => t.pnl)) }));
  const byBucket = BUCKETS.map((b) => ({
    ...b,
    stats: tradeStats(closed.filter((t) => scoreBucket(t.checklist_score) === b.key).map((t) => t.pnl)),
  })).filter((b) => b.key !== 'none' || b.stats.n > 0);

  return (
    <>
      <PageHeader title="Journal" subtitle="Every closed paper trade, newest first." />
      {closed.length === 0 ? (
        <Empty title="No closed trades yet">
          <p>When a position is fully sold it lands here with its net P&L, and the summaries below fill in.</p>
        </Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th><th>Entered</th><th>Exited</th><th className="r">Entry</th><th className="r">Exit (avg)</th>
                  <th className="r">Qty</th><th className="r">Net P&amp;L</th><th>Reason</th><th>Checklist</th><th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((t) => {
                  const ep = exitPrice(t);
                  return (
                    <tr key={t.id}>
                      <td><b>{t.symbol}</b></td>
                      <td>{dateLabel(t.entry_date)}</td>
                      <td>{dateLabel(t.exit_date)}</td>
                      <td className="r">{inr(t.entry_price)}</td>
                      <td className="r">{inr(ep)}</td>
                      <td className="r">{t.initial_qty}</td>
                      <td className={`r ${pnlClass(t.pnl)}`}><b>{inrSigned(t.pnl)}</b></td>
                      <td>{REASON_LABEL[t.exit_reason ?? ''] ?? t.exit_reason ?? '—'}</td>
                      <td>{t.checklist_score !== null ? `${t.checklist_score}/7` : '—'}</td>
                      <td className="wrapcell">
                        <details>
                          <summary className="small">{t.notes ? <span>{t.notes.length > 60 ? t.notes.slice(0, 60) + '…' : t.notes}</span> : <span className="muted">add notes</span>}</summary>
                          <NotesForm tradeId={t.id} notes={t.notes} />
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h2>P&amp;L by exit reason</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Reason</th><th className="r">Trades</th><th className="r">Win rate</th><th className="r">Avg P&amp;L</th><th className="r">Total P&amp;L</th></tr></thead>
              <tbody>
                {byReason.map((r) => (
                  <tr key={r.key}>
                    <td>{REASON_LABEL[r.key] ?? r.key}</td>
                    <td className="r">{r.stats.n}</td>
                    <td className="r">{pct(r.stats.winRate === null ? null : r.stats.winRate * 100, 0)}</td>
                    <td className={`r ${pnlClass(r.stats.expectancy)}`}>{inrSigned(r.stats.expectancy)}</td>
                    <td className={`r ${pnlClass(r.stats.total)}`}>{inrSigned(r.stats.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>Performance by checklist score</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Bucket</th><th className="r">Trades</th><th className="r">Win rate</th><th className="r">Avg P&amp;L</th><th className="r">Total P&amp;L</th></tr></thead>
              <tbody>
                {byBucket.map((b) => (
                  <tr key={b.key}>
                    <td>{b.label}</td>
                    <td className="r">{b.stats.n}</td>
                    <td className="r">{pct(b.stats.winRate === null ? null : b.stats.winRate * 100, 0)}</td>
                    <td className={`r ${pnlClass(b.stats.expectancy)}`}>{inrSigned(b.stats.expectancy)}</td>
                    <td className={`r ${pnlClass(b.stats.total)}`}>{inrSigned(b.stats.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">Small samples mislead: wait for 20+ closed trades before reading anything into these tables.</p>
        </>
      )}
    </>
  );
}
