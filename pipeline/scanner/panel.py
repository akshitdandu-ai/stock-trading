"""Build wide (dates x symbols) price panels from stored rows, with split/bonus adjustment."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from data.adjust import adjustment_multiplier


@dataclass
class Panel:
    dates: pd.DatetimeIndex
    symbols: list[str]
    open: pd.DataFrame
    high: pd.DataFrame
    low: pd.DataFrame
    close: pd.DataFrame
    volume: pd.DataFrame
    turnover_cr: pd.DataFrame
    deliv_pct: pd.DataFrame
    bench: pd.Series                       # benchmark index close aligned to dates (ffilled)
    sector_close: pd.DataFrame             # dates x sector index name
    sectors: dict[str, str] = field(default_factory=dict)   # symbol -> sector index name


def _wide(df: pd.DataFrame, col: str) -> pd.DataFrame:
    return df.pivot(index="trade_date", columns="symbol", values=col).sort_index()


def build_panel(prices: pd.DataFrame, indices: pd.DataFrame, benchmark: str,
                sectors: dict[str, str] | None = None, sector_index_names: list[str] | None = None) -> Panel:
    """prices: long frame with symbol, trade_date, open, high, low, close, prev_close, volume, turnover_cr, deliv_pct.
    indices: long frame index_name, trade_date, close."""
    if prices.empty:
        raise ValueError("no price rows to build a panel from")
    prices = prices.copy()
    prices["trade_date"] = pd.to_datetime(prices["trade_date"])
    for c in ("open", "high", "low", "close", "prev_close", "volume", "turnover_cr", "deliv_pct"):
        prices[c] = pd.to_numeric(prices[c], errors="coerce").astype(float)
    close = _wide(prices, "close")
    mult = adjustment_multiplier(close, _wide(prices, "prev_close"))
    mult = mult.reindex(index=close.index, columns=close.columns).fillna(1.0)
    o, h, l = (_wide(prices, c) * mult for c in ("open", "high", "low"))
    c_adj = close * mult
    vol = _wide(prices, "volume") / mult
    panel_dates = close.index
    idx = indices.copy()
    idx["trade_date"] = pd.to_datetime(idx["trade_date"])
    idx["close"] = pd.to_numeric(idx["close"], errors="coerce").astype(float)
    idx_wide = idx.pivot(index="trade_date", columns="index_name", values="close").sort_index()
    idx_wide = idx_wide.reindex(panel_dates.union(idx_wide.index)).ffill().reindex(panel_dates)
    bench = idx_wide[benchmark] if benchmark in idx_wide.columns else pd.Series(np.nan, index=panel_dates)
    names = [n for n in (sector_index_names or []) if n in idx_wide.columns]
    return Panel(
        dates=panel_dates, symbols=list(close.columns),
        open=o, high=h, low=l, close=c_adj, volume=vol,
        turnover_cr=_wide(prices, "turnover_cr"), deliv_pct=_wide(prices, "deliv_pct"),
        bench=bench, sector_close=idx_wide[names], sectors=sectors or {},
    )
