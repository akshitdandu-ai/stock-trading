"""Position sizing, charges, tax and P&L maths. Pure functions; mirrored in dashboard/lib/engine.ts."""
from __future__ import annotations

import math
from dataclasses import dataclass


def charges(side: str, qty: int, price: float, s: dict) -> float:
    """Per-side % charge on traded value, plus the flat DP charge on every sell."""
    value = qty * price
    c = value * s["charges_pct_per_side"] / 100.0
    if side == "sell":
        c += s["dp_charge"]
    return round(c, 2)


def stop_price(entry: float, s: dict) -> float:
    return round(entry * (1 - s["stop_pct"] / 100.0), 2)


def target_price(entry: float, s: dict) -> float:
    return round(entry * (1 + s["target_pct"] / 100.0), 2)


@dataclass
class Sizing:
    qty: int
    stop: float
    risk_amount: float
    cost: float
    warning: str | None


def position_size(entry: float, equity: float, cash: float, s: dict) -> Sizing:
    """qty = risk / (entry - stop), capped by cash (including the buy charge). qty 0 => warning."""
    stop = stop_price(entry, s)
    risk_amount = equity * s["risk_pct"] / 100.0
    per_share_risk = entry - stop
    if entry <= 0 or per_share_risk <= 0:
        return Sizing(0, stop, risk_amount, 0.0, "invalid entry price or stop")
    by_risk = math.floor(risk_amount / per_share_risk)
    by_cash = math.floor(cash / (entry * (1 + s["charges_pct_per_side"] / 100.0)))
    qty = max(0, min(by_risk, by_cash))
    warning = None
    if qty < 1:
        if by_cash < 1:
            warning = (f"Too expensive: cash ₹{cash:,.0f} cannot buy even 1 share at ₹{entry:,.2f}")
        else:
            warning = (f"Too expensive: risking {s['risk_pct']}% (₹{risk_amount:,.0f}) with a "
                       f"{s['stop_pct']}% stop buys less than 1 share at ₹{entry:,.2f}")
    return Sizing(qty, stop, risk_amount, round(qty * entry, 2), warning)


def book_third_qty(qty: int) -> int:
    """Shares to sell when booking 1/3: round(qty/3), at least 1 if qty >= 2, else none."""
    if qty < 2:
        return 0
    return max(1, int(round(qty / 3.0)))


def tax_estimate(net_realised_gain: float, s: dict) -> float:
    """STCG on net gains only: 20% + 4% cess => 20.8%. Losses give no refund here (conservative display)."""
    gain = max(0.0, net_realised_gain)
    return round(gain * s["stcg_rate_pct"] / 100.0 * (1 + s["cess_pct"] / 100.0), 2)


def sell_pnl(entry_price: float, qty: int, exit_price: float, entry_charges_share: float, exit_charges: float) -> float:
    """Net P&L of selling `qty` shares bought at entry_price (entry charges pro-rated by caller)."""
    return round((exit_price - entry_price) * qty - entry_charges_share - exit_charges, 2)
