"""One command for the evening run: update data -> fill orders -> exit alerts -> equity snapshot -> scan.

    python run_daily.py                 # normal run (backfills ~3 years the first time)
    python run_daily.py --backfill-days 1500
    python run_daily.py --skip-data     # re-run everything except the NSE downloads

Paper trading only. Nothing here connects to a broker.
"""
from __future__ import annotations

import argparse
import logging
import sys
import traceback
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import db
from config import BENCHMARK_INDEX, HISTORY_DAYS_DEFAULT, SECTOR_INDICES, load_settings
from data import loader, nse, yahoo
from engine import portfolio
from scanner import scan
from scanner.indicators import compute

IST = ZoneInfo("Asia/Kolkata")
log = logging.getLogger("run_daily")


def ensure_settings(conn) -> None:
    from config import DEFAULT_SETTINGS
    import json
    with conn.cursor() as cur:
        cur.execute("insert into settings (id, data) values (1, %s) on conflict (id) do nothing",
                    (json.dumps(DEFAULT_SETTINGS),))
    conn.commit()


def fill_benchmark_from_yahoo_if_missing(conn, days: int) -> None:
    """Only if NSE index files gave us (almost) nothing for the benchmark; clearly logged."""
    with conn.cursor() as cur:
        cur.execute("select count(*) from index_prices where index_name = %s", (BENCHMARK_INDEX,))
        n = cur.fetchone()[0]
    if n >= 250:
        return
    log.warning("only %d %s rows from NSE files; trying yfinance fallback", n, BENCHMARK_INDEX)
    for name in (BENCHMARK_INDEX, "Nifty 50"):
        df = yahoo.index_history(name, days)
        if not df.empty:
            loader.store_indices(conn, df)
            db.log_source(conn, "indices", "ok", data_date=df["trade_date"].max(),
                          message=f"{name}: {len(df)} rows from yfinance fallback (NSE index files unavailable)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill-days", type=int, default=HISTORY_DAYS_DEFAULT,
                    help="calendar days of history to load when the database is empty")
    ap.add_argument("--skip-data", action="store_true")
    ap.add_argument("--skip-reference", action="store_true", help="skip symbol/sector/ASM/band/market-cap refresh")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    conn = db.connect()
    run_id = db.start_run(conn, "daily")
    try:
        ensure_settings(conn)
        s = load_settings(conn)
        today = datetime.now(IST).date()
        client = nse.NseClient()

        if not args.skip_data:
            last = loader.latest_data_date(conn)
            start = (last + timedelta(days=1)) if last else today - timedelta(days=args.backfill_days)
            log.info("loading NSE data %s -> %s", start, today)
            stats = loader.update_prices(conn, client, start, today, today=today)
            loader.refresh_data_status(conn, stats)
            log.info("data: %s", {k: v for k, v in stats.items() if k != "errors"})
            for e in stats["errors"][:10]:
                log.error("data error: %s", e)
            fill_benchmark_from_yahoo_if_missing(conn, args.backfill_days)

        data_date = loader.latest_data_date(conn)
        if data_date is None:
            msg = "No price data in the database. Check the data errors above (NSE unreachable from this network?)."
            log.error(msg)
            db.finish_run(conn, run_id, False, msg)
            return 1

        if not args.skip_data and not args.skip_reference:
            loader.refresh_reference(conn, client, data_date)

        panel = scan.load_panel(conn)
        ind = compute(panel, trail_ema=int(s["trail_ema"]))

        f = portfolio.fill_pending_orders(conn, s)
        log.info("orders: %s", f)
        n_alerts = portfolio.generate_alerts(conn, panel, ind, s)
        bench = panel.bench.iloc[-1]
        st = portfolio.snapshot_equity(conn, s, data_date, None if bench != bench else float(bench))
        res = scan.run_scan(conn, panel, ind, s, st["equity"], st["cash"])
        msg = (f"data as of {data_date}; market filter {'ON' if res['market_filter_on'] else 'OFF'}; "
               f"{res['suggestions']} suggestions; {n_alerts} new alerts; orders {f}")
        log.info(msg)
        db.finish_run(conn, run_id, True, msg, data_date)
        return 0
    except Exception as e:  # keep the failure visible in the dashboard, then fail the job
        conn.rollback()
        log.error("run failed: %s\n%s", e, traceback.format_exc())
        db.finish_run(conn, run_id, False, f"{type(e).__name__}: {e}")
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
