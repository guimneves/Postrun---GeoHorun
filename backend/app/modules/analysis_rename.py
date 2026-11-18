"""Renomear o nome e/ou o job de uma análise já feita (pedido do usuário,
2026-10-01). Ver `AnalysisRename` em `app/db/models.py` para o porquê das
regras; aqui ficam as partes puras (caminhos, nomes, plano de movimentos) e a
execução no disco local (Fase 1). No modo agente, o mesmo plano vai para
`agent_bridge.move_files`.

Na `RE7raw-data`, o nome da análise é o NOME DO ARQUIVO e o job é a PRIMEIRA
PASTA: `<job>/<pastas do método>/<nome da análise>.B00`. O conteúdo do
`.B00` não cita nenhum dos dois (conferido em 400 arquivos reais), então
renomear nunca precisa abrir nem reescrever o arquivo. O `.B00~` (cópia
anterior guardada pelo GeoWorks, diferente do `.B00`) anda sempre junto.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from sqlmodel import Session, select

from app.modules.naming import forbidden_chars_message

B00_SUFFIX = ".B00"
BACKUP_SUFFIX = ".B00~"
# qualquer método (18/11/2026): .B00, .M00 (multi-heating rates), .O00 (pure oil)…
_SUFFIX = re.compile(r"\.[A-Za-z]00$")

# Caracteres que o Windows não aceita em nome de arquivo/pasta.
_INVALID_CHARS = set('<>:"/\\|?*')
_RESERVED_WINDOWS = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
# Convenção do Horun (`naming.generate_analysis_name`):
# AAAA-MM-DD_<código>[_<extra>]_<réplica>
_CONVENTION = re.compile(r"^(\d{4}-\d{2}-\d{2})_(.+)_(\d+)$")


class RenameError(ValueError):
    """Pedido inválido — mensagem pronta para o usuário."""


@dataclass(frozen=True)
class AnalysisPath:
    job: str
    method_dirs: tuple[str, ...]  # ex. ("BULK ROCK",) ou ("Rochas_Araripe", "BULK ROCK")
    name: str  # nome da análise = nome do arquivo sem a extensão
    suffix: str = B00_SUFFIX  # extensão do método: ".B00", ".M00", ".O00"…

    @property
    def token(self) -> str:
        return PurePosixPath(self.job, *self.method_dirs, self.name + self.suffix).as_posix()


def split_token(token: str) -> AnalysisPath:
    parts = PurePosixPath(token).parts
    m = _SUFFIX.search(parts[-1]) if parts else None
    if len(parts) < 2 or m is None or ".." in parts or token.startswith("/"):
        raise RenameError("Análise inválida.")
    return AnalysisPath(job=parts[0], method_dirs=tuple(parts[1:-1]), name=parts[-1][: m.start()], suffix=m.group(0))


def validate_component(value: str, label: str) -> str:
    """Um nome de arquivo ou de pasta válido no Windows (onde está o
    equipamento)."""
    value = (value or "").strip()
    if not value:
        raise RenameError(f"{label}: não pode ficar vazio.")
    bad = sorted({c for c in value if c in _INVALID_CHARS or ord(c) < 32})
    if bad:
        raise RenameError(f"{label}: caracteres não permitidos no Windows: {' '.join(bad)}")
    if value.endswith(".") or value.endswith(" "):
        raise RenameError(f"{label}: não pode terminar em ponto ou espaço.")
    if value.split(".")[0].upper() in _RESERVED_WINDOWS:
        raise RenameError(f"{label}: {value!r} é um nome reservado do Windows.")
    if len(value) > 120:
        raise RenameError(f"{label}: longo demais (máximo 120 caracteres).")
    return value


def name_with_extra(current_name: str, extra: str) -> str:
    """Põe o "extra" no nome da análise, no lugar que a convenção do Horun
    usa: `2026-07-17_IFP160000_1` + "rep" → `2026-07-17_IFP160000_rep_1`.
    Se o nome já tiver um extra, o novo vai depois dele (nunca apaga o que
    já estava). Nomes fora da convenção não têm onde encaixar o extra — aí a
    tela pede o nome completo."""
    extra = validate_component(extra, "Extra")
    _check_rockeval_chars(extra, "Extra")
    if "_" in extra:
        raise RenameError("Extra: não use '_' (é o separador do nome da análise).")
    match = _CONVENTION.match(current_name)
    if match is None:
        raise RenameError(
            f"O nome {current_name!r} não segue a convenção AAAA-MM-DD_código_réplica — "
            "informe o nome completo."
        )
    date, middle, replica = match.groups()
    return f"{date}_{middle}_{extra}_{replica}"


def _check_rockeval_chars(value: str, label: str) -> None:
    # `. , / \ : ;` — o RockSeven Supervisor rejeita (naming.FORBIDDEN_NAME_CHARS)
    message = forbidden_chars_message(value, label)
    if message:
        raise RenameError(message)


def follows_convention(name: str) -> bool:
    return _CONVENTION.match(name) is not None


def plan(old: AnalysisPath, *, new_name: str | None, new_job: str | None) -> tuple[AnalysisPath, list[dict]]:
    """Destino + lista de movimentos (formato de `move_files` do agente)."""
    if new_name is not None:
        new_name = validate_component(new_name, "Nome da análise")
        _check_rockeval_chars(new_name, "Nome da análise")
    target = AnalysisPath(
        job=validate_component(new_job, "Job") if new_job is not None else old.job,
        method_dirs=old.method_dirs,
        name=new_name if new_name is not None else old.name,
        suffix=old.suffix,
    )
    if target == old:
        raise RenameError("Nada mudou: o nome e o job são os mesmos.")
    moves = [
        {"from": old.token, "to": target.token},
        # backup do GeoWorks: o mesmo nome com "~" no fim (.B00~, .M00~…)
        {"from": old.token + "~", "to": target.token + "~", "optional": True},
    ]
    return target, moves


def execute_local(base: Path, moves: list[dict]) -> list[str]:
    """Mesma semântica do `move_files` do Agente Horun (tudo ou nada, nunca
    sobrescreve, confinado à pasta) — usada na Fase 1, com a RE7raw-data no
    próprio disco do backend."""
    base = base.resolve()

    def inside(rel: str) -> Path:
        p = (base / rel).resolve()
        if base not in p.parents:
            raise RenameError("Caminho inválido.")
        return p

    planned: list[tuple[Path, Path, str]] = []
    for m in moves:
        src, dst = inside(m["from"]), inside(m["to"])
        if not src.is_file():
            if m.get("optional"):
                continue
            raise RenameError(f"Arquivo não encontrado: {m['from']}")
        if dst.exists():
            raise RenameError(f"Já existe um arquivo com esse nome: {m['to']}")
        planned.append((src, dst, m["to"]))
    if not planned:
        raise RenameError("Arquivo não encontrado.")

    done: list[tuple[Path, Path]] = []
    try:
        for src, dst, _ in planned:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                raise RenameError(f"Já existe um arquivo com esse nome: {dst.name}")
            os.rename(src, dst)
            done.append((src, dst))
    except BaseException as exc:
        for src, dst in reversed(done):
            try:
                os.rename(dst, src)
            except OSError:
                pass
        if isinstance(exc, OSError):
            raise RenameError(f"Não foi possível mover (arquivo aberto em outro programa?): {exc}") from exc
        raise
    return [rel for _, _, rel in planned]


def repoint_postrun(session: Session, old_token: str, new_token: str) -> None:
    """Tudo no PostRun que guarda o caminho do `.B00` passa a apontar para o
    novo — senão regiões de integração, cache e pontos de calibração da
    análise ficariam órfãos. Não faz commit (quem chama decide)."""
    from app.db.models import (
        PostrunAnalysisMeta,
        PostrunB00Cache,
        PostrunCalibration,
        PostrunCurve,
        PostrunDeconvolution,
        PostrunDeconvReference,
        PostrunRegion,
    )

    for deconv in session.exec(select(PostrunDeconvolution).where(PostrunDeconvolution.token == old_token)).all():
        deconv.token = new_token
        session.add(deconv)
    for ref in session.exec(select(PostrunDeconvReference)).all():
        tokens = json.loads(ref.tokens or "[]")
        if old_token in tokens:
            ref.tokens = json.dumps([new_token if t == old_token else t for t in tokens])
            session.add(ref)

    for region in session.exec(select(PostrunRegion).where(PostrunRegion.token == old_token)).all():
        region.token = new_token
        session.add(region)

    meta = session.get(PostrunAnalysisMeta, old_token)
    if meta is not None:
        # todas as colunas (massa original do arquivo, massas reais dos
        # componentes...), só o token muda
        moved = PostrunAnalysisMeta(**{**meta.model_dump(), "token": new_token})
        session.delete(meta)
        session.flush()
        if session.get(PostrunAnalysisMeta, new_token) is None:
            session.add(moved)

    for curve in session.exec(select(PostrunCurve)).all():
        points = json.loads(curve.points or "[]")
        if any(pt.get("token") == old_token for pt in points):
            for pt in points:
                if pt.get("token") == old_token:
                    pt["token"] = new_token
            curve.points = json.dumps(points)
            session.add(curve)

    cached = session.get(PostrunB00Cache, old_token)
    if cached is not None:
        content = cached.content
        session.delete(cached)
        session.flush()
        if session.get(PostrunB00Cache, new_token) is None:
            session.add(PostrunB00Cache(token=new_token, content=content))

    for calibration in session.exec(select(PostrunCalibration)).all():
        points = json.loads(calibration.source_points or "[]")
        changed = False
        for point in points:
            if point.get("token") == old_token:
                point["token"] = new_token
                changed = True
        if changed:
            calibration.source_points = json.dumps(points)
            session.add(calibration)

    # F4: o registro de rastreabilidade e o histórico de exclusões acompanham
    from app.db.models import PostrunExclusionLog, PostrunRunRecord

    record = session.get(PostrunRunRecord, old_token)
    if record is not None and session.get(PostrunRunRecord, new_token) is None:
        moved_record = PostrunRunRecord(**{**record.model_dump(), "token": new_token})
        session.delete(record)
        session.flush()
        session.add(moved_record)
    for log in session.exec(select(PostrunExclusionLog).where(PostrunExclusionLog.token == old_token)).all():
        log.token = new_token
        session.add(log)


def sample_corrections(session: Session) -> dict[int, tuple[str, int | None]]:
    """Entrada do histórico → (código da amostra certa, id na biblioteca),
    das trocas de amostra feitas pelo PostRun (a mais recente vale). O
    histórico continua como foi gravado; quem conta ou lista amostras usa
    isto por cima."""
    from app.db.models import AnalysisRename

    out: dict[int, tuple[str, int | None]] = {}
    for r in session.exec(
        select(AnalysisRename)
        .where(AnalysisRename.status == "done", AnalysisRename.new_sample.is_not(None),
               AnalysisRename.history_entry_id.is_not(None))
        .order_by(AnalysisRename.created_at)
    ).all():
        out[r.history_entry_id] = (r.new_sample, r.new_library_sample_id)
    return out


def reconcile_uncertain(session: Session, existing_tokens: set[str], *, job: str | None = None) -> int:
    """Fecha renomeações "uncertain" (o agente não respondeu a tempo) olhando
    a listagem atual da RE7raw-data: se o arquivo novo existe e o antigo
    não, o movimento aconteceu — aplica o resto (PostRun) e marca "done";
    se o antigo continua lá, não aconteceu — marca "failed". Devolve quantas
    fechou.

    `job`: a listagem cobre só aquele job — só dá para concluir algo sobre
    renomeações com origem E destino nele (mudança de job fica para a
    listagem completa, `/postrun/jobs`)."""
    from app.db.models import AnalysisRename, utcnow

    closed = 0
    closed_records = []
    for record in session.exec(select(AnalysisRename).where(AnalysisRename.status == "uncertain")).all():
        if job is not None and not (
            record.old_token.startswith(f"{job}/") and record.new_token.startswith(f"{job}/")
        ):
            continue
        moved = record.new_token in existing_tokens and record.old_token not in existing_tokens
        not_moved = record.old_token in existing_tokens and record.new_token not in existing_tokens
        if moved:
            repoint_postrun(session, record.old_token, record.new_token)
            record.status = "done"
        elif not_moved:
            record.status = "failed"
            record.error = (record.error or "") + " (confirmado depois: o arquivo não foi movido)"
        else:
            continue
        record.completed_at = utcnow()
        session.add(record)
        closed_records.append(record)
        closed += 1
    if closed:
        session.commit()
        from app.modules import re7s_link

        for record in closed_records:  # réplica para a fila do RE7S
            re7s_link.replicate_rename(session, record)
    return closed
