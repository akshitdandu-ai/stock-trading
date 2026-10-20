"""Backtest performance metrics."""
from __future__ import annotations

import math

import numpy as np


def compute_metrics(trades: list[dict], equity: list[float], dates: list, start_capital: float) -> dict:
    """trades: dicts with pnl (net of charges) and risk (INR risked at entry). equity: daily equity series."""
    pnls = np.array([t["pnl"] for t in trades], dtype=float)
    wins, losses = pnls[pnls > 0], pnls[pnls <= 0]
    gross_win, gross_loss = wins.sum(), -losses.sum()
    risks = np.array([t.get("risk") or np.nan for t in trades], dtype=float)
    r_mult = pnls / risks if len(pnls) else np.array([])
    eq = np.array(equity, dtype=float)
    peak = np.maximum.accumulate(eq) if len(eq) else eq
    dd = (eq / peak - 1.0) * 100 if len(eq) else eq
    years = (dates[-1] - dates[0]).days / 365.25 if len(dates) > 1 else 0
    final = float(eq[-1]) if len(eq) else float(start_capital)
    cagr = ((final / start_capital) ** (1 / years) - 1) * 100 if years > 0 and final > 0 else None
    return {
        "trades": len(trades),
        "win_rate": round(len(wins) / len(pnls) * 100, 1) if len(pnls) else None,
        "avg_win": round(float(wins.mean()), 2) if len(wins) else None,
        "avg_loss": round(float(losses.mean()), 2) if len(losses) else None,
        "expectancy": round(float(pnls.mean()), 2) if len(pnls) else None,
        "expectancy_r": round(float(np.nanmean(r_mult)), 2) if len(r_mult) and not np.isnan(r_mult).all() else None,
        "profit_factor": round(float(gross_win / gross_loss), 2) if gross_loss > 0 else None,  # None: no losing trades
        "max_drawdown_pct": round(float(dd.min()), 2) if len(dd) else None,
        "cagr_pct": round(cagr, 2) if cagr is not None else None,
        "total_return_pct": round((final / start_capital - 1) * 100, 2),
        "final_equity": round(final, 2),
        "start_capital": start_capital,
    }
