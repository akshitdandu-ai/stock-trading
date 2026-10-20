from config import DEFAULT_SETTINGS as S
from engine.sizing import book_third_qty, charges, position_size, stop_price, tax_estimate, target_price


def test_stop_and_target():
    assert stop_price(100, S) == 92.0
    assert target_price(100, S) == 120.0


def test_charges_buy_and_sell():
    assert charges("buy", 18, 100, S) == 2.16            # 1800 * 0.12%
    assert charges("sell", 18, 100, S) == 22.16          # + Rs 20 DP charge


def test_position_size_risk_limited():
    sz = position_size(100, equity=5000, cash=5000, s=S)  # risk 150 / 8 per share = 18.75 -> 18
    assert sz.qty == 18 and sz.stop == 92.0 and sz.warning is None


def test_position_size_cash_limited():
    sz = position_size(100, equity=100000, cash=1000, s=S)   # risk would allow 375 shares, cash only 9
    assert sz.qty == 9


def test_position_size_too_expensive_risk():
    sz = position_size(3000, equity=5000, cash=5000, s=S)    # 150 / 240 = 0.6 shares
    assert sz.qty == 0 and "Too expensive" in sz.warning and "risking" in sz.warning


def test_position_size_too_expensive_cash():
    sz = position_size(8000, equity=5000, cash=5000, s=S)
    assert sz.qty == 0 and "cash" in sz.warning


def test_book_third():
    assert [book_third_qty(q) for q in (0, 1, 2, 3, 9, 10, 11)] == [0, 0, 1, 1, 3, 3, 4]


def test_tax_estimate():
    assert tax_estimate(1000, S) == 208.0                    # 20% + 4% cess
    assert tax_estimate(-500, S) == 0.0
