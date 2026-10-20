import numpy as np

from config import DEFAULT_SETTINGS as S
from backtest.metrics import compute_metrics
from backtest.simulate import find_signals, simulate
from scanner.indicators import compute
from tests.synth import make_panel

RISING = [126, 128, 131, 134, 137, 141, 146, 152, 158, 160, 150, 145, 140, 135, 130]


def test_simulation_enters_next_open_and_has_no_lookahead():
    panel, dates = make_panel(extra_after=RISING)
    ind = compute(panel)
    end_i = len(panel.dates) - 1
    signals = find_signals(panel, ind, S, 280, end_i)
    assert set(signals) == {320}, "only the breakout day should signal"
    res = simulate(panel, ind, signals, S, 280, end_i, use_market_filter=False)
    assert len(res["trades"]) == 1
    t = res["trades"][0]
    assert t["entry_date"] == str(dates[321])                     # next session after the signal
    assert abs(t["entry_price"] - panel.open.values[321, panel.symbols.index("VCP")]) < 1e-6
    assert t["qty"] >= 1
    assert res["metrics"]["trades"] == 1
    # equity curve starts at the configured capital
    assert res["equity_curve"][0]["equity"] == S["capital"]


def test_target_books_third_then_trails():
    panel, _ = make_panel(extra_after=RISING)
    ind = compute(panel)
    end_i = len(panel.dates) - 1
    signals = find_signals(panel, ind, S, 280, end_i)
    res = simulate(panel, ind, signals, S, 280, end_i, use_market_filter=False)
    t = res["trades"][0]
    assert t["pnl"] > 0                                           # +20% reached, partial booked, rest trailed
    assert t["reason"] in ("trail", "stop", "open at end of test")


def test_market_filter_blocks_entries_when_off():
    panel, _ = make_panel(extra_after=RISING)          # benchmark is flat -> close not above 50DMA > 200DMA reliably
    ind = compute(panel)
    end_i = len(panel.dates) - 1
    signals = find_signals(panel, ind, S, 280, end_i)
    import scanner.rules as r
    mf = r.market_filter_series(panel.bench).values
    res = simulate(panel, ind, signals, S, 280, end_i, use_market_filter=True)
    assert len(res["trades"]) == (1 if mf[320] else 0)


def test_metrics_math():
    trades = [{"pnl": 100.0, "risk": 50.0}, {"pnl": -50.0, "risk": 50.0}, {"pnl": 50.0, "risk": 50.0}]
    from datetime import datetime, timedelta
    d0 = datetime(2024, 1, 1)
    dates = [d0 + timedelta(days=k) for k in range(4)]
    m = compute_metrics(trades, [5000, 5100, 5050, 5100], dates, 5000)
    assert m["trades"] == 3 and m["win_rate"] == 66.7
    assert m["avg_win"] == 75.0 and m["avg_loss"] == -50.0
    assert m["expectancy"] == 33.33 and m["profit_factor"] == 3.0
    assert m["max_drawdown_pct"] < 0 and m["total_return_pct"] == 2.0
