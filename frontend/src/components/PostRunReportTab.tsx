import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { METHOD_LABEL, postrunApi, type DeconvMethod, type RecoveryReport, type ReportStat, type SavedCurve } from '../api/postrun'
import { PEAK_COLORS } from '../lib/postrunColors'
import { fmtMass, massTemplateCsv, parseComponentMasses } from '../lib/componentMassPaste'
import { parseMassNumber } from '../lib/weighingPaste'
import { PostRunScatterPlot } from './PostRunScatterPlot'
import { RecoveryBars, RecoveryKpis, groupsFromReport, recoveryColor } from './PostRunRecoveryViz'
import { inputClass, btnClass, btnPrimaryClass, cardClass } from '../ui/classes'

function stat(s: ReportStat, unit = '', digits = 1): string {
  if (s.mean === null) return '—'
  const m = s.mean.toFixed(digits)
  return s.sd !== null ? `${m} ± ${s.sd.toFixed(digits)}${unit}` : `${m}${unit}`
}

function signed(s: ReportStat, unit: string): string {
  if (s.mean === null) return '—'
  const m = `${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(1)}`
  return s.sd !== null ? `${m} ± ${s.sd.toFixed(1)} ${unit}` : `${m} ${unit}`
}

/** Aba "Relatório" do PostRun (Fase 4, pedido do usuário de 16/10/2026):
 * recuperação e interferência por mistura — média ± desvio das réplicas
 * (análises com a mesma composição e ciclo) para cada componente, a partir
 * das deconvoluções salvas das análises abertas. Excel com tudo. */
export function PostRunReportTab({
  tokens,
  method: methodProp,
  onMethodChange,
  embedded = false,
  curvesVersion = 0,
}: {
  tokens: string[]
  /** método das áreas (gaussiana ou molde) — controlado por quem chama, se vier */
  method?: DeconvMethod
  onMethodChange?: (m: DeconvMethod) => void
  /** dentro da aba Deconvolução (texto mais curto) */
  embedded?: boolean
  /** muda quando as curvas foram criadas/atualizadas (passo 3) — relê a lista */
  curvesVersion?: number
}) {
  const [ownMethod, setOwnMethod] = useState<DeconvMethod>('gauss')
  const method = methodProp ?? ownMethod
  const setMethod = (m: DeconvMethod) => {
    setOwnMethod(m)
    onMethodChange?.(m)
    setReport(null)
    setOverrides({})
  }
  const [allCurves, setAllCurves] = useState<SavedCurve[]>([])
  const curves = useMemo(() => allCurves.filter((c) => (c.deconv_method ?? 'gauss') === method), [allCurves, method])
  const [overrides, setOverrides] = useState<Record<string, number>>({})
  const [report, setReport] = useState<RecoveryReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // sub-aba da tabela: médias por composição ou cada réplica (24/10/2026)
  const [view, setView] = useState<'medias' | 'replicas'>('medias')
  // massas reais pesadas de cada polímero, por análise e componente (em
  // edição) — uma caixa por polímero, e colar do Excel (22/10/2026)
  const [massEdits, setMassEdits] = useState<Record<string, Record<string, string>>>({})
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteErrors, setPasteErrors] = useState<string[]>([])

  // a lista de curvas é relida quando o passo 3 cria/atualiza curvas e a cada
  // relatório gerado — antes ficava a da abertura da aba ("nenhuma curva por
  // molde" logo depois de criá-las, embora o cálculo já usasse a nova)
  const reloadCurves = () =>
    postrunApi.listCurves('pyro:FID').then((cs) => setAllCurves(cs.filter((c) => c.area_source === 'gaussian'))).catch(() => setAllCurves([]))
  useEffect(() => {
    void reloadCurves()
  }, [tokens.length, method, curvesVersion])
  useEffect(() => setReport(null), [methodProp])

  const materials = useMemo(() => {
    const set = new Set<string>(curves.map((c) => c.component))
    for (const g of report?.groups ?? []) for (const m of g.materials) set.add(m.material)
    return Array.from(set).filter(Boolean).sort()
  }, [curves, report])

  const req = () => ({ tokens, channel: 'pyro:FID', curve_ids: overrides, method })

  async function generate() {
    setBusy(true)
    setMessage(null)
    try {
      setReport(await postrunApi.recoveryReport(req()))
      void reloadCurves()
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao gerar o relatório')
    } finally {
      setBusy(false)
    }
  }

  async function downloadXlsx() {
    setBusy(true)
    try {
      const blob = await postrunApi.recoveryReportXlsx(req())
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `postrun_recuperacao_${method}_${new Date().toISOString().slice(0, 10)}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao gerar o Excel')
    } finally {
      setBusy(false)
    }
  }

  const colorOf = (mat: string) => PEAK_COLORS[Math.max(0, materials.indexOf(mat)) % PEAK_COLORS.length]
  const mixtureGroups = (report?.groups ?? []).filter((g) => Object.keys(g.composition).length > 1)
  const recPoints = mixtureGroups.flatMap((g) =>
    g.materials
      .filter((m) => m.fraction !== null && m.recovery_pct.mean !== null)
      .map((m) => ({
        x: 100 * (m.fraction as number), y: m.recovery_pct.mean as number, yErr: m.recovery_pct.sd ?? undefined,
        color: colorOf(m.material), title: `${g.key} — ${m.material}: ${stat(m.recovery_pct, ' %')}`,
      })),
  )
  const dTPoints = mixtureGroups.flatMap((g) =>
    g.materials
      .filter((m) => m.fraction !== null && m.delta_mu_c.mean !== null)
      .map((m) => ({
        x: 100 * (m.fraction as number), y: m.delta_mu_c.mean as number, yErr: m.delta_mu_c.sd ?? undefined,
        color: colorOf(m.material), title: `${g.key} — ${m.material}: ${signed(m.delta_mu_c, '°C')}`,
      })),
  )
  const legend = Array.from(new Set(mixtureGroups.flatMap((g) => g.materials.map((m) => m.material)))).map((m) => ({ label: m, color: colorOf(m) }))
  // réplicas com o pico no limite da tolerância (por composição e material)
  const atLimit = (group: string, mat: string) =>
    (report?.runs ?? []).some((r) => r.group === group && r.materials.some((m) => m.material === mat && m.flags.some((f) => f.includes('limite'))))
  const dWPoints = mixtureGroups.flatMap((g) =>
    g.materials
      .filter((m) => m.fraction !== null && m.delta_width_pct.mean !== null)
      .map((m) => ({
        x: 100 * (m.fraction as number), y: m.delta_width_pct.mean as number, yErr: m.delta_width_pct.sd ?? undefined,
        color: colorOf(m.material), hollow: atLimit(g.key, m.material),
        title: `${g.key} — ${m.material}: ${signed(m.delta_width_pct, '%')}${atLimit(g.key, m.material) ? ' · no limite da tolerância' : ''}`,
      })),
  )
  // faixa natural: média ± 2 desvios da dilatação entre as corridas puras de cada material
  const naturalBands = Object.entries(report?.natural_width ?? {})
    .filter(([mat, s]) => s.mean !== null && legend.some((l) => l.label === mat))
    .map(([mat, s]) => ({ y0: (s.mean as number) - 2 * (s.sd ?? 0), y1: (s.mean as number) + 2 * (s.sd ?? 0), color: colorOf(mat), mat, s }))

  const groupOrder = (report?.groups ?? []).map((g) => g.key)
  const runsByGroup = groupOrder.map((key) => ({ key, runs: (report?.runs ?? []).filter((r) => r.group === key) }))
  // só as misturas recebem massa por polímero (puro = a massa da corrida)
  const mixRuns = runsByGroup.flatMap((g) => g.runs).filter((r) => r.materials.length > 1 || r.component_masses)
  const pasteRuns = mixRuns.map((r) => ({
    token: r.token, filename: r.filename, sample: r.sample, materials: r.materials.map((m) => m.material), masses: r.component_masses,
  }))
  const massValue = (r: { token: string; component_masses?: Record<string, number> | null }, mat: string) =>
    massEdits[r.token]?.[mat] ?? (r.component_masses?.[mat] != null ? fmtMass(r.component_masses[mat]) : '')
  const nEdited = Object.keys(massEdits).length
  function applyPaste() {
    const { edits, errors } = parseComponentMasses(pasteText, pasteRuns)
    setPasteErrors(errors)
    setMassEdits((prev) => {
      const next = { ...prev }
      for (const [token, masses] of Object.entries(edits)) next[token] = { ...(prev[token] ?? {}), ...masses }
      return next
    })
    if (!errors.length) {
      setPasteText('')
      setPasteOpen(false)
    }
  }
  function downloadMassTemplate() {
    const url = URL.createObjectURL(new Blob([massTemplateCsv(pasteRuns)], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'massas_reais_replicas.csv'
    a.click()
    URL.revokeObjectURL(url)
  }
  async function saveMasses() {
    const items: { token: string; component_masses_text: string }[] = []
    for (const token of Object.keys(massEdits)) {
      const run = report?.runs.find((r) => r.token === token)
      if (!run) continue
      const mats = [...new Set([...run.materials.map((m) => m.material), ...Object.keys(massEdits[token])])]
      const parts: string[] = []
      for (const mat of mats) {
        const raw = massValue(run, mat).trim()
        if (!raw) continue
        const v = parseMassNumber(raw)
        if (v === null || v <= 0) {
          setMessage(`${run.filename.replace(/\.B00$/i, '')}: "${raw}" não é uma massa válida para ${mat}`)
          return
        }
        parts.push(`${mat} ${v}`)
      }
      items.push({ token, component_masses_text: parts.join('; ') })
    }
    if (!items.length) return
    setBusy(true)
    setMessage(null)
    try {
      await postrunApi.updateMeta(items)
      setMassEdits({})
      setReport(await postrunApi.recoveryReport(req()))
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao salvar as massas reais')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className={cardClass}>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Recuperação e interferência por mistura</h2>
          {!methodProp && (
            <div className="flex gap-1 rounded-full border p-0.5 text-xs border-[var(--color-border)]" role="tablist" aria-label="método">
              {(['gauss', 'molde'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={method === m}
                  onClick={() => setMethod(m)}
                  className="rounded-full px-3 py-0.5"
                  style={{
                    backgroundColor: method === m ? 'var(--color-primary)' : 'transparent',
                    color: method === m ? 'var(--color-primary-contrast)' : 'var(--color-text-muted)',
                  }}
                >
                  {METHOD_LABEL[m]}
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Método: <strong>{METHOD_LABEL[method]}</strong> — usa as deconvoluções por {method === 'molde' ? 'molde' : 'gaussiana'}{' '}
          salvas das {tokens.length} análises abertas e, para cada componente, a curva do mesmo método (a mais recente do
          ciclo, ou a escolhida abaixo). Réplicas = análises com a mesma composição (nominal, do nome). Recuperação = massa
          pela curva ÷ massa esperada: a <strong>massa real pesada</strong> de cada polímero, quando informada na sub-aba
          Réplicas; senão, fração nominal × massa da corrida.{!embedded && ' O passo a passo (referências, ajuste e curvas) fica na aba Deconvolução.'}
        </p>
        {materials.length > 0 && (
          <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-3">
            {materials.map((mat) => {
              const options = curves.filter((c) => c.component === mat)
              return (
                <label key={mat} className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                  Curva de {mat}
                  <select
                    className={inputClass}
                    value={overrides[mat] ?? ''}
                    onChange={(e) =>
                      setOverrides((prev) => {
                        const next = { ...prev }
                        if (e.target.value) next[mat] = Number(e.target.value)
                        else delete next[mat]
                        return next
                      })
                    }
                  >
                    <option value="">{options.length ? 'a mais recente do ciclo (automático)' : `— nenhuma curva por ${method === 'molde' ? 'molde' : 'gaussiana'} —`}</option>
                    {options.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} (R² {c.fit?.r2.toFixed(4)})
                      </option>
                    ))}
                  </select>
                </label>
              )
            })}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnPrimaryClass} onClick={() => void generate()} disabled={busy || tokens.length === 0}>
            Gerar relatório
          </button>
          <button type="button" className={btnClass} onClick={() => void downloadXlsx()} disabled={busy || tokens.length === 0}>
            Baixar Excel
          </button>
          {tokens.length === 0 && <span className="text-xs text-[var(--color-text-muted)]">Abra as análises na aba Análises.</span>}
          {message && <span className="text-xs text-[var(--color-danger)]">{message}</span>}
        </div>
        {report && (report.missing_curves.length > 0 || report.skipped.length > 0) && (
          <div className="mt-2 text-xs text-[var(--color-warning,#b26a00)]">
            {report.missing_curves.length > 0 && (
              <p>
                Sem curva por {method === 'molde' ? 'molde' : 'gaussiana'} para: {report.missing_curves.join(', ')} — crie no passo 3 da
                aba Deconvolução.
              </p>
            )}
            {report.skipped.length > 0 && (
              <p>
                Fora do relatório: {report.skipped.length} análise(s) — {Array.from(new Set(report.skipped.map((s) => s.reason))).join('; ')}.
              </p>
            )}
          </div>
        )}
      </div>

      {report && report.groups.length > 0 && (
        <>
          {/* recuperação em destaque (22/10/2026) */}
          <div className={cardClass}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">Recuperação</h3>
              <span className="text-[11px] text-[var(--color-text-muted)]">
                média ± desvio das réplicas · <span style={{ color: recoveryColor(100) }}>■</span> até ±5 % de 100{' '}
                <span style={{ color: recoveryColor(108) }}>■</span> até ±10 % <span style={{ color: recoveryColor(150) }}>■</span> além
              </span>
            </div>
            <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <RecoveryKpis groups={groupsFromReport(report.groups)} compact />
              <div className="mx-auto w-full max-w-xl">
                <RecoveryBars groups={groupsFromReport(report.groups)} />
              </div>
            </div>
          </div>
          <div className={cardClass}>
            <div className="mb-2 flex flex-wrap items-center gap-1 rounded-full border p-0.5 text-xs self-start border-[var(--color-border)] w-fit" role="tablist" aria-label="Médias ou réplicas">
              {(
                [
                  ['medias', 'Médias por composição'],
                  ['replicas', `Réplicas (${report.runs.length})`],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={view === k}
                  onClick={() => setView(k)}
                  className="rounded-full px-3 py-0.5"
                  style={{
                    backgroundColor: view === k ? 'var(--color-primary)' : 'transparent',
                    color: view === k ? 'var(--color-primary-contrast)' : 'var(--color-text-muted)',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {view === 'replicas' && (
              <div className="overflow-x-auto">
                <p className="mb-2 text-xs text-[var(--color-text-muted)]">
                  Cada réplica (análise independente). Em <strong>Massa real</strong>, a massa pesada de cada polímero na mistura
                  (mg) — a esperada passa a ser essa massa, e a fração real aparece ao lado da nominal. Para muitas réplicas,
                  use <strong>Colar do Excel</strong>.
                </p>
                {mixRuns.length > 0 && (
                  <div className="mb-3 flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" className={btnClass} onClick={() => setPasteOpen((v) => !v)}>
                        {pasteOpen ? 'Fechar colagem' : 'Colar do Excel'}
                      </button>
                      <button type="button" className={btnClass} onClick={downloadMassTemplate}>
                        Baixar modelo (.csv)
                      </button>
                      <span className="text-[11px] text-[var(--color-text-muted)]">
                        o modelo traz uma linha por réplica e uma coluna por polímero — preencha no Excel e cole aqui
                      </span>
                    </div>
                    {pasteOpen && (
                      <div className="flex flex-col gap-1">
                        <textarea
                          className={`${inputClass} h-32 font-mono text-xs`}
                          value={pasteText}
                          onChange={(e) => setPasteText(e.target.value)}
                          placeholder={'Amostra\tPEAD\tPS\n' + mixRuns.slice(0, 2).map((r) => `${r.filename.replace(/\.B00$/i, '')}\t1,012\t0,998`).join('\n')}
                          aria-label="Massas reais coladas do Excel"
                        />
                        <span className="text-[11px] text-[var(--color-text-muted)]">
                          Copie do Excel as colunas Amostra + uma por polímero, com o cabeçalho. A amostra pode ser o nome do
                          arquivo ou um trecho único dele. Sem a coluna Amostra, as linhas seguem a ordem da tabela abaixo.
                          Os valores entram nas caixas — confira e clique em salvar.
                        </span>
                        <div className="flex gap-2">
                          <button type="button" className={btnPrimaryClass} onClick={applyPaste} disabled={!pasteText.trim()}>
                            Preencher as caixas
                          </button>
                        </div>
                        {pasteErrors.length > 0 && (
                          <ul className="list-disc pl-5 text-xs text-[var(--color-danger,#c0392b)]">
                            {pasteErrors.map((e) => <li key={e}>{e}</li>)}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <table className="w-full text-left text-xs">
                  <thead className="text-[var(--color-text-muted)]">
                    <tr>
                      <th className="py-1 pr-3">Réplica</th>
                      <th className="py-1 pr-3">Massa (mg)</th>
                      <th className="py-1 pr-3">Componente</th>
                      <th className="py-1 pr-3">Massa real (mg)</th>
                      <th className="py-1 pr-3">Fração nominal → real</th>
                      <th className="py-1 pr-3">Esperada (mg)</th>
                      <th className="py-1 pr-3">Encontrada (mg)</th>
                      <th className="py-1 pr-3">Recuperação</th>
                      <th className="py-1 pr-3">ΔTmax</th>
                      <th className="py-1 pr-3">Δlargura</th>
                      <th className="py-1 pr-3">Rec. total</th>
                      <th className="py-1 pr-3">R²</th>
                      <th className="py-1 pr-3">Avisos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runsByGroup.map(({ key, runs }) => [
                      <tr key={`h|${key}`} className="border-t-2 border-[var(--color-border)]">
                        <td colSpan={13} className="pt-2 pb-1 font-semibold text-[var(--color-text)]">
                          {key} · {runs.length} réplica(s)
                        </td>
                      </tr>,
                      ...runs.flatMap((r) =>
                        r.materials.map((m, i) => (
                          <tr key={`${r.token}|${m.material}`} className={i === 0 ? 'border-t border-[var(--color-border)]' : ''}>
                            {i === 0 && (
                              <>
                                <td className="py-1 pr-3 align-top font-mono" rowSpan={r.materials.length}>{r.filename.replace(/\.B00$/i, '')}</td>
                                <td className="py-1 pr-3 align-top tabular-nums" rowSpan={r.materials.length}>
                                  {r.mass_mg.toFixed(3)}{r.mass_source === 'manual' ? ' ✎' : ''}
                                </td>
                              </>
                            )}
                            <td className="py-1 pr-3">
                              <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full" style={{ background: colorOf(m.material) }} />
                              {m.material}
                            </td>
                            <td className="py-1 pr-3">
                              {r.materials.length > 1 || r.component_masses ? (
                                <input
                                  className={`${inputClass} w-20 text-xs tabular-nums ${massEdits[r.token]?.[m.material] !== undefined ? 'ring-1 ring-[var(--color-primary)]' : ''}`}
                                  inputMode="decimal"
                                  value={massValue(r, m.material)}
                                  placeholder="0,000"
                                  onChange={(e) => {
                                    const v = e.target.value
                                    setMassEdits((prev) => ({ ...prev, [r.token]: { ...(prev[r.token] ?? {}), [m.material]: v } }))
                                  }}
                                  aria-label={`Massa real de ${m.material} em ${r.filename}`}
                                />
                              ) : (
                                <span className="text-[var(--color-text-dim)]">—</span>
                              )}
                            </td>
                            <td className="py-1 pr-3 tabular-nums">
                              {m.fraction !== null ? `${(100 * m.fraction).toFixed(0)} %` : '—'}
                              {m.real_fraction != null && <> → <strong>{(100 * m.real_fraction).toFixed(1)} %</strong></>}
                            </td>
                            <td className="py-1 pr-3 tabular-nums" title={m.expected_source}>
                              {m.expected_mg !== null ? m.expected_mg.toFixed(3) : '—'}
                              {m.expected_source === 'massa real pesada' && <span className="text-[10px] text-[var(--color-text-dim)]"> real</span>}
                            </td>
                            <td className="py-1 pr-3 tabular-nums">
                              {m.found_mg !== null ? `${m.found_mg.toFixed(3)} ± ${(m.U95_mg ?? NaN).toFixed(3)}` : '—'}
                            </td>
                            <td className="py-1 pr-3 tabular-nums font-medium">{m.recovery_pct !== null ? `${m.recovery_pct.toFixed(1)} %` : '—'}</td>
                            <td className="py-1 pr-3 tabular-nums">{m.delta_mu_c !== null ? `${m.delta_mu_c >= 0 ? '+' : ''}${m.delta_mu_c.toFixed(1)} °C` : '—'}</td>
                            <td className="py-1 pr-3 tabular-nums">{m.delta_width_pct !== null ? `${m.delta_width_pct >= 0 ? '+' : ''}${m.delta_width_pct.toFixed(1)} %` : '—'}</td>
                            {i === 0 && (
                              <>
                                <td className="py-1 pr-3 align-top tabular-nums" rowSpan={r.materials.length}>
                                  {r.total_recovery_pct !== null ? `${r.total_recovery_pct.toFixed(1)} %` : '—'}
                                </td>
                                <td className="py-1 pr-3 align-top tabular-nums" rowSpan={r.materials.length}>{r.r2.toFixed(4)}</td>
                              </>
                            )}
                            <td className="py-1 pr-3 text-[var(--color-warning,#b26a00)]">{[...m.flags, ...(i === 0 ? r.warnings : [])].join('; ')}</td>
                          </tr>
                        )),
                      ),
                    ])}
                  </tbody>
                </table>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" className={btnPrimaryClass} onClick={() => void saveMasses()} disabled={busy || nEdited === 0}>
                    Salvar massas reais e recalcular{nEdited ? ` (${nEdited} réplica${nEdited > 1 ? 's' : ''})` : ''}
                  </button>
                  {nEdited > 0 && (
                    <button type="button" className={btnClass} onClick={() => setMassEdits({})} disabled={busy}>
                      Descartar
                    </button>
                  )}
                  <span className="text-[11px] text-[var(--color-text-muted)]">caixas vazias = volta à fração nominal × massa da corrida</span>
                </div>
              </div>
            )}
            {view === 'medias' && <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-[var(--color-text-muted)]">
                  <tr>
                    <th className="py-1 pr-3">Mistura</th>
                    <th className="py-1 pr-3">Réplicas</th>
                    <th className="py-1 pr-3">Componente</th>
                    <th className="py-1 pr-3">Esperada (mg)</th>
                    <th className="py-1 pr-3">Encontrada (mg)</th>
                    <th className="py-1 pr-3">Recuperação</th>
                    <th className="py-1 pr-3">ΔTmax</th>
                    <th className="py-1 pr-3">Δlargura</th>
                    <th className="py-1 pr-3">Recuperação total</th>
                    <th className="py-1 pr-3">R² mín.</th>
                  </tr>
                </thead>
                <tbody>
                  {report.groups.map((g) =>
                    g.materials.map((m, i) => (
                      <tr key={`${g.key}|${m.material}`} className={i === 0 ? 'border-t-2 border-[var(--color-border)]' : ''}>
                        {i === 0 && (
                          <>
                            <td className="py-1 pr-3 align-top font-medium" rowSpan={g.materials.length}>
                              {g.key}
                            </td>
                            <td className="py-1 pr-3 align-top" rowSpan={g.materials.length}>
                              {g.n_runs}
                              {g.n_runs_with_warnings > 0 && (
                                <span className="block text-[10px] text-[var(--color-warning,#b26a00)]">{g.n_runs_with_warnings} com aviso</span>
                              )}
                            </td>
                          </>
                        )}
                        <td className="py-1 pr-3">
                          <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full" style={{ background: colorOf(m.material) }} />
                          {m.material}
                          {m.fraction !== null && <span className="text-xs text-[var(--color-text-muted)]"> ({(100 * m.fraction).toFixed(0)} %)</span>}
                        </td>
                        <td className="py-1 pr-3 tabular-nums">{stat(m.expected_mg, '', 3)}</td>
                        <td className="py-1 pr-3 tabular-nums">{stat(m.found_mg, '', 3)}</td>
                        <td className="py-1 pr-3 tabular-nums font-semibold" style={{ color: recoveryColor(m.recovery_pct.mean) }}>
                          {stat(m.recovery_pct, ' %')}
                        </td>
                        <td className="py-1 pr-3 tabular-nums">{signed(m.delta_mu_c, '°C')}</td>
                        <td className="py-1 pr-3 tabular-nums">{signed(m.delta_width_pct, '%')}</td>
                        {i === 0 && (
                          <>
                            <td className="py-1 pr-3 align-top tabular-nums font-semibold" rowSpan={g.materials.length}
                              style={{ color: recoveryColor(g.total_recovery_pct.mean) }}>
                              {stat(g.total_recovery_pct, ' %')}
                            </td>
                            <td className="py-1 pr-3 align-top tabular-nums" rowSpan={g.materials.length}>
                              {g.r2_min.toFixed(4)}
                            </td>
                          </>
                        )}
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>}
          </div>

          {recPoints.length > 0 && (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              <div className={cardClass}>
                <h3 className="font-semibold">Recuperação × fração do componente</h3>
                <p className="mb-1 text-xs text-[var(--color-text-muted)]">Média ± desvio das réplicas · linha tracejada = 100 %</p>
                <PostRunScatterPlot points={recPoints} xLabel="Fração do componente na mistura (%)" yLabel="Recuperação (%)" hLine={100} legend={legend} height={260} />
              </div>
              <div className={cardClass}>
                <h3 className="font-semibold">ΔTmax × fração do componente</h3>
                <p className="mb-1 text-xs text-[var(--color-text-muted)]">Deslocamento do pico em relação ao material puro · linha = sem deslocamento</p>
                <PostRunScatterPlot points={dTPoints} xLabel="Fração do componente na mistura (%)" yLabel="ΔTmax (°C)" hLine={0} legend={legend} height={260} />
              </div>
              <div className={`${cardClass} lg:col-span-2 2xl:col-span-1`}>
                <h3 className="font-semibold">Δlargura × fração do componente</h3>
                <p className="mb-1 text-xs text-[var(--color-text-muted)]">
                  Alargamento do pico em relação ao molde do puro (média ± desvio das réplicas). Faixa colorida = dilatação
                  natural dos puros (média ± 2 desvios entre as corridas puras): dentro dela, o alargamento não passa da variação
                  normal. Ponto vazado = alguma réplica ficou no limite da tolerância (o pico queria alargar mais — aumente o limite).
                </p>
                <PostRunScatterPlot
                  points={dWPoints}
                  xLabel="Fração do componente na mistura (%)"
                  yLabel="Δlargura (%)"
                  hLine={0}
                  hBands={naturalBands}
                  legend={legend}
                  height={260}
                />
                {naturalBands.length > 0 && (
                  <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                    Dilatação natural:{' '}
                    {naturalBands.map((b) => `${b.mat} ${signed(b.s, '%')} (n = ${b.s.n})`).join(' · ')}
                  </p>
                )}
              </div>
            </div>
          )}

        </>
      )}
      {report && report.groups.length === 0 && (
        <p className="text-sm text-[var(--color-text-muted)]">Nenhuma análise aberta com deconvolução salva.</p>
      )}
    </div>
  )
}
