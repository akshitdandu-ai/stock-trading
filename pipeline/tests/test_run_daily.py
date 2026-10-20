"""Smoke test of the whole evening run (fake NSE, real Postgres)."""
import os
import sys

import pytest

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL not set")

from data import nse
from tests.synth import make_long_prices
from tests.test_backtest import RISING

HEAD = ("SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, "
        "TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER\n")


def _fake_files():
    prices, idx, dates = make_long_prices(RISING, bench_slope=1.0)
    files = {}
    for d, g in prices.groupby("trade_date"):
        lines = [f"{r.symbol}, EQ, {d.strftime('%d-%b-%Y')}, {r.prev_close}, {r.open}, {r.high}, {r.low}, {r.close}, "
                 f"{r.close}, {r.close}, {int(r.volume)}, {r.turnover_cr * 100}, {r.trades}, 1, {r.deliv_pct}"
                 for r in g.itertuples()]
        files[nse.bhavcopy_url(d)] = (HEAD + "\n".join(lines) + "\n").encode()
    for d, g in idx.groupby("trade_date"):
        v = g["close"].iloc[0]
        files[nse.index_close_url(d)] = (
            "Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value\n"
            f"Nifty Smallcap 250,{d.strftime('%d-%m-%Y')},{v},{v},{v},{v}\n").encode()
    return files, dates


def test_run_daily_end_to_end(monkeypatch):
    import psycopg
    import run_daily
    files, dates = _fake_files()

    class Fake:
        def __init__(self, *a, **k):
            pass

        def get(self, url):
            return files.get(url)

    monkeypatch.setattr(run_daily.nse, "NseClient", Fake)
    monkeypatch.setattr(run_daily.yahoo, "index_history", lambda *a, **k: __import__("pandas").DataFrame())
    monkeypatch.setenv("SUPABASE_DB_URL", URL)
    monkeypatch.setenv("NSE_SKIP_WEBSITE_API", "1")
    monkeypatch.setattr(sys, "argv", ["run_daily.py"])
    conn = psycopg.connect(URL, prepare_threshold=None)
    with conn.cursor() as cur:
        cur.execute("truncate daily_prices, index_prices, symbols, scan_runs, suggestions, data_sources, data_runs, "
                    "trades, fills, orders, alerts, equity_snapshots, settings restart identity cascade")
    conn.commit()
    assert run_daily.main() == 0
    with conn.cursor() as cur:
        cur.execute("select data_date, ok from data_runs where kind='daily'")
        assert cur.fetchone() == (dates[-1], True)
        cur.execute("select count(*) from daily_prices")
        assert cur.fetchone()[0] == 2 * len(dates)
        cur.execute("select source, status from data_sources order by source")
        status = dict(cur.fetchall())
        cur.execute("select scan_date, market_filter_on from scan_runs")
        assert cur.fetchone()[0] == dates[-1]
        cur.execute("select count(*) from settings")
        assert cur.fetchone()[0] == 1
    assert status["bhavcopy"] == "ok" and status["indices"] == "ok"
    assert status["asm_gsm"] == "unavailable" and status["price_bands"] == "unavailable"   # missing sources are reported
    assert status["market_cap"] == "unavailable" and status["equity_list"] == "error"
    conn.close()
