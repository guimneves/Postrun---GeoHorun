// Aba PostRun (pedido do usuário): sinais brutos do Rock-Eval 7S lidos
// direto do .B00 (RE7S_JOBS_DIR) — sem nenhum cálculo geoquímico
// (S1/S2/S3/Tmax/TOC/... continuam sendo trabalho do GeoWorks). Ver
// `backend/app/api/routes_postrun.py`.
import { api } from './client'

/** Um job (pasta de primeiro nível da RE7raw-data) — vem só dos nomes de
 * arquivo, sem abrir nenhum .B00. */
export interface JobInfo {
  name: string
  analyses: number
  /** data da análise mais recente (AAAA-MM-DD), tirada do nome do arquivo */
  last_date: string | null
}

export interface AnalysisSummary {
  token: string
  job: string
  method_folder: string
  filename: string
  sample: string
  cycle_name: string
  quantity_mg: number
  date: string | null
  /** nome anterior, se a análise foi renomeada pelo Horun */
  renamed_from?: string | null
  /** método + ciclo + programa do forno — curvas de calibração são por ciclo */
  cycle_key: string
  cycle_label: string
  /** massa usada nos cálculos: a corrigida na tela, senão a do .B00 */
  mass_mg: number
  mass_source: 'arquivo' | 'manual'
  /** fração por componente (soma 1), do nome ou corrigida na tela — null
   * quando não identificada OU sem a proporção (ver `components`) */
  composition: Record<string, number> | null
  composition_text: string
  composition_source: string
  /** componentes, também sem a proporção ("PP + PS"): quais picos procurar */
  components: string[]
  composition_status: CompositionStatus
  /** como a composição foi lida, ou por que não deu */
  composition_note: string
  nominal_mass_mg: number | null
  /** massa que estava no .B00 antes de ser corrigida (a tela grava Quant= no arquivo) */
  file_mass_before_mg?: number | null
  /** só na resposta da edição: salvo no Horun, mas o .B00 não pôde ser gravado */
  file_note?: string | null
  /** massa real de cada polímero pesada na mistura (mg) — a esperada no relatório */
  component_masses?: Record<string, number> | null
}

/** completa = dá recuperação; sem_proporcao = só a massa encontrada; desconhecida = informar */
export type CompositionStatus = 'completa' | 'sem_proporcao' | 'desconhecida'

/** Correção da tela: mass_mg null = volta ao arquivo; composition_text '' = volta ao nome. */
export interface AnalysisMetaIn {
  token: string
  /** campo ausente = fica como estava */
  mass_mg?: number | null
  composition_text?: string | null
  /** "PEAD 1,012; PS 0,998" (mg); "" = tira */
  component_masses_text?: string | null
}

/** Renomear nome/job de uma análise já feita (move o .B00 e o .B00~). */
export interface RenameInfo {
  token: string
  analysis_name: string
  job: string
  /** segue AAAA-MM-DD_código_réplica — dá pra só acrescentar o extra */
  follows_convention: boolean
  current_extra: string | null
  /** por que não dá pra renomear agora (null = pode) */
  blocked_reason: string | null
  renamed_from: string | null
}

export interface RenameInput {
  token: string
  extra?: string
  analysis_name?: string
  job?: string
  dry_run?: boolean
}

export interface RenameResult {
  old_token: string
  new_token: string
  old_analysis_name: string
  new_analysis_name: string
  old_job: string
  new_job: string
  status: 'planned' | 'done'
  moved: string[]
}

/** Mover em lote: cada análise passa pelas mesmas regras do mover individual. */
export interface MoveBatchInput {
  tokens: string[]
  job: string
  dry_run?: boolean
}

/** Trocar a amostra (biblioteca) de análises feitas — Sample= no .B00 + código no nome. */
export interface ChangeSampleItem {
  token: string
  analysis_name: string
  old_sample: string | null
  new_analysis_name: string | null
  new_token: string | null
  status: 'planned' | 'done' | 'failed' | 'skipped'
  renumbered: boolean
  error: string | null
  /** amostra certa desta análise (no lote podem ser várias) */
  library_sample_id: number | null
  code: string | null
}

export interface ChangeSampleResult {
  /** preenchidos só quando o lote inteiro vai para a mesma amostra */
  library_sample_id: number | null
  code: string | null
  name: string | null
  dry_run: boolean
  done: number
  failed: number
  skipped: number
  items: ChangeSampleItem[]
}

export interface MoveBatchItem {
  token: string
  analysis_name: string
  /** planned (prévia ok) | done | failed | skipped (já estava no job / não tentada) */
  status: 'planned' | 'done' | 'failed' | 'skipped'
  new_token: string | null
  error: string | null
}

export interface MoveBatchResult {
  job: string
  dry_run: boolean
  done: number
  failed: number
  skipped: number
  items: MoveBatchItem[]
}

export interface Cursor {
  values: number[]
  base: number
}

export interface Curve {
  idx: number[]
  temp: number[]
  channels: Record<string, number[]>
}

export interface AnalysisDetail {
  token: string
  sample: string
  method_folder: string
  cycle_name: string
  quantity_mg: number
  date: string | null
  cycle_key: string
  cycle_label: string
  /** eixo de tempo: segundos por ponto (1 s no Rock-Eval 7S) */
  seconds_per_point: number
  timebase_warning: string | null
  gas_names: Record<string, string>
  baseline: Record<string, number>
  cursors_auto: Record<string, Cursor>
  cursors_manu: Record<string, Cursor>
  pyro: Curve | null
  oxi: Curve | null
}

export interface BatchItem {
  token: string
  ok: boolean
  error: string | null
  data: AnalysisDetail | null
}

export interface Sparkline {
  token: string
  values: number[] | null // ~48 pontos do FID de pirólise, 0-1; null se deu erro
  error: string | null
}

export type BaselineMode = 'fixed' | 'linear'

export interface RegionIn {
  token: string
  channel: string // "pyro:FID" | "oxi:CO2" | ... — ver CURSOR_SLOTS no backend
  label: string
  start_idx: number
  end_idx: number
  baseline_mode?: BaselineMode
  fixed_baseline?: number
}

export interface RegionUpdate {
  label?: string
  start_idx?: number
  end_idx?: number
  baseline_mode?: BaselineMode
  fixed_baseline?: number
}

export interface Region {
  id: number
  token: string
  channel: string
  label: string
  start_idx: number
  end_idx: number
  baseline_mode: BaselineMode
  fixed_baseline: number
  created_by_id: number
  created_at: string
  area: number | null
  /** área no tempo (sinal × s) — a das curvas de calibração */
  area_s: number | null
  seconds_per_point: number | null
  peak_value: number | null
  peak_idx: number | null
  peak_temp: number | null
  area_error: string | null
  // Pedido do usuário: valor convertido em mg (e mg/g), quando existe
  // calibração vigente pro canal — null se ainda não houver nenhuma.
  calibrated_mg: number | null
  calibrated_mg_per_g: number | null
}

/** Área/pico de uma região ainda não salva (o botão "Salvar" grava). */
export interface RegionPreview {
  token: string
  channel: string
  area: number | null
  area_s: number | null
  seconds_per_point: number | null
  peak_value: number | null
  peak_idx: number | null
  peak_temp: number | null
  area_error: string | null
  calibrated_mg: number | null
  calibrated_mg_per_g: number | null
}

/** Leitura dos .B00 de um job em segundo plano ("Verificar novamente"). */
export interface ScanStatus {
  job: string
  state: 'idle' | 'running' | 'done' | 'error'
  /** ainda listando os arquivos no equipamento */
  listing: boolean
  total: number
  read: number
  failed: number
  error: string | null
  started_at: string | null
  finished_at: string | null
}

// ---------------------------------------------------------- curvas de calibração

export type CurveModel = 'linear' | 'origin' | 'quadratic'
export type CurveWeighting = 'none' | '1/x' | '1/x2'
export type CurveXKind = 'sample_mass' | 'component_mass'

export interface CurvePointIn {
  region: RegionIn
  excluded: boolean
  /** curva de gaussiana: material do pico na deconvolução salva */
  gaussian?: string
}

export type AreaSource = 'region' | 'gaussian'

export interface CurveSpec {
  channel: string
  area_source: AreaSource
  /** com área de pico: de qual deconvolução salva (molde ou gaussiana) */
  deconv_method?: DeconvMethod
  x_kind: CurveXKind
  component: string
  model: CurveModel
  weighting: CurveWeighting
  points: CurvePointIn[]
}

export interface CurvePoint {
  token: string
  sample: string
  filename: string
  composition_text: string
  mass_mg: number | null
  mass_source: string
  fraction: number | null
  x: number | null
  area_s: number | null
  area_per_mg: number | null
  peak_temp: number | null
  residual: number | null
  excluded: boolean
  start_idx: number
  end_idx: number
  baseline_mode: BaselineMode
  fixed_baseline: number
  label: string
  gaussian: string
  u_area_s: number | null
  error: string | null
}

export interface CurveFit {
  coef: number[]
  cov: number[][]
  equation: string
  s: number
  s_y: number
  r2: number
  n: number
  dof: number
  x_min: number
  x_max: number
  lod: number | null
  loq: number | null
  rf_mean: number | null
  rf_sd: number | null
  rf_cv_pct: number | null
  warnings: string[]
}

/** de qual deconvolução salva vem a área: gaussianas (livre/guiada) ou molde */
export type DeconvMethod = 'gauss' | 'molde'
export const METHOD_LABEL: Record<DeconvMethod, string> = { gauss: 'Gaussiana', molde: 'Molde' }

export interface CurvePreview {
  channel: string
  area_source: AreaSource
  deconv_method?: DeconvMethod
  cycle_key: string
  cycle_label: string
  x_kind: CurveXKind
  component: string
  model: CurveModel
  weighting: CurveWeighting
  points: CurvePoint[]
  fit: CurveFit | null
  error: string | null
}

// F2: brancos de matriz e limites (POST /postrun/curves/{id}/limits)
export interface LimitsIn {
  blank_tokens: string[]
  low_tokens?: string[]
  matrix_mass_mg?: number | null
  start_idx?: number | null
  end_idx?: number | null
  baseline_mode?: BaselineMode
  save?: boolean
}

export interface LimitRun {
  token: string
  filename: string
  sample: string
  mass_mg: number | null
  area_s: number | null
  apparent_mg: number | null
  error: string | null
}

export interface LimitValue {
  key: 'lob' | 'lod' | 'loq' | 'ld_curve' | 'lq_curve'
  label: string
  criterion: string
  mg: number | null
  ppm: number | null
}

export interface LimitsOut {
  curve_id: number
  start_idx: number
  end_idx: number
  baseline_mode: BaselineMode
  matrix_mass_mg: number | null
  matrix_mass_source: string
  n_blanks: number
  blank_mean_mg: number
  blank_sd_mg: number
  n_low: number
  low_sd_mg: number | null
  limits: LimitValue[]
  blanks: LimitRun[]
  low: LimitRun[]
  warnings: string[]
  computed_at: string
}

export interface SavedCurve extends CurvePreview {
  id: number
  name: string
  notes: string
  /** F2: último cálculo de brancos e limites guardado na curva */
  limits?: LimitsOut | null
  created_by_id: number
  created_at: string
  updated_at: string
}

export interface QuantifyItem {
  token: string
  channel: string
  material: string
  area_s: number | null
  mass_mg: number | null
  u_mg: number | null
  U95_mg: number | null
  outside_range: boolean
  below_lod: boolean
  below_loq: boolean
  sample_mass_mg: number | null
  expected_mg: number | null
  recovery_pct: number | null
  error: string | null
}

// ---------------------------------------------------------- deconvolução

export type DeconvShape = 'gaussian' | 'bigaussian'
/** free = picos livres; guided = picos guiados pelas referências;
 * template = molde (curva média) do material puro */
export type DeconvMode = 'free' | 'guided' | 'template'

export interface DeconvSpec {
  token: string
  channel: string
  start_idx: number
  end_idx: number
  baseline_mode: BaselineMode
  fixed_baseline: number
  shape: DeconvShape
  mode: DeconvMode
  n_peaks: number
  reference_ids: number[]
  tol_c: number
  tol_width_pct: number
  names: string[]
  guesses_c: number[]
}

export interface DeconvPeak {
  name: string
  material: string
  h: number
  mu_s: number
  mu_c: number | null
  sigma_l_s: number
  sigma_r_s: number
  fwhm_s: number
  area_s: number
  u_area_s: number
  pct_of_total: number
  reference_id: number | null
  ref_mu_c: number | null
  delta_mu_c: number | null
  delta_width_pct: number | null
  at_bound: boolean
  /** modo molde: centro do molde (s) e dilatação (1 = mesma largura do puro) */
  center_s?: number | null
  stretch?: number | null
  /** largura à meia altura (°C) do componente na mistura e do molde do puro */
  fwhm_c?: number | null
  pure_fwhm_c?: number | null
}

export interface DeconvResult {
  id: number | null
  spec: DeconvSpec
  cycle_key: string
  cycle_label: string
  seconds_per_point: number
  peaks: DeconvPeak[]
  total_area_s: number
  window_area_s: number
  r2: number
  rmse: number
  bic: number
  area_correlation: number[][]
  warnings: string[]
  curve: {
    idx: number[]
    signal: number[]
    fitted: number[]
    components: number[][]
    /** modo molde: o molde do puro (dilatação 1, na posição da referência) com a mesma área */
    pure_components?: number[][]
    /** temperatura de cada ponto (°C) */
    temps?: number[]
  } | null
  updated_at: string | null
  method?: DeconvMethod
}

export interface DeconvFitItem {
  token: string
  ok: boolean
  error: string | null
  data: DeconvResult | null
}

export interface DeconvReference {
  id: number
  name: string
  channel: string
  cycle_key: string
  cycle_label: string
  shape: DeconvShape
  peaks: { mu_s: number; mu_c: number | null; sigma_l_s: number; sigma_r_s: number; sd_mu_c: number | null; sd_sigma_pct: number | null }[]
  n_runs: number
  tokens: string[]
  notes: string
  created_at: string
  /** tem o molde (curva média do puro) para o modo "Molde do material puro" */
  has_template: boolean
  /** corridas tiradas pelo usuário (o passo 1 não as devolve) */
  excluded?: string[]
}

/** uma corrida pura da referência, contra o molde */
export interface ReferenceRun {
  token: string
  sample: string
  /** nome da análise (.B00) */
  filename: string
  job: string
  mass_mg: number | null
  date: string | null
  ok: boolean
  error: string | null
  max_c: number | null
  area_s: number | null
  fwhm_s: number | null
  /** largura desta corrida ÷ largura do molde (dilatação natural) */
  stretch: number | null
  /** quanto a forma foge do molde (% da altura do molde) */
  rms_pct: number | null
  density: number[]
  /** R² do ajuste de 1 gaussiana desta corrida */
  gauss_r2?: number | null
}

export interface ReferenceDetail {
  reference: DeconvReference
  tau: number[]
  mold: number[]
  sd: number[]
  center_s: number | null
  max_c: number | null
  mold_fwhm_s: number | null
  runs: ReferenceRun[]
  /** gaussiana de referência (centro e larguras médios, área 1) na grade do molde — vazio com 2+ picos */
  gauss: number[]
  gauss_fwhm_s: number | null
  /** parte da forma real que a gaussiana não descreve (%) */
  gauss_misfit_pct: number | null
}

// ---------------------------------------------------------- relatório de recuperação

export interface ReportStat {
  mean: number | null
  sd: number | null
  n: number
}

export interface ReportRunMaterial {
  material: string
  fraction: number | null
  n_peaks: number
  area_s: number
  u_area_s: number
  tpk_c: number | null
  delta_mu_c: number | null
  delta_width_pct: number | null
  found_mg: number | null
  U95_mg: number | null
  expected_mg: number | null
  recovery_pct: number | null
  /** fração real (pelas massas pesadas), se informadas */
  real_fraction?: number | null
  expected_source?: string
  flags: string[]
}

export interface ReportRun {
  token: string
  filename: string
  sample: string
  group: string
  composition_text: string
  mass_mg: number
  mass_source: string
  shape: DeconvShape
  mode: DeconvMode
  r2: number
  bic: number
  warnings: string[]
  total_found_mg: number | null
  /** Σ massas encontradas ÷ massa pesada (F1) */
  total_recovery_pct: number | null
  /** poliolefinas somadas (PEAD + PP…), quando há duas ou mais */
  polyolefins_found_mg?: number | null
  polyolefins_recovery_pct?: number | null
  component_masses?: Record<string, number> | null
  materials: ReportRunMaterial[]
}

export interface ReportGroup {
  key: string
  composition: Record<string, number>
  cycle_label: string
  n_runs: number
  total_recovery_pct: ReportStat
  /** materiais somados em `polyolefins_recovery_pct` (vazio = não se aplica) */
  polyolefins?: string[]
  polyolefins_recovery_pct?: ReportStat
  r2_min: number
  n_runs_with_warnings: number
  materials: {
    material: string
    fraction: number | null
    expected_mg: ReportStat
    found_mg: ReportStat
    recovery_pct: ReportStat
    delta_mu_c: ReportStat
    delta_width_pct: ReportStat
  }[]
}

export interface RecoveryReport {
  channel: string
  method?: DeconvMethod
  groups: ReportGroup[]
  runs: ReportRun[]
  curves: { material: string; id: number; name: string; equation: string; r2: number; lod: number | null; loq: number | null; x_min: number; x_max: number; cycle_label: string }[]
  missing_curves: string[]
  skipped: { token: string; reason: string }[]
  /** dilatação natural dos puros (%), por material: média ± desvio das corridas da referência */
  natural_width?: Record<string, ReportStat>
}

export interface ReportRequest {
  tokens: string[]
  channel: string
  curve_ids: Record<string, number>
  method?: DeconvMethod
}

// ---------------------------------------------------------- aba Deconvolução (passo a passo)

export interface WorkflowRun {
  token: string
  filename: string
  sample: string
  composition: Record<string, number> | null
  composition_text: string
  components: string[]
  composition_status: CompositionStatus
  composition_note: string
  mass_mg: number
  cycle_key: string
  cycle_label: string
  /** no_ratio = mistura sem proporção: ajusta e dá a massa encontrada, sem recuperação */
  kind: 'pure' | 'mixture' | 'no_ratio' | 'unknown'
  material: string | null
  has_region: boolean
  error: string | null
  saved: Partial<Record<DeconvMethod, { mode: string; r2: number; warnings: string[]; materials: Record<string, number> }>>
}

export interface WorkflowCurve {
  id: number
  name: string
  component: string
  method: DeconvMethod
  cycle_key: string
  cycle_label: string
  r2: number | null
  n_points: number
  equation: string
  updated_at: string
}

export interface WorkflowStatus {
  runs: WorkflowRun[]
  references: DeconvReference[]
  curves: WorkflowCurve[]
}

export interface WorkflowItem {
  token: string
  ok: boolean
  error: string | null
  r2: number | null
  warnings: string[]
}

export interface WorkflowReferencesResult {
  items: WorkflowItem[]
  references: { material: string; cycle_label: string; ok: boolean; error: string | null; reference: DeconvReference | null; updated: boolean; n_excluded: number }[]
}

export interface WorkflowCurveResult {
  material: string
  cycle_label: string
  ok: boolean
  error: string | null
  curve: WorkflowCurve | null
  updated: boolean
}

export type CalibrationMode = 'gain' | 'linear'

export interface CalibrationCandidate {
  token: string
  channel: string
  standard_id: number
  standard_name: string
  start_idx: number // cursor do próprio GeoWorks pra essa corrida (min/max)
  end_idx: number
  area: number
  mass_mg: number
  known_mg: number // parâmetro de massa (pro FID: S2) × massa da corrida
  reference_source: string // "standard.ini" | "catálogo"
  tmax_certified: number | null
  tmax_measured: number | null // temperatura no pico do sinal — só conferência, não entra no K1
  suggested_k1: number
}

export interface CalibrationPoint {
  token: string
  standard_id: number
}

export interface CalibrationSourcePoint {
  token: string
  standard_id: number
  standard_name: string
  area: number
  known_mg: number
  mass_mg: number
  tmax_certified: number | null
  tmax_measured: number | null
  /** quando o padrão foi rodado (data da corrida no .B00) */
  run_date: string | null
}

export interface Calibration {
  id: number
  channel: string
  /** nome escolhido (ex.: "IFP160000 — agosto/2026") */
  name: string
  notes: string
  /** a que vale agora para o canal */
  is_active: boolean
  /** datas das corridas do padrão (primeira e última) */
  run_date_min: string | null
  run_date_max: string | null
  mode: CalibrationMode
  k0: number
  k1: number
  r2: number | null
  source_points: CalibrationSourcePoint[]
  validated_by_id: number
  validated_at: string
}

function tokensQuery(tokens: string[]): string {
  const params = new URLSearchParams()
  tokens.forEach((t) => params.append('tokens', t))
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export const postrunApi = {
  listJobs: () => api.get<JobInfo[]>('/postrun/jobs'),

  /** Só as análises de um job (a aba sempre pede assim — ler os .B00 de
   * todos os jobs de uma vez é lento pelo agente). */
  listAnalyses: (job: string) =>
    api.get<AnalysisSummary[]>(`/postrun/analyses?job=${encodeURIComponent(job)}`),

  getDetail: (token: string) =>
    api.get<AnalysisDetail>(`/postrun/analyses/detail?token=${encodeURIComponent(token)}`),

  getBatch: (tokens: string[]) =>
    api.post<BatchItem[]>('/postrun/analyses/batch', { tokens }),

  getSparklines: (tokens: string[]) =>
    api.post<Sparkline[]>('/postrun/analyses/sparklines', { tokens }),

  listRegions: (tokens: string[]) => api.get<Region[]>(`/postrun/regions${tokensQuery(tokens)}`),

  deleteRegions: (tokens: string[]) =>
    api.delete<{ ok: boolean; deleted: number }>(`/postrun/regions${tokensQuery(tokens)}`),

  createRegion: (payload: RegionIn) => api.post<Region>('/postrun/regions', payload),

  updateRegion: (id: number, payload: RegionUpdate) =>
    api.patch<Region>(`/postrun/regions/${id}`, payload),

  deleteRegion: (id: number) => api.delete<{ ok: boolean }>(`/postrun/regions/${id}`),

  /** Calcula área/pico sem gravar nada. */
  previewRegions: (regions: RegionIn[]) => api.post<RegionPreview[]>('/postrun/regions/preview', { regions }),

  /** Botão "Salvar": grava/atualiza (uma por análise + canal) e apaga as marcadas. */
  saveRegions: (upserts: RegionIn[], deleteIds: number[]) =>
    api.put<Region[]>('/postrun/regions/save', { upserts, delete_ids: deleteIds }),

  /** Corrige massa/composição (devolve o resumo atualizado de cada análise). */
  updateMeta: (items: AnalysisMetaIn[]) => api.put<AnalysisSummary[]>('/postrun/analyses/meta', items),

  previewCurve: (spec: CurveSpec) => api.post<CurvePreview>('/postrun/curves/preview', spec),
  createCurve: (spec: CurveSpec & { name: string; notes: string }) => api.post<SavedCurve>('/postrun/curves', spec),
  updateCurve: (id: number, spec: CurveSpec & { name: string; notes: string }) =>
    api.put<SavedCurve>(`/postrun/curves/${id}`, spec),
  listCurves: (channel?: string) =>
    api.get<SavedCurve[]>(`/postrun/curves${channel ? `?channel=${encodeURIComponent(channel)}` : ''}`),
  deleteCurve: (id: number) => api.delete<{ ok: boolean }>(`/postrun/curves/${id}`),
  curveLimits: (id: number, body: LimitsIn) => api.post<LimitsOut>(`/postrun/curves/${id}/limits`, body),
  quantify: (curveId: number, regions: RegionIn[]) =>
    api.post<QuantifyItem[]>('/postrun/quantify', { curve_id: curveId, regions }),
  quantifyGaussians: (curveId: number, gaussians: { token: string; channel: string; material: string }[]) =>
    api.post<QuantifyItem[]>('/postrun/quantify', { curve_id: curveId, gaussians }),

  recoveryReport: (req: ReportRequest) => api.post<RecoveryReport>('/postrun/report/recovery', req),
  // simples (F5): tabela para publicação, sem formatação visual
  recoveryReportXlsx: (req: ReportRequest, simples = false) =>
    api.postBlob(`/postrun/report/recovery.xlsx${simples ? '?simples=true' : ''}`, req),

  fitDeconv: (items: DeconvSpec[]) => api.post<DeconvFitItem[]>('/postrun/deconvolution/fit', { items }),
  saveDeconv: (upserts: DeconvSpec[], deleteIds: number[]) =>
    api.put<DeconvResult[]>('/postrun/deconvolution/save', { upserts, delete_ids: deleteIds }),
  listDeconv: (tokens: string[], method?: DeconvMethod) =>
    api.get<DeconvResult[]>(`/postrun/deconvolution${tokensQuery(tokens)}${method ? `${tokens.length ? '&' : '?'}method=${method}` : ''}`),
  // POST: com dezenas de análises, os caminhos não cabem na URL
  workflowStatus: (tokens: string[]) => api.post<WorkflowStatus>('/postrun/workflow/status', { tokens, channel: 'pyro:FID' }),
  workflowReferences: (tokens: string[]) =>
    api.post<WorkflowReferencesResult>('/postrun/workflow/references', { tokens, channel: 'pyro:FID' }),
  workflowFit: (tokens: string[], method: DeconvMethod, tolC: number, tolW: number) =>
    api.post<WorkflowItem[]>('/postrun/workflow/fit', { tokens, channel: 'pyro:FID', method, tol_c: tolC, tol_width_pct: tolW }),
  workflowCurves: (tokens: string[], method: DeconvMethod, model: string, weighting: string) =>
    api.post<WorkflowCurveResult[]>('/postrun/workflow/curves', { tokens, channel: 'pyro:FID', method, model, weighting }),
  listReferences: () => api.get<DeconvReference[]>('/postrun/deconvolution/references'),
  createReference: (name: string, tokens: string[], channel = 'pyro:FID') =>
    api.post<DeconvReference>('/postrun/deconvolution/references', { name, tokens, channel }),
  referenceDetail: (id: number) => api.get<ReferenceDetail>(`/postrun/deconvolution/references/${id}/detail`),
  setReferenceRuns: (id: number, tokens: string[]) =>
    api.put<DeconvReference>(`/postrun/deconvolution/references/${id}/runs`, { tokens }),
  deleteReference: (id: number) => api.delete<{ ok: boolean }>(`/postrun/deconvolution/references/${id}`),

  /** Começa (ou acompanha) a leitura do job em segundo plano. */
  startScan: (job: string) => api.post<ScanStatus>('/postrun/scan', { job }),

  getScan: (job: string) => api.get<ScanStatus>(`/postrun/scan?job=${encodeURIComponent(job)}`),

  applyRegion: (regionId: number, targetTokens: string[]) =>
    api.post<Region[]>('/postrun/regions/apply', { region_id: regionId, target_tokens: targetTokens }),

  getCalibrationCandidate: (token: string, channel: string, standardId: number) =>
    api.get<CalibrationCandidate>(
      `/postrun/calibration/candidate?token=${encodeURIComponent(token)}` +
        `&channel=${encodeURIComponent(channel)}&standard_id=${standardId}`,
    ),

  createCalibration: (
    channel: string,
    mode: CalibrationMode,
    points: CalibrationPoint[],
    extra: { name?: string; notes?: string; make_active?: boolean } = {},
  ) => api.post<Calibration>('/postrun/calibration', { channel, mode, points, ...extra }),

  /** renomear/anotar ou tornar vigente (K0/K1 nunca mudam) */
  updateCalibration: (id: number, patch: { name?: string; notes?: string; make_active?: boolean }) =>
    api.patch<Calibration>(`/postrun/calibration/${id}`, patch),

  listCalibrations: (channel: string) =>
    api.get<Calibration[]>(`/postrun/calibration?channel=${encodeURIComponent(channel)}`),

  renameInfo: (token: string) =>
    api.get<RenameInfo>(`/postrun/analyses/rename-info?token=${encodeURIComponent(token)}`),

  renameAnalysis: (payload: RenameInput) => api.post<RenameResult>('/postrun/analyses/rename', payload),

  /** Mover várias análises para outro job (só admin) — resultado por análise. */
  moveBatch: (payload: MoveBatchInput) => api.post<MoveBatchResult>('/postrun/analyses/move-batch', payload),
  /** uma amostra para todas (tokens + library_sample_id) ou uma por análise (assignments) */
  changeSample: (
    payload:
      | { tokens: string[]; library_sample_id: number; dry_run?: boolean }
      | {
          assignments: { token: string; library_sample_id: number }[]
          dry_run?: boolean
          /** todas as análises da operação, quando ela vai em partes */
          context_tokens?: string[]
          /** nomes novos já planejados nas partes anteriores da prévia */
          reserved_names?: string[]
        },
  ) =>
    api.post<ChangeSampleResult>('/postrun/analyses/change-sample', payload),
}

// ---------------------------------------------------------- estudos (22/10/2026)

export type StudyStatus = 'aberto' | 'finalizado'

export interface StudyHeadlineGroup {
  key: string
  n_runs: number
  total_mean: number | null
  total_sd: number | null
  total_n?: number
  polyolefins?: string[]
  polyolefins_mean?: number | null
  polyolefins_sd?: number | null
  polyolefins_n?: number
  materials: { material: string; fraction: number | null; recovery_mean: number | null; recovery_sd: number | null; n: number }[]
}

export interface Study {
  id: number
  name: string
  description: string
  status: StudyStatus
  method: DeconvMethod
  channel: string
  tokens: string[]
  reference_ids: number[]
  curve_ids: number[]
  calibration_ids: number[]
  headline: Partial<Record<DeconvMethod, StudyHeadlineGroup[]>>
  created_by_id: number
  created_at: string
  updated_at: string
  finalized_at: string | null
}

export interface StudyDetail extends Study {
  analyses: { token: string; ok: boolean; error: string | null; summary: AnalysisSummary | null; saved_methods: DeconvMethod[] }[]
  references: DeconvReference[]
  curves: { id: number; name: string; component: string; method: DeconvMethod; area_source: string; model: string; equation: string; r2: number | null; n_points: number; cycle_label: string }[]
  calibrations: { id: number; name: string; channel: string; mode: string; r2: number | null; validated_at: string }[]
}

export interface StudyItems {
  tokens?: string[]
  reference_ids?: number[]
  curve_ids?: number[]
  calibration_ids?: number[]
}

export const studyApi = {
  list: () => api.get<Study[]>('/postrun/studies'),
  get: (id: number) => api.get<StudyDetail>(`/postrun/studies/${id}`),
  create: (body: { name: string; description: string; method: DeconvMethod }) => api.post<Study>('/postrun/studies', body),
  update: (id: number, body: { name?: string; description?: string; method?: DeconvMethod; status?: StudyStatus }) =>
    api.put<Study>(`/postrun/studies/${id}`, body),
  remove: (id: number) => api.delete<{ ok: boolean }>(`/postrun/studies/${id}`),
  items: (id: number, change: { add?: StudyItems; remove?: StudyItems }) => api.post<Study>(`/postrun/studies/${id}/items`, change),
  collect: (id: number, tokens: string[]) => api.post<Study>(`/postrun/studies/${id}/collect`, { tokens }),
  report: (id: number, method?: DeconvMethod) =>
    api.post<{ report: RecoveryReport; frozen: boolean }>(`/postrun/studies/${id}/report${method ? `?method=${method}` : ''}`),
  exportXlsx: (id: number, simples = false) => api.getBlob(`/postrun/studies/${id}/export.xlsx${simples ? '?simples=true' : ''}`),
  sensitivity: (id: number, tolerances: number[]) => api.post<StudySensitivity>(`/postrun/studies/${id}/sensitivity`, { tolerances }),
  // PCA e PLS das curvas (17/11/2026)
  classes: (id: number) => api.get<StudyClasses>(`/postrun/studies/${id}/classes`),
  setClasses: (id: number, body: StudyClasses) => api.put<StudyClasses>(`/postrun/studies/${id}/classes`, body),
  pca: (
    id: number,
    body: ChemPrepIn & { n_comp?: number; blocks?: string[] | null; block_weights?: Record<string, number>; delays_s?: Record<string, number> },
  ) => api.post<StudyPCA>(`/postrun/studies/${id}/pca`, body),
  pls: (id: number, body: ChemPrepIn & { target: PlsTarget; cv: PlsCv; n_lv?: number | null; max_lv?: number }) =>
    api.post<StudyPLS>(`/postrun/studies/${id}/pls`, body),
  // F3: validação independente
  validationConfig: (id: number) => api.get<ValidationConfig>(`/postrun/studies/${id}/validation/config`),
  setValidationConfig: (id: number, body: { roles: Record<string, ValidationRole>; blind: boolean }) =>
    api.put<ValidationConfig>(`/postrun/studies/${id}/validation/config`, body),
  validation: (id: number, method?: DeconvMethod) =>
    api.post<ValidationReport>(`/postrun/studies/${id}/validation${method ? `?method=${method}` : ''}`),
  revealValidation: (id: number, method?: DeconvMethod) =>
    api.post<ValidationReport>(`/postrun/studies/${id}/validation/reveal${method ? `?method=${method}` : ''}`),
}

// ------------------------------------------------- F3: validação independente

export type ValidationRole = 'calibracao' | 'validacao'

export interface ValidationConfig {
  roles: Record<string, ValidationRole>
  blind: boolean
  revealed_at: string | null
  revealed_by: string | null
}

export interface ValidationRun {
  token: string | null
  code: string
  label: string
  day: string
  included: boolean
  reason: string | null
  changed_since_reveal: boolean
  materials: { material: string; found_mg: number | null; U95_mg: number | null; added_mg: number | null; recovery_pct: number | null; flags: string[] }[]
}

export interface ValidationMetrics {
  material: string
  n: number
  n_days: number
  bias_mg: number
  bias_pct: number
  rmsep_mg: number
  recovery_mean: number
  recovery_sd: number | null
  slope: number | null
  intercept: number | null
  r2: number | null
  mean_rel_U95_pct: number | null
  anova: { k_days: number; n: number; s_r: number | null; s_between: number | null; s_ip: number | null; warnings: string[] }
}

export interface ValidationReport {
  config: ValidationConfig
  method: DeconvMethod
  n_calibration: number
  n_validation: number
  hidden: boolean
  runs: ValidationRun[]
  metrics: ValidationMetrics[]
  points: { material: string; added_mg: number; found_mg: number; U95_mg: number | null }[]
  conflicts: string[]
  warnings: string[]
}

/** Tolerância de largura ótima (23/10/2026): RMSE da recuperação × tolerância */
export interface StudySensitivityPoint {
  tol_width_pct: number
  rmse: number | null
  rmse_by_material: Record<string, number>
  rmse_total: number | null
  n: number
  n_at_bound: number
  n_failed: number
  mean_r2: number | null
  recovery_by_group: Record<string, Record<string, number>>
  width_by_material: Record<string, ReportStat>
}

export interface StudySensitivity {
  points: StudySensitivityPoint[]
  best_tol: number | null
  best_rmse: number | null
  loco: { group: string; chosen_tol: number | null; rmse_at_group: number | null }[]
  rmse_loco: number | null
  saved_tol: number[]
  natural_width: Record<string, ReportStat>
  n_mixtures: number
  errors: string[]
}

/** Classes da PCA (18/11/2026): rótulos que a pessoa dá às corridas do estudo */
export interface StudyClass {
  id: string
  name: string
  color: string
}

export interface StudyClasses {
  classes: StudyClass[]
  assign: Record<string, string>
}

/** PCA e PLS das curvas do estudo (17/11/2026) */
export type ChemNormalize = 'none' | 'mass' | 'area' | 'max'
export type PlsTarget = 'mass' | 'fraction'
export type PlsCv = 'composicao' | 'corrida'

export interface ChemPrepIn {
  normalize?: ChemNormalize | null
  derivative?: number
  align?: boolean
  t_min?: number | null
  t_max?: number | null
  step?: number
  /** só estas corridas do estudo (null = todas) */
  tokens?: string[] | null
}

export interface ChemPrep {
  normalize: ChemNormalize
  derivative: number
  align: boolean
  t_min: number
  t_max: number
  step: number
}

export interface ChemRun {
  token: string
  filename: string
  sample: string
  group: string
  kind: 'puro' | 'mistura' | 'desconhecida'
  composition: Record<string, number> | null
  mass_mg: number | null
  day: string | null
  cycle: string
  method: string
  tmax_c: number | null
  shift_c: number
}

export interface ChemBlock {
  name: string
  weight: number
  scale: number
  delay_s: number
  empty: boolean
}

export interface StudyPCA {
  /** multibloco (vários detectores): x, mean e loadings concatenados, um bloco de len(grid) por detector */
  blocks: ChemBlock[]
  q_block: number[][]
  q_block_limit: (number | null)[]
  prep: ChemPrep
  grid: number[]
  runs: ChemRun[]
  x: number[][]
  mean: number[]
  explained: number[]
  scores: number[][]
  loadings: number[][]
  t2: number[]
  q: number[]
  t2_limit: number | null
  q_limit: number | null
  materials: string[]
  errors: string[]
}

export interface PlsMaterial {
  material: string
  n_lv: number
  rmsec: number[]
  rmsecv: number[]
  r2_cal: number | null
  q2: number | null
  b: number[]
  vip: number[]
  preds: { token: string; y: number; y_cv: number; y_fit: number; recovery_cv_pct: number | null }[]
  rmse_recovery_mix_pct: number | null
  notes: string[]
  error: string | null
}

export interface StudyPLS {
  prep: ChemPrep
  target: PlsTarget
  unit: string
  cv: PlsCv
  n_groups: number
  grid: number[]
  runs: ChemRun[]
  materials: PlsMaterial[]
  excluded: string[]
  errors: string[]
}

// ------------------------------------------------- F4: rastreabilidade por corrida

export type ExclusionReason = 'falha' | 'massa_ausente' | 'nome_suspeito' | 'outro'

export interface RunRecord {
  token: string
  excluded: boolean
  exclusion_reason: ExclusionReason | ''
  exclusion_reason_label: string
  exclusion_comment: string
  excluded_by: string
  excluded_at: string | null
  matrix_mass_mg: number | null
  polymer_lot: string
  granulometry: string
  operator: string
  run_date: string
  notes: string
  updated_by: string
  updated_at: string | null
}

export interface RunMetaIn {
  token: string
  matrix_mass_mg: number | null
  polymer_lot: string
  granulometry: string
  operator: string
  run_date: string
  notes: string
}

export interface ExclusionLogEntry {
  token: string
  action: 'excluida' | 'restaurada'
  reason: string
  reason_label: string
  comment: string
  user: string
  at: string
}

export const runsApi = {
  reasons: () => api.get<Record<ExclusionReason, string>>('/postrun/runs/reasons'),
  records: (tokens: string[]) => api.post<RunRecord[]>('/postrun/runs/records', tokens),
  saveRecords: (items: RunMetaIn[]) => api.put<RunRecord[]>('/postrun/runs/records', items),
  exclude: (tokens: string[], reason: ExclusionReason, comment: string) =>
    api.post<RunRecord[]>('/postrun/runs/exclude', { tokens, reason, comment }),
  restore: (tokens: string[], comment: string) => api.post<RunRecord[]>('/postrun/runs/restore', { tokens, comment }),
  log: (tokens: string[]) => api.post<ExclusionLogEntry[]>('/postrun/runs/exclusions/log', tokens),
}

// ------------------------------------------------- F6: comparador de modelos

export type CompareModelKey = 'molde' | 'molde_c_fixo' | 'molde_s_fixo' | 'cls' | 'gauss' | 'bigauss' | 'pmp008'

export interface CompareModel {
  key: CompareModelKey
  label: string
  n_mixtures: number
  n_failed: number
  n_at_bound: number | null
  recovery: Record<string, { mean: number | null; sd: number | null; n: number }>
  rmsep_mg: Record<string, number>
  rmse_recovery_pct: number | null
  total_recovery: { mean: number | null; sd: number | null; n: number }
  bic_mean: number | null
  r2_mean: number | null
  curve_slopes: Record<string, number>
  errors: string[]
}

export interface CompareResult {
  models: CompareModel[]
  best: CompareModelKey | null
  n_pure: number
  n_mixtures: number
  warnings: string[]
}

export const compareApi = {
  run: (studyId: number, models: CompareModelKey[]) =>
    api.post<CompareResult>(`/postrun/studies/${studyId}/compare-models`, { models }),
}

// ------------------------------------------------- F7: interação na co-pirólise

export interface InteractionRun {
  token: string
  filename: string
  composition_text: string
  delta_m_pct: number | null
  max_dev_pct: number | null
  t_s: number[]
  temp_c: number[]
  measured: number[]
  predicted: number[]
  difference: number[]
  components: number[][]
  component_info: { material: string; fraction: number | null; expected_mg: number | null; predicted_area_s: number | null; error: string | null }[]
  error: string | null
}

export interface InteractionResult {
  method: DeconvMethod
  runs: InteractionRun[]
  trends: { material: string; fraction: number; delta_mu_c: number | null; delta_width_pct: number | null; at_bound: boolean; token: string }[]
  alerts: { token: string; filename: string; material: string; delta_mu_c: number | null; delta_width_pct: number | null; tol_c: number; tol_width_pct: number }[]
  warnings: string[]
}

export const interactionApi = {
  run: (studyId: number, method?: DeconvMethod) =>
    api.post<InteractionResult>(`/postrun/studies/${studyId}/interaction${method ? `?method=${method}` : ''}`),
}

// ------------------------------------------------- F8: robustez dos moldes

export interface RobustnessResult {
  material: string
  reference_id: number
  reference_name: string
  n_template_runs: number
  n_pures: number
  n_mixtures: number
  baseline_recovery: number | null
  loro: { left_out: string; filename: string; recovery_mean: number | null; error: string | null }[]
  template_sd_recovery: number | null
  combined: { token: string; filename: string; found_mg: number | null; u_fit_mg: number | null; u_template_mg: number | null; U95_combined_mg: number | null; template_share_pct: number | null }[]
  compare: { reference_id: number; name: string; correlation: number | null; l2: number | null; l2_rel_pct: number | null; max_c_diff: number | null; recovery_mean: number | null; delta_recovery: number | null } | null
  warnings: string[]
}

export const robustnessApi = {
  run: (studyId: number, material: string, altReferenceId: number | null) =>
    api.post<RobustnessResult>(`/postrun/studies/${studyId}/template-robustness`, { material, alt_reference_id: altReferenceId }),
}

// ------------------------------------------------- F9: identificabilidade

export interface IdentifiabilityResult {
  method: DeconvMethod
  runs: {
    token: string
    filename: string
    composition_text: string
    materials: string[]
    correlation: number[][]
    pairs: { a: string; b: string; rho: number; ill_conditioned: boolean; recovery_a: number | null; recovery_b: number | null; recovery_sum: number | null }[]
    error: string | null
  }[]
  recommendations: string[]
}

export interface BootstrapResult {
  token: string
  filename: string
  n_ok: number
  n_failed: number
  materials: { material: string; expected_mg: number | null; found_mean: number | null; found_sd: number | null; found_p2_5: number | null; found_p97_5: number | null; recovery_sd_pct: number | null }[]
  pairs: { a: string; b: string; rho: number | null; sum_sd: number | null; sum_cv_pct: number | null; a_cv_pct: number | null; b_cv_pct: number | null }[]
  samples: Record<string, number[]>
}

export const identifiabilityApi = {
  run: (studyId: number, method?: DeconvMethod) =>
    api.post<IdentifiabilityResult>(`/postrun/studies/${studyId}/identifiability${method ? `?method=${method}` : ''}`),
  bootstrap: (studyId: number, token: string, method: DeconvMethod, nBoot: number) =>
    api.post<BootstrapResult>(`/postrun/studies/${studyId}/identifiability/bootstrap`, { token, method, n_boot: nBoot }),
}
