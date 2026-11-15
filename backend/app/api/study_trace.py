"""Relatório de rastreabilidade do estudo (F4 do artigo) — abas extras do
Excel do estudo: versão do GeoHorun, parâmetros de cada ajuste (janela,
limites/tolerâncias, pontos de partida, referências), exclusões (estado e
histórico) e o SHA-256 de cada `.B00`, com os metadados da corrida."""

from __future__ import annotations

import json
import os
from importlib import metadata

from fastapi import HTTPException
from sqlmodel import Session, select

from app.core.config import settings
from app.db.models import PostrunB00Cache, PostrunDeconvolution, PostrunExclusionLog, PostrunRunRecord
from app.modules import run_records


def geohorun_version() -> str:
    """Versão do pacote + identificador do build (GEOHORUN_BUILD, ex. o commit,
    passado na imagem Docker), quando houver."""
    try:
        v = metadata.version("geohorun")
    except metadata.PackageNotFoundError:
        v = "dev"
    build = os.environ.get("GEOHORUN_BUILD", "").strip()
    return f"{v} ({build})" if build else v


def b00_sha256(session: Session, token: str) -> tuple[str | None, str | None]:
    """(sha256, erro). Pelo Agente usa o texto já guardado no cache quando há."""
    from app.api.routes_postrun import _read_agent_b00_text, _resolve_token

    try:
        if settings.agent_mode:
            cached = session.get(PostrunB00Cache, token)
            text = cached.content if cached is not None else _read_agent_b00_text(session, token)
            return run_records.sha256_text(text), None
        return run_records.sha256_bytes(_resolve_token(token).read_bytes()), None
    except HTTPException as exc:
        return None, str(exc.detail)
    except OSError as exc:
        return None, str(exc)


def trace_sheets(session: Session, tokens: list[str], summaries: dict, deconvs: dict[str, dict[str, PostrunDeconvolution]]):
    """[(título, cabeçalho, linhas, larguras)] para o Excel do estudo."""
    records = {t: session.get(PostrunRunRecord, t) for t in tokens}

    files = []
    for t in tokens:
        sm = summaries.get(t)
        r = records.get(t)
        sha, err = b00_sha256(session, t)
        files.append([
            t, sm.filename if sm else "", sm.sample if sm else "",
            sm.date.date().isoformat() if sm and sm.date else "", r.run_date if r else "",
            r.operator if r else "", sm.mass_mg if sm else None, r.matrix_mass_mg if r else None,
            r.polymer_lot if r else "", r.granulometry if r else "", r.notes if r else "",
            "sim" if r and r.excluded else "não", sha or f"(erro: {err})",
        ])

    params = []
    for method, rows in deconvs.items():
        for t, d in rows.items():
            res = json.loads(d.result or "{}")
            params.append([
                t, method, d.shape, d.mode, d.channel, d.start_idx, d.end_idx, d.baseline_mode, d.fixed_baseline,
                d.n_peaks, d.tol_c, d.tol_width_pct, ", ".join(json.loads(d.names or "[]")),
                ", ".join(f"{g:g}" for g in json.loads(d.guesses_c or "[]")),
                ", ".join(str(i) for i in json.loads(d.reference_ids or "[]")),
                res.get("r2"), res.get("bic"), d.updated_at.isoformat() if d.updated_at else "",
            ])

    excl = [[t, run_records.reason_label(r.exclusion_reason), r.exclusion_comment, r.excluded_by,
             r.excluded_at.isoformat() if r.excluded_at else ""]
            for t, r in records.items() if r is not None and r.excluded]
    log = [[g.at.isoformat(), g.token, g.action, run_records.reason_label(g.reason), g.comment, g.user]
           for g in session.exec(select(PostrunExclusionLog).where(PostrunExclusionLog.token.in_(tokens))  # type: ignore[union-attr]
                                 .order_by(PostrunExclusionLog.at)).all()]

    return [
        ("Arquivos e metadados", [
            "Caminho", "Arquivo", "Amostra", "Data no .B00", "Data informada", "Operador", "Massa (mg)",
            "Massa de matriz (mg)", "Lote/fabricante", "Granulometria", "Observações", "Excluída", "SHA-256 do .B00",
        ], files, {1: 50, 2: 34, 13: 66}),
        ("Parâmetros dos ajustes", [
            "Caminho", "Método", "Forma", "Modo", "Canal", "Início (idx)", "Fim (idx)", "Linha de base",
            "Base fixa", "Picos", "Tolerância centro (±°C)", "Tolerância largura (±%)", "Nomes", "Chutes de centro (°C)",
            "Referências (ids)", "R²", "BIC", "Salvo em",
        ], params, {1: 50}),
        ("Exclusões", ["Caminho", "Motivo", "Comentário", "Por", "Em"], excl, {1: 50, 3: 50}),
        ("Exclusões (histórico)", ["Quando", "Caminho", "Ação", "Motivo", "Comentário", "Por"], log, {2: 50, 5: 50}),
    ]
