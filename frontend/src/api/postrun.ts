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
  /** fração por componente (soma 1), do nome ou corrigida na tela */
  composition: Record<string, number> | null
  composition_text: string
  composition_source: string
  nominal_mass_mg: number | null
  /** massa que estava no .B00 antes de ser corrigida (a tela grava Quant= no arquivo) */
  file_mass_before_mg?: number | null
  /** só na resposta da edição: salvo no Horun, mas o .B00 não pôde ser gravado */
  file_note?: string | null
  /** massa real de cada polímero pesada na mistura (mg) — a esperada no relatório */
  component_masses?: Record<string, number> | null
}

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
}

export interface ChangeSampleResult {
  library_sample_id: number
  code: string
  name: string
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

export interface SavedCurve extends CurvePreview {
  id: number
  name: string
  notes: string
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
  total_recovery_pct: number | null
  component_masses?: Record<string, number> | null
  materials: ReportRunMaterial[]
}

export interface ReportGroup {
  key: string
  composition: Record<string, number>
  cycle_label: string
  n_runs: number
  total_recovery_pct: ReportStat
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
  mass_mg: number
  cycle_key: string
  cycle_label: string
  kind: 'pure' | 'mixture' | 'unknown'
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
  quantify: (curveId: number, regions: RegionIn[]) =>
    api.post<QuantifyItem[]>('/postrun/quantify', { curve_id: curveId, regions }),
  quantifyGaussians: (curveId: number, gaussians: { token: string; channel: string; material: string }[]) =>
    api.post<QuantifyItem[]>('/postrun/quantify', { curve_id: curveId, gaussians }),

  recoveryReport: (req: ReportRequest) => api.post<RecoveryReport>('/postrun/report/recovery', req),
  recoveryReportXlsx: (req: ReportRequest) => api.postBlob('/postrun/report/recovery.xlsx', req),

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
  changeSample: (payload: { tokens: string[]; library_sample_id: number; dry_run?: boolean }) =>
    api.post<ChangeSampleResult>('/postrun/analyses/change-sample', payload),
}

// ---------------------------------------------------------- estudos (22/10/2026)

export type StudyStatus = 'aberto' | 'finalizado'

export interface StudyHeadlineGroup {
  key: string
  n_runs: number
  total_mean: number | null
  total_sd: number | null
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
  exportXlsx: (id: number) => api.getBlob(`/postrun/studies/${id}/export.xlsx`),
  sensitivity: (id: number, tolerances: number[]) => api.post<StudySensitivity>(`/postrun/studies/${id}/sensitivity`, { tolerances }),
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
