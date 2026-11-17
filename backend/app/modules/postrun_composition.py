"""Composição das amostras pelo nome (curvas de calibração e misturas no
PostRun — pedido do usuário, 16/10/2026; regras claras e gerais desde
16/11/2026).

Como o nome é lido (`read_names`), na ordem:

1. Nome da amostra no formato de mistura — `PE + PS (50-50)` → PE 50 %,
   PS 50 %; `PE + PS` sem a proporção → componentes PE e PS, proporção não
   informada.
2. Nome do arquivo com proporção — `2026-10-01_PEAD_PP_PS_50-25-25_1.B00` →
   PEAD 50 %, PP 25 %, PS 25 % (os nomes antes da proporção são os
   componentes, quaisquer que sejam; data no início e réplica no fim saem).
3. Nome do arquivo com "+" — `PP+PS_1` → PP e PS, proporção não informada.
4. Nome do arquivo sem proporção — só valem os pedaços que são **materiais
   conhecidos** (`BUILTIN_MATERIALS` + os que o laboratório já usou: ver
   `known`): `PEAD_040_2` → PEAD puro (040 = 4,0 mg nominais),
   `PEAD_rep_2` → PEAD puro ("rep" ignorado), `PP_PS_1` → PP e PS sem
   proporção, `Parafina4_1` / `160k_2` / `vide_1` → não identificada.

Antes de 16/11/2026 qualquer nome sem proporção virava um "material puro"
(Parafina4, 160K, VIDE…) e entrava nas referências; agora um nome que não
traz nenhum material conhecido fica sem composição, e a pessoa informa na
tela uma vez — o material passa a ser conhecido e as próximas corridas com
ele no nome são lidas sozinhas.

Composição **sem proporção** ("PP + PS"): o PostRun sabe quais picos
procurar (deconvolução e massa encontrada pela curva), mas não tem a massa
esperada de cada um — sem recuperação. É o caso de uma amostra real a
quantificar.

A massa da corrida é a do `.B00` (`Quant`), salvo correção manual.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

_DATE_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2}_")
_REPLICATE_SUFFIX = re.compile(r"_\d+(?:\.\d+)?$")
_RATIO = re.compile(r"^\d+(?:[.,]\d+)?(?:-\d+(?:[.,]\d+)?)+$")
_NOMINAL_MASS = re.compile(r"^\d{3}$")
_SAMPLE_MIX = re.compile(r"^(.+?)\s*\(\s*(\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)+)\s*\)\s*$")
_SAMPLE_PLUS = re.compile(r"^\s*[A-Za-zÀ-ÿ][\w.\-]*(?:\s*\+\s*[A-Za-zÀ-ÿ][\w.\-]*)+\s*$")
_TEXT_PART = re.compile(r"([A-Za-zÀ-ÿ][\w.\-]*)\s*[:=]?\s*(\d+(?:[.,]\d+)?)?\s*%?")

# Polímeros comuns (siglas em português e em inglês). O laboratório amplia a
# lista só de usar: material de referência, de curva ou informado na tela
# (ver `known_materials` em `app.api.routes_postrun`).
BUILTIN_MATERIALS = frozenset({
    "PE", "PEAD", "PEBD", "PELBD", "PEUAPM", "HDPE", "LDPE", "LLDPE", "UHMWPE",
    "PP", "PS", "EPS", "HIPS", "PET", "PETG", "PBT", "PVC", "PVA", "PVOH", "PVAC",
    "PA", "PA6", "PA66", "PA11", "PA12", "PC", "PMMA", "PLA", "PHB", "PHA", "PCL", "PBAT", "PBS",
    "ABS", "SAN", "ASA", "PU", "PUR", "TPU", "PTFE", "PVDF", "EVA", "POM", "PEEK", "PPS", "PAN",
    "PES", "PSU", "PPO", "SBR", "SBS", "EPDM",
})


class CompositionError(ValueError):
    pass


@dataclass
class Composition:
    # componente -> fração (soma 1); VAZIO quando a proporção não foi informada
    components: dict[str, float] = field(default_factory=dict)
    nominal_mass_mg: float | None = None
    source: str = ""  # "nome do arquivo" | "nome da amostra" | "manual"
    # os componentes, na ordem — também quando a proporção não foi informada
    names: list[str] = field(default_factory=list)
    # como foi lida, em português (aparece na tela)
    note: str = ""

    def __post_init__(self) -> None:
        if not self.names:
            self.names = list(self.components)

    @property
    def complete(self) -> bool:
        """Tem a proporção de cada componente (dá para calcular a recuperação)."""
        return bool(self.components)

    @property
    def text(self) -> str:
        if not self.complete:
            return " + ".join(self.names) + " (sem proporção)"
        if len(self.components) == 1:
            return f"{self.names[0]} puro"
        return " · ".join(f"{name} {100 * frac:.4g} %" for name, frac in self.components.items())

    def to_json_dict(self) -> dict[str, float | None]:
        """Para gravar: fração de cada um, ou None (proporção não informada)."""
        return dict(self.components) if self.complete else {n: None for n in self.names}

    @classmethod
    def from_json_dict(cls, data: dict, source: str = "manual", note: str = "") -> Composition:
        names = [str(k).upper() for k in data]
        if data and all(v is not None for v in data.values()):
            return cls({str(k).upper(): float(v) for k, v in data.items()}, None, source, names, note)
        return cls({}, None, source, names, note)


def _num(value: str) -> float:
    return float(value.replace(",", "."))


def _clean(name: str) -> str:
    key = name.strip().upper()
    if not key:
        raise CompositionError("componente sem nome")
    return key


def _normalized(names: list[str], ratios: list[float], source: str, nominal: float | None = None,
                note: str = "") -> Composition:
    total = sum(ratios)
    if total <= 0 or len(names) != len(ratios):
        raise CompositionError("proporções inválidas")
    merged: dict[str, float] = {}
    for name, ratio in zip(names, ratios):
        key = _clean(name)
        merged[key] = merged.get(key, 0.0) + ratio / total
    return Composition(merged, nominal, source, list(merged), note)


def _without_ratio(names: list[str], source: str, nominal: float | None = None, note: str = "") -> Composition:
    """Componentes sem proporção — um só é puro (100 %)."""
    keys = list(dict.fromkeys(_clean(n) for n in names))
    if len(keys) == 1:
        return Composition({keys[0]: 1.0}, nominal, source, keys, note)
    return Composition({}, nominal, source, keys, note)


def stem_of(filename: str) -> str:
    """`2026-10-01_PEAD_PP_PS_50-25-25_1.B00` → `PEAD_PP_PS_50-25-25`."""
    stem = filename.rsplit("/", 1)[-1]
    if stem.upper().endswith(".B00"):
        stem = stem[:-4]
    stem = _DATE_PREFIX.sub("", stem)
    return _REPLICATE_SUFFIX.sub("", stem)


@dataclass
class Reading:
    """O que saiu do nome: a composição (ou None) e a explicação."""

    composition: Composition | None
    note: str


def read_names(filename: str, sample: str, known: frozenset[str] | set[str] | None = None) -> Reading:
    """Composição lida do nome da amostra ou do arquivo, com a explicação de
    como foi lida (ou de por que não deu). `known`: materiais conhecidos,
    em MAIÚSCULAS (padrão: `BUILTIN_MATERIALS`)."""
    known = BUILTIN_MATERIALS if known is None else known
    sample = (sample or "").strip()
    m = _SAMPLE_MIX.match(sample)
    if m:
        names = [n for n in m.group(1).split("+") if n.strip()]
        ratios = [_num(r) for r in re.split(r"\s*-\s*", m.group(2))]
        if len(names) == len(ratios) > 1:
            note = f'lida do nome da amostra "{sample}"'
            return Reading(_normalized(names, ratios, "nome da amostra", note=note), note)
    if _SAMPLE_PLUS.match(sample):
        note = f'lida do nome da amostra "{sample}" — sem a proporção'
        return Reading(_without_ratio(sample.split("+"), "nome da amostra", note=note), note)

    stem = stem_of(filename)
    tokens = [t for t in stem.split("_") if t]
    if not tokens:
        return Reading(None, "o nome do arquivo está vazio")
    for k, token in enumerate(tokens):
        if _RATIO.match(token):
            names = tokens[:k]
            ratios = [_num(r) for r in token.split("-")]
            if names and len(names) == len(ratios):
                note = f'lida do nome do arquivo "{stem}"'
                return Reading(_normalized(names, ratios, "nome do arquivo", note=note), note)
            return Reading(None, f'no nome "{stem}" há {len(names)} componente(s) antes da proporção '
                                 f"{token}, que tem {len(ratios)} números — não bate")
    nominal = None
    nominal_code = ""
    if len(tokens) > 1 and _NOMINAL_MASS.match(tokens[-1]):
        nominal_code = tokens[-1]
        nominal = int(nominal_code) / 10.0
        tokens = tokens[:-1]
    plus = [t for t in tokens if "+" in t]
    if plus:
        names = [n for n in plus[0].split("+") if n.strip()]
        note = f'lida do nome do arquivo "{stem}"'
        comp = _without_ratio(names, "nome do arquivo", nominal, note)
        if not comp.complete:
            comp.note = note = note + " — sem a proporção"
        return Reading(comp, note)
    found = [t for t in tokens if t.upper() in known]
    ignored = [t for t in tokens if t.upper() not in known]
    if not found:
        return Reading(None, f'nenhum material conhecido no nome "{stem}"')
    note = f'lida do nome do arquivo "{stem}"'
    if ignored:
        note += f" (ignorado: {', '.join(ignored)})"
    if nominal is not None:
        note += f"; {nominal_code} = {nominal:g} mg nominais"
    comp = _without_ratio(found, "nome do arquivo", nominal, note)
    if not comp.complete:
        comp.note = note = note + " — sem a proporção"
    return Reading(comp, note)


def from_names(filename: str, sample: str, known: frozenset[str] | set[str] | None = None) -> Composition | None:
    """Composição lida do nome do arquivo ou da amostra; None se não der."""
    return read_names(filename, sample, known).composition


def parse_text(text: str) -> Composition:
    """Composição digitada: "PEAD 50, PP 25, PS 25", "PS" (puro), "PP, PS"
    ou "PP + PS" (sem proporção) ou o formato do nome do arquivo
    ("PEAD_PS_75-25"). Qualquer nome vale — é a pessoa dizendo o que é."""
    raw = (text or "").strip()
    if not raw:
        raise CompositionError("informe os componentes (ex.: PEAD 50, PP 25, PS 25)")
    tokens = raw.split("_")
    if len(tokens) > 1 and _RATIO.match(tokens[-1]):
        ratios = [_num(r) for r in tokens[-1].split("-")]
        if len(tokens) - 1 != len(ratios):
            raise CompositionError("o número de componentes não bate com o de proporções")
        return _normalized(tokens[:-1], ratios, "manual", note="informada na tela")
    parts = [p for p in re.split(r"[,;·+]", raw) if p.strip()]
    names: list[str] = []
    ratios: list[float] = []
    for part in parts:
        m = _TEXT_PART.fullmatch(part.strip())
        if not m:
            raise CompositionError(f'não entendi "{part.strip()}" — use NOME e porcentagem, ex.: PP 50')
        names.append(m.group(1))
        ratios.append(_num(m.group(2)) if m.group(2) else math.nan)
    missing = [math.isnan(r) for r in ratios]
    if all(missing):
        comp = _without_ratio(names, "manual")
        comp.note = "informada na tela" + ("" if comp.complete else " — sem a proporção")
        return comp
    if any(missing):
        raise CompositionError("informe a porcentagem de todos os componentes — ou de nenhum (ex.: PP, PS)")
    note = "informada na tela"
    total = sum(ratios)
    if len(ratios) > 1 and abs(total - 100) > 1:
        note += f" (as porcentagens somavam {total:g}; usadas como proporção)"
    return _normalized(names, ratios, "manual", note=note)


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
