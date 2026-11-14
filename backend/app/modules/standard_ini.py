"""Parser do `standard.ini` do Rock-Eval 7S — mesma pasta do TABSAMPLE e do
savecycle no PC do equipamento (pedido do usuário). Guarda os padrões
fisicamente carregados nas posições de padrão do equipamento (3 slots,
STD1-STD3), usados pelo próprio equipamento para calibrar o sinal do FID a
partir de S2 e Tmax.

Formato confirmado por arquivo real fornecido pelo usuário — INI com
valores entre aspas:

    [STD1]
    stdName = "std300000"
    stdTmax = 449.000000
    stdS2 = 70.600000

Um slot com stdTmax = stdS2 = 0 significa posição vazia (sem padrão
carregado) — não é tratado como erro, só sinalizado como `loaded=False` pra
UI mostrar como slot vazio.
"""

from __future__ import annotations

import configparser
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

SLOTS = ("STD1", "STD2", "STD3")
EOL = "\r\n"


@dataclass
class InstrumentStandard:
    slot: str  # "STD1", "STD2", "STD3"
    name: str
    tmax: float
    s2: float

    @property
    def loaded(self) -> bool:
        return self.tmax != 0 or self.s2 != 0


def _strip_quotes(raw: str) -> str:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        return raw[1:-1]
    return raw


def parse(text: str) -> list[InstrumentStandard]:
    parser = configparser.ConfigParser()
    parser.read_string(text)
    result = []
    for section in parser.sections():
        result.append(
            InstrumentStandard(
                slot=section,
                name=_strip_quotes(parser.get(section, "stdName", fallback='""')),
                tmax=parser.getfloat(section, "stdTmax", fallback=0.0),
                s2=parser.getfloat(section, "stdS2", fallback=0.0),
            )
        )
    return result


def read_file(path: str | Path) -> list[InstrumentStandard]:
    p = Path(path)
    if not p.exists():
        return []
    return parse(p.read_text(encoding="utf-8"))


def serialize(entries: list[InstrumentStandard]) -> str:
    """Serializa de volta pro formato observado no arquivo real (seção 9),
    sempre os 3 slots STD1-STD3 na ordem, valor com aspas pro nome e 6
    casas decimais pros números — mesmo estilo do arquivo original."""
    lines: list[str] = []
    for e in entries:
        lines.append(f"[{e.slot}]")
        lines.append(f'stdName = "{e.name}"')
        lines.append(f"stdTmax = {e.tmax:.6f}")
        lines.append(f"stdS2 = {e.s2:.6f}")
        lines.append("")
    return EOL.join(lines)


def write_file_atomic(path: str | Path, entries: list[InstrumentStandard]) -> None:
    """Grava o standard.ini por substituição atômica (mesmo padrão do
    TABSAMPLE/savecycle/queue_files — nunca deixar o equipamento ler um
    arquivo pela metade). Pedido do usuário: ao criar um padrão de
    calibração novo, o Horun escreve S2/Tmax nesse arquivo, que é o que o
    RE7S usa de verdade pra calibrar o FID."""
    path = Path(path)
    content = serialize(entries)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, prefix=".standardini_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        os.replace(tmp_path, path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise
