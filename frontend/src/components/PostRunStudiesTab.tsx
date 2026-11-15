import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import {
  METHOD_LABEL,
  postrunApi,
  studyApi,
  type Calibration,
  type DeconvMethod,
  type RecoveryReport,
  type Study,
  type StudyDetail,
  type StudyHeadlineGroup,
} from '../api/postrun'
import { POLY_HELP, RecoveryBars, RecoveryKpis, TOTAL_HELP, groupsFromReport, nValid, recoveryColor, type RecoveryGroup } from './PostRunRecoveryViz'
import { PostRunStudyInspect } from './PostRunStudyInspect'
import { PostRunStudyTolerance } from './PostRunStudyTolerance'
import { PostRunValidationPanel } from './PostRunValidationPanel'
import { PostRunModelCompare } from './PostRunModelCompare'
import { PostRunInteractionPanel } from './PostRunInteractionPanel'
import { inputClass, btnClass, btnPrimaryClass, cardClass } from '../ui/classes'

const xBtn = 'rounded px-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] disabled:opacity-30'

const stem = (f: string) => f.replace(/\.B00$/i, '')

function headlineGroups(h: StudyHeadlineGroup[] | undefined): RecoveryGroup[] {
  return (h ?? []).map((g) => ({
    key: g.key,
    n_runs: g.n_runs,
    // estudos salvos antes da F1 não têm total_n nem as poliolefinas: até o
    // próximo "atualizar", o n do total fica de fora
    total: { mean: g.total_mean, sd: g.total_sd, n: g.total_n ?? (g.total_mean !== null ? g.n_runs : 0) },
    polyolefins:
      g.polyolefins && g.polyolefins.length >= 2
        ? { label: g.polyolefins.join(' + '), mean: g.polyolefins_mean ?? null, sd: g.polyolefins_sd ?? null, n: g.polyolefins_n ?? 0 }
        : null,
    materials: g.materials.map((m) => ({ material: m.material, fraction: m.fraction, mean: m.recovery_mean, sd: m.recovery_sd, n: m.n })),
  }))
}

function StatusBadge({ status }: { status: Study['status'] }) {
  const done = status === 'finalizado'
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{
        background: done ? 'var(--color-surface)' : 'var(--color-primary)',
        color: done ? 'var(--color-text-muted)' : 'var(--color-primary-contrast)',
      }}
    >
      {done ? 'finalizado' : 'aberto'}
    </span>
  )
}

/** Aba "Estudos" do PostRun (pedido do usuário, 22/10/2026): cada estudo
 * guarda as análises, referências/moldes, curvas e calibrações; abre tudo
 * de uma vez nas abas Deconvolução e Curvas; mostra a recuperação em
 * destaque e exporta o Excel absoluto (para os professores e para o
 * módulo Resultados). */
export function PostRunStudiesTab({
  studies,
  onStudiesChanged,
  activeStudyId,
  openTokens,
  onOpenStudy,
  onCloseStudy,
}: {
  studies: Study[]
  onStudiesChanged: () => void
  activeStudyId: number | null
  openTokens: string[]
  /** abre o estudo no workspace (e vai para a aba pedida) */
  onOpenStudy: (id: number, goTo?: 'deconv' | 'curvas' | 'relatorio') => void
  onCloseStudy: () => void
}) {
  const [selected, setSelected] = useState<number | null>(activeStudyId ?? studies[0]?.id ?? null)
  const [detail, setDetail] = useState<StudyDetail | null>(null)
  const [report, setReport] = useState<{ report: RecoveryReport; frozen: boolean } | null>(null)
  const [viewMethod, setViewMethod] = useState<DeconvMethod | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newMethod, setNewMethod] = useState<DeconvMethod>('molde')
  const [showNew, setShowNew] = useState(false)
  const [editing, setEditing] = useState<{ name: string; description: string } | null>(null)
  const [calibrations, setCalibrations] = useState<Calibration[]>([])
  const [section, setSection] = useState<'analises' | 'referencias' | 'curvas' | 'calibracoes'>('analises')
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    if (selected === null && studies.length) setSelected(studies[0].id)
  }, [studies, selected])

  function loadDetail(id: number) {
    setDetail(null)
    setReport(null)
    studyApi
      .get(id)
      .then((d) => {
        setDetail(d)
        setViewMethod(d.method)
      })
      .catch((err) => setMessage(err instanceof ApiError ? err.message : 'Erro ao abrir o estudo'))
  }
  useEffect(() => {
    if (selected !== null) loadDetail(selected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  useEffect(() => {
    if (!detail || !viewMethod || detail.tokens.length === 0) return
    let alive = true
    studyApi
      .report(detail.id, viewMethod)
      .then((r) => alive && setReport(r))
      .catch(() => alive && setReport(null))
    return () => {
      alive = false
    }
  }, [detail, viewMethod])

  useEffect(() => {
    postrunApi.listCalibrations('pyro:FID').then(setCalibrations).catch(() => setCalibrations([]))
  }, [])

  async function run<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
    setBusy(true)
    setMessage(null)
    try {
      const out = await fn()
      if (ok) setMessage(ok)
      return out
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro')
      return undefined
    } finally {
      setBusy(false)
    }
  }

  async function create() {
    const s = await run(() => studyApi.create({ name: newName.trim(), description: newDesc.trim(), method: newMethod }))
    if (!s) return
    setNewName('')
    setNewDesc('')
    setShowNew(false)
    onStudiesChanged()
    setSelected(s.id)
  }

  async function refreshAfter(p: Promise<unknown> | undefined) {
    if ((await p) === undefined) return
    onStudiesChanged()
    if (selected !== null) loadDetail(selected)
  }

  async function exportXlsx(simples = false) {
    if (!detail) return
    setExporting(true)
    const blob = await run(() => studyApi.exportXlsx(detail.id, simples))
    setExporting(false)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `estudo_${detail.name.replace(/[^\w-]+/g, '_')}${simples ? '_publicacao' : ''}_${new Date().toISOString().slice(0, 10)}.xlsx`
    a.click()
    URL.revokeObjectURL(url)
  }

  const isOpen = detail?.status === 'aberto'
  const groups = useMemo(() => (report ? groupsFromReport(report.report.groups) : []), [report])
  const newInWorkspace = detail ? openTokens.filter((t) => !detail.tokens.includes(t)).length : 0

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)] 2xl:grid-cols-[340px_minmax(0,1fr)]">
      {/* lista de estudos */}
      <div className={`${cardClass} flex flex-col gap-2 self-start`}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Estudos</h2>
          <button type="button" className={btnClass} onClick={() => setShowNew((v) => !v)}>
            {showNew ? 'Cancelar' : '+ Novo'}
          </button>
        </div>
        {showNew && (
          <div className="flex flex-col gap-2 rounded-xl border p-3 border-[var(--color-border)]">
            <input className={inputClass} placeholder="nome (ex.: PP/PS — série 1)" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <textarea className={`${inputClass} h-16`} placeholder="descrição (opcional)" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
            <label className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
              método principal
              <select className={`${inputClass} w-auto`} value={newMethod} onChange={(e) => setNewMethod(e.target.value as DeconvMethod)}>
                <option value="molde">Molde</option>
                <option value="gauss">Gaussiana</option>
              </select>
            </label>
            <button type="button" className={btnPrimaryClass} onClick={() => void create()} disabled={busy || !newName.trim()}>
              Criar estudo
            </button>
          </div>
        )}
        {studies.length === 0 && !showNew && (
          <p className="text-xs text-[var(--color-text-muted)]">
            Nenhum estudo ainda. Crie um e guarde nele as análises abertas — com as referências, moldes e curvas que elas usam.
          </p>
        )}
        <ul className="flex flex-col gap-1.5">
          {studies.map((s) => {
            const head = headlineGroups(s.headline[s.method]).filter((g) => g.materials.length > 1)
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSelected(s.id)}
                  className="w-full rounded-xl border px-3 py-2 text-left border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                  style={selected === s.id ? { borderColor: 'var(--color-primary)', boxShadow: '0 0 0 1px var(--color-primary)' } : undefined}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                    {s.tokens.length} análises · {s.reference_ids.length} ref. · {s.curve_ids.length} curvas · {METHOD_LABEL[s.method]}
                    {activeStudyId === s.id && <strong className="ml-1 text-[var(--color-primary)]">· aberto no workspace</strong>}
                  </div>
                  {head.length > 0 && (
                    // F1: cada componente, as poliolefinas somadas e o total (Σ encontrada ÷ pesada)
                    // lado a lado, com o n de réplicas válidas — não um % solto
                    <div className="mt-1.5 flex flex-col gap-1 border-t border-[var(--color-border)] pt-1.5 text-[11px] tabular-nums">
                      {head.slice(0, 4).map((g) => (
                        <div key={g.key} className="flex flex-wrap items-baseline gap-x-2.5">
                          <span className="w-full truncate text-[var(--color-text-muted)]">
                            {g.key.replace(/ %/g, '')} <span className="text-[var(--color-text-dim)]">({g.n_runs} rép.)</span>
                          </span>
                          {g.materials.map((m) => (
                            <span key={m.material} title={`recuperação de ${m.material} — n=${m.n}`}>
                              {m.material}{' '}
                              <strong style={{ color: recoveryColor(m.mean) }}>{m.mean !== null ? `${m.mean.toFixed(0)}%` : '—'}</strong>
                            </span>
                          ))}
                          {g.polyolefins && (
                            <span title={`${POLY_HELP} — n=${g.polyolefins.n}`}>
                              {g.polyolefins.label}{' '}
                              <strong style={{ color: recoveryColor(g.polyolefins.mean) }}>
                                {g.polyolefins.mean !== null ? `${g.polyolefins.mean.toFixed(0)}%` : '—'}
                              </strong>
                            </span>
                          )}
                          <span title={`${TOTAL_HELP} — n=${g.total.n}`}>
                            total{' '}
                            <strong style={{ color: recoveryColor(g.total.mean) }}>{g.total.mean !== null ? `${g.total.mean.toFixed(0)}%` : '—'}</strong>
                            <span className="text-[var(--color-text-dim)]"> {nValid(g.total.n, g.n_runs)}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      {/* detalhe */}
      <div className="flex min-w-0 flex-col gap-4">
        {message && <p className="text-sm text-[var(--color-text-muted)]">{message}</p>}
        {!detail && selected !== null && <p className="text-sm text-[var(--color-text-muted)]">Carregando o estudo…</p>}
        {detail && (
          <>
            <div className={cardClass}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {editing ? (
                    <div className="flex flex-col gap-2">
                      <input className={inputClass} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                      <textarea className={`${inputClass} h-16`} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className={btnPrimaryClass}
                          disabled={busy}
                          onClick={() => void refreshAfter(run(() => studyApi.update(detail.id, editing)).then((r) => (r ? (setEditing(null), r) : r)))}
                        >
                          Salvar
                        </button>
                        <button type="button" className={btnClass} onClick={() => setEditing(null)}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-semibold">{detail.name}</h2>
                        <StatusBadge status={detail.status} />
                        <button type="button" className={xBtn} onClick={() => setEditing({ name: detail.name, description: detail.description })} title="editar nome e descrição">
                          ✎
                        </button>
                      </div>
                      {detail.description && <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">{detail.description}</p>}
                      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                        criado em {new Date(detail.created_at).toLocaleDateString('pt-BR')}
                        {detail.finalized_at && ` · finalizado em ${new Date(detail.finalized_at).toLocaleDateString('pt-BR')}`}
                        {' · '}método principal{' '}
                        <select
                          className="rounded border bg-transparent px-1 text-xs border-[var(--color-border)]"
                          value={detail.method}
                          disabled={!isOpen || busy}
                          onChange={(e) => void refreshAfter(run(() => studyApi.update(detail.id, { method: e.target.value as DeconvMethod })))}
                        >
                          <option value="molde">Molde</option>
                          <option value="gauss">Gaussiana</option>
                        </select>
                      </p>
                    </>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {activeStudyId === detail.id ? (
                    <button type="button" className={btnClass} onClick={onCloseStudy}>
                      Fechar do workspace
                    </button>
                  ) : (
                    <button type="button" className={btnPrimaryClass} onClick={() => onOpenStudy(detail.id, 'deconv')} disabled={detail.tokens.length === 0}>
                      Abrir no workspace
                    </button>
                  )}
                  <button type="button" className={btnClass} onClick={() => void exportXlsx()} disabled={busy || detail.tokens.length === 0}>
                    {exporting ? 'Gerando o Excel… (pode levar ~1 min)' : 'Exportar Excel completo'}
                  </button>
                  <button
                    type="button"
                    className={btnClass}
                    onClick={() => void exportXlsx(true)}
                    disabled={busy || detail.tokens.length === 0}
                    title="o mesmo Excel, só valores — sem negrito, cores nem larguras (tabelas de artigo)"
                  >
                    Excel para publicação
                  </button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3 border-[var(--color-border)]">
                {isOpen && (
                  <button
                    type="button"
                    className={btnClass}
                    disabled={busy || openTokens.length === 0}
                    onClick={() =>
                      void refreshAfter(
                        run(() => studyApi.collect(detail.id, openTokens), 'Workspace guardado no estudo.').then((r) => {
                          // o workspace passa a ser este estudo
                          if (r && activeStudyId !== detail.id) onOpenStudy(detail.id)
                          return r
                        }),
                      )
                    }
                    title="guarda as análises abertas e as referências, moldes e curvas que elas usam"
                  >
                    Guardar workspace no estudo{newInWorkspace ? ` (+${newInWorkspace} análises)` : ''}
                  </button>
                )}
                {isOpen ? (
                  <button
                    type="button"
                    className={btnClass}
                    disabled={busy || detail.tokens.length === 0}
                    onClick={() => {
                      if (window.confirm('Finalizar o estudo? O relatório dos dois métodos fica congelado e as referências e curvas dele saem das listas gerais (continuam aqui). Dá para reabrir depois.'))
                        void refreshAfter(run(() => studyApi.update(detail.id, { status: 'finalizado' }), 'Estudo finalizado.'))
                    }}
                  >
                    Finalizar estudo
                  </button>
                ) : (
                  <button type="button" className={btnClass} disabled={busy} onClick={() => void refreshAfter(run(() => studyApi.update(detail.id, { status: 'aberto' }), 'Estudo reaberto.'))}>
                    Reabrir
                  </button>
                )}
                <button
                  type="button"
                  className={`${btnClass} ml-auto text-[var(--color-danger,#c0392b)]`}
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Apagar o estudo "${detail.name}"? Só o estudo: análises, referências, curvas e deconvoluções continuam onde estão.`))
                      void run(() => studyApi.remove(detail.id)).then((r) => {
                        if (!r) return
                        if (activeStudyId === detail.id) onCloseStudy()
                        setSelected(null)
                        setDetail(null)
                        onStudiesChanged()
                      })
                  }}
                >
                  Apagar estudo
                </button>
              </div>
            </div>

            {/* recuperação em destaque */}
            <div className={cardClass}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">
                  Recuperação
                  {report?.frozen && <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">(congelada na finalização)</span>}
                </h3>
                <div className="flex gap-1 rounded-full border p-0.5 text-xs border-[var(--color-border)]" role="tablist" aria-label="método">
                  {(['molde', 'gauss'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="tab"
                      aria-selected={viewMethod === m}
                      onClick={() => setViewMethod(m)}
                      className="rounded-full px-3 py-0.5"
                      style={{
                        backgroundColor: viewMethod === m ? 'var(--color-primary)' : 'transparent',
                        color: viewMethod === m ? 'var(--color-primary-contrast)' : 'var(--color-text-muted)',
                      }}
                    >
                      {METHOD_LABEL[m]}
                    </button>
                  ))}
                </div>
              </div>
              {detail.tokens.length === 0 ? (
                <p className="text-sm text-[var(--color-text-muted)]">
                  O estudo está vazio. Abra as análises (aba Análises), faça a deconvolução e use <strong>Guardar workspace no estudo</strong>.
                </p>
              ) : !report ? (
                <p className="text-sm text-[var(--color-text-muted)]">Calculando…</p>
              ) : groups.length === 0 ? (
                <p className="text-sm text-[var(--color-text-muted)]">
                  Nenhuma análise com deconvolução por {viewMethod === 'molde' ? 'molde' : 'gaussiana'} salva.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                  <RecoveryKpis groups={groups} compact />
                  <div className="mx-auto w-full max-w-xl">
                    <RecoveryBars groups={groups} />
                  </div>
                </div>
              )}
              {report && (report.report.missing_curves.length > 0 || report.report.skipped.length > 0) && (
                <p className="mt-2 text-xs text-[var(--color-warning,#b26a00)]">
                  {report.report.missing_curves.length > 0 && `Sem curva para: ${report.report.missing_curves.join(', ')}. `}
                  {report.report.skipped.length > 0 && `${report.report.skipped.length} análise(s) sem deconvolução salva neste método.`}
                </p>
              )}
              {detail.tokens.length > 0 && (
                <button type="button" className={`${btnClass} mt-3`} onClick={() => onOpenStudy(detail.id, 'relatorio')}>
                  Relatório detalhado (réplicas, gráficos, massas reais) →
                </button>
              )}
            </div>

            {/* F3: validação independente (calibração × validação, modo cego, RMSEP, ANOVA) */}
            {detail.tokens.length > 0 && (
              <div className={cardClass}>
                <h3 className="mb-1 font-semibold">Validação independente</h3>
                <p className="mb-3 text-xs text-[var(--color-text-muted)]">
                  Marque as corridas de calibração e as de validação (independentes das curvas). As de validação são
                  quantificadas pelas curvas e comparadas com a massa pesada: recuperação, viés, RMSEP e precisão
                  intermediária (ANOVA com o dia como fator) — {METHOD_LABEL[viewMethod ?? detail.method]}.
                </p>
                <PostRunValidationPanel
                  key={detail.id}
                  studyId={detail.id}
                  analyses={detail.analyses}
                  method={viewMethod ?? detail.method}
                  editable={detail.status === 'aberto'}
                />
              </div>
            )}

            {/* F6: comparador de modelos nos mesmos dados */}
            {detail.tokens.length > 0 && (
              <div className={cardClass}>
                <h3 className="mb-1 font-semibold">Comparador de modelos</h3>
                <p className="mb-3 text-xs text-[var(--color-text-muted)]">
                  Puros e misturas do estudo ajustados por vários modelos — mesma janela, mesmas referências — cada um com as
                  próprias curvas (refeitas com os puros no mesmo modelo). Recuperação, RMSE e BIC lado a lado; as ablações do
                  molde mostram o que a deformação (centro, dilatação) acrescenta.
                </p>
                <PostRunModelCompare key={detail.id} studyId={detail.id} />
              </div>
            )}

            {/* F7: interação na co-pirólise */}
            {detail.tokens.length > 0 && (
              <div className={cardClass}>
                <h3 className="mb-1 font-semibold">Interação na co-pirólise</h3>
                <p className="mb-3 text-xs text-[var(--color-text-muted)]">
                  Cada mistura contra a previsão sem interação (os moldes dos puros com as massas esperadas): a curva de
                  diferença e o ΔM, como no PMP-008; ΔTmax e Δlargura × fração; e os parâmetros que bateram no limite —{' '}
                  {METHOD_LABEL[viewMethod ?? detail.method]}.
                </p>
                <PostRunInteractionPanel key={`${detail.id}-${viewMethod ?? detail.method}`} studyId={detail.id} method={viewMethod ?? detail.method} />
              </div>
            )}

            {/* réplica a réplica: a corrida com o molde do puro, a forma e as larguras (22/10/2026) */}
            {report && viewMethod && report.report.runs.length > 0 && (
              <div className={cardClass}>
                <h3 className="mb-1 font-semibold">Réplicas — molde, forma e dilatação</h3>
                <p className="mb-3 text-xs text-[var(--color-text-muted)]">
                  Escolha uma réplica para ver a corrida com o molde do puro sobreposto e a forma normalizada ({METHOD_LABEL[viewMethod]}).
                </p>
                <PostRunStudyInspect report={report.report} method={viewMethod} />
              </div>
            )}

            {/* tolerância ótima de dilatação (23/10/2026) */}
            {detail.tokens.length > 0 && (
              <div className={cardClass}>
                <h3 className="mb-1 font-semibold">Tolerância ótima de dilatação (Molde)</h3>
                <p className="mb-3 text-xs text-[var(--color-text-muted)]">
                  Qual tolerância de largura faz a recuperação das misturas chegar mais perto das massas conhecidas — a curva
                  RMSE × tolerância deste sistema.
                </p>
                <PostRunStudyTolerance key={detail.id} studyId={detail.id} />
              </div>
            )}

            {/* o que o estudo guarda */}
            <div className={cardClass}>
              <div className="mb-3 flex flex-wrap gap-1 rounded-full border p-0.5 text-xs w-fit border-[var(--color-border)]" role="tablist">
                {(
                  [
                    ['analises', `Análises (${detail.tokens.length})`],
                    ['referencias', `Referências e moldes (${detail.references.length})`],
                    ['curvas', `Curvas (${detail.curves.length})`],
                    ['calibracoes', `Calibrações STD (${detail.calibrations.length})`],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={section === k}
                    onClick={() => setSection(k)}
                    className="rounded-full px-3 py-0.5"
                    style={{
                      backgroundColor: section === k ? 'var(--color-primary)' : 'transparent',
                      color: section === k ? 'var(--color-primary-contrast)' : 'var(--color-text-muted)',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {section === 'analises' && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-[var(--color-text-muted)]">
                      <tr>
                        <th className="py-1 pr-3">Réplica</th>
                        <th className="py-1 pr-3">Amostra</th>
                        <th className="py-1 pr-3">Composição</th>
                        <th className="py-1 pr-3">Massa (mg)</th>
                        <th className="py-1 pr-3">Deconvoluções</th>
                        <th className="py-1 pr-3">Job</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {detail.analyses.map((a) => (
                        <tr key={a.token} className="border-t border-[var(--color-border)]">
                          <td className="py-1 pr-3 font-mono">{a.summary ? stem(a.summary.filename) : a.token}</td>
                          <td className="py-1 pr-3">{a.summary?.sample}</td>
                          <td className="py-1 pr-3">{a.summary?.composition_text || '—'}</td>
                          <td className="py-1 pr-3 tabular-nums">{a.summary ? a.summary.mass_mg.toFixed(3) : ''}</td>
                          <td className="py-1 pr-3">
                            {a.ok ? (
                              (['gauss', 'molde'] as const).map((m) => (
                                <span
                                  key={m}
                                  className="mr-1 rounded px-1.5 py-0.5 text-[10px]"
                                  style={{
                                    background: a.saved_methods.includes(m) ? 'var(--color-surface)' : 'transparent',
                                    color: a.saved_methods.includes(m) ? 'var(--color-text)' : 'var(--color-text-muted)',
                                    textDecoration: a.saved_methods.includes(m) ? undefined : 'line-through',
                                  }}
                                >
                                  {METHOD_LABEL[m]}
                                </span>
                              ))
                            ) : (
                              <span className="text-[var(--color-danger,#c0392b)]">{a.error}</span>
                            )}
                          </td>
                          <td className="py-1 pr-3 text-[var(--color-text-muted)]">{a.summary?.job}</td>
                          <td className="py-1 text-right">
                            <button
                              type="button"
                              className={xBtn}
                              disabled={!isOpen || busy}
                              title="tirar do estudo (a análise continua no job)"
                              onClick={() => void refreshAfter(run(() => studyApi.items(detail.id, { remove: { tokens: [a.token] } })))}
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {section === 'referencias' && (
                <ul className="flex flex-col gap-1 text-sm">
                  {detail.references.length === 0 && <li className="text-xs text-[var(--color-text-muted)]">Nenhuma referência guardada.</li>}
                  {detail.references.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2 border-t py-1 border-[var(--color-border)]">
                      <span>
                        <strong>{r.name}</strong>
                        <span className="text-xs text-[var(--color-text-muted)]">
                          {' '}
                          · {r.n_runs} corridas · {r.has_template ? 'com molde' : 'sem molde'} ·{' '}
                          {r.peaks.map((p) => (p.mu_c !== null ? `${p.mu_c.toFixed(0)} °C` : '')).join(', ')} · {r.cycle_label}
                        </span>
                      </span>
                      <button
                        type="button"
                        className={xBtn}
                        disabled={!isOpen || busy}
                        title="tirar do estudo"
                        onClick={() => void refreshAfter(run(() => studyApi.items(detail.id, { remove: { reference_ids: [r.id] } })))}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {section === 'curvas' && (
                <ul className="flex flex-col gap-1 text-sm">
                  {detail.curves.length === 0 && <li className="text-xs text-[var(--color-text-muted)]">Nenhuma curva guardada.</li>}
                  {detail.curves.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 border-t py-1 border-[var(--color-border)]">
                      <span>
                        <strong>{c.name}</strong>
                        <span className="text-xs text-[var(--color-text-muted)]">
                          {' '}
                          · {c.component || 'amostra'} · {METHOD_LABEL[c.method]} · {c.model} · {c.n_points} pontos
                          {c.r2 !== null && ` · R² ${c.r2.toFixed(4)}`}
                        </span>
                        {c.equation && <span className="block font-mono text-[11px] text-[var(--color-text-muted)]">{c.equation}</span>}
                      </span>
                      <button
                        type="button"
                        className={xBtn}
                        disabled={!isOpen || busy}
                        title="tirar do estudo"
                        onClick={() => void refreshAfter(run(() => studyApi.items(detail.id, { remove: { curve_ids: [c.id] } })))}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {section === 'calibracoes' && (
                <div className="flex flex-col gap-2 text-sm">
                  <p className="text-xs text-[var(--color-text-muted)]">Calibrações de padrão STD (área → mg do FID) usadas no estudo — vão para o Excel com os pontos.</p>
                  <ul className="flex flex-col gap-1">
                    {detail.calibrations.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2 border-t py-1 border-[var(--color-border)]">
                        <span>
                          <strong>{c.name || `Calibração ${c.id}`}</strong>
                          <span className="text-xs text-[var(--color-text-muted)]">
                            {' '}
                            · {c.mode} {c.r2 !== null && `· R² ${c.r2.toFixed(4)}`} · {new Date(c.validated_at).toLocaleDateString('pt-BR')}
                          </span>
                        </span>
                        <button
                          type="button"
                          className={xBtn}
                          disabled={!isOpen || busy}
                          onClick={() => void refreshAfter(run(() => studyApi.items(detail.id, { remove: { calibration_ids: [c.id] } })))}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                  {isOpen && calibrations.some((c) => !detail.calibration_ids.includes(c.id)) && (
                    <select
                      className={`${inputClass} w-auto self-start`}
                      value=""
                      onChange={(e) =>
                        e.target.value && void refreshAfter(run(() => studyApi.items(detail.id, { add: { calibration_ids: [Number(e.target.value)] } })))
                      }
                    >
                      <option value="">+ adicionar calibração do FID…</option>
                      {calibrations
                        .filter((c) => !detail.calibration_ids.includes(c.id))
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name || `Calibração ${c.id}`} {c.is_active ? '(vigente)' : ''} — {new Date(c.validated_at).toLocaleDateString('pt-BR')}
                          </option>
                        ))}
                    </select>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
