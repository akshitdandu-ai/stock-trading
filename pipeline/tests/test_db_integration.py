"""End-to-end against a real Postgres (set TEST_DATABASE_URL; the schema from supabase/migrations must exist)."""
import json
import os

import pytest

psycopg = pytest.importorskip("psycopg")
URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL not set")

from config import BENCHMARK_INDEX, DEFAULT_SETTINGS as S
from data import loader
from engine import portfolio
from scanner import scan
from scanner.indicators import compute
from tests.synth import make_long_prices
from tests.test_backtest import RISING

TABLES = ["alerts", "fills", "orders", "trades", "suggestions", "scan_runs", "equity_snapshots", "daily_prices",
          "index_prices", "symbols", "data_sources", "settings", "checklists", "watchlist", "surveillance", "price_bands"]


@pytest.fixture()
def conn():
    c = psycopg.connect(URL, prepare_threshold=None)
    with c.cursor() as cur:
        cur.execute("truncate " + ",".join(TABLES) + " restart identity cascade")
    c.commit()
    yield c
    c.close()


def _store(conn, prices, idx, upto):
    p = prices[prices["trade_date"] <= upto]
    i = idx[idx["trade_date"] <= upto].copy()
    i["open"] = i["high"] = i["low"] = i["close"]
    loader.store_prices(conn, p)
    loader.store_indices(conn, i[["index_name", "trade_date", "open", "high", "low", "close"]])


def test_scan_fill_alert_snapshot_flow(conn):
    prices, idx, dates = make_long_prices(RISING, bench_slope=1.0)
    with conn.cursor() as cur:
        cur.execute("insert into symbols (symbol, name, sector) values ('VCP','Vcp Ltd','Nifty IT'),('DOWN','Down Ltd',null)")
    conn.commit()
    _store(conn, prices, idx, dates[320])

    panel = scan.load_panel(conn)
    ind = compute(panel)
    st = portfolio.portfolio_state(conn, S, dates[320])
    assert st["cash"] == S["capital"] and st["equity"] == S["capital"]
    res = scan.run_scan(conn, panel, ind, S, st["equity"], st["cash"])
    assert res["market_filter_on"] is True, res
    with conn.cursor() as cur:
        cur.execute("select symbol, grp, qty, stop::float8, target::float8, score::float8, screener_url, breakdown "
                    "from suggestions")
        rows = cur.fetchall()
        cur.execute("select market_detail, counts from scan_runs")
        detail, counts = cur.fetchone()
    assert [r[0] for r in rows] == ["VCP"] and rows[0][1] == "breakout"
    assert rows[0][2] == 15 and rows[0][3] == 115.0 and rows[0][4] == 150.0       # 150 risk / 10 per share
    assert rows[0][6] == "https://www.screener.in/company/VCP/"
    assert any("ASM/GSM" in w for w in detail["warnings"])                         # honest about missing filters
    assert counts["breakouts"] == 1

    # user confirms a paper buy at "next open" on the signal day
    with conn.cursor() as cur:
        cur.execute("insert into orders (side, symbol, qty, reason, created_data_date) values ('buy','VCP',15,'breakout',%s)",
                    (dates[320],))
    conn.commit()
    assert portfolio.fill_pending_orders(conn, S) == {"filled": 0, "cancelled": 0, "waiting": 1}   # next session not loaded

    # the following sessions arrive
    for k in range(321, len(dates)):
        _store(conn, prices, idx, dates[k])
        panel = scan.load_panel(conn)
        ind = compute(panel)
        f = portfolio.fill_pending_orders(conn, S)
        if k == 321:
            assert f["filled"] == 1
        portfolio.generate_alerts(conn, panel, ind, S)
        portfolio.snapshot_equity(conn, S, dates[k], None)

    with conn.cursor() as cur:
        cur.execute("select entry_date, entry_price::float8, initial_qty, qty, status, booked_third, stop::float8 from trades")
        t = cur.fetchone()
        cur.execute("select kind from alerts order by alert_date")
        kinds = [r[0] for r in cur.fetchall()]
        cur.execute("select count(*) from equity_snapshots")
        n_snap = cur.fetchone()[0]
    assert t[0] == dates[321] and t[1] == 125.0 and t[2] == 15 and t[4] == "open"
    assert "target" in kinds and "trail" not in kinds[:1]
    assert n_snap == len(dates) - 321

    # confirm the sells like the dashboard would: book 1/3 then exit the rest
    with conn.cursor() as cur:
        cur.execute("select id, symbol, status, entry_date, entry_price::float8, qty, stop::float8, booked_third from trades")
        row = cur.fetchone()
    trade = dict(zip(["id", "symbol", "status", "entry_date", "entry_price", "qty", "stop", "booked_third"], row))
    portfolio.apply_sell(conn, trade=trade, qty=5, price=150.0, fill_date=dates[330], reason="target", s=S)
    with conn.cursor() as cur:
        cur.execute("select qty, booked_third, stop::float8, status from trades")
        assert cur.fetchone() == (10, True, 125.0, "open")                          # stop moved up to entry
    trade.update(qty=10, booked_third=True, stop=125.0)
    portfolio.apply_sell(conn, trade=trade, qty=10, price=140.0, fill_date=dates[335], reason="trail", s=S)
    with conn.cursor() as cur:
        cur.execute("select status, exit_reason, realized_pnl::float8 from trades")
        status, reason, pnl = cur.fetchone()
    # buy 15@125 (1875 + 2.25), sell 5@150 (750 - 0.9 - 20), sell 10@140 (1400 - 1.68 - 20)
    expected = round((750 - 0.9 - 20) + (1400 - 1.68 - 20) - (1875 + 2.25), 2)
    assert (status, reason) == ("closed", "trail") and abs(pnl - expected) < 0.01
    assert abs(portfolio.cash_balance(conn, S) - (S["capital"] + expected)) < 0.01


def test_data_source_logging(conn):
    from db import log_source
    log_source(conn, "asm_gsm", "unavailable", message="blocked")
    log_source(conn, "asm_gsm", "ok", message="fine", rows=3)
    log_source(conn, "asm_gsm", "error", message="later failure")
    with conn.cursor() as cur:
        cur.execute("select status, message, last_success is not null, rows_last from data_sources")
        assert cur.fetchone() == ("error", "later failure", True, 3)                # last_success survives later errors
