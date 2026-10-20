"""Day-by-day simulation of the exact same rules on stored history. No look-ahead.

Per day t (using only data up to t's close):
  1. fills queued the previous evening execute at t's OPEN (entries and exits);
  2. exit rules are checked on t's CLOSE for open positions -> sells queued for t+1's open;
  3. if the market filter allows, the scanner runs on t's close; the best-scored 'breakout' signals
     (not already held) are queued as buys for t+1's open, sized by risk % of current equity.
Charges apply to every fill. Exits are decided on closing prices only (intraday stop touches are ignored,
exactly like the live evening alert).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from backtest.metrics import compute_metrics
from engine.exits import evaluate_exit
from engine.sizing import book_third_qty, charges, position_size, stop_price, target_price
from scanner import rules
from scanner.indicators import Indicators
from scanner.panel import Panel
from scanner.scan import Arrays, scan_at, to_arrays


def find_signals(panel: Panel, ind: Indicators, s: dict, start_i: int, end_i: int) -> dict[int, list[dict]]:
    """Breakout signals per row (independent of portfolio state, so reusable across filter on/off runs)."""
    arr = to_arrays(panel, ind)
    tmask = rules.trend_mask(panel, ind, s).values
    umask = rules.universe_mask(panel, ind, s).values
    out: dict[int, list[dict]] = {}
    for i in range(start_i, end_i + 1):
        c = [x for x in scan_at(panel, arr, tmask, umask, i, s) if x["grp"] == "breakout"]
        if c:
            out[i] = sorted(c, key=lambda x: -x["score"])
    return out


def simulate(panel: Panel, ind: Indicators, signals: dict[int, list[dict]], s: dict, start_i: int, end_i: int,
             *, use_market_filter: bool) -> dict:
    mf = rules.market_filter_series(panel.bench).values
    O, C = panel.open.values, panel.close.values
    ema = ind.ema_trail.values
    cash = float(s["capital"])
    positions: dict[int, dict] = {}          # col -> position
    pending_buys: list[dict] = []
    pending_sells: list[dict] = []
    trades: list[dict] = []
    curve: list[tuple] = []

    def finalize(pos: dict, i: int) -> None:
        pnl = pos["cash_out"] - pos["cash_in"]
        trades.append({"symbol": panel.symbols[pos["col"]], "entry_date": str(panel.dates[pos["entry_i"]].date()),
                       "entry_price": round(pos["entry_price"], 2), "exit_date": str(panel.dates[i].date()),
                       "exit_price": round(pos["last_exit_price"], 2), "qty": pos["initial_qty"],
                       "pnl": round(pnl, 2), "ret_pct": round(pnl / pos["cash_in"] * 100, 2),
                       "reason": pos["exit_reason"], "risk": pos["initial_qty"] * pos["entry_price"] * s["stop_pct"] / 100})

    for i in range(start_i, end_i + 1):
        # 1) fills at today's open
        for order in pending_sells:
            pos = positions.get(order["col"])
            px = O[i, order["col"]]
            if pos is None or np.isnan(px):
                continue
            qty = min(order["qty"], pos["qty"])
            if qty <= 0 and order["reason"] == "target":
                pos["booked"], pos["stop"] = True, max(pos["stop"], pos["entry_price"])
                continue
            proceeds = qty * px - charges("sell", qty, px, s)
            cash += proceeds
            pos["cash_out"] += proceeds
            pos["qty"] -= qty
            pos["last_exit_price"] = px
            if order["reason"] == "target":
                pos["booked"], pos["stop"] = True, max(pos["stop"], pos["entry_price"])
            if pos["qty"] <= 0:
                pos["exit_reason"] = order["reason"]
                finalize(pos, i)
                del positions[order["col"]]
            elif order["reason"] != "target":
                pos["exit_reason"] = order["reason"]
        pending_sells = []
        for order in pending_buys:
            col, px = order["col"], O[i, order["col"]]
            if col in positions or np.isnan(px):
                continue
            qty = order["qty"]
            while qty > 0 and qty * px + charges("buy", qty, px, s) > cash:
                qty -= 1
            if qty < 1:
                continue
            cost = qty * px + charges("buy", qty, px, s)
            cash -= cost
            positions[col] = {"col": col, "entry_i": i, "entry_price": float(px), "qty": qty, "initial_qty": qty,
                              "stop": stop_price(float(px), s), "booked": False, "cash_in": cost, "cash_out": 0.0,
                              "last_exit_price": float(px), "exit_reason": None}
        pending_buys = []

        # 2) exit rules on today's close
        for col, pos in list(positions.items()):
            close = C[i, col]
            if np.isnan(close):
                continue
            e = ema[i, col]
            sig = evaluate_exit(entry_price=pos["entry_price"], stop=pos["stop"], booked_third=pos["booked"],
                                close=float(close), ema_trail=None if np.isnan(e) else float(e),
                                days_held=i - pos["entry_i"], s=s)
            if sig is None or any(o["col"] == col for o in pending_sells):
                continue
            if sig.kind == "target":
                pending_sells.append({"col": col, "qty": book_third_qty(pos["qty"]), "reason": "target"})
            else:
                pending_sells.append({"col": col, "qty": pos["qty"], "reason": sig.kind})

        # mark to market
        mv = sum(p["qty"] * (C[i, p["col"]] if not np.isnan(C[i, p["col"]]) else p["entry_price"])
                 for p in positions.values())
        equity = cash + mv
        curve.append((panel.dates[i], equity))

        # 3) new signals -> buys at next open
        if i < end_i and (not use_market_filter or mf[i]):
            held = set(positions)
            queued = 0
            avail = cash
            for sig in signals.get(i, []):
                if sig["col"] in held:
                    continue
                sz = position_size(sig["close"], equity, avail, s)
                if sz.qty < 1:
                    continue
                pending_buys.append({"col": sig["col"], "qty": sz.qty})
                avail -= sz.qty * sig["close"] * (1 + s["charges_pct_per_side"] / 100)
                queued += 1

    # close out any still-open positions at the last close (marked, flagged as open)
    for col, pos in list(positions.items()):
        px = C[end_i, col]
        if np.isnan(px):
            px = pos["entry_price"]
        proceeds = pos["qty"] * px - charges("sell", pos["qty"], px, s)
        pos["cash_out"] += proceeds
        pos["last_exit_price"] = float(px)
        pos["exit_reason"] = "open at end of test"
        finalize(pos, end_i)

    dates = [d for d, _ in curve]
    equity_list = [e for _, e in curve]
    bench = panel.bench.values[start_i:end_i + 1]
    b0 = bench[~np.isnan(bench)][0] if (~np.isnan(bench)).any() else np.nan
    curve_json = [{"d": str(d.date()), "equity": round(e, 2),
                   "bench": None if np.isnan(b) or np.isnan(b0) else round(float(s["capital"]) * b / b0, 2)}
                  for d, e, b in zip(dates, equity_list, bench)]
    metrics = compute_metrics(trades, equity_list, [d.to_pydatetime() for d in dates], float(s["capital"]))
    return {"metrics": metrics, "equity_curve": curve_json, "trades": trades,
            "period_start": dates[0].date(), "period_end": dates[-1].date()}
