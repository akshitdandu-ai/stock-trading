import numpy as np
import pandas as pd

from data.adjust import adjustment_multiplier
from scanner.indicators import ema, pct_return, sma


def test_sma():
    s = pd.Series([1, 2, 3, 4, 5], dtype=float)
    out = sma(s, 3)
    assert np.isnan(out.iloc[1]) and out.iloc[2] == 2.0 and out.iloc[4] == 4.0


def test_ema_matches_recursion():
    s = pd.Series([10, 11, 12, 13, 14, 15], dtype=float)
    out = ema(s, 3)
    alpha = 2 / 4
    exp = s.iloc[0]
    for x in s.iloc[1:]:
        exp = alpha * x + (1 - alpha) * exp
    assert abs(out.iloc[-1] - exp) < 1e-9
    assert np.isnan(out.iloc[1])


def test_pct_return():
    s = pd.Series([100.0, 110.0, 121.0])
    assert abs(pct_return(s, 2).iloc[-1] - 0.21) < 1e-12


def test_split_adjustment():
    # 1:10 split on day 3: raw close drops 1000 -> 100, NSE's prev_close on that day is 100
    close = pd.DataFrame({"A": [1000.0, 1010.0, 100.0, 101.0]})
    prev = pd.DataFrame({"A": [np.nan, 1000.0, 101.0, 100.0]})
    prev.iloc[2, 0] = 101.0
    # day index 2: prev_close (adjusted by NSE) = 101 vs last close 1010 -> ratio 0.1
    mult = adjustment_multiplier(close, prev)
    assert np.allclose(mult["A"].values, [0.1, 0.1, 1.0, 1.0])
    adj = close * mult
    assert np.allclose(adj["A"].values, [100.0, 101.0, 100.0, 101.0])


def test_small_dividend_adjustment_ignored():
    close = pd.DataFrame({"A": [100.0, 100.0, 100.0]})
    prev = pd.DataFrame({"A": [np.nan, 99.5, 100.0]})
    assert np.allclose(adjustment_multiplier(close, prev)["A"].values, [1.0, 1.0, 1.0])
