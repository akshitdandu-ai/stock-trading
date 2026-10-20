"""Synthetic market used by tests: one textbook VCP breakout stock, one downtrender, flat benchmark."""
from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pandas as pd

from config import BENCHMARK_INDEX
from scanner.panel import build_panel


def trading_dates(n: int, start: date = date(2024, 1, 1)) -> list[date]:
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def vcp_closes(extra_after: list[float] | None = None) -> np.ndarray:
    """270 trend bars 40->120, then a 50-bar base with shrinking pullbacks, then a breakout bar at 125."""
    trend = 40 * 3 ** (np.arange(270) / 269.0)
    leg = lambda a, b, n: np.linspace(a, b, n, endpoint=False)
    base = np.concatenate([
        leg(120, 102, 15), leg(102, 117, 10),      # pullback 1 ~15%
        leg(117, 108, 10), leg(108, 115, 7),       # pullback 2 ~7.7%
        leg(115, 111, 5), leg(111, 114, 3),        # pullback 3 ~3.5%
    ])                                             # 50 bars
    c = np.concatenate([trend, base, [125.0]])
    if extra_after:
        c = np.concatenate([c, extra_after])
    return c


def make_long_prices(extra_after: list[float] | None = None, bench_slope: float = 0.0):
    closes = vcp_closes(extra_after)
    n = len(closes)
    dates = trading_dates(n)
    rows = []
    vol = np.full(n, 100_000.0)
    vol[290:320] = 60_000.0                         # dry-up inside the last contraction
    vol[320] = 220_000.0                            # breakout volume
    deliv = np.full(n, 40.0)
    deliv[320] = 62.0
    prev = closes[0]
    for k, (d, c) in enumerate(zip(dates, closes)):
        o = prev
        rows.append(("VCP", d, o, max(o, c) * 1.005, min(o, c) * 0.995, c, prev, vol[k], 20.0, 5000, deliv[k]))
        prev = c
    # a stock in a steady downtrend
    down = 200 * 0.998 ** np.arange(n)
    prev = down[0]
    for k, (d, c) in enumerate(zip(dates, down)):
        rows.append(("DOWN", d, prev, max(prev, c) * 1.005, min(prev, c) * 0.995, c, prev, 100_000.0, 20.0, 5000, 45.0))
        prev = c
    prices = pd.DataFrame(rows, columns=["symbol", "trade_date", "open", "high", "low", "close", "prev_close",
                                         "volume", "turnover_cr", "trades", "deliv_pct"])
    idx = pd.DataFrame({"index_name": BENCHMARK_INDEX, "trade_date": dates,
                        "close": 1000.0 + bench_slope * np.arange(n) + np.sin(np.arange(n) / 7.0)})
    return prices, idx, dates


def make_panel(extra_after: list[float] | None = None, bench_slope: float = 0.0):
    prices, idx, dates = make_long_prices(extra_after, bench_slope)
    return build_panel(prices, idx, BENCHMARK_INDEX, sectors={"VCP": "Nifty IT"}), dates
