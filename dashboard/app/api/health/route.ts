import { dbConfigured, sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Public liveness probe. Returns freshness only, never any trading data.
export async function GET() {
  const headers = { 'Cache-Control': 'no-store' };
  if (!dbConfigured()) {
    return Response.json({ db: false, latest_data_date: null, last_scan_date: null }, { headers });
  }
  try {
    const db = sql();
    const [d] = await db<{ d: string | null }[]>`select max(trade_date) as d from daily_prices`;
    const [s] = await db<{ d: string | null }[]>`select max(scan_date) as d from scan_runs`;
    return Response.json({ db: true, latest_data_date: d?.d ?? null, last_scan_date: s?.d ?? null }, { headers });
  } catch {
    return Response.json({ db: false, latest_data_date: null, last_scan_date: null }, { headers });
  }
}
