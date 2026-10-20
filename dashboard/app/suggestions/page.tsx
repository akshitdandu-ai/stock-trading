import PageHeader from '@/components/PageHeader';
import SuggestionsView, { type WatchRow } from '@/components/SuggestionsView';
import { Empty, SetupNeeded } from '@/components/ui';
import { dbConfigured, sql } from '@/lib/db';
import { getLatestScan, loadPortfolio, loadSuggestions, sizingParams } from '@/lib/queries';
import { dateLabel, todayIST } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function SuggestionsPage() {
  if (!dbConfigured()) return <><h1>Suggestions</h1><SetupNeeded /></>;
  const db = sql();
  const [p, scan] = await Promise.all([loadPortfolio(db), getLatestScan(db)]);
  const suggestions = scan ? await loadSuggestions(db, scan.scan_date) : [];
  const watchlist = await db<WatchRow[]>`
    select w.symbol, w.added_at, c.score as checklist_score
    from watchlist w left join checklists c on c.symbol = w.symbol order by w.added_at desc`;

  return (
    <>
      <PageHeader title="Suggestions" subtitle={scan ? `Ranked list from the scan of ${dateLabel(scan.scan_date)}.` : undefined} />
      {scan && !scan.market_filter_on ? (
        <div className="banner bad" role="status"><strong>Market filter is off: no new buys</strong>These suggestions are for reference only.</div>
      ) : null}
      {!scan && watchlist.length === 0 ? (
        <Empty title="No suggestions yet">
          <p>The scanner has not run. Run the daily job (GitHub Actions → Daily → Run workflow) to produce the first ranked list.</p>
        </Empty>
      ) : (
        <SuggestionsView
          suggestions={suggestions} watchlist={watchlist} scanDate={scan?.scan_date ?? null}
          marketOn={scan ? scan.market_filter_on : null} sizing={sizingParams(p)} dataDate={p.dataDate} today={todayIST()}
        />
      )}
    </>
  );
}
