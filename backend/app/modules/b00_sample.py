"""Trocar a AMOSTRA de uma análise já feita (pedido do usuário, 2026-10-20):
alguém escolheu a amostra errada da biblioteca, o equipamento gravou o
`.B00` com o nome errado. A correção mexe em duas coisas:

1. dentro do `.B00` (e do `.B00~`), a linha `Sample=` da seção `[Param]` —
   o ÚNICO lugar do arquivo que cita a amostra (conferido nos arquivos
   reais; o nome da análise e o job não aparecem no conteúdo). A troca é
   feita nos BYTES, só nessa linha: o resto do arquivo (curvas, cursores,
   fins de linha) fica idêntico;
2. o nome da análise (nome do arquivo), trocando o código da amostra no meio
   da convenção `AAAA-MM-DD_<código>[_<extra>]_<réplica>` — data, extra e
   réplica ficam. Se o nome novo já existir, a réplica anda para o próximo
   número livre (o caso das réplicas: as 3 corridas da amostra errada viram
   as réplicas seguintes da certa)."""

from __future__ import annotations

import re

from app.modules.analysis_rename import RenameError

# [Param] ... Sample=<valor>  (só dentro da seção [Param])
_PARAM_SAMPLE = re.compile(rb"(\[Param\][^\[]*?(?:\r\n|\r|\n))(Sample=)([^\r\n]*)")
_CONVENTION = re.compile(r"^(\d{4}-\d{2}-\d{2})_(.+)_(\d+)$")
MAX_REPLICA = 99


def read_sample(content: bytes) -> str:
    m = _PARAM_SAMPLE.search(content)
    if m is None:
        raise RenameError("Arquivo sem a linha Sample= na seção [Param] — não parece um .B00 do Rock-Eval 7S.")
    return m.group(3).decode("utf-8", errors="replace").strip()


def with_sample(content: bytes, new_sample: str) -> bytes:
    """O mesmo arquivo, com `Sample=` trocado — e nada mais."""
    try:
        encoded = new_sample.encode("ascii")
    except UnicodeEncodeError as exc:
        raise RenameError(
            f"O código {new_sample!r} tem acento ou caractere especial — o Rock-Eval só grava texto simples (ASCII)."
        ) from exc
    m = _PARAM_SAMPLE.search(content)
    if m is None:
        raise RenameError("Arquivo sem a linha Sample= na seção [Param] — não parece um .B00 do Rock-Eval 7S.")
    return content[: m.start(3)] + encoded + content[m.end(3):]


def split_name(name: str, old_code: str) -> tuple[str, str, int]:
    """`2026-07-17_PEAD_rep_2` (código PEAD) → ("2026-07-17", "_rep", 2):
    data, o que vem depois do código (o extra, com o "_") e a réplica."""
    m = _CONVENTION.match(name)
    if m is None:
        raise RenameError(
            f"O nome {name!r} não segue a convenção AAAA-MM-DD_código_réplica — não dá para saber onde está o código "
            "da amostra. Renomeie a análise primeiro (✎)."
        )
    date, middle, replica = m.group(1), m.group(2), int(m.group(3))
    if old_code and (middle == old_code or middle.startswith(old_code + "_")):
        return date, middle[len(old_code):], replica
    raise RenameError(
        f"O nome {name!r} não começa pelo código da amostra gravada no arquivo ({old_code!r}) — "
        "renomeie a análise primeiro (✎)."
    )


def build_name(date: str, new_code: str, tail: str, replica: int) -> str:
    return f"{date}_{new_code}{tail}_{replica}"


# ------------------------------------------------------------------ massa
# Editar a massa no PostRun (pedido do usuário, 2026-10-23) grava também a
# linha `Quant=` da seção [Param] — a massa em mg, com 3 casas, como o
# equipamento grava (ex. "Quant=60.007"). Mesma regra do Sample=: só essa
# linha muda, o resto do arquivo fica idêntico.

_PARAM_QUANT = re.compile(rb"(\[Param\][^\[]*?(?:\r\n|\r|\n))(Quant=)([^\r\n]*)")


def read_quantity(content: bytes) -> float:
    m = _PARAM_QUANT.search(content)
    if m is None:
        raise RenameError("Arquivo sem a linha Quant= na seção [Param] — não parece um .B00 do Rock-Eval 7S.")
    try:
        return float(m.group(3).decode("ascii", errors="replace").strip() or 0)
    except ValueError:
        return 0.0


def with_quantity(content: bytes, mass_mg: float) -> bytes:
    """O mesmo arquivo, com `Quant=` trocado — e nada mais."""
    m = _PARAM_QUANT.search(content)
    if m is None:
        raise RenameError("Arquivo sem a linha Quant= na seção [Param] — não parece um .B00 do Rock-Eval 7S.")
    return content[: m.start(3)] + f"{mass_mg:.3f}".encode("ascii") + content[m.end(3):]
