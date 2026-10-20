import { sql } from '@/lib/db';
import { getShell } from '@/lib/queries';
import { dateLabel, dateTimeLabel } from '@/lib/format';

/** Title + "Data as of" + data-source banner. Shown on every page. Assumes DATABASE_URL is set. */
export default async function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  let shell;
  try {
    shell = await getShell(sql());
  } catch (e) {
    return (
      <>
        <div className="page-head"><h1>{title}</h1></div>
        <div className="banner bad" role="alert">
          <strong>Cannot reach the database</strong>
          Check DATABASE_URL (use the Supabase transaction pooler URL) and that the migration has been applied.
          {' '}<span className="small">{e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/gi, '[hidden]') : ''}</span>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="page-head">
        <h1>{title}</h1>
        {shell.dataDate ? (
          <span className="asof">Data as of <strong>{dateLabel(shell.dataDate)}</strong></span>
        ) : (
          <span className="asof bad">No price data yet: run the daily job</span>
        )}
      </div>
      {subtitle ? <p className="sub">{subtitle}</p> : null}
      {shell.badSources.length ? (
        <div className="banner warn" role="alert">
          <strong>Some data sources are not healthy: results may be incomplete or stale</strong>
          <ul>
            {shell.badSources.map((s) => (
              <li key={s.source}>
                <b>{s.source}</b>: {s.status}
                {s.data_date ? `, data up to ${dateLabel(s.data_date)}` : ''}
                {s.last_success ? `, last success ${dateTimeLabel(s.last_success)}` : ''}
                {s.message ? `: ${s.message}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
