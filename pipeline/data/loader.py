"""Download NSE data and store it in Postgres. Incremental, resumable, honest about failures."""
from __future__ import annotations

import json
import logging
from datetime import date, timedelta

import pandas as pd

import db
from config import BENCHMARK_INDEX, MARKET_INDEX, SECTOR_INDICES
from data import nse

log = logging.getLogger("loader")

WANTED_INDICES = {nse.normalise_index_name(n): n for n in [BENCHMARK_INDEX, MARKET_INDEX, *SECTOR_INDICES]}


def _records(df: pd.DataFrame, cols: list[str]) -> list[tuple]:
    sub = df[cols].astype(object).where(df[cols].notna(), None)
    return list(sub.itertuples(index=False, name=None))


def store_prices(conn, df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    cols = nse.BHAV_COLUMNS
    sql = """
      insert into daily_prices (symbol, trade_date, open, high, low, close, prev_close, volume, turnover_cr, trades, deliv_pct)
      values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
      on conflict (symbol, trade_date) do update set
        open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
        prev_close=excluded.prev_close, volume=excluded.volume, turnover_cr=excluded.turnover_cr,
        trades=excluded.trades, deliv_pct=excluded.deliv_pct"""
    with conn.cursor() as cur:
        cur.executemany(sql, _records(df, cols))
    conn.commit()
    return len(df)


def store_indices(conn, df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    sql = """
      insert into index_prices (index_name, trade_date, open, high, low, close)
      values (%s,%s,%s,%s,%s,%s)
      on conflict (index_name, trade_date) do update set
        open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close"""
    with conn.cursor() as cur:
        cur.executemany(sql, _records(df, nse.INDEX_COLUMNS))
    conn.commit()
    return len(df)


def weekdays(start: date, end: date):
    d = start
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


def loaded_dates(conn) -> set[date]:
    with conn.cursor() as cur:
        cur.execute("select distinct trade_date from daily_prices")
        return {r[0] for r in cur.fetchall()}


def latest_data_date(conn) -> date | None:
    with conn.cursor() as cur:
        cur.execute("select max(trade_date) from daily_prices")
        return cur.fetchone()[0]


def fetch_prices_for(client: nse.NseClient, d: date) -> tuple[pd.DataFrame | None, str]:
    """Bhavcopy with delivery %; falls back to the UDiFF file (no delivery %) if the main file errors.
    Returns (None, note) when NSE has no file for the date (holiday / not published yet)."""
    try:
        raw = client.get(nse.bhavcopy_url(d))
        if raw is None:
            return None, "no bhavcopy file"
        df = nse.parse_bhavcopy(raw)
        if not df.empty and set(df["trade_date"]) != {d}:
            # file for a different day than requested -> don't trust it
            raise nse.ParseError(f"bhavcopy for {d} contains dates {sorted(set(df['trade_date']))[:3]}")
        return df, "bhavcopy"
    except (nse.FetchError, nse.ParseError) as e:
        log.warning("bhavcopy %s failed (%s); trying UDiFF fallback", d, e)
        raw = client.get(nse.udiff_bhavcopy_url(d))
        if raw is None:
            raise nse.FetchError(f"bhavcopy failed ({e}) and UDiFF fallback has no file") from e
        df = nse.parse_udiff_bhavcopy(raw)
        return df, "udiff fallback (no delivery %)"


def update_prices(conn, client: nse.NseClient, start: date, end: date, *, today: date) -> dict:
    """Fetch every weekday in [start, end] that is not stored yet. Commits per day (resumable)."""
    have = loaded_dates(conn)
    stats = {"loaded": 0, "skipped_existing": 0, "no_file": 0, "errors": [], "rows": 0, "pending_today": False}
    consecutive_errors = 0
    for d in weekdays(start, end):
        if d in have:
            stats["skipped_existing"] += 1
            continue
        try:
            prices, note = fetch_prices_for(client, d)
        except (nse.FetchError, nse.ParseError) as e:
            stats["errors"].append(f"{d}: {e}")
            consecutive_errors += 1
            if consecutive_errors >= 5:
                stats["errors"].append("stopping after 5 consecutive failures (NSE blocked or down?)")
                break
            continue
        consecutive_errors = 0
        if prices is None:
            if d >= today:
                stats["pending_today"] = True
            stats["no_file"] += 1
            continue
        stats["rows"] += store_prices(conn, prices)
        stats["loaded"] += 1
        try:
            raw = client.get(nse.index_close_url(d))
            if raw is not None:
                store_indices(conn, nse.parse_index_close(raw, WANTED_INDICES))
        except (nse.FetchError, nse.ParseError) as e:
            stats["errors"].append(f"{d} indices: {e}")
        if stats["loaded"] % 50 == 0:
            log.info("loaded %d days so far (at %s)", stats["loaded"], d)
    return stats


def refresh_data_status(conn, stats: dict) -> None:
    last = latest_data_date(conn)
    if stats["errors"] and stats["loaded"] == 0 and last is None:
        db.log_source(conn, "bhavcopy", "error", message="; ".join(stats["errors"])[:900])
    elif stats["errors"]:
        db.log_source(conn, "bhavcopy", "error" if stats["loaded"] == 0 else "ok", data_date=last,
                      message=f"{stats['loaded']} days loaded; errors: " + "; ".join(stats["errors"])[:800],
                      rows=stats["rows"])
    else:
        msg = f"{stats['loaded']} new days loaded"
        if stats["pending_today"]:
            msg += " (today's file not published yet)"
        db.log_source(conn, "bhavcopy", "ok", data_date=last, message=msg, rows=stats["rows"])
    with conn.cursor() as cur:
        cur.execute("select max(trade_date), count(*) from index_prices where index_name = %s", (BENCHMARK_INDEX,))
        idx_last, idx_n = cur.fetchone()
    if idx_n:
        db.log_source(conn, "indices", "ok", data_date=idx_last, message=f"{idx_n} days of {BENCHMARK_INDEX}")
    else:
        db.log_source(conn, "indices", "error", message=f"no {BENCHMARK_INDEX} rows stored; market filter cannot run")


# ---------------------------------------------------------------- reference data (latest snapshot only)
def refresh_symbols(conn, client: nse.NseClient) -> None:
    try:
        raw = client.get(nse.EQUITY_LIST_URL)
        if raw is None:
            raise nse.FetchError("EQUITY_L.csv not found")
        df = nse.parse_equity_list(raw)
        sql = """insert into symbols (symbol, name, isin, listing_date, active, updated_at)
                 values (%s,%s,%s,%s,true,now())
                 on conflict (symbol) do update set name=excluded.name, isin=excluded.isin,
                   listing_date=excluded.listing_date, active=true, updated_at=now()"""
        with conn.cursor() as cur:
            cur.executemany(sql, _records(df, ["symbol", "name", "isin", "listing_date"]))
            cur.execute("update symbols set active=false where symbol <> all(%s)", (list(df["symbol"]),))
        conn.commit()
        db.log_source(conn, "equity_list", "ok", message=f"{len(df)} EQ symbols", rows=len(df))
    except (nse.FetchError, nse.ParseError, ValueError) as e:
        conn.rollback()
        db.log_source(conn, "equity_list", "error", message=str(e)[:900])


def refresh_sectors(conn, client: nse.NseClient) -> None:
    mapping: dict[str, str] = {}
    failed: list[str] = []
    for index_name, stem in SECTOR_INDICES.items():
        try:
            raw = client.get(nse.sector_list_url(stem))
            if raw is None:
                failed.append(f"{index_name}: file not found")
                continue
            for sym in nse.parse_constituents(raw)["symbol"]:
                mapping.setdefault(sym, index_name)          # first (narrowest) sector wins
        except (nse.FetchError, nse.ParseError) as e:
            failed.append(f"{index_name}: {e}")
    industry: dict[str, str] = {}
    try:
        raw = client.get(nse.NIFTY500_LIST_URL)
        if raw is not None:
            cons = nse.parse_constituents(raw)
            industry = dict(zip(cons["symbol"], cons["industry"]))
    except (nse.FetchError, nse.ParseError) as e:
        failed.append(f"Nifty 500 industry list: {e}")
    if mapping or industry:
        with conn.cursor() as cur:
            cur.executemany("update symbols set sector = %s where symbol = %s",
                            [(sec, sym) for sym, sec in mapping.items()])
            cur.executemany("update symbols set industry = %s where symbol = %s",
                            [(ind, sym) for sym, ind in industry.items() if ind])
        conn.commit()
    status = "ok" if mapping and not failed else ("error" if not mapping else "ok")
    msg = f"{len(mapping)} stocks mapped to a sector index"
    if failed:
        msg += "; problems: " + "; ".join(failed)[:700]
    db.log_source(conn, "sector_lists", status, message=msg, rows=len(mapping))


def refresh_price_bands(conn, client: nse.NseClient, data_date: date) -> None:
    try:
        raw = client.get(nse.sec_list_url(data_date))
        if raw is None:
            raise nse.FetchError(f"sec_list file for {data_date} not found")
        df = nse.parse_price_bands(raw)
        with conn.cursor() as cur:
            cur.execute("delete from price_bands where trade_date = %s", (data_date,))
            cur.executemany("insert into price_bands (trade_date, symbol, band_pct) values (%s,%s,%s)",
                            [(data_date, r.symbol, r.band_pct) for r in df.itertuples()])
        conn.commit()
        db.log_source(conn, "price_bands", "ok", data_date=data_date, message=f"{len(df)} bands", rows=len(df))
    except (nse.FetchError, nse.ParseError, ValueError) as e:
        conn.rollback()
        db.log_source(conn, "price_bands", "unavailable",
                      message=f"price-band filter NOT applied: {e}"[:900])


def refresh_market_cap(conn, client: nse.NseClient, data_date: date) -> None:
    try:
        raw = client.get(nse.pr_zip_url(data_date))
        if raw is None:
            raise nse.FetchError(f"PR zip for {data_date} not found")
        df = nse.parse_mcap_from_pr_zip(raw)
        with conn.cursor() as cur:
            cur.executemany("update symbols set market_cap_cr = %s where symbol = %s",
                            [(r.market_cap_cr, r.symbol) for r in df.itertuples()])
        conn.commit()
        db.log_source(conn, "market_cap", "ok", data_date=data_date, message=f"{len(df)} market caps", rows=len(df))
    except (nse.FetchError, nse.ParseError, ValueError, KeyError) as e:
        conn.rollback()
        db.log_source(conn, "market_cap", "unavailable",
                      message=f"market-cap filter NOT applied: {e}"[:900])


def refresh_surveillance(conn, client: nse.NseClient, data_date: date) -> None:
    """ASM/GSM lists from NSE's public report endpoints (the ones the NSE website itself shows).
    One request per list per day. Set NSE_SKIP_WEBSITE_API=1 to disable."""
    import os
    if os.environ.get("NSE_SKIP_WEBSITE_API") == "1":
        db.log_source(conn, "asm_gsm", "unavailable", message="disabled via NSE_SKIP_WEBSITE_API; ASM/GSM filter NOT applied")
        return
    rows: list[tuple] = []
    try:
        client.get(nse.WWW + "/")                       # cookie warm-up, as a browser would
        for list_type, path in (("ASM", "/api/reportASM"), ("GSM", "/api/reportGSM")):
            raw = client.get(nse.WWW + path)
            if raw is None:
                raise nse.FetchError(f"{path} not found")
            for sym, stage in _walk_surveillance(json.loads(raw)):
                rows.append((data_date, sym, list_type, stage))
        if not rows:
            raise nse.ParseError("ASM/GSM responses contained no symbols (format change or empty list)")
        with conn.cursor() as cur:
            cur.execute("delete from surveillance where trade_date = %s", (data_date,))
            cur.executemany("insert into surveillance (trade_date, symbol, list_type, stage) values (%s,%s,%s,%s) "
                            "on conflict do nothing", rows)
        conn.commit()
        db.log_source(conn, "asm_gsm", "ok", data_date=data_date, message=f"{len(rows)} ASM/GSM entries", rows=len(rows))
    except (nse.FetchError, nse.ParseError, ValueError) as e:
        conn.rollback()
        db.log_source(conn, "asm_gsm", "unavailable", message=f"ASM/GSM filter NOT applied: {e}"[:900])


def _walk_surveillance(obj):
    """Yield (symbol, stage) from arbitrarily nested NSE report JSON."""
    if isinstance(obj, dict):
        keys = {k.lower(): k for k in obj}
        if "symbol" in keys and isinstance(obj[keys["symbol"]], str):
            stage = next((str(obj[k]) for lk, k in keys.items()
                          if any(t in lk for t in ("stage", "indicator", "survdesc", "surv")) and obj[k]), None)
            yield obj[keys["symbol"]].strip(), stage
        else:
            for v in obj.values():
                yield from _walk_surveillance(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_surveillance(v)


def refresh_reference(conn, client: nse.NseClient, data_date: date) -> None:
    refresh_symbols(conn, client)
    refresh_sectors(conn, client)
    refresh_price_bands(conn, client, data_date)
    refresh_market_cap(conn, client, data_date)
    refresh_surveillance(conn, client, data_date)
