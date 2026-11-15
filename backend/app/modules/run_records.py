"""Rastreabilidade por corrida (F4 do artigo): exclusões com motivo e
comentário, metadados e o checksum dos `.B00`.

Uma corrida excluída continua existindo (arquivo, regiões, deconvoluções) —
só sai das contas: relatório de recuperação, validação e pontos das curvas,
sempre com o motivo à vista. Cada exclusão/restauração fica no registro
imutável `PostrunExclusionLog`."""

from __future__ import annotations

import hashlib

from sqlmodel import Session, select

from app.db.models import PostrunRunRecord

# motivo → como aparece (pedido do artigo: lista fechada + comentário)
REASONS: dict[str, str] = {
    "falha": "corrida falha",
    "massa_ausente": "massa ausente",
    "nome_suspeito": "troca de nome suspeita",
    "outro": "outro",
}


def reason_label(key: str) -> str:
    return REASONS.get(key, key or "sem motivo")


def excluded_map(session: Session, tokens: list[str] | set[str]) -> dict[str, str]:
    """token → texto do motivo ("excluída — corrida falha: comentário")."""
    tokens = list(tokens)
    if not tokens:
        return {}
    rows = session.exec(
        select(PostrunRunRecord).where(PostrunRunRecord.excluded.is_(True), PostrunRunRecord.token.in_(tokens))  # type: ignore[union-attr]
    ).all()
    return {
        r.token: f"excluída — {reason_label(r.exclusion_reason)}" + (f": {r.exclusion_comment}" if r.exclusion_comment else "")
        for r in rows
    }


def sha256_text(text: str) -> str:
    """SHA-256 do conteúdo do `.B00`. O Agente entrega o arquivo decodificado
    em UTF-8 estrito, então re-codificar dá os mesmos bytes do arquivo."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
