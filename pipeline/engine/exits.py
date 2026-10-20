"""Evening exit rules, evaluated on closing prices. Same function drives live alerts and the backtest."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ExitSignal:
    kind: str       # 'stop' | 'target' | 'trail' | 'time_stop'
    message: str


def evaluate_exit(*, entry_price: float, stop: float, booked_third: bool, close: float,
                  ema_trail: float | None, days_held: int, s: dict) -> ExitSignal | None:
    """Most urgent applicable signal, or None.

    Priority: stop > target > trail > time stop.
      * close <= stop              -> sell at next open
      * close >= +target%          -> book 1/3 and move stop to entry (only before booking)
      * after booking: close < EMA -> sell the rest (trail)
      * >= time_stop_days held and gain < time_stop_min_gain% -> time-stop (only before booking)
    `days_held` is the number of trading sessions since entry (entry day = 0)."""
    if close <= stop:
        return ExitSignal("stop", f"Close ₹{close:,.2f} ≤ stop ₹{stop:,.2f}: sell at next open")
    gain_pct = (close / entry_price - 1) * 100
    if not booked_third and close >= entry_price * (1 + s["target_pct"] / 100.0) - 1e-9:
        return ExitSignal("target", f"Up {gain_pct:.1f}% (≥ {s['target_pct']}%): book 1/3, move stop to entry")
    if booked_third and ema_trail is not None and close < ema_trail:
        return ExitSignal("trail", f"Close ₹{close:,.2f} below {s['trail_ema']}-day EMA ₹{ema_trail:,.2f}: "
                                   f"sell the rest at next open")
    if (not booked_third and days_held >= s["time_stop_days"] and gain_pct < s["time_stop_min_gain_pct"]):
        return ExitSignal("time_stop", f"Held {days_held} sessions with only {gain_pct:.1f}% gain "
                                       f"(< {s['time_stop_min_gain_pct']}%): time-stop, sell at next open")
    return None


def raised_stop(current_stop: float, new_stop: float) -> float:
    """Stops can only move up."""
    return max(current_stop, new_stop)
