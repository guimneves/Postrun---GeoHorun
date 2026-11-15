"""Validação independente (F3 do artigo): métricas de um conjunto de corridas
de VALIDAÇÃO — nunca usadas nas curvas — quantificadas pelas curvas da
calibração.

Por material, com pares (massa adicionada, massa encontrada):
- viés = média(encontrada − adicionada), em mg e relativo (% da adicionada);
- RMSEP = √média((encontrada − adicionada)²);
- recuperação = encontrada ÷ adicionada × 100: média ± DP;
- regressão encontrada × adicionada (mínimos quadrados): inclinação,
  intercepto e R² — a reta 1:1 é o ideal;
- precisão intermediária pela ANOVA de um fator com o DIA como fator (sobre a
  recuperação %): s_r (dentro do dia, repetibilidade), s_entre (entre dias) e
  s_PI = √(s_r² + s_entre²) — ISO 5725-3 / Eurachem. Grupos desiguais: n₀ =
  (N − Σnᵢ²/N)/(k − 1).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from statistics import mean, stdev


@dataclass
class Pair:
    token: str
    material: str
    day: str
    added_mg: float
    found_mg: float
    U95_mg: float | None = None

    @property
    def recovery_pct(self) -> float:
        return 100.0 * self.found_mg / self.added_mg


@dataclass
class Anova:
    k_days: int
    n: int
    ms_between: float | None
    ms_within: float | None
    s_r: float | None  # repetibilidade (dentro do dia)
    s_between: float | None  # entre dias
    s_ip: float | None  # precisão intermediária
    warnings: list[str] = field(default_factory=list)


def anova_one_way(groups: list[list[float]]) -> Anova:
    groups = [g for g in groups if g]
    k = len(groups)
    n_total = sum(len(g) for g in groups)
    warnings: list[str] = []
    if k < 2:
        warnings.append("Só um dia: sem precisão intermediária (a ANOVA precisa de pelo menos 2 dias).")
    if n_total - k < 1:
        warnings.append("Sem réplicas dentro dos dias: a repetibilidade não pode ser separada.")
        return Anova(k, n_total, None, None, None, None, None, warnings)
    grand = mean(x for g in groups for x in g)
    ss_within = sum((x - mean(g)) ** 2 for g in groups for x in g)
    ms_within = ss_within / (n_total - k)
    s_r = math.sqrt(ms_within)
    if k < 2:
        return Anova(k, n_total, None, ms_within, s_r, None, None, warnings)
    ss_between = sum(len(g) * (mean(g) - grand) ** 2 for g in groups)
    ms_between = ss_between / (k - 1)
    n0 = (n_total - sum(len(g) ** 2 for g in groups) / n_total) / (k - 1)
    var_between = max(0.0, (ms_between - ms_within) / n0) if n0 > 0 else 0.0
    if ms_between < ms_within:
        warnings.append("Variância entre dias menor que dentro do dia: s_entre = 0 (não há efeito de dia detectável).")
    s_between = math.sqrt(var_between)
    return Anova(k, n_total, ms_between, ms_within, s_r, s_between, math.sqrt(ms_within + var_between), warnings)


@dataclass
class MaterialMetrics:
    material: str
    n: int
    n_days: int
    bias_mg: float
    bias_pct: float
    rmsep_mg: float
    recovery_mean: float
    recovery_sd: float | None
    slope: float | None
    intercept: float | None
    r2: float | None
    mean_rel_U95_pct: float | None  # U95 médio ÷ massa adicionada (banda do gráfico)
    anova: Anova


def _ols(xs: list[float], ys: list[float]) -> tuple[float | None, float | None, float | None]:
    if len(xs) < 3 or len(set(xs)) < 2:
        return None, None, None
    mx, my = mean(xs), mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx
    a = my - b * mx
    ss_tot = sum((y - my) ** 2 for y in ys)
    ss_res = sum((y - (a + b * x)) ** 2 for x, y in zip(xs, ys))
    return b, a, (1 - ss_res / ss_tot) if ss_tot > 0 else None


def metrics(pairs: list[Pair]) -> list[MaterialMetrics]:
    out: list[MaterialMetrics] = []
    for mat in dict.fromkeys(p.material for p in pairs):
        ps = [p for p in pairs if p.material == mat and p.added_mg > 0]
        if not ps:
            continue
        errs = [p.found_mg - p.added_mg for p in ps]
        recs = [p.recovery_pct for p in ps]
        by_day: dict[str, list[float]] = {}
        for p in ps:
            by_day.setdefault(p.day, []).append(p.recovery_pct)
        slope, intercept, r2 = _ols([p.added_mg for p in ps], [p.found_mg for p in ps])
        rel_u = [100.0 * p.U95_mg / p.added_mg for p in ps if p.U95_mg is not None]
        out.append(MaterialMetrics(
            material=mat, n=len(ps), n_days=len(by_day),
            bias_mg=mean(errs), bias_pct=mean(100.0 * e / p.added_mg for e, p in zip(errs, ps)),
            rmsep_mg=math.sqrt(mean(e * e for e in errs)),
            recovery_mean=mean(recs), recovery_sd=stdev(recs) if len(recs) > 1 else None,
            slope=slope, intercept=intercept, r2=r2,
            mean_rel_U95_pct=mean(rel_u) if rel_u else None,
            anova=anova_one_way(list(by_day.values())),
        ))
    return out
