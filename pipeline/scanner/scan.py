"""Run the scanner on a panel. `scan_at` is shared by the live scan and the backtest (same rules)."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date

import numpy as np
import pandas as pd

from config import BENCHMARK_INDEX, SECTOR_INDICES
from engine.sizing import position_size, stop_price, target_price
from scanner import rules, scoring
from scanner.indicators import Indicators, compute, sector_ranks
from scanner.panel import Panel, build_panel


@dataclass
class Arrays:
    h: np.ndarray
    l: np.ndarray
    v: np.ndarray
    c: np.ndarray
    deliv: np.ndarray
    avg_vol50: np.ndarray
    excess: np.ndarray


def to_arrays(panel: Panel, ind: Indicators) -> Arrays:
    return Arrays(panel.high.values, panel.low.values, panel.volume.values, panel.close.values,
                  panel.deliv_pct.values, ind.avg_vol50.values, rules.excess_pp(ind).values)


def scan_at(panel: Panel, arr: Arrays, tmask: np.ndarray, umask: np.ndarray, i: int, s: dict,
            allowed: np.ndarray | None = None) -> list[dict]:
    """Candidates (breakout / watchlist / extended) on row i. `allowed` = optional static symbol mask."""
    ok = tmask[i] & umask[i]
    if allowed is not None:
        ok = ok & allowed
    cols = np.flatnonzero(ok)
    if len(cols) == 0:
        return []
    ranks = sector_ranks(panel, i)
    out = []
    for j in cols:
        setup, _why = rules.detect_base(arr.h[:, j], arr.l[:, j], arr.v[:, j], i, float(arr.avg_vol50[i, j]))
        if setup is None:
            continue
        deliv = arr.deliv[i, j]
        grp, info = rules.classify(setup, float(arr.c[i, j]), float(arr.v[i, j]), float(arr.avg_vol50[i, j]),
                                   None if np.isnan(deliv) else float(deliv), s)
        if grp is None:
            continue
        sym = panel.symbols[j]
        sector = panel.sectors.get(sym)
        rank = ranks.get(sector) if sector else None
        total, breakdown = scoring.score(setup, float(arr.excess[i, j]), info["dist_pct"], sector, rank, s)
        out.append({"symbol": sym, "grp": grp, "sector": sector, "close": float(arr.c[i, j]), "pivot": setup.pivot,
                    "dist_pct": info["dist_pct"], "score": total, "breakdown": breakdown, "setup": setup,
                    "info": info, "excess_pp": float(arr.excess[i, j]), "col": int(j)})
    return out


# ------------------------------------------------------------------ live scan
def load_panel(conn, history_days: int = 720) -> Panel | None:
    with conn.cursor() as cur:
        cur.execute("select max(trade_date) from daily_prices")
        last = cur.fetchone()[0]
        if last is None:
            return None
        cur.execute(
            """select symbol, trade_date, open::float8, high::float8, low::float8, close::float8,
                      prev_close::float8, volume::float8, turnover_cr::float8, deliv_pct::float8
               from daily_prices where trade_date >= %s::date - %s::int""", (last, history_days))
        prices = pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])
        cur.execute("select index_name, trade_date, close::float8 from index_prices where trade_date >= %s::date - %s::int",
                    (last, history_days))
        indices = pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])
        cur.execute("select symbol, sector from symbols where sector is not null")
        sectors = dict(cur.fetchall())
    return build_panel(prices, indices, BENCHMARK_INDEX, sectors, list(SECTOR_INDICES))


def static_filters(conn, panel: Panel, s: dict, data_date: date) -> tuple[np.ndarray, list[str], dict]:
    """ASM/GSM, price band and market-cap filters from the latest snapshots. Returns (mask over panel.symbols,
    warnings for filters that could not be applied, per-filter exclusion counts)."""
    n = len(panel.symbols)
    mask = np.ones(n, dtype=bool)
    warnings: list[str] = []
    excluded = {"asm_gsm": 0, "price_band": 0, "market_cap": 0}
    idx = {sym: k for k, sym in enumerate(panel.symbols)}
    with conn.cursor() as cur:
        cur.execute("select source, status, message from data_sources")
        status = {r[0]: (r[1], r[2]) for r in cur.fetchall()}

        if status.get("asm_gsm", ("", ""))[0] == "ok":
            cur.execute("select distinct symbol from surveillance where trade_date = (select max(trade_date) from surveillance)")
            for (sym,) in cur.fetchall():
                if sym in idx and mask[idx[sym]]:
                    mask[idx[sym]] = False
                    excluded["asm_gsm"] += 1
        else:
            warnings.append("ASM/GSM list unavailable: filter NOT applied. " + (status.get("asm_gsm", ("", "not fetched yet"))[1] or ""))

        if status.get("price_bands", ("", ""))[0] == "ok":
            cur.execute("select symbol from price_bands where trade_date = (select max(trade_date) from price_bands) and band_pct <= 10")
            for (sym,) in cur.fetchall():
                if sym in idx and mask[idx[sym]]:
                    mask[idx[sym]] = False
                    excluded["price_band"] += 1
        else:
            warnings.append("Price-band data unavailable: 5%/10% band exclusion NOT applied. " + (status.get("price_bands", ("", "not fetched yet"))[1] or ""))

        if status.get("market_cap", ("", ""))[0] == "ok":
            cur.execute("select symbol, market_cap_cr::float8 from symbols where market_cap_cr is not null")
            have = dict(cur.fetchall())
            for sym, k in idx.items():
                cap = have.get(sym)
                if cap is None:
                    continue            # 'where available': no cap on record -> not excluded
                if cap < s["mcap_min_cr"] or cap > s["mcap_max_cr"]:
                    if mask[k]:
                        mask[k] = False
                        excluded["market_cap"] += 1
        else:
            warnings.append("Market-cap data unavailable: ₹1,000-30,000 cr filter NOT applied. " + (status.get("market_cap", ("", "not fetched yet"))[1] or ""))
        if status.get("sector_lists", ("", ""))[0] != "ok":
            warnings.append("Sector lists unavailable: sector-strength points are 0 for every stock.")
    return mask, warnings, excluded


def run_scan(conn, panel: Panel, ind: Indicators, s: dict, equity: float, cash: float) -> dict:
    """Scan the last row of the panel and write scan_runs + suggestions. Returns a summary dict."""
    i = len(panel.dates) - 1
    data_date = panel.dates[i].date()
    detail = rules.market_filter_detail(panel.bench)
    on = detail["ok"]
    static_mask, warnings, excluded = static_filters(conn, panel, s, data_date)
    detail["warnings"] = detail["warnings"] + warnings
    umask = rules.universe_mask(panel, ind, s).values
    tmask = rules.trend_mask(panel, ind, s).values
    traded = ~np.isnan(panel.close.values[i])
    arr = to_arrays(panel, ind)
    cands = scan_at(panel, arr, tmask, umask, i, s, allowed=static_mask)
    counts = {
        "symbols_traded": int(traded.sum()),
        "pass_price_liquidity": int((umask[i] & traded).sum()),
        "pass_static_filters": int((umask[i] & traded & static_mask).sum()),
        "pass_trend_template": int((umask[i] & traded & static_mask & tmask[i]).sum()),
        "setups_found": len(cands),
        "excluded_by": excluded,
        "breakouts": sum(c["grp"] == "breakout" for c in cands),
        "watchlist": sum(c["grp"] == "watchlist" for c in cands),
        "extended": sum(c["grp"] == "extended" for c in cands),
    }
    rows = []
    if on:
        for c in sorted(cands, key=lambda c: -c["score"]):
            entry = c["close"]
            sz = position_size(entry, equity, cash, s)
            st = c["setup"]
            rows.append((
                data_date, c["symbol"], c["grp"], c["sector"], round(c["close"], 2), round(c["pivot"], 2),
                round(c["dist_pct"], 2), stop_price(entry, s), target_price(entry, s), sz.qty, sz.warning,
                c["score"], json.dumps(c["breakdown"]),
                json.dumps({
                    "base_weeks": st.base_weeks, "base_depth_pct": st.depth_pct, "contractions": st.contractions,
                    "last_contraction_depth_pct": st.last_contraction_depth_pct,
                    "vol_ratio_last_contraction": st.vol_ratio_last,
                    "breakout_volume_x": c["info"]["breakout_volume_x"], "deliv_pct": c["info"]["deliv_pct"],
                    "rs_excess_pp": round(c["excess_pp"], 1), "extended": c["grp"] == "extended",
                    "sma50": _f(ind.sma50.values[i, c["col"]]), "sma150": _f(ind.sma150.values[i, c["col"]]),
                    "sma200": _f(ind.sma200.values[i, c["col"]]), "high_52w": _f(ind.high52.values[i, c["col"]]),
                    "low_52w": _f(ind.low52.values[i, c["col"]]), "notes": c["info"]["notes"],
                }),
                f"https://www.screener.in/company/{c['symbol']}/"))
    else:
        counts["would_be_candidates"] = len(cands)
    with conn.cursor() as cur:
        cur.execute("delete from scan_runs where scan_date = %s", (data_date,))   # cascades to suggestions
        cur.execute("insert into scan_runs (scan_date, data_date, market_filter_on, market_detail, counts) "
                    "values (%s,%s,%s,%s,%s)",
                    (data_date, data_date, on, json.dumps(detail), json.dumps(counts)))
        cur.executemany(
            """insert into suggestions (scan_date, symbol, grp, sector, close, pivot, dist_pct, stop, target, qty,
                 size_warning, score, breakdown, details, screener_url)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", rows)
    conn.commit()
    return {"data_date": data_date, "market_filter_on": on, "counts": counts, "suggestions": len(rows)}


def _f(x) -> float | None:
    return None if x is None or np.isnan(x) else round(float(x), 2)
