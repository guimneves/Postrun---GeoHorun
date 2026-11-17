"""Aba PostRun (pedido do usuário): lê os `.B00` gravados pelo equipamento
em `RE7S_JOBS_DIR` (sinais brutos de FID/CO/CO2/SO2, ver
`app.modules.postrun_b00`) e deixa o usuário marcar/ajustar regiões sobre
a curva pra calcular a área — sem nenhum cálculo geoquímico (S1/S2/S3/
Tmax/TOC/... continuam sendo trabalho do GeoWorks). Disponível pra
qualquer usuário autenticado (só leitura de dados já gravados pelo
equipamento + um workbench pessoal de regiões, mesmo nível de
Histórico/Pesagem — sem gate de admin)."""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.api.deps import CurrentUser, SessionDep
from app.api.routes_analysis_rename import _agent_error_message, _backup_token, _read_raw, _write_raw
from app.core.action_log import log_action
from app.core.config import settings
from app.db.models import (
    AnalysisRename,
    PostrunAnalysisMeta,
    PostrunB00Cache,
    PostrunCalibration,
    PostrunCurve,
    PostrunDeconvReference,
    PostrunRegion,
)
from app.modules import (
    agent_bridge,
    analysis_rename,
    postrun_b00,
    postrun_calc,
    postrun_calibration,
    postrun_composition,
    postrun_scan,
    postrun_timebase,
    re7s_link,
    standard_ini,
)
from app.modules import b00_sample

router = APIRouter(prefix="/postrun", tags=["postrun"])


@router.get("/standards")
def list_standards(_user: CurrentUser):
    """Catálogo de padrões certificados (do RE7S) — para escolher o padrão na calibração."""
    try:
        return re7s_link.standards()
    except re7s_link.Re7sUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

_STANDARD_INI_FILENAME = "standard.ini"


def _read_standard_ini(session: SessionDep) -> list[standard_ini.InstrumentStandard]:
    """Funciona tanto lendo o disco local (Fase 1) quanto através do
    Agente Horun (Fase 2, `RE7S_AGENT_MODE=true`) — ver
    `app/modules/agent_bridge.py` e `Prompt_refinado.md`, seção 14."""
    if settings.agent_mode:
        try:
            text = agent_bridge.read_text(session, agent_bridge.ROOT_DATA, _STANDARD_INI_FILENAME)
        except agent_bridge.AgentTaskError as exc:
            if agent_bridge.file_not_found(exc):
                return []
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Agente Horun: {exc}") from exc
        return standard_ini.parse(text)
    return standard_ini.read_file(settings.standard_ini_path)


# ---------------------------------------------------------------- schemas

class JobOut(BaseModel):
    name: str
    analyses: int
    # data da análise mais recente, tirada do nome do arquivo
    # ("2026-07-17_IFP160000_1.B00") — sem abrir nenhum .B00
    last_date: str | None = None


class AnalysisSummaryOut(BaseModel):
    token: str
    job: str
    method_folder: str
    filename: str
    sample: str
    cycle_name: str
    quantity_mg: float
    date: datetime | None
    # nome anterior, se a análise foi renomeada pelo Horun (AnalysisRename)
    renamed_from: str | None = None
    # ciclo (método + programa do forno) — curvas de calibração são por ciclo
    cycle_key: str = ""
    cycle_label: str = ""
    # massa usada nos cálculos: a corrigida na tela, senão a do .B00
    mass_mg: float = 0.0
    mass_source: str = "arquivo"  # "arquivo" | "manual"
    # composição (fração por componente, soma 1), do nome ou corrigida na
    # tela — None quando não identificada OU sem a proporção (ver `components`)
    composition: dict[str, float] | None = None
    composition_text: str = ""
    composition_source: str = ""
    # os componentes, também sem a proporção ("PP + PS"): quais picos procurar
    components: list[str] = []
    # "completa" | "sem_proporcao" | "desconhecida" (16/11/2026)
    composition_status: str = "desconhecida"
    # como a composição foi lida, ou por que não deu — aparece na tela
    composition_note: str = ""
    nominal_mass_mg: float | None = None
    # massa que estava no .B00 antes de ser corrigida pela tela (None = nunca mudou)
    file_mass_before_mg: float | None = None
    # massa real de cada polímero pesada na mistura (mg) — a esperada no relatório
    component_masses: dict[str, float] | None = None
    # só na resposta de PUT /analyses/meta: a massa foi salva no Horun, mas o
    # .B00 não pôde ser gravado (ex. Agente com a pasta "jobs" só leitura)
    file_note: str | None = None


class AnalysisMetaIn(BaseModel):
    """Correção feita na tela: `mass_mg` None = volta à massa do arquivo;
    `composition_text` "" = volta à composição lida do nome. O campo que
    não vier fica como estava (editar só a massa não apaga a composição)."""

    token: str
    mass_mg: float | None = None
    composition_text: str | None = None
    # "PEAD 1,012; PS 0,998" (mg); "" = tira
    component_masses_text: str | None = None


class CursorOut(BaseModel):
    values: list[int]
    base: float


class CurveOut(BaseModel):
    idx: list[int]
    temp: list[float]
    channels: dict[str, list[float]]


class AnalysisDetailOut(BaseModel):
    token: str
    sample: str
    method_folder: str
    cycle_name: str
    quantity_mg: float
    date: datetime | None
    cycle_key: str = ""
    cycle_label: str = ""
    # eixo de tempo (ver postrun_timebase): segundos por ponto e aviso
    seconds_per_point: float = 1.0
    timebase_warning: str | None = None
    gas_names: dict[str, str]
    baseline: dict[str, float]
    cursors_auto: dict[str, CursorOut]
    cursors_manu: dict[str, CursorOut]
    pyro: CurveOut | None
    oxi: CurveOut | None


class BatchIn(BaseModel):
    tokens: list[str]


class BatchItemOut(BaseModel):
    token: str
    ok: bool
    error: str | None = None
    data: AnalysisDetailOut | None = None


class SparklineOut(BaseModel):
    """Miniatura do sinal de FID de pirólise pra uma corrida — pedido do
    usuário: bater o olho na lista e descartar rápido as corridas ruins
    (sem sinal, saturadas, pico deslocado) sem abrir uma por uma.
    `values` são ~48 pontos, baseline subtraída, normalizados 0-1 pelo
    próprio máximo da corrida. `channel` é sempre `pyro:FID` nesta
    versão."""

    token: str
    values: list[float] | None = None
    error: str | None = None


class RegionIn(BaseModel):
    token: str
    channel: str  # "pyro:FID" / "oxi:CO2" / etc — ver postrun_b00.CURSOR_SLOTS
    label: str
    start_idx: int
    end_idx: int
    baseline_mode: str = "fixed"
    fixed_baseline: float = 0.0


class RegionUpdateIn(BaseModel):
    label: str | None = None
    start_idx: int | None = None
    end_idx: int | None = None
    baseline_mode: str | None = None
    fixed_baseline: float | None = None


class RegionOut(BaseModel):
    id: int
    token: str
    channel: str
    label: str
    start_idx: int
    end_idx: int
    baseline_mode: str
    fixed_baseline: float
    created_by_id: int
    created_at: datetime
    area: float | None = None
    area_s: float | None = None  # área no tempo (sinal × s)
    seconds_per_point: float | None = None
    # Pedido do usuário: além da área, o valor e a posição do pico dentro
    # da região — útil tanto pra visualizar quanto pra exportar.
    peak_value: float | None = None
    peak_idx: int | None = None
    peak_temp: float | None = None
    area_error: str | None = None
    # Pedido do usuário: valor convertido em mg (e mg/g), quando existe
    # calibração vigente pro canal — ver PostrunCalibration abaixo. Nunca
    # armazenado, sempre recalculado com a calibração mais recente.
    calibrated_mg: float | None = None
    calibrated_mg_per_g: float | None = None


class RegionPreviewIn(BaseModel):
    regions: list[RegionIn]


class RegionPreviewOut(BaseModel):
    """Área/pico de uma região AINDA NÃO SALVA (pedido do usuário,
    16/10/2026: "os resultados só são salvos quando eu clicar em Salvar")
    — mesmo cálculo de `RegionOut`, sem gravar nada."""

    token: str
    channel: str
    area: float | None = None
    # área no tempo (sinal × s) — a das curvas de calibração
    area_s: float | None = None
    seconds_per_point: float | None = None
    peak_value: float | None = None
    peak_idx: int | None = None
    peak_temp: float | None = None
    area_error: str | None = None
    calibrated_mg: float | None = None
    calibrated_mg_per_g: float | None = None


class RegionSaveIn(BaseModel):
    """Botão "Salvar" da aba: grava de uma vez as regiões alteradas
    (uma por análise + canal — se já existe, é atualizada) e apaga as
    marcadas para remoção."""

    upserts: list[RegionIn] = []
    delete_ids: list[int] = []


class ScanIn(BaseModel):
    job: str


class ScanOut(BaseModel):
    job: str
    state: str  # idle | running | done | error
    listing: bool = False  # ainda listando os arquivos no equipamento
    total: int = 0
    read: int = 0
    failed: int = 0
    error: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None


class ApplyRegionIn(BaseModel):
    region_id: int
    target_tokens: list[str]


class CalibrationCandidateOut(BaseModel):
    """Prévia de um ponto de calibração — pedido do usuário: mostrar o que
    resultaria antes de aceitar/rejeitar (igual o fluxo do GeoWorks: cada
    corrida de um padrão STD é revisada manualmente, nunca automática)."""

    token: str
    channel: str
    standard_id: int
    standard_name: str
    start_idx: int  # cursor do próprio GeoWorks pra essa corrida (min/max dos valores válidos)
    end_idx: int
    area: float
    mass_mg: float
    known_mg: float  # parâmetro de massa certificado (pro FID: S2) × massa da corrida
    reference_source: str  # "standard.ini" | "catálogo" — de onde vieram S2/Tmax
    # Tmax só pra conferência (pedido do usuário — opção A): não entra no
    # K1. `tmax_measured` = temperatura no pico do sinal na janela do
    # cursor; `tmax_certified` = valor do standard.ini (ou catálogo).
    tmax_certified: float | None
    tmax_measured: float | None
    suggested_k1: float  # known_mg / area — o K1 resultante em modo ganho puro


class CalibrationPointIn(BaseModel):
    token: str
    standard_id: int


class CalibrationIn(BaseModel):
    channel: str
    mode: str  # "gain" (1 ponto, K0=0) | "linear" (2+ pontos, regressão)
    points: list[CalibrationPointIn]
    name: str = ""
    notes: str = ""
    # False = guarda a calibração sem trocar a vigente (ex. a de um padrão antigo)
    make_active: bool = True


class CalibrationUpdateIn(BaseModel):
    name: str | None = None
    notes: str | None = None
    make_active: bool | None = None


class CalibrationSourcePointOut(BaseModel):
    token: str
    standard_id: int
    standard_name: str
    area: float
    known_mg: float
    mass_mg: float
    # Registrados no histórico só pra auditoria (não entram no ajuste).
    # Default None pra ler registros antigos gravados antes desses campos.
    tmax_certified: float | None = None
    tmax_measured: float | None = None
    # quando o padrão foi rodado (data da corrida no .B00) — pedido do usuário
    run_date: datetime | None = None


class CalibrationOut(BaseModel):
    id: int
    channel: str
    name: str = ""
    notes: str = ""
    # a que vale agora para o canal (a marcada, ou a mais recente)
    is_active: bool = False
    mode: str
    k0: float
    k1: float
    r2: float | None
    source_points: list[CalibrationSourcePointOut]
    # datas das corridas do padrão (a primeira e a última)
    run_date_min: datetime | None = None
    run_date_max: datetime | None = None
    validated_by_id: int
    validated_at: datetime


# ------------------------------------------------------------------ utils

def _resolve_token(token: str) -> Path:
    base = settings.jobs_dir.resolve()
    candidate = (base / token).resolve()
    if base not in candidate.parents:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Caminho inválido")
    if not candidate.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Análise não encontrada")
    return candidate


def _validate_token_shape(token: str) -> None:
    """Confinamento contra path traversal no modo agente — sem disco
    local aqui pra confirmar de verdade (quem faz essa parte é o próprio
    agente, do lado dele — Agent-Horun/agent/tasks.py, `_resolve_safe`),
    mas rejeita de cara qualquer tentativa óbvia de escapar da pasta."""
    parts = PurePosixPath(token).parts
    if not token or token.startswith("/") or ".." in parts:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Caminho inválido")


def _read_agent_b00_text(session: SessionDep, token: str, *, timeout: float | None = None) -> str:
    """Um `.B00` nunca muda depois de pronto — cacheado pra sempre depois
    da primeira leitura via Agente (ver docstring de `PostrunB00Cache`).
    Corrige um bug real: sem isso, listar o PostRun refazia a ida-e-volta
    pelo Agente pra CADA arquivo em TODA visita, o que com dezenas de
    análises reais estourava o timeout fixo de 30s do proxy do Horun
    Core.

    `timeout` (opcional, mais curto que o padrão de
    `RE7S_AGENT_TASK_TIMEOUT`): usado só por quem varre VÁRIOS tokens
    numa mesma requisição (`list_analyses`/`get_sparklines`, abaixo) —
    sem isso, um único arquivo ainda não cacheado e lento pra responder
    consome sozinho o timeout inteiro do proxy do Core (30s fixos, ver
    seção 14.4 do Prompt_refinado.md), derrubando a listagem inteira com
    "Módulo inacessível" mesmo que os outros 53 arquivos já estivessem
    em cache. Estourar esse timeout curto não é tratado como erro (ver
    chamadores) — só significa "tenta nessa próxima visita"."""
    _validate_token_shape(token)

    cached = session.get(PostrunB00Cache, token)
    if cached is not None:
        return cached.content

    try:
        return _fetch_and_cache_b00(session, token, timeout=timeout)
    except agent_bridge.AgentTaskError as exc:
        if agent_bridge.file_not_found(exc):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Análise não encontrada") from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Agente Horun: {exc}") from exc


def _fetch_and_cache_b00(session: Session, token: str, *, timeout: float | None = None) -> str:
    """Lê o `.B00` pelo agente e guarda no cache. `AgentTaskError` propaga
    (quem chama decide: a rota vira 404/502; a leitura em segundo plano
    conta como falha e segue)."""
    text = agent_bridge.read_text(session, agent_bridge.ROOT_JOBS, token, timeout=timeout)
    session.add(PostrunB00Cache(token=token, content=text))
    try:
        session.commit()
    except IntegrityError:
        # Corrida rara (duas requisições concorrentes cacheando o mesmo
        # token pela primeira vez) — quem perdeu não precisa falhar, só
        # devolver o texto que já tem em mãos (idêntico ao que a outra
        # gravou, o arquivo não muda).
        session.rollback()
    return text


def _read_analysis(session: SessionDep, token: str, *, timeout: float | None = None) -> postrun_b00.B00Analysis:
    """Parse completo de um `.B00` — disco local (Fase 1) ou Agente Horun
    (Fase 2, `RE7S_AGENT_MODE=true`). `B00ParseError` propaga pra quem
    chama decidir como reportar (a maioria das rotas usa 422)."""
    if settings.agent_mode:
        return postrun_b00.parse_full(_read_agent_b00_text(session, token, timeout=timeout))
    return postrun_b00.read_full(_resolve_token(token))


def _read_analysis_header(
    session: SessionDep, token: str, *, timeout: float | None = None
) -> postrun_b00.B00Header:
    if settings.agent_mode:
        return postrun_b00.parse_header(_read_agent_b00_text(session, token, timeout=timeout))
    return postrun_b00.read_header(_resolve_token(token))


def _ensure_analysis_exists(session: SessionDep, token: str) -> None:
    """Confere que a análise existe antes de criar/aplicar uma região pra
    ela — 404 cedo em vez de só descobrir na hora de calcular a área."""
    if settings.agent_mode:
        _read_agent_b00_text(session, token)
        return
    _resolve_token(token)


_GLOB_SPECIAL = set("*?[]")


def _validate_job_name(job: str) -> None:
    if not job or job in (".", "..") or "/" in job or "\\" in job or ":" in job:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Job inválido")


def _list_analysis_tokens(
    session: SessionDep, *, job: str | None = None, timeout: float | None = None
) -> list[str]:
    """Caminhos (tokens) dos `.B00`. Com `job`, só os daquele job — o agente
    varre só aquela pasta em vez da RE7raw-data inteira."""
    if job is not None:
        _validate_job_name(job)
    if settings.agent_mode:
        # nome com caractere de glob não pode ir no padrão: lista tudo e filtra
        pattern = f"{job}/**/*.B00" if job and not (_GLOB_SPECIAL & set(job)) else "**/*.B00"
        try:
            tokens = agent_bridge.list_files(session, agent_bridge.ROOT_JOBS, pattern, timeout=timeout)
        except agent_bridge.AgentTaskError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Agente Horun: {exc}") from exc
    else:
        base = settings.jobs_dir.resolve()
        start = base / job if job else base
        if job and not start.is_dir():
            return []
        tokens = [p.resolve().relative_to(base).as_posix() for p in postrun_b00.list_analyses(start)]
    if job is not None:
        tokens = [t for t in tokens if PurePosixPath(t).parts[:1] == (job,)]
    return tokens


_DATE_PREFIX = re.compile(r"^(\d{4}-\d{2}-\d{2})_")


def _jobs_from_tokens(tokens: list[str]) -> list[JobOut]:
    by_job: dict[str, list[str]] = {}
    for token in tokens:
        parts = PurePosixPath(token).parts
        if len(parts) < 2:
            continue  # .B00 solto na raiz da RE7raw-data não pertence a job nenhum
        by_job.setdefault(parts[0], []).append(parts[-1])
    out = []
    for name, files in by_job.items():
        dates = [m.group(1) for f in files if (m := _DATE_PREFIX.match(f))]
        out.append(JobOut(name=name, analyses=len(files), last_date=max(dates) if dates else None))
    # mais recentes primeiro; sem data no nome, por último; empate, alfabética
    out.sort(key=lambda j: j.name.lower())
    out.sort(key=lambda j: j.last_date or "", reverse=True)
    return out


# Bug real de produção corrigido aqui: mesmo com o cache de `.B00`
# (`_read_agent_b00_text`), varrer TODOS os tokens numa única
# requisição não tinha orçamento de tempo nenhum — um único arquivo
# ainda não cacheado (ou lento pra responder) consumia sozinho o
# timeout fixo de 30s do proxy do Horun Core, derrubando a listagem
# inteira com "Módulo inacessível" mesmo que a maioria já estivesse em
# cache. `_AGENT_LIST_TOTAL_BUDGET` é o teto de tempo (com margem sob os
# 30s) pra `list_analyses`/`get_sparklines` inteiras, incluindo a
# listagem de nomes de arquivo; o que não couber no orçamento fica pra
# próxima visita — o cache vai completando aos poucos em vez de tudo ou
# nada. Only ativo em modo agente: no disco local (Fase 1) essas
# operações já são instantâneas, sem nenhum orçamento a respeitar.
_AGENT_LIST_TOTAL_BUDGET = 22.0
_AGENT_LIST_TOKENS_TIMEOUT = 8.0
_AGENT_PER_FILE_TIMEOUT = 5.0
# Lista de jobs: uma listagem só (sem ler .B00) — pode usar quase todo o
# prazo do proxy do Core. Com a rede lenta, 8 s não bastava.
_AGENT_JOBS_TIMEOUT = 20.0
_last_jobs: list[JobOut] | None = None


def _effective_mass(session: SessionDep, token: str, file_mass: float) -> float:
    meta = session.get(PostrunAnalysisMeta, token)
    return meta.mass_mg if meta is not None and meta.mass_mg is not None else file_mass


_known_cache: tuple[float, frozenset[str]] | None = None
_KNOWN_TTL_S = 30.0


def known_materials(session: Session) -> frozenset[str]:
    """Materiais que o PostRun reconhece no nome de um arquivo (16/11/2026):
    os polímeros comuns (`BUILTIN_MATERIALS`) + os que o laboratório já usou
    — nome de referência, componente de curva ou composição informada na
    tela. Informar "PBAT" uma vez faz as corridas "PBAT_1", "PBAT_2"… serem
    lidas sozinhas. Guardado por 30 s; `forget_known_materials` limpa."""
    global _known_cache
    now = time.monotonic()
    if _known_cache is not None and now - _known_cache[0] < _KNOWN_TTL_S:
        return _known_cache[1]
    names: set[str] = set(postrun_composition.BUILTIN_MATERIALS)
    names.update(n.upper() for n in session.exec(select(PostrunDeconvReference.name)).all() if n)
    names.update(n.upper() for n in session.exec(select(PostrunCurve.component)).all() if n)
    for raw in session.exec(select(PostrunAnalysisMeta.composition).where(PostrunAnalysisMeta.composition.is_not(None))).all():
        try:
            names.update(str(k).upper() for k in json.loads(raw or "{}"))
        except (ValueError, TypeError):
            continue
    _known_cache = (now, frozenset(names))
    return _known_cache[1]


def forget_known_materials() -> None:
    global _known_cache
    _known_cache = None


def _apply_meta(session: SessionDep, out: AnalysisSummaryOut, meta: PostrunAnalysisMeta | None) -> AnalysisSummaryOut:
    """Massa e composição efetivas: a correção da tela, senão o arquivo/nome."""
    out.mass_mg = out.quantity_mg
    out.mass_source = "arquivo"
    if meta is not None:
        out.file_mass_before_mg = meta.file_mass_before_mg
        out.component_masses = json.loads(meta.component_masses) if meta.component_masses else None
    if meta is not None and meta.mass_mg is not None:
        out.mass_mg = meta.mass_mg
        out.mass_source = "manual"
    reading = postrun_composition.read_names(out.filename, out.sample, known_materials(session))
    comp = reading.composition
    note = reading.note
    if meta is not None and meta.composition:
        manual = postrun_composition.Composition.from_json_dict(json.loads(meta.composition), "manual")
        manual.nominal_mass_mg = comp.nominal_mass_mg if comp else None
        manual.note = "informada na tela" + ("" if manual.complete else " — sem a proporção")
        comp, note = manual, manual.note
    out.composition_note = note
    if comp is not None:
        out.composition = comp.components if comp.complete else None
        out.components = list(comp.names)
        out.composition_status = "completa" if comp.complete else "sem_proporcao"
        out.composition_text = comp.text
        out.composition_source = comp.source
        out.nominal_mass_mg = comp.nominal_mass_mg
    else:
        out.composition = None
        out.components = []
        out.composition_status = "desconhecida"
        out.composition_text = ""
        out.composition_source = ""
        out.nominal_mass_mg = None
    return out


def _summary(session: SessionDep, token: str, header: postrun_b00.B00Header, renamed_from: str | None = None,
             meta: PostrunAnalysisMeta | None = None) -> AnalysisSummaryOut:
    rel = PurePosixPath(token)
    out = AnalysisSummaryOut(
        token=token, job=rel.parts[0] if rel.parts else "", method_folder=header.method_folder,
        filename=rel.name, sample=header.sample, cycle_name=header.cycle_name,
        quantity_mg=header.quantity_mg, date=header.date, renamed_from=renamed_from,
        cycle_key=header.cycle_key, cycle_label=header.cycle_label,
    )
    return _apply_meta(session, out, meta)


def _to_detail(token: str, a: postrun_b00.B00Analysis) -> AnalysisDetailOut:
    tb = postrun_timebase.time_base(a.pyro, a.header.cycle_pyro)
    return AnalysisDetailOut(
        cycle_key=a.header.cycle_key,
        cycle_label=a.header.cycle_label,
        seconds_per_point=tb.seconds_per_point,
        timebase_warning=tb.warning,
        token=token,
        sample=a.header.sample,
        method_folder=a.header.method_folder,
        cycle_name=a.header.cycle_name,
        quantity_mg=a.header.quantity_mg,
        date=a.header.date,
        gas_names=a.gas_names,
        baseline=a.baseline,
        cursors_auto={k: CursorOut(values=c.values, base=c.base) for k, c in a.cursors_auto.items()},
        cursors_manu={k: CursorOut(values=c.values, base=c.base) for k, c in a.cursors_manu.items()},
        pyro=CurveOut(idx=a.pyro.idx, temp=a.pyro.temp, channels=a.pyro.channels) if a.pyro else None,
        oxi=CurveOut(idx=a.oxi.idx, temp=a.oxi.temp, channels=a.oxi.channels) if a.oxi else None,
    )


@dataclass
class _RegionComputation:
    area: float
    peak_value: float
    peak_idx: int
    peak_temp: float | None
    mass_mg: float
    seconds_per_point: float = 1.0


def _region_computation(session: SessionDep, region: PostrunRegion) -> _RegionComputation:
    analysis = _read_analysis(session, region.token)
    curve_name, channel = region.channel.split(":", 1)
    curve = analysis.pyro if curve_name == "pyro" else analysis.oxi
    if curve is None or channel not in curve.channels:
        raise postrun_calc.RegionError(f"canal {region.channel} não encontrado nessa análise")
    result = postrun_calc.compute_area(
        idx=curve.idx,
        signal=curve.channels[channel],
        start_idx=region.start_idx,
        end_idx=region.end_idx,
        baseline_mode=region.baseline_mode,  # type: ignore[arg-type]
        fixed_baseline=region.fixed_baseline,
    )
    try:
        peak_temp = curve.temp[curve.idx.index(result.peak_idx)]
    except ValueError:
        peak_temp = None
    tb = postrun_timebase.time_base(analysis.pyro, analysis.header.cycle_pyro)
    return _RegionComputation(
        area=result.area, peak_value=result.peak_value, peak_idx=result.peak_idx, peak_temp=peak_temp,
        mass_mg=_effective_mass(session, region.token, analysis.header.quantity_mg),
        seconds_per_point=tb.seconds_per_point,
    )


def _active_calibration(session: SessionDep, channel: str) -> PostrunCalibration | None:
    """A calibração que vale para o canal: a marcada como vigente; sem
    nenhuma marcada (bancos de antes do nome/vigente), a mais recente."""
    query = select(PostrunCalibration).where(PostrunCalibration.channel == channel)
    marked = session.exec(
        query.where(PostrunCalibration.is_active == True).order_by(PostrunCalibration.validated_at.desc())  # noqa: E712
    ).first()
    return marked or session.exec(query.order_by(PostrunCalibration.validated_at.desc())).first()


def _region_out(session: SessionDep, region: PostrunRegion) -> RegionOut:
    v = _region_values(session, region)
    return RegionOut(
        id=region.id, token=region.token, channel=region.channel, label=region.label,
        start_idx=region.start_idx, end_idx=region.end_idx, baseline_mode=region.baseline_mode,
        fixed_baseline=region.fixed_baseline, created_by_id=region.created_by_id,
        created_at=region.created_at, **v.model_dump(exclude={"token", "channel"}),
    )


def _region_values(session: SessionDep, region: PostrunRegion) -> RegionPreviewOut:
    """Área, pico e valor calibrado de uma região — salva ou não (a prévia
    usa um `PostrunRegion` que nunca entra na sessão)."""
    area: float | None = None
    area_s: float | None = None
    seconds_per_point: float | None = None
    peak_value: float | None = None
    peak_idx: int | None = None
    peak_temp: float | None = None
    mass_mg: float | None = None
    area_error: str | None = None
    try:
        computation = _region_computation(session, region)
        area = computation.area
        seconds_per_point = computation.seconds_per_point
        area_s = computation.area * computation.seconds_per_point
        peak_value = computation.peak_value
        peak_idx = computation.peak_idx
        peak_temp = computation.peak_temp
        mass_mg = computation.mass_mg
    except (postrun_calc.RegionError, postrun_b00.B00ParseError, HTTPException) as exc:
        area_error = exc.detail if isinstance(exc, HTTPException) else str(exc)

    calibrated_mg: float | None = None
    calibrated_mg_per_g: float | None = None
    if area is not None and mass_mg:
        calibration = _active_calibration(session, region.channel)
        if calibration is not None:
            calibrated_mg = postrun_calibration.apply_calibration(calibration.k0, calibration.k1, area)
            calibrated_mg_per_g = calibrated_mg / (mass_mg / 1000.0)

    return RegionPreviewOut(
        token=region.token, channel=region.channel, area=area, area_s=area_s,
        seconds_per_point=seconds_per_point, peak_value=peak_value, peak_idx=peak_idx,
        peak_temp=peak_temp, area_error=area_error,
        calibrated_mg=calibrated_mg, calibrated_mg_per_g=calibrated_mg_per_g,
    )


@dataclass
class _StandardReference:
    standard_name: str
    known_mg: float  # parâmetro de massa (pro FID: S2) × massa da corrida
    tmax_certified: float | None
    source: str  # "standard.ini" | "catálogo"


def _reference_for_standard(
    session: SessionDep, standard_id: int, channel: str, mass_mg: float,
) -> _StandardReference:
    """Valor de referência do padrão pra calibrar o canal. Pedido do
    usuário: fonte primária é o `standard.ini` (o mesmo arquivo/valores
    que o equipamento usa pra calibrar o FID — S2 e Tmax por slot), com o
    catálogo de padrões certificados do Horun como reserva quando o
    padrão não está fisicamente carregado num slot."""
    # o catálogo de padrões certificados é do RE7S (rota interna)
    try:
        standard = re7s_link.standard(standard_id)
    except re7s_link.Re7sUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    if standard is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Padrão não encontrado")
    mass_params = postrun_calibration.CHANNEL_MASS_PARAMETERS.get(channel)
    if not mass_params:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Canal {channel} não tem parâmetro de referência configurado pra calibração",
        )
    tmax_param = postrun_calibration.CHANNEL_TMAX_PARAMETER.get(channel)

    # 1) standard.ini (fonte primária) — só o FID usa S2/Tmax de lá, e só
    # se o padrão escolhido bater com o nome de um slot carregado.
    if mass_params == ["S2"]:
        wanted = standard.name.strip().lower()
        for slot in _read_standard_ini(session):
            if slot.loaded and slot.name.strip().lower() == wanted:
                return _StandardReference(
                    standard_name=standard.name,
                    known_mg=slot.s2 * (mass_mg / 1000.0),
                    tmax_certified=slot.tmax or None,
                    source="standard.ini",
                )

    # 2) catálogo de padrões certificados (reserva)
    by_param = dict(standard.reference_values or {})
    missing = [p for p in mass_params if p not in by_param]
    if missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Padrão {standard.name} não está no standard.ini e não tem valor certificado de "
            f"{', '.join(missing)} cadastrado no catálogo",
        )
    total_per_g = sum(by_param[p] for p in mass_params)
    return _StandardReference(
        standard_name=standard.name,
        known_mg=total_per_g * (mass_mg / 1000.0),
        tmax_certified=by_param.get(tmax_param) if tmax_param else None,
        source="catálogo",
    )


@dataclass
class _CalibrationArea:
    area: float
    mass_mg: float
    start_idx: int
    end_idx: int
    peak_temp: float | None  # temperatura no pico do sinal na janela do cursor = Tmax medido
    run_date: datetime | None = None


def _calibration_point_area(session: SessionDep, token: str, channel: str) -> _CalibrationArea:
    """Área bruta de uma corrida candidata a ponto de calibração — usa os
    mesmos cursores que o próprio GeoWorks gravou pra essa corrida
    (`postrun_calibration.pick_bounds`), não uma região desenhada à mão
    (pedido do usuário)."""
    try:
        analysis = _read_analysis(session, token)
    except postrun_b00.B00ParseError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    curve_name, ch = channel.split(":", 1)
    curve = analysis.pyro if curve_name == "pyro" else analysis.oxi
    if curve is None or ch not in curve.channels:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Canal {channel} não encontrado em {token}")
    cursor = analysis.cursors_auto.get(channel)
    if cursor is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{token} não tem cursor do GeoWorks pro canal {channel}")
    bounds = postrun_calibration.pick_bounds(cursor)
    if bounds is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Cursor do GeoWorks em {token} não tem pontos válidos suficientes pro canal {channel}",
        )
    start_idx, end_idx = bounds
    baseline = analysis.baseline.get(channel, 0.0)
    try:
        result = postrun_calc.compute_area(
            idx=curve.idx, signal=curve.channels[ch],
            start_idx=start_idx, end_idx=end_idx,
            baseline_mode="fixed", fixed_baseline=baseline,
        )
    except postrun_calc.RegionError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    try:
        peak_temp = curve.temp[curve.idx.index(result.peak_idx)]
    except ValueError:
        peak_temp = None
    return _CalibrationArea(
        area=result.area, mass_mg=_effective_mass(session, token, analysis.header.quantity_mg),
        start_idx=start_idx, end_idx=end_idx, peak_temp=peak_temp, run_date=analysis.header.date,
    )


def _cached_run_date(session: SessionDep | None, token: str) -> datetime | None:
    """Data da corrida para calibrações gravadas antes do campo `run_date`:
    só pelo cabeçalho já disponível (cache do agente ou disco local), sem
    ir ao equipamento."""
    if session is None:
        return None
    try:
        if settings.agent_mode:
            cached = session.get(PostrunB00Cache, token)
            return postrun_b00.parse_header(cached.content).date if cached else None
        return postrun_b00.read_header(_resolve_token(token)).date
    except (postrun_b00.B00ParseError, HTTPException, OSError):
        return None


def _calibration_out(c: PostrunCalibration, active_id: int | None = None, session: SessionDep | None = None) -> CalibrationOut:
    points = [CalibrationSourcePointOut(**sp) for sp in json.loads(c.source_points)]
    for p in points:
        if p.run_date is None:
            p.run_date = _cached_run_date(session, p.token)
    dates = [p.run_date for p in points if p.run_date is not None]
    return CalibrationOut(
        id=c.id, channel=c.channel, name=c.name, notes=c.notes, is_active=c.id == active_id,
        mode=c.mode, k0=c.k0, k1=c.k1, r2=c.r2,
        source_points=points,
        run_date_min=min(dates) if dates else None,
        run_date_max=max(dates) if dates else None,
        validated_by_id=c.validated_by_id, validated_at=c.validated_at,
    )


# ---------------------------------------------------------------- routes

@router.get("/jobs", response_model=list[JobOut])
def list_jobs(_user: CurrentUser, session: SessionDep):
    """Primeiro passo da aba (pedido do usuário): os jobs, com quantas
    análises cada um tem e a data da mais recente — uma única listagem de
    nomes de arquivo, sem ler nenhum `.B00`. O usuário escolhe o job e só
    então `/analyses?job=...` lê os cabeçalhos daquele job."""
    global _last_jobs
    timeout = _AGENT_JOBS_TIMEOUT if settings.agent_mode else None
    try:
        tokens = _list_analysis_tokens(session, timeout=timeout)
    except HTTPException:
        # rede lenta/agente demorou: devolve a última lista boa (se houver)
        # em vez de deixar a tela sem jobs — "atualizar" tenta de novo
        if settings.agent_mode and _last_jobs is not None:
            return _last_jobs
        raise
    analysis_rename.reconcile_uncertain(session, set(tokens))
    _last_jobs = _jobs_from_tokens(tokens)
    return _last_jobs


@router.get("/analyses", response_model=list[AnalysisSummaryOut])
def list_analyses(user: CurrentUser, session: SessionDep, job: str | None = None):
    """Sem `job`, todas as análises (comportamento antigo); com `job`, só as
    daquele job — o que a aba usa."""
    out: list[AnalysisSummaryOut] = []
    # Leitura em segundo plano do job (POST /postrun/scan): a lista sai só do
    # cache — instantânea — e vai crescendo conforme a leitura avança.
    scan = postrun_scan.get(job) if (settings.agent_mode and job) else None
    cache_only = scan is not None and not scan.stale
    if cache_only:
        deadline: float | None = None
        tokens = list(scan.tokens or [])  # type: ignore[union-attr]
    elif settings.agent_mode:
        deadline = time.monotonic() + _AGENT_LIST_TOTAL_BUDGET
        tokens = _list_analysis_tokens(session, job=job, timeout=_AGENT_LIST_TOKENS_TIMEOUT)
    else:
        deadline = None
        tokens = _list_analysis_tokens(session, job=job)
    # renomeações que o equipamento não confirmou a tempo: a listagem atual
    # diz se o arquivo foi movido ou não (analysis_rename.reconcile_uncertain).
    # Com `job`, a listagem só cobre aquele job — conferir só as dele.
    analysis_rename.reconcile_uncertain(session, set(tokens), job=job)
    renamed_from = {
        r.new_token: r.old_analysis_name
        for r in session.exec(
            select(AnalysisRename).where(AnalysisRename.status == "done").order_by(AnalysisRename.created_at)
        ).all()
    }
    metas = {m.token: m for m in session.exec(select(PostrunAnalysisMeta)).all()}
    for token in tokens:
        if deadline is not None and time.monotonic() >= deadline:
            break  # resto fica pra próxima visita — o cache vai completando aos poucos
        try:
            if cache_only:
                cached = session.get(PostrunB00Cache, token)
                if cached is None:
                    continue  # ainda não lido — a leitura em segundo plano traz
                header = postrun_b00.parse_header(cached.content)
            else:
                header = _read_analysis_header(
                    session, token, timeout=_AGENT_PER_FILE_TIMEOUT if deadline is not None else None
                )
        except (postrun_b00.B00ParseError, HTTPException):
            continue  # arquivo corrompido/incompleto/lento pra responder — pula em vez de derrubar a lista inteira
        out.append(_summary(session, token, header, renamed_from.get(token), metas.get(token)))
    _sync_edited_masses(session, out, metas, user.username)
    out.sort(key=lambda a: (a.date is None, a.date), reverse=True)
    return out


# Massas editadas antes de a tela gravar no .B00 (ou que o arquivo não aceitou
# na hora): ao verificar as análises, o .B00 é atualizado sozinho (pedido do
# usuário, 23/10/2026). Poucas por vez, para a lista não ficar lenta com o
# Agente; uma que falhou só é tentada de novo depois de alguns minutos.
_SYNC_PER_REQUEST = 20
_SYNC_RETRY_S = 600.0
_sync_failed_at: dict[str, float] = {}


def _sync_edited_masses(session: SessionDep, summaries: list[AnalysisSummaryOut], metas: dict[str, PostrunAnalysisMeta],
                        username: str) -> None:
    now = time.monotonic()
    done = 0
    for out in summaries:
        meta = metas.get(out.token)
        if meta is None or meta.mass_mg is None or abs(out.quantity_mg - meta.mass_mg) < 0.0005:
            continue
        if now - _sync_failed_at.get(out.token, -1e9) < _SYNC_RETRY_S:
            continue
        if done >= _SYNC_PER_REQUEST:
            break
        done += 1
        if _write_b00_mass(session, out.token, meta.mass_mg, meta, username):
            _sync_failed_at[out.token] = now
            continue
        _sync_failed_at.pop(out.token, None)
        session.add(meta)
        session.commit()
        out.quantity_mg = meta.mass_mg
        out.file_mass_before_mg = meta.file_mass_before_mg


@router.put("/analyses/meta", response_model=list[AnalysisSummaryOut])
def update_analysis_meta(payload: list[AnalysisMetaIn], session: SessionDep, user: CurrentUser):
    """Corrige a massa e/ou a composição de análises (pedido do usuário,
    16/10/2026: corridas saíram com massa 0 no .B00; misturas sem proporção
    no nome). Devolve o resumo atualizado de cada uma.

    A massa também é gravada no próprio `.B00` (e no `.B00~`), na linha
    `Quant=` (pedido do usuário, 23/10/2026) — a massa que estava lá fica
    guardada (`file_mass_before_mg`) e "vazio" grava de volta essa massa
    original. Se o arquivo não puder ser gravado (Agente só leitura, fora do
    ar), a correção vale no Horun do mesmo jeito e a resposta diz por quê
    (`file_note`)."""
    out: list[AnalysisSummaryOut] = []
    notes: dict[str, str] = {}
    for item in payload:
        _check_region_token(session, item.token)
        if item.mass_mg is not None and not (0 < item.mass_mg < 10000):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Massa inválida em {item.token}: {item.mass_mg}")
        sent = item.model_fields_set
        composition_json: str | None = None
        if "composition_text" in sent and item.composition_text:
            try:
                comp = postrun_composition.parse_text(item.composition_text)
            except postrun_composition.CompositionError as exc:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{item.token}: {exc}") from exc
            composition_json = json.dumps(comp.to_json_dict())
        masses_json: str | None = None
        if "component_masses_text" in sent and item.component_masses_text:
            try:
                masses_json = json.dumps(postrun_composition.parse_masses(item.component_masses_text))
            except postrun_composition.CompositionError as exc:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{item.token}: {exc}") from exc
        meta = session.get(PostrunAnalysisMeta, item.token)
        if meta is None:
            meta = PostrunAnalysisMeta(token=item.token, updated_by_id=user.id)
        if "mass_mg" in sent:
            note = _write_b00_mass(session, item.token, item.mass_mg, meta, user.username)
            if note:
                notes[item.token] = note
            meta.mass_mg = item.mass_mg
        if "composition_text" in sent:
            meta.composition = composition_json
        if "component_masses_text" in sent:
            meta.component_masses = masses_json
        meta.updated_by_id = user.id
        meta.updated_at = datetime.now(timezone.utc)
        if meta.mass_mg is None and meta.composition is None and meta.file_mass_before_mg is None and meta.component_masses is None:
            if session.get(PostrunAnalysisMeta, item.token) is not None:
                session.delete(meta)
        else:
            session.add(meta)
    session.commit()
    forget_known_materials()  # um material novo informado vale já para as outras corridas
    for item in payload:
        try:
            header = _read_analysis_header(session, item.token)
        except (postrun_b00.B00ParseError, HTTPException):
            continue
        summary = _summary(session, item.token, header, None, session.get(PostrunAnalysisMeta, item.token))
        summary.file_note = notes.get(item.token)
        out.append(summary)
    return out


def _write_b00_mass(session: SessionDep, token: str, mass_mg: float | None, meta: PostrunAnalysisMeta, username: str) -> str | None:
    """Grava a massa no `.B00`/`.B00~` (linha `Quant=`). `mass_mg` None =
    volta à massa original do arquivo (se a tela já tinha gravado outra).
    Devolve uma explicação quando o arquivo não pôde ser gravado."""
    target = mass_mg if mass_mg is not None else meta.file_mass_before_mg
    if target is None:
        return None  # "voltar" sem nada gravado antes: o arquivo já tem a massa original
    try:
        content = _read_raw(session, token)
        current = b00_sample.read_quantity(content)
        if abs(current - target) >= 0.0005:
            _write_raw(session, token, b00_sample.with_quantity(content, target))
            backup = _read_raw(session, _backup_token(token), optional=True)
            if backup is not None and b"Quant=" in backup:
                _write_raw(session, _backup_token(token), b00_sample.with_quantity(backup, target))
            cached = session.get(PostrunB00Cache, token)
            if cached is not None:
                # atualiza a cópia em cache (apagar faria a análise sumir da
                # lista, que com o Agente sai só do cache, até a próxima leitura)
                cached.content = re.sub(r"^Quant=[^\r\n]*", f"Quant={target:.3f}", cached.content, count=1, flags=re.M)
                session.add(cached)
            log_action("postrun_mass_b00", user=username, token=token, old_mg=current, new_mg=target)
    except (analysis_rename.RenameError, agent_bridge.AgentTaskError, agent_bridge.AgentTimeoutError, OSError) as exc:
        return f"Massa salva no Horun, mas não gravada no .B00: {_agent_error_message(exc)}"
    if mass_mg is None:
        meta.file_mass_before_mg = None  # o arquivo voltou à massa original
    elif meta.file_mass_before_mg is None:
        meta.file_mass_before_mg = current
    return None


@router.get("/analyses/detail", response_model=AnalysisDetailOut)
def get_analysis_detail(token: str, _user: CurrentUser, session: SessionDep):
    try:
        analysis = _read_analysis(session, token)
    except postrun_b00.B00ParseError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    return _to_detail(token, analysis)


def _agent_budget_deadline() -> float | None:
    """`None` em modo local (Fase 1, sem orçamento nenhum a respeitar —
    disco é instantâneo); em modo agente, o teto de tempo (com margem
    sob os 30s fixos do proxy do Core) pra uma rota inteira que varre
    vários tokens numa só requisição."""
    return time.monotonic() + _AGENT_LIST_TOTAL_BUDGET if settings.agent_mode else None


@router.post("/analyses/batch", response_model=list[BatchItemOut])
def get_analyses_batch(payload: BatchIn, _user: CurrentUser, session: SessionDep):
    out: list[BatchItemOut] = []
    deadline = _agent_budget_deadline()
    for token in payload.tokens:
        if deadline is not None and time.monotonic() >= deadline:
            out.append(BatchItemOut(token=token, ok=False, error="tempo esgotado — tenta de novo em instantes"))
            continue
        try:
            analysis = _read_analysis(
                session, token, timeout=_AGENT_PER_FILE_TIMEOUT if deadline is not None else None
            )
            out.append(BatchItemOut(token=token, ok=True, data=_to_detail(token, analysis)))
        except HTTPException as exc:
            out.append(BatchItemOut(token=token, ok=False, error=str(exc.detail)))
        except postrun_b00.B00ParseError as exc:
            out.append(BatchItemOut(token=token, ok=False, error=str(exc)))
    return out


_SPARKLINE_BUCKETS = 48


def _fid_sparkline(session: SessionDep, token: str, *, timeout: float | None = None) -> SparklineOut:
    try:
        analysis = _read_analysis(session, token, timeout=timeout)
    except (HTTPException, postrun_b00.B00ParseError) as exc:
        return SparklineOut(token=token, error=exc.detail if isinstance(exc, HTTPException) else str(exc))
    curve = analysis.pyro
    if curve is None or "FID" not in curve.channels:
        return SparklineOut(token=token, error="sem curva de FID na pirólise")
    baseline = analysis.baseline.get("pyro:FID", 0.0)
    signal = [max(0.0, v - baseline) for v in curve.channels["FID"]]
    if not signal:
        return SparklineOut(token=token, error="curva de FID vazia")
    n = len(signal)
    buckets: list[float] = []
    for b in range(_SPARKLINE_BUCKETS):
        lo = b * n // _SPARKLINE_BUCKETS
        hi = max(lo + 1, (b + 1) * n // _SPARKLINE_BUCKETS)
        buckets.append(max(signal[lo:hi]))
    peak = max(buckets)
    values = [round(v / peak, 4) for v in buckets] if peak > 0 else [0.0] * _SPARKLINE_BUCKETS
    return SparklineOut(token=token, values=values)


@router.post("/analyses/sparklines", response_model=list[SparklineOut])
def get_sparklines(payload: BatchIn, _user: CurrentUser, session: SessionDep):
    """Miniaturas do FID de pirólise pra uma lista de análises (pedido do
    usuário) — chamado só pras análises visíveis depois do filtro, o
    frontend guarda em cache por token (os `.B00` não mudam)."""
    deadline = _agent_budget_deadline()
    out: list[SparklineOut] = []
    for token in payload.tokens:
        if deadline is not None and time.monotonic() >= deadline:
            out.append(SparklineOut(token=token, error="tempo esgotado — tenta de novo em instantes"))
            continue
        out.append(_fid_sparkline(session, token, timeout=_AGENT_PER_FILE_TIMEOUT if deadline is not None else None))
    return out


@router.get("/regions", response_model=list[RegionOut])
def list_regions(session: SessionDep, _user: CurrentUser, tokens: list[str] = Query(default=[])):
    query = select(PostrunRegion)
    if tokens:
        query = query.where(PostrunRegion.token.in_(tokens))
    regions = session.exec(query).all()
    return [_region_out(session, r) for r in regions]


@router.delete("/regions")
def delete_regions(session: SessionDep, _user: CurrentUser, tokens: list[str] = Query(default=[])):
    """Limpar a tabela resumo (pedido do usuário) — apaga as regiões dos
    tokens informados, ou todas se nenhum token for passado."""
    query = select(PostrunRegion)
    if tokens:
        query = query.where(PostrunRegion.token.in_(tokens))
    regions = session.exec(query).all()
    for r in regions:
        session.delete(r)
    session.commit()
    return {"ok": True, "deleted": len(regions)}


@router.post("/regions", response_model=RegionOut)
def create_region(payload: RegionIn, session: SessionDep, user: CurrentUser):
    _ensure_analysis_exists(session, payload.token)  # 404 cedo se o token não existir
    region = PostrunRegion(
        token=payload.token, channel=payload.channel, label=payload.label,
        start_idx=payload.start_idx, end_idx=payload.end_idx,
        baseline_mode=payload.baseline_mode, fixed_baseline=payload.fixed_baseline,
        created_by_id=user.id,
    )
    session.add(region)
    session.commit()
    session.refresh(region)
    return _region_out(session, region)


@router.patch("/regions/{region_id}", response_model=RegionOut)
def update_region(region_id: int, payload: RegionUpdateIn, session: SessionDep, _user: CurrentUser):
    region = session.get(PostrunRegion, region_id)
    if region is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Região não encontrada")
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(region, key, value)
    session.add(region)
    session.commit()
    session.refresh(region)
    return _region_out(session, region)


@router.delete("/regions/{region_id}")
def delete_region(region_id: int, session: SessionDep, _user: CurrentUser):
    region = session.get(PostrunRegion, region_id)
    if region is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Região não encontrada")
    session.delete(region)
    session.commit()
    return {"ok": True}


def _check_region_token(session: SessionDep, token: str) -> None:
    """Confere o token sem ir ao agente (as análises da tela já foram
    lidas): forma do caminho no modo agente, existência no disco local."""
    if settings.agent_mode:
        _validate_token_shape(token)
    else:
        _resolve_token(token)


@router.post("/regions/preview", response_model=list[RegionPreviewOut])
def preview_regions(payload: RegionPreviewIn, session: SessionDep, _user: CurrentUser):
    """Área/pico de regiões ainda não salvas — a tela mostra o resultado
    enquanto a pessoa ajusta; só o botão "Salvar" grava."""
    out: list[RegionPreviewOut] = []
    for r in payload.regions:
        _check_region_token(session, r.token)
        draft = PostrunRegion(
            token=r.token, channel=r.channel, label=r.label, start_idx=r.start_idx, end_idx=r.end_idx,
            baseline_mode=r.baseline_mode, fixed_baseline=r.fixed_baseline, created_by_id=0,
        )
        out.append(_region_values(session, draft))
    return out


@router.put("/regions/save", response_model=list[RegionOut])
def save_regions(payload: RegionSaveIn, session: SessionDep, user: CurrentUser):
    """Botão "Salvar" (pedido do usuário, 16/10/2026): grava de uma vez
    as regiões alteradas na tela — uma por análise + canal (a que já existe
    é atualizada, nunca duplicada) — e apaga as marcadas para remoção. Tudo
    numa transação só: ou salva tudo, ou nada."""
    for region_id in payload.delete_ids:
        region = session.get(PostrunRegion, region_id)
        if region is not None:
            session.delete(region)
    saved: list[PostrunRegion] = []
    for r in payload.upserts:
        _check_region_token(session, r.token)
        if r.baseline_mode not in ("fixed", "linear"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Baseline inválida: {r.baseline_mode}")
        region = session.exec(
            select(PostrunRegion).where(PostrunRegion.token == r.token, PostrunRegion.channel == r.channel)
        ).first()
        if region is None or region.id in payload.delete_ids:
            region = PostrunRegion(token=r.token, channel=r.channel, created_by_id=user.id, label=r.label)
        region.label = r.label
        region.start_idx = r.start_idx
        region.end_idx = r.end_idx
        region.baseline_mode = r.baseline_mode
        region.fixed_baseline = r.fixed_baseline
        session.add(region)
        saved.append(region)
    session.commit()
    for region in saved:
        session.refresh(region)
    return [_region_out(session, region) for region in saved]


@router.post("/regions/apply", response_model=list[RegionOut])
def apply_region(payload: ApplyRegionIn, session: SessionDep, user: CurrentUser):
    """Replica a definição de uma região (canal, faixa de índice, baseline)
    pra outras análises selecionadas — pedido do usuário: trabalhar várias
    análises ao mesmo tempo sem redesenhar a região em cada uma. Os índices
    são copiados como estão (mesma faixa de varredura); como o `.B00` não
    tem eixo de tempo real, isso é só um ponto de partida — o usuário
    ajusta por análise se o pico não cair exatamente na mesma faixa.

    Idempotente: se o token-alvo já tem uma região nesse canal, ela é
    **atualizada** (não duplicada) — aplicar de novo depois de ajustar a
    origem só sobrescreve, não empilha regiões repetidas (bug reportado
    pelo usuário)."""
    source = session.get(PostrunRegion, payload.region_id)
    if source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Região não encontrada")
    result: list[PostrunRegion] = []
    for token in payload.target_tokens:
        if token == source.token:
            continue  # não faz sentido "aplicar" a região nela mesma
        _ensure_analysis_exists(session, token)
        existing = session.exec(
            select(PostrunRegion).where(
                PostrunRegion.token == token, PostrunRegion.channel == source.channel
            )
        ).first()
        if existing is not None:
            existing.label = source.label
            existing.start_idx = source.start_idx
            existing.end_idx = source.end_idx
            existing.baseline_mode = source.baseline_mode
            existing.fixed_baseline = source.fixed_baseline
            session.add(existing)
            result.append(existing)
        else:
            clone = PostrunRegion(
                token=token, channel=source.channel, label=source.label,
                start_idx=source.start_idx, end_idx=source.end_idx,
                baseline_mode=source.baseline_mode, fixed_baseline=source.fixed_baseline,
                created_by_id=user.id,
            )
            session.add(clone)
            result.append(clone)
    session.commit()
    for r in result:
        session.refresh(r)
    return [_region_out(session, r) for r in result]

# Exportação em CSV é montada no frontend a partir do que já está no
# workspace (curvas + regiões já carregadas via /analyses/batch e
# /regions) — mesmo padrão de `HistoryPage.tsx` (`downloadCsv`), sem
# precisar de uma rota dedicada nem de lidar com resposta não-JSON aqui.


# ---------------------------------------------------------- leitura em segundo plano

# Prazos da leitura em segundo plano — sem o limite de 30 s do proxy do Core
# (não há requisição esperando). Com a rede lenta, o agente leva o tempo
# que precisar; 3 arquivos seguidos sem resposta = agente fora do ar.
_SCAN_LIST_TIMEOUT = 180.0
_SCAN_FILE_TIMEOUT = 120.0
_SCAN_MAX_TIMEOUTS_IN_A_ROW = 3


def _scan_out(job: str, scan: postrun_scan.ScanState | None) -> ScanOut:
    if scan is None:
        return ScanOut(job=job, state="idle")
    return ScanOut(
        job=job, state=scan.state, listing=scan.tokens is None and scan.state == "running",
        total=scan.total, read=scan.read, failed=scan.failed, error=scan.error,
        started_at=scan.started_at, finished_at=scan.finished_at,
    )


def _scan_worker(bind, job: str):
    def work(state: postrun_scan.ScanState) -> None:
        with Session(bind) as session:
            if not settings.agent_mode:
                state.tokens = _list_analysis_tokens(session, job=job)
                state.total = state.read = len(state.tokens)
                return
            pattern = f"{job}/**/*.B00" if not (_GLOB_SPECIAL & set(job)) else "**/*.B00"
            listed = agent_bridge.list_files(session, agent_bridge.ROOT_JOBS, pattern, timeout=_SCAN_LIST_TIMEOUT)
            tokens = [t for t in listed if PurePosixPath(t).parts[:1] == (job,)]
            analysis_rename.reconcile_uncertain(session, set(tokens), job=job)
            state.total = len(tokens)
            pending = []
            for token in tokens:
                if session.get(PostrunB00Cache, token) is not None:
                    state.read += 1
                else:
                    pending.append(token)
            state.tokens = tokens  # a lista já pode ser mostrada (com o que está no cache)
            timeouts_in_a_row = 0
            for _attempt in range(2):  # uma nova tentativa no fim para os que falharam
                retry: list[str] = []
                for token in pending:
                    try:
                        _validate_token_shape(token)
                        _fetch_and_cache_b00(session, token, timeout=_SCAN_FILE_TIMEOUT)
                        state.read += 1
                        timeouts_in_a_row = 0
                    except agent_bridge.AgentTimeoutError:
                        timeouts_in_a_row += 1
                        retry.append(token)
                        if timeouts_in_a_row >= _SCAN_MAX_TIMEOUTS_IN_A_ROW:
                            state.failed = state.total - state.read
                            raise RuntimeError(
                                "o agente parou de responder — confira se está ligado e com rede, "
                                "e toque em Verificar novamente"
                            ) from None
                    except (agent_bridge.AgentTaskError, HTTPException):
                        retry.append(token)
                pending = retry
            state.failed = len(pending)

    return work


@router.post("/scan", response_model=ScanOut)
def start_scan(payload: ScanIn, session: SessionDep, _user: CurrentUser):
    """"Verificar novamente": lista os `.B00` do job e lê em segundo plano
    o que ainda não está no cache. Se já há uma leitura rodando, só devolve
    o progresso dela."""
    _validate_job_name(payload.job)
    scan = postrun_scan.start(
        payload.job, _scan_worker(session.get_bind(), payload.job), background=settings.agent_mode
    )
    return _scan_out(payload.job, scan)


@router.get("/scan", response_model=ScanOut)
def get_scan(job: str, _user: CurrentUser):
    _validate_job_name(job)
    return _scan_out(job, postrun_scan.get(job))


@router.get("/calibration/candidate", response_model=CalibrationCandidateOut)
def get_calibration_candidate(
    token: str, channel: str, standard_id: int, session: SessionDep, _user: CurrentUser,
):
    """Prévia de um ponto de calibração — pedido do usuário: mostra o que
    resultaria (área, mg conhecido, K1) antes de aceitar ou rejeitar,
    igual o fluxo de calibração do GeoWorks."""
    point = _calibration_point_area(session, token, channel)
    ref = _reference_for_standard(session, standard_id, channel, point.mass_mg)
    try:
        _, k1 = postrun_calibration.gain_fit(point.area, ref.known_mg)
    except postrun_calibration.CalibrationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    return CalibrationCandidateOut(
        token=token, channel=channel, standard_id=standard_id, standard_name=ref.standard_name,
        start_idx=point.start_idx, end_idx=point.end_idx, area=point.area,
        mass_mg=point.mass_mg, known_mg=ref.known_mg, reference_source=ref.source,
        tmax_certified=ref.tmax_certified, tmax_measured=point.peak_temp,
        suggested_k1=k1,
    )


@router.post("/calibration", response_model=CalibrationOut)
def create_calibration(payload: CalibrationIn, session: SessionDep, user: CurrentUser):
    """Valida uma calibração nova — pedido do usuário: evento único e
    supervisionado (nunca automático), igual o GeoWorks. Recalcula tudo
    no servidor a partir dos `.B00` (nunca confia em número vindo do
    cliente pra isso)."""
    if payload.mode == "gain":
        if len(payload.points) != 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Modo ganho puro exige exatamente 1 ponto")
    elif payload.mode == "linear":
        if len(payload.points) < 2:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Modo com intercepto exige pelo menos 2 pontos")
    else:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "mode precisa ser 'gain' ou 'linear'")

    source_points: list[CalibrationSourcePointOut] = []
    fit_points: list[tuple[float, float]] = []
    for p in payload.points:
        point = _calibration_point_area(session, p.token, payload.channel)
        ref = _reference_for_standard(session, p.standard_id, payload.channel, point.mass_mg)
        source_points.append(CalibrationSourcePointOut(
            token=p.token, standard_id=p.standard_id, standard_name=ref.standard_name,
            area=point.area, known_mg=ref.known_mg, mass_mg=point.mass_mg,
            tmax_certified=ref.tmax_certified, tmax_measured=point.peak_temp, run_date=point.run_date,
        ))
        fit_points.append((point.area, ref.known_mg))

    try:
        if payload.mode == "gain":
            area, known_mg = fit_points[0]
            k0, k1 = postrun_calibration.gain_fit(area, known_mg)
            r2: float | None = None
        else:
            fit = postrun_calibration.linear_fit(fit_points)
            k0, k1, r2 = fit.k0, fit.k1, fit.r2
    except postrun_calibration.CalibrationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

    if payload.make_active:
        _clear_active(session, payload.channel)
    else:
        # guardar sem trocar: a vigente de agora precisa ficar marcada, senão
        # a nova (mais recente) passaria a valer
        current = _active_calibration(session, payload.channel)
        if current is not None and not current.is_active:
            current.is_active = True
            session.add(current)
    calibration = PostrunCalibration(
        channel=payload.channel, mode=payload.mode, k0=k0, k1=k1, r2=r2,
        source_points=json.dumps([sp.model_dump(mode="json") for sp in source_points]),
        name=payload.name.strip(), notes=payload.notes.strip(), is_active=payload.make_active,
        validated_by_id=user.id,
    )
    session.add(calibration)
    session.commit()
    session.refresh(calibration)
    active = _active_calibration(session, payload.channel)
    return _calibration_out(calibration, active.id if active else None, session)


def _clear_active(session: SessionDep, channel: str) -> None:
    for c in session.exec(
        select(PostrunCalibration).where(PostrunCalibration.channel == channel, PostrunCalibration.is_active == True)  # noqa: E712
    ).all():
        c.is_active = False
        session.add(c)


@router.patch("/calibration/{calibration_id}", response_model=CalibrationOut)
def update_calibration(calibration_id: int, payload: CalibrationUpdateIn, session: SessionDep, _user: CurrentUser):
    """Renomear / anotar uma calibração ou torná-la a vigente do canal (os
    valores K0/K1 nunca mudam — são o que foi validado)."""
    calibration = session.get(PostrunCalibration, calibration_id)
    if calibration is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Calibração não encontrada")
    if payload.name is not None:
        calibration.name = payload.name.strip()
    if payload.notes is not None:
        calibration.notes = payload.notes.strip()
    if payload.make_active:
        _clear_active(session, calibration.channel)
        session.flush()
        calibration.is_active = True
    session.add(calibration)
    session.commit()
    session.refresh(calibration)
    active = _active_calibration(session, calibration.channel)
    return _calibration_out(calibration, active.id if active else None, session)


@router.get("/calibration", response_model=list[CalibrationOut])
def list_calibrations(channel: str, session: SessionDep, _user: CurrentUser):
    """Histórico de calibrações do canal, mais recente primeiro. A vigente
    (`is_active`) é a marcada na tela, ou — sem nenhuma marcada — a mais
    recente; as outras ficam de histórico e podem voltar a valer."""
    query = (
        select(PostrunCalibration)
        .where(PostrunCalibration.channel == channel)
        .order_by(PostrunCalibration.validated_at.desc())
    )
    active = _active_calibration(session, channel)
    return [_calibration_out(c, active.id if active else None, session) for c in session.exec(query).all()]
