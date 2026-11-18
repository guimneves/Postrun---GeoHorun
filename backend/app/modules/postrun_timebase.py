"""Eixo de tempo das curvas do `.B00` (pedido do usuário, 16/10/2026: "a
integração hoje é por medida; seria interessante que fosse feita através do
tempo ou com uma conversão com base no ciclo").

O `.B00` só grava o índice do ponto. O tempo sai do programa do forno
(`CycleProgram.rate`, °C/min) comparado à subida da temperatura medida
durante a rampa: segundos por ponto = (rate / 60) / (°C por ponto).
Conferido em arquivos reais (padrão IFP160000, polímeros, Mix PI; ciclo
BASIC 25 °C/min): 0,99–1,00 s por ponto — o equipamento grava a 1 Hz.

Regra: se a estimativa da rampa da pirólise ficar a até 5 % de 1 s, vale
1 s (a estimativa tem o ruído do termopar); fora disso, vale a estimativa e
a tela avisa. A oxidação usa a mesma aquisição (a temperatura medida fica
atrás da programada na oxidação, então a rampa dela não serve de régua).

Área no tempo (sinal × s) é a grandeza que se conserva para a mesma massa
mesmo com rampas diferentes (o FID mede vazão de massa): é ela que entra nas
curvas de calibração.
"""

from __future__ import annotations

from dataclasses import dataclass
from statistics import median

from app.modules.postrun_b00 import Curve, CycleProgram

NOMINAL_SECONDS_PER_POINT = 1.0
_TOLERANCE = 0.05
# trecho "limpo" da rampa: longe do patamar inicial e da temperatura final
_RAMP_MARGIN_C = 20.0
_MIN_RAMP_POINTS = 30


@dataclass(frozen=True)
class TimeBase:
    seconds_per_point: float
    # estimativa pela rampa (None = sem programa/rampa para estimar)
    estimated: float | None
    warning: str | None = None


def estimate_seconds_per_point(curve: Curve | None, program: CycleProgram | None) -> float | None:
    if curve is None or program is None or program.rate <= 0 or len(curve.temp) < 2:
        return None
    # cada rampa do programa (o multi-heating rates tem várias, 18/11/2026):
    # segundos por ponto = (taxa / 60) / (°C por ponto) no trecho limpo dela
    estimates: list[tuple[int, float]] = []
    for rate, start, end in program.segments():
        lo, hi = start + _RAMP_MARGIN_C, end - _RAMP_MARGIN_C
        if rate <= 0 or hi <= lo:
            continue
        steps: list[float] = []
        for (i0, t0), (i1, t1) in zip(zip(curve.idx, curve.temp), zip(curve.idx[1:], curve.temp[1:])):
            if i1 <= i0 or not (lo <= t0 <= hi and lo <= t1 <= hi):
                continue
            dt = (t1 - t0) / (i1 - i0)
            if dt > 0:
                steps.append(dt)
        if len(steps) >= _MIN_RAMP_POINTS:
            per_point = median(steps)
            if per_point > 0:
                estimates.append((len(steps), (rate / 60.0) / per_point))
    if not estimates:
        return None
    # a rampa com mais pontos manda (o ruído do termopar pesa menos nela)
    return max(estimates)[1]


def time_base(pyro: Curve | None, program: CycleProgram | None) -> TimeBase:
    est = estimate_seconds_per_point(pyro, program)
    if est is None:
        return TimeBase(
            NOMINAL_SECONDS_PER_POINT,
            None,
            "sem programa da pirólise no arquivo — usado 1 ponto por segundo" if program is None else
            "rampa curta demais para conferir a aquisição — usado 1 ponto por segundo",
        )
    if abs(est - NOMINAL_SECONDS_PER_POINT) <= _TOLERANCE * NOMINAL_SECONDS_PER_POINT:
        return TimeBase(NOMINAL_SECONDS_PER_POINT, est)
    return TimeBase(
        est,
        est,
        f"aquisição fora do esperado: {est:.3f} s por ponto pela rampa (esperado 1 s) — confira o ciclo",
    )
