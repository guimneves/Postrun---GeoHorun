import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import {
  METHOD_LABEL,
  postrunApi,
  type AnalysisSummary,
  type DeconvMethod,
  type DeconvReference,
  type WorkflowCurveResult,
  type WorkflowItem,
  type WorkflowReferencesResult,
  type WorkflowStatus,
} from '../api/postrun'
import { PostRunReferencesTab } from './PostRunReferencesTab'
import { PostRunReportTab } from './PostRunReportTab'
import { inputInlineClass as inputClass, btnPrimaryClass, cardClass } from '../ui/classes'

// Aba Deconvolução do PostRun (pedido do usuário, 17/10/2026): molde,
// referência, deconvolução, curvas e recuperação num lugar só, em 4
// passos — cada um um botão, sobre as análises abertas (com a região de
// cada uma, definida na aba Análises, e a composição dela). Gaussiana e
// molde ficam salvos lado a lado: trocar o método não apaga o outro.

function short(name: string): string {
  return name.replace(/\.B00$/i, '')
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean | null; children: React.ReactNode }) {
  return (
    <section className={cardClass}>
      <h2 className="mb-2 flex flex-wrap items-center gap-2 font-semibold">
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs"
          style={{
            background: done ? 'var(--color-status-ready, #1baf7a)' : 'var(--color-surface)',
            color: done ? '#fff' : 'var(--color-text-muted)',
          }}
        >
          {done ? '✓' : n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  )
}

function ItemsTable({ items, names }: { items: WorkflowItem[]; names: Record<string, string> }) {
  if (!items.length) return null
  const bad = items.filter((i) => !i.ok)
  return (
    <div className="mt-2 text-xs">
      <p className="mb-1 text-[var(--color-text-muted)]">
        {items.length - bad.length} de {items.length} ajustada(s) e salva(s){bad.length ? ` · ${bad.length} com problema` : ''}.
      </p>
      <div className="max-h-64 overflow-auto">
        <table className="w-full text-left">
          <thead className="text-[var(--color-text-muted)]">
            <tr>
              <th className="py-1 pr-3">Análise</th>
              <th className="py-1 pr-3">R²</th>
              <th className="py-1">Avisos / erro</th>
            </tr>
          </thead>
          <tbody>
            {[...bad, ...items.filter((i) => i.ok)].map((i) => (
              <tr key={i.token} className="border-t border-[var(--color-border)]">
                <td className="py-1 pr-3 font-mono">{names[i.token] ?? i.token}</td>
                <td className="py-1 pr-3 tabular-nums">{i.r2 != null ? i.r2.toFixed(4) : '—'}</td>
                <td className="py-1" style={{ color: i.ok ? '#b26a00' : 'var(--color-danger)' }}>
                  {i.ok ? i.warnings.join(' · ') : i.error}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function PostRunDeconvTab({
  openTokens,
  references,
  onReferencesChanged,
  analysesByToken,
  onAnalysesUpdated,
  onSavedChanged,
  onGoToAnalyses,
}: {
  openTokens: string[]
  references: DeconvReference[]
  onReferencesChanged: () => void
  analysesByToken: Record<string, AnalysisSummary>
  onAnalysesUpdated: (items: AnalysisSummary[]) => void
  /** deconvoluções salvas mudaram (para a aba Análises reler) */
  onSavedChanged: () => void
  onGoToAnalyses: () => void
}) {
  const [status, setStatus] = useState<WorkflowStatus | null>(null)
  // para quais análises o status foi lido — a lista nunca mostra o de antes
  const [statusKey, setStatusKey] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [method, setMethod] = useState<DeconvMethod>('molde')
  // limites de partida (no PP_PS 50-50 o PP alarga ~30 % e desloca ~−12 °C no molde)
  const [tolC, setTolC] = useState(25)
  const [tolW, setTolW] = useState(40)
  const [model, setModel] = useState('linear')
  const [weighting, setWeighting] = useState('1/x2')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refResult, setRefResult] = useState<WorkflowReferencesResult | null>(null)
  const [fitResult, setFitResult] = useState<Partial<Record<DeconvMethod, WorkflowItem[]>>>({})
  const [curveResult, setCurveResult] = useState<Partial<Record<DeconvMethod, WorkflowCurveResult[]>>>({})
  const [refreshKey, setRefreshKey] = useState(0)
  const [curvesVersion, setCurvesVersion] = useState(0)
  const [showRuns, setShowRuns] = useState(false)

  const load = useCallback(() => {
    if (openTokens.length === 0) {
      setStatus(null)
      return
    }
    setLoading(true)
    setLoadError(null)
    const key = openTokens.join('\n')
    postrunApi
      .workflowStatus(openTokens)
      .then((s) => {
        setStatus(s)
        setStatusKey(key)
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Erro ao ler as análises abertas'))
      .finally(() => setLoading(false))
  }, [openTokens])
  useEffect(load, [load])

  const current = statusKey === openTokens.join('\n')
  const runs = current ? (status?.runs ?? []) : []
  const failed = runs.filter((r) => r.error)
  const names = useMemo(() => Object.fromEntries(runs.map((r) => [r.token, short(r.filename)])), [runs])
  const pure = runs.filter((r) => r.kind === 'pure')
  const mixtures = runs.filter((r) => r.kind === 'mixture')
  const unknown = runs.filter((r) => r.kind === 'unknown')
  const noRegion = runs.filter((r) => !r.has_region)
  const pureByMat = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of pure) m.set(r.material ?? '?', (m.get(r.material ?? '?') ?? 0) + 1)
    return m
  }, [pure])
  const cycles = new Set(runs.map((r) => r.cycle_key).filter(Boolean))

  // o que já está feito, por passo
  // materiais que as análises abertas precisam (componentes das misturas e
  // puros), por ciclo — sem puros abertos, valem as referências e curvas já
  // salvas (o passo 1 e o 3 só CRIAM, a partir dos puros abertos)
  const needed = useMemo(() => {
    const out: { material: string; cycle_key: string; cycle_label: string }[] = []
    for (const r of runs)
      for (const mat of Object.keys(r.composition ?? {}))
        if (r.cycle_key && !out.some((n) => n.material === mat && n.cycle_key === r.cycle_key))
          out.push({ material: mat, cycle_key: r.cycle_key, cycle_label: r.cycle_label })
    return out.sort((a, b) => a.material.localeCompare(b.material))
  }, [runs])
  const refOf = (n: { material: string; cycle_key: string }) =>
    (status?.references ?? []).find((f) => f.name === n.material && f.cycle_key === n.cycle_key && f.has_template)
  const curveOf = (n: { material: string; cycle_key: string }) =>
    (status?.curves ?? []).find((c) => c.component === n.material && c.method === method && c.cycle_key === n.cycle_key)
  const refsDone =
    pure.length > 0
      ? pure.every((r) => (status?.references ?? []).some((f) => f.name === r.material && f.cycle_key === r.cycle_key && f.has_template))
      : needed.length > 0 && needed.every((n) => refOf(n))
  const withComp = runs.filter((r) => r.kind !== 'unknown' && r.has_region)
  const fittedN = withComp.filter((r) => r.saved[method]).length
  const curvesDone =
    pure.length > 0
      ? Array.from(pureByMat.keys()).every((mat) =>
          (status?.curves ?? []).some((c) => c.component === mat && c.method === method && cycles.has(c.cycle_key)),
        )
      : needed.length > 0 && needed.every((n) => curveOf(n))

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Erro em: ${label}`)
    } finally {
      setBusy(null)
      load()
    }
  }

  const stepRefs = () =>
    run('referências', async () => {
      const res = await postrunApi.workflowReferences(openTokens)
      setRefResult(res)
      setRefreshKey((k) => k + 1)
      onReferencesChanged()
      onSavedChanged()
    })
  const stepFit = () =>
    run('ajuste', async () => {
      const res = await postrunApi.workflowFit(openTokens, method, tolC, tolW)
      setFitResult((p) => ({ ...p, [method]: res }))
      onSavedChanged()
    })
  const stepCurves = () =>
    run('curvas', async () => {
      const res = await postrunApi.workflowCurves(openTokens, method, model, weighting)
      setCurveResult((p) => ({ ...p, [method]: res }))
      setCurvesVersion((v) => v + 1)
    })

  if (openTokens.length === 0)
    return (
      <div className={`${cardClass} text-sm text-[var(--color-text-muted)]`}>
        Abra na aba <strong>Análises</strong> as corridas que entram (os puros de cada material e as misturas), com a região
        (janela) de cada uma salva. Depois volte aqui.{' '}
        <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={onGoToAnalyses}>
          ir para Análises →
        </button>
      </div>
    )

  return (
    <div className="flex flex-col gap-4">
      {/* as análises abertas */}
      <section className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">
            Análises abertas ({openTokens.length})
            {!current && (
              <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">
                {loading ? `lendo as ${openTokens.length} análises…` : loadError ? '' : 'aguardando a leitura…'}
              </span>
            )}
          </h2>
          <span className="flex gap-3 text-xs">
            <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => setShowRuns((v) => !v)}>
              {showRuns ? 'esconder a lista' : 'ver a lista'}
            </button>
            <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={load} disabled={loading}>
              {loading ? 'lendo…' : 'atualizar'}
            </button>
          </span>
        </div>
        {loadError && (
          <p className="mt-2 text-xs text-[var(--color-danger)]">
            Não foi possível ler as análises abertas: {loadError}{' '}
            <button type="button" className="underline" onClick={load}>
              tentar de novo
            </button>
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {Array.from(pureByMat.entries()).map(([m, n]) => (
            <span key={m} className="rounded-full border px-2 py-0.5 border-[var(--color-border)]">
              puro <strong>{m}</strong> · {n}
            </span>
          ))}
          <span className="rounded-full border px-2 py-0.5 border-[var(--color-border)]">misturas · {mixtures.length}</span>
          {failed.length > 0 && (
            <span className="rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}
              title={failed.map((r) => `${short(r.filename)}: ${r.error}`).join('\n')}>
              com erro de leitura · {failed.length} (veja a lista)
            </span>
          )}
          {unknown.length > 0 && (
            <span className="rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}>
              sem composição · {unknown.length} (informe na aba Curvas)
            </span>
          )}
          {noRegion.length > 0 && (
            <span className="rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}>
              sem região salva · {noRegion.length}{' '}
              <button type="button" className="underline" onClick={onGoToAnalyses}>
                definir
              </button>
            </span>
          )}
          {cycles.size > 1 && (
            <span className="rounded-full border px-2 py-0.5 text-[#b26a00] border-[#b26a00]">
              {cycles.size} ciclos diferentes — referências e curvas valem por ciclo
            </span>
          )}
        </div>
        {showRuns && (
          <div className="mt-2 max-h-72 overflow-auto text-xs">
            <table className="w-full text-left">
              <thead className="text-[var(--color-text-muted)]">
                <tr>
                  <th className="py-1 pr-3">Análise</th>
                  <th className="py-1 pr-3">Composição</th>
                  <th className="py-1 pr-3">Massa</th>
                  <th className="py-1 pr-3">Região</th>
                  <th className="py-1 pr-3">Gaussiana (R²)</th>
                  <th className="py-1">Molde (R²)</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.token} className="border-t border-[var(--color-border)]">
                    <td className="py-1 pr-3 font-mono">{short(r.filename)}</td>
                    <td className="py-1 pr-3">
                      {r.error ? (
                        <span className="text-[var(--color-danger)]">{r.error}</span>
                      ) : (
                        r.composition_text || <span className="text-[var(--color-danger)]">desconhecida</span>
                      )}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">{r.mass_mg ? `${r.mass_mg.toFixed(3)} mg` : '—'}</td>
                    <td className="py-1 pr-3">{r.has_region ? '✓' : <span className="text-[var(--color-danger)]">✗</span>}</td>
                    <td className="py-1 pr-3 tabular-nums">{r.saved.gauss ? r.saved.gauss.r2.toFixed(4) : '—'}</td>
                    <td className="py-1 tabular-nums">{r.saved.molde ? r.saved.molde.r2.toFixed(4) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error && <p className="mt-2 text-xs text-[var(--color-danger)]">{error}</p>}
      </section>

      {/* passo 1 */}
      <Step n={1} title="Referências e moldes dos materiais puros" done={refsDone}>
        <p className="mb-2 text-xs text-[var(--color-text-muted)]">
          Cada corrida pura é ajustada com 1 pico (gaussiana assimétrica) com o nome do material, e a referência do material
          é criada — ou refeita, se já existir — com o centro, as larguras e o <strong>molde</strong> (a forma média do sinal
          dos puros, área 1). Misturas não entram aqui.
        </p>
        <button type="button" className={btnPrimaryClass} onClick={() => void stepRefs()} disabled={!!busy || pure.length === 0}>
          {busy === 'referências' ? 'criando…' : `Criar / refazer referências (${pure.length} corrida(s) pura(s))`}
        </button>
        {pure.length === 0 && runs.length > 0 && (
          <div className="mt-2 text-xs text-[var(--color-text-muted)]">
            Nenhuma corrida pura aberta — este passo só <strong>cria</strong> referências a partir dos puros. As já salvas
            continuam valendo para as misturas abertas:
            <ul className="mt-1 list-none">
              {needed.map((n) => (
                <li key={`${n.material}|${n.cycle_key}`} style={{ color: refOf(n) ? undefined : 'var(--color-danger)' }}>
                  {refOf(n) ? '✓' : '✗'} <strong>{n.material}</strong>
                  {cycles.size > 1 ? ` (${n.cycle_label})` : ''} —{' '}
                  {refOf(n) ? 'referência com molde salva' : 'sem referência neste ciclo: abra os puros dele e crie aqui'}
                </li>
              ))}
            </ul>
          </div>
        )}
        {refResult && (
          <div className="mt-2 text-xs">
            {refResult.references.map((r) => (
              <p key={`${r.material}${r.cycle_label}`} style={{ color: r.ok ? undefined : 'var(--color-danger)' }}>
                {r.ok ? '✓' : '✗'} <strong>{r.material}</strong> — {r.ok
                  ? `${r.updated ? 'refeita' : 'criada'} com ${r.reference?.n_runs} corrida(s)${r.n_excluded ? ` (${r.n_excluded} tirada(s) por você continuam fora)` : ''}`
                  : r.error}
              </p>
            ))}
            <ItemsTable items={refResult.items.filter((i) => !i.ok)} names={names} />
          </div>
        )}
        <details className="mt-3" open={refsDone}>
          <summary className="cursor-pointer text-sm text-[var(--color-text-muted)]">
            Ver os moldes, a dilatação natural e tirar corridas de uma referência
          </summary>
          <div className="mt-3">
            <PostRunReferencesTab
              references={references}
              channel="pyro:FID"
              openTokens={openTokens}
              savedMaterials={{}}
              unsavedMaterials={{}}
              onReferencesChanged={() => {
                onReferencesChanged()
                load()
              }}
              analysesByToken={analysesByToken}
              onAnalysesUpdated={onAnalysesUpdated}
              embedded
              refreshKey={refreshKey}
            />
          </div>
        </details>
      </Step>

      {/* método */}
      <section className={cardClass}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-semibold">Método</h2>
          <div className="flex gap-1 rounded-full border p-0.5 text-sm border-[var(--color-border)]" role="tablist" aria-label="método">
            {(['molde', 'gauss'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={method === m}
                onClick={() => {
                  setMethod(m)
                  setTolC(m === 'molde' ? 25 : 20)
                  setTolW(m === 'molde' ? 40 : 30)
                }}
                className="rounded-full px-3 py-0.5"
                style={{
                  backgroundColor: method === m ? 'var(--color-primary)' : 'transparent',
                  color: method === m ? 'var(--color-primary-contrast)' : 'var(--color-text-muted)',
                }}
              >
                {m === 'molde' ? 'Molde (recomendado)' : 'Gaussiana guiada'}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
            centro ± °C
            <input type="number" min={0} className={`${inputClass} w-16`} value={tolC} onChange={(e) => setTolC(Number(e.target.value) || 0)} />
          </label>
          <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
            {method === 'molde' ? 'dilatação ± %' : 'largura ± %'}
            <input type="number" min={0} className={`${inputClass} w-16`} value={tolW} onChange={(e) => setTolW(Number(e.target.value) || 0)} />
          </label>
        </div>
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          {method === 'molde'
            ? 'Cada material entra com o seu molde (a forma real do puro); o ajuste acha a área e, dentro dos limites, um pequeno deslocamento e a dilatação. A "dilatação natural" dos moldes (passo 1) mostra quanto os puros variam entre si; numa mistura o pico pode alargar mais (interação) — se aparecer "no limite da tolerância", aumente o limite e ajuste de novo.'
            : 'Cada material entra como uma gaussiana assimétrica com centro e larguras presos perto dos da referência (dentro dos limites).'}{' '}
          Os passos 2 a 4 usam este método; o outro continua salvo — dá para comparar trocando aqui.
        </p>
      </section>

      {/* passo 2 */}
      <Step n={2} title={`Ajustar puros e misturas — ${METHOD_LABEL[method]}`} done={withComp.length > 0 && fittedN === withComp.length}>
        <p className="mb-2 text-xs text-[var(--color-text-muted)]">
          Ajusta e salva todas as análises abertas com composição e região: as misturas com as referências de todos os
          componentes; os puros também (a curva de calibração precisa da área medida do mesmo jeito).{' '}
          {fittedN}/{withComp.length} já têm ajuste por {method === 'molde' ? 'molde' : 'gaussiana'} salvo.
        </p>
        <button type="button" className={btnPrimaryClass} onClick={() => void stepFit()} disabled={!!busy || withComp.length === 0}>
          {busy === 'ajuste' ? 'ajustando…' : `Ajustar e salvar (${withComp.length})`}
        </button>
        <ItemsTable items={fitResult[method] ?? []} names={names} />
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          Para ver a curva e os resíduos de uma corrida, ou ajustar uma à mão: aba Análises → 2 · Deconvolução.
        </p>
      </Step>

      {/* passo 3 */}
      <Step n={3} title={`Curvas de calibração — ${METHOD_LABEL[method]}`} done={curvesDone}>
        <p className="mb-2 text-xs text-[var(--color-text-muted)]">
          Uma curva por material: massa do componente × área do pico, com as corridas puras dele (ajuste do passo 2). Criada
          ou atualizada com o nome "material · método (automática)"; dá para refinar (tirar pontos, mudar o modelo) na aba Curvas.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
            modelo
            <select className={inputClass} value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="linear">reta (a + b·m)</option>
              <option value="origin">reta pela origem</option>
              <option value="quadratic">quadrática</option>
            </select>
          </label>
          <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
            peso
            <select className={inputClass} value={weighting} onChange={(e) => setWeighting(e.target.value)}>
              <option value="1/x2">1/m² (recomendado)</option>
              <option value="1/x">1/m</option>
              <option value="none">nenhum</option>
            </select>
          </label>
          <button type="button" className={btnPrimaryClass} onClick={() => void stepCurves()} disabled={!!busy || pure.length === 0}>
            {busy === 'curvas' ? 'criando…' : 'Criar / atualizar curvas'}
          </button>
        </div>
        {(curveResult[method] ?? []).length > 0 && (
          <div className="mt-2 text-xs">
            {(curveResult[method] ?? []).map((c) => (
              <p key={`${c.material}${c.cycle_label}`} style={{ color: c.ok ? undefined : 'var(--color-danger)' }}>
                {c.ok ? '✓' : '✗'} <strong>{c.material}</strong> —{' '}
                {c.ok && c.curve
                  ? `${c.updated ? 'atualizada' : 'criada'}: ${c.curve.equation} · R² ${c.curve.r2?.toFixed(4) ?? '—'} · ${c.curve.n_points} ponto(s)`
                  : c.error}
              </p>
            ))}
          </div>
        )}
        {pure.length === 0 && runs.length > 0 && (
          <div className="mt-2 text-xs text-[var(--color-text-muted)]">
            Nenhuma corrida pura aberta — este passo só <strong>cria</strong> curvas a partir dos puros (por isso o botão fica
            desligado). Para quantificar as misturas abertas não precisa: o passo 4 usa as curvas já salvas.
            <ul className="mt-1 list-none">
              {needed.map((n) => {
                const c = curveOf(n)
                return (
                  <li key={`${n.material}|${n.cycle_key}`} style={{ color: c ? undefined : 'var(--color-danger)' }}>
                    {c ? '✓' : '✗'} <strong>{n.material}</strong>
                    {cycles.size > 1 ? ` (${n.cycle_label})` : ''} —{' '}
                    {c
                      ? `${c.name} (R² ${c.r2?.toFixed(4) ?? '—'}) será usada`
                      : `sem curva por ${method === 'molde' ? 'molde' : 'gaussiana'} neste ciclo: abra os puros de ${n.material} e crie aqui`}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        {pure.length > 0 && !(curveResult[method] ?? []).length && (status?.curves ?? []).some((c) => c.method === method && cycles.has(c.cycle_key)) && (
          <div className="mt-2 text-xs text-[var(--color-text-muted)]">
            Curvas por {method === 'molde' ? 'molde' : 'gaussiana'} existentes:{' '}
            {(status?.curves ?? [])
              .filter((c) => c.method === method && cycles.has(c.cycle_key))
              .map((c) => `${c.name} (R² ${c.r2?.toFixed(4) ?? '—'})`)
              .join(' · ')}
          </div>
        )}
      </Step>

      {/* passo 4 */}
      <Step n={4} title={`Recuperação — ${METHOD_LABEL[method]}`} done={null}>
        <PostRunReportTab tokens={openTokens} method={method} embedded curvesVersion={curvesVersion} />
      </Step>
    </div>
  )
}
