import { useEffect, useState } from 'react'
import { ApiError } from '../api/client'
import type { AnalysisSummary, Calibration, CalibrationMode } from '../api/postrun'
import { postrunApi } from '../api/postrun'
import { standardsApi } from '../api/standards'
import type { StandardOut } from '../api/types'
import { linearFit } from '../lib/postrunCalibrationFit'
import { useJobAnalyses } from '../hooks/usePostrunScan'
import { PostRunScanBar } from './PostRunScanBar'

const inputClass =
  'w-full rounded-lg border px-2 py-1 text-sm border-[var(--color-border)] ' +
  'bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none ' +
  'focus:ring-2 focus:ring-[var(--color-primary)]'

const btnClass =
  'rounded-lg border px-3 py-1.5 text-sm border-[var(--color-border)] ' +
  'hover:bg-[var(--color-surface)] disabled:opacity-40'

interface PointDraft {
  token: string
  standardId: number | ''
  preview: {
    startIdx: number
    endIdx: number
    area: number
    knownMg: number
    massMg: number
    suggestedK1: number
    referenceSource: string
    tmaxCertified: number | null
    tmaxMeasured: number | null
  } | null
  error: string | null
  loading: boolean
}

function emptyPoint(token = ''): PointDraft {
  return { token, standardId: '', preview: null, error: null, loading: false }
}

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString('pt-BR') : '—'
}

/** "17/07/2026" ou "17/07/2026 a 02/08/2026" — quando o padrão foi rodado */
function runDates(c: Calibration): string {
  const a = fmtDate(c.run_date_min)
  const b = fmtDate(c.run_date_max)
  return !c.run_date_min ? 'data desconhecida' : a === b ? a : `${a} a ${b}`
}

function calName(c: Calibration): string {
  return c.name || `sem nome (validada em ${fmtDate(c.validated_at)})`
}

function fmt(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return n.toExponential(digits)
}

/** Calibração de área bruta -> mg, por canal (pedido do usuário): igual o
 * fluxo do GeoWorks — cada corrida de um padrão STD é um evento único
 * que o usuário revisa e aceita/rejeita manualmente, nunca automático
 * (a variação pode vir de um problema no equipamento). Reaproveita o
 * catálogo de padrões certificados já existente (`/standards`).
 *
 * Pedido do usuário (16/10/2026): além do job ativo, as corridas do job
 * STD (padrões) entram na lista — lidas em segundo plano quando o
 * formulário abre. */
export function PostRunCalibrationPanel({
  channel,
  channelLabel,
  analyses,
  currentToken,
  onCalibrated,
  currentJob = '',
  stdJobs = [],
  defaultOpen = false,
}: {
  channel: string
  channelLabel: string
  analyses: AnalysisSummary[]
  currentToken: string | null
  onCalibrated?: () => void
  /** job aberto na aba (as análises de `analyses`) */
  currentJob?: string
  /** jobs de padrões (STD) — as corridas deles também entram na lista */
  stdJobs?: string[]
  /** aba Calibração: formulário e histórico já abertos */
  defaultOpen?: boolean
}) {
  const [standards, setStandards] = useState<StandardOut[]>([])
  const [history, setHistory] = useState<Calibration[]>([])
  const [showHistory, setShowHistory] = useState(defaultOpen)
  const [showForm, setShowForm] = useState(defaultOpen)
  const [stdJob, setStdJob] = useState(stdJobs[0] ?? '')
  useEffect(() => {
    if (!stdJobs.includes(stdJob)) setStdJob(stdJobs[0] ?? '')
  }, [stdJobs, stdJob])
  // o job STD só é lido quando o formulário está aberto (e não é o próprio job ativo)
  const std = useJobAnalyses(showForm && stdJob !== currentJob ? stdJob : '')
  const [mode, setMode] = useState<CalibrationMode>('gain')
  const [points, setPoints] = useState<PointDraft[]>([emptyPoint()])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // Pedido do usuário (16/10/2026): nome da calibração e escolher se vira a vigente
  const [newName, setNewName] = useState('')
  const [newNotes, setNewNotes] = useState('')
  const [makeActive, setMakeActive] = useState(true)

  useEffect(() => {
    standardsApi.list().then(setStandards).catch(() => setStandards([]))
  }, [])

  useEffect(() => {
    setShowForm(defaultOpen)
    setPoints([emptyPoint(currentToken ?? '')])
    postrunApi
      .listCalibrations(channel)
      .then(setHistory)
      .catch(() => setHistory([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel])

  const active = history.find((c) => c.is_active) ?? history[0]

  function updatePoint(index: number, patch: Partial<PointDraft>) {
    setPoints((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }

  async function loadPreview(index: number, token: string, standardId: number) {
    updatePoint(index, { loading: true, error: null })
    try {
      const c = await postrunApi.getCalibrationCandidate(token, channel, standardId)
      updatePoint(index, {
        loading: false,
        preview: {
          startIdx: c.start_idx, endIdx: c.end_idx, area: c.area,
          knownMg: c.known_mg, massMg: c.mass_mg, suggestedK1: c.suggested_k1,
          referenceSource: c.reference_source,
          tmaxCertified: c.tmax_certified, tmaxMeasured: c.tmax_measured,
        },
      })
    } catch (err) {
      updatePoint(index, {
        loading: false, preview: null,
        error: err instanceof ApiError ? err.message : 'Erro ao calcular candidato',
      })
    }
  }

  function handleTokenChange(index: number, token: string) {
    updatePoint(index, { token, preview: null, error: null })
    const standardId = points[index].standardId
    if (token && standardId) void loadPreview(index, token, Number(standardId))
  }

  function handleStandardChange(index: number, standardId: number) {
    updatePoint(index, { standardId, preview: null, error: null })
    const token = points[index].token
    if (token && standardId) void loadPreview(index, token, standardId)
  }

  function addPoint() {
    setPoints((prev) => [...prev, emptyPoint()])
  }

  function removePoint(index: number) {
    setPoints((prev) => prev.filter((_, i) => i !== index))
  }

  // sugestão de nome: padrão + mês/ano da corrida (ex.: "IFP160000 — 08/2026")
  const firstPoint = points.find((p) => p.token && p.standardId)
  const firstStd = standards.find((x) => x.id === Number(firstPoint?.standardId))
  const firstRun = [...std.analyses, ...analyses].find((a) => a.token === firstPoint?.token)
  const suggestedName =
    firstStd && firstRun?.date
      ? `${firstStd.name} — ${new Date(firstRun.date).toLocaleDateString('pt-BR', { month: '2-digit', year: 'numeric' })}`
      : ''

  const validPoints = points.filter((p) => p.preview && !p.error)
  const linearPreview =
    mode === 'linear' && validPoints.length >= 2
      ? linearFit(validPoints.map((p) => ({ area: p.preview!.area, knownMg: p.preview!.knownMg })))
      : null

  const canSubmit =
    (mode === 'gain' && points.length === 1 && validPoints.length === 1) ||
    (mode === 'linear' && points.length >= 2 && validPoints.length === points.length)

  async function submit() {
    if (!canSubmit) return
    setBusy(true)
    setMessage(null)
    try {
      await postrunApi.createCalibration(
        channel, mode,
        points.map((p) => ({ token: p.token, standard_id: Number(p.standardId) })),
        { name: newName || suggestedName, notes: newNotes, make_active: makeActive },
      )
      setMessage(makeActive ? 'Calibração validada e vigente.' : 'Calibração guardada (a vigente não mudou).')
      setNewName('')
      setNewNotes('')
      setMakeActive(true)
      setShowForm(defaultOpen)
      setShowHistory(true)
      setPoints([emptyPoint()])
      const refreshed = await postrunApi.listCalibrations(channel)
      setHistory(refreshed)
      onCalibrated?.()
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao validar calibração')
    } finally {
      setBusy(false)
    }
  }

  async function rename(c: Calibration) {
    const name = window.prompt('Nome da calibração', c.name)
    if (name === null) return
    try {
      await postrunApi.updateCalibration(c.id, { name })
      setHistory(await postrunApi.listCalibrations(channel))
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao renomear')
    }
  }

  async function activate(c: Calibration) {
    if (!window.confirm(`Tornar "${calName(c)}" a calibração vigente deste canal? Os valores em mg passam a usar ela.`)) return
    try {
      await postrunApi.updateCalibration(c.id, { make_active: true })
      setHistory(await postrunApi.listCalibrations(channel))
      onCalibrated?.()
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao trocar a vigente')
    }
  }

  return (
    <div className="rounded-2xl border p-3 border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-semibold">Calibração — {channelLabel}</span>{' '}
          {active ? (
            <span className="text-xs text-[var(--color-text-muted)]">
              vigente: <strong className="text-[var(--color-text)]">{calName(active)}</strong> · K1={fmt(active.k1)}{' '}
              {active.mode === 'linear' && `K0=${fmt(active.k0)} R²=${active.r2?.toFixed(3)}`} · padrão rodado em {runDates(active)} ·
              validada em {new Date(active.validated_at).toLocaleDateString('pt-BR')}
            </span>
          ) : (
            <span className="text-xs text-[var(--color-text-muted)]">nenhuma calibração vigente pra este canal</span>
          )}
        </div>
        <div className="flex gap-2">
          {history.length > 0 && (
            <button type="button" className={btnClass} onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? 'Ocultar histórico' : `Histórico (${history.length})`}
            </button>
          )}
          {!defaultOpen && (
            <button type="button" className={btnClass} onClick={() => setShowForm((v) => !v)}>
              {showForm ? 'Cancelar' : 'Nova calibração'}
            </button>
          )}
        </div>
      </div>

      {showHistory && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-[var(--color-text-muted)]">
              <tr>
                <th className="py-1 pr-3">Nome</th>
                <th className="py-1 pr-3">Padrão rodado em</th>
                <th className="py-1 pr-3">Validada em</th>
                <th className="py-1 pr-3">Modo</th>
                <th className="py-1 pr-3">K0</th>
                <th className="py-1 pr-3">K1</th>
                <th className="py-1 pr-3">R²</th>
                <th className="py-1 pr-3">Padrões usados</th>
                <th className="py-1 pr-3" />
              </tr>
            </thead>
            <tbody>
              {history.map((c) => (
                <tr
                  key={c.id}
                  className="border-t border-[var(--color-border)]"
                  style={c.is_active ? { background: 'var(--color-surface)' } : undefined}
                >
                  <td className="py-1 pr-3">
                    <span className="font-medium">{calName(c)}</span>{' '}
                    <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => void rename(c)} title="renomear">
                      ✎
                    </button>
                    {c.notes && <span className="block text-[10px] text-[var(--color-text-dim)]">{c.notes}</span>}
                  </td>
                  <td className="py-1 pr-3">{runDates(c)}</td>
                  <td className="py-1 pr-3">{new Date(c.validated_at).toLocaleString('pt-BR')}</td>
                  <td className="py-1 pr-3">{c.mode === 'gain' ? 'ganho puro' : 'com intercepto'}</td>
                  <td className="py-1 pr-3 font-mono">{fmt(c.k0)}</td>
                  <td className="py-1 pr-3 font-mono">{fmt(c.k1)}</td>
                  <td className="py-1 pr-3">{c.r2 !== null ? c.r2.toFixed(4) : '—'}</td>
                  <td className="py-1 pr-3">{c.source_points.map((sp) => sp.standard_name).join(', ')}</td>
                  <td className="py-1 pr-3 text-right">
                    {c.is_active ? (
                      <span className="font-medium text-[var(--color-primary)]">vigente</span>
                    ) : (
                      <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => void activate(c)}>
                        tornar vigente
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="mt-3 flex flex-col gap-3 border-t pt-3 border-[var(--color-border)]">
          <div className="flex gap-1 rounded-full border p-1 text-xs border-[var(--color-border)]" style={{ width: 'fit-content' }}>
            {(['gain', 'linear'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className="rounded-full px-3 py-1"
                style={{
                  backgroundColor: mode === m ? 'var(--color-primary)' : 'transparent',
                  color: mode === m ? 'var(--color-primary-contrast)' : 'var(--color-text-muted)',
                }}
              >
                {m === 'gain' ? 'Ganho puro (1 ponto)' : 'Com intercepto (2+ pontos)'}
              </button>
            ))}
          </div>

          {stdJobs.length > 0 ? (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
                <span>Corridas de padrão do job</span>
                {stdJobs.length > 1 ? (
                  <select className={`${inputClass} w-auto`} value={stdJob} onChange={(e) => setStdJob(e.target.value)}>
                    {stdJobs.map((j) => (
                      <option key={j} value={j}>
                        {j}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="font-medium text-[var(--color-text)]">{stdJob}</span>
                )}
                {currentJob && stdJob !== currentJob && <span>+ as do job aberto ({currentJob})</span>}
              </div>
              {stdJob !== currentJob && <PostRunScanBar status={std.status} onRescan={std.rescan} />}
              {std.error && <span className="text-xs text-[var(--color-danger)]">{std.error}</span>}
            </div>
          ) : (
            <p className="text-xs text-[var(--color-text-muted)]">
              Nenhum job de padrões (nome começando com STD) encontrado — só as corridas do job aberto aparecem.
            </p>
          )}

          {points.map((p, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border p-2 border-[var(--color-border)]">
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                Análise (corrida do padrão)
                <select
                  className={`${inputClass} min-w-[220px]`}
                  value={p.token}
                  onChange={(e) => handleTokenChange(i, e.target.value)}
                >
                  <option value="">— selecione —</option>
                  {stdJob !== currentJob && std.analyses.length > 0 && (
                    <optgroup label={`Padrões — job ${stdJob}`}>
                      {std.analyses.map((a) => (
                        <option key={a.token} value={a.token}>
                          {a.sample} ({a.filename}{a.date ? ` · ${new Date(a.date).toLocaleDateString('pt-BR')}` : ''})
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {analyses.length > 0 && (
                    <optgroup label={currentJob ? `Job aberto — ${currentJob}` : 'Job aberto'}>
                      {analyses.map((a) => (
                        <option key={a.token} value={a.token}>
                          {a.sample} ({a.filename}{a.date ? ` · ${new Date(a.date).toLocaleDateString('pt-BR')}` : ''})
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                Padrão certificado
                <select
                  className={inputClass}
                  value={p.standardId}
                  onChange={(e) => handleStandardChange(i, Number(e.target.value))}
                >
                  <option value="">— selecione —</option>
                  {standards.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="text-xs text-[var(--color-text-muted)]">
                {p.loading && 'calculando…'}
                {p.error && <span className="text-[var(--color-danger)]">{p.error}</span>}
                {p.preview && (
                  <div className="flex flex-col gap-0.5">
                    <span>
                      janela do cursor [{p.preview.startIdx}, {p.preview.endIdx}] · área{' '}
                      {p.preview.area.toFixed(1)} · massa {p.preview.massMg.toFixed(3)} mg
                    </span>
                    <span>
                      S2 conhecido ({p.preview.referenceSource}) → {p.preview.knownMg.toFixed(4)} mg · K1{' '}
                      {fmt(p.preview.suggestedK1)}
                    </span>
                    {p.preview.tmaxCertified !== null && (
                      <span>
                        Tmax certificado {p.preview.tmaxCertified.toFixed(0)} °C · medido no pico{' '}
                        {p.preview.tmaxMeasured !== null ? `${p.preview.tmaxMeasured.toFixed(0)} °C` : '—'}
                        {p.preview.tmaxMeasured !== null && (
                          <span
                            style={{
                              color:
                                Math.abs(p.preview.tmaxMeasured - p.preview.tmaxCertified) > 5
                                  ? 'var(--color-warn, var(--color-danger))'
                                  : undefined,
                            }}
                          >
                            {' '}
                            (Δ {(p.preview.tmaxMeasured - p.preview.tmaxCertified).toFixed(0)} °C)
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {points.length > 1 && (
                <button type="button" className={btnClass} onClick={() => removePoint(i)}>
                  Remover
                </button>
              )}
            </div>
          ))}

          {mode === 'linear' && (
            <div className="flex items-center gap-2">
              <button type="button" className={btnClass} onClick={addPoint}>
                + adicionar ponto
              </button>
              {linearPreview && (
                <span className="text-xs text-[var(--color-text-muted)]">
                  prévia: K0={fmt(linearPreview.k0)} K1={fmt(linearPreview.k1)} R²={linearPreview.r2.toFixed(4)}
                </span>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
              Nome da calibração
              <input
                className={inputClass}
                value={newName}
                placeholder={suggestedName || 'ex.: IFP160000 — agosto/2026'}
                onChange={(e) => setNewName(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)] md:col-span-2">
              Observação (opcional)
              <input className={inputClass} value={newNotes} onChange={(e) => setNewNotes(e.target.value)} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={makeActive} onChange={(e) => setMakeActive(e.target.checked)} />
              tornar esta a calibração vigente (desmarque para só guardar, ex.: um padrão antigo)
            </label>
            <button type="button" className={btnClass} onClick={() => void submit()} disabled={busy || !canSubmit}>
              Aceitar calibração
            </button>
          </div>
        </div>
      )}

      {message && <p className="mt-2 text-xs text-[var(--color-text-muted)]">{message}</p>}
    </div>
  )
}
