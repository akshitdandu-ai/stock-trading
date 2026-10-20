import numpy as np

from config import DEFAULT_SETTINGS as S
from scanner import rules, scoring
from scanner.indicators import compute
from scanner.scan import scan_at, to_arrays
from tests.synth import make_panel

BREAKOUT_I = 320


def test_zigzag_finds_shrinking_pullbacks():
    h = np.array([100, 99, 95, 90, 94, 98, 97, 93, 92, 95, 96], dtype=float)
    l = h - 1.0
    sw = rules.zigzag_contractions(h, l, 0.03)
    depths = [(p - t) / p for _, _, p, t in sw]
    assert len(depths) >= 1 and depths[0] > 0.08


def test_market_filter_series():
    up = np.linspace(100, 300, 300)
    import pandas as pd
    assert bool(rules.market_filter_series(pd.Series(up)).iloc[-1]) is True
    down = np.linspace(300, 100, 300)
    assert bool(rules.market_filter_series(pd.Series(down)).iloc[-1]) is False


def test_detect_base_on_synthetic_vcp():
    panel, _ = make_panel()
    ind = compute(panel)
    j = panel.symbols.index("VCP")
    h, l, v = panel.high.values[:, j], panel.low.values[:, j], panel.volume.values[:, j]
    setup, why = rules.detect_base(h, l, v, BREAKOUT_I, float(ind.avg_vol50.values[BREAKOUT_I, j]))
    assert setup is not None, why
    assert 10 <= setup.depth_pct <= 30
    assert 3 <= setup.base_weeks <= 10
    assert len(setup.contractions) >= 2 and all(b < a for a, b in zip(setup.contractions, setup.contractions[1:]))
    assert setup.vol_ratio_last < 1.0
    assert abs(setup.pivot - 120 * 1.005) < 0.5          # highest high of the base


def test_scan_flags_breakout_and_ignores_downtrender():
    panel, _ = make_panel()
    ind = compute(panel)
    arr = to_arrays(panel, ind)
    t, u = rules.trend_mask(panel, ind, S).values, rules.universe_mask(panel, ind, S).values
    res = scan_at(panel, arr, t, u, BREAKOUT_I, S)
    syms = {r["symbol"]: r for r in res}
    assert "DOWN" not in syms
    assert syms["VCP"]["grp"] == "breakout"
    assert 0 <= syms["VCP"]["score"] <= 100
    assert abs(sum(c["points"] for c in syms["VCP"]["breakdown"].values()) - syms["VCP"]["score"]) < 0.11


def test_classify_variants():
    panel, _ = make_panel()
    ind = compute(panel)
    j = panel.symbols.index("VCP")
    setup, _ = rules.detect_base(panel.high.values[:, j], panel.low.values[:, j], panel.volume.values[:, j],
                                 BREAKOUT_I, float(ind.avg_vol50.values[BREAKOUT_I, j]))
    avg = 100_000.0
    p = setup.pivot
    assert rules.classify(setup, p * 1.02, 160_000, avg, 55, S)[0] == "breakout"
    assert rules.classify(setup, p * 1.02, 110_000, avg, 55, S)[0] == "watchlist"       # volume too low
    assert rules.classify(setup, p * 1.02, 160_000, avg, 30, S)[0] == "watchlist"       # delivery too low
    assert rules.classify(setup, p * 1.02, 160_000, avg, None, S)[0] == "watchlist"     # delivery unknown
    assert rules.classify(setup, p * 1.07, 160_000, avg, 55, S)[0] == "extended"
    assert rules.classify(setup, p * 0.97, 90_000, avg, 55, S)[0] == "watchlist"        # 3% below pivot
    assert rules.classify(setup, p * 0.90, 90_000, avg, 55, S)[0] is None


def test_score_components_bounded_and_monotonic():
    panel, _ = make_panel()
    ind = compute(panel)
    j = panel.symbols.index("VCP")
    setup, _ = rules.detect_base(panel.high.values[:, j], panel.low.values[:, j], panel.volume.values[:, j],
                                 BREAKOUT_I, float(ind.avg_vol50.values[BREAKOUT_I, j]))
    best, _ = scoring.score(setup, 80, -1, "Nifty IT", 1, S)
    worse, _ = scoring.score(setup, 25, 4.5, "Nifty IT", 5, S)
    assert 0 <= worse < best <= 100
