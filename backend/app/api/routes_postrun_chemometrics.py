"""PCA e PLS das corridas de um estudo (pedido do usuário, 17/11/2026).

Cada corrida do estudo entra com o sinal da MESMA janela e linha de base da
deconvolução salva (método do estudo; senão o outro; senão a região salva),
interpolado numa grade comum de temperatura — a matriz X. Ver
`app.modules.postrun_chemometrics` para a matemática.

- `/pca`: exploração (todas as corridas, com ou sem composição).
- `/pls`: um modelo PLS1 por material, prevendo a massa (mg) ou a fração (%)
  a partir da curva inteira, com validação cruzada por composição. As
  corridas sem composição completa ficam de fora (listadas).

Nada é gravado.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlmodel import select

from app.api.deps import CurrentUser, SessionDep
from app.api.routes_postrun_curves import _AnalysisInfo, _info
from app.api.routes_postrun_deconv import DeconvSpecIn, _window, saved_row
from app.api.routes_postrun_report import _group_key
from app.api.routes_postrun_study import _get, _ids
from app.db.models import PostrunRegion, PostrunStudy
from app.modules import postrun_chemometrics as chem

router = APIRouter(prefix="/postrun/studies", tags=["postrun"])


class PrepIn(BaseModel):
    normalize: str | None = None  # None = o padrão de cada ferramenta
    derivative: int = 0
    align: bool = False
    t_min: float | None = None
    t_max: float | None = None
    step: float = 1.0
    # só estas corridas do estudo (18/11/2026: "selecionar umas amostras no
    # gráfico e calcular de novo só com elas"); None = todas
    tokens: list[str] | None = None


class PCAIn(PrepIn):
    n_comp: int = 4


class PLSIn(PrepIn):
    target: str = "mass"  # "mass" (mg) | "fraction" (%)
    cv: str = "composicao"  # "composicao" | "corrida"
    max_lv: int = 8
    n_lv: int | None = None


class ChemRunOut(BaseModel):
    token: str
    filename: str
    sample: str
    group: str
    kind: str  # "puro" | "mistura" | "desconhecida"
    composition: dict[str, float] | None = None
    mass_mg: float | None = None
    day: str | None = None
    cycle: str = ""  # nome do ciclo (CyclN)
    method: str = ""  # método (CyclT: BULK ROCK, MULTI-HEATING RATES…)
    tmax_c: float | None = None
    shift_c: float = 0.0


class PrepOut(BaseModel):
    normalize: str
    derivative: int
    align: bool
    t_min: float
    t_max: float
    step: float


class PCAOut(BaseModel):
    prep: PrepOut
    grid: list[float]
    runs: list[ChemRunOut]
    x: list[list[float]]  # X depois do pré-tratamento (n × p)
    mean: list[float]
    explained: list[float]  # fração de cada PC (até 10)
    scores: list[list[float]]  # n × k
    loadings: list[list[float]]  # k × p
    t2: list[float]
    q: list[float]
    t2_limit: float | None = None
    q_limit: float | None = None
    materials: list[str] = []
    errors: list[str] = []


class PLSPredOut(BaseModel):
    token: str
    y: float
    y_cv: float
    y_fit: float
    recovery_cv_pct: float | None = None


class PLSMaterialOut(BaseModel):
    material: str
    n_lv: int
    rmsec: list[float]
    rmsecv: list[float]
    r2_cal: float | None = None
    q2: float | None = None
    b: list[float]
    vip: list[float]
    preds: list[PLSPredOut]
    # √média (recuperação − 100)² das MISTURAS, com as previsões da validação cruzada
    rmse_recovery_mix_pct: float | None = None
    notes: list[str] = []
    error: str | None = None


class PLSOut(BaseModel):
    prep: PrepOut
    target: str
    unit: str
    cv: str
    n_groups: int
    grid: list[float]
    runs: list[ChemRunOut]
    materials: list[PLSMaterialOut]
    excluded: list[str] = []
    errors: list[str] = []


# ------------------------------------------------------------------ dados

def _span(session: SessionDep, s: PostrunStudy, token: str) -> tuple[int, int, str, float]:
    """Janela + linha de base da corrida: a deconvolução salva (método do
    estudo, senão o outro), senão a região salva no canal do estudo."""
    other = "gauss" if s.method == "molde" else "molde"
    row = saved_row(session, token, s.channel, s.method) or saved_row(session, token, s.channel, other)
    if row is not None:
        return row.start_idx, row.end_idx, row.baseline_mode, row.fixed_baseline
    regs = session.exec(
        select(PostrunRegion).where(PostrunRegion.token == token, PostrunRegion.channel == s.channel)
    ).all()
    # várias regiões na corrida (ex.: S1 e S2): a mais larga — a do pico
    # principal; a primeira podia ser o S1, e a faixa comum sumia (18/11/2026)
    reg = max(regs, key=lambda r: r.end_idx - r.start_idx) if regs else None
    if reg is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "sem região nem deconvolução salva no canal do estudo")
    return reg.start_idx, reg.end_idx, reg.baseline_mode, reg.fixed_baseline


def _run_out(info: _AnalysisInfo) -> ChemRunOut:
    sm = info.summary
    comp = sm.composition
    kind = "desconhecida" if not comp else "puro" if len(comp) == 1 else "mistura"
    return ChemRunOut(
        token=sm.token, filename=sm.filename, sample=sm.sample,
        group=_group_key(comp, sm.cycle_key, sm.components), kind=kind, composition=comp,
        mass_mg=sm.mass_mg or None, day=sm.date.date().isoformat() if sm.date else None,
        cycle=sm.cycle_name, method=sm.method_folder,
    )


def _matrix(session: SessionDep, s: PostrunStudy, p: PrepIn, default_norm: str, only_complete: bool = False):
    infos: dict[str, _AnalysisInfo] = {}
    runs: list[ChemRunOut] = []
    curves: list[tuple[np.ndarray, np.ndarray]] = []
    errors: list[str] = []
    excluded: list[str] = []
    study_tokens = _ids(s.tokens)
    if p.tokens is not None:
        wanted = set(p.tokens)
        outside = wanted - set(study_tokens)
        if outside:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"corrida fora do estudo: {sorted(outside)[0]}")
        study_tokens = [t for t in study_tokens if t in wanted]
    for t in study_tokens:
        try:
            info = _info(session, t, infos)
            if only_complete and not info.summary.composition:
                excluded.append(info.summary.filename)
                continue
            a, b, bm, fb = _span(session, s, t)
            spec = DeconvSpecIn(token=t, channel=s.channel, start_idx=a, end_idx=b, baseline_mode=bm, fixed_baseline=fb)
            _xs, y, _t, temps, _tb = _window(info.analysis, spec)
        except HTTPException as exc:
            errors.append(f"{t.rsplit('/', 1)[-1]}: {exc.detail}")
            continue
        temps, y = chem.monotonic(temps, y)
        if len(temps) < 10:
            errors.append(f"{t.rsplit('/', 1)[-1]}: janela curta demais")
            continue
        runs.append(_run_out(info))
        curves.append((temps, y))
    if len(curves) < 3:
        detail = "são precisas pelo menos 3 corridas com região ou deconvolução salva"
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail + (f" ({'; '.join(errors[:3])})" if errors else ""))
    lo, hi = chem.common_range(curves)
    if p.t_min is not None or p.t_max is not None:
        # faixa escolhida na tela: vale como está; fora da janela de uma
        # corrida o sinal (já sem a linha de base) conta como zero
        t_min = p.t_min if p.t_min is not None else min(float(t[0]) for t, _ in curves)
        t_max = p.t_max if p.t_max is not None else max(float(t[-1]) for t, _ in curves)
        short = [r.filename for r, (t, _) in zip(runs, curves) if t[0] > t_min + 1 or t[-1] < t_max - 1]
        if short:
            errors.append(f"{len(short)} corrida(s) com janela menor que a faixa — completadas com zero fora dela: "
                          + ", ".join(short[:5]) + ("…" if len(short) > 5 else ""))
    else:
        t_min, t_max = lo, hi
        if hi - lo < 10 * p.step:
            # explica quem limita a faixa e o que fazer
            i_lo = max(range(len(curves)), key=lambda i: curves[i][0][0])
            i_hi = min(range(len(curves)), key=lambda i: curves[i][0][-1])
            w = lambda i: f"{runs[i].filename} ({curves[i][0][0]:.0f}–{curves[i][0][-1]:.0f} °C)"  # noqa: E731
            raise HTTPException(status.HTTP_400_BAD_REQUEST, (
                f"as janelas das corridas quase não se sobrepõem: a PCA usa a faixa que TODAS cobrem, e aqui ela "
                f"vai de {lo:.0f} a {hi:.0f} °C. Quem limita: {w(i_lo)} começa mais tarde e {w(i_hi)} termina mais "
                "cedo. Confira a região/deconvolução dessas corridas, tire do estudo as que não são do mesmo tipo, "
                "ou informe a faixa (°C) na tela — fora da janela de cada corrida o sinal conta como zero."))
    norm = p.normalize or default_norm
    try:
        grid, X = chem.to_grid(curves, t_min, t_max, p.step, pad_zero=p.t_min is not None or p.t_max is not None)
        masses = np.array([r.mass_mg or np.nan for r in runs], dtype=float)
        Xp, shifts = chem.preprocess(grid, X, masses, chem.Prep(normalize=norm, derivative=p.derivative, align=p.align))
    except chem.ChemometricsError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    for r, row, sh in zip(runs, X, shifts):
        r.tmax_c = chem.tmax_of(grid, row)
        r.shift_c = sh
    prep = PrepOut(normalize=norm, derivative=p.derivative, align=p.align, t_min=float(grid[0]),
                   t_max=float(grid[-1]), step=p.step)
    return prep, grid, Xp, runs, errors, excluded, infos


def _materials(runs: list[ChemRunOut]) -> list[str]:
    return sorted({m for r in runs for m in (r.composition or {})})


def _r(v: np.ndarray, d: int = 6) -> list[float]:
    return [float(round(x, d)) if np.isfinite(x) else 0.0 for x in np.asarray(v, dtype=float)]


# ------------------------------------------------------------------- rotas

@router.post("/{study_id}/pca", response_model=PCAOut)
def study_pca(study_id: int, payload: PCAIn, session: SessionDep, _user: CurrentUser):
    """PCA das curvas do estudo: scores, loadings × temperatura, variância
    explicada, T² e Q (com os limites de 95 %). Padrão: normalizada pela área
    (compara a FORMA, não a quantidade). Nada é gravado."""
    s = _get(session, study_id)
    prep, grid, X, runs, errors, _exc, _infos = _matrix(session, s, payload, "area")
    try:
        res = chem.pca(X, max(1, min(payload.n_comp, 10)))
    except chem.ChemometricsError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    scale = float(np.max(np.abs(X))) or 1.0
    return PCAOut(
        prep=prep, grid=_r(grid, 3), runs=runs,
        x=[_r(row / scale) for row in X], mean=_r(res.mean / scale),
        explained=_r(res.explained[:10]),
        scores=[_r(row) for row in res.scores], loadings=[_r(col) for col in res.loadings.T],
        t2=_r(res.t2), q=_r(res.q), t2_limit=res.t2_limit, q_limit=res.q_limit,
        materials=_materials(runs), errors=errors,
    )


@router.post("/{study_id}/pls", response_model=PLSOut)
def study_pls(study_id: int, payload: PLSIn, session: SessionDep, _user: CurrentUser):
    """Um PLS1 por material: prevê a massa (mg, X sem normalizar — o sinal
    cresce com a massa) ou a fração (%, X normalizada pela área) a partir da
    curva inteira. Validação cruzada por composição (as réplicas saem
    juntas) ou por corrida. Recuperação = previsto (validação cruzada) ÷
    esperado — comparável à da deconvolução. Nada é gravado."""
    if payload.target not in ("mass", "fraction"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "alvo deve ser 'mass' ou 'fraction'")
    if payload.cv not in ("composicao", "corrida"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "validação cruzada deve ser 'composicao' ou 'corrida'")
    s = _get(session, study_id)
    default_norm = "none" if payload.target == "mass" else "area"
    prep, grid, X, runs, errors, excluded, infos = _matrix(session, s, payload, default_norm, only_complete=True)
    mats = _materials(runs)
    if not mats:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "nenhuma corrida do estudo tem composição completa")
    groups = [r.group if payload.cv == "composicao" else r.token for r in runs]
    out: list[PLSMaterialOut] = []
    for mat in mats:
        ys = []
        for r in runs:
            frac = (r.composition or {}).get(mat, 0.0)
            if payload.target == "fraction":
                ys.append(100.0 * frac)
            else:
                real = infos[r.token].summary.component_masses
                ys.append(real.get(mat, 0.0) if real else frac * (r.mass_mg or 0.0))
        y = np.array(ys, dtype=float)
        try:
            cv = chem.pls_cv(X, y, groups, max_lv=max(1, min(payload.max_lv, 15)), n_lv=payload.n_lv)
        except chem.ChemometricsError as exc:
            out.append(PLSMaterialOut(material=mat, n_lv=0, rmsec=[], rmsecv=[], b=[], vip=[], preds=[], error=str(exc)))
            continue
        preds = []
        rec_mix = []
        for r, yi, ycv, yfit in zip(runs, y, cv.cv_pred, cv.fit_pred):
            rec = float(100 * ycv / yi) if yi > 0 else None
            if rec is not None and r.kind == "mistura":
                rec_mix.append(rec - 100)
            preds.append(PLSPredOut(token=r.token, y=float(yi), y_cv=float(ycv), y_fit=float(yfit), recovery_cv_pct=rec))
        out.append(PLSMaterialOut(
            material=mat, n_lv=cv.chosen, rmsec=_r(cv.rmsec), rmsecv=_r(cv.rmsecv), r2_cal=cv.r2_cal, q2=cv.q2,
            b=_r(cv.model.b, 8), vip=_r(chem.vip(cv.model), 4), preds=preds,
            rmse_recovery_mix_pct=float(np.sqrt(np.mean(np.square(rec_mix)))) if rec_mix else None, notes=cv.notes,
        ))
    return PLSOut(
        prep=prep, target=payload.target, unit="mg" if payload.target == "mass" else "%", cv=payload.cv,
        n_groups=len(set(groups)), grid=_r(grid, 3), runs=runs, materials=out, excluded=excluded, errors=errors,
    )


# ---------------------------------------------------------------- classes

class StudyClassIn(BaseModel):
    id: str
    name: str
    color: str = ""


class StudyClassesIO(BaseModel):
    """Classes da PCA (18/11/2026): a pessoa cria classes (ex.: 1, 2, 3 ou
    "cigarro", "charuto") e põe cada corrida numa delas, para ver se os
    agrupamentos da PCA correspondem a elas. Só rótulos: nada é recalculado."""

    classes: list[StudyClassIn] = []
    assign: dict[str, str] = {}  # token -> id da classe


MAX_CLASSES = 20


def _classes_of(s: PostrunStudy) -> StudyClassesIO:
    if not s.classes:
        return StudyClassesIO()
    try:
        return StudyClassesIO.model_validate_json(s.classes)
    except ValueError:
        return StudyClassesIO()


@router.get("/{study_id}/classes", response_model=StudyClassesIO)
def get_classes(study_id: int, session: SessionDep, _user: CurrentUser):
    s = _get(session, study_id)
    out = _classes_of(s)
    tokens = set(_ids(s.tokens))
    # corrida que saiu do estudo não aparece mais
    out.assign = {t: c for t, c in out.assign.items() if t in tokens}
    return out


@router.put("/{study_id}/classes", response_model=StudyClassesIO)
def set_classes(study_id: int, payload: StudyClassesIO, session: SessionDep, _user: CurrentUser):
    """Grava as classes e quem está em cada uma. Vale também em estudo
    finalizado: são rótulos descritivos, não mudam nenhum resultado."""
    s = _get(session, study_id)
    if len(payload.classes) > MAX_CLASSES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"no máximo {MAX_CLASSES} classes")
    ids: set[str] = set()
    names: set[str] = set()
    for c in payload.classes:
        c.id, c.name, c.color = c.id.strip(), c.name.strip(), c.color.strip()
        if not c.id or not c.name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "toda classe precisa de um nome")
        if len(c.name) > 60:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "nome de classe longo demais (máx. 60)")
        if c.id in ids or c.name.lower() in names:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"classe repetida: {c.name}")
        if c.color and not (len(c.color) == 7 and c.color.startswith("#")):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"cor inválida: {c.color}")
        ids.add(c.id)
        names.add(c.name.lower())
    tokens = set(_ids(s.tokens))
    bad = [t for t in payload.assign if t not in tokens]
    if bad:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"corrida fora do estudo: {bad[0]}")
    payload.assign = {t: c for t, c in payload.assign.items() if c in ids}
    s.classes = payload.model_dump_json()
    session.add(s)
    session.commit()
    return payload
