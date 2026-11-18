"""Parser dos `.B00` do Rock-Eval 7S — sinais brutos por corrida, usados
pela aba PostRun (pedido do usuário): o GeoWorks calcula S1/S2/S3/Tmax/TOC
a partir desses arquivos, mas não dá acesso de trabalho ao sinal bruto do
FID (pirólise) nem dos detectores de infravermelho (CO/CO2/SO2, pirólise e
oxidação). PostRun lê o `.B00` diretamente — sem depender de um relatório
já exportado do GeoWorks — pra deixar o usuário reprocessar áreas de região
sobre a curva. Este módulo **não calcula nenhum índice geoquímico**
(S1/S2/S3/Tmax/TOC/PI/HI/OI/PC/RC continuam sendo trabalho do GeoWorks,
pedido explícito do usuário).

Outros métodos do equipamento (18/11/2026) gravam o MESMO formato, com outra
extensão e numa pasta com o nome do método: `.M00` (MULTI-HEATING RATES),
`.O00` (PURE OIL), `.Q00` (COAL)… — conferido em 61 `.M00`, 37 `.O00` e 1
`.Q00` reais. Toda extensão "letra + 00" é uma análise (`is_analysis_file`);
o `~` no fim (`.M00~`) é o backup do GeoWorks e fica de fora. O
multi-heating rates tem o programa em vários trechos (`Rate1`/`Temp1`/`Iso1`,
`Rate2`…) — ver `CycleProgram.steps`.

Formato confirmado por inspeção de arquivos reais em
`RE7raw-data/Mix PI/BULK ROCK/*.B00` e nos 7 replicados do padrão
certificado `RE7raw-data/0_Padroes/BULK ROCK/*IFP160000*.B00`: texto tipo
INI (`\\r\\n`, seções `[Nome]`).

Seções usadas:
- `[Param]`: `Sample`, `CyclT` (pasta do método, ex. "BULK ROCK"), `CyclN`
  (nome do ciclo), `Quant` (massa em mg — só informativo aqui, PostRun não
  normaliza área por massa).
- `[Identity]`: `Date=MM-DD-AAAA:HH-MM-SS` (confirmado comparando com a data
  no próprio nome do arquivo, que usa DD-MM-AAAA — ex. arquivo
  `RE7_MIXPI_0_11052026.B00` de 11 de maio de 2026 tem `Date=05-11-2026:...`
  no `[Identity]`, mês antes do dia).
- `[GasName]`: `nbGas` (0-5 canais extras além de FID/CO/CO2/SO2).
- `[base ligne]`: baseline por canal — `LB_FID`, `LB_CO_P`, `LB_CO2_P`,
  `LB_SO2_P`, `LB_GAS4..8_P` (pirólise), depois as mesmas com `_O`
  (oxidação) — mesma ordem de colunas de `[Curves Pyro]`/`[Curves Oxi]`.
- `[Curs auto_1..7:Geoworks]` / `[Curs manu_1..7:Geoworks]`: os cursores
  que o próprio GeoWorks gravou pra essa corrida (auto = escolhido
  automaticamente, manu = ajustado manualmente pelo operador no
  equipamento) — 1=FID, 2=CO pirólise, 3=CO2 pirólise, 4=SO2 pirólise,
  5=CO oxidação, 6=CO2 oxidação, 7=SO2 oxidação (`CURSOR_SLOTS` abaixo).
  Cada `Curs_N=<inteiro>` é um **índice de linha** dentro de
  `[Curves Pyro]`/`[Curves Oxi]` (bate exatamente com a 1ª coluna da
  tabela de curvas — não é temperatura nem tempo). `Base=<float>` é o
  valor de baseline que o GeoWorks usou naquele cursor. Servem de ponto de
  partida real pros cursores editáveis do PostRun.
- `[Curves Pyro]`: uma linha por ponto, `idx  Temp  FID  CO  CO2  SO2`
  (+ `GAS4..8` se `nbGas>0`).
- `[Curves Oxi]`: `idx  Temp  CO  CO2  SO2` (+ `GAS4..8`) — sem FID, não
  há chama detectável na oxidação.

O `.B00` não grava um eixo de tempo explícito, só o índice de varredura —
`idx` é a única referência de posição ao longo da corrida. O tempo sai do
programa do forno (`[Cycle Pyro]`/`[Cycle Oxi]`: `InitT`, `InitIso` (min),
`Rate` (°C/min), `Temp`, `Iso` (min), `Purge` (min)) comparado à subida da
temperatura medida na rampa — ver `app.modules.postrun_timebase`
(confirmado em arquivos reais: 1 ponto por segundo).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

_SECTION_RE = re.compile(r"^\[(.+)\]$")
_LINE_SPLIT_RE = re.compile(r"\r\n|\r|\n")

# Canais possíveis por curva, na ordem das colunas em [Curves Pyro]/
# [Curves Oxi] (após idx/Temp) — os extras (GAS4..8) só existem se nbGas>0.
_PYRO_BASE_CHANNELS = ["FID", "CO", "CO2", "SO2"]
_OXI_BASE_CHANNELS = ["CO", "CO2", "SO2"]
_MAX_EXTRA_GAS = 5

# Slot N de [Curs auto_N:Geoworks]/[Curs manu_N:Geoworks] -> (curva, canal).
CURSOR_SLOTS: list[tuple[str, str]] = [
    ("pyro", "FID"),
    ("pyro", "CO"),
    ("pyro", "CO2"),
    ("pyro", "SO2"),
    ("oxi", "CO"),
    ("oxi", "CO2"),
    ("oxi", "SO2"),
]


class B00ParseError(ValueError):
    pass


@dataclass(frozen=True)
class CycleProgram:
    """Programa do forno de uma etapa (pirólise ou oxidação), da seção
    `[Cycle Pyro]`/`[Cycle Oxi]`. Pedido do usuário (16/10/2026): curva de
    calibração vale para um método e, sobretudo, um ciclo — `key` identifica
    o programa; `label` é o texto para a tela."""

    init_temp: float  # InitT (°C)
    init_iso_min: float  # InitIso (min)
    rate: float  # Rate (°C/min) — com vários trechos, o do trecho mais longo
    final_temp: float  # Temp (°C)
    final_iso_min: float  # Iso (min)
    purge_min: float  # Purge (min)
    # vários trechos (multi-heating rates: Rate1/Temp1/Iso1, Rate2…): (taxa, até °C, patamar min)
    steps: tuple[tuple[float, float, float], ...] = ()

    def segments(self) -> list[tuple[float, float, float]]:
        """Cada rampa: (taxa °C/min, de °C, até °C)."""
        if not self.steps:
            return [(self.rate, self.init_temp, self.final_temp)]
        out, start = [], self.init_temp
        for rate, temp, _iso in self.steps:
            out.append((rate, start, temp))
            start = temp
        return out

    @property
    def key(self) -> str:
        if len(self.steps) > 1:
            parts = [f"{self.init_temp:g}/{self.init_iso_min:g}"] + [f"{r:g}>{t:g}>{i:g}" for r, t, i in self.steps]
            return "/".join(parts)
        return "/".join(f"{v:g}" for v in (self.init_temp, self.init_iso_min, self.rate, self.final_temp, self.final_iso_min))

    @property
    def label(self) -> str:
        if len(self.steps) > 1:
            return f"{self.init_temp:g} °C ({self.init_iso_min:g} min)" + "".join(
                f" → {r:g} °C/min → {t:g} °C ({i:g} min)" for r, t, i in self.steps)
        return (
            f"{self.init_temp:g} °C ({self.init_iso_min:g} min) → {self.rate:g} °C/min → "
            f"{self.final_temp:g} °C ({self.final_iso_min:g} min)"
        )


def _cycle_program(lines: list[str] | None) -> CycleProgram | None:
    if not lines:
        return None
    kv = _kv(lines)
    if not kv.get("Rate"):
        return _multi_step_program(kv)
    return CycleProgram(
        init_temp=_float(kv.get("InitT")),
        init_iso_min=_float(kv.get("InitIso")),
        rate=_float(kv.get("Rate")),
        final_temp=_float(kv.get("Temp")),
        final_iso_min=_float(kv.get("Iso")),
        purge_min=_float(kv.get("Purge")),
    )


def _multi_step_program(kv: dict) -> CycleProgram | None:
    """Programa em trechos (multi-heating rates): `Rate1`/`Temp1`/`Iso1`…;
    trecho com taxa 0 = não usado."""
    steps = []
    for i in range(1, 10):
        rate = _float(kv.get(f"Rate{i}"))
        if rate > 0:
            steps.append((rate, _float(kv.get(f"Temp{i}")), _float(kv.get(f"Iso{i}"))))
    if not steps:
        return None
    init = _float(kv.get("InitT"))
    spans, start = [], init
    for rate, temp, _iso in steps:
        spans.append((temp - start, rate))
        start = temp
    return CycleProgram(
        init_temp=init, init_iso_min=_float(kv.get("InitIso")), rate=max(spans)[1],
        final_temp=steps[-1][1], final_iso_min=steps[-1][2], purge_min=_float(kv.get("Purge")),
        steps=tuple(steps),
    )


_ANALYSIS_SUFFIX = re.compile(r"\.[A-Za-z]00$")
# padrão de busca (pathlib e Agente Horun): "?" = a letra do método; o "~"
# do backup no fim faz o nome não casar
ANALYSIS_GLOB = "*.?00"


def is_analysis_file(name: str) -> bool:
    """`.B00` (bulk rock), `.M00` (multi-heating rates), `.O00` (pure oil),
    `.Q00`… — qualquer método do Rock-Eval 7S; nunca o backup `.B00~`."""
    return bool(_ANALYSIS_SUFFIX.search(name))


def analysis_stem(name: str) -> str:
    """Nome sem a extensão do método: `2026-06-11_X_1.M00` → `2026-06-11_X_1`."""
    return _ANALYSIS_SUFFIX.sub("", name)


def analysis_suffix(name: str) -> str:
    m = _ANALYSIS_SUFFIX.search(name)
    return m.group(0) if m else ""


@dataclass
class B00Header:
    """Parse leve — só o cabeçalho, sem tocar nas linhas de curva (a pasta
    real (`RE7raw-data`) tem centenas de `.B00`; listar todos com parse
    completo seria lento demais pra uma tela de navegação)."""

    sample: str
    method_folder: str  # CyclT — nome da subpasta de método
    cycle_name: str  # CyclN
    quantity_mg: float
    date: datetime | None
    cycle_pyro: CycleProgram | None = None
    cycle_oxi: CycleProgram | None = None

    @property
    def cycle_key(self) -> str:
        """Método + ciclo + programa da pirólise (e da oxidação) — duas
        corridas com a mesma chave são comparáveis numa curva de calibração."""
        parts = [self.method_folder, self.cycle_name]
        parts.append(f"P {self.cycle_pyro.key}" if self.cycle_pyro else "P ?")
        parts.append(f"O {self.cycle_oxi.key}" if self.cycle_oxi else "O ?")
        return " | ".join(parts)

    @property
    def cycle_label(self) -> str:
        pyro = self.cycle_pyro.label if self.cycle_pyro else "programa não informado"
        return f"{self.method_folder} · {self.cycle_name} · pirólise {pyro}"


@dataclass
class Curve:
    idx: list[int]
    temp: list[float]
    channels: dict[str, list[float]]  # nome do canal -> valores brutos


@dataclass
class Cursor:
    values: list[int]  # Curs_1, Curs_2, ... na ordem gravada no arquivo
    base: float


@dataclass
class B00Analysis:
    header: B00Header
    gas_names: dict[str, str]  # gas4..gas8 -> nome configurado (ou "NA")
    baseline: dict[str, float]  # "pyro:FID" / "oxi:CO2" -> valor LB_*
    cursors_auto: dict[str, Cursor]  # mesmas chaves "pyro:FID" etc
    cursors_manu: dict[str, Cursor]
    pyro: Curve | None
    oxi: Curve | None


def _parse_sections(text: str) -> dict[str, list[str]]:
    """Divide o arquivo em seções `[Nome]` -> linhas de conteúdo (sem a
    própria linha de cabeçalho da seção)."""
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for raw_line in _LINE_SPLIT_RE.split(text):
        line = raw_line.lstrip("﻿")  # BOM ocasional na 1ª linha
        m = _SECTION_RE.match(line.strip())
        if m:
            current = m.group(1)
            sections[current] = []
            continue
        if current is not None:
            sections[current].append(line)
    return sections


def _kv(lines: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in lines:
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip()
    return out


def _float(value: str | None, default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    try:
        return float(value)
    except ValueError:
        return default


def parse_header(text: str) -> B00Header:
    sections = _parse_sections(text)
    if "Param" not in sections:
        raise B00ParseError("Arquivo não parece um .B00 do Rock-Eval 7S (seção [Param] ausente)")
    param = _kv(sections.get("Param", []))
    identity = _kv(sections.get("Identity", []))

    date: datetime | None = None
    raw_date = identity.get("Date")
    if raw_date:
        try:
            date = datetime.strptime(raw_date, "%m-%d-%Y:%H-%M-%S")
        except ValueError:
            date = None

    return B00Header(
        sample=param.get("Sample", ""),
        method_folder=param.get("CyclT", ""),
        cycle_name=param.get("CyclN", ""),
        quantity_mg=_float(param.get("Quant")),
        date=date,
        cycle_pyro=_cycle_program(sections.get("Cycle Pyro")),
        cycle_oxi=_cycle_program(sections.get("Cycle Oxi")),
    )


def _parse_cursor_block(lines: list[str]) -> Cursor:
    kv = _kv(lines)
    values: list[int] = []
    i = 1
    while f"Curs_{i}" in kv:
        try:
            values.append(int(round(float(kv[f"Curs_{i}"]))))
        except ValueError:
            break
        i += 1
    return Cursor(values=values, base=_float(kv.get("Base")))


def _parse_curve(lines: list[str], channels: list[str]) -> Curve | None:
    idx: list[int] = []
    temp: list[float] = []
    per_channel: dict[str, list[float]] = {name: [] for name in channels}

    for line in lines:
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        try:
            row_idx = int(round(float(parts[0])))
            row_temp = float(parts[1])
        except ValueError:
            continue
        idx.append(row_idx)
        temp.append(row_temp)
        for offset, name in enumerate(channels):
            col = 2 + offset
            raw = parts[col] if col < len(parts) else ""
            per_channel[name].append(_float(raw))

    if not idx:
        return None
    return Curve(idx=idx, temp=temp, channels=per_channel)


def parse_full(text: str) -> B00Analysis:
    sections = _parse_sections(text)
    header = parse_header(text)

    gas_kv = _kv(sections.get("GasName", []))
    try:
        n_extra_gas = max(0, min(_MAX_EXTRA_GAS, int(gas_kv.get("nbGas", "0") or "0")))
    except ValueError:
        n_extra_gas = 0
    extra_channels = [f"GAS{4 + i}" for i in range(n_extra_gas)]
    gas_names = {f"gas{4 + i}": gas_kv.get(f"gas{4 + i}", "NA") for i in range(_MAX_EXTRA_GAS)}

    pyro_channels = _PYRO_BASE_CHANNELS + extra_channels
    oxi_channels = _OXI_BASE_CHANNELS + extra_channels

    baseline_kv = _kv(sections.get("base ligne", []))
    baseline: dict[str, float] = {}
    for name in pyro_channels:
        lb_key = "LB_FID" if name == "FID" else f"LB_{name}_P"
        baseline[f"pyro:{name}"] = _float(baseline_kv.get(lb_key))
    for name in oxi_channels:
        baseline[f"oxi:{name}"] = _float(baseline_kv.get(f"LB_{name}_O"))

    cursors_auto: dict[str, Cursor] = {}
    cursors_manu: dict[str, Cursor] = {}
    for slot_i, (curve, channel) in enumerate(CURSOR_SLOTS, start=1):
        key = f"{curve}:{channel}"
        auto_lines = sections.get(f"Curs auto_{slot_i}:Geoworks")
        if auto_lines is not None:
            cursors_auto[key] = _parse_cursor_block(auto_lines)
        manu_lines = sections.get(f"Curs manu_{slot_i}:Geoworks")
        if manu_lines is not None:
            cursors_manu[key] = _parse_cursor_block(manu_lines)

    pyro = _parse_curve(sections.get("Curves Pyro", []), pyro_channels)
    oxi = _parse_curve(sections.get("Curves Oxi", []), oxi_channels)

    return B00Analysis(
        header=header,
        gas_names=gas_names,
        baseline=baseline,
        cursors_auto=cursors_auto,
        cursors_manu=cursors_manu,
        pyro=pyro,
        oxi=oxi,
    )


# [Param]/[Identity] sempre terminam bem antes disso nos arquivos reais
# (~1.3 KB até [Info]) — ler só um prefixo, em vez do arquivo inteiro (que
# pode passar de 150 KB), é o que torna `list_analyses` + `read_header`
# viável pra navegar as centenas de `.B00` da pasta real sem parsear as
# curvas de cada um.
_HEADER_READ_BYTES = 8192


def read_header(path: str | Path) -> B00Header:
    with Path(path).open("rb") as f:
        chunk = f.read(_HEADER_READ_BYTES)
    text = chunk.decode("utf-8", errors="replace")
    return parse_header(text)


def read_full(path: str | Path) -> B00Analysis:
    return parse_full(Path(path).read_text(encoding="utf-8", errors="replace"))


def list_analyses(jobs_dir: Path) -> list[Path]:
    """Todas as análises (`.B00`, `.M00`, `.O00`… — `is_analysis_file`) em qualquer subpasta de `jobs_dir` (job -> método ->
    arquivos), recursivo. `*.B00~` (backup/autosave do GeoWorks — visto nos
    dados reais, às vezes sem o `.B00` final correspondente, ou seja a
    corrida não chegou a ser salva) fica automaticamente de fora: o padrão
    `*.B00` não casa com um nome terminado em `~`."""
    if not jobs_dir.exists():
        return []
    return sorted(p for p in jobs_dir.rglob(ANALYSIS_GLOB) if p.is_file() and is_analysis_file(p.name))
