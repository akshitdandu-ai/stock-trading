from config import DEFAULT_SETTINGS as S
from engine.exits import evaluate_exit, raised_stop


def ev(**kw):
    base = dict(entry_price=100, stop=92, booked_third=False, close=105, ema_trail=100, days_held=5, s=S)
    base.update(kw)
    return evaluate_exit(**base)


def test_no_signal():
    assert ev() is None


def test_stop_hit():
    assert ev(close=92).kind == "stop"
    assert ev(close=90).kind == "stop"


def test_target():
    sig = ev(close=120)
    assert sig.kind == "target" and "book 1/3" in sig.message


def test_target_not_repeated_after_booking():
    assert ev(close=125, booked_third=True, ema_trail=110) is None


def test_trail_only_after_booking():
    assert ev(close=108, booked_third=True, ema_trail=112, stop=100).kind == "trail"
    assert ev(close=108, booked_third=False, ema_trail=112) is None


def test_time_stop():
    assert ev(close=103, days_held=21).kind == "time_stop"
    assert ev(close=106, days_held=21) is None            # >= 5% gain: not flat
    assert ev(close=103, days_held=20) is None


def test_stop_beats_other_signals():
    assert ev(close=91, days_held=30).kind == "stop"


def test_stops_only_move_up():
    assert raised_stop(92, 95) == 95
    assert raised_stop(100, 95) == 100
