"""Calibração de área bruta -> mg (aba PostRun, pedido do usuário): faz
o mesmo que o GeoWorks faz ao calibrar o FID/IV com um padrão certificado
(seção `[Calibration:Geoworks]` do `.B00`, ver `postrun_b00.py`) — mas
com um fator próprio, ajustado contra a área que o `postrun_calc` calcula
(não dá pra reaproveitar direto o `K1` que o GeoWorks grava no arquivo,
porque foi ajustado contra a área calculada do jeito *dele*, que não é
necessariamente a mesma base do `postrun_calc`).

Confirmado por inspeção real (script exploratório rodado nesta sessão
contra as 27 réplicas do padrão certificado IFP160000/STD160000 em
`RE7raw-data/STD/BULK ROCK`):

- Todo `.B00` real tem `LawType=Gain` com `K0=0.000000e+00` — o modelo do
  GeoWorks é proporção direta (`mg = K1 × área`), não uma reta genérica.
- Os pontos `Curs_1..Curs_N` de um cursor **não vêm em ordem crescente de
  índice** (são pontos nomeados — início, vale, fim — não uma sequência).
  Um arquivo real tinha `Curs_2=0`, claramente inválido/corrompido pelo
  próprio GeoWorks. `pick_bounds` filtra isso.

Pedido do usuário: calibração é um evento único e supervisionado, igual
o fluxo do GeoWorks — cada corrida de um padrão STD é um candidato que o
usuário aceita ou rejeita (nunca automático), em um de dois modos:

- **Ganho puro** (`gain_fit`): 1 ponto, `K0` fixo em 0.
- **Com intercepto** (`linear_fit`): 2+ pontos, regressão linear de
  verdade (`K0`/`K1`/`R²`) — o usuário escolhe quais corridas entram.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.modules.postrun_b00 import Cursor


class CalibrationError(ValueError):
    pass


def pick_bounds(cursor: Cursor) -> tuple[int, int] | None:
    """Início/fim da região de calibração = min/max dos valores válidos
    (> 0) do cursor que o GeoWorks gravou pra aquela corrida. `None` se
    sobrar menos de 2 pontos válidos (cursor corrompido/vazio)."""
    valid = [v for v in cursor.values if v > 0]
    if len(valid) < 2:
        return None
    return min(valid), max(valid)


def gain_fit(area: float, known_mg: float) -> tuple[float, float]:
    """Calibração de 1 ponto — `K0` sempre 0, igual `LawType=Gain` do
    GeoWorks. `(k0, k1)`."""
    if area == 0:
        raise CalibrationError("área do ponto de calibração é zero — não dá pra calcular o ganho")
    return 0.0, known_mg / area


@dataclass
class LinearFitResult:
    k0: float
    k1: float
    r2: float


def linear_fit(points: list[tuple[float, float]]) -> LinearFitResult:
    """Calibração com intercepto — mínimos quadrados de `known_mg` (y) em
    função de `area` (x), pelo menos 2 pontos com área não toda igual."""
    if len(points) < 2:
        raise CalibrationError("calibração com intercepto exige pelo menos 2 pontos")
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    n = len(xs)
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    ss_xx = sum((x - mean_x) ** 2 for x in xs)
    if ss_xx == 0:
        raise CalibrationError("todos os pontos têm a mesma área — não dá pra ajustar uma reta")
    ss_xy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    k1 = ss_xy / ss_xx
    k0 = mean_y - k1 * mean_x
    pred = [k0 + k1 * x for x in xs]
    ss_res = sum((y - p) ** 2 for y, p in zip(ys, pred))
    ss_tot = sum((y - mean_y) ** 2 for y in ys)
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 1.0
    return LinearFitResult(k0=k0, k1=k1, r2=r2)


def apply_calibration(k0: float, k1: float, area: float) -> float:
    return k0 + k1 * area


# Parâmetro certificado de MASSA usado pra calibrar cada canal.
#
# Pedido do usuário: pro FID é o **S2** (não S1+S2) — a janela do cursor
# `Curs auto_1` do GeoWorks (`180 → ~1033`) já é só o pico de S2; o S1 (o
# pequeno transiente do aquecimento inicial, índices 0–180) fica de fora.
# É o mesmo valor que o equipamento usa (`stdS2` no `standard.ini`), que
# pra um padrão de rocha é idêntico ao S2 certificado. Os demais canais
# não têm candidato automático ainda (sem valor certificado de CO/CO2/SO2
# cadastrado hoje no Horun).
CHANNEL_MASS_PARAMETERS: dict[str, list[str]] = {
    "pyro:FID": ["S2"],
}

# Parâmetro certificado de TEMPERATURA (Tmax) por canal — não entra no
# K1 (é temperatura, não massa), só é exibido na tela do candidato pra
# comparar com o Tmax medido no pico e o usuário julgar se a corrida do
# padrão prestou (pedido do usuário — opção A: só conferência, sem
# offset).
CHANNEL_TMAX_PARAMETER: dict[str, str] = {
    "pyro:FID": "Tmax",
}
