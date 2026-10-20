"""Scanner rules: market filter, universe filter, trend template, base/VCP detection, breakout classification."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from config import BARS_1M
from scanner.indicators import Indicators
from scanner.panel import Panel


# ------------------------------------------------------------------ market filter
def market_filter_series(bench: pd.Series) -> pd.Series:
    """True when the benchmark closes above its 50 DMA and the 50 DMA is above the 200 DMA."""
    s50 = bench.rolling(50, min_periods=50).mean()
    s200 = bench.rolling(200, min_periods=200).mean()
    return ((bench > s50) & (s50 > s200)).fillna(False)


def market_filter_detail(bench: pd.Series) -> dict:
    s50 = bench.rolling(50, min_periods=50).mean()
    s200 = bench.rolling(200, min_periods=200).mean()
    ok = market_filter_series(bench)
    last = bench.dropna()
    if last.empty or math.isnan(s200.iloc[-1]):
        return {"ok": False, "index_close": None, "sma50": None, "sma200": None,
                "rule": "close > 50 DMA > 200 DMA",
                "warnings": ["Not enough benchmark index history (need 200 sessions): market filter cannot be evaluated; treated as OFF."]}
    return {"ok": bool(ok.iloc[-1]), "index_close": float(bench.iloc[-1]), "sma50": float(s50.iloc[-1]),
            "sma200": float(s200.iloc[-1]), "rule": "close > 50 DMA > 200 DMA", "warnings": []}


# ------------------------------------------------------------------ universe + trend (vectorised)
def universe_mask(panel: Panel, ind: Indicators, s: dict) -> pd.DataFrame:
    """Price and liquidity filters that can be applied on any historical date."""
    return (panel.close > s["min_price"]) & (ind.avg_tv50 > s["min_avg_traded_value_cr"])


def trend_mask(panel: Panel, ind: Indicators, s: dict) -> pd.DataFrame:
    c = panel.close
    m = (c > ind.sma50) & (ind.sma50 > ind.sma150) & (ind.sma150 > ind.sma200)
    m &= ind.sma200 > ind.sma200_lag
    m &= c >= ind.high52 * 0.75                       # within 25% of 52-week high
    m &= c >= ind.low52 * 1.30                        # at least 30% above 52-week low
    excess_pp = (ind.ret6m.sub(ind.bench_ret6m, axis=0)) * 100.0
    m &= excess_pp >= s["rs_min_excess_pp"]
    return m.fillna(False)


def excess_pp(ind: Indicators) -> pd.DataFrame:
    return ind.ret6m.sub(ind.bench_ret6m, axis=0) * 100.0


# ------------------------------------------------------------------ base / VCP detection
@dataclass
class Setup:
    start: int
    n_bars: int
    base_weeks: float
    pivot: float
    base_low: float
    depth_pct: float
    contractions: list[float]
    last_contraction_depth_pct: float
    last_contraction_start: int
    vol_ratio_last: float
    notes: list[str] = field(default_factory=list)


def zigzag_contractions(h: np.ndarray, l: np.ndarray, thresh: float = 0.03) -> list[tuple[int, int, float, float]]:
    """Pullbacks inside a base. h[0] is the base peak. Returns [(peak_idx, trough_idx, peak, trough)], oldest first.
    A swing is recorded only once price reverses by at least `thresh` (3%)."""
    swings: list[tuple[str, int, float]] = []
    kind, idx, price = "H", 0, float(h[0])
    for j in range(1, len(h)):
        if kind == "H":
            if h[j] > price:
                idx, price = j, float(h[j])
            elif l[j] <= price * (1 - thresh):
                swings.append(("H", idx, price))
                kind, idx, price = "L", j, float(l[j])
        else:
            if l[j] < price:
                idx, price = j, float(l[j])
            elif h[j] >= price * (1 + thresh):
                swings.append(("L", idx, price))
                kind, idx, price = "H", j, float(h[j])
    swings.append((kind, idx, price))
    out = []
    for a, b in zip(swings, swings[1:]):
        if a[0] == "H" and b[0] == "L":
            out.append((a[1], b[1], a[2], b[2]))
    return out


def detect_base(h: np.ndarray, l: np.ndarray, v: np.ndarray, i: int, avg_vol50: float, *,
                min_bars: int = 15, max_bars: int = 50, depth_min: float = 10.0, depth_max: float = 30.0,
                zz: float = 0.03) -> tuple[Setup | None, str]:
    """Look for a 3-10 week base ending the session BEFORE bar i (today's bar is not part of the base).

    Pivot = highest high of the base. Needs depth 10-30%, >= 2 pullbacks each smaller than the previous,
    and average volume since the last pullback's peak below the 50-day average volume."""
    lo = max(0, i - max_bars)
    if i - lo < min_bars:
        return None, "not enough history"
    window = h[lo:i]
    if np.isnan(window).any() or np.isnan(l[lo:i]).any():
        return None, "gaps in price data"
    start = lo + int(np.argmax(window))                  # first occurrence of the highest high
    n = i - start
    if n < min_bars:
        return None, f"highest high only {n} sessions ago (< {min_bars}): no base yet"
    hb, lb = h[start:i], l[start:i]
    pivot = float(hb[0])
    base_low = float(lb.min())
    depth = (pivot - base_low) / pivot * 100.0
    if depth < depth_min:
        return None, f"base too shallow ({depth:.1f}% < {depth_min:.0f}%)"
    if depth > depth_max:
        return None, f"base too deep ({depth:.1f}% > {depth_max:.0f}%)"
    swings = zigzag_contractions(hb, lb, zz)
    depths = [(p - t) / p * 100.0 for _, _, p, t in swings]
    if len(depths) < 2:
        return None, f"needs >= 2 pullbacks of >= {zz*100:.0f}% (found {len(depths)})"
    if any(d2 >= d1 for d1, d2 in zip(depths, depths[1:])):
        return None, "pullbacks not getting smaller: " + " > ".join(f"{d:.1f}%" for d in depths)
    last_peak_abs = start + swings[-1][0]
    vol_seg = v[last_peak_abs:i]
    if len(vol_seg) == 0 or np.isnan(vol_seg).any() or not avg_vol50 or math.isnan(avg_vol50):
        return None, "volume data missing"
    ratio = float(vol_seg.mean() / avg_vol50)
    if ratio >= 1.0:
        return None, f"no volume dry-up (last contraction volume {ratio:.2f}x of 50-day average)"
    return Setup(start=start, n_bars=n, base_weeks=round(n / 5.0, 1), pivot=pivot, base_low=base_low,
                 depth_pct=round(depth, 2), contractions=[round(d, 2) for d in depths],
                 last_contraction_depth_pct=round(depths[-1], 2), last_contraction_start=last_peak_abs,
                 vol_ratio_last=round(ratio, 3)), "ok"


def classify(setup: Setup, close: float, volume: float, avg_vol50: float, deliv_pct: float | None, s: dict
             ) -> tuple[str | None, dict]:
    """Return (group, info). group in 'breakout' | 'watchlist' | 'extended' | None."""
    pivot = setup.pivot
    info: dict = {"dist_pct": round((pivot - close) / pivot * 100.0, 2), "notes": []}
    vol_x = volume / avg_vol50 if avg_vol50 else float("nan")
    info["breakout_volume_x"] = None if math.isnan(vol_x) else round(vol_x, 2)
    info["deliv_pct"] = None if deliv_pct is None or (isinstance(deliv_pct, float) and math.isnan(deliv_pct)) else float(deliv_pct)
    if close > pivot * (1 + s["extended_pct"] / 100.0):
        info["notes"].append(f"Extended: close is {-info['dist_pct']:.1f}% above the pivot. Do not buy.")
        return "extended", info
    if close > pivot:
        vol_ok = not math.isnan(vol_x) and vol_x >= s["breakout_vol_mult"]
        deliv_ok = info["deliv_pct"] is not None and info["deliv_pct"] >= s["breakout_deliv_pct"]
        if vol_ok and deliv_ok:
            return "breakout", info
        why = []
        if not vol_ok:
            why.append(f"volume {vol_x:.1f}x < {s['breakout_vol_mult']}x")
        if not deliv_ok:
            why.append("delivery % unavailable" if info["deliv_pct"] is None
                       else f"delivery {info['deliv_pct']:.0f}% < {s['breakout_deliv_pct']}%")
        info["notes"].append("Above pivot but breakout not confirmed: " + ", ".join(why))
        return "watchlist", info
    if info["dist_pct"] <= s["watchlist_near_pivot_pct"]:
        return "watchlist", info
    return None, info
