"""Settings, defaults and constants shared by the whole pipeline."""
from __future__ import annotations

import json

# Keep in sync with docs/CONTRACT.md and dashboard/lib/settings.ts
DEFAULT_SETTINGS: dict = {
    "capital": 5000,
    "risk_pct": 3,
    "stop_pct": 8,
    "target_pct": 20,
    "charges_pct_per_side": 0.12,
    "dp_charge": 20,
    "stcg_rate_pct": 20,
    "cess_pct": 4,
    "time_stop_days": 21,
    "time_stop_min_gain_pct": 5,
    "trail_ema": 21,
    "watchlist_near_pivot_pct": 5,
    "extended_pct": 5,
    "min_price": 50,
    "min_avg_traded_value_cr": 10,
    "mcap_min_cr": 1000,
    "mcap_max_cr": 30000,
    "rs_min_excess_pp": 20,
    "breakout_vol_mult": 1.5,
    "breakout_deliv_pct": 50,
}

BENCHMARK_INDEX = "Nifty Smallcap 250"
MARKET_INDEX = "Nifty 50"

# NSE sector index name -> file stem of its constituents list under /content/indices/
# (file is ind_<stem>list.csv). Index names are matched case-insensitively against ind_close_all.
SECTOR_INDICES: dict[str, str] = {
    # Order matters: a stock gets the FIRST sector index that lists it, so narrow indices come first.
    "Nifty Bank": "niftybank",
    "Nifty IT": "niftyit",
    "Nifty Auto": "niftyauto",
    "Nifty FMCG": "niftyfmcg",
    "Nifty Pharma": "niftypharma",
    "Nifty Healthcare Index": "niftyhealthcare",
    "Nifty Metal": "niftymetal",
    "Nifty Realty": "niftyrealty",
    "Nifty Media": "niftymedia",
    "Nifty Consumer Durables": "niftyconsumerdurables",
    "Nifty Oil & Gas": "niftyoilgas",
    "Nifty Energy": "niftyenergy",
    "Nifty Infrastructure": "niftyinfra",
    "Nifty Financial Services": "niftyfinance",
}

# Bars (trading days)
BARS_6M = 126
BARS_3M = 63
BARS_1M = 21
BARS_52W = 252
HISTORY_DAYS_DEFAULT = 1100  # calendar days backfilled: ~3 years = 2y of backtest + 1y indicator warm-up


def merge_settings(stored: dict | None) -> dict:
    out = dict(DEFAULT_SETTINGS)
    if stored:
        for k, v in stored.items():
            if k in DEFAULT_SETTINGS and v is not None:
                out[k] = v
    return out


def load_settings(conn) -> dict:
    with conn.cursor() as cur:
        cur.execute("select data from settings where id = 1")
        row = cur.fetchone()
    stored = row[0] if row else None
    if isinstance(stored, str):
        stored = json.loads(stored)
    return merge_settings(stored)
