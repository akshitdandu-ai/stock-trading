"""Vectorised indicator maths on wide (dates x symbols) frames. Only data up to each row is used."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from config import BARS_1M, BARS_3M, BARS_52W, BARS_6M
from scanner.panel import Panel


def sma(x: pd.DataFrame | pd.Series, n: int):
    return x.rolling(n, min_periods=n).mean()


def ema(x: pd.DataFrame | pd.Series, n: int):
    """Exponential moving average, alpha = 2/(n+1), seeded with the first n values' SMA-free recursion."""
    return x.ewm(span=n, adjust=False, min_periods=n).mean()


def pct_return(x, n: int):
    return x / x.shift(n) - 1.0


@dataclass
class Indicators:
    sma50: pd.DataFrame
    sma150: pd.DataFrame
    sma200: pd.DataFrame
    sma200_lag: pd.DataFrame      # 200 DMA one month (21 bars) ago
    ema_trail: pd.DataFrame
    avg_vol50: pd.DataFrame       # mean volume of the 50 sessions BEFORE each day (excludes the day itself)
    avg_tv50: pd.DataFrame        # mean traded value (INR cr) of the last 50 sessions incl. the day
    high52: pd.DataFrame
    low52: pd.DataFrame
    ret6m: pd.DataFrame
    bench_ret6m: pd.Series


def compute(panel: Panel, trail_ema: int = 21) -> Indicators:
    c = panel.close
    sma200 = sma(c, 200)
    return Indicators(
        sma50=sma(c, 50), sma150=sma(c, 150), sma200=sma200, sma200_lag=sma200.shift(BARS_1M),
        ema_trail=ema(c, trail_ema),
        avg_vol50=panel.volume.shift(1).rolling(50, min_periods=50).mean(),
        avg_tv50=panel.turnover_cr.rolling(50, min_periods=40).mean(),
        high52=panel.high.rolling(BARS_52W, min_periods=BARS_52W).max(),
        low52=panel.low.rolling(BARS_52W, min_periods=BARS_52W).min(),
        ret6m=pct_return(c, BARS_6M),
        bench_ret6m=pct_return(panel.bench, BARS_6M),
    )


def sector_ranks(panel: Panel, i: int) -> dict[str, int]:
    """Rank sector indices (1 = best) by 3-month return as of row i."""
    sc = panel.sector_close
    if sc.empty or i < BARS_3M:
        return {}
    r = (sc.iloc[i] / sc.iloc[i - BARS_3M] - 1.0).dropna().sort_values(ascending=False)
    return {name: k + 1 for k, name in enumerate(r.index)}
