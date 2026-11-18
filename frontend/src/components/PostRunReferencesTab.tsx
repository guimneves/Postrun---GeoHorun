import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { METHOD_LABEL, postrunApi, type AnalysisSummary, type DeconvReference, type ReferenceDetail, type SavedCurve } from '../api/postrun'
import { PostRunMassEdit } from './PostRunMassEdit'
import { fmtNum } from '../lib/postrunFormat'
import { PEAK_COLORS } from '../lib/postrunColors'
import { PostRunLinesPlot, type LineSeries } from './PostRunLinesPlot'
import { inputInlineClass as inputClass, btnClass, cardClass } from '../ui/classes'

// Aba Referências do PostRun (pedido do usuário, 16/10/2026): ver o molde
// de cada material puro junto com as corridas que o formaram, a "dilatação
// natural" entre elas e comparar os moldes dos materiais — fora da aba
// Análises, que estava poluída. Desde 16/11/2026 mostra as DUAS partes da
// referência — a gaussiana de referência (método Gaussiana guiada) e o molde
// (método Molde) — e as curvas de calibração do material nos dois métodos.

/** nome da análise sem a extensão (ex.: PP_60mg_001) */
function runName(r: { filename: string; token: string }): string {
  return (r.filename || r.token).replace(/.[A-Za-z]00$/i, '')
}

function median(v: number[]): number {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** trecho onde o molde tem sinal (≥ 1 % do máximo), com uma margem — a
 * janela costuma ser bem maior que o pico e o deixaria espremido */
function cropRange(mold: number[]): [number, number] {
  if (!mold.length) return [0, 0]
  const peak = Math.max(...mold)
  let a = mold.findIndex((v) => v >= 0.01 * peak)
  let b = mold.length - 1 - [...mold].reverse().findIndex((v) => v >= 0.01 * peak)
  const pad = Math.round((b - a) * 0.15)
  a = Math.max(0, a - pad)
  b = Math.min(mold.length - 1, b + pad)
  return [a, b + 1]
}

export function PostRunReferencesTab({
  references,
  channel,
  openTokens,
  savedMaterials,
  unsavedMaterials,
  onReferencesChanged,
  analysesByToken = {},
  onAnalysesUpdated,
  embedded = false,
  refreshKey = 0,
}: {
  references: DeconvReference[]
  channel: string
  openTokens: string[]
  savedMaterials: Record<string, string[]>
  unsavedMaterials: Record<string, string[]>
  onReferencesChanged: () => void
  analysesByToken?: Record<string, AnalysisSummary>
  onAnalysesUpdated?: (items: AnalysisSummary[]) => void
  /** dentro da aba Deconvolução: sem o quadro "Criar referência" (é o passo 1) */
  embedded?: boolean
  /** muda quando as referências são refeitas fora daqui — relê os moldes */
  refreshKey?: number
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const [compare, setCompare] = useState<Set<number>>(new Set())
  const [details, setDetails] = useState<Record<number, ReferenceDetail>>({})
  const [loading, setLoading] = useState<Set<number>>(new Set())
  const [errors, setErrors] = useState<Record<number, string>>({})
  const [hoverRun, setHoverRun] = useState<string | null>(null)
  const [showRuns, setShowRuns] = useState(true)
  const [showMold, setShowMold] = useState(true)
  const [showGauss, setShowGauss] = useState(true)
  const [curves, setCurves] = useState<SavedCurve[] | null>(null)
  const [refName, setRefName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // corridas desmarcadas (a tirar da referência selecionada)
  const [dropped, setDropped] = useState<Set<string>>(new Set())
  const [runMsg, setRunMsg] = useState<string | null>(null)
  useEffect(() => {
    setDropped(new Set())
    setRunMsg(null)
  }, [selected])

  const refs = references.filter((r) => r.channel === channel)
  useEffect(() => {
    setDetails({})
    setErrors({})
  }, [refreshKey])
  // curvas de calibração (para mostrar as do material selecionado, nos dois métodos)
  useEffect(() => {
    let alive = true
    postrunApi
      .listCurves(channel)
      .then((c) => alive && setCurves(c))
      .catch(() => alive && setCurves([]))
    return () => {
      alive = false
    }
  }, [channel, refreshKey])
  useEffect(() => {
    if (selected === null && refs.length) setSelected(refs[0].id)
    if (selected !== null && !refs.some((r) => r.id === selected)) setSelected(refs[0]?.id ?? null)
  }, [refs, selected])

  // carrega o detalhe (molde + corridas) de quem está selecionado ou em comparação
  useEffect(() => {
    const want = [selected, ...compare].filter((x): x is number => x !== null)
    for (const id of want) {
      if (details[id] || loading.has(id) || errors[id]) continue
      setLoading((p) => new Set(p).add(id))
      postrunApi
        .referenceDetail(id)
        .then((d) => setDetails((p) => ({ ...p, [id]: d })))
        .catch((err) => setErrors((p) => ({ ...p, [id]: err instanceof ApiError ? err.message : 'Erro ao ler a referência' })))
        .finally(() =>
          setLoading((p) => {
            const n = new Set(p)
            n.delete(id)
            return n
          }),
        )
    }
  }, [selected, compare, details, loading, errors])

  const det = selected !== null ? details[selected] : undefined
  const okRuns = det?.runs.filter((r) => r.ok && r.density.length) ?? []

  const stats = useMemo(() => {
    if (!det) return null
    const runs = det.runs.filter((r) => r.ok)
    const st = runs.map((r) => r.stretch).filter((x): x is number => x != null)
    const rms = runs.map((r) => r.rms_pct).filter((x): x is number => x != null)
    const tmax = runs.map((r) => r.max_c).filter((x): x is number => x != null)
    const spread = st.length ? Math.max(...st.map((x) => Math.abs(x - 1))) : null
    const meanT = tmax.length ? tmax.reduce((a, b) => a + b, 0) / tmax.length : null
    return {
      stMin: st.length ? Math.min(...st) : null,
      stMax: st.length ? Math.max(...st) : null,
      spread,
      // sugestão: o dobro da maior variação natural, de 5 em 5 %, no mínimo 5 %
      suggest: spread != null ? Math.max(5, Math.ceil((200 * spread) / 5) * 5) : null,
      rmsMed: median(rms),
      meanT,
      tSpread: tmax.length ? Math.max(...tmax) - Math.min(...tmax) : null,
    }
  }, [det])

  function flagOf(r: ReferenceDetail['runs'][number]): string | null {
    if (!r.ok) return r.error
    if (!stats) return null
    if (r.stretch != null && Math.abs(r.stretch - 1) > 0.1) return 'largura bem diferente das outras'
    if (r.rms_pct != null && r.rms_pct > Math.max(2 * stats.rmsMed, 3)) return 'forma foge do molde'
    if (r.max_c != null && stats.meanT != null && Math.abs(r.max_c - stats.meanT) > 5) return 'pico deslocado'
    return null
  }

  const detailSeries: LineSeries[] = useMemo(() => {
    if (!det || !det.tau.length) return []
    const [a, b] = cropRange(det.mold)
    const tau = det.tau.slice(a, b)
    const out: LineSeries[] = []
    if (showRuns)
      for (const r of okRuns)
        out.push({
          key: r.token,
          x: tau,
          y: r.density.slice(a, b),
          color: hoverRun === r.token ? '#e34948' : 'var(--color-text-muted)',
          width: hoverRun === r.token ? 2 : 0.8,
          opacity: hoverRun && hoverRun !== r.token ? 0.25 : 0.6,
        })
    if (showMold) out.push({ key: '__mold', x: tau, y: det.mold.slice(a, b), color: PEAK_COLORS[0], width: 2.4 })
    if (showGauss && det.gauss?.length)
      out.push({ key: '__gauss', x: tau, y: det.gauss.slice(a, b), color: PEAK_COLORS[1], width: 2.2, dash: '6 4' })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [det, showRuns, showMold, showGauss, hoverRun])

  // curvas de calibração do material selecionado, no ciclo da referência, por método
  const refCurves = useMemo(() => {
    if (!det || !curves) return null
    const mine = curves.filter(
      (c) => c.component.toUpperCase() === det.reference.name.toUpperCase() && c.cycle_key === det.reference.cycle_key,
    )
    return {
      molde: mine.filter((c) => c.area_source === 'gaussian' && c.deconv_method === 'molde'),
      gauss: mine.filter((c) => c.area_source === 'gaussian' && (c.deconv_method ?? 'gauss') === 'gauss'),
      region: mine.filter((c) => c.area_source === 'region'),
    }
  }, [det, curves])

  // molde fora do zero: referência criada quando o alinhamento era pelo
  // centro da gaussiana (antes de 16/10/2026) — recriar resolve
  const moldOffset = det && det.mold.length ? det.tau[det.mold.indexOf(Math.max(...det.mold))] : 0

  const detailBand = useMemo(() => {
    if (!det || !det.sd.length) return undefined
    const [a, b] = cropRange(det.mold)
    const m = det.mold.slice(a, b)
    const sd = det.sd.slice(a, b)
    return { x: det.tau.slice(a, b), lo: m.map((v, i) => Math.max(0, v - sd[i])), hi: m.map((v, i) => v + sd[i]), color: PEAK_COLORS[0] }
  }, [det])

  const compareIds = [...compare].filter((id) => details[id]?.tau.length)
  const compareCycle = compareIds.length ? details[compareIds[0]].reference.cycle_label : null
  const compareSeries: LineSeries[] = compareIds.map((id, i) => {
    const d = details[id]
    const [a, b] = cropRange(d.mold)
    return { key: String(id), x: d.tau.slice(a, b).map((t) => t + (d.center_s ?? 0)), y: d.mold.slice(a, b), color: PEAK_COLORS[i % PEAK_COLORS.length], width: 2 }
  })
  const mixedCycles = new Set(compareIds.map((id) => details[id].reference.cycle_key)).size > 1

  // ------------------------------------------------------------ criar referência
  const refMaterial = refName.trim().toUpperCase().replace(/^(REFER[ÊE]NCIA|REF\.?)\s+(D[OAE]\s+)?/, '').trim()
  const candidates = openTokens.filter((t) => {
    const mats = savedMaterials[t]
    return mats && mats.length > 0 && (!refMaterial || mats.every((m) => m === refMaterial))
  })
  const pureSaved = new Map<string, number>()
  for (const t of openTokens) {
    const mats = savedMaterials[t]
    if (mats?.length === 1) pureSaved.set(mats[0], (pureSaved.get(mats[0]) ?? 0) + 1)
  }
  const unsavedForName = openTokens.filter((t) => {
    const mats = unsavedMaterials[t]
    return mats?.length && (!refMaterial || mats.every((m) => m === refMaterial))
  }).length

  async function createReference() {
    if (!refMaterial) return
    setBusy(true)
    try {
      const ref = await postrunApi.createReference(refMaterial, candidates, channel)
      setMessage(`Referência ${ref.name} criada com ${ref.n_runs} corrida(s).`)
      setRefName('')
      setSelected(ref.id)
      onReferencesChanged()
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao criar a referência')
    } finally {
      setBusy(false)
    }
  }

  async function applyDropped() {
    if (!det || dropped.size === 0) return
    const keep = det.runs.map((r) => r.token).filter((t) => !dropped.has(t))
    if (keep.length === 0) {
      setRunMsg('Deixe pelo menos uma corrida (ou apague a referência).')
      return
    }
    if (!window.confirm(`Refazer a referência ${det.reference.name} sem ${dropped.size} corrida(s)? Centro, larguras e molde são recalculados com as ${keep.length} que ficam.`)) return
    setBusy(true)
    try {
      const id = det.reference.id
      await postrunApi.setReferenceRuns(id, keep)
      setDetails((p) => {
        const n = { ...p }
        delete n[id]
        return n
      })
      setDropped(new Set())
      setRunMsg(`Referência refeita com ${keep.length} corrida(s).`)
      onReferencesChanged()
    } catch (err) {
      setRunMsg(err instanceof ApiError ? err.message : 'Erro ao refazer a referência')
    } finally {
      setBusy(false)
    }
  }

  async function restoreRun(token: string) {
    if (!det) return
    setBusy(true)
    try {
      const id = det.reference.id
      await postrunApi.setReferenceRuns(id, [...det.runs.map((r) => r.token), token])
      setDetails((p) => {
        const n = { ...p }
        delete n[id]
        return n
      })
      setRunMsg('Corrida devolvida; referência refeita.')
      onReferencesChanged()
    } catch (err) {
      setRunMsg(err instanceof ApiError ? err.message : 'Erro ao devolver a corrida')
    } finally {
      setBusy(false)
    }
  }

  async function deleteReference(r: DeconvReference) {
    if (!window.confirm(`Apagar a referência ${r.name} (${r.cycle_label})?`)) return
    try {
      await postrunApi.deleteReference(r.id)
      setCompare((p) => {
        const n = new Set(p)
        n.delete(r.id)
        return n
      })
      onReferencesChanged()
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao apagar a referência')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[380px_1fr]">
        {/* lista + criar */}
        <div className="flex flex-col gap-4">
          <div className={cardClass}>
            <h2 className="mb-1 font-semibold">Referências ({refs.length})</h2>
            <p className="mb-2 text-xs text-[var(--color-text-muted)]">
              Cada referência guarda a <strong>gaussiana de referência</strong> (usada pela Gaussiana guiada) e o{' '}
              <strong>molde</strong> (usado pelo Molde). Clique para ver as duas; marque "comparar" para sobrepor os moldes de
              vários materiais.
            </p>
            {refs.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">Nenhuma referência neste canal ainda.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {refs.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm"
                    style={{
                      borderColor: selected === r.id ? 'var(--color-primary)' : 'var(--color-border)',
                      background: selected === r.id ? 'var(--color-surface)' : undefined,
                    }}
                  >
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelected(r.id)}>
                      <span className="font-semibold">{r.name}</span>{' '}
                      <span className="text-xs text-[var(--color-text-muted)]">
                        · {r.n_runs} corrida(s) · {r.peaks.map((p) => `${p.mu_c?.toFixed(0)} °C`).join(', ')}
                      </span>
                      <span className="mt-0.5 flex gap-1 text-[10px]">
                        <span className="rounded-full border px-1.5 border-[var(--color-border)]" title="centro e larguras médios — método Gaussiana guiada">
                          gaussiana ✓
                        </span>
                        <span
                          className="rounded-full border px-1.5"
                          style={{ borderColor: r.has_template ? 'var(--color-border)' : 'var(--color-danger)', color: r.has_template ? undefined : 'var(--color-danger)' }}
                          title={r.has_template ? 'forma média dos puros — método Molde' : 'criada antes do molde — apague e crie de novo'}
                        >
                          molde {r.has_template ? '✓' : '✗'}
                        </span>
                      </span>
                      <span className="block truncate text-[10px] text-[var(--color-text-dim)]">{r.cycle_label}</span>
                    </button>
                    <label className="flex items-center gap-1 text-xs" title="sobrepor no gráfico de comparação">
                      <input
                        type="checkbox"
                        checked={compare.has(r.id)}
                        disabled={!r.has_template}
                        onChange={() =>
                          setCompare((p) => {
                            const n = new Set(p)
                            if (n.has(r.id)) n.delete(r.id)
                            else n.add(r.id)
                            return n
                          })
                        }
                      />
                      comparar
                    </label>
                    <button type="button" className="text-xs text-[var(--color-danger)] hover:underline" onClick={() => void deleteReference(r)}>
                      apagar
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {!embedded && (
          <div className={cardClass}>
            <h2 className="mb-1 font-semibold">Criar referência</h2>
            <ol className="mb-2 list-decimal pl-5 text-xs text-[var(--color-text-muted)]">
              <li>Na aba Análises, abra as corridas do material puro.</li>
              <li>Deconvolução: modo Livre, 1 pico, nome do material (ex.: PEAD), "Ajustar todas as abertas".</li>
              <li>Toque em Salvar.</li>
              <li>Aqui: escreva o material (o mesmo nome do pico) e crie.</li>
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <input className={`${inputClass} w-32`} value={refName} placeholder="ex.: PEAD" onChange={(e) => setRefName(e.target.value)} />
              <button type="button" className={btnClass} onClick={() => void createReference()} disabled={busy || candidates.length === 0 || !refMaterial}>
                Criar {refMaterial ? `de ${refMaterial} ` : ''}({candidates.length} corrida(s))
              </button>
            </div>
            {pureSaved.size > 0 && (
              <div className="mt-2 flex flex-wrap gap-1 text-xs">
                <span className="text-[var(--color-text-muted)]">salvos nas abertas:</span>
                {Array.from(pureSaved.entries()).map(([m, n]) => (
                  <button
                    key={m}
                    type="button"
                    className="rounded-full border px-2 py-0.5 border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                    onClick={() => setRefName(m)}
                  >
                    {m} · {n}
                  </button>
                ))}
              </div>
            )}
            {candidates.length === 0 && (
              <p className="mt-2 text-xs text-[var(--color-warning,#b26a00)]">
                {unsavedForName > 0
                  ? `${unsavedForName} análise(s) ajustada(s) ainda não foram salvas — toque em Salvar na aba Análises.`
                  : refMaterial && pureSaved.size > 0
                    ? `Nenhuma corrida salva com o pico "${refMaterial}". Nomes salvos: ${Array.from(pureSaved.keys()).join(', ')}.`
                    : openTokens.length === 0
                      ? 'Nenhuma análise aberta — abra as corridas do puro na aba Análises.'
                      : 'Escreva o nome do material, igual ao nome do pico.'}
              </p>
            )}
            {message && <p className="mt-2 text-xs text-[var(--color-text-muted)]">{message}</p>}
          </div>
          )}
        </div>

        {/* detalhe */}
        <div className={cardClass}>
          {selected === null ? (
            <p className="text-sm text-[var(--color-text-muted)]">Escolha uma referência à esquerda.</p>
          ) : errors[selected] ? (
            <p className="text-sm text-[var(--color-danger)]">{errors[selected]}</p>
          ) : !det ? (
            <p className="text-sm text-[var(--color-text-muted)]">Lendo as corridas da referência…</p>
          ) : !det.tau.length ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              {det.reference.name}: referência sem molde (criada antes do modo Molde). Apague e crie de novo para ter o molde.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-semibold">
                  Referência de {det.reference.name}{' '}
                  <span className="text-xs font-normal text-[var(--color-text-muted)]">{det.reference.cycle_label}</span>
                </h2>
                <span className="flex flex-wrap items-center gap-3 text-xs">
                  <label className="flex items-center gap-1" title="a forma média real dos puros — método Molde">
                    <input type="checkbox" checked={showMold} onChange={(e) => setShowMold(e.target.checked)} />
                    <span style={{ color: PEAK_COLORS[0] }}>━</span> molde
                  </label>
                  <label
                    className="flex items-center gap-1"
                    title={det.gauss?.length ? 'centro e larguras médios — método Gaussiana guiada' : 'referência com mais de um pico: veja os centros na lista'}
                  >
                    <input type="checkbox" checked={showGauss} disabled={!det.gauss?.length} onChange={(e) => setShowGauss(e.target.checked)} />
                    <span style={{ color: PEAK_COLORS[1] }}>╍</span> gaussiana de referência
                  </label>
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={showRuns} onChange={(e) => setShowRuns(e.target.checked)} />
                    as corridas
                  </label>
                </span>
              </div>
              <PostRunLinesPlot
                series={detailSeries}
                band={detailBand}
                xLabel="tempo em relação ao máximo (s)"
                yLabel="sinal ÷ área (1/s)"
                height={320}
                vLines={[{ x: 0, label: `máximo · ${det.max_c?.toFixed(1) ?? '—'} °C` }]}
                legend={[
                  ...(showMold ? [{ label: 'molde', color: PEAK_COLORS[0] }] : []),
                  ...(showGauss && det.gauss?.length
                    ? [{ label: 'gaussiana', color: PEAK_COLORS[1], dash: '6 4' }]
                    : []),
                  ...(showRuns ? [{ label: 'cada corrida', color: 'var(--color-text-muted)' }] : []),
                ]}
                onHover={(k) => setHoverRun(k && !k.startsWith('__') ? k : null)}
              />
              <p className="min-h-4 text-xs font-medium" style={{ color: '#e34948' }}>
                {(() => {
                  const r = hoverRun ? det.runs.find((x) => x.token === hoverRun) : undefined
                  return r ? `${runName(r)}${r.mass_mg != null ? ` · ${fmtNum(r.mass_mg)} mg` : ''}` : ''
                })()}
              </p>
              {Math.abs(moldOffset) > 2 && (
                <p className="rounded-lg border p-2 text-xs border-[var(--color-warning,#b26a00)] text-[var(--color-warning,#b26a00)]">
                  ⚠ O máximo do molde está {Math.abs(moldOffset).toFixed(0)} s {moldOffset < 0 ? 'antes' : 'depois'} do máximo das corridas:
                  esta referência foi criada com o alinhamento antigo (pelo centro da gaussiana). Apague e crie de novo — as
                  deconvoluções salvas dos puros bastam — para o molde ficar centrado.
                </p>
              )}
              <p className="text-xs text-[var(--color-text-muted)]">
                Cada corrida foi dividida pela própria área (área 1) e alinhada pelo próprio máximo; o <strong>molde</strong> é a
                média (a faixa clara é ± 1 desvio-padrão entre as corridas: estreita = as corridas têm a mesma forma). A{' '}
                <strong>gaussiana de referência</strong> (tracejada) é o pico com o centro e as larguras médios dos ajustes de 1
                gaussiana de cada corrida, também com área 1 — onde ela se afasta do molde (caudas, topo) é a parte da forma real
                que o método Gaussiana guiada não descreve.
              </p>

              {stats && (
                <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                  <Stat label="Tmax médio" value={stats.meanT != null ? `${stats.meanT.toFixed(1)} °C` : '—'} sub={stats.tSpread != null ? `variação ${stats.tSpread.toFixed(1)} °C` : undefined} />
                  <Stat label="Largura do molde (meia altura)" value={det.mold_fwhm_s != null ? `${det.mold_fwhm_s.toFixed(0)} s` : '—'} />
                  <Stat
                    label="Dilatação natural entre as corridas"
                    value={stats.stMin != null ? `× ${stats.stMin.toFixed(3)} – ${stats.stMax!.toFixed(3)}` : '—'}
                    sub={stats.spread != null ? `até ± ${(100 * stats.spread).toFixed(1)} %` : undefined}
                  />
                  <Stat
                    label="Sugestão p/ o modo Molde"
                    value={stats.suggest != null ? `± ${stats.suggest} %` : '—'}
                    sub="o mínimo para os puros; misturas podem pedir mais"
                  />
                  {det.reference.peaks.length === 1 && (
                    <Stat
                      label="Gaussiana de referência"
                      value={`${det.reference.peaks[0].mu_c?.toFixed(1) ?? '—'} °C`}
                      sub={`largura (meia altura) ${det.gauss_fwhm_s != null ? det.gauss_fwhm_s.toFixed(0) : '—'} s · esq. ${det.reference.peaks[0].sigma_l_s.toFixed(0)} s / dir. ${det.reference.peaks[0].sigma_r_s.toFixed(0)} s`}
                    />
                  )}
                  {det.gauss_misfit_pct != null && (
                    <Stat
                      label="Forma que a gaussiana não descreve"
                      value={`${det.gauss_misfit_pct.toFixed(1)} %`}
                      sub="½ ∫ |molde − gaussiana| — perto de 0 = a gaussiana basta"
                    />
                  )}
                </div>
              )}

              {refCurves && (
                <div className="rounded-xl border p-2 text-xs border-[var(--color-border)]">
                  <div className="mb-1 font-semibold">Curvas de calibração de {det.reference.name} (neste ciclo)</div>
                  <table className="w-full text-left">
                    <tbody>
                      {(
                        [
                          ['molde', `Pelo molde — área do pico ajustado com o molde (${METHOD_LABEL.molde})`],
                          ['gauss', `Pela gaussiana — área do pico gaussiano (${METHOD_LABEL.gauss})`],
                          ['region', 'Pela área da janela inteira (sem deconvolução)'],
                        ] as const
                      ).map(([k, label]) => {
                        const list = refCurves[k]
                        if (k === 'region' && list.length === 0) return null
                        return (
                          <tr key={k} className="border-t border-[var(--color-border)] align-top">
                            <td className="py-1 pr-3 text-[var(--color-text-muted)]">{label}</td>
                            <td className="py-1">
                              {list.length === 0 ? (
                                <span className="text-[var(--color-text-dim)]">
                                  nenhuma — passo 3 da aba Deconvolução com o método {k === 'molde' ? 'Molde' : 'Gaussiana guiada'}
                                </span>
                              ) : (
                                list.map((c) => (
                                  <span key={c.id} className="block">
                                    <strong>{c.name}</strong> · {c.fit?.equation ?? '—'} · R² {c.fit?.r2?.toFixed(4) ?? '—'} ·{' '}
                                    {c.points.filter((p) => !p.excluded).length} ponto(s)
                                  </span>
                                ))
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  <p className="mt-1 text-[var(--color-text-dim)]">
                    As duas curvas usam as mesmas corridas puras; mudam só as áreas (molde × gaussiana). Para ver o gráfico ou tirar
                    pontos: aba Curvas.
                  </p>
                </div>
              )}

              <table className="w-full text-left text-sm">
                <thead className="text-xs text-[var(--color-text-muted)]">
                  <tr>
                    <th className="py-1 pr-2" title="desmarque para tirar a corrida da referência">usar</th>
                    <th className="py-1 pr-3">Análise</th>
                    <th className="py-1 pr-3">Tmax (°C)</th>
                    <th className="py-1 pr-3">Área (sinal·s)</th>
                    <th className="py-1 pr-3">Largura (s)</th>
                    <th className="py-1 pr-3" title="largura desta corrida ÷ largura do molde">Dilatação</th>
                    <th className="py-1 pr-3" title="RMS da diferença para o molde ÷ altura do molde">Foge do molde</th>
                    <th className="py-1 pr-3" title="R² do ajuste de 1 gaussiana desta corrida (a base da gaussiana de referência)">R² gaussiana</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {det.runs.map((r) => {
                    const flag = flagOf(r)
                    return (
                      <tr
                        key={r.token}
                        className="border-t border-[var(--color-border)]"
                        onPointerEnter={() => setHoverRun(r.token)}
                        onPointerLeave={() => setHoverRun(null)}
                        style={{
                          background: hoverRun === r.token ? 'var(--color-surface)' : undefined,
                          opacity: dropped.has(r.token) ? 0.45 : 1,
                          textDecoration: dropped.has(r.token) ? 'line-through' : undefined,
                        }}
                      >
                        <td className="py-1 pr-2">
                          <input
                            type="checkbox"
                            checked={!dropped.has(r.token)}
                            onChange={() =>
                              setDropped((p) => {
                                const n = new Set(p)
                                if (n.has(r.token)) n.delete(r.token)
                                else n.add(r.token)
                                return n
                              })
                            }
                            aria-label={`usar ${r.sample || r.token}`}
                          />
                        </td>
                        <td className="py-1 pr-3" title={r.token}>
                          <span className="font-medium">{runName(r)}</span>
                          <span className="block text-[11px] text-[var(--color-text-muted)]">
                            {[
                              r.sample,
                              r.date ? new Date(r.date).toLocaleDateString('pt-BR') : null,
                              r.job,
                            ]
                              .filter(Boolean)
                              .join(' · ')}{' '}
                            ·{' '}
                            <PostRunMassEdit
                              token={r.token}
                              massMg={analysesByToken[r.token]?.mass_mg ?? r.mass_mg}
                              manual={analysesByToken[r.token] ? analysesByToken[r.token].mass_source === 'manual' : false}
                              fileMassMg={analysesByToken[r.token]?.quantity_mg}
                              originalMassMg={analysesByToken[r.token]?.file_mass_before_mg}
                              onSaved={(items) => {
                                onAnalysesUpdated?.(items)
                                const m = items.find((x) => x.token === r.token)?.mass_mg
                                if (m != null && det)
                                  setDetails((p) => ({
                                    ...p,
                                    [det.reference.id]: { ...det, runs: det.runs.map((x) => (x.token === r.token ? { ...x, mass_mg: m } : x)) },
                                  }))
                              }}
                            />
                          </span>
                        </td>
                        <td className="py-1 pr-3 tabular-nums">{r.max_c?.toFixed(1) ?? '—'}</td>
                        <td className="py-1 pr-3 tabular-nums">{r.area_s != null ? fmtNum(r.area_s) : '—'}</td>
                        <td className="py-1 pr-3 tabular-nums">{r.fwhm_s?.toFixed(0) ?? '—'}</td>
                        <td className="py-1 pr-3 tabular-nums">{r.stretch != null ? `× ${r.stretch.toFixed(3)}` : '—'}</td>
                        <td className="py-1 pr-3 tabular-nums">{r.rms_pct != null ? `${r.rms_pct.toFixed(1)} %` : '—'}</td>
                        <td className="py-1 pr-3 tabular-nums">{r.gauss_r2 != null ? r.gauss_r2.toFixed(4) : '—'}</td>
                        <td className="py-1 text-xs" style={{ color: r.ok ? '#b26a00' : 'var(--color-danger)' }}>
                          {flag ? `⚠ ${flag}` : ''}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={btnClass} onClick={() => void applyDropped()} disabled={busy || dropped.size === 0}>
                  Refazer sem as desmarcadas{dropped.size ? ` (${dropped.size})` : ''}
                </button>
                {det.runs.some((r) => flagOf(r)) && (
                  <button
                    type="button"
                    className="text-xs text-[var(--color-primary)] hover:underline"
                    onClick={() => setDropped(new Set(det.runs.filter((r) => flagOf(r)).map((r) => r.token)))}
                  >
                    desmarcar as ⚠
                  </button>
                )}
                {dropped.size > 0 && (
                  <button type="button" className="text-xs text-[var(--color-text-muted)] hover:underline" onClick={() => setDropped(new Set())}>
                    marcar todas
                  </button>
                )}
                {runMsg && <span className="text-xs text-[var(--color-text-muted)]">{runMsg}</span>}
              </div>
              {(det.reference.excluded ?? []).length > 0 && (
                <p className="text-xs text-[var(--color-text-muted)]">
                  Tiradas por você (o passo 1 não as devolve):{' '}
                  {(det.reference.excluded ?? []).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="mr-2 underline hover:text-[var(--color-primary)]"
                      title="devolver esta corrida à referência"
                      disabled={busy}
                      onClick={() => void restoreRun(t)}
                    >
                      {runName({ filename: t.split('/').pop() ?? t, token: t })} ↺
                    </button>
                  ))}
                </p>
              )}
              <p className="text-xs text-[var(--color-text-muted)]">
                Passe o mouse numa linha da tabela (ou no gráfico) para destacar a corrida. Uma corrida marcada com ⚠ puxa o molde
                para a forma dela — se for um erro de corrida, desmarque e refaça. A referência continua a mesma (as deconvoluções
                guiadas e por molde já salvas não mudam; ajuste de novo as misturas para usar a nova). Para devolver uma corrida
                tirada, clique nela em "Tiradas por você".
              </p>
            </div>
          )}
        </div>
      </div>

      {compareIds.length > 0 && (
        <div className={cardClass}>
          <h2 className="mb-1 font-semibold">Comparar moldes {compareCycle && <span className="text-xs font-normal text-[var(--color-text-muted)]">{compareCycle}</span>}</h2>
          {mixedCycles && (
            <p className="mb-1 text-xs text-[var(--color-warning,#b26a00)]">
              Referências de ciclos diferentes: o eixo de tempo não é o mesmo programa de temperatura.
            </p>
          )}
          <PostRunLinesPlot
            series={compareSeries}
            xLabel="tempo da corrida (s)"
            yLabel="sinal ÷ área (1/s)"
            height={300}
            legend={compareIds.map((id, i) => ({ label: details[id].reference.name, color: PEAK_COLORS[i % PEAK_COLORS.length] }))}
          />
          <p className="text-xs text-[var(--color-text-muted)]">
            Cada molde na posição média do seu máximo. Moldes que quase se cobrem (mesmo lugar, mesma forma) não se separam bem
            numa mistura — nesse caso, reporte a soma.
          </p>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border p-2 border-[var(--color-border)]">
      <div className="text-[11px] text-[var(--color-text-muted)]">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  )
}
