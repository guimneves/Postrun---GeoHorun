"""Brancos de matriz e limites de detecção/quantificação (F2 do artigo).

Entradas: as massas APARENTES dos brancos (área de cada branco de matriz —
sílica — no intervalo da curva, convertida em massa pela própria curva), as
dos níveis baixos (opcional) e a massa de matriz por cadinho.

Dois critérios, lado a lado, sempre com o nome de quem define:

- **Armbruster & Pry (2008), Clin. Biochem. Rev. 29:S49 — CLSI EP17**:
  LoB = μ_branco + 1,645·σ_branco (95 % dos brancos ficam abaixo);
  LoD = LoB + 1,645·σ_baixo (σ das réplicas de uma amostra de baixa
  concentração; sem elas, usa σ_branco — aproximação, avisada);
  LoQ = μ_branco + 10·σ_branco (critério de 10σ; Armbruster & Pry definem o
  LoQ pela meta de precisão/viés, que depende do método — por isso o
  critério usado vai escrito ao lado).
- **Curva de calibração (ICH Q2)**: LD = 3,3·σ₀/b e LQ = 10·σ₀/b, com σ₀ e b
  da própria curva (ver `postrun_regression.fit`).

Em ppm (µg/g): massa do analito (mg) ÷ massa de matriz (mg) × 10⁶.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from statistics import mean, stdev

Z95 = 1.645  # unilateral, 95 %
MIN_BLANKS = 10  # abaixo disso, aviso (pedido do usuário; o EP17 pede bem mais)


class LimitsError(ValueError):
    pass


@dataclass
class Limit:
    key: str  # "lob" | "lod" | "loq" | "ld_curve" | "lq_curve"
    label: str
    criterion: str
    mg: float | None
    ppm: float | None


@dataclass
class LimitsResult:
    n_blanks: int
    blank_mean_mg: float
    blank_sd_mg: float
    n_low: int
    low_sd_mg: float | None
    matrix_mass_mg: float | None
    limits: list[Limit]
    warnings: list[str] = field(default_factory=list)


def to_ppm(mg: float | None, matrix_mass_mg: float | None) -> float | None:
    if mg is None or not matrix_mass_mg or matrix_mass_mg <= 0:
        return None
    return mg / matrix_mass_mg * 1e6


def compute(
    blank_mg: list[float],
    *,
    low_mg: list[float] | None = None,
    matrix_mass_mg: float | None = None,
    curve_lod_mg: float | None = None,
    curve_loq_mg: float | None = None,
    curve_sigma_label: str = "σ₀ da curva",
) -> LimitsResult:
    if len(blank_mg) < 2:
        raise LimitsError("São precisos pelo menos 2 brancos (o recomendado é 10 ou mais).")
    warnings: list[str] = []
    if len(blank_mg) < MIN_BLANKS:
        warnings.append(
            f"Só {len(blank_mg)} branco(s): com menos de {MIN_BLANKS}, o desvio-padrão do branco — e todos os "
            "limites de Armbruster & Pry — ficam pouco confiáveis."
        )
    mu_b = mean(blank_mg)
    sd_b = stdev(blank_mg)
    low = list(low_mg or [])
    if len(low) == 1:
        warnings.append("Só uma réplica de nível baixo: o LoD usa o σ do branco.")
    sd_low = stdev(low) if len(low) >= 2 else None
    if sd_low is None:
        warnings.append(
            "Sem réplicas de uma amostra de baixa concentração: LoD = LoB + 1,645·σ_branco (aproximação). "
            "Para o LoD de Armbruster & Pry, marque também as réplicas do nível mais baixo."
        )
    if not matrix_mass_mg or matrix_mass_mg <= 0:
        warnings.append("Sem massa de matriz: os limites saem só em mg, não em ppm.")

    lob = mu_b + Z95 * sd_b
    lod = lob + Z95 * (sd_low if sd_low is not None else sd_b)
    loq = mu_b + 10.0 * sd_b
    sd_used = "σ do nível baixo" if sd_low is not None else "σ do branco (aproximação)"
    limits = [
        Limit("lob", "LoB", "Armbruster & Pry: μ_branco + 1,645·σ_branco", lob, to_ppm(lob, matrix_mass_mg)),
        Limit("lod", "LoD", f"Armbruster & Pry: LoB + 1,645·{sd_used}", lod, to_ppm(lod, matrix_mass_mg)),
        Limit("loq", "LoQ", "μ_branco + 10·σ_branco", loq, to_ppm(loq, matrix_mass_mg)),
        Limit("ld_curve", "LD", f"curva: 3,3·{curve_sigma_label}/b", curve_lod_mg, to_ppm(curve_lod_mg, matrix_mass_mg)),
        Limit("lq_curve", "LQ", f"curva: 10·{curve_sigma_label}/b", curve_loq_mg, to_ppm(curve_loq_mg, matrix_mass_mg)),
    ]
    return LimitsResult(
        n_blanks=len(blank_mg), blank_mean_mg=mu_b, blank_sd_mg=sd_b, n_low=len(low), low_sd_mg=sd_low,
        matrix_mass_mg=matrix_mass_mg if matrix_mass_mg and matrix_mass_mg > 0 else None,
        limits=limits, warnings=warnings,
    )
