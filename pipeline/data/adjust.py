"""Corporate-action (split/bonus) adjustment of raw price history, derived from NSE's own PREV_CLOSE.

NSE re-bases a stock's previous close on the ex-date. If prev_close(t) differs from close(t-1) by more than
`threshold`, a corporate action happened on t and every earlier price is multiplied by the ratio
prev_close(t) / close(t-1) (volume divided by it). Small ratios (< threshold, e.g. ordinary dividends) are ignored.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def adjustment_multiplier(close: pd.DataFrame, prev_close: pd.DataFrame, threshold: float = 0.02) -> pd.DataFrame:
    """Wide frames (dates x symbols) -> multiplier frame to apply to prices on each date.

    mult[t] = product of event ratios on dates AFTER t (so the latest prices are unchanged)."""
    last_close = close.ffill().shift(1)                       # close of the previous session actually traded
    ratio = prev_close / last_close
    is_event = (ratio - 1).abs() > threshold
    ratio = ratio.where(is_event & ratio.notna() & (ratio > 0), 1.0)
    # product of ratios strictly after t:  reverse cumprod then shift back
    rev = ratio.iloc[::-1].cumprod().iloc[::-1]
    mult = rev.shift(-1).fillna(1.0)
    return mult
