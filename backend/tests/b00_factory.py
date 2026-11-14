"""Gerador de `.B00` SINTÉTICOS do Rock-Eval 7S para os testes do PostRun.

Só o FORMATO segue o arquivo do equipamento (texto tipo INI, `\\r\\n`, seções
`[Param]`, `[Cycle Pyro]`/`[Cycle Oxi]`, `[Identity]`, `[GasName]`,
`[base ligne]`, `[Curs auto_N:Geoworks]`/`[Curs manu_N:Geoworks]`,
`[Curves Pyro]` = `idx Temp FID CO CO2 SO2`, `[Curves Oxi]` = `idx Temp CO CO2
SO2` — ver app/modules/postrun_b00.py). Os números são todos inventados aqui:
nenhum dado de corrida real entra no repositório.

Sinais:
- temperatura: aquecimento até a temperatura inicial do programa, patamar,
  rampa exata (`rate` °C/min, 1 ponto por segundo — o que o equipamento
  grava), patamar final e resfriamento na purga;
- FID: linha de base + S1 pequeno no patamar inicial + S2 = soma de
  gaussianas (centro em °C na rampa, sigma em pontos, área em sinal × s
  conhecida: `área = altura × sigma × √(2π)`);
- CO/CO2/SO2 da pirólise e da oxidação: corcovas gaussianas sobre um
  patamar;
- ruído pseudoaleatório próprio (LCG com semente), para o arquivo ser
  idêntico em qualquer máquina e versão do Python/NumPy.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path

SQRT_2PI = math.sqrt(2 * math.pi)


@dataclass(frozen=True)
class Program:
    init_temp: float = 300.0
    init_iso_min: float = 3.0
    rate: float = 25.0
    final_temp: float = 650.0
    final_iso_min: float = 0.0
    purge_min: float = 3.0

    @property
    def ramp_start(self) -> int:
        return int(round(self.init_iso_min * 60))

    @property
    def ramp_end(self) -> int:
        return self.ramp_start + int(round((self.final_temp - self.init_temp) / (self.rate / 60.0)))

    @property
    def n_points(self) -> int:
        return self.ramp_end + int(round((self.final_iso_min + self.purge_min) * 60)) + 1

    def idx_at(self, temp_c: float) -> float:
        """Índice (= segundos) em que a rampa passa por `temp_c`."""
        return self.ramp_start + (temp_c - self.init_temp) / (self.rate / 60.0)

    def key(self) -> str:
        return "/".join(f"{v:g}" for v in (self.init_temp, self.init_iso_min, self.rate, self.final_temp, self.final_iso_min))


@dataclass(frozen=True)
class Peak:
    """Pico gaussiano do FID: centro em °C (na rampa), largura em pontos e
    área em sinal × ponto (= sinal × s, 1 ponto por segundo)."""

    center_c: float
    sigma: float
    area: float

    def height(self) -> float:
        return self.area / (self.sigma * SQRT_2PI)


@dataclass(frozen=True)
class B00Spec:
    sample: str
    quant_mg: float
    date: datetime
    cycle_name: str = "BASIC"
    method_folder: str = "BULK ROCK"
    pyro: Program = field(default_factory=Program)
    oxi: Program = field(default_factory=lambda: Program(300.0, 1.0, 20.0, 850.0, 5.0, 5.0))
    s2_peaks: tuple[Peak, ...] = ()
    s1_area: float = 20000.0
    fid_base: float = 90.0
    fid_noise: float = 3.0
    seed: int = 1

    def s2_center_idx(self, peak: Peak) -> float:
        return self.pyro.idx_at(peak.center_c)

    @property
    def fid_cursor(self) -> list[int]:
        """Cursor `Curs auto_1` (FID) gravado no arquivo: início da rampa,
        máximo do S2, pontos intermediários, fim da integração, máximo de
        novo — como o GeoWorks grava (não vêm em ordem crescente)."""
        main = max(self.s2_peaks, key=lambda p: p.height()) if self.s2_peaks else Peak(self.pyro.init_temp + 100, 40, 1)
        top = int(round(self.s2_center_idx(main)))
        return [self.pyro.ramp_start, top, top + 50, top + 220, self.pyro.ramp_end + 10, top]

    @property
    def s2_area(self) -> float:
        return sum(p.area for p in self.s2_peaks)


class _Noise:
    """Ruído determinístico: gerador congruencial + soma de 12 uniformes."""

    def __init__(self, seed: int):
        self.state = (seed * 2654435761 + 12345) % 2**32 or 1

    def uniform(self) -> float:
        self.state = (1664525 * self.state + 1013904223) % 2**32
        return self.state / 2**32

    def normal(self) -> float:
        return sum(self.uniform() for _ in range(12)) - 6.0


def _gauss(x: float, center: float, sigma: float, height: float) -> float:
    return height * math.exp(-0.5 * ((x - center) / sigma) ** 2)


def _temperature(program: Program, i: int, start_temp: float, cool_to: float) -> float:
    if i < program.ramp_start:  # aquecendo até o patamar inicial
        return program.init_temp - (program.init_temp - start_temp) * math.exp(-i / 25.0)
    if i <= program.ramp_end:
        return program.init_temp + (program.rate / 60.0) * (i - program.ramp_start)
    hold_end = program.ramp_end + int(round(program.final_iso_min * 60))
    if i <= hold_end:
        return program.final_temp
    return cool_to + (program.final_temp - cool_to) * math.exp(-(i - hold_end) / 150.0)


def _num(v: float) -> str:
    return f"{v:.6g}"


def _pyro_rows(spec: B00Spec, noise: _Noise) -> list[str]:
    p = spec.pyro
    rows = []
    s1_center, s1_sigma = p.ramp_start * 0.6, 18.0
    s1_height = spec.s1_area / (s1_sigma * SQRT_2PI)
    peaks = [(spec.s2_center_idx(pk), pk.sigma, pk.height()) for pk in spec.s2_peaks]
    s3_center = p.idx_at(p.init_temp + 60)
    for i in range(p.n_points):
        temp = _temperature(p, i, p.init_temp - 110, p.init_temp + 150) + 0.02 * noise.normal()
        fid = spec.fid_base + _gauss(i, s1_center, s1_sigma, s1_height)
        fid += sum(_gauss(i, c, s, h) for c, s, h in peaks)
        fid += spec.fid_noise * noise.normal()
        co = 4.0 + _gauss(i, p.idx_at(p.init_temp + 180), 90.0, 120.0) + 0.5 * noise.normal()
        co2 = 40.0 + _gauss(i, s3_center, 60.0, 800.0) + 3.0 * noise.normal()
        so2 = max(0.0, 0.3 * noise.normal())
        rows.append(f"{i}\t{_num(round(temp, 3))}\t{int(round(fid))}\t{_num(round(co, 3))}\t"
                    f"{_num(round(co2, 3))}\t{_num(round(so2, 3))}")
    return rows


def _oxi_rows(spec: B00Spec, noise: _Noise) -> list[str]:
    p = spec.oxi
    rows = []
    for i in range(p.n_points):
        temp = _temperature(p, i, p.init_temp - 5, p.init_temp + 300) + 0.02 * noise.normal()
        co = 1.0 + _gauss(i, p.idx_at(560.0), 120.0, 150.0) + 0.4 * noise.normal()
        co2 = 5.0 + _gauss(i, p.idx_at(620.0), 140.0, 2500.0) + 4.0 * noise.normal()
        so2 = max(0.0, 0.2 * noise.normal())
        rows.append(f"{i}\t{_num(round(temp, 3))}\t{_num(round(co, 3))}\t{_num(round(co2, 3))}\t{_num(round(so2, 3))}")
    return rows


def _cycle(name: str, program: Program, status_key: str) -> list[str]:
    return [
        f"[Cycle {name}]", "Starting Analysis=", "End Analysis=", f"{status_key}=", "RE Status=",
        f"InitT={program.init_temp:g}", f"InitIso={program.init_iso_min:g}", f"Rate={program.rate:g}",
        f"Temp={program.final_temp:g}", f"Iso={program.final_iso_min:g}", f"Purge={program.purge_min:g}",
    ]


def _cursor_blocks(kind: str, spec: B00Spec) -> list[str]:
    p, o = spec.pyro, spec.oxi
    slots = [
        (spec.fid_cursor, spec.fid_base),
        ([p.ramp_start, int(p.idx_at(p.init_temp + 180)), p.ramp_end + 10], 4.0),
        ([p.ramp_start, int(p.idx_at(p.init_temp + 60)), p.ramp_end + 10], 40.0),
        ([p.ramp_start, p.ramp_end + 10], 0.0),
        ([o.ramp_start, int(o.idx_at(560.0)), o.ramp_end + 10], 1.0),
        ([o.ramp_start, int(o.idx_at(620.0)), o.ramp_end + 10], 5.0),
        ([o.ramp_start, o.ramp_end + 10], 0.0),
    ]
    lines: list[str] = []
    for n, (values, base) in enumerate(slots, start=1):
        lines.append(f"[Curs {kind}_{n}:Geoworks]")
        lines += [f"Curs_{i}={v}" for i, v in enumerate(values, start=1)]
        lines += [f"Base={base:g}", ""]
    return lines


def b00_text(spec: B00Spec) -> str:
    noise = _Noise(spec.seed)
    stamp = spec.date.strftime("%m-%d-%Y:%H-%M-%S")
    lines = [
        "[Param]", f"Sample={spec.sample}", "Type=Analysis", "Nature=", "Stage=", "Coun=COUNTRY", "Well=WELL",
        "Basin=BASIN", "Unit=1", "Depth=0", f"Quant={spec.quant_mg:.3f}", f"CyclN={spec.cycle_name}",
        f"CyclT={spec.method_folder}",
        "[Coeff]", "KFID=1.00", "KCO_pyro=1.00", "KCO2_pyro=1.00", "KSO2_pyro=1.00",
        "[Version SW]", "Version Supervisor=SYNTHETIC", "Calibration=True",
        "[GasName]", "nbGas=0", *(f"gas{i}=NA" for i in range(4, 9)),
        *_cycle("Pyro", spec.pyro, "Pyrolysis status"),
        *_cycle("Oxi", spec.oxi, "Oxidation status"),
        "[Identity]", "Analyser=SYNTHETIC", f"Date={stamp}",
        "[Info]", "LastBlank=No blank substraction",
        "[base ligne]", f"LB_FID={spec.fid_base:.3f}", "LB_CO_P=4.000", "LB_CO2_P=40.000", "LB_SO2_P=0.000",
        *(f"LB_GAS{i}_P=0.000" for i in range(4, 9)),
        "LB_CO_O=1.000", "LB_CO2_O=5.000", "LB_SO2_O=0.000", *(f"LB_GAS{i}_O=0.000" for i in range(4, 9)),
        "",
        *_cursor_blocks("auto", spec),
        *_cursor_blocks("manu", spec),
        "[Calibration:Geoworks]", "P_HC_LawType=Gain", "P_HC_K0=0.000000e+00", "P_HC_K1=1.000000e-07",
        "Comments=sintetico", "",
        "[Curves Pyro]", *_pyro_rows(spec, noise), "",
        "[Curves Oxi]", *_oxi_rows(spec, noise),
    ]
    return "\r\n".join(lines) + "\r\n"


def write_b00(path: Path, spec: B00Spec) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b00_text(spec).encode("ascii"))
    return path


# --------------------------------------------------------------- conjunto padrão
#
# "PADRAO": duas réplicas de um padrão de um pico só (S2 gaussiano a 440 °C),
# com rendimento fixo de FID por mg (`YIELD`): área do S2 = YIELD × massa.
# "Mix X": uma mistura de dois materiais (o do padrão a 440 °C e um "X" a
# 500 °C), metade da massa cada, mesmo rendimento — e um nome fora da
# convenção AAAA-MM-DD_código_réplica. Mais um `.B00~` órfão (o equipamento
# às vezes deixa só o backup), que a listagem tem de ignorar.

YIELD = 40000.0  # área do S2 (sinal × s) por mg de amostra

T1 = "PADRAO/BULK ROCK/2026-07-17_STDA_1.B00"
T2 = "PADRAO/BULK ROCK/2026-07-17_STDA_2.B00"
T3 = "Mix X/BULK ROCK/RE7_MIXX_0_11052026.B00"
ORPHAN_BACKUP = "Mix X/BULK ROCK/RE7_OLD_07052026.B00~"
JOB_STD = "PADRAO"
JOB_MIX = "Mix X"

SPECS: dict[str, B00Spec] = {
    T1: B00Spec(
        sample="STDA", quant_mg=60.0, date=datetime(2026, 7, 17, 9, 15, 30),
        s2_peaks=(Peak(440.0, 45.0, YIELD * 60.0),), seed=11,
    ),
    T2: B00Spec(
        sample="STDA", quant_mg=30.0, date=datetime(2026, 7, 17, 10, 2, 11),
        s2_peaks=(Peak(441.0, 46.0, YIELD * 30.0),), seed=12,
    ),
    T3: B00Spec(
        sample="MIXX", quant_mg=40.0, date=datetime(2026, 5, 11, 14, 30, 0),
        s2_peaks=(Peak(440.0, 45.0, YIELD * 20.0), Peak(500.0, 40.0, YIELD * 20.0)), seed=13,
    ),
    ORPHAN_BACKUP: B00Spec(
        sample="OLD", quant_mg=50.0, date=datetime(2026, 5, 7, 8, 0, 0),
        s2_peaks=(Peak(450.0, 45.0, YIELD * 50.0),), seed=14,
    ),
}


def build_standard_tree(root: Path) -> Path:
    """Escreve o conjunto padrão em `root` (a "RE7raw-data" dos testes)."""
    for token, spec in SPECS.items():
        write_b00(root / token, spec)
    return root


def with_changes(spec: B00Spec, **changes) -> B00Spec:
    return replace(spec, **changes)
