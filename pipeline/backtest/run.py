"""Run the backtest on stored history and save results (market filter ON and OFF).

    python -m backtest.run            # last ~2 years (needs ~1 year of earlier history for indicators)
"""
from __future__ import annotations

import json
import logging
import sys

import db
from backtest.simulate import find_signals, simulate
from config import load_settings
from data import loader
from scanner.indicators import compute
from scanner.scan import load_panel

log = logging.getLogger("backtest")

WARMUP_BARS = 252 + 21          # 52-week window + 200DMA one-month-ago comparison
TEST_BARS = 504                 # ~2 years

NOTES = """Survivorship bias and other limits of this backtest
- The stock universe on each day is whatever NSE's daily bhavcopy listed that day (EQ series), so stocks that were later delisted or went to BE/T2T series DO appear while they traded. This reduces, but does not remove, survivorship bias: a stock that disappears before ever showing a signal is invisible, and delisting losses after an open position vanishes are not modelled (open positions are marked at the last available close).
- Sector membership, and surveillance (ASM/GSM), price-band and market-cap filters use TODAY's snapshots or are skipped historically (NSE publishes no easy history), so the backtest applies only the price and liquidity filters. Live scans apply all of them; live results will differ.
- Fills are at the next session's open with no slippage or liquidity impact; real small-cap fills (circuit limits, wide spreads) are worse. Exits use closing prices only.
- Only ~2 years of data is used, and a few dozen trades at most: small samples are noisy. Treat the numbers as a sanity check of the rules, not a forecast.
- Positions are sized with the same rules as live trading (risk % of equity, stop % below entry, capped by cash). With very small capital, share-price rounding matters a lot."""


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    conn = db.connect()
    run_id = db.start_run(conn, "backtest")
    try:
        s = load_settings(conn)
        panel = load_panel(conn, history_days=2200)
        if panel is None:
            raise RuntimeError("no price data stored; run run_daily.py first")
        ind = compute(panel, trail_ema=int(s["trail_ema"]))
        n = len(panel.dates)
        start_i = max(WARMUP_BARS, n - TEST_BARS)
        end_i = n - 1
        if end_i - start_i < 60:
            raise RuntimeError(f"only {n} sessions stored: need at least {WARMUP_BARS + 60} to backtest")
        log.info("backtest %s -> %s (%d sessions)", panel.dates[start_i].date(), panel.dates[end_i].date(), end_i - start_i + 1)
        signals = find_signals(panel, ind, s, start_i, end_i)
        log.info("%d signal days, %d signals", len(signals), sum(len(v) for v in signals.values()))
        results = []
        for on in (True, False):
            r = simulate(panel, ind, signals, s, start_i, end_i, use_market_filter=on)
            r["filter_on"], r["label"] = on, f"market filter {'ON' if on else 'OFF'}"
            results.append(r)
            log.info("%s: %s", r["label"], r["metrics"])
        with conn.cursor() as cur:
            cur.execute("delete from backtest_runs")
            for r in results:
                cur.execute(
                    """insert into backtest_runs (label, filter_on, params, period_start, period_end, metrics,
                                                  equity_curve, trades, notes) values (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (r["label"], r["filter_on"], json.dumps(s), r["period_start"], r["period_end"],
                     json.dumps(r["metrics"]), json.dumps(r["equity_curve"]),
                     json.dumps(r["trades"]), NOTES))
        conn.commit()
        db.finish_run(conn, run_id, True, "backtest saved", loader.latest_data_date(conn))
        return 0
    except Exception as e:
        conn.rollback()
        log.exception("backtest failed")
        db.finish_run(conn, run_id, False, f"{type(e).__name__}: {e}")
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
