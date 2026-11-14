"""Calibração de área bruta -> mg (aba PostRun) — casos sintéticos,
incluindo o cursor corrompido (`Curs_2=0`) que o GeoWorks às vezes grava."""

import pytest


def test_pick_bounds_uses_min_max_not_position():
    """Curs_1..Curs_N não vêm em ordem crescente de índice (são pontos
    nomeados, não uma sequência)."""
    from app.modules.postrun_b00 import Cursor
    from app.modules.postrun_calibration import pick_bounds

    cursor = Cursor(values=[180, 516, 566, 736, 1030, 516], base=90.0)
    assert pick_bounds(cursor) == (180, 1030)


def test_pick_bounds_filters_invalid_zero_value():
    """`Curs_2=0` (cursor corrompido pelo próprio GeoWorks) não deve virar
    um limite válido."""
    from app.modules.postrun_b00 import Cursor
    from app.modules.postrun_calibration import pick_bounds

    cursor = Cursor(values=[180, 0, 566, 736, 1030, 0], base=90.0)
    assert pick_bounds(cursor) == (180, 1030)


def test_pick_bounds_none_when_fewer_than_two_valid_points():
    from app.modules.postrun_b00 import Cursor
    from app.modules.postrun_calibration import pick_bounds

    assert pick_bounds(Cursor(values=[180, 0, 0], base=0)) is None
    assert pick_bounds(Cursor(values=[], base=0)) is None


def test_gain_fit_is_a_simple_ratio_with_zero_intercept():
    from app.modules.postrun_calibration import gain_fit

    k0, k1 = gain_fit(area=2_000_000.0, known_mg=0.5)
    assert k0 == 0.0
    assert k1 == pytest.approx(0.5 / 2_000_000.0)


def test_gain_fit_rejects_zero_area():
    from app.modules.postrun_calibration import CalibrationError, gain_fit

    with pytest.raises(CalibrationError):
        gain_fit(area=0.0, known_mg=0.5)


def test_linear_fit_recovers_known_line_exactly():
    from app.modules.postrun_calibration import linear_fit

    # y = 0.1 + 2e-7 * x, sem ruído — a regressão tem que achar exatamente isso
    k0_true, k1_true = 0.1, 2e-7
    points = [(x, k0_true + k1_true * x) for x in (1_000_000, 2_000_000, 3_000_000, 4_000_000)]
    fit = linear_fit(points)
    assert fit.k0 == pytest.approx(k0_true, rel=1e-9)
    assert fit.k1 == pytest.approx(k1_true, rel=1e-9)
    assert fit.r2 == pytest.approx(1.0)


def test_linear_fit_requires_at_least_two_points():
    from app.modules.postrun_calibration import CalibrationError, linear_fit

    with pytest.raises(CalibrationError):
        linear_fit([(1.0, 2.0)])


def test_linear_fit_rejects_identical_areas():
    from app.modules.postrun_calibration import CalibrationError, linear_fit

    with pytest.raises(CalibrationError):
        linear_fit([(5.0, 1.0), (5.0, 2.0)])


def test_apply_calibration_is_the_inverse_of_gain_fit():
    from app.modules.postrun_calibration import apply_calibration, gain_fit

    k0, k1 = gain_fit(area=1_500_000.0, known_mg=0.75)
    assert apply_calibration(k0, k1, 1_500_000.0) == pytest.approx(0.75)
