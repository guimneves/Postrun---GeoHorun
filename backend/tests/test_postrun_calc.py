"""Integração de área por trapézio (aba PostRun) — casos sintéticos com
resposta calculável à mão, sem depender de nenhum fator geoquímico."""

import pytest


def test_triangle_area_matches_half_base_times_height():
    from app.modules import postrun_calc

    idx = [0, 1, 2, 3, 4]
    signal = [0, 1, 2, 1, 0]  # triângulo isósceles, base 4, altura 2
    result = postrun_calc.compute_area(idx, signal, start_idx=0, end_idx=4, baseline_mode="fixed", fixed_baseline=0)
    assert result.area == pytest.approx(4.0)  # 0.5 * base * altura
    assert result.n_points == 5
    assert result.peak_value == 2
    assert result.peak_idx == 2


def test_fixed_baseline_is_subtracted_before_integrating():
    from app.modules import postrun_calc

    idx = [0, 1, 2]
    signal = [10, 12, 10]  # patamar de 10 + um triângulo de altura 2
    result = postrun_calc.compute_area(idx, signal, 0, 2, baseline_mode="fixed", fixed_baseline=10)
    assert result.area == pytest.approx(2.0)


def test_linear_baseline_follows_a_drifting_line():
    from app.modules import postrun_calc

    idx = [0, 1, 2, 3, 4]
    signal = [5, 6, 7, 6, 5]  # mesmo triângulo do 1º teste, mas sobre baseline plana em 5
    result = postrun_calc.compute_area(idx, signal, 0, 4, baseline_mode="linear")
    assert result.area == pytest.approx(4.0)


def test_start_end_order_does_not_matter():
    from app.modules import postrun_calc

    idx = [0, 1, 2, 3, 4]
    signal = [0, 1, 2, 1, 0]
    forward = postrun_calc.compute_area(idx, signal, 0, 4, baseline_mode="fixed")
    backward = postrun_calc.compute_area(idx, signal, 4, 0, baseline_mode="fixed")
    assert forward.area == pytest.approx(backward.area)


def test_region_with_fewer_than_two_points_raises():
    from app.modules import postrun_calc

    with pytest.raises(postrun_calc.RegionError):
        postrun_calc.compute_area([0, 1, 2], [1, 2, 3], start_idx=5, end_idx=6)
