"""0-100 ranking score with a transparent per-component breakdown."""
from __future__ import annotations

from scanner.rules import Setup

MAX_POINTS = {"relative_strength": 30, "closeness_to_pivot": 25, "tightness": 20,
              "volume_dryup": 15, "sector_strength": 10}
SECTOR_POINTS = {1: 10.0, 2: 7.0, 3: 4.0}


def _clip(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def score(setup: Setup, excess_pp: float, dist_pct: float, sector: str | None, sector_rank: int | None,
          s: dict) -> tuple[float, dict]:
    """Components (max):
      relative strength 30: 6M excess return vs benchmark, 20pp (the minimum to pass) -> 0, 80pp+ -> 30
      closeness to pivot 25: at/above pivot -> 25, `watchlist_near_pivot_pct` below -> 0, linear
      tightness 20: last contraction depth <= 3% -> 20, >= 12% -> 0, linear
      volume dry-up 15: last-contraction volume / 50-day avg <= 0.5 -> 15, >= 1.0 -> 0, linear
      sector strength 10: sector index rank by 3M return: #1 10, #2 7, #3 4, else 0
    """
    near = s["watchlist_near_pivot_pct"]
    rs_pts = 30 * _clip((excess_pp - s["rs_min_excess_pp"]) / 60.0)
    close_pts = 25.0 if dist_pct <= 0 else 25 * _clip(1 - dist_pct / near)
    tight_pts = 20 * _clip((12.0 - setup.last_contraction_depth_pct) / 9.0)
    vol_pts = 15 * _clip((1.0 - setup.vol_ratio_last) / 0.5)
    sec_pts = SECTOR_POINTS.get(sector_rank or 0, 0.0)
    if sector is None:
        sec_detail = "sector unknown: 0 points"
    elif sector_rank is None:
        sec_detail = f"{sector}: no index data, 0 points"
    else:
        sec_detail = f"{sector} ranked #{sector_rank} by 3-month return"
    bd = {
        "relative_strength": {"points": round(rs_pts, 1), "max": 30,
                              "detail": f"6M return beats benchmark by {excess_pp:+.1f}pp"},
        "closeness_to_pivot": {"points": round(close_pts, 1), "max": 25,
                               "detail": ("at/above pivot" if dist_pct <= 0 else f"{dist_pct:.1f}% below pivot")},
        "tightness": {"points": round(tight_pts, 1), "max": 20,
                      "detail": f"last contraction {setup.last_contraction_depth_pct:.1f}% deep"},
        "volume_dryup": {"points": round(vol_pts, 1), "max": 15,
                         "detail": f"last-contraction volume {setup.vol_ratio_last:.2f}x of 50-day average"},
        "sector_strength": {"points": round(sec_pts, 1), "max": 10, "detail": sec_detail},
    }
    total = round(sum(v["points"] for v in bd.values()), 1)
    return total, bd
