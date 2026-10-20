import PageHeader from '@/components/PageHeader';
import SettingsForm from '@/components/SettingsForm';
import { Badge, Empty, SetupNeeded } from '@/components/ui';
import { dbConfigured, sql } from '@/lib/db';
import { DEFAULT_SETTINGS, getStoredSettings, mergeSettings } from '@/lib/settings';
import { dateLabel, dateTimeLabel } from '@/lib/format';
import type { SourceRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RunRow = { id: number; kind: string; started_at: string; finished_at: string | null; data_date: string | null; ok: boolean | null; message: string | null };

export default async function SettingsPage() {
  if (!dbConfigured()) return <><h1>Settings</h1><SetupNeeded /></>;
  const db = sql();
  const stored = await getStoredSettings(db);
  const merged = mergeSettings(stored);
  const sources = await db<SourceRow[]>`
    select source, status, data_date, last_success, last_attempt, message, rows_last from data_sources order by source`;
  const runs = await db<RunRow[]>`
    select id, kind, started_at, finished_at, data_date, ok, message from data_runs order by started_at desc limit 10`;

  return (
    <>
      <PageHeader title="Settings" />
      <div className="card">
        <h3>Trading parameters</h3>
        <p className="small muted">
          Changes apply to new sizing, charges and tax estimates. The daily job reads the same values. Changing capital
          shifts your cash balance (cash = capital + all fills).
        </p>
        <SettingsForm values={merged} defaults={DEFAULT_SETTINGS} />
      </div>

      <h2>Data sources</h2>
      {sources.length === 0 ? (
        <Empty title="No data sources recorded yet"><p>Run the daily job: each source reports its status here.</p></Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Status</th><th>Data date</th><th>Last success</th><th>Rows</th><th>Message</th></tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.source}>
                  <td><b>{s.source}</b></td>
                  <td><Badge tone={s.status === 'ok' ? 'good' : 'bad'}>{s.status}</Badge></td>
                  <td>{dateLabel(s.data_date)}</td>
                  <td>{dateTimeLabel(s.last_success)}</td>
                  <td>{s.rows_last ?? '—'}</td>
                  <td className="wrapcell">{s.message ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Last 10 pipeline runs</h2>
      {runs.length === 0 ? (
        <Empty title="No runs recorded yet"><p>GitHub Actions → Daily → Run workflow.</p></Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Kind</th><th>Started</th><th>Finished</th><th>Data date</th><th>Result</th><th>Message</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{r.kind}</td>
                  <td>{dateTimeLabel(r.started_at)}</td>
                  <td>{dateTimeLabel(r.finished_at)}</td>
                  <td>{dateLabel(r.data_date)}</td>
                  <td><Badge tone={r.ok === null ? 'warn' : r.ok ? 'good' : 'bad'}>{r.ok === null ? 'running' : r.ok ? 'ok' : 'failed'}</Badge></td>
                  <td className="wrapcell">{r.message ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
