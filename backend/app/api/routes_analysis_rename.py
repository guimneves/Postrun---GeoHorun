"""Renomear nome e/ou job de uma análise já feita — move o `.B00` e o
`.B00~` na RE7raw-data (disco local na Fase 1, Agente Horun na Fase 2).
Regras e porquês em `AnalysisRename` (models.py) e
`app/modules/analysis_rename.py`.

Conflitos com o carrossel, analisados antes de implementar (2026-10-01):
- a sincronização do carrossel (`routes_samples._do_sync`) NÃO lê `.B00` —
  usa TABSAMPLE.txt, file_termine.txt e a cópia interna, sempre pelo nome da
  análise. Por isso esta rota nunca mexe em `Sample`, `SampleHistoryEntry`
  nem na cópia interna: a sincronização continua exatamente igual;
- análise que ainda está no carrossel sem ter sido confirmada como analisada
  é recusada — o `.B00` pode estar sendo gravado agora pelo equipamento;
- o nome novo não pode ser o de nenhuma amostra do carrossel nem de outra
  análise (o equipamento gravaria outro `.B00` com o mesmo nome); e um
  cadastro futuro também não pode reaproveitar um nome renomeado
  (`routes_samples._has_duplicate_analysis_name`)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlmodel import select

from app.api.deps import AdminUser, CurrentUser, SessionDep
from app.core.action_log import log_action
from app.core.config import settings
from app.db.models import AnalysisRename, PostrunB00Cache, utcnow
from app.modules import agent_bridge
from app.modules import analysis_rename as ar
from app.modules import b00_sample
from app.modules import postrun_scan, re7s_link

router = APIRouter(prefix="/postrun", tags=["postrun"])


class RenameIn(BaseModel):
    token: str
    # Um dos dois para o nome (ou nenhum, se só o job muda):
    extra: str | None = None  # acrescenta o extra na convenção AAAA-MM-DD_código_extra_réplica
    analysis_name: str | None = None  # nome completo (nomes fora da convenção)
    job: str | None = None
    dry_run: bool = False  # só valida e devolve o plano, sem mover nada


class RenameOut(BaseModel):
    old_token: str
    new_token: str
    old_analysis_name: str
    new_analysis_name: str
    old_job: str
    new_job: str
    status: str  # "planned" (dry_run) | "done"
    moved: list[str] = []


class MoveBatchIn(BaseModel):
    """Mover várias análises para outro job de uma vez (pedido do usuário,
    2026-10-14: "Postrun mover em lote"). Cada uma passa pelas MESMAS regras
    do mover/renomear individual."""

    tokens: list[str]
    job: str
    dry_run: bool = False


class MoveBatchItemOut(BaseModel):
    token: str
    analysis_name: str
    # "planned" (dry_run, pode mover) | "done" | "failed" | "skipped"
    # (já estava no job, ou não foi tentada porque o equipamento parou de
    # responder no meio do lote)
    status: str
    new_token: str | None = None
    error: str | None = None


class MoveBatchOut(BaseModel):
    job: str
    dry_run: bool
    done: int
    failed: int
    skipped: int
    items: list[MoveBatchItemOut]


class _StopBatch(HTTPException):
    """Erro do equipamento (sem sinal, sem resposta a tempo, agente antigo)
    — vale para as próximas também, então o lote para aqui."""


class RenameInfoOut(BaseModel):
    token: str
    analysis_name: str
    job: str
    follows_convention: bool  # dá para usar "extra" (senão, só nome completo)
    current_extra: str | None  # do histórico, quando a análise veio do Horun
    blocked_reason: str | None  # por que não dá para renomear agora (None = pode)
    renamed_from: str | None


def _history_entry_for(session: SessionDep, token: str, analysis_name: str):
    """Entrada de histórico NO RE7S (id, extra) — pela renomeação anterior
    desta análise, ou pelo nome."""
    previous = session.exec(
        select(AnalysisRename)
        .where(AnalysisRename.new_token == token, AnalysisRename.status == "done")
        .order_by(AnalysisRename.created_at.desc())
    ).first()
    try:
        if previous is not None and previous.history_entry_id is not None:
            return re7s_link.history_entry_by_id(previous.history_entry_id)
        return re7s_link.history_entry_by_name(analysis_name)
    except re7s_link.Re7sUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc


def _blocked_reason(session: SessionDep, token: str, analysis_name: str) -> str | None:
    try:
        waiting = re7s_link.waiting_on_carousel(analysis_name)
    except re7s_link.Re7sUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    if waiting is not None:
        return (
            f"A análise {analysis_name!r} ainda está no carrossel (posição {waiting.crucible}) sem "
            "confirmação de que terminou — sincronize o carrossel depois que ela rodar e tente de novo."
        )
    in_flight = session.exec(
        select(AnalysisRename).where(
            AnalysisRename.status == "uncertain",
            (AnalysisRename.old_token == token) | (AnalysisRename.new_token == token),
        )
    ).first()
    if in_flight is not None:
        return (
            "Há uma renomeação desta análise ainda sem confirmação do equipamento — "
            "abra o PostRun de novo em instantes para ela ser conferida."
        )
    return None


def _name_taken(session: SessionDep, name: str) -> bool:
    try:
        if re7s_link.name_taken_in_queue(name):  # amostra ativa, analisada ou no histórico do RE7S
            return True
    except re7s_link.Re7sUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    return session.exec(
        select(AnalysisRename).where(
            AnalysisRename.new_analysis_name == name, AnalysisRename.status.in_(["done", "uncertain"])
        )
    ).first() is not None


def _renamed_from(session: SessionDep, token: str) -> str | None:
    record = session.exec(
        select(AnalysisRename)
        .where(AnalysisRename.new_token == token, AnalysisRename.status == "done")
        .order_by(AnalysisRename.created_at.desc())
    ).first()
    return record.old_analysis_name if record else None


@router.get("/analyses/rename-info", response_model=RenameInfoOut)
def rename_info(token: str, _user: CurrentUser, session: SessionDep):
    try:
        current = ar.split_token(token)
    except ar.RenameError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    history = _history_entry_for(session, token, current.name)
    return RenameInfoOut(
        token=token,
        analysis_name=current.name,
        job=current.job,
        follows_convention=ar.follows_convention(current.name),
        current_extra=(history.extra or None) if history is not None else None,
        blocked_reason=_blocked_reason(session, token, current.name),
        renamed_from=_renamed_from(session, token),
    )


@router.post("/analyses/rename", response_model=RenameOut)
def rename_analysis(payload: RenameIn, user: AdminUser, session: SessionDep):
    out = _rename(payload, user, session)
    if out.status == "done":
        postrun_scan.invalidate_all()  # listas do PostRun guardadas não valem mais
    return out


def _rename(payload: RenameIn, user, session: SessionDep) -> RenameOut:
    """Renomear/mover UMA análise — usado pela rota individual e, uma por
    uma, pelo mover em lote. Erros saem como HTTPException (o lote as
    transforma em erro por análise)."""
    try:
        current = ar.split_token(payload.token)
        if payload.analysis_name is not None and payload.analysis_name.strip():
            new_name: str | None = payload.analysis_name
        elif payload.extra is not None and payload.extra.strip():
            new_name = ar.name_with_extra(current.name, payload.extra)
        else:
            new_name = None
        new_job = payload.job if payload.job is not None and payload.job.strip() else None
        target, moves = ar.plan(current, new_name=new_name, new_job=new_job)
    except ar.RenameError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    reason = _blocked_reason(session, payload.token, current.name)
    if reason is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, reason)
    if target.name != current.name and _name_taken(session, target.name):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Já existe uma amostra ou análise com o nome {target.name!r} — escolha outro extra/nome.",
        )

    out = RenameOut(
        old_token=current.token, new_token=target.token,
        old_analysis_name=current.name, new_analysis_name=target.name,
        old_job=current.job, new_job=target.job, status="planned",
    )
    if payload.dry_run:
        return out

    history = _history_entry_for(session, current.token, current.name)
    record = AnalysisRename(
        old_token=current.token, new_token=target.token,
        old_analysis_name=current.name, new_analysis_name=target.name,
        old_job=current.job, new_job=target.job,
        history_entry_id=history.id if history is not None else None,
        renamed_by_id=user.id,
    )

    try:
        if settings.agent_mode:
            moved = agent_bridge.move_files(session, agent_bridge.ROOT_JOBS, moves)
        else:
            moved = ar.execute_local(settings.jobs_dir, moves)
    except agent_bridge.AgentTimeoutError as exc:
        # Pode ter acontecido ou não (o agente pode ter pegado a tarefa a
        # tempo e terminado depois do prazo). A próxima listagem do PostRun
        # confere no disco e fecha o registro.
        record.status = "uncertain"
        record.error = str(exc)
        session.add(record)
        session.commit()
        re7s_link.replicate_rename(session, record)
        log_action("analysis_rename_uncertain", user=user.username, old=current.token, new=target.token)
        raise _StopBatch(
            status.HTTP_504_GATEWAY_TIMEOUT,
            "O equipamento não confirmou a renomeação a tempo. Abra o PostRun de novo em instantes: "
            "ele confere se os arquivos foram movidos e atualiza sozinho.",
        ) from exc
    except (ar.RenameError, agent_bridge.AgentTaskError) as exc:
        log_action("analysis_rename_failed", user=user.username, old=current.token, new=target.token, error=str(exc))
        error_class = (
            _StopBatch
            if isinstance(exc, (agent_bridge.AgentOfflineError, agent_bridge.AgentTooOldError))
            else HTTPException
        )
        raise error_class(status.HTTP_409_CONFLICT, f"Nada foi alterado: {exc}") from exc

    ar.repoint_postrun(session, current.token, target.token)
    record.status = "done"
    record.completed_at = utcnow()
    session.add(record)
    session.commit()
    re7s_link.replicate_rename(session, record)  # réplica para a fila do RE7S
    log_action("analysis_rename", user=user.username, old=current.token, new=target.token, moved=moved)
    return out.model_copy(update={"status": "done", "moved": moved})


MOVE_BATCH_MAX = 500


@router.post("/analyses/move-batch", response_model=MoveBatchOut)
def move_batch(payload: MoveBatchIn, user: AdminUser, session: SessionDep):
    """Move várias análises (`.B00` + `.B00~`) para o job `payload.job`, uma
    por uma, com as mesmas regras e permissões do mover individual (só
    admin, recusa se ainda está no carrossel, nunca sobrescreve...).

    Não é "tudo ou nada": cada análise movida fica movida (o registro
    `AnalysisRename` e o PostRun dela são atualizados na hora), e a resposta
    diz, análise por análise, o que aconteceu. Se o equipamento parar de
    responder no meio, o lote para e as que faltavam voltam como "skipped"
    (não tentadas) — tentar de novo depois só move as que ficaram."""
    try:
        job = ar.validate_component(payload.job, "Job")
    except ar.RenameError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    tokens = list(dict.fromkeys(t for t in payload.tokens if t))  # sem repetidas, na ordem
    if not tokens:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Selecione ao menos uma análise.")
    if len(tokens) > MOVE_BATCH_MAX:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"No máximo {MOVE_BATCH_MAX} análises por vez — mova em partes.",
        )

    items: list[MoveBatchItemOut] = []
    targets: dict[str, str] = {}  # destino -> origem, para pegar colisão dentro do próprio lote
    stopped: str | None = None
    for token in tokens:
        try:
            name = ar.split_token(token).name
        except ar.RenameError as exc:
            items.append(MoveBatchItemOut(token=token, analysis_name=token, status="failed", error=str(exc)))
            continue
        if stopped is not None:
            items.append(MoveBatchItemOut(
                token=token, analysis_name=name, status="skipped", error=f"Não tentada: {stopped}",
            ))
            continue
        if ar.split_token(token).job == job:
            items.append(MoveBatchItemOut(
                token=token, analysis_name=name, status="skipped", new_token=token,
                error=f"Já está no job {job!r}.",
            ))
            continue
        target = ar.AnalysisPath(job=job, method_dirs=ar.split_token(token).method_dirs, name=name).token
        if target in targets:
            items.append(MoveBatchItemOut(
                token=token, analysis_name=name, status="failed",
                error=f"Outra análise do lote ({targets[target]}) vai para o mesmo lugar: {target}",
            ))
            continue
        try:
            out = _rename(RenameIn(token=token, job=job, dry_run=payload.dry_run), user, session)
        except _StopBatch as exc:
            stopped = str(exc.detail)
            items.append(MoveBatchItemOut(token=token, analysis_name=name, status="failed", error=stopped))
            continue
        except HTTPException as exc:
            items.append(MoveBatchItemOut(token=token, analysis_name=name, status="failed", error=str(exc.detail)))
            continue
        targets[out.new_token] = token
        items.append(MoveBatchItemOut(token=token, analysis_name=name, status=out.status, new_token=out.new_token))

    counts = {k: sum(1 for i in items if i.status == k) for k in ("done", "failed", "skipped")}
    if not payload.dry_run:
        log_action("analysis_move_batch", user=user.username, job=job, **counts)
        if counts["done"]:
            postrun_scan.invalidate_all()  # listas do PostRun guardadas não valem mais
    return MoveBatchOut(job=job, dry_run=payload.dry_run, items=items, **counts)



# ---------------------------------------------------------------- trocar a amostra
# Pedido do usuário (2026-10-20): "A pessoa cadastrou uma amostra na
# biblioteca com o nome errado, foi para o B00 errado" — troca a amostra
# (só por uma da biblioteca) em várias análises de uma vez, sobretudo as
# réplicas. Regras em `app/modules/b00_sample.py`.

CHANGE_SAMPLE_MAX = 200


class ChangeSampleIn(BaseModel):
    tokens: list[str]
    library_sample_id: int
    dry_run: bool = False


class ChangeSampleItemOut(BaseModel):
    token: str
    analysis_name: str
    old_sample: str | None = None
    new_analysis_name: str | None = None
    new_token: str | None = None
    # "planned" (prévia) | "done" | "failed" | "skipped"
    status: str
    renumbered: bool = False  # a réplica mudou (o nome com a réplica antiga já existia)
    error: str | None = None


class ChangeSampleOut(BaseModel):
    library_sample_id: int
    code: str
    name: str
    dry_run: bool
    done: int
    failed: int
    skipped: int
    items: list[ChangeSampleItemOut]


def _backup_token(token: str) -> str:
    return token[: -len(ar.B00_SUFFIX)] + ar.BACKUP_SUFFIX


def _read_raw(session: SessionDep, token: str, *, optional: bool = False) -> bytes | None:
    if settings.agent_mode:
        try:
            return agent_bridge.read_bytes(session, agent_bridge.ROOT_JOBS, token)
        except agent_bridge.AgentTaskError as exc:
            if optional and agent_bridge.file_not_found(exc):
                return None
            raise
    path = (settings.jobs_dir / token).resolve()
    if settings.jobs_dir.resolve() not in path.parents:
        raise ar.RenameError("Caminho inválido.")
    if not path.is_file():
        if optional:
            return None
        raise ar.RenameError(f"Arquivo não encontrado: {token}")
    return path.read_bytes()


def _write_raw(session: SessionDep, token: str, content: bytes) -> None:
    if settings.agent_mode:
        agent_bridge.write_bytes(session, agent_bridge.ROOT_JOBS, token, content)
        return
    path = (settings.jobs_dir / token).resolve()
    if settings.jobs_dir.resolve() not in path.parents:
        raise ar.RenameError("Caminho inválido.")
    tmp = path.with_name(path.name + ".horun-tmp")
    tmp.write_bytes(content)
    tmp.replace(path)  # atômico: nunca fica meio arquivo


def _agent_error_message(exc: Exception) -> str:
    if isinstance(exc, agent_bridge.AgentTaskError) and exc.code == "read_only":
        return (
            "O Agente Horun do equipamento só pode mover arquivos da RE7raw-data, não alterar o conteúdo — "
            'no config.json do agente, mude o "mode" da pasta "jobs" para "read-write" e reinicie o agente.'
        )
    return str(exc)


@router.post("/analyses/change-sample", response_model=ChangeSampleOut)
def change_sample(payload: ChangeSampleIn, user: AdminUser, session: SessionDep):
    """Troca a amostra de várias análises: `Sample=` dentro do `.B00` (e do
    `.B00~`) e o código no nome do arquivo. Primeiro grava o conteúdo (se o
    equipamento recusar, nada muda), depois renomeia (mesmas regras do
    renomear). Refazer é seguro: o que já estiver certo é pulado."""
    try:
        lib = re7s_link.library_sample(payload.library_sample_id)
    except re7s_link.Re7sUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    if lib is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Amostra não encontrada na biblioteca")
    code = lib.code
    tokens = list(dict.fromkeys(t for t in payload.tokens if t))
    if not tokens:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Selecione ao menos uma análise.")
    if len(tokens) > CHANGE_SAMPLE_MAX:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"No máximo {CHANGE_SAMPLE_MAX} análises por vez.")

    def order(t: str):
        try:
            name = ar.split_token(t).name
        except ar.RenameError:
            return (t, 0)
        m = b00_sample._CONVENTION.match(name)
        return (m.group(1) + m.group(2), int(m.group(3))) if m else (name, 0)

    items: list[ChangeSampleItemOut] = []
    reserved: set[str] = set()  # nomes já tomados por outra análise deste lote
    stopped: str | None = None
    for token in sorted(tokens, key=order):  # réplicas em ordem: _1, _2, _3
        try:
            current = ar.split_token(token)
        except ar.RenameError as exc:
            items.append(ChangeSampleItemOut(token=token, analysis_name=token, status="failed", error=str(exc)))
            continue
        item = ChangeSampleItemOut(token=token, analysis_name=current.name, status="failed")
        items.append(item)
        if stopped is not None:
            item.status, item.error = "skipped", f"Não tentada: {stopped}"
            continue
        reason = _blocked_reason(session, token, current.name)
        if reason is not None:
            item.error = reason
            continue
        try:
            content = _read_raw(session, token)
            old_sample = b00_sample.read_sample(content)
            item.old_sample = old_sample
            try:
                date, tail, replica = b00_sample.split_name(current.name, old_sample)
            except ar.RenameError:
                # o conteúdo já foi trocado numa tentativa anterior e o nome não
                date, tail, replica = b00_sample.split_name(current.name, code) if old_sample == code else \
                    b00_sample.split_name(current.name, old_sample)
            new_name = b00_sample.build_name(date, code, tail, replica)
            if new_name != current.name:
                while _name_taken(session, new_name) or new_name in reserved:
                    replica += 1
                    item.renumbered = True
                    if replica > b00_sample.MAX_REPLICA:
                        raise ar.RenameError("Não há réplica livre para o nome novo.")
                    new_name = b00_sample.build_name(date, code, tail, replica)
            new_name = ar.validate_component(new_name, "Nome da análise")
        except agent_bridge.AgentTimeoutError as exc:
            stopped = str(exc)
            item.error = stopped
            continue
        except (ar.RenameError, agent_bridge.AgentTaskError) as exc:
            item.error = str(exc)
            if isinstance(exc, (agent_bridge.AgentOfflineError, agent_bridge.AgentTooOldError)):
                stopped = str(exc)
            continue
        target = ar.AnalysisPath(job=current.job, method_dirs=current.method_dirs, name=new_name)
        item.new_analysis_name, item.new_token = new_name, target.token
        if old_sample == code and new_name == current.name:
            item.status, item.error = "skipped", "Já está com esta amostra."
            continue
        reserved.add(new_name)
        if payload.dry_run:
            item.status = "planned"
            continue

        # 1) conteúdo (antes de mover: se o equipamento recusar, nada mudou)
        try:
            if old_sample != code:
                _write_raw(session, token, b00_sample.with_sample(content, code))
                backup = _read_raw(session, _backup_token(token), optional=True)
                if backup is not None and b"Sample=" in backup:
                    _write_raw(session, _backup_token(token), b00_sample.with_sample(backup, code))
        except agent_bridge.AgentTimeoutError as exc:
            stopped = "o equipamento não respondeu a tempo — refaça (o que já estiver certo é pulado)"
            item.error = f"{stopped}: {exc}"
            continue
        except (ar.RenameError, agent_bridge.AgentTaskError, OSError) as exc:
            item.error = f"Nada foi alterado: {_agent_error_message(exc)}"
            if isinstance(exc, (agent_bridge.AgentOfflineError, agent_bridge.AgentTooOldError)) or (
                isinstance(exc, agent_bridge.AgentTaskError) and exc.code == "read_only"
            ):
                stopped = _agent_error_message(exc)
            continue

        # 2) nome do arquivo (mesmas regras do renomear)
        history = _history_entry_for(session, token, current.name)
        try:
            if new_name != current.name:
                _rename(RenameIn(token=token, analysis_name=new_name), user, session)
                record = session.exec(
                    select(AnalysisRename)
                    .where(AnalysisRename.new_token == target.token, AnalysisRename.status == "done")
                    .order_by(AnalysisRename.created_at.desc())
                ).first()
            else:
                record = AnalysisRename(
                    old_token=token, new_token=token, old_analysis_name=current.name, new_analysis_name=current.name,
                    old_job=current.job, new_job=current.job, history_entry_id=history.id if history else None,
                    renamed_by_id=user.id, status="done", completed_at=utcnow(),
                )
        except _StopBatch as exc:
            stopped = str(exc.detail)
            item.error = f"A amostra dentro do arquivo já foi trocada, mas o nome não: {stopped}"
            continue
        except HTTPException as exc:
            item.error = f"A amostra dentro do arquivo já foi trocada, mas o nome não: {exc.detail} — refaça."
            continue
        if record is not None:
            record.old_sample, record.new_sample, record.new_library_sample_id = old_sample, code, lib.id
            session.add(record)
        cached = session.get(PostrunB00Cache, target.token)
        if cached is not None:
            session.delete(cached)  # o conteúdo mudou: relê na próxima vez
        session.commit()
        if record is not None:
            re7s_link.replicate_rename(session, record)
        item.status = "done"
        log_action("analysis_change_sample", user=user.username, old=token, new=target.token,
                   old_sample=old_sample, new_sample=code)

    counts = {k: sum(1 for i in items if i.status == k) for k in ("done", "failed", "skipped")}
    if not payload.dry_run and counts["done"]:
        postrun_scan.invalidate_all()
    return ChangeSampleOut(library_sample_id=lib.id, code=code, name=lib.name, dry_run=payload.dry_run,
                           items=items, **counts)
