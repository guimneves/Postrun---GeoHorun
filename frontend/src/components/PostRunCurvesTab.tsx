import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import {
  postrunApi,
  type AnalysisSummary,
  type AreaSource,
  type CurveModel,
  type CurvePointIn,
  type CurvePreview,
  type CurveWeighting,
  type CurveXKind,
  type RegionIn,
  type SavedCurve,
} from '../api/postrun'
import { fmtNum } from '../lib/postrunFormat'
import { PostRunScatterPlot } from './PostRunScatterPlot'
import { inputClass, btnClass, btnPrimaryClass, cardClass } from '../ui/classes'
import { PostRunCurveLimits } from './PostRunCurveLimits'

const MODEL_LABELS: Record<CurveModel, string> = {
  linear: 'Reta (a + b·m)',
  origin: 'Reta pela origem (b·m)',
  quadratic: 'Quadrática (a + b·m + c·m²)',
}
const WEIGHT_LABELS: Record<CurveWeighting, string> = { none: 'Sem peso', '1/x': 'Peso 1/m', '1/x2': 'Peso 1/m² (recomendado)' }

export interface WorkspacePoint {
  key: string
  token: string
  region: RegionIn
}

/** pico de uma deconvolução SALVA (amostra virtual) */
export interface WorkspaceGaussian {
  token: string
  material: string
  region: RegionIn
}

interface Edit {
  mass: string
  comp: string
}

function evalFit(coef: number[], model: CurveModel, x: number): number {
  if (model === 'origin') return coef[0] * x
  if (model === 'linear') return coef[0] + coef[1] * x
  return coef[0] + coef[1] * x + coef[2] * x * x
}

/** Aba "Curvas" do PostRun (pedido do usuário, 16/10/2026): curvas de
 * calibração massa × área a partir das regiões das análises — área no
 * tempo (sinal × s), massa da amostra ou de um componente (pela
 * composição), por ciclo. Mostra também a área ÷ mg (fator de resposta). */
export function PostRunCurvesTab({
  workspacePoints,
  workspaceGaussians,
  analysesByToken,
  onAnalysesUpdated,
  curveFilter,
  openTokens = [],
}: {
  /** análises abertas no workspace — candidatas a branco/nível baixo (F2) */
  openTokens?: string[]
  workspacePoints: WorkspacePoint[]
  workspaceGaussians: WorkspaceGaussian[]
  analysesByToken: Record<string, AnalysisSummary>
  onAnalysesUpdated: (items: AnalysisSummary[]) => void
  /** estudo aberto: só as curvas dele (e as de nenhum estudo); finalizados somem da lista (22/10/2026) */
  curveFilter?: (id: number) => boolean
}) {
  const [allCurves, setCurves] = useState<SavedCurve[]>([])
  const curves = useMemo(() => (curveFilter ? allCurves.filter((c) => curveFilter(c.id)) : allCurves), [allCurves, curveFilter])
  const [editingId, setEditingId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [areaSource, setAreaSource] = useState<AreaSource>('region')
  const [xKind, setXKind] = useState<CurveXKind>('sample_mass')
  const [component, setComponent] = useState('')
  const [model, setModel] = useState<CurveModel>('linear')
  const [weighting, setWeighting] = useState<CurveWeighting>('1/x2')
  const [points, setPoints] = useState<CurvePointIn[]>([])
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [preview, setPreview] = useState<CurvePreview | null>(null)
  const [nonce, setNonce] = useState(0)
  // resíduos em unidade de área ou em % do previsto (pedido do usuário, 16/10/2026:
  // com peso 1/m², o relativo é o que o ajuste minimiza)
  const [residMode, setResidMode] = useState<'pct' | 'abs'>('pct')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  function loadCurves() {
    postrunApi.listCurves().then(setCurves).catch(() => setCurves([]))
  }
  useEffect(loadCurves, [])

  // prévia (ajuste sem gravar) a cada mudança
  useEffect(() => {
    if (points.length === 0) {
      setPreview(null)
      return
    }
    if (xKind === 'component_mass' && !component) return
    let alive = true
    const timer = window.setTimeout(() => {
      postrunApi
        .previewCurve({ channel: 'pyro:FID', area_source: areaSource, x_kind: xKind, component, model, weighting, points })
        .then((p) => alive && setPreview(p))
        .catch((err) => alive && setMessage(err instanceof ApiError ? err.message : 'Erro ao ajustar a curva'))
    }, 350)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [points, areaSource, xKind, component, model, weighting, nonce])

  const components = useMemo(() => {
    const set = new Set<string>()
    for (const p of points) {
      const a = analysesByToken[p.region.token]
      for (const c of a?.components ?? Object.keys(a?.composition ?? {})) set.add(c)
    }
    for (const g of workspaceGaussians) set.add(g.material)
    for (const p of preview?.points ?? [])
      for (const part of p.composition_text.replace(' (sem proporção)', '').split(/ · | \+ /)) if (part) set.add(part.split(' ')[0])
    return Array.from(set).sort()
  }, [points, analysesByToken, preview, workspaceGaussians])

  function fillFromWorkspace() {
    const prev = new Map(points.map((p) => [p.region.token, p.excluded]))
    if (areaSource === 'gaussian') {
      const mine = workspaceGaussians.filter((g) => !component || g.material === component)
      setPoints(mine.map((g) => ({ region: g.region, gaussian: g.material, excluded: prev.get(g.token) ?? false })))
      setMessage(
        mine.length
          ? `${mine.length} pico(s) ${component ? `de ${component} ` : ''}das deconvoluções salvas nas análises abertas.`
          : 'Nenhuma deconvolução salva com esse material nas análises abertas — ajuste e salve a deconvolução na aba Análises.',
      )
      return
    }
    setPoints(workspacePoints.map((w) => ({ region: w.region, excluded: prev.get(w.token) ?? false })))
    setMessage(
      workspacePoints.length
        ? `${workspacePoints.length} ponto(s) das regiões do FID nas análises abertas.`
        : 'Nenhuma região do FID nas análises abertas — marque as análises e as regiões na aba Análises.',
    )
  }

  function newCurve() {
    setEditingId(null)
    setName('')
    setNotes('')
    setPoints([])
    setPreview(null)
    setMessage(null)
  }

  function openCurve(c: SavedCurve) {
    setEditingId(c.id)
    setName(c.name)
    setNotes(c.notes)
    setAreaSource(c.area_source)
    setXKind(c.x_kind)
    setComponent(c.component)
    setModel(c.model)
    setWeighting(c.weighting)
    setPoints(
      c.points.map((p) => ({
        excluded: p.excluded,
        gaussian: p.gaussian || undefined,
        region: {
          token: p.token, channel: c.channel, label: p.label, start_idx: p.start_idx, end_idx: p.end_idx,
          baseline_mode: p.baseline_mode, fixed_baseline: p.fixed_baseline,
        },
      })),
    )
    setMessage(`Curva "${c.name}" aberta — os pontos são os gravados nela.`)
  }

  function toggleExcluded(i: number) {
    setPoints((prev) => prev.map((p, j) => (j === i ? { ...p, excluded: !p.excluded } : p)))
  }

  // seleção no gráfico (retângulo): tira (ou, com Shift, devolve) vários pontos
  function setExcluded(ids: number[], excluded: boolean) {
    const set = new Set(ids)
    setPoints((prev) => prev.map((p, j) => (set.has(j) ? { ...p, excluded } : p)))
  }

  function editOf(token: string): Edit {
    const a = analysesByToken[token]
    return edits[token] ?? {
      mass: a?.mass_source === 'manual' ? String(a.mass_mg) : '',
      // no formato que se digita: "PP 50, PS 50", "PS" ou "PP, PS" (sem proporção)
      comp:
        a?.composition_source === 'manual'
          ? a.composition && Object.keys(a.composition).length > 1
            ? Object.entries(a.composition)
                .map(([k, v]) => `${k} ${+(100 * v).toFixed(2)}`)
                .join(', ')
            : (a.components ?? []).join(', ')
          : '',
    }
  }

  const pendingEdits = Object.keys(edits)

  async function saveEdits() {
    setBusy(true)
    setMessage(null)
    try {
      const items = pendingEdits.map((token) => {
        const e = edits[token]
        const mass = e.mass.trim() ? Number(e.mass.replace(',', '.')) : null
        return { token, mass_mg: mass, composition_text: e.comp.trim() }
      })
      const updated = await postrunApi.updateMeta(items)
      onAnalysesUpdated(updated)
      setEdits({})
      setNonce((n) => n + 1)
      setMessage(`Correções salvas em ${updated.length} análise(s).`)
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao salvar as correções')
    } finally {
      setBusy(false)
    }
  }

  async function saveCurve() {
    if (!name.trim()) {
      setMessage('Dê um nome à curva.')
      return
    }
    setBusy(true)
    setMessage(null)
    const spec = { channel: 'pyro:FID', area_source: areaSource, x_kind: xKind, component, model, weighting, points, name, notes }
    try {
      const saved = editingId ? await postrunApi.updateCurve(editingId, spec) : await postrunApi.createCurve(spec)
      setEditingId(saved.id)
      loadCurves()
      setMessage(`Curva "${saved.name}" salva.`)
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao salvar a curva')
    } finally {
      setBusy(false)
    }
  }

  async function removeCurve(c: SavedCurve) {
    if (!window.confirm(`Apagar a curva "${c.name}"? Isso não pode ser desfeito.`)) return
    try {
      await postrunApi.deleteCurve(c.id)
      if (editingId === c.id) newCurve()
      loadCurves()
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao apagar a curva')
    }
  }

  const fit = preview?.fit ?? null
  const savedCurve = editingId !== null ? (allCurves.find((c) => c.id === editingId) ?? null) : null
  const xLabel = xKind === 'component_mass' && component ? `Massa de ${component} (mg)` : 'Massa da amostra (mg)'
  // pontos dos gráficos: `id` = índice do ponto na curva (clique/seleção);
  // resíduo calculado também para os que estão fora do ajuste (para ver se
  // são mesmo pontos fora da curva)
  const used = (preview?.points ?? [])
    .map((p, id) => ({ ...p, id }))
    .filter((p) => p.x !== null && p.area_s !== null && !p.error)
  const resid = (p: (typeof used)[number]) =>
    fit && preview ? (p.area_s as number) - evalFit(fit.coef, preview.model, p.x as number) : null
  // resíduo relativo: rᵢ ÷ área prevista × 100
  const residPct = (p: (typeof used)[number]) => {
    const r = resid(p)
    if (r === null || !fit || !preview) return null
    const pred = evalFit(fit.coef, preview.model, p.x as number)
    return pred ? (100 * r) / pred : null
  }
  const tip = (p: (typeof used)[number]) => {
    const r = resid(p)
    const rp = residPct(p)
    return [
      `${p.sample} · ${p.filename}`,
      `massa ${fmtNum(p.x as number)} mg · área ${fmtNum(p.area_s as number)}`,
      `área/mg ${p.area_per_mg !== null ? fmtNum(p.area_per_mg) : '—'}`,
      r !== null ? `resíduo ${fmtNum(r)}${rp !== null ? ` (${rp >= 0 ? '+' : ''}${rp.toFixed(1)} %)` : ''}` : 'resíduo —',
      p.excluded ? 'fora do ajuste — clique para incluir' : 'no ajuste — clique para tirar',
    ]
  }
  const areaPoints = used.map((p) => ({ id: p.id, x: p.x as number, y: p.area_s as number, hollow: p.excluded, tip: tip(p) }))
  const rfPoints = used
    .filter((p) => p.area_per_mg !== null)
    .map((p) => ({ id: p.id, x: p.x as number, y: p.area_per_mg as number, hollow: p.excluded, tip: tip(p) }))
  const residValue = (p: (typeof used)[number]) => (residMode === 'pct' ? residPct(p) : resid(p))
  const residualPoints = used
    .filter((p) => residValue(p) !== null)
    .map((p) => ({ id: p.id, x: p.x as number, y: residValue(p) as number, hollow: p.excluded, tip: tip(p) }))
  // dispersão relativa dos pontos do ajuste (RMS do resíduo %) — faixa de ± 2×RMS no gráfico
  const pctIn = used.filter((p) => !p.excluded).map(residPct).filter((v): v is number => v !== null)
  const rmsPct = pctIn.length > 1 ? Math.sqrt(pctIn.reduce((acc, v) => acc + v * v, 0) / pctIn.length) : null
  const nExcluded = points.filter((p) => p.excluded).length
  const interaction = { onPointClick: toggleExcluded, onBoxSelect: (ids: number[], include: boolean) => setExcluded(ids, !include) }

  return (
    <div className="flex flex-col gap-3">
      <div className={cardClass}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Curvas salvas</h2>
          <button type="button" className={btnClass} onClick={newCurve}>
            Nova curva
          </button>
        </div>
        {curves.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">Nenhuma curva ainda.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[var(--color-text-muted)]">
                <tr>
                  <th className="py-1 pr-3">Nome</th>
                  <th className="py-1 pr-3">Massa (eixo X)</th>
                  <th className="py-1 pr-3">Ciclo</th>
                  <th className="py-1 pr-3">Modelo</th>
                  <th className="py-1 pr-3">n</th>
                  <th className="py-1 pr-3">R²</th>
                  <th className="py-1 pr-3">Atualizada</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {curves.map((c) => (
                  <tr
                    key={c.id}
                    className="border-t border-[var(--color-border)]"
                    style={editingId === c.id ? { background: 'var(--color-surface)' } : undefined}
                  >
                    <td className="py-1 pr-3 font-medium">{c.name}</td>
                    <td className="py-1 pr-3">
                      {c.x_kind === 'component_mass' ? `de ${c.component}` : 'da amostra'}
                      {c.area_source === 'gaussian' && <span className="block text-[10px] text-[var(--color-text-dim)]">área da gaussiana</span>}
                    </td>
                    <td className="py-1 pr-3 text-xs">{c.cycle_label}</td>
                    <td className="py-1 pr-3 text-xs">
                      {MODEL_LABELS[c.model]} · {WEIGHT_LABELS[c.weighting].replace(' (recomendado)', '')}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">{c.fit?.n ?? '—'}</td>
                    <td className="py-1 pr-3 tabular-nums">{c.fit ? c.fit.r2.toFixed(5) : '—'}</td>
                    <td className="py-1 pr-3 text-xs">{new Date(c.updated_at).toLocaleString('pt-BR')}</td>
                    <td className="py-1 text-right">
                      <button type="button" className="text-xs text-[var(--color-primary)] hover:underline" onClick={() => openCurve(c)}>
                        abrir
                      </button>{' '}
                      <button type="button" className="text-xs text-[var(--color-danger)] hover:underline" onClick={() => void removeCurve(c)}>
                        apagar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={cardClass}>
        <h2 className="mb-1 font-semibold">{editingId ? `Editando: ${name}` : 'Nova curva de calibração'}</h2>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Cada ponto é uma análise com a sua região do FID (pirólise): área no tempo (sinal × s) contra a massa. Use as
          análises de um mesmo ciclo — pontos de ciclos diferentes são recusados. Marque as análises e ajuste as regiões na
          aba Análises (pode usar "Aplicar a todas"), depois toque em <strong>Usar as regiões das análises abertas</strong>.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Nome da curva
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: PS — FID — BASIC" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Área de
            <select
              className={inputClass}
              value={areaSource}
              onChange={(e) => {
                const v = e.target.value as AreaSource
                setAreaSource(v)
                setPoints([])
                if (v === 'gaussian') setXKind('component_mass')
              }}
            >
              <option value="region">Região integrada</option>
              <option value="gaussian">Gaussiana (deconvolução salva)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Massa no eixo X
            <select className={inputClass} value={xKind} onChange={(e) => setXKind(e.target.value as CurveXKind)}>
              <option value="sample_mass">Massa da amostra</option>
              <option value="component_mass">Massa de um componente (pela composição)</option>
            </select>
          </label>
          {xKind === 'component_mass' && (
            <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
              Componente
              <select className={inputClass} value={component} onChange={(e) => setComponent(e.target.value)}>
                <option value="">— escolha —</option>
                {components.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Modelo
            <select className={inputClass} value={model} onChange={(e) => setModel(e.target.value as CurveModel)}>
              {(Object.keys(MODEL_LABELS) as CurveModel[]).map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Peso dos pontos
            <select className={inputClass} value={weighting} onChange={(e) => setWeighting(e.target.value as CurveWeighting)}>
              {(Object.keys(WEIGHT_LABELS) as CurveWeighting[]).map((w) => (
                <option key={w} value={w}>
                  {WEIGHT_LABELS[w]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)] md:col-span-2">
            Observações
            <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={btnClass} onClick={fillFromWorkspace}>
            {areaSource === 'gaussian'
              ? `Usar as gaussianas salvas das análises abertas (${workspaceGaussians.filter((g) => !component || g.material === component).length})`
              : `Usar as regiões das análises abertas (${workspacePoints.length})`}
          </button>
          {pendingEdits.length > 0 && (
            <button type="button" className={btnClass} onClick={() => void saveEdits()} disabled={busy}>
              Salvar correções de massa/composição ({pendingEdits.length})
            </button>
          )}
          <button type="button" className={btnPrimaryClass} onClick={() => void saveCurve()} disabled={busy || !fit || !!preview?.error}>
            {editingId ? 'Salvar alterações da curva' : 'Salvar curva'}
          </button>
          {message && <span className="text-xs text-[var(--color-text-muted)]">{message}</span>}
        </div>
        {preview?.error && <p className="mt-2 text-sm text-[var(--color-danger)]">{preview.error}</p>}
      </div>

      {points.length > 0 && (
        <div className={cardClass}>
          <h3 className="mb-2 font-semibold">Pontos</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[var(--color-text-muted)]">
                <tr>
                  <th className="py-1 pr-2">Usar</th>
                  <th className="py-1 pr-3">Amostra</th>
                  <th className="py-1 pr-3">Composição</th>
                  <th className="py-1 pr-3">Massa (mg)</th>
                  <th className="py-1 pr-3">Massa no eixo (mg)</th>
                  <th className="py-1 pr-3">Área (sinal·s)</th>
                  <th className="py-1 pr-3">Área/mg</th>
                  <th className="py-1 pr-3">Resíduo</th>
                  <th className="py-1 pr-3">{areaSource === 'gaussian' ? 'Gaussiana' : 'Pico'}</th>
                </tr>
              </thead>
              <tbody>
                {points.map((p, i) => {
                  const token = p.region.token
                  const out = preview?.points[i]
                  const a = analysesByToken[token]
                  const e = editOf(token)
                  return (
                    <tr key={token} className="border-t border-[var(--color-border)] align-top" style={p.excluded ? { opacity: 0.5 } : undefined}>
                      <td className="py-1 pr-2">
                        <input type="checkbox" checked={!p.excluded} onChange={() => toggleExcluded(i)} aria-label={`usar ${token}`} />
                      </td>
                      <td className="py-1 pr-3">
                        <span className="block">{out?.sample ?? a?.sample ?? token}</span>
                        <span className="block font-mono text-[10px] text-[var(--color-text-dim)]">{out?.filename ?? token.split('/').pop()}</span>
                        {out?.error && <span className="block text-xs text-[var(--color-danger)]">{out.error}</span>}
                      </td>
                      <td className="py-1 pr-3">
                        <input
                          className={`${inputClass} min-w-[160px] text-xs`}
                          value={e.comp}
                          placeholder={out?.composition_text || a?.composition_text || 'ex.: PS · PP 50, PS 50 · PP, PS'}
                          title="vazio = composição lida do nome"
                          onChange={(ev) => setEdits((prev) => ({ ...prev, [token]: { ...e, comp: ev.target.value } }))}
                        />
                      </td>
                      <td className="py-1 pr-3">
                        <input
                          className={`${inputClass} w-24 text-xs`}
                          value={e.mass}
                          inputMode="decimal"
                          placeholder={a ? String(a.quantity_mg) : ''}
                          title="vazio = massa do arquivo (.B00)"
                          onChange={(ev) => setEdits((prev) => ({ ...prev, [token]: { ...e, mass: ev.target.value } }))}
                        />
                        <span className="text-[10px] text-[var(--color-text-dim)]">{out?.mass_source === 'manual' ? 'corrigida' : 'do arquivo'}</span>
                      </td>
                      <td className="py-1 pr-3 tabular-nums">{out?.x !== null && out?.x !== undefined ? fmtNum(out.x) : '—'}</td>
                      <td className="py-1 pr-3 tabular-nums">{out?.area_s !== null && out?.area_s !== undefined ? fmtNum(out.area_s) : '—'}</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {out?.area_per_mg !== null && out?.area_per_mg !== undefined ? fmtNum(out.area_per_mg) : '—'}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">{out?.residual !== null && out?.residual !== undefined ? fmtNum(out.residual) : '—'}</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {areaSource === 'gaussian' ? (p.gaussian ?? '—') : out?.peak_temp ? `${out.peak_temp.toFixed(0)} °C` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {fit && preview && (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          <div className={`${cardClass} xl:col-span-2`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">Área × massa</h3>
              {nExcluded > 0 && (
                <button
                  type="button"
                  className="text-xs text-[var(--color-primary)] hover:underline"
                  onClick={() => setPoints((prev) => prev.map((p) => ({ ...p, excluded: false })))}
                >
                  devolver os {nExcluded} ponto(s) tirados
                </button>
              )}
            </div>
            <p className="mb-1 text-xs text-[var(--color-text-muted)]">
              {fit.equation} (A em sinal·s, m em mg) · <strong>clique</strong> num ponto para tirá-lo do ajuste (fica vazado) ou
              devolvê-lo; <strong>arraste</strong> um retângulo para tirar vários (com <strong>Shift</strong>, devolve). Vale nos três
              gráficos.
            </p>
            <PostRunScatterPlot
              {...interaction}
              lineDash="6 4"
              points={areaPoints}
              xLabel={xLabel}
              yLabel="Área (sinal·s)"
              line={(x) => evalFit(fit.coef, preview.model, x)}
              vLines={[
                ...(fit.lod !== null ? [{ x: fit.lod, label: 'LD' }] : []),
                ...(fit.loq !== null ? [{ x: fit.loq, label: 'LQ' }] : []),
              ]}
              yFromZero
              height={320}
            />
          </div>
          <div className={cardClass}>
            <h3 className="mb-2 font-semibold">Resultado</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-[var(--color-text-muted)]">Equação</dt>
              <dd className="font-mono text-xs">{fit.equation}</dd>
              <dt className="text-[var(--color-text-muted)]">R²</dt>
              <dd className="tabular-nums">{fit.r2.toFixed(5)}</dd>
              <dt className="text-[var(--color-text-muted)]">Pontos</dt>
              <dd>{fit.n} (graus de liberdade {fit.dof})</dd>
              <dt className="text-[var(--color-text-muted)]">Desvio residual</dt>
              <dd className="tabular-nums">{fmtNum(fit.s_y)} sinal·s</dd>
              <dt className="text-[var(--color-text-muted)]">Faixa</dt>
              <dd className="tabular-nums">
                {fmtNum(fit.x_min)} a {fmtNum(fit.x_max)} mg
              </dd>
              <dt className="text-[var(--color-text-muted)]">LD / LQ</dt>
              <dd className="tabular-nums">
                {fit.lod !== null ? `${fmtNum(fit.lod)} / ${fmtNum(fit.loq ?? NaN)} mg` : '—'}
              </dd>
              <dt className="text-[var(--color-text-muted)]">Área/mg</dt>
              <dd className="tabular-nums">
                {fit.rf_mean !== null ? `${fmtNum(fit.rf_mean)} ± ${fmtNum(fit.rf_sd ?? NaN)} (CV ${fit.rf_cv_pct?.toFixed(1)} %)` : '—'}
              </dd>
              <dt className="text-[var(--color-text-muted)]">Ciclo</dt>
              <dd className="text-xs">{preview.cycle_label}</dd>
            </dl>
            {fit.warnings.map((w) => (
              <p key={w} className="mt-2 text-xs text-[var(--color-danger)]">
                {w}
              </p>
            ))}
          </div>
          <div className={`${cardClass} xl:col-span-2`}>
            <h3 className="font-semibold">Área ÷ mg × massa (fator de resposta)</h3>
            <p className="mb-1 text-xs text-[var(--color-text-muted)]">
              Deveria ser constante na faixa linear — tendência indica saturação do FID ou perda na pirólise. Faixa = média ±
              desvio.
            </p>
            <PostRunScatterPlot
              {...interaction}
              points={rfPoints}
              xLabel={xLabel}
              yLabel="Área/mg (sinal·s/mg)"
              hLine={fit.rf_mean ?? undefined}
              band={fit.rf_mean !== null && fit.rf_sd !== null ? { y0: fit.rf_mean - fit.rf_sd, y1: fit.rf_mean + fit.rf_sd } : undefined}
              height={260}
            />
          </div>
          <div className={cardClass}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Resíduos</h3>
              <div className="flex gap-1 rounded-full border p-0.5 text-xs border-[var(--color-border)]" role="group" aria-label="Unidade dos resíduos">
                {(
                  [
                    ['pct', '% do previsto'],
                    ['abs', 'sinal·s'],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={residMode === v}
                    onClick={() => setResidMode(v)}
                    className="rounded-full px-2.5 py-0.5"
                    style={{
                      backgroundColor: residMode === v ? 'var(--color-primary)' : 'transparent',
                      color: residMode === v ? 'var(--color-primary-contrast)' : 'var(--color-text-muted)',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p className="mb-1 text-xs text-[var(--color-text-muted)]">
              {residMode === 'pct'
                ? `(medida − prevista) ÷ prevista × 100. Com peso 1/m², é o que o ajuste minimiza: os pontos devem se espalhar por igual em torno de zero, sem funil nem curvatura.${rmsPct !== null ? ` Dispersão (RMS) ${rmsPct.toFixed(1)} % — faixa = ± 2 × RMS.` : ''}`
                : 'Área medida − prevista. Funil abrindo com a massa = erro proporcional à massa (use peso 1/m²); curvatura = o modelo não serve.'}{' '}
              Vazados: fora do ajuste.
            </p>
            <PostRunScatterPlot
              {...interaction}
              points={residualPoints}
              xLabel={xLabel}
              yLabel={residMode === 'pct' ? 'Resíduo (% do previsto)' : 'Resíduo (sinal·s)'}
              hLine={0}
              band={residMode === 'pct' && rmsPct !== null ? { y0: -2 * rmsPct, y1: 2 * rmsPct } : undefined}
              height={260}
            />
          </div>
        </div>
      )}

      {editingId !== null && savedCurve && (
        <PostRunCurveLimits curve={savedCurve} openTokens={openTokens} analysesByToken={analysesByToken} onSaved={loadCurves} />
      )}
    </div>
  )
}
