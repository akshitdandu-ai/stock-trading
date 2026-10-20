"""Paper-trading state kept in Postgres: fills, alerts and equity snapshots. Paper only: no broker, no real orders."""
from __future__ import annotations

import logging
from datetime import date

import numpy as np
import pandas as pd

from engine.exits import evaluate_exit
from engine.sizing import book_third_qty, charges, stop_price, target_price

log = logging.getLogger("portfolio")


def cash_balance(conn, s: dict) -> float:
    with conn.cursor() as cur:
        cur.execute("""select coalesce(sum(case when side='sell' then qty*price - charges
                                               else -(qty*price + charges) end), 0)::float8 from fills""")
        return float(s["capital"]) + cur.fetchone()[0]


def open_trades(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute("""select id, symbol, entry_date, entry_price::float8, qty, stop::float8, target::float8,
                              booked_third from trades where status='open' order by id""")
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def last_closes(conn, symbols: list[str], data_date: date) -> dict[str, float]:
    if not symbols:
        return {}
    with conn.cursor() as cur:
        cur.execute("select symbol, close::float8 from daily_prices where trade_date = %s and symbol = any(%s)",
                    (data_date, symbols))
        return dict(cur.fetchall())


def portfolio_state(conn, s: dict, data_date: date) -> dict:
    cash = cash_balance(conn, s)
    trades = open_trades(conn)
    px = last_closes(conn, [t["symbol"] for t in trades], data_date)
    mv = sum(t["qty"] * px.get(t["symbol"], t["entry_price"]) for t in trades)
    open_pnl = sum(t["qty"] * (px.get(t["symbol"], t["entry_price"]) - t["entry_price"]) for t in trades)
    equity = cash + mv
    return {"cash": cash, "equity": equity, "open_pnl": open_pnl, "realized_pnl": equity - float(s["capital"]) - open_pnl}


# ------------------------------------------------------------------ fills
def apply_buy(conn, *, symbol: str, qty: int, price: float, fill_date: date, s: dict, stop: float | None,
              reason: str | None, checklist_score: int | None, notes: str | None) -> int:
    stop_v = stop if stop is not None and stop < price else stop_price(price, s)
    with conn.cursor() as cur:
        cur.execute(
            """insert into trades (symbol, status, entry_date, entry_price, initial_qty, qty, stop, target,
                                   checklist_score, entry_reason, notes)
               values (%s,'open',%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
            (symbol, fill_date, price, qty, qty, stop_v, target_price(price, s), checklist_score, reason, notes))
        trade_id = cur.fetchone()[0]
        cur.execute("insert into fills (trade_id, fill_date, side, qty, price, charges, reason) "
                    "values (%s,%s,'buy',%s,%s,%s,%s)",
                    (trade_id, fill_date, qty, price, charges("buy", qty, price, s), reason or "entry"))
    return trade_id


def apply_sell(conn, *, trade: dict, qty: int, price: float, fill_date: date, reason: str, s: dict) -> None:
    qty = min(qty, trade["qty"])
    with conn.cursor() as cur:
        if qty > 0:
            cur.execute("insert into fills (trade_id, fill_date, side, qty, price, charges, reason) "
                        "values (%s,%s,'sell',%s,%s,%s,%s)",
                        (trade["id"], fill_date, qty, price, charges("sell", qty, price, s), reason))
        remaining = trade["qty"] - qty
        booked = trade["booked_third"] or reason == "target"
        new_stop = max(trade["stop"], trade["entry_price"]) if reason == "target" else trade["stop"]
        if remaining <= 0:
            cur.execute("""select coalesce(sum(case when side='sell' then qty*price - charges
                                                    else -(qty*price + charges) end),0)::float8
                           from fills where trade_id=%s""", (trade["id"],))
            pnl = round(cur.fetchone()[0], 2)
            cur.execute("""update trades set qty=0, status='closed', exit_date=%s, exit_reason=%s, realized_pnl=%s,
                                  booked_third=%s, stop=%s where id=%s""",
                        (fill_date, reason, pnl, booked, new_stop, trade["id"]))
            cur.execute("update alerts set acknowledged = true where trade_id = %s", (trade["id"],))
        else:
            cur.execute("update trades set qty=%s, booked_third=%s, stop=%s where id=%s",
                        (remaining, booked, new_stop, trade["id"]))


def fill_pending_orders(conn, s: dict) -> dict:
    """Fill pending orders at the open of the first session after the day they were confirmed."""
    stats = {"filled": 0, "cancelled": 0, "waiting": 0}
    with conn.cursor() as cur:
        cur.execute("""select id, side, symbol, trade_id, qty, price::float8, reason, checklist_score, notes,
                              stop::float8, created_data_date from orders where status='pending' order by id""")
        cols = [d.name for d in cur.description]
        orders = [dict(zip(cols, r)) for r in cur.fetchall()]
    for o in orders:
        with conn.cursor() as cur:
            cur.execute("""select trade_date, open::float8 from daily_prices
                           where symbol=%s and trade_date > %s order by trade_date limit 1""",
                        (o["symbol"], o["created_data_date"]))
            row = cur.fetchone()
        if row is None:
            stats["waiting"] += 1
            continue
        fill_date, open_px = row
        price = o["price"] or open_px
        if o["side"] == "buy":
            cash = cash_balance(conn, s)
            qty = o["qty"]
            while qty > 0 and qty * price + charges("buy", qty, price, s) > cash:
                qty -= 1
            if qty < 1:
                _set_order(conn, o["id"], "cancelled", fill_date, None, "not enough cash at fill")
                stats["cancelled"] += 1
                continue
            trade_id = apply_buy(conn, symbol=o["symbol"], qty=qty, price=price, fill_date=fill_date, s=s,
                                 stop=o["stop"], reason=o["reason"], checklist_score=o["checklist_score"],
                                 notes=o["notes"])
            _set_order(conn, o["id"], "filled", fill_date, price, None, trade_id=trade_id)
        else:
            trade = _trade(conn, o["trade_id"])
            if trade is None or trade["status"] != "open" or trade["qty"] <= 0:
                _set_order(conn, o["id"], "cancelled", fill_date, None, "position no longer open")
                stats["cancelled"] += 1
                continue
            apply_sell(conn, trade=trade, qty=o["qty"], price=price, fill_date=fill_date,
                       reason=o["reason"] or "manual", s=s)
            _set_order(conn, o["id"], "filled", fill_date, price, None)
        stats["filled"] += 1
        conn.commit()
    conn.commit()
    return stats


def _trade(conn, trade_id) -> dict | None:
    if trade_id is None:
        return None
    with conn.cursor() as cur:
        cur.execute("""select id, symbol, status, entry_date, entry_price::float8, qty, stop::float8, booked_third
                       from trades where id=%s""", (trade_id,))
        r = cur.fetchone()
        return dict(zip([d.name for d in cur.description], r)) if r else None


def _set_order(conn, order_id, status, fill_date, fill_price, note, trade_id=None) -> None:
    with conn.cursor() as cur:
        cur.execute("""update orders set status=%s, fill_date=%s, fill_price=%s,
                              notes = case when %s::text is null then notes else coalesce(notes || ' | ', '') || %s::text end,
                              trade_id = coalesce(%s, trade_id)
                       where id=%s""", (status, fill_date, fill_price, note, note, trade_id, order_id))


# ------------------------------------------------------------------ alerts + snapshot
def generate_alerts(conn, panel, ind, s: dict) -> int:
    """Evening exit-rule check on closing prices for every open trade."""
    data_date = panel.dates[-1].date()
    n = 0
    sym_idx = {sym: k for k, sym in enumerate(panel.symbols)}
    dates = panel.dates
    for t in open_trades(conn):
        k = sym_idx.get(t["symbol"])
        if k is None:
            continue
        close = panel.close.values[-1, k]
        if np.isnan(close):
            continue
        ema = ind.ema_trail.values[-1, k]
        entry_pos = int(dates.searchsorted(pd.Timestamp(t["entry_date"])))
        days_held = max(0, len(dates) - 1 - entry_pos)
        sig = evaluate_exit(entry_price=t["entry_price"], stop=t["stop"], booked_third=t["booked_third"],
                            close=float(close), ema_trail=None if np.isnan(ema) else float(ema),
                            days_held=days_held, s=s)
        if sig is None:
            continue
        with conn.cursor() as cur:
            cur.execute("""insert into alerts (alert_date, trade_id, symbol, kind, message)
                           values (%s,%s,%s,%s,%s) on conflict (alert_date, trade_id, kind) do nothing""",
                        (data_date, t["id"], t["symbol"], sig.kind, sig.message))
            n += cur.rowcount
    conn.commit()
    return n


def snapshot_equity(conn, s: dict, data_date: date, bench_close: float | None) -> dict:
    st = portfolio_state(conn, s, data_date)
    with conn.cursor() as cur:
        cur.execute("""insert into equity_snapshots (snap_date, cash, equity, open_pnl, realized_pnl, bench_close)
                       values (%s,%s,%s,%s,%s,%s)
                       on conflict (snap_date) do update set cash=excluded.cash, equity=excluded.equity,
                         open_pnl=excluded.open_pnl, realized_pnl=excluded.realized_pnl, bench_close=excluded.bench_close""",
                    (data_date, round(st["cash"], 2), round(st["equity"], 2), round(st["open_pnl"], 2),
                     round(st["realized_pnl"], 2), bench_close))
    conn.commit()
    return st
