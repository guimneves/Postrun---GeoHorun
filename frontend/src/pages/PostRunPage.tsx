import { replicateGroups, sampleOf } from '../lib/replicates'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import {
  METHOD_LABEL,
  postrunApi,
  type AnalysisDetail,
  type AnalysisSummary,
  type BaselineMode,
  type DeconvMethod,
  type DeconvReference,
  type DeconvResult,
  type JobInfo,
  type ChangeSampleResult,
  type MoveBatchResult,
  type Region,
  type QuantifyItem,
  type RegionIn,
  type RegionPreview,
  type SavedCurve,
  type Study,
  studyApi,
} from '../api/postrun'
import { PostRunCalibrationPanel } from '../components/PostRunCalibrationPanel'
import { PostRunCurveViewer } from '../components/PostRunCurveViewer'
import { PostRunSparkline } from '../components/PostRunSparkline'
import { MoveAnalysesBatchModal } from '../components/MoveAnalysesBatchModal'
import { ChangeSampleModal } from '../components/ChangeSampleModal'
import { RenameAnalysisModal } from '../components/RenameAnalysisModal'
import { PostRunScanBar } from '../components/PostRunScanBar'
import { PostRunCurvesTab, type WorkspaceGaussian, type WorkspacePoint } from '../components/PostRunCurvesTab'
import { PostRunDeconvTab } from '../components/PostRunDeconvTab'
import { PostRunMassEdit } from '../components/PostRunMassEdit'
import { PostRunDeconvPanel, type DeconvEntry, type DeconvWindow } from '../components/PostRunDeconvPanel'
import { PostRunReportTab } from '../components/PostRunReportTab'
import { PostRunStudiesTab } from '../components/PostRunStudiesTab'
import { PostRunOverlayPlot } from '../components/PostRunOverlayPlot'
import { PostRunMultiPlot } from '../components/PostRunMultiPlot'
import { PostRunPyrogramPlot } from '../components/PostRunPyrogramPlot'
import { materialColor } from '../lib/postrunColors'
import { fmtNum } from '../lib/postrunFormat'
import { isStdJob, useJobScan } from '../hooks/usePostrunScan'
import { inputClass, inputInlineClass, btnClass, btnPrimaryClass, iconBtnClass, linkBtnClass } from '../ui/classes'
import { Segmented } from '../ui/Segmented'
import { ManualTab } from './ManualTab'
import { RunRecordModal } from '../components/RunRecordModal'
import { runsApi, type RunRecord } from '../api/postrun'
import {
  IconCalib,
  IconChevron,
  IconCurve,
  IconDeconv,
  IconEyeOff,
  IconFolder,
  IconIntegral,
  IconManual,
  IconPencil,
  IconPyrogram,
  IconReport,
  IconSave,
  IconSearch,
  IconStudy,
  IconTag,
  IconBan,
  IconUndo,
} from '../ui/icons'

const CHANNEL_LABELS: Record<string, string> = {
  FID: 'FID', CO: 'CO', CO2: 'CO₂', SO2: 'SO₂',
  GAS4: 'Gás 4', GAS5: 'Gás 5', GAS6: 'Gás 6', GAS7: 'Gás 7', GAS8: 'Gás 8',
}

interface WorkingRegion {
  startIdx: number
  endIdx: number
  label: string
  baselineMode: BaselineMode
  fixedBaseline: number
  // Pedido do usuário (16/10/2026): nada é gravado até o botão "Salvar".
  // `dirty` = alterada na tela e ainda não salva; `removed` = marcada para
  // apagar no próximo "Salvar"; `preview` = área/pico calculados no servidor
  // sem gravar (valem enquanto `sig` bater com os valores da região).
  dirty?: boolean
  removed?: boolean
  preview?: (RegionPreview & { sig: string }) | null
}

function draftSig(w: WorkingRegion): string {
  return [w.startIdx, w.endIdx, w.baselineMode, w.fixedBaseline].join('|')
}

/** chave do rascunho = `${token}|${canal}` (token é caminho de arquivo — sem "|") */
function splitKey(key: string): { token: string; channel: string } {
  const i = key.lastIndexOf('|')
  return { token: key.slice(0, i), channel: key.slice(i + 1) }
}

function toRegionIn(key: string, w: WorkingRegion): RegionIn {
  const { token, channel } = splitKey(key)
  return {
    token, channel, label: w.label, start_idx: w.startIdx, end_idx: w.endIdx,
    baseline_mode: w.baselineMode, fixed_baseline: w.fixedBaseline,
  }
}

type RegionValues = Pick<
  Region,
  'area' | 'area_s' | 'peak_value' | 'peak_idx' | 'peak_temp' | 'area_error' | 'calibrated_mg' | 'calibrated_mg_per_g'
>

interface SummaryRow {
  key: string
  token: string
  channel: string
  label: string
  startIdx: number
  endIdx: number
  baselineMode: BaselineMode
  fixedBaseline: number
  values: RegionValues | null // null = calculando
  state: 'salvo' | 'alterado' | 'remover'
}

function channelKey(curveName: 'pyro' | 'oxi', channel: string): string {
  return `${curveName}:${channel}`
}

/** Parte do nome da análise depois do código da amostra (réplica), para
 * distinguir no workspace duas análises da mesma amostra. */
function replicaTag(filename: string): string {
  const base = filename.replace(/\.[A-Za-z]00$/i, '')
  const m = base.match(/[_ -]([^_ -]+)$/)
  return m ? m[1] : base
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Aba PostRun (pedido do usuário): lê os .B00 gravados pelo equipamento
 * e deixa o usuário trabalhar o sinal bruto (FID/CO/CO2/SO2) — marcar
 * regiões sobre a curva e calcular a área, em várias análises ao mesmo
 * tempo. Não calcula nenhum parâmetro geoquímico (S1/S2/S3/Tmax/TOC/...
 * continua sendo trabalho do GeoWorks). */
/** Ciclo de uma análise: o nome do ciclo no arquivo (CyclN — BASIC, tabaco200…). */
function cycleOf(a: { cycle_name: string }): string {
  return a.cycle_name?.trim() || 'sem ciclo'
}

/** Método do equipamento de uma análise: o CyclT do arquivo (BULK ROCK,
 * MULTI-HEATING RATES, PURE OIL…); sem ele, a pasta do método no job, e por
 * fim a extensão (.B00, .M00…). */
function methodOf(a: { method_folder: string; token: string; filename: string }): string {
  if (a.method_folder?.trim()) return a.method_folder.trim().toUpperCase()
  const parts = a.token.split('/')
  if (parts.length > 2) return parts[parts.length - 2].toUpperCase()
  return (a.filename.match(/\.([A-Za-z])00$/)?.[0] ?? '').toUpperCase() || 'sem método'
}

export function PostRunPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  // análise sendo renomeada (nome/job) — só admin (ver RenameAnalysisModal)
  const [renaming, setRenaming] = useState<AnalysisSummary | null>(null)
  // mover em lote (só admin): as análises marcadas, congeladas ao abrir
  const [movingBatch, setMovingBatch] = useState<string[] | null>(null)
  // trocar a amostra (biblioteca) das análises marcadas — Sample= no .B00 + nome
  const [changingSample, setChangingSample] = useState<string[] | null>(null)
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // Pedido do usuário: primeiro a lista de jobs, depois escolher um, e só
  // então ler os .B00 daquele job — pelo agente, cada .B00 ainda não lido é
  // uma ida e volta até o PC do equipamento. O job escolhido fica lembrado
  // neste navegador.
  const [jobsList, setJobsList] = useState<JobInfo[] | null>(null)
  const [job, setJob] = useState<string>(() => {
    try {
      return localStorage.getItem('postrun-job') ?? ''
    } catch {
      return ''
    }
  })
  const [loadingAnalyses, setLoadingAnalyses] = useState(false)
  // resposta de um job antigo (o usuário trocou no meio) é descartada
  const analysesRequest = useRef(0)
  // Pedido do usuário: escolher o critério de ordenação da lista (nome da
  // amostra, data, análise) — a massa continua sempre visível em cada
  // linha independente do critério escolhido.
  const [sortBy, setSortBy] = useState<'sample' | 'date' | 'analysis' | 'mass'>('sample')
  // lista simplificada (uma linha por análise) e amostras colapsadas
  // (pedido do usuário, 16/10/2026) — a lista completa ocupava muito espaço
  const [compact, setCompact] = useState<boolean>(() => {
    try {
      return localStorage.getItem('postrun-compact') === '1'
    } catch {
      return false
    }
  })
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  function toggleCompact() {
    setCompact((v) => {
      try {
        localStorage.setItem('postrun-compact', v ? '0' : '1')
      } catch {
        // sem localStorage: só não lembra
      }
      return !v
    })
  }
  function toggleCollapsed(sample: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(sample)) next.delete(sample)
      else next.add(sample)
      return next
    })
  }
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  // filtro por método do equipamento (18/11/2026): BULK ROCK (.B00),
  // MULTI-HEATING RATES (.M00), PURE OIL (.O00)… — '' = todos
  const [methodFilter, setMethodFilter] = useState('')
  // filtro por ciclo (18/11/2026): o CyclN do arquivo (BASIC, tabaco200…)
  const [cycleFilter, setCycleFilter] = useState('')

  const [openTokens, setOpenTokens] = useState<string[]>([])
  const [details, setDetails] = useState<Record<string, AnalysisDetail>>({})
  const [regions, setRegions] = useState<Region[]>([])
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({})

  const [activeToken, setActiveToken] = useState<string | null>(null)
  const [activeCurve, setActiveCurve] = useState<'pyro' | 'oxi'>('pyro')
  const [activeChannel, setActiveChannel] = useState<string>('FID')
  // sobrepor os pirogramas das análises abertas, sem integração (23/10/2026)
  const [viewMode, setViewMode] = useState<'pirograma' | 'integracao' | 'sobrepor' | 'multi'>('pirograma') // abre no pirograma; integração é ferramenta (12/11/2026)

  const [working, setWorking] = useState<Record<string, WorkingRegion>>({})
  // Pedido do usuário: uma aba só de calibração, além da de análises
  const [tab, setTab] = useState<'analises' | 'estudos' | 'deconv' | 'curvas' | 'relatorio' | 'calibracao' | 'manual'>('analises')
  // Estudos (pedido do usuário, 22/10/2026): o estudo aberto no workspace —
  // abre as análises dele (como um job) e restringe referências e curvas
  const [studies, setStudies] = useState<Study[]>([])
  // nenhum estudo ativo ao entrar (pedido do usuário, 16/11/2026): a pessoa
  // ativa um estudo à mão; antes o último ficava lembrado e reabria sozinho
  const [activeStudyId, setActiveStudyId] = useState<number | null>(null)
  // resumos das análises do estudo (podem ser de outros jobs)
  const [studyAnalyses, setStudyAnalyses] = useState<Record<string, AnalysisSummary>>({})
  // qual deconvolução salva a aba Análises mostra: gaussiana ou molde (as
  // duas ficam salvas lado a lado — pedido do usuário, 17/10/2026)
  const [deconvMethod, setDeconvMethod] = useState<DeconvMethod>('gauss')
  // aba Análises em etapas (pedido do usuário, 16/10/2026: estava poluída)
  const [step, setStep] = useState<'regiao' | 'deconv' | 'calib'>('regiao')
  // quantificador: curva escolhida e resultados por linha do resumo
  const [curves, setCurves] = useState<SavedCurve[]>([])
  const [quantCurveId, setQuantCurveId] = useState<number | ''>('')
  const [quantResults, setQuantResults] = useState<Record<string, QuantifyItem>>({})
  // Deconvolução (Fase 3): ajustes por análise + canal (`${token}|${canal}`),
  // rascunho até o Salvar; referências dos materiais puros
  const [deconvs, setDeconvs] = useState<Record<string, DeconvEntry>>({})
  const [references, setReferences] = useState<DeconvReference[]>([])
  const [gaussQuant, setGaussQuant] = useState<Record<string, QuantifyItem & { curveName: string }>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [applyTargets, setApplyTargets] = useState<Set<string>>(new Set())

  // Pedido do usuário: mini-curva de FID por linha da lista pra descartar
  // rápido as corridas ruins. `undefined` = ainda não carregado, `null` =
  // erro/sem FID, array = os ~48 pontos normalizados.
  const [sparklines, setSparklines] = useState<Record<string, number[] | null>>({})
  // "eliminar rapidamente" = esconder da lista (reversível, só no
  // navegador — nunca apaga o `.B00`).
  // F4: ficha de rastreabilidade (exclusão com motivo, metadados) por corrida
  const [runRecords, setRunRecords] = useState<Record<string, RunRecord>>({})
  const [recordTokens, setRecordTokens] = useState<string[] | null>(null)
  const [hiddenTokens, setHiddenTokens] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem('postrun-hidden-tokens') ?? '[]'))
    } catch {
      return new Set<string>()
    }
  })
  const [showHidden, setShowHidden] = useState(false)

  function persistHidden(next: Set<string>) {
    setHiddenTokens(next)
    try {
      localStorage.setItem('postrun-hidden-tokens', JSON.stringify(Array.from(next)))
    } catch {
      // navegador sem localStorage — só não persiste entre sessões
    }
  }

  function toggleHidden(token: string) {
    const next = new Set(hiddenTokens)
    if (next.has(token)) next.delete(token)
    else {
      next.add(token)
      setOpenTokens((prev) => prev.filter((t) => t !== token))
      if (activeToken === token) setActiveToken(null)
    }
    persistHidden(next)
  }

  function reloadJobs() {
    postrunApi
      .listJobs()
      .then(setJobsList)
      .catch((err) => {
        setJobsList([])
        setLoadError(err instanceof ApiError ? err.message : 'Erro ao listar os jobs')
      })
  }
  useEffect(reloadJobs, [])

  function reloadAnalyses(forJob: string = job, quiet = false) {
    const request = ++analysesRequest.current
    if (!forJob) {
      setAnalyses([])
      setLoadingAnalyses(false)
      return
    }
    if (!quiet) setLoadingAnalyses(true)
    setLoadError(null)
    postrunApi
      .listAnalyses(forJob)
      .then((items) => {
        if (request === analysesRequest.current) setAnalyses(items)
      })
      .catch((err) => {
        if (request === analysesRequest.current)
          setLoadError(err instanceof ApiError ? err.message : 'Erro ao listar análises')
      })
      .finally(() => {
        if (request === analysesRequest.current) setLoadingAnalyses(false)
      })
  }
  // Pedido do usuário (16/10/2026): o servidor lê os .B00 do job em segundo
  // plano; a lista vai sendo recarregada (só do cache, instantâneo) conforme
  // os arquivos chegam — dá para trabalhar enquanto o agente lê o resto.
  const scan = useJobScan(job, () => reloadAnalyses(job, true))

  // job lembrado que não existe mais (renomeado/apagado no equipamento)
  useEffect(() => {
    if (jobsList && job && !jobsList.some((j) => j.name === job)) chooseJob('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsList])

  function chooseJob(name: string) {
    if (name !== job) setAnalyses([])
    setJob(name)
    setSearch('')
    try {
      localStorage.setItem('postrun-job', name)
    } catch {
      // navegador sem localStorage — só não lembra o job
    }
  }

  // Depois de renomear, o token (caminho do .B00) muda: troca o antigo
  // pelo novo no workspace aberto, para não perder o que estava na tela.
  function handleRenamed(oldToken: string, newToken: string) {
    setRenaming(null)
    replaceTokens(new Map([[oldToken, newToken]]))
  }

  // Trocar a amostra: as que mudaram de nome trocam de token no workspace;
  // todas relêem o .B00 (o Sample= mudou)
  function handleSampleChanged(result: ChangeSampleResult) {
    setChangingSample(null)
    const moved = new Map<string, string>()
    for (const item of result.items) if (item.status === 'done' && item.new_token) moved.set(item.token, item.new_token)
    replaceTokens(moved)
    // o conteúdo mudou (Sample=): relê o detalhe das trocadas
    const changed = new Set(result.items.filter((i) => i.status === 'done').map((i) => i.new_token ?? i.token))
    setDetails((prev) => Object.fromEntries(Object.entries(prev).filter(([t]) => !changed.has(t))))
    scan.rescan()
    const codes = new Set(result.items.filter((i) => i.status === 'done' && i.code).map((i) => i.code))
    setMessage(
      (result.code ? `Amostra ${result.code}` : `${codes.size} amostra(s)`) +
        `: ${result.done} análise(s) trocada(s)` +
        (result.failed ? `, ${result.failed} não trocada(s)` : '') +
        (result.skipped ? `, ${result.skipped} ignorada(s)` : '') +
        '.',
    )
  }

  // Mover em lote: as que andaram trocam de token no workspace (como no
  // renomear); as que falharam ficam onde estavam, marcadas.
  function handleBatchMoved(result: MoveBatchResult) {
    setMovingBatch(null)
    const moved = new Map<string, string>()
    for (const item of result.items) if (item.status === 'done' && item.new_token) moved.set(item.token, item.new_token)
    replaceTokens(moved)
    setMessage(
      `Mover em lote para ${result.job}: ${result.done} movida(s)` +
        (result.failed ? `, ${result.failed} não movida(s)` : '') +
        (result.skipped ? `, ${result.skipped} ignorada(s)` : '') +
        '.',
    )
  }

  function replaceTokens(map: Map<string, string>) {
    if (map.size > 0) {
      setOpenTokens((prev) => prev.map((t) => map.get(t) ?? t))
      setActiveToken((prev) => (prev && map.has(prev) ? map.get(prev)! : prev))
      setDetails((prev) => {
        const next: Record<string, AnalysisDetail> = {}
        for (const [t, d] of Object.entries(prev)) next[map.get(t) ?? t] = d
        return next
      })
      // rascunhos não salvos acompanham o novo caminho
      setWorking((prev) => {
        const next: Record<string, WorkingRegion> = {}
        for (const [k, w] of Object.entries(prev)) {
          const { token, channel } = splitKey(k)
          next[`${map.get(token) ?? token}|${channel}`] = w
        }
        return next
      })
    }
    scan.rescan() // os caminhos mudaram: lista o job de novo
    reloadJobs()
  }

  function refreshRegions() {
    if (openTokens.length === 0) return
    postrunApi.listRegions(openTokens).then(setRegions).catch(() => {})
    postrunApi
      .listDeconv(openTokens, deconvMethod)
      .then((items) =>
        setDeconvs((prev) => {
          // troca de método: sai o que estava salvo do outro (rascunhos ficam)
          const next = Object.fromEntries(Object.entries(prev).filter(([, d]) => d.dirty))
          for (const r of items) {
            const key = `${r.spec.token}|${r.spec.channel}`
            if (!next[key]?.dirty) next[key] = { result: r, dirty: false, savedId: r.id }
          }
          return next
        }),
      )
      .catch(() => {})
  }

  function loadReferences() {
    postrunApi.listReferences().then(setReferences).catch(() => setReferences([]))
  }
  useEffect(loadReferences, [])

  function reloadStudies() {
    studyApi.list().then(setStudies).catch(() => setStudies([]))
  }
  useEffect(reloadStudies, [])

  function rememberStudy(id: number | null) {
    setActiveStudyId(id)
    try {
      localStorage.removeItem('postrun-study') // chave antiga (o estudo reabria sozinho)
    } catch {
      // sem localStorage: nada a limpar
    }
  }

  async function openStudy(id: number, goTo?: 'deconv' | 'curvas' | 'relatorio') {
    try {
      const d = await studyApi.get(id)
      const ok = d.analyses.filter((a) => a.ok && a.summary)
      setStudyAnalyses(Object.fromEntries(ok.map((a) => [a.token, a.summary as AnalysisSummary])))
      setOpenTokens(ok.map((a) => a.token))
      setActiveToken(ok[0]?.token ?? null)
      rememberStudy(id)
      if (goTo) setTab(goTo)
    } catch (err) {
      rememberStudy(null)
      setMessage(err instanceof ApiError ? err.message : 'Erro ao abrir o estudo')
    }
  }

  function closeStudy() {
    rememberStudy(null)
    setStudyAnalyses({})
    setOpenTokens([])
    setActiveToken(null)
  }

  // referências e curvas: com um estudo aberto, as dele + as de nenhum estudo;
  // sem estudo, somem as de estudos finalizados (ficam guardadas lá)
  const studyFilter = useMemo(() => {
    const active = studies.find((s) => s.id === activeStudyId) ?? null
    const inAny = { ref: new Set<number>(), curve: new Set<number>() }
    const archived = { ref: new Set<number>(), curve: new Set<number>() }
    for (const s of studies) {
      s.reference_ids.forEach((i) => inAny.ref.add(i))
      s.curve_ids.forEach((i) => inAny.curve.add(i))
      if (s.status === 'finalizado') {
        s.reference_ids.forEach((i) => archived.ref.add(i))
        s.curve_ids.forEach((i) => archived.curve.add(i))
      }
    }
    const pick = (kind: 'ref' | 'curve', own: number[] | undefined) => (id: number) =>
      own ? own.includes(id) || !inAny[kind].has(id) : !archived[kind].has(id)
    return { active, ref: pick('ref', active?.reference_ids), curve: pick('curve', active?.curve_ids) }
  }, [studies, activeStudyId])
  const shownReferences = useMemo(() => references.filter((r) => studyFilter.ref(r.id)), [references, studyFilter])

  // Busca detalhe completo (curvas) só das análises abertas que ainda não
  // estão em cache, e recarrega as regiões salvas pra todo o workspace.
  useEffect(() => {
    if (openTokens.length === 0) return
    const missing = openTokens.filter((t) => !(t in details) && !(t in detailErrors))
    if (missing.length > 0) {
      postrunApi.getBatch(missing).then((items) => {
        setDetails((prev) => {
          const next = { ...prev }
          for (const item of items) if (item.ok && item.data) next[item.token] = item.data
          return next
        })
        setDetailErrors((prev) => {
          const next = { ...prev }
          for (const item of items) if (!item.ok) next[item.token] = item.error || 'Erro ao ler análise'
          return next
        })
      })
    }
    refreshRegions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTokens])

  useEffect(() => {
    refreshRegions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deconvMethod])

  const jobs = useMemo(() => (jobsList ?? []).map((j) => j.name).sort(), [jobsList])
  // jobs de padrões (STD) — a calibração lê as corridas deles também
  const stdJobs = useMemo(() => (jobsList ?? []).filter((j) => isStdJob(j.name)).map((j) => j.name), [jobsList])

  const methods = useMemo(() => {
    const count = new Map<string, number>()
    for (const a of analyses) count.set(methodOf(a), (count.get(methodOf(a)) ?? 0) + 1)
    return [...count.entries()].sort((x, y) => x[0].localeCompare(y[0]))
  }, [analyses])
  useEffect(() => {
    if (methodFilter && !methods.some(([m]) => m === methodFilter)) setMethodFilter('')
  }, [methods, methodFilter])
  // ciclos das análises do método escolhido (o filtro de ciclo segue o de método)
  const cycles = useMemo(() => {
    const count = new Map<string, { n: number; labels: Set<string> }>()
    for (const a of analyses) {
      if (methodFilter && methodOf(a) !== methodFilter) continue
      const c = cycleOf(a)
      const e = count.get(c) ?? { n: 0, labels: new Set<string>() }
      e.n += 1
      if (a.cycle_label) e.labels.add(a.cycle_label)
      count.set(c, e)
    }
    return [...count.entries()].sort((x, y) => x[0].localeCompare(y[0]))
  }, [analyses, methodFilter])
  useEffect(() => {
    if (cycleFilter && !cycles.some(([c]) => c === cycleFilter)) setCycleFilter('')
  }, [cycles, cycleFilter])

  // réplicas pelo nome (18/11/2026): "X1", "X2", "X3" de antes do Horun = a amostra X
  const repGroups = useMemo(
    () => replicateGroups(analyses.map((a) => ({ sample: a.sample, method: methodOf(a) }))),
    [analyses],
  )
  const sampleKey = (a: { sample: string }) => sampleOf(a.sample, repGroups)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return analyses.filter((a) => {
      if (methodFilter && methodOf(a) !== methodFilter) return false
      if (cycleFilter && cycleOf(a) !== cycleFilter) return false
      if (dateFrom && (!a.date || a.date.slice(0, 10) < dateFrom)) return false
      if (dateTo && (!a.date || a.date.slice(0, 10) > dateTo)) return false
      if (!q) return true
      return (
        a.sample.toLowerCase().includes(q) ||
        sampleKey(a).toLowerCase().includes(q) ||
        a.filename.toLowerCase().includes(q) ||
        a.job.toLowerCase().includes(q)
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyses, search, dateFrom, dateTo, methodFilter, cycleFilter, repGroups])

  // Pedido do usuário: escolher o critério de ordenação (amostra, data,
  // análise, massa) — agrupado por amostra pra facilitar seleção múltipla
  // de todas as réplicas de uma mesma amostra de uma vez (1.1).
  const sortedFiltered = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => {
      switch (sortBy) {
        case 'date':
          return (b.date ?? '').localeCompare(a.date ?? '')
        case 'analysis':
          return a.filename.localeCompare(b.filename)
        case 'mass':
          return b.quantity_mg - a.quantity_mg
        case 'sample':
        default:
          return sampleKey(a).localeCompare(sampleKey(b)) || a.filename.localeCompare(b.filename)
      }
    })
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortBy, repGroups])

  const visible = useMemo(
    () => (showHidden ? sortedFiltered : sortedFiltered.filter((a) => !hiddenTokens.has(a.token))),
    [sortedFiltered, showHidden, hiddenTokens],
  )

  const groups = useMemo(() => {
    const map = new Map<string, AnalysisSummary[]>()
    for (const a of visible) {
      const key = sampleKey(a)
      const list = map.get(key)
      if (list) list.push(a)
      else map.set(key, [a])
    }
    return Array.from(map.entries())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, repGroups])

  // Carrega as miniaturas de FID das análises visíveis que ainda não
  // estão em cache, em blocos, pra lista ir preenchendo progressivamente.
  useEffect(() => {
    if (compact) return // lista simples não mostra as miniaturas
    const missing = visible
      .filter((a) => !collapsed.has(sampleKey(a)))
      .map((a) => a.token)
      .filter((t) => !(t in sparklines))
    if (missing.length === 0) return
    let cancelled = false
    ;(async () => {
      for (let i = 0; i < missing.length && !cancelled; i += 40) {
        const chunk = missing.slice(i, i + 40)
        try {
          const res = await postrunApi.getSparklines(chunk)
          if (cancelled) return
          setSparklines((prev) => {
            const next = { ...prev }
            for (const s of res) next[s.token] = s.values
            return next
          })
        } catch {
          if (cancelled) return
          setSparklines((prev) => {
            const next = { ...prev }
            for (const t of chunk) next[t] = null
            return next
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, compact, collapsed])

  function toggleOpen(token: string) {
    setOpenTokens((prev) => {
      if (prev.includes(token)) {
        if (activeToken === token) setActiveToken(null)
        return prev.filter((t) => t !== token)
      }
      setActiveToken(token)
      return [...prev, token]
    })
  }

  // 1.1 — seleção múltipla por amostra: liga/desliga todas as réplicas de
  // um grupo (mesmo nome de amostra) de uma vez.
  function toggleGroup(tokens: string[]) {
    setOpenTokens((prev) => {
      const allOpen = tokens.every((t) => prev.includes(t))
      if (allOpen) {
        const next = prev.filter((t) => !tokens.includes(t))
        if (activeToken && tokens.includes(activeToken)) setActiveToken(next[0] ?? null)
        return next
      }
      const toAdd = tokens.filter((t) => !prev.includes(t))
      if (!activeToken && toAdd.length > 0) setActiveToken(toAdd[0])
      return [...prev, ...toAdd]
    })
  }

  function selectAllFiltered() {
    const tokens = visible.map((a) => a.token)
    setOpenTokens((prev) => {
      const merged = [...prev, ...tokens.filter((t) => !prev.includes(t))]
      if (!activeToken && merged.length > 0) setActiveToken(merged[0])
      return merged
    })
  }

  function clearSelection() {
    setOpenTokens([])
    setActiveToken(null)
  }

  const activeDetail = activeToken ? details[activeToken] : null
  const activeCurveData = activeDetail ? (activeCurve === 'pyro' ? activeDetail.pyro : activeDetail.oxi) : null

  const availableChannels = useMemo(() => {
    if (!activeCurveData) return []
    return Object.keys(activeCurveData.channels).filter((c) => activeCurveData.channels[c].some((v) => v !== 0))
  }, [activeCurveData])

  useEffect(() => {
    if (availableChannels.length > 0 && !availableChannels.includes(activeChannel)) {
      setActiveChannel(availableChannels[0])
    }
  }, [availableChannels, activeChannel])

  const activeKey = activeToken ? channelKey(activeCurve, activeChannel) : null
  const persistedRegion =
    activeToken && activeKey ? regions.find((r) => r.token === activeToken && r.channel === activeKey) : undefined
  const workKey = activeToken && activeKey ? `${activeToken}|${activeKey}` : null

  // Semeia a região de trabalho: a persistida (se existir), senão um
  // rascunho local a partir do cursor auto do GeoWorks (só como ponto de
  // partida — o usuário ajusta livremente), senão o terço do meio da
  // curva como fallback.
  useEffect(() => {
    if (!workKey || !activeCurveData || !activeKey) return
    const existing = working[workKey]
    // alteração não salva nunca é sobrescrita; sem região salva, o rascunho fica
    if (existing && (existing.dirty || !persistedRegion)) return
    if (persistedRegion) {
      if (
        existing &&
        existing.startIdx === persistedRegion.start_idx &&
        existing.endIdx === persistedRegion.end_idx &&
        existing.label === persistedRegion.label &&
        existing.baselineMode === persistedRegion.baseline_mode &&
        existing.fixedBaseline === persistedRegion.fixed_baseline
      )
        return
      // região salva (ou acabou de ser salva/aplicada): a tela mostra ela
      setWorking((prev) => ({
        ...prev,
        [workKey]: {
          startIdx: persistedRegion.start_idx, endIdx: persistedRegion.end_idx,
          label: persistedRegion.label, baselineMode: persistedRegion.baseline_mode,
          fixedBaseline: persistedRegion.fixed_baseline,
        },
      }))
      return
    }
    const auto = activeDetail?.cursors_auto[activeKey]
    const n = activeCurveData.idx.length
    const fallbackStart = Math.floor(n / 3)
    const fallbackEnd = Math.floor((2 * n) / 3)
    const startIdx = auto && auto.values.length > 0 ? auto.values[0] : activeCurveData.idx[fallbackStart] ?? 0
    const endIdx =
      auto && auto.values.length > 0
        ? auto.values[auto.values.length - 1]
        : activeCurveData.idx[fallbackEnd] ?? n - 1
    setWorking((prev) => ({
      ...prev,
      [workKey]: {
        startIdx, endIdx, label: CHANNEL_LABELS[activeChannel] ?? activeChannel,
        baselineMode: 'fixed', fixedBaseline: auto?.base ?? activeDetail?.baseline[activeKey] ?? 0,
      },
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workKey, persistedRegion, activeCurveData, activeDetail, activeKey])

  const currentWorking = workKey ? working[workKey] : undefined

  function updateWorking(patch: Partial<WorkingRegion>) {
    if (!workKey) return
    setWorking((prev) => ({ ...prev, [workKey]: { ...prev[workKey], dirty: true, ...patch } }))
  }

  // Área/pico das regiões alteradas, calculados no servidor SEM gravar.
  async function previewDrafts(entries: [string, WorkingRegion][]) {
    const live = entries.filter(([, w]) => !w.removed)
    if (live.length === 0) return
    try {
      const res = await postrunApi.previewRegions(live.map(([k, w]) => toRegionIn(k, w)))
      setWorking((prev) => {
        const next = { ...prev }
        live.forEach(([k, w], i) => {
          const cur = next[k]
          if (cur && draftSig(cur) === draftSig(w)) next[k] = { ...cur, preview: { ...res[i], sig: draftSig(w) } }
        })
        return next
      })
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao calcular a área')
    }
  }

  // recalcula a prévia da região ativa um instante depois de cada ajuste
  useEffect(() => {
    if (!workKey || !currentWorking?.dirty || currentWorking.removed) return
    if (currentWorking.preview?.sig === draftSig(currentWorking)) return
    const draft = currentWorking
    const key = workKey
    const timer = window.setTimeout(() => void previewDrafts([[key, draft]]), 400)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workKey, currentWorking])

  // arrastar/digitar só muda a tela — gravar é no "Salvar"
  function commitRegion(startIdx: number, endIdx: number) {
    updateWorking({ startIdx, endIdx })
  }

  function savedRegionFor(key: string): Region | undefined {
    const { token, channel } = splitKey(key)
    return regions.find((r) => r.token === token && r.channel === channel)
  }

  /** Usar a sugestão (cursor do GeoWorks) como região desta análise. */
  function adoptSuggestion() {
    updateWorking({ removed: false })
  }

  function discardChanges() {
    if (!workKey) return
    setWorking((prev) => {
      const next = { ...prev }
      delete next[workKey] // volta à salva (ou à sugestão) — o efeito semeia de novo
      return next
    })
  }

  function removeRegion() {
    if (!workKey) return
    if (persistedRegion) updateWorking({ removed: true })
    else discardChanges()
  }

  // 2.2 — "Aplicar a todas as abertas" / "às marcadas": copia a região da
  // tela (canal, faixa, rótulo, baseline — mesmo o que ainda não foi salvo)
  // para as outras análises, que ficam alteradas até o "Salvar". Bug
  // reportado (16/10/2026): antes gravava direto no banco, mas a tela das
  // outras análises continuava mostrando o rascunho antigo (e um arraste
  // por cima sobrescrevia) — parecia que não tinha salvado.
  function applyRegionTo(targets: string[]) {
    if (targets.length === 0 || !activeToken || !activeKey || !currentWorking || !workKey) return
    const base: WorkingRegion = {
      startIdx: currentWorking.startIdx, endIdx: currentWorking.endIdx, label: currentWorking.label,
      baselineMode: currentWorking.baselineMode, fixedBaseline: currentWorking.fixedBaseline,
      dirty: true, removed: false, preview: null,
    }
    const entries: [string, WorkingRegion][] = targets
      .filter((t) => t !== activeToken)
      .map((t) => [`${t}|${activeKey}`, { ...base }])
    setWorking((prev) => {
      const next = { ...prev }
      for (const [k, w] of entries) next[k] = w
      // a própria região de origem também entra no Salvar
      if (!persistedRegion && !prev[workKey]?.dirty) next[workKey] = { ...prev[workKey], dirty: true, removed: false }
      return next
    })
    setApplyTargets(new Set())
    setMessage(`Região aplicada em ${entries.length} análise(s) — confira e toque em Salvar para gravar.`)
    void previewDrafts(entries)
  }

  const dirtyEntries = useMemo(() => Object.entries(working).filter(([, w]) => w.dirty), [working])
  const dirtyDeconvs = useMemo(() => Object.entries(deconvs).filter(([, d]) => d.dirty), [deconvs])
  const unsavedCount = dirtyEntries.length + dirtyDeconvs.length

  // aviso ao fechar/recarregar a página com alterações não salvas
  useEffect(() => {
    if (unsavedCount === 0) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [unsavedCount])

  async function saveAll() {
    if (unsavedCount === 0) return
    const upserts = dirtyEntries.filter(([, w]) => !w.removed).map(([k, w]) => toRegionIn(k, w))
    const deleteIds = dirtyEntries
      .filter(([, w]) => w.removed)
      .map(([k]) => savedRegionFor(k)?.id)
      .filter((id): id is number => id !== undefined)
    const deconvUpserts = dirtyDeconvs.filter(([, d]) => !d.removed).map(([, d]) => d.result.spec)
    const deconvDeletes = dirtyDeconvs
      .filter(([, d]) => d.removed && d.savedId)
      .map(([, d]) => d.savedId as number)
    setBusy(true)
    setMessage(null)
    try {
      if (deconvUpserts.length || deconvDeletes.length) {
        const savedDeconvs = await postrunApi.saveDeconv(deconvUpserts, deconvDeletes)
        setDeconvs((prev) => {
          const next = { ...prev }
          for (const [k, d] of dirtyDeconvs) if (d.removed) delete next[k]
          for (const r of savedDeconvs) next[`${r.spec.token}|${r.spec.channel}`] = { result: r, dirty: false, savedId: r.id }
          return next
        })
      }
      const saved = upserts.length || deleteIds.length ? await postrunApi.saveRegions(upserts, deleteIds) : []
      setRegions((prev) => {
        const savedKeys = new Set(saved.map((r) => `${r.token}|${r.channel}`))
        const kept = prev.filter((r) => !deleteIds.includes(r.id) && !savedKeys.has(`${r.token}|${r.channel}`))
        return [...kept, ...saved]
      })
      setWorking((prev) => {
        const next = { ...prev }
        for (const [k, w] of dirtyEntries) {
          if (w.removed) delete next[k]
          else if (next[k] && draftSig(next[k]) === draftSig(w)) next[k] = { ...next[k], dirty: false, preview: null }
        }
        return next
      })
      setMessage(
        `Salvo: ${upserts.length} região(ões)` +
          (deleteIds.length ? `, ${deleteIds.length} removida(s)` : '') +
          (deconvUpserts.length || deconvDeletes.length
            ? `; ${deconvUpserts.length} deconvolução(ões)` + (deconvDeletes.length ? `, ${deconvDeletes.length} removida(s)` : '')
            : '') +
          '.',
      )
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao salvar — nada foi gravado, tente de novo')
    } finally {
      setBusy(false)
    }
  }

  const analysesByToken = useMemo(
    () => ({ ...studyAnalyses, ...Object.fromEntries(analyses.map((a) => [a.token, a])) }),
    [analyses, studyAnalyses],
  )

  // F4: fichas (exclusão, metadados) das análises listadas
  const listedKey = analyses.map((a) => a.token).join('|')
  useEffect(() => {
    const tokens = listedKey ? listedKey.split('|') : []
    if (!tokens.length) return
    let alive = true
    runsApi
      .records(tokens)
      .then((rs) => alive && setRunRecords((prev) => ({ ...prev, ...Object.fromEntries(rs.map((r) => [r.token, r])) })))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [listedKey])

  function mergeAnalyses(items: AnalysisSummary[]) {
    const byToken = new Map(items.map((a) => [a.token, a]))
    setAnalyses((prev) => prev.map((a) => byToken.get(a.token) ?? a))
    setStudyAnalyses((prev) => Object.fromEntries(Object.entries(prev).map(([t, a]) => [t, byToken.get(t) ?? a])))
  }

  // curvas salvas, para o quantificador do resumo
  useEffect(() => {
    if (tab !== 'analises') return
    postrunApi.listCurves().then(setCurves).catch(() => setCurves([]))
  }, [tab])

  // Resumo: as regiões salvas + as alteradas na tela (ainda não salvas)
  const summary = useMemo<SummaryRow[]>(() => {
    const rows = new Map<string, SummaryRow>()
    for (const r of regions) {
      const key = `${r.token}|${r.channel}`
      rows.set(key, {
        key, token: r.token, channel: r.channel, label: r.label, startIdx: r.start_idx, endIdx: r.end_idx,
        baselineMode: r.baseline_mode, fixedBaseline: r.fixed_baseline, values: r, state: 'salvo',
      })
    }
    for (const [key, w] of dirtyEntries) {
      const { token, channel } = splitKey(key)
      const prev = rows.get(key)
      rows.set(key, {
        key, token, channel, label: w.label, startIdx: w.startIdx, endIdx: w.endIdx,
        baselineMode: w.baselineMode, fixedBaseline: w.fixedBaseline,
        values: w.removed ? (prev?.values ?? null) : w.preview && w.preview.sig === draftSig(w) ? w.preview : null,
        state: w.removed ? 'remover' : 'alterado',
      })
    }
    return Array.from(rows.values())
  }, [regions, dirtyEntries])

  // regiões do FID das análises abertas (pontos da aba Curvas)
  const workspacePoints = useMemo<WorkspacePoint[]>(
    () =>
      summary
        .filter((r) => r.channel === 'pyro:FID' && r.state !== 'remover' && openTokens.includes(r.token))
        .map((r) => ({
          key: r.key,
          token: r.token,
          region: {
            token: r.token, channel: r.channel, label: r.label, start_idx: r.startIdx, end_idx: r.endIdx,
            baseline_mode: r.baselineMode, fixed_baseline: r.fixedBaseline,
          },
        })),
    [summary, openTokens],
  )

  const quantCurve = curves.find((c) => c.id === quantCurveId) ?? null

  // janela da deconvolução = a região da análise no canal (rascunho ou salva)
  function windowFor(t: string): DeconvWindow | null {
    if (!activeKey) return null
    const w = working[`${t}|${activeKey}`]
    if (w && !w.removed) return { startIdx: w.startIdx, endIdx: w.endIdx, baselineMode: w.baselineMode, fixedBaseline: w.fixedBaseline }
    const r = regions.find((x) => x.token === t && x.channel === activeKey)
    return r ? { startIdx: r.start_idx, endIdx: r.end_idx, baselineMode: r.baseline_mode, fixedBaseline: r.fixed_baseline } : null
  }

  function addDeconvResults(items: DeconvResult[]) {
    setDeconvs((prev) => {
      const next = { ...prev }
      for (const r of items) {
        const key = `${r.spec.token}|${r.spec.channel}`
        next[key] = { result: r, dirty: true, savedId: prev[key]?.savedId ?? null }
      }
      return next
    })
  }

  function removeDeconv() {
    if (!workKey) return
    setDeconvs((prev) => {
      const next = { ...prev }
      const cur = next[workKey]
      if (!cur) return prev
      if (cur.savedId) next[workKey] = { ...cur, dirty: true, removed: true }
      else delete next[workKey]
      return next
    })
  }

  const activeDeconv = workKey ? deconvs[workKey] : undefined
  // modo molde: o molde do PURO de cada componente (tracejado, mesma área) por
  // cima do componente ajustado — mostra o deslocamento e a dilatação (24/10/2026)
  const [showPure, setShowPure] = useState(true)
  const overlays = useMemo(() => {
    const c = activeDeconv && !activeDeconv.removed ? activeDeconv.result.curve : null
    if (!c || !activeCurveData) return []
    const raw = activeCurveData.channels[activeChannel] ?? []
    const pos = new Map(activeCurveData.idx.map((v, i) => [v, i]))
    const base = c.idx.map((x, i) => (raw[pos.get(x) ?? -1] ?? c.signal[i]) - c.signal[i])
    return [
      ...c.components.map((vals, k) => ({
        idx: c.idx, values: vals.map((v, i) => v + base[i]), color: materialColor(activeDeconv!.result.peaks[k]?.name ?? '', activeDeconv!.result.peaks.map((q) => q.name)), width: 1.6,
        label: activeDeconv!.result.peaks[k]?.name,
      })),
      ...(showPure
        ? (c.pure_components ?? []).flatMap((vals, k) =>
            vals.length
              ? [{
                  idx: c.idx, values: vals.map((v, i) => v + base[i]), color: materialColor(activeDeconv!.result.peaks[k]?.name ?? '', activeDeconv!.result.peaks.map((q) => q.name)), width: 1.2,
                  dash: '2 3', label: `${activeDeconv!.result.peaks[k]?.name} · molde do puro`,
                }]
              : [],
          )
        : []),
      { idx: c.idx, values: c.fitted.map((v, i) => v + base[i]), color: 'var(--color-text)', width: 1.2, dash: '5 3', label: 'soma dos picos' },
    ]
  }, [activeDeconv, activeCurveData, activeChannel, showPure])
  const hasPure = !!activeDeconv?.result.curve?.pure_components?.some((v) => v.length)

  const workspaceGaussians = useMemo<WorkspaceGaussian[]>(() => {
    const out: WorkspaceGaussian[] = []
    for (const d of Object.values(deconvs)) {
      const sp = d.result.spec
      if (d.dirty || d.removed || sp.channel !== 'pyro:FID' || !openTokens.includes(sp.token)) continue
      for (const material of new Set(d.result.peaks.map((p) => p.material))) {
        out.push({
          token: sp.token, material,
          region: {
            token: sp.token, channel: sp.channel, label: material, start_idx: sp.start_idx, end_idx: sp.end_idx,
            baseline_mode: sp.baseline_mode, fixed_baseline: sp.fixed_baseline,
          },
        })
      }
    }
    return out
  }, [deconvs, openTokens])

  // tabela das amostras virtuais (um pico por linha)
  const gaussRows = useMemo(() => {
    const rows: { key: string; token: string; channel: string; entry: DeconvEntry; peak: DeconvResult['peaks'][number] }[] = []
    for (const [key, d] of Object.entries(deconvs)) {
      if (!openTokens.includes(d.result.spec.token)) continue
      for (const peak of d.result.peaks) rows.push({ key: `${key}|${peak.name}`, token: d.result.spec.token, channel: d.result.spec.channel, entry: d, peak })
    }
    return rows
  }, [deconvs, openTokens])

  useEffect(() => setGaussQuant({}), [deconvs])

  async function quantifyGaussians() {
    const saved = gaussRows.filter((r) => !r.entry.dirty && !r.entry.removed)
    if (saved.length === 0) {
      setMessage('Salve as deconvoluções antes de quantificar as gaussianas.')
      return
    }
    setBusy(true)
    const out: Record<string, QuantifyItem & { curveName: string }> = {}
    const missing = new Set<string>()
    try {
      const allCurves = await postrunApi.listCurves()
      setCurves(allCurves)
      const byMaterial = new Map<string, typeof saved>()
      for (const r of saved) byMaterial.set(r.peak.material, [...(byMaterial.get(r.peak.material) ?? []), r])
      for (const [material, rows] of byMaterial) {
        const curve = allCurves.find((c) => c.area_source === 'gaussian' && c.component === material && c.channel === rows[0].channel)
        if (!curve) {
          missing.add(material)
          continue
        }
        // material somado (vários picos do mesmo material = uma amostra virtual)
        const uniq = Array.from(new Map(rows.map((r) => [r.token, r])).values())
        const res = await postrunApi.quantifyGaussians(curve.id, uniq.map((r) => ({ token: r.token, channel: r.channel, material })))
        uniq.forEach((r, i) => {
          for (const row of rows.filter((x) => x.token === r.token)) out[row.key] = { ...res[i], curveName: curve.name }
        })
      }
      setGaussQuant(out)
      if (missing.size)
        setMessage(`Sem curva de gaussiana para: ${Array.from(missing).join(', ')} — crie na aba Curvas (Área de: Gaussiana).`)
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao quantificar as gaussianas')
    } finally {
      setBusy(false)
    }
  }

  function exportGaussiansCsv() {
    const rows: (string | number)[][] = [[
      'token', 'amostra', 'composição', 'massa_mg', 'pico', 'material', 'tpico_c', 'delta_tmax_c', 'área_sinal_s', 'u_área',
      '%_do_total', 'largura_s', 'delta_largura_%', 'r2_ajuste', 'forma', 'modo', 'massa_curva_mg', 'U95_mg',
      'massa_esperada_mg', 'recuperação_%', 'curva', 'situação',
    ]]
    for (const r of gaussRows) {
      const a = analysesByToken[r.token]
      const q = gaussQuant[r.key]
      const p = r.peak
      rows.push([
        r.token, a?.sample ?? '', a?.composition_text ?? '', a?.mass_mg ?? '', p.name, p.material, p.mu_c ?? '', p.delta_mu_c ?? '',
        p.area_s, p.u_area_s, p.pct_of_total, p.fwhm_s, p.delta_width_pct ?? '', r.entry.result.r2, r.entry.result.spec.shape,
        r.entry.result.spec.mode, q?.mass_mg ?? '', q?.U95_mg ?? '', q?.expected_mg ?? '', q?.recovery_pct ?? '', q?.curveName ?? '',
        r.entry.removed ? 'será removida' : r.entry.dirty ? 'não salvo' : 'salvo',
      ])
    }
    downloadCsv(`postrun_gaussianas_${new Date().toISOString().slice(0, 10)}.csv`, rows)
  }

  async function runQuantify() {
    if (!quantCurve) return
    const rows = summary.filter((r) => r.channel === quantCurve.channel && r.state !== 'remover')
    if (rows.length === 0) {
      setMessage(`Nenhuma região do canal ${quantCurve.channel} no resumo.`)
      return
    }
    setBusy(true)
    try {
      const res = await postrunApi.quantify(
        quantCurve.id,
        rows.map((r) => ({
          token: r.token, channel: r.channel, label: r.label, start_idx: r.startIdx, end_idx: r.endIdx,
          baseline_mode: r.baselineMode, fixed_baseline: r.fixedBaseline,
        })),
      )
      const next: Record<string, QuantifyItem> = {}
      rows.forEach((r, i) => (next[r.key] = res[i]))
      setQuantResults(next)
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao quantificar')
    } finally {
      setBusy(false)
    }
  }

  // resultados valem só para a curva e as regiões com que foram calculados
  useEffect(() => setQuantResults({}), [quantCurveId, summary])

  function massOf(token: string): number | null {
    const a = analyses.find((x) => x.token === token)
    return a ? a.mass_mg : (details[token]?.quantity_mg ?? null)
  }

  async function clearRegions() {
    if (regions.length === 0) {
      setWorking({}) // só havia alterações não salvas: descarta
      return
    }
    // guarda: sem análise aberta, `deleteRegions([])` apagaria TODAS no
    // banco — nesse caso só limpa a visão (que está obsoleta).
    if (openTokens.length === 0) {
      setRegions([])
      return
    }
    if (!window.confirm(`Apagar as ${regions.length} região(ões) salvas da tabela resumo? Isso não pode ser desfeito.`)) return
    setBusy(true)
    try {
      await postrunApi.deleteRegions(openTokens)
      setRegions([])
      setWorking({})
      setMessage('Tabela resumo limpa.')
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao limpar regiões')
    } finally {
      setBusy(false)
    }
  }

  function exportRegionsCsv() {
    // 2.3 — pedido do usuário (extremamente importante): a massa da
    // amostra sai junto no CSV. Pico (valor/índice/temperatura) também,
    // além da área — útil tanto pra visualizar quanto pra exportar.
    const rows: (string | number)[][] = [
      [
        'token', 'amostra', 'massa_mg', 'canal', 'rótulo', 'início', 'fim',
        'modo_baseline', 'baseline', 'área', 'área_sinal_s', 'pico', 'pico_idx', 'pico_temp_c',
        'mg_calibrado', 'mg_por_g_calibrado', 'situação',
        ...(quantCurve ? [`massa_curva_mg (${quantCurve.name})`, 'U95_mg', 'massa_esperada_mg', 'recuperação_%', 'aviso_curva'] : []),
      ],
    ]
    for (const r of summary) {
      const sample = details[r.token]?.sample ?? analyses.find((a) => a.token === r.token)?.sample ?? ''
      const mass = massOf(r.token)
      const v = r.values
      rows.push([
        r.token, sample, mass ?? '', r.channel, r.label, r.startIdx, r.endIdx,
        r.baselineMode, r.fixedBaseline, v?.area ?? '', v?.area_s ?? '',
        v?.peak_value ?? '', v?.peak_idx ?? '', v?.peak_temp ?? '',
        v?.calibrated_mg ?? '', v?.calibrated_mg_per_g ?? '',
        r.state === 'salvo' ? 'salvo' : r.state === 'remover' ? 'será removida (não salvo)' : 'não salvo',
        ...(quantCurve
          ? (() => {
              const q = quantResults[r.key]
              return [q?.mass_mg ?? '', q?.U95_mg ?? '', q?.expected_mg ?? '', q?.recovery_pct ?? '', quantFlag(q)]
            })()
          : []),
      ])
    }
    downloadCsv(`postrun_regioes_${new Date().toISOString().slice(0, 10)}.csv`, rows)
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Abas do módulo — fixas logo abaixo do cabeçalho */}
      <div className="z-20 -mx-4 border-b md:sticky md:top-[55px] border-[var(--color-border)] bg-[var(--color-bg)] px-4 sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <nav className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="seções do PostRun">
            {(
              [
                ['analises', 'Análises', IconPyrogram],
                ['estudos', 'Estudos', IconStudy],
                ['deconv', 'Deconvolução', IconDeconv],
                ['curvas', 'Curvas', IconCurve],
                ['relatorio', 'Relatório', IconReport],
                ['calibracao', 'Calibração', IconCalib],
                ['manual', 'Manual', IconManual],
              ] as const
            ).map(([value, label, Icon]) => {
              const active = tab === value
              return (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(value)}
                  className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition-colors ${
                    active
                      ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                      : 'border-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]'
                  }`}
                >
                  <Icon size={16} />
                  {label}
                </button>
              )
            })}
          </nav>
          {tab === 'analises' && (
            <div className="flex items-center gap-3 py-2">
              <span className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: unsavedCount > 0 ? 'var(--color-warning)' : 'var(--color-status-ready)' }}
                  aria-hidden
                />
                {unsavedCount > 0 ? (
                  `${unsavedCount} alteração(ões) não salva(s)`
                ) : (
                  <>
                    Tudo salvo<span className="hidden lg:inline"> — nada é gravado até você tocar em Salvar</span>
                  </>
                )}
              </span>
              <button type="button" className={btnPrimaryClass} onClick={() => void saveAll()} disabled={busy || unsavedCount === 0}>
                <IconSave size={15} />
                Salvar
              </button>
            </div>
          )}
        </div>
      </div>

      {loadError && <p className="text-sm text-[var(--color-danger)]">{loadError}</p>}

      {tab === 'estudos' && (
        <PostRunStudiesTab
          studies={studies}
          onStudiesChanged={reloadStudies}
          activeStudyId={activeStudyId}
          openTokens={openTokens}
          onOpenStudy={(id, goTo) => void openStudy(id, goTo)}
          onCloseStudy={closeStudy}
        />
      )}

      {(tab === 'deconv' || tab === 'curvas' || tab === 'relatorio') && (
        <StudyBar
          studies={studies}
          activeStudyId={activeStudyId}
          openCount={openTokens.length}
          onChoose={(id) => (id === null ? closeStudy() : void openStudy(id))}
          onCollect={async () => {
            if (activeStudyId === null) return
            try {
              await studyApi.collect(activeStudyId, openTokens)
              reloadStudies()
              loadReferences()
              setMessage('Workspace guardado no estudo (análises, referências, moldes e curvas).')
            } catch (err) {
              setMessage(err instanceof ApiError ? err.message : 'Erro ao guardar no estudo')
            }
          }}
          onGoToStudies={() => setTab('estudos')}
        />
      )}
      {(tab === 'deconv' || tab === 'curvas' || tab === 'relatorio') && message && (
        <p className="-mt-3 text-xs text-[var(--color-text-muted)]">{message}</p>
      )}

      {tab === 'deconv' && (
        <PostRunDeconvTab
          openTokens={openTokens}
          references={shownReferences}
          onReferencesChanged={loadReferences}
          analysesByToken={analysesByToken}
          onAnalysesUpdated={mergeAnalyses}
          onSavedChanged={refreshRegions}
          onGoToAnalyses={() => setTab('analises')}
        />
      )}

      {tab === 'curvas' && (
        <PostRunCurvesTab
          workspacePoints={workspacePoints}
          workspaceGaussians={workspaceGaussians}
          analysesByToken={analysesByToken}
          onAnalysesUpdated={mergeAnalyses}
          curveFilter={studyFilter.curve}
          openTokens={openTokens}
        />
      )}

      {tab === 'relatorio' && (
        <PostRunReportTab
          tokens={openTokens}
        />
      )}

      {tab === 'manual' && <ManualTab />}

      {tab === 'calibracao' && (
        <CalibrationTab
          job={job}
          jobsList={jobsList}
          analyses={analyses}
          scanBar={<PostRunScanBar status={scan.status} onRescan={scan.rescan} />}
          onChooseJob={chooseJob}
        />
      )}

      <div className={tab === 'analises' ? 'grid grid-cols-1 gap-5 lg:grid-cols-[380px_minmax(0,1fr)] 2xl:grid-cols-[440px_minmax(0,1fr)]' : 'hidden'}>
        {/* Navegador de análises */}
        <div className="flex flex-col gap-3 self-start rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4 shadow-[var(--shadow-card)] lg:sticky lg:top-[120px]">
          {!job ? (
            <JobPicker jobs={jobsList} onChoose={chooseJob} onReload={reloadJobs} />
          ) : (
          <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">Job</span>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <IconFolder size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]" />
                <select
                  className={`${inputClass} pl-8 font-medium`}
                  value={job}
                  onChange={(e) => chooseJob(e.target.value)}
                  title="trocar de job"
                >
                  {(jobsList ?? []).map((j) => (
                    <option key={j.name} value={j.name}>
                      {j.name} ({j.analyses})
                    </option>
                  ))}
                  {jobsList && !jobsList.some((j) => j.name === job) && <option value={job}>{job}</option>}
                </select>
              </div>
              <button type="button" className={btnClass} onClick={() => chooseJob('')} title="voltar à lista de jobs">
                Todos
              </button>
            </div>
          </div>
          <PostRunScanBar status={scan.status} onRescan={scan.rescan} />
          <div className="relative">
            <IconSearch size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]" />
            <input
              className={`${inputClass} pl-8`}
              placeholder="Buscar amostra ou arquivo…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-2 text-xs text-[var(--color-text-muted)]">
            <span>Método</span>
            <select
              className={inputClass}
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
              title="método do Rock-Eval (a pasta do método no job e a extensão do arquivo)"
            >
              <option value="">todos ({analyses.length})</option>
              {methods.map(([m, n]) => (
                <option key={m} value={m}>
                  {m} ({n})
                </option>
              ))}
            </select>
            <span>Ciclo</span>
            <select
              className={inputClass}
              value={cycleFilter}
              onChange={(e) => setCycleFilter(e.target.value)}
              title={
                cycles.find(([c]) => c === cycleFilter)?.[1].labels.size
                  ? [...(cycles.find(([c]) => c === cycleFilter)?.[1].labels ?? [])].join('\n')
                  : 'ciclo do equipamento (nome do ciclo no arquivo — CyclN); o programa do forno aparece ao escolher'
              }
            >
              <option value="">todos ({cycles.reduce((s, [, e]) => s + e.n, 0)})</option>
              {cycles.map(([c, e]) => (
                <option key={c} value={c}>
                  {c} ({e.n})
                </option>
              ))}
            </select>
            <span>Ordem</span>
            <select
              className={inputClass}
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            >
              <option value="sample">por amostra</option>
              <option value="date">por data</option>
              <option value="analysis">por análise</option>
              <option value="mass">por massa</option>
            </select>
            <span>Data</span>
            <div className="flex min-w-0 items-center gap-1.5">
              <input type="date" className={`${inputClass} min-w-0 flex-1`} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="data inicial" />
              <span>–</span>
              <input type="date" className={`${inputClass} min-w-0 flex-1`} value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="data final" />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3 text-xs">
            <span className="text-[var(--color-text-muted)]">
              {loadingAnalyses ? (
                'lendo as análises do job…'
              ) : (
                <>
                  <strong className="font-semibold text-[var(--color-text)]">{visible.length}</strong> análise(s) ·{' '}
                  <strong className="font-semibold text-[var(--color-primary)]">{openTokens.length}</strong> no workspace
                </>
              )}
            </span>
            <span className="flex gap-1">
              {hiddenTokens.size > 0 && (
                <button type="button" className={linkBtnClass} onClick={() => setShowHidden((v) => !v)}>
                  {showHidden ? 'esconder ocultas' : `ocultas (${hiddenTokens.size})`}
                </button>
              )}
              <button type="button" className={linkBtnClass} onClick={selectAllFiltered}>
                marcar todas
              </button>
              {openTokens.length > 0 && (
                <button
                  type="button"
                  className={linkBtnClass}
                  title="excluir ou restaurar as análises marcadas (com motivo e comentário)"
                  onClick={() => setRecordTokens([...openTokens])}
                >
                  excluir…
                </button>
              )}
              <button type="button" className={linkBtnClass} onClick={clearSelection}>
                limpar
              </button>
            </span>
          </div>
          {isAdmin && openTokens.length > 0 && (
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-xs">
              <span className="font-medium text-[var(--color-text-muted)]">
                {openTokens.length} marcada{openTokens.length === 1 ? '' : 's'} — ações de coordenação
              </span>
              <span className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`${btnClass} text-xs`}
                  title="a amostra da biblioteca estava errada: troca o Sample= dentro do .B00 e o código no nome da análise"
                  onClick={() => setChangingSample([...openTokens])}
                >
                  Trocar amostra…
                </button>
                <button
                  type="button"
                  className={`${btnClass} text-xs`}
                  title="move o .B00 e o .B00~ das análises marcadas para outro job"
                  onClick={() => setMovingBatch([...openTokens])}
                >
                  Mover para outro job…
                </button>
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <Segmented
              size="xs"
              ariaLabel="modo da lista"
              value={compact}
              onChange={() => toggleCompact()}
              options={[
                { value: false, label: 'Completa' },
                { value: true, label: 'Simples' },
              ]}
            />
            <span className="flex gap-1">
              <button type="button" className={linkBtnClass} onClick={() => setCollapsed(new Set(groups.map(([g]) => g)))}>
                recolher
              </button>
              <button type="button" className={linkBtnClass} onClick={() => setCollapsed(new Set())}>
                expandir
              </button>
            </span>
          </div>
          <div className="-mx-4 -mb-4 max-h-[calc(100vh-430px)] overflow-y-auto rounded-b-2xl border-t border-[var(--color-border)]">
            {groups.map(([sample, items]) => {
              const tokens = items.map((i) => i.token)
              const allOpen = tokens.every((t) => openTokens.includes(t))
              const someOpen = !allOpen && tokens.some((t) => openTokens.includes(t))
              const isCollapsed = collapsed.has(sample)
              const openCount = tokens.filter((t) => openTokens.includes(t)).length
              return (
                <div key={sample}>
                  {/* 1.1 — seleção múltipla por amostra: um clique liga/desliga
                      todas as réplicas dessa amostra de uma vez; a seta colapsa */}
                  <div className="sticky top-0 z-[1] flex items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs font-semibold">
                    <button
                      type="button"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--color-text-dim)] hover:text-[var(--color-primary)]"
                      onClick={() => toggleCollapsed(sample)}
                      aria-label={isCollapsed ? `expandir ${sample}` : `colapsar ${sample}`}
                      aria-expanded={!isCollapsed}
                    >
                      <IconChevron size={14} className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
                    </button>
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={allOpen}
                        ref={(el) => {
                          if (el) el.indeterminate = someOpen
                        }}
                        onChange={() => toggleGroup(tokens)}
                      />
                      <span className="truncate text-[var(--color-text)]">{sample}</span>
                      {items.some((i) => repGroups.has(i.sample.trim().toUpperCase())) && (
                        <span
                          className="shrink-0 rounded bg-[var(--color-primary)]/10 px-1 text-[10px] font-normal text-[var(--color-primary)]"
                          title={`Réplicas reconhecidas pelo nome (amostras de antes do Horun): ${
                            repGroups.get(items.find((i) => repGroups.has(i.sample.trim().toUpperCase()))!.sample.trim().toUpperCase())?.members.join(', ') ?? ''
                          }`}
                        >
                          réplicas pelo nome
                        </span>
                      )}
                      <span className="ml-auto shrink-0 rounded-full bg-[var(--color-bg-elevated)] px-1.5 py-px text-[10px] font-medium text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
                        {openCount > 0 && !allOpen ? `${openCount}/` : ''}
                        {items.length}
                      </span>
                    </label>
                  </div>
                  {!isCollapsed && items.map((a) => {
                    const hidden = hiddenTokens.has(a.token)
                    const selected = openTokens.includes(a.token)
                    const isActive = activeToken === a.token
                    const rowClass = `group relative flex items-center gap-2 border-b border-[var(--color-border)] text-xs transition-colors ${
                      selected ? 'bg-[var(--color-row-selected)]' : 'hover:bg-[var(--color-surface)]'
                    }`
                    const bar = selected && (
                      <span
                        className="absolute inset-y-0 left-0 w-[3px]"
                        style={{ background: isActive ? 'var(--color-flame)' : 'var(--color-primary)' }}
                        aria-hidden
                      />
                    )
                    const hideBtn = (inline: boolean) => (
                      <button
                        type="button"
                        title={hidden ? 'mostrar de novo' : 'ocultar da lista (não apaga o arquivo)'}
                        aria-label={hidden ? 'mostrar de novo' : 'ocultar da lista'}
                        className={`${iconBtnClass} hover:text-[var(--color-danger)] ${inline && !hidden ? 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100' : ''}`}
                        onClick={() => toggleHidden(a.token)}
                      >
                        {hidden ? <IconUndo size={14} /> : <IconEyeOff size={14} />}
                      </button>
                    )
                    if (compact)
                      return (
                        <div
                          key={a.token}
                          className={`${rowClass} py-0.5 pl-8 pr-2`}
                          style={hidden ? { opacity: 0.45 } : undefined}
                          title={`${a.filename} · ${a.method_folder} · ${a.date ? new Date(a.date).toLocaleDateString('pt-BR') : '—'}`}
                        >
                          {bar}
                          <input
                            type="checkbox"
                            className="cursor-pointer"
                            checked={selected}
                            onChange={() => toggleOpen(a.token)}
                          />
                          <span className="min-w-0 flex-1 cursor-pointer truncate font-mono text-[var(--color-text-muted)]" onClick={() => toggleOpen(a.token)}>
                            {a.filename.replace(/\.[A-Za-z]00$/i, '')}
                          </span>
                          <PostRunMassEdit
                            token={a.token}
                            massMg={a.mass_mg}
                            manual={a.mass_source === 'manual'}
                            fileMassMg={a.quantity_mg}
                            originalMassMg={a.file_mass_before_mg}
                            onSaved={mergeAnalyses}
                            className="shrink-0 tabular-nums text-[var(--color-text)]"
                          />
                          {hideBtn(true)}
                        </div>
                      )
                    return (
                      <div
                        key={a.token}
                        className={`${rowClass} py-2 pl-8 pr-2`}
                        style={hidden ? { opacity: 0.45 } : undefined}
                      >
                        {bar}
                        <input
                          type="checkbox"
                          className="cursor-pointer"
                          checked={selected}
                          onChange={() => toggleOpen(a.token)}
                        />
                        <span
                          className="cursor-pointer rounded-md bg-[var(--color-bg-elevated)] p-0.5 ring-1 ring-[var(--color-border)]"
                          onClick={() => toggleOpen(a.token)}
                        >
                          <PostRunSparkline
                            values={sparklines[a.token]}
                            loading={!(a.token in sparklines)}
                          />
                        </span>
                        <span className="min-w-0 flex-1 cursor-pointer" onClick={() => toggleOpen(a.token)}>
                          <span className="block truncate font-mono text-[11.5px] font-medium text-[var(--color-text)]" title={a.filename}>
                            {a.filename.replace(/\.[A-Za-z]00$/i, '')}
                          </span>
                          {runRecords[a.token]?.excluded && (
                            <span
                              className="mt-0.5 inline-flex items-center gap-1 rounded bg-[var(--color-danger)]/10 px-1.5 text-[10px] font-medium text-[var(--color-danger)]"
                              title={`${runRecords[a.token].exclusion_reason_label}: ${runRecords[a.token].exclusion_comment} (${runRecords[a.token].excluded_by})`}
                            >
                              <IconBan size={11} /> excluída — {runRecords[a.token].exclusion_reason_label}
                            </span>
                          )}
                          {a.renamed_from && (
                            <span className="block truncate text-[10px] italic text-[var(--color-text-dim)]">
                              renomeada de {a.renamed_from}
                            </span>
                          )}
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[var(--color-text-dim)]">
                            <span>{a.method_folder}</span>
                            <span aria-hidden>·</span>
                            <span>{a.date ? new Date(a.date).toLocaleDateString('pt-BR') : '—'}</span>
                            <span aria-hidden>·</span>
                            <PostRunMassEdit
                              token={a.token}
                              massMg={a.mass_mg}
                              manual={a.mass_source === 'manual'}
                              fileMassMg={a.quantity_mg}
                              originalMassMg={a.file_mass_before_mg}
                              onSaved={mergeAnalyses}
                              className="font-medium tabular-nums text-[var(--color-text)]"
                            />
                          </span>
                        </span>
                        {/* ações da linha: aparecem por cima ao passar o mouse */}
                        <span
                          className={`absolute right-1.5 top-1.5 flex items-center rounded-lg bg-[var(--color-bg-elevated)] shadow-[var(--shadow-xs)] ring-1 ring-[var(--color-border)] transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
                            hidden ? 'opacity-100' : 'opacity-0'
                          }`}
                        >
                          <button
                            type="button"
                            title="ficha da corrida: metadados, exclusão com motivo, histórico"
                            aria-label="ficha da corrida"
                            className={`${iconBtnClass} hover:text-[var(--color-primary)]`}
                            onClick={() => setRecordTokens([a.token])}
                          >
                            <IconTag size={14} />
                          </button>
                          {isAdmin && (
                            <button
                              type="button"
                              title="renomear análise / mudar job (move o .B00 e o .B00~)"
                              aria-label="renomear análise"
                              className={`${iconBtnClass} hover:text-[var(--color-primary)]`}
                              onClick={() => setRenaming(a)}
                            >
                              <IconPencil size={14} />
                            </button>
                          )}
                          {hideBtn(false)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )
            })}
            {visible.length === 0 && !loadingAnalyses && (
              <p className="py-8 text-center text-xs text-[var(--color-text-muted)]">Nenhuma análise encontrada.</p>
            )}
          </div>
          </>
          )}
        </div>

        {/* Workspace: análises abertas + visualizador de curva */}
        <div className="flex min-w-0 flex-col gap-3">
          {openTokens.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--color-border-strong)] px-6 py-16 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                <IconPyrogram size={28} />
              </span>
              <div>
                <p className="text-sm font-semibold text-[var(--color-text)]">Nenhuma análise aberta</p>
                <p className="mt-1 max-w-sm text-xs text-[var(--color-text-muted)]">
                  Marque uma ou mais análises na lista para ver o pirograma, sobrepor corridas ou integrar regiões.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
                Workspace
              </span>
              {openTokens.map((t) => {
                const a = analysesByToken[t]
                const active = activeToken === t
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setActiveToken(t)}
                    title={a?.filename ?? t}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                      active
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-contrast)] shadow-[var(--shadow-xs)]'
                        : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text)] hover:border-[var(--color-border-strong)]'
                    }`}
                  >
                    <span className="font-semibold">{details[t]?.sample ?? a?.sample ?? t}</span>
                    {a?.filename && (
                      <span className={`font-mono text-[10.5px] ${active ? 'opacity-75' : 'text-[var(--color-text-dim)]'}`}>
                        {replicaTag(a.filename)}
                      </span>
                    )}
                    {detailErrors[t] && <span className="text-[var(--color-warning)]">⚠</span>}
                  </button>
                )
              })}
            </div>
          )}

          {activeToken && detailErrors[activeToken] && (
            <p className="text-sm text-[var(--color-danger)]">{detailErrors[activeToken]}</p>
          )}

          {activeDetail && (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-2 shadow-[var(--shadow-xs)]">
                <Segmented
                  ariaLabel="ciclo"
                  value={activeCurve}
                  onChange={setActiveCurve}
                  options={[
                    { value: 'pyro', label: 'Pirólise', disabled: !activeDetail.pyro },
                    { value: 'oxi', label: 'Oxidação', disabled: !activeDetail.oxi },
                  ]}
                />
                <span className="h-5 w-px bg-[var(--color-border)]" aria-hidden />
                <Segmented
                  ariaLabel="modo do gráfico"
                  value={viewMode}
                  onChange={setViewMode}
                  options={[
                    { value: 'pirograma', label: 'Pirograma', title: 'a análise ativa: tempo × intensidade' },
                    {
                      value: 'sobrepor',
                      label: `Sobrepor (${openTokens.length})`,
                      title: 'todas as análises abertas no mesmo gráfico, sem integração',
                    },
                    {
                      value: 'multi',
                      label: 'Multi',
                      title: 'todos os sinais (FID, CO, CO₂, SO₂) juntos, cada um com a sua cor',
                    },
                  ]}
                />
                <button
                  type="button"
                  onClick={() => setViewMode(viewMode === 'integracao' ? 'pirograma' : 'integracao')}
                  className={viewMode === 'integracao' ? `${btnPrimaryClass} rounded-full text-xs` : `${btnClass} rounded-full text-xs`}
                  title="ferramenta de integração: região arrastável, deconvolução e calibração do canal"
                  aria-pressed={viewMode === 'integracao'}
                >
                  <IconIntegral size={14} />
                  {viewMode === 'integracao' ? 'Fechar integração' : 'Integrar'}
                </button>
                {viewMode !== 'multi' && (
                  <>
                    <span className="ml-auto text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">Canal</span>
                    <Segmented
                      ariaLabel="canal"
                      value={activeChannel}
                      onChange={setActiveChannel}
                      options={availableChannels.map((c) => ({ value: c, label: CHANNEL_LABELS[c] ?? c }))}
                    />
                  </>
                )}
              </div>

              {viewMode === 'sobrepor' && (
                <PostRunOverlayPlot
                  tokens={openTokens}
                  details={details}
                  analysesByToken={analysesByToken}
                  curve={activeCurve}
                  channel={activeChannel}
                  channelLabel={`${activeCurve === 'pyro' ? 'Pirólise' : 'Oxidação'} · ${CHANNEL_LABELS[activeChannel] ?? activeChannel}`}
                />
              )}

              {viewMode === 'pirograma' && (
                <PostRunPyrogramPlot
                  detail={activeDetail}
                  curve={activeCurve}
                  channel={activeChannel}
                  title={`${activeCurve === 'pyro' ? 'Pirólise' : 'Oxidação'} · ${CHANNEL_LABELS[activeChannel] ?? activeChannel}`}
                />
              )}

              {viewMode === 'multi' && activeToken && (
                <PostRunMultiPlot
                  activeToken={activeToken}
                  tokens={openTokens}
                  details={details}
                  analysesByToken={analysesByToken}
                  curve={activeCurve}
                  channelLabels={CHANNEL_LABELS}
                />
              )}

              {viewMode === 'integracao' && activeCurveData && currentWorking && (
                <>
                  <PostRunCurveViewer
                    idx={activeCurveData.idx}
                    temp={activeCurveData.temp}
                    values={activeCurveData.channels[activeChannel] ?? []}
                    channelLabel={`${activeCurve === 'pyro' ? 'Pirólise' : 'Oxidação'} · ${CHANNEL_LABELS[activeChannel] ?? activeChannel}`}
                    startIdx={currentWorking.startIdx}
                    endIdx={currentWorking.endIdx}
                    baselineMode={currentWorking.baselineMode}
                    fixedBaseline={currentWorking.fixedBaseline}
                    referenceMarks={activeDetail.cursors_auto[activeKey ?? '']?.values ?? []}
                    overlays={overlays}
                    secondsPerPoint={activeDetail.seconds_per_point || 1}
                    onChange={(s, e) => updateWorking({ startIdx: s, endIdx: e })}
                    onCommit={commitRegion}
                  />
                  {hasPure && (
                    <label className="-mt-2 flex items-center gap-1.5 self-start text-xs text-[var(--color-text-muted)]">
                      <input type="checkbox" checked={showPure} onChange={(e) => setShowPure(e.target.checked)} />
                      mostrar o molde do puro de cada componente (pontilhado, mesma área): a diferença é o deslocamento e o alargamento na mistura
                    </label>
                  )}

                  <Segmented
                    ariaLabel="etapa da integração"
                    className="self-start"
                    value={step}
                    onChange={setStep}
                    options={[
                      { value: 'regiao', label: '1 · Região' },
                      { value: 'deconv', label: '2 · Deconvolução' },
                      { value: 'calib', label: '3 · Calibração do canal' },
                    ]}
                  />

                  {step === 'regiao' && (<>
                  <div className="flex flex-wrap items-end gap-2 rounded-2xl border p-3 border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-card)]">
                    <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                      Rótulo
                      <input
                        className={inputClass}
                        value={currentWorking.label}
                        onChange={(e) => updateWorking({ label: e.target.value })}
                      />
                    </label>
                    {/* 2 — escolher o intervalo de integração numericamente,
                        sem depender só do arraste na curva */}
                    <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                      Início (idx)
                      <input
                        type="number"
                        className={`${inputClass} w-24`}
                        value={currentWorking.startIdx}
                        onChange={(e) => updateWorking({ startIdx: Number(e.target.value) })}
                        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                      Fim (idx)
                      <input
                        type="number"
                        className={`${inputClass} w-24`}
                        value={currentWorking.endIdx}
                        onChange={(e) => updateWorking({ endIdx: Number(e.target.value) })}
                        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                      Baseline
                      <select
                        className={inputClass}
                        value={currentWorking.baselineMode}
                        onChange={(e) => updateWorking({ baselineMode: e.target.value as BaselineMode })}
                      >
                        <option value="fixed">Fixa</option>
                        <option value="linear">Reta (início→fim)</option>
                      </select>
                    </label>
                    {currentWorking.baselineMode === 'fixed' && (
                      <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                        Valor da baseline
                        <input
                          type="number"
                          step="any"
                          className={inputClass}
                          value={currentWorking.fixedBaseline}
                          onChange={(e) => updateWorking({ fixedBaseline: Number(e.target.value) })}
                        />
                      </label>
                    )}
                    {!persistedRegion && !currentWorking.dirty && (
                      <button type="button" className={btnClass} onClick={adoptSuggestion} disabled={busy}>
                        Usar esta região
                      </button>
                    )}
                    {currentWorking.dirty && !currentWorking.removed && (
                      <button type="button" className={btnClass} onClick={discardChanges} disabled={busy}>
                        Desfazer alterações
                      </button>
                    )}
                    {(persistedRegion || currentWorking.dirty) && !currentWorking.removed && (
                      <button type="button" className={btnClass} onClick={removeRegion} disabled={busy}>
                        Remover região
                      </button>
                    )}
                    {currentWorking.removed && (
                      <button type="button" className={btnClass} onClick={discardChanges} disabled={busy}>
                        Manter região
                      </button>
                    )}
                    <RegionStatus working={currentWorking} saved={persistedRegion} />
                  </div>

                  {openTokens.length > 1 && (
                    <div className="flex flex-wrap items-center gap-2 rounded-2xl border p-3 border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-card)]">
                      <span className="text-xs text-[var(--color-text-muted)]">
                        Aplicar essa região (mesmo canal/faixa) em:
                      </span>
                      {/* 2.2 — atalho pra aplicar a todas as análises abertas
                          de uma vez, sem precisar marcar uma por uma */}
                      <button
                        type="button"
                        className={btnClass}
                        onClick={() => applyRegionTo(openTokens.filter((t) => t !== activeToken))}
                        disabled={busy}
                      >
                        Aplicar a todas as abertas ({openTokens.length - 1})
                      </button>
                      {openTokens
                        .filter((t) => t !== activeToken)
                        .map((t) => (
                          <label key={t} className="flex items-center gap-1 text-xs">
                            <input
                              type="checkbox"
                              checked={applyTargets.has(t)}
                              onChange={(e) =>
                                setApplyTargets((prev) => {
                                  const next = new Set(prev)
                                  if (e.target.checked) next.add(t)
                                  else next.delete(t)
                                  return next
                                })
                              }
                            />
                            {details[t]?.sample ?? t}
                          </label>
                        ))}
                      <button
                        type="button"
                        className={btnClass}
                        onClick={() => applyRegionTo(Array.from(applyTargets))}
                        disabled={busy || applyTargets.size === 0}
                      >
                        Aplicar às marcadas
                      </button>
                    </div>
                  )}

                  </>)}

                  {step === 'deconv' && activeKey && activeToken && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
                      <span>Mostrando os ajustes salvos por:</span>
                      <div className="flex gap-1 rounded-full border p-0.5 border-[var(--color-border)]" role="tablist" aria-label="método salvo">
                        {(['gauss', 'molde'] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            role="tab"
                            aria-selected={deconvMethod === m}
                            onClick={() => setDeconvMethod(m)}
                            className="rounded-full px-2.5 py-0.5"
                            style={{
                              backgroundColor: deconvMethod === m ? 'var(--color-primary)' : 'transparent',
                              color: deconvMethod === m ? 'var(--color-primary-contrast)' : 'var(--color-text-muted)',
                            }}
                          >
                            {METHOD_LABEL[m]}
                          </button>
                        ))}
                      </div>
                      <span>(os dois ficam salvos; o passo a passo completo está na aba Deconvolução)</span>
                    </div>
                  )}
                  {step === 'deconv' && activeKey && activeToken && (
                    <PostRunDeconvPanel
                      token={activeToken}
                      channel={activeKey}
                      window={{
                        startIdx: currentWorking.startIdx, endIdx: currentWorking.endIdx,
                        baselineMode: currentWorking.baselineMode, fixedBaseline: currentWorking.fixedBaseline,
                      }}
                      analysis={analysesByToken[activeToken]}
                      entry={activeDeconv}
                      openTokens={openTokens}
                      analysesByToken={analysesByToken}
                      windowFor={windowFor}
                      references={shownReferences}
                      onOpenReferences={() => setTab('deconv')}
                      onModeChange={(mode) => setDeconvMethod(mode === 'template' ? 'molde' : 'gauss')}
                      onResults={addDeconvResults}
                      onRemove={removeDeconv}
                    />
                  )}

                  {step === 'calib' && activeKey && (
                    <PostRunCalibrationPanel
                      channel={activeKey}
                      channelLabel={`${activeCurve === 'pyro' ? 'Pirólise' : 'Oxidação'} · ${CHANNEL_LABELS[activeChannel] ?? activeChannel}`}
                      analyses={analyses}
                      currentToken={activeToken}
                      onCalibrated={refreshRegions}
                      currentJob={job}
                      stdJobs={stdJobs}
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Tabela resumo — todas as regiões definidas nas análises abertas */}
      {tab === 'analises' && viewMode === 'integracao' && step === 'regiao' && summary.length > 0 && (
        <div className="rounded-2xl border p-4 border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-card)]">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Resumo das regiões</h2>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                Quantificar com
                <select
                  className={`${inputClass} w-auto`}
                  value={quantCurveId}
                  onChange={(e) => setQuantCurveId(e.target.value ? Number(e.target.value) : '')}
                >
                  <option value="">— curva —</option>
                  {curves.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              {quantCurve && (
                <button type="button" className={btnClass} onClick={() => void runQuantify()} disabled={busy}>
                  Calcular massas
                </button>
              )}
              <button type="button" className={btnPrimaryClass} onClick={() => void saveAll()} disabled={busy || unsavedCount === 0}>
                Salvar{unsavedCount > 0 ? ` (${unsavedCount})` : ''}
              </button>
              <button type="button" className={btnClass} onClick={exportRegionsCsv}>
                Exportar CSV
              </button>
              <button type="button" className={btnClass} onClick={() => void clearRegions()} disabled={busy}>
                Limpar
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[var(--color-text-muted)]">
                <tr>
                  <th className="py-1 pr-3">Amostra</th>
                  <th className="py-1 pr-3">Massa (mg)</th>
                  <th className="py-1 pr-3">Canal</th>
                  <th className="py-1 pr-3">Rótulo</th>
                  <th className="py-1 pr-3">Início</th>
                  <th className="py-1 pr-3">Fim</th>
                  <th className="py-1 pr-3">Área (sinal·s)</th>
                  <th className="py-1 pr-3">Pico</th>
                  <th className="py-1 pr-3">Temp. pico</th>
                  <th className="py-1 pr-3">mg (calibrado)</th>
                  <th className="py-1 pr-3">mg/g (calibrado)</th>
                  <th className="py-1 pr-3">Situação</th>
                  {quantCurve && (
                    <>
                      <th className="py-1 pr-3">Massa pela curva (mg)</th>
                      <th className="py-1 pr-3">Esperada (mg)</th>
                      <th className="py-1 pr-3">Recuperação</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => {
                  const mass = massOf(r.token)
                  const v = r.values
                  const dash = v === null ? 'calculando…' : '—'
                  return (
                    <tr
                      key={r.key}
                      className="border-t border-[var(--color-border)]"
                      style={r.state === 'remover' ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}
                    >
                      <td className="py-1 pr-3">{details[r.token]?.sample ?? r.token}</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {mass !== null ? mass.toFixed(3) : '—'}
                        {analysesByToken[r.token]?.mass_source === 'manual' && <span title="massa corrigida na tela"> ✎</span>}
                      </td>
                      <td className="py-1 pr-3 font-mono">{r.channel}</td>
                      <td className="py-1 pr-3">{r.label}</td>
                      <td className="py-1 pr-3 tabular-nums">{r.startIdx}</td>
                      <td className="py-1 pr-3 tabular-nums">{r.endIdx}</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {v?.area_error ? (
                          <span className="text-[var(--color-danger)]">{v.area_error}</span>
                        ) : v?.area_s !== null && v?.area_s !== undefined ? (
                          fmtNum(v.area_s)
                        ) : (
                          dash
                        )}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">{v?.peak_value?.toFixed(2) ?? dash}</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {v?.peak_temp !== null && v?.peak_temp !== undefined ? `${v.peak_temp.toFixed(0)}°C` : dash}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">
                        {v?.calibrated_mg !== null && v?.calibrated_mg !== undefined ? v.calibrated_mg.toFixed(4) : '—'}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">
                        {v?.calibrated_mg_per_g !== null && v?.calibrated_mg_per_g !== undefined
                          ? v.calibrated_mg_per_g.toFixed(3)
                          : '—'}
                      </td>
                      <td className="py-1 pr-3 text-xs">
                        {r.state === 'salvo' ? (
                          <span className="text-[var(--color-text-muted)]">salvo</span>
                        ) : (
                          <span className="font-medium text-[var(--color-warning,#b26a00)]">
                            {r.state === 'remover' ? 'será removida' : 'não salvo'}
                          </span>
                        )}
                      </td>
                      {quantCurve && <QuantCells item={quantResults[r.key]} />}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'analises' && viewMode === 'integracao' && step === 'deconv' && gaussRows.length > 0 && (
        <div className="rounded-2xl border p-4 border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-card)]">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">Gaussianas (amostras virtuais)</h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                Cada pico da deconvolução, com a curva de gaussiana do mesmo material (aba Curvas) para a massa e a recuperação.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btnClass} onClick={() => void quantifyGaussians()} disabled={busy}>
                Quantificar gaussianas
              </button>
              <button type="button" className={btnClass} onClick={exportGaussiansCsv}>
                Exportar CSV
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[var(--color-text-muted)]">
                <tr>
                  <th className="py-1 pr-3">Amostra</th>
                  <th className="py-1 pr-3">Composição</th>
                  <th className="py-1 pr-3">Pico</th>
                  <th className="py-1 pr-3">Tpico</th>
                  <th className="py-1 pr-3">ΔTmax</th>
                  <th className="py-1 pr-3">Área (sinal·s)</th>
                  <th className="py-1 pr-3">% total</th>
                  <th className="py-1 pr-3">Δlargura</th>
                  <th className="py-1 pr-3">R²</th>
                  <th className="py-1 pr-3">Massa pela curva (mg)</th>
                  <th className="py-1 pr-3">Esperada (mg)</th>
                  <th className="py-1 pr-3">Recuperação</th>
                  <th className="py-1 pr-3">Situação</th>
                </tr>
              </thead>
              <tbody>
                {gaussRows.map((r) => {
                  const a = analysesByToken[r.token]
                  const q = gaussQuant[r.key]
                  const p = r.peak
                  return (
                    <tr key={r.key} className="border-t border-[var(--color-border)]" style={r.entry.removed ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                      <td className="py-1 pr-3">
                        {a?.sample ?? r.token}
                        <span className="block font-mono text-[10px] text-[var(--color-text-dim)]">{a?.filename}</span>
                      </td>
                      <td className="py-1 pr-3 text-xs">{a?.composition_text}</td>
                      <td className="py-1 pr-3 font-medium">{p.name}</td>
                      <td className="py-1 pr-3 tabular-nums">{p.mu_c?.toFixed(1)} °C</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {p.delta_mu_c !== null ? `${p.delta_mu_c >= 0 ? '+' : ''}${p.delta_mu_c.toFixed(1)} °C` : '—'}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">
                        {fmtNum(p.area_s)} ± {fmtNum(p.u_area_s)}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">{p.pct_of_total.toFixed(1)} %</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {p.delta_width_pct !== null ? `${p.delta_width_pct >= 0 ? '+' : ''}${p.delta_width_pct.toFixed(0)} %` : '—'}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">
                        {r.entry.result.r2.toFixed(4)}
                        {r.entry.result.warnings.length > 0 && <span title={r.entry.result.warnings.join('\n')}> ⚠</span>}
                      </td>
                      {q?.error ? (
                        <td colSpan={3} className="py-1 pr-3 text-xs text-[var(--color-danger)]">
                          {q.error}
                        </td>
                      ) : (
                        <>
                          <td className="py-1 pr-3 tabular-nums" title={q?.curveName}>
                            {q?.mass_mg != null ? `${fmtNum(q.mass_mg)} ± ${fmtNum(q.U95_mg ?? NaN)}` : '—'}
                            {q && quantFlag(q) && <span className="block text-[10px] text-[var(--color-warning,#b26a00)]">{quantFlag(q)}</span>}
                          </td>
                          <td className="py-1 pr-3 tabular-nums">{q?.expected_mg != null ? fmtNum(q.expected_mg) : '—'}</td>
                          <td className="py-1 pr-3 tabular-nums">{q?.recovery_pct != null ? `${q.recovery_pct.toFixed(1)} %` : '—'}</td>
                        </>
                      )}
                      <td className="py-1 pr-3 text-xs">
                        {r.entry.removed ? 'será removida' : r.entry.dirty ? <span className="text-[var(--color-warning,#b26a00)]">não salvo</span> : 'salvo'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {message && <p className="text-sm text-[var(--color-text-muted)]">{message}</p>}
      {movingBatch && (
        <MoveAnalysesBatchModal
          tokens={movingBatch}
          jobs={jobs}
          currentJob={job}
          onClose={() => setMovingBatch(null)}
          onDone={handleBatchMoved}
        />
      )}
      {changingSample && (
        <ChangeSampleModal tokens={changingSample} onClose={() => setChangingSample(null)} onDone={handleSampleChanged} />
      )}
      {recordTokens && (
        <RunRecordModal
          tokens={recordTokens}
          labelOf={(t) => (analysesByToken[t]?.filename ?? t).replace(/\.[A-Za-z]00$/i, '')}
          onClose={() => setRecordTokens(null)}
          onChanged={(rs) => setRunRecords((prev) => ({ ...prev, ...Object.fromEntries(rs.map((r) => [r.token, r])) }))}
        />
      )}
      {renaming && (
        <RenameAnalysisModal
          analysis={renaming}
          jobs={jobs}
          onClose={() => setRenaming(null)}
          onDone={(r) => handleRenamed(r.old_token, r.new_token)}
        />
      )}
    </div>
  )
}

function quantFlag(q: QuantifyItem | undefined): string {
  if (!q) return ''
  if (q.error) return q.error
  const flags = []
  if (q.outside_range) flags.push('fora da faixa da curva')
  if (q.below_lod) flags.push('abaixo do LD')
  else if (q.below_loq) flags.push('abaixo do LQ')
  return flags.join('; ')
}

/** Colunas do quantificador no resumo: massa ± U95, esperada e recuperação. */
function QuantCells({ item }: { item: QuantifyItem | undefined }) {
  if (!item)
    return (
      <td colSpan={3} className="py-1 pr-3 text-xs text-[var(--color-text-dim)]">
        toque em Calcular massas
      </td>
    )
  if (item.error)
    return (
      <td colSpan={3} className="py-1 pr-3 text-xs text-[var(--color-danger)]">
        {item.error}
      </td>
    )
  const flag = quantFlag(item)
  return (
    <>
      <td className="py-1 pr-3 tabular-nums">
        {item.mass_mg !== null ? `${fmtNum(item.mass_mg)} ± ${fmtNum(item.U95_mg ?? NaN)}` : '—'}
        {flag && <span className="block text-[10px] text-[var(--color-warning,#b26a00)]">{flag}</span>}
      </td>
      <td className="py-1 pr-3 tabular-nums">{item.expected_mg !== null ? fmtNum(item.expected_mg) : '—'}</td>
      <td className="py-1 pr-3 tabular-nums">{item.recovery_pct !== null ? `${item.recovery_pct.toFixed(1)} %` : '—'}</td>
    </>
  )
}

/** Situação da região na tela: salva, alterada (não salva) ou a remover. */
function RegionStatus({ working, saved }: { working: WorkingRegion; saved: Region | undefined }) {
  const preview = working.preview && working.preview.sig === draftSig(working) ? working.preview : null
  let text: string
  if (working.removed) text = 'será removida ao salvar'
  else if (working.dirty) {
    const area = preview ? (preview.area_error ? preview.area_error : `área ${preview.area?.toFixed(2)}`) : 'calculando a área…'
    text = `não salva · ${area}`
  } else if (saved) text = `salva · área ${saved.area?.toFixed(2) ?? '—'}`
  else text = 'sugestão (cursor do GeoWorks) — ajuste ou toque em Usar esta região'
  return (
    <span
      className="self-center text-xs"
      style={{ color: working.dirty ? 'var(--color-warning, #b26a00)' : 'var(--color-text-muted)' }}
    >
      {text}
    </span>
  )
}

/** Aba "Calibração" (pedido do usuário, 16/10/2026): a calibração do FID
 * sozinha, com as corridas do job STD (padrões) e do job escolhido. */
function CalibrationTab({
  job,
  jobsList,
  analyses,
  scanBar,
  onChooseJob,
}: {
  job: string
  jobsList: JobInfo[] | null
  analyses: AnalysisSummary[]
  scanBar: React.ReactNode
  onChooseJob: (name: string) => void
}) {
  const stdJobs = useMemo(() => (jobsList ?? []).filter((j) => isStdJob(j.name)).map((j) => j.name), [jobsList])
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-2xl border p-4 border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-card)]">
        <p className="text-sm text-[var(--color-text-muted)]">
          Converte a área do FID (pirólise) em mg, com corridas de padrão certificado — igual o GeoWorks: cada corrida é
          revisada e aceita por você. Entram as corridas do job de padrões (STD) e, se quiser, as de outro job.
        </p>
        <label className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
          Outro job (opcional)
          <select className={`${inputClass} w-auto`} value={job} onChange={(e) => onChooseJob(e.target.value)}>
            <option value="">— nenhum —</option>
            {(jobsList ?? []).map((j) => (
              <option key={j.name} value={j.name}>
                {j.name} ({j.analyses})
              </option>
            ))}
          </select>
        </label>
        {job && scanBar}
      </div>
      <PostRunCalibrationPanel
        channel="pyro:FID"
        channelLabel="Pirólise · FID"
        analyses={analyses}
        currentToken={null}
        currentJob={job}
        stdJobs={stdJobs}
        defaultOpen
      />
    </div>
  )
}

/** Primeiro passo da aba: a lista de jobs, mais recentes primeiro, com
 * quantas análises cada um tem. Só nomes de arquivo — nenhum .B00 é lido
 * até o usuário escolher um job. */
function JobPicker({
  jobs,
  onChoose,
  onReload,
}: {
  jobs: JobInfo[] | null
  onChoose: (name: string) => void
  onReload: () => void
}) {
  const [filter, setFilter] = useState('')
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (jobs ?? []).filter((j) => !q || j.name.toLowerCase().includes(q))
  }, [jobs, filter])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Escolha um job</span>
        <button type="button" className={linkBtnClass} onClick={onReload}>
          atualizar
        </button>
      </div>
      <div className="relative">
        <IconSearch size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]" />
        <input
          className={`${inputClass} pl-8`}
          placeholder="Buscar job…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
      </div>
      <div className="-mx-4 -mb-4 max-h-[calc(100vh-300px)] overflow-y-auto border-t border-[var(--color-border)]">
        {jobs === null && (
          <p className="py-4 text-center text-xs text-[var(--color-text-muted)]">listando os jobs…</p>
        )}
        {shown.map((j) => (
          <button
            key={j.name}
            type="button"
            onClick={() => onChoose(j.name)}
            className="group flex w-full items-center gap-3 border-b border-[var(--color-border)] px-4 py-2.5 text-left text-sm transition-colors hover:bg-[var(--color-row-selected)]"
          >
            <IconFolder size={16} className="shrink-0 text-[var(--color-text-dim)] group-hover:text-[var(--color-primary)]" />
            <span className="min-w-0 flex-1 truncate font-medium">{j.name}</span>
            <span className="shrink-0 text-xs text-[var(--color-text-dim)]">
              {j.analyses} análise{j.analyses === 1 ? '' : 's'}
              {j.last_date && <> · {j.last_date.split('-').reverse().join('/')}</>}
            </span>
          </button>
        ))}
        {jobs !== null && shown.length === 0 && (
          <p className="py-4 text-center text-xs text-[var(--color-text-muted)]">Nenhum job encontrado.</p>
        )}
      </div>
    </div>
  )
}

/** Seletor de estudo das abas Deconvolução, Curvas e Relatório (pedido do
 * usuário, 22/10/2026): abre tudo o que o estudo guarda, como um job. */
function StudyBar({
  studies,
  activeStudyId,
  openCount,
  onChoose,
  onCollect,
  onGoToStudies,
}: {
  studies: Study[]
  activeStudyId: number | null
  openCount: number
  onChoose: (id: number | null) => void
  onCollect: () => void
  onGoToStudies: () => void
}) {
  const active = studies.find((s) => s.id === activeStudyId) ?? null
  const newOnes = active ? openCount - active.tokens.length : 0
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm shadow-[var(--shadow-xs)]">
      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
        <IconStudy size={14} />
        Estudo
      </span>
      <select
        className={`${inputInlineClass} min-w-[220px]`}
        value={activeStudyId ?? ''}
        onChange={(e) => onChoose(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">— nenhum estudo ativo —</option>
        {studies.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} ({s.tokens.length}){s.status === 'finalizado' ? ' · finalizado' : ''}
          </option>
        ))}
      </select>
      {active ? (
        <>
          <span className="text-xs text-[var(--color-text-muted)]">
            {active.tokens.length} análises · {active.reference_ids.length} referências · {active.curve_ids.length} curvas
          </span>
          {active.status === 'aberto' && (
            <button
              type="button"
              className={`${btnClass} text-xs`}
              onClick={onCollect}
              title="guarda as análises abertas e as referências, moldes e curvas que elas usam"
            >
              Guardar workspace no estudo{newOnes > 0 ? ` (+${newOnes})` : ''}
            </button>
          )}
        </>
      ) : (
        <span className="text-xs text-[var(--color-text-muted)]">escolha um estudo para ativá-lo (abre tudo o que ele guarda)</span>
      )}
      <button type="button" className={`${linkBtnClass} ml-auto`} onClick={onGoToStudies}>
        Estudos →
      </button>
    </div>
  )
}
