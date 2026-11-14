"""Integração de área sob a curva por região (aba PostRun, pedido do
usuário): trabalha só o sinal bruto e sua área — sem nenhum fator de
calibração/normalização geoquímica, isso continua sendo trabalho do
GeoWorks (ver `app/modules/postrun_b00.py`). Regra do trapézio simples
entre dois índices de `Curves Pyro`/`Curves Oxi`, com a baseline subtraída
antes de integrar."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

BaselineMode = Literal["fixed", "linear"]


class RegionError(ValueError):
    pass


@dataclass
class AreaResult:
    area: float  # unidade "sinal × varredura" — o .B00 não grava eixo de tempo real
    n_points: int
    peak_value: float  # valor bruto máximo do sinal na região (sem subtrair baseline)
    peak_idx: int


def compute_area(
    idx: list[int],
    signal: list[float],
    start_idx: int,
    end_idx: int,
    baseline_mode: BaselineMode = "fixed",
    fixed_baseline: float = 0.0,
) -> AreaResult:
    """Integra `signal` (alinhado 1:1 com `idx`) entre `start_idx` e
    `end_idx` (inclusive, em qualquer ordem) pela regra do trapézio.

    - `"fixed"`: subtrai `fixed_baseline` (ex. o `Base=` que o GeoWorks
      gravou pro cursor original) constante em toda a região.
    - `"linear"`: interpola uma reta entre o valor do sinal no primeiro e
      no último ponto da região e subtrai essa reta — mais realista quando
      a linha de base deriva ao longo da corrida.
    """
    xs, ys, corrected = baseline_corrected(idx, signal, start_idx, end_idx, baseline_mode, fixed_baseline)

    area = 0.0
    for i in range(len(xs) - 1):
        dx = xs[i + 1] - xs[i]
        area += dx * (corrected[i] + corrected[i + 1]) / 2

    peak_pos = max(range(len(ys)), key=lambda i: ys[i])
    return AreaResult(area=area, n_points=len(xs), peak_value=ys[peak_pos], peak_idx=xs[peak_pos])


def baseline_corrected(
    idx: list[int],
    signal: list[float],
    start_idx: int,
    end_idx: int,
    baseline_mode: BaselineMode = "fixed",
    fixed_baseline: float = 0.0,
) -> tuple[list[int], list[float], list[float]]:
    """Pontos da janela [início, fim]: índices, sinal bruto e sinal menos a
    linha de base — o mesmo trecho que a área integra e que a deconvolução
    ajusta (`postrun_deconv`)."""
    if len(idx) != len(signal):
        raise RegionError("idx e signal precisam ter o mesmo tamanho")
    if not idx:
        raise RegionError("curva vazia")

    lo, hi = (start_idx, end_idx) if start_idx <= end_idx else (end_idx, start_idx)
    index_of = {v: i for i, v in enumerate(idx)}
    positions = [index_of[v] for v in range(lo, hi + 1) if v in index_of]
    if len(positions) < 2:
        raise RegionError(f"região [{lo}, {hi}] tem menos de 2 pontos na curva")

    xs = [idx[p] for p in positions]
    ys = [signal[p] for p in positions]

    if baseline_mode == "linear":
        y0, y1 = ys[0], ys[-1]
        span = xs[-1] - xs[0]

        def baseline_at(x: int) -> float:
            return y0 if span == 0 else y0 + (y1 - y0) * (x - xs[0]) / span

        corrected = [y - baseline_at(x) for x, y in zip(xs, ys)]
    else:
        corrected = [y - fixed_baseline for y in ys]
    return xs, ys, corrected
