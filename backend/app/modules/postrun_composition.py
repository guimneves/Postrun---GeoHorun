"""Composição das amostras pelo nome (curvas de calibração e misturas no
PostRun — pedido do usuário, 16/10/2026).

Formatos vistos nas corridas reais:

- mistura no nome do arquivo: `2026-10-01_PEAD_PP_PS_50-25-25_1.B00` →
  PEAD 50 %, PP 25 %, PS 25 % (componentes antes da proporção, réplica no fim);
- mistura no nome da amostra: `Sample=PE + PS (50-50)`;
- série de massas de um puro: `2026-08-10_PEAD_040_2.B00` → PEAD 100 %, massa
  nominal 4,0 mg (código de 3 dígitos = décimos de mg);
- puro: `2026-06-19_PS_1.B00` → PS 100 %.

Nome com "+" e sem proporção (`PP+PS_1`) fica sem composição: a pessoa
informa na tela (`parse_text`, ex.: "PP 50, PS 50"). A massa da corrida é a
do `.B00` (`Quant`), salvo correção manual — algumas corridas reais saíram
com `Quant=0`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_DATE_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2}_")
_REPLICATE_SUFFIX = re.compile(r"_\d+(?:\.\d+)?$")
_RATIO = re.compile(r"^\d+(?:[.,]\d+)?(?:-\d+(?:[.,]\d+)?)+$")
_NOMINAL_MASS = re.compile(r"^\d{3}$")
_SAMPLE_MIX = re.compile(r"^(.+?)\s*\(\s*(\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)+)\s*\)\s*$")
_TEXT_PART = re.compile(r"([A-Za-zÀ-ÿ][\w.+\-]*)\s*[:=]?\s*(\d+(?:[.,]\d+)?)?\s*%?")


class CompositionError(ValueError):
    pass


@dataclass
class Composition:
    # componente -> fração (soma 1)
    components: dict[str, float] = field(default_factory=dict)
    nominal_mass_mg: float | None = None
    source: str = ""  # "nome do arquivo" | "nome da amostra" | "manual"

    @property
    def text(self) -> str:
        return " · ".join(f"{name} {100 * frac:.4g} %" for name, frac in self.components.items())


def _num(value: str) -> float:
    return float(value.replace(",", "."))


def _normalized(names: list[str], ratios: list[float], source: str, nominal: float | None = None) -> Composition:
    total = sum(ratios)
    if total <= 0 or len(names) != len(ratios):
        raise CompositionError("proporções inválidas")
    merged: dict[str, float] = {}
    for name, ratio in zip(names, ratios):
        key = name.strip().upper()
        if not key:
            raise CompositionError("componente sem nome")
        merged[key] = merged.get(key, 0.0) + ratio / total
    return Composition(merged, nominal, source)


def stem_of(filename: str) -> str:
    """`2026-10-01_PEAD_PP_PS_50-25-25_1.B00` → `PEAD_PP_PS_50-25-25`."""
    stem = filename.rsplit("/", 1)[-1]
    if stem.upper().endswith(".B00"):
        stem = stem[:-4]
    stem = _DATE_PREFIX.sub("", stem)
    return _REPLICATE_SUFFIX.sub("", stem)


def from_names(filename: str, sample: str) -> Composition | None:
    """Composição lida do nome do arquivo ou da amostra; None se não der."""
    m = _SAMPLE_MIX.match(sample or "")
    if m:
        names = [n for n in m.group(1).split("+")]
        ratios = [_num(r) for r in re.split(r"\s*-\s*", m.group(2))]
        if len(names) == len(ratios) > 1:
            return _normalized(names, ratios, "nome da amostra")

    tokens = [t for t in stem_of(filename).split("_") if t]
    if not tokens:
        return None
    for k, token in enumerate(tokens):
        if _RATIO.match(token):
            names = tokens[:k]
            ratios = [_num(r) for r in token.split("-")]
            if len(names) == len(ratios):
                return _normalized(names, ratios, "nome do arquivo")
            return None
    nominal = None
    if len(tokens) > 1 and _NOMINAL_MASS.match(tokens[-1]):
        nominal = int(tokens[-1]) / 10.0
        tokens = tokens[:-1]
    name = "_".join(tokens)
    if "+" in name:
        return None  # mistura sem proporção: informar na tela
    return Composition({name.upper(): 1.0}, nominal, "nome do arquivo")


def parse_text(text: str) -> Composition:
    """Composição digitada: "PEAD 50, PP 25, PS 25", "PS" (puro) ou o
    formato do nome do arquivo ("PEAD_PS_75-25")."""
    raw = (text or "").strip()
    if not raw:
        raise CompositionError("informe os componentes (ex.: PEAD 50, PP 25, PS 25)")
    tokens = raw.split("_")
    if len(tokens) > 1 and _RATIO.match(tokens[-1]):
        ratios = [_num(r) for r in tokens[-1].split("-")]
        if len(tokens) - 1 != len(ratios):
            raise CompositionError("o número de componentes não bate com o de proporções")
        c = _normalized(tokens[:-1], ratios, "manual")
        return c
    parts = [p for p in re.split(r"[,;·]|\s+\+\s+", raw) if p.strip()]
    names: list[str] = []
    ratios: list[float] = []
    for part in parts:
        m = _TEXT_PART.fullmatch(part.strip())
        if not m:
            raise CompositionError(f"não entendi \"{part.strip()}\" — use NOME e porcentagem, ex.: PP 50")
        names.append(m.group(1))
        ratios.append(_num(m.group(2)) if m.group(2) else float("nan"))
    if len(names) == 1 and ratios[0] != ratios[0]:
        ratios = [100.0]  # só o nome: puro
    if any(r != r for r in ratios):
        raise CompositionError("informe a porcentagem de cada componente")
    return _normalized(names, ratios, "manual")


def parse_masses(text: str) -> dict[str, float]:
    """Massas reais de cada polímero na mistura, em mg (24/10/2026):
    "PEAD 1,012; PS 0,998" (vírgula decimal aceita; separador ";" ou " + ").
    Não normaliza — são as massas pesadas."""
    raw = (text or "").strip()
    if not raw:
        raise CompositionError("informe a massa de cada componente (ex.: PEAD 1,012; PS 0,998)")
    parts = [p for p in re.split(r";|\s+\+\s+|\n", raw) if p.strip()]
    if len(parts) == 1 and raw.count(",") >= 2:
        raise CompositionError('separe os componentes com ";" (a vírgula é a casa decimal): PEAD 1,012; PS 0,998')
    out: dict[str, float] = {}
    for part in parts:
        m = re.fullmatch(r"\s*([A-Za-zÀ-ÿ][\w.+\-]*)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(?:mg)?\s*", part)
        if not m:
            raise CompositionError(f'não entendi "{part.strip()}" — use NOME e massa em mg, ex.: PEAD 1,012')
        value = _num(m.group(2))
        if value <= 0:
            raise CompositionError(f"massa de {m.group(1)} deve ser maior que zero")
        key = m.group(1).strip().upper()
        out[key] = out.get(key, 0.0) + value
    return out
