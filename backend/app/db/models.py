"""Tabelas do PostRun · GeoHorun.

As tabelas `Postrun*` e `AnalysisRename` vieram do RE7S (13/11/2026) com os
MESMOS nomes e colunas — é o que deixa a migração dos dados do Postgres do
RE7S ser uma cópia direta (`app/scripts/migrar_do_re7s.py`). As tabelas comuns de
todo PostRun (`postrun_file`, `postrun_run`...) ficam em `app/postrun_core`.

`User`: cópia local de quem entrou pelo Core (id do Core + nome), só para as
colunas `*_by_id` continuarem chaves estrangeiras como no RE7S; o papel vem
do cargo no Core a cada pedido (app/api/deps.py).
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(dt: datetime | None) -> datetime | None:
    """SQLite descarta o tzinfo ao ler de volta um datetime (mesmo os
    salvos com `utcnow()`/`datetime.now(timezone.utc)`, sempre UTC, voltam
    "naive"). Sem isso, o JSON serializado não tem sufixo de fuso e o
    frontend (`new Date(iso)`) interpreta a string como hora LOCAL em vez
    de UTC — mostrando um horário 3h adiantado em relação à hora real de
    Brasília (bug real reportado pelo usuário no Histórico). Reanexa
    tzinfo=UTC antes de qualquer resposta da API sair pro frontend."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


class Role(str, Enum):
    USER = "user"
    ADMIN = "admin"


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    core_user_id: str = Field(index=True, unique=True)
    username: str = Field(index=True)
    role: Role = Field(default=Role.USER)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class PostrunRegion(SQLModel, table=True):
    """Região/cursor definida pelo usuário sobre um sinal bruto do `.B00`,
    aba PostRun (pedido do usuário) — persistida pra não perder o trabalho
    a cada reload. Não guarda nenhum índice geoquímico, só a definição da
    região (o cálculo de área é sempre refeito na hora, a partir da curva
    lida do `.B00` — ver `app.modules.postrun_calc`).

    `token` é o caminho relativo do `.B00` dentro de `RE7S_JOBS_DIR`
    (mesmo esquema de resolução segura contra path traversal usado em
    `routes_weighing.py`). `channel` é `"pyro:FID"`/`"oxi:CO2"`/etc (ver
    `postrun_b00.CURSOR_SLOTS`)."""

    id: Optional[int] = Field(default=None, primary_key=True)
    token: str = Field(index=True)
    channel: str
    label: str
    start_idx: int
    end_idx: int
    baseline_mode: str = "fixed"  # "fixed" | "linear" — ver postrun_calc.BaselineMode
    fixed_baseline: float = 0.0

    created_by_id: int = Field(foreign_key="user.id")
    created_at: datetime = Field(default_factory=utcnow)


class PostrunCalibration(SQLModel, table=True):
    """Calibração de área bruta -> mg, por canal (aba PostRun, pedido do
    usuário) — igual o fluxo do GeoWorks: cada corrida de um padrão STD é
    um evento único que o usuário valida (ou rejeita) manualmente, nunca
    automático (podem ter vindo de um problema no equipamento). A mais
    recente validada (`validated_at`) é a vigente pro canal; as
    anteriores ficam de histórico/auditoria — mesmo espírito de
    `CalibrationReset` acima.

    `mode="gain"`: 1 ponto, `k0` sempre 0 (mesma "Gain law" que todo
    `.B00` real grava). `mode="linear"`: 2+ pontos, regressão de verdade
    (`r2` preenchido). `source_points` guarda o que exatamente entrou no
    ajuste (token do `.B00`, padrão usado, área/mg calculados na hora),
    pra auditoria sem precisar reabrir os arquivos depois."""

    id: Optional[int] = Field(default=None, primary_key=True)
    channel: str = Field(index=True)
    mode: str  # "gain" | "linear"
    k0: float
    k1: float
    r2: Optional[float] = None
    source_points: str  # JSON: [{"token", "standard_id", "area", "known_mg", "mass_mg"}, ...]
    # Pedido do usuário (16/10/2026): dar nome à calibração (ex. "IFP160000 —
    # agosto/2026") e escolher qual vale — registrar uma calibração antiga não
    # precisa substituir a vigente. Sem nenhuma marcada, vale a mais recente.
    name: str = ""
    notes: str = ""
    is_active: bool = False

    validated_by_id: int = Field(foreign_key="user.id")
    validated_at: datetime = Field(default_factory=utcnow, index=True)


class PostrunAnalysisMeta(SQLModel, table=True):
    """Correções de uma análise do PostRun feitas na tela (pedido do
    usuário, 16/10/2026): a massa (corridas reais saíram com `Quant=0` no
    `.B00`) e a composição, quando o nome não diz (ex. "PP+PS" sem
    proporção). Vazio = vale o que vem do arquivo/nome
    (`app.modules.postrun_composition`). Acompanha renomear/mover
    (`analysis_rename.repoint_postrun`)."""

    token: str = Field(primary_key=True)
    mass_mg: Optional[float] = None
    composition: Optional[str] = None  # JSON {"PEAD": 0.5, "PS": 0.5}
    # massa que estava no .B00 antes de a tela gravar outra por cima
    # (2026-10-23: editar a massa grava `Quant=` no arquivo) — para "voltar"
    file_mass_before_mg: Optional[float] = None
    # massa REAL de cada polímero pesada na mistura (mg), JSON {"PEAD": 1.012,
    # "PS": 0.998} — a esperada de cada componente passa a ser esta (24/10/2026);
    # a composição nominal (do nome) continua agrupando as réplicas
    component_masses: Optional[str] = None

    updated_by_id: int = Field(foreign_key="user.id")
    updated_at: datetime = Field(default_factory=utcnow)


class PostrunCurve(SQLModel, table=True):
    """Curva de calibração massa × área do PostRun (pedido do usuário,
    16/10/2026) — para quantificar a massa (da amostra ou de um componente)
    a partir da área de um pirograma. Sempre de um canal e de UM ciclo
    (`cycle_key`: método + ciclo + programa do forno — rampas diferentes
    mudam o rendimento da pirólise). A área é a do tempo (sinal × s).

    `points` guarda o que entrou no ajuste (análise, região, massa, área
    calculada na hora de salvar), para auditoria sem reabrir os arquivos;
    `fit` guarda os coeficientes, a covariância e as estatísticas."""

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    channel: str = Field(index=True)
    cycle_key: str = Field(index=True)
    cycle_label: str = ""
    x_kind: str = "sample_mass"  # "sample_mass" | "component_mass"
    component: str = ""  # com x_kind="component_mass"
    area_source: str = "region"  # "region" | "gaussian" (deconvolução)
    # com area_source="gaussian": de qual deconvolução salva vem a área —
    # "gauss" (livre/guiada) ou "molde" (pedido do usuário, 17/10/2026)
    deconv_method: str = "gauss"
    model: str = "linear"  # ver postrun_regression.MODELS
    weighting: str = "none"  # ver postrun_regression.WEIGHTINGS
    points: str  # JSON
    fit: str  # JSON
    notes: str = ""
    # F2: brancos de matriz e limites (LoB/LoD/LoQ, LD/LQ da curva, em mg e
    # ppm) — entradas e resultado, JSON; vazio = ainda não calculados.
    # Coluna nova (não existe no RE7S): app/db/session.py garante nos bancos antigos.
    limits: str = ""

    created_by_id: int = Field(foreign_key="user.id")
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class PostrunDeconvolution(SQLModel, table=True):
    """Deconvolução salva de uma análise + canal do PostRun (pedido do
    usuário, 16/10/2026) — os picos viram "amostras virtuais" com área
    própria, que entram nas curvas de calibração e no quantificador. Uma por
    análise + canal; gravada só no botão Salvar, como as regiões.

    Guarda as escolhas (janela, linha de base, forma, modo livre/guiado,
    referências e tolerâncias) e o resultado (`result`, JSON: parâmetros e
    área de cada pico, R², BIC, avisos) — as curvas ajustadas são refeitas
    a partir dos parâmetros, sem reajustar. Ver `app.modules.postrun_deconv`."""

    id: Optional[int] = Field(default=None, primary_key=True)
    token: str = Field(index=True)
    channel: str
    start_idx: int
    end_idx: int
    baseline_mode: str = "fixed"
    fixed_baseline: float = 0.0
    shape: str = "gaussian"  # "gaussian" | "bigaussian"
    mode: str = "free"  # "free" | "guided" | "template"
    # Uma deconvolução salva por análise + canal + MÉTODO (pedido do usuário,
    # 17/10/2026): "gauss" (livre ou guiada) e "molde" convivem, para
    # comparar a recuperação dos dois no relatório. Ver `method_of`.
    method: str = Field(default="gauss", index=True)
    n_peaks: int = 1
    reference_ids: str = "[]"  # JSON
    tol_c: float = 10.0
    tol_width_pct: float = 30.0
    names: str = "[]"  # JSON — nomes dos picos (modo livre), na ordem do centro
    guesses_c: str = "[]"  # JSON — chutes do centro (°C) no modo livre
    result: str = "{}"  # JSON

    created_by_id: int = Field(foreign_key="user.id")
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class PostrunDeconvReference(SQLModel, table=True):
    """Referência de um material puro para a deconvolução guiada (pedido do
    usuário, 16/10/2026): centro e largura médios do(s) pico(s) do material
    nas deconvoluções salvas das corridas dele — de um canal e um ciclo
    (`cycle_key`). `peaks` (JSON): [{mu_s, mu_c, sigma_l_s, sigma_r_s,
    sd_mu_c, sd_sigma_pct}], na ordem do centro."""

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)  # material (ex. "PS")
    channel: str
    cycle_key: str = Field(index=True)
    cycle_label: str = ""
    shape: str = "gaussian"
    peaks: str = "[]"
    n_runs: int = 0
    tokens: str = "[]"
    notes: str = ""
    # corridas que o usuário TIROU da referência (JSON) — o passo 1 da aba
    # Deconvolução não as devolve ao refazer (17/10/2026)
    excluded: str = "[]"
    # molde (modo "Molde do material puro"): curva média normalizada (área 1)
    # em τ = t − centro — JSON {tau, density, center_s, center_c, tau_max}
    template: str = ""

    created_by_id: int = Field(foreign_key="user.id")
    created_at: datetime = Field(default_factory=utcnow)


class PostrunStudy(SQLModel, table=True):
    """Estudo do PostRun (pedido do usuário, 22/10/2026): guarda num lugar só
    tudo de um estudo — as análises (puros e misturas), as referências e
    moldes, as curvas de calibração e as calibrações STD — para reabrir de
    uma vez nas abas Deconvolução e Curvas (como um job) e, ao final, não
    deixar os resultados espalhados pela interface. As deconvoluções vêm das
    análises (uma por análise + canal + método). `snapshot` (JSON) guarda o
    relatório de recuperação dos dois métodos no momento da finalização."""

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    description: str = ""
    status: str = "aberto"  # "aberto" | "finalizado"
    method: str = "molde"  # método principal do estudo: "gauss" | "molde"
    channel: str = "pyro:FID"
    tokens: str = "[]"  # JSON — análises
    reference_ids: str = "[]"
    curve_ids: str = "[]"
    calibration_ids: str = "[]"
    snapshot: str = ""
    # resumo da última recuperação calculada (JSON), para a lista de estudos
    headline: str = ""

    created_by_id: int = Field(foreign_key="user.id")
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    finalized_at: Optional[datetime] = None


class AnalysisRename(SQLModel, table=True):
    """Renomeação de uma análise JÁ FEITA — nome e/ou job — feita movendo o
    `.B00` e o `.B00~` no equipamento (pedido do usuário, 2026-10-01: o caso
    típico é ter esquecido o "extra" no cadastro).

    O histórico imutável (`SampleHistoryEntry`) nunca é editado: este
    registro guarda o antes/depois, quem e quando, e as telas mostram o nome
    atual com "renomeado de…". As amostras do carrossel e a cópia interna do
    TABSAMPLE também não são tocadas — a sincronização do carrossel não lê
    `.B00`, só TABSAMPLE/file_termine, então ela não é afetada.

    `status`: "done" | "failed" | "uncertain" — "uncertain" = o agente não
    respondeu a tempo; a próxima listagem do PostRun confere no disco se o
    arquivo foi movido ou não e fecha o registro (ver
    `analysis_rename.reconcile_uncertain`)."""

    id: Optional[int] = Field(default=None, primary_key=True)
    old_token: str = Field(index=True)
    new_token: str = Field(index=True)
    old_analysis_name: str
    new_analysis_name: str = Field(index=True)
    old_job: str
    new_job: str
    # id da entrada de histórico NO RE7S (a fila é dele — sem chave estrangeira aqui)
    history_entry_id: Optional[int] = Field(default=None, index=True)
    # Troca de AMOSTRA (2026-10-20, `b00_sample`): a amostra da biblioteca
    # estava errada — `Sample=` no `.B00` e o código no nome trocados. O
    # histórico continua imutável; as telas e os contadores usam a amostra
    # nova a partir daqui (`analysis_rename.sample_corrections`).
    old_sample: Optional[str] = None
    new_sample: Optional[str] = None
    # id da amostra da biblioteca NO RE7S
    new_library_sample_id: Optional[int] = None
    status: str = Field(default="done", index=True)
    error: Optional[str] = None
    renamed_by_id: int = Field(foreign_key="user.id")
    created_at: datetime = Field(default_factory=utcnow, index=True)
    completed_at: Optional[datetime] = None


class PostrunB00Cache(SQLModel, table=True):
    """Cache do conteúdo bruto de um `.B00` já lido pelo Agente Horun
    (bug real de produção: `GET /postrun/analyses` fazia uma ida-e-volta
    pelo Agente PRA CADA arquivo, toda vez que a lista era aberta — com
    dezenas de análises reais, isso estourava o timeout fixo de 30s do
    proxy do Horun Core, e o PostRun ficava "inacessível"). Um `.B00`
    nunca muda depois de pronto (o equipamento não reescreve uma análise
    já finalizada) — diferente de `standard.ini`/`TABSAMPLE.txt`/
    `savecycle.txt`, que são ativamente reescritos e por isso NUNCA
    passam por aqui, sempre buscados frescos do agente.

    `token` é o mesmo caminho relativo usado em toda rota do PostRun
    (`app/api/routes_postrun.py`, `_resolve_token`/`_validate_token_shape`)
    — chave primária natural, um `.B00` por token. Sem expiração: como o
    arquivo é imutável, o cache é bom pra sempre; só existe escape manual
    (apagar a linha direto no banco) pro caso raro de um arquivo corrompido
    ter sido cacheado antes de se perceber o problema."""

    token: str = Field(primary_key=True)
    content: str
    cached_at: datetime = Field(default_factory=utcnow)
