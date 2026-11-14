import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import {
  postrunApi,
  type AnalysisSummary,
  type BaselineMode,
  type DeconvMode,
  type DeconvReference,
  type DeconvResult,
  type DeconvShape,
  type DeconvSpec,
} from '../api/postrun'
import { fmtNum } from '../lib/postrunFormat'
import { PEAK_COLORS } from '../lib/postrunColors'
import { PostRunLinesPlot, type LineSeries } from './PostRunLinesPlot'
import { shapeSeriesOf } from '../lib/postrunShape'
import { PostRunScatterPlot } from './PostRunScatterPlot'
import { inputClass, btnClass } from '../ui/classes'

export interface DeconvWindow {
  startIdx: number
  endIdx: number
  baselineMode: BaselineMode
  fixedBaseline: number
}

export interface DeconvEntry {
  result: DeconvResult
  dirty: boolean
  removed?: boolean
  savedId?: number | null
}

interface Settings {
  shape: DeconvShape
  mode: DeconvMode
  nPeaks: number
  names: string
  guesses: string
  refIds: number[]
  byComposition: boolean
  tolC: number
  tolW: number
}

const DEFAULTS: Settings = {
  shape: 'bigaussian', mode: 'free', nPeaks: 1, names: '', guesses: '', refIds: [], byComposition: true, tolC: 20, tolW: 30,
}

function listOf(text: string): string[] {
  return text.split(/[,;]/).map((t) => t.trim()).filter(Boolean)
}

/** Deconvolução do sinal da análise ativa (pedido do usuário, 16/10/2026):
 * picos gaussianos (ou assimétricos) livres ou guiados pelas referências
 * dos materiais puros. Cada pico vira uma "amostra virtual"; nada é
 * gravado até o Salvar da página. */
export function PostRunDeconvPanel({
  token,
  channel,
  window: win,
  analysis,
  entry,
  openTokens,
  analysesByToken,
  windowFor,
  references,
  onOpenReferences,
  onModeChange,
  onResults,
  onRemove,
}: {
  token: string
  channel: string
  window: DeconvWindow
  analysis: AnalysisSummary | undefined
  entry: DeconvEntry | undefined
  openTokens: string[]
  analysesByToken: Record<string, AnalysisSummary>
  /** janela (região) de outra análise aberta no mesmo canal — senão vale a desta */
  windowFor: (token: string) => DeconvWindow | null
  references: DeconvReference[]
  /** leva à aba Referências (ver moldes, criar/apagar) */
  onOpenReferences?: () => void
  /** trocou o modo (molde ↔ gaussiana): a página mostra os salvos do método */
  onModeChange?: (mode: DeconvMode) => void
  onResults: (items: DeconvResult[]) => void
  onRemove: () => void
}) {
  const [s, setS] = useState<Settings>(DEFAULTS)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // ao trocar de análise, mostra as escolhas da deconvolução dela (se houver)
  const specOfEntry = entry?.result.spec
  useEffect(() => {
    if (!specOfEntry) return
    setS((prev) => ({
      ...prev,
      shape: specOfEntry.shape, mode: specOfEntry.mode, nPeaks: specOfEntry.n_peaks,
      names: specOfEntry.names.join(', '), guesses: specOfEntry.guesses_c.join(', '),
      refIds: specOfEntry.reference_ids, tolC: specOfEntry.tol_c, tolW: specOfEntry.tol_width_pct,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, specOfEntry?.token])

  // (2) forma normalizada: puro × mistura, cada um ÷ a própria altura e
  // centrado no próprio máximo (24/10/2026)
  const shapeSeries = useMemo<LineSeries[]>(() => shapeSeriesOf(entry?.removed ? null : entry?.result), [entry])

  const cycleRefs = useMemo(
    () => references.filter((r) => r.channel === channel && (!analysis || r.cycle_key === analysis.cycle_key)),
    [references, channel, analysis],
  )

  function refsFor(t: string): number[] {
    const a = analysesByToken[t]
    if (!s.byComposition) return s.refIds
    const comp = Object.keys(a?.composition ?? {})
    return references
      .filter((r) => r.channel === channel && (!a || r.cycle_key === a.cycle_key) && comp.includes(r.name))
      .map((r) => r.id)
  }

  /** componentes da composição sem referência (deste ciclo, com molde no modo Molde) */
  function missingFor(t: string): string[] {
    const a = analysesByToken[t]
    const comp = Object.keys(a?.composition ?? {})
    return comp.filter(
      (name) =>
        !references.some(
          (r) => r.channel === channel && r.name === name && (!a || r.cycle_key === a.cycle_key) && (s.mode !== 'template' || r.has_template),
        ),
    )
  }

  function specFor(t: string): DeconvSpec | { missing: string[]; unknown?: boolean } {
    const w = t === token ? win : (windowFor(t) ?? win)
    const usesRefs = s.mode === 'guided' || s.mode === 'template'
    if (usesRefs && s.byComposition) {
      // todos os componentes precisam de referência — senão o sinal de quem
      // falta iria inteiro para os outros
      const a = analysesByToken[t]
      if (!a?.composition) return { missing: [], unknown: true }
      const missing = missingFor(t)
      if (missing.length) return { missing }
    }
    const refIds = usesRefs ? refsFor(t) : []
    if (usesRefs && refIds.length === 0) return { missing: [] }
    const guesses = listOf(s.guesses).map((v) => Number(v.replace(',', '.'))).filter((v) => Number.isFinite(v))
    return {
      token: t, channel, start_idx: w.startIdx, end_idx: w.endIdx, baseline_mode: w.baselineMode,
      fixed_baseline: w.fixedBaseline, shape: s.shape, mode: s.mode,
      n_peaks: s.mode === 'free' ? (guesses.length || s.nPeaks) : 1, reference_ids: refIds, tol_c: s.tolC,
      tol_width_pct: s.tolW, names: s.mode === 'free' ? listOf(s.names).map((n) => n.toUpperCase()) : [], guesses_c: guesses,
    }
  }

  async function run(tokens: string[]) {
    const specs: DeconvSpec[] = []
    const problems: string[] = []
    const missing = new Set<string>()
    let skipped = 0
    let unknown = 0
    for (const t of tokens) {
      const sp = specFor(t)
      if ('missing' in sp) {
        skipped++
        if (sp.unknown) unknown++
        sp.missing.forEach((m) => missing.add(m))
      } else specs.push(sp)
    }
    if (skipped) {
      const mats = Array.from(missing)
      problems.push(
        (mats.length
          ? `${skipped} análise(s) sem referência de ${mats.join(', ')} neste ciclo${s.mode === 'template' ? ' (com molde)' : ''}. ` +
            `Crie primeiro: abra as corridas do puro, modo Livre, 1 pico, nome ${mats[0]}, Ajustar todas, Salvar, e Criar referência ` +
            `em "Referências dos materiais puros".`
          : `${skipped} análise(s) sem referência marcada.`) +
          (unknown ? ` ${unknown} sem composição conhecida — informe na aba Curvas.` : ''),
      )
    }
    if (specs.length === 0) {
      setMessage(problems.join(' ') || 'Nada para ajustar.')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const res = await postrunApi.fitDeconv(specs)
      const ok = res.filter((r) => r.ok && r.data).map((r) => r.data!)
      for (const r of res) if (!r.ok) problems.push(`${analysesByToken[r.token]?.filename ?? r.token}: ${r.error}`)
      onResults(ok)
      setMessage(
        `Ajustada(s) ${ok.length} análise(s) — confira e toque em Salvar para gravar.` +
          (problems.length ? ` Não ajustadas: ${problems.join(' ')}` : ''),
      )
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro na deconvolução')
    } finally {
      setBusy(false)
    }
  }

  function renamePeak(i: number, name: string) {
    if (!entry) return
    const r = entry.result
    const names = r.peaks.map((p, j) => (j === i ? name.toUpperCase() : p.name))
    onResults([
      {
        ...r,
        spec: { ...r.spec, names },
        peaks: r.peaks.map((p, j) => (j === i ? { ...p, name: name.toUpperCase(), material: name.toUpperCase() } : p)),
      },
    ])
  }

  const result = entry?.result
  const residuals = useMemo(() => {
    const c = result?.curve
    if (!c) return []
    return c.idx.map((x, i) => ({ x: x * (result?.seconds_per_point ?? 1), y: c.signal[i] - c.fitted[i] }))
  }, [result])

  return (
    <div className="flex flex-col gap-3 rounded-2xl border p-3 border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">Deconvolução — picos (amostras virtuais)</span>
        <span className="text-xs text-[var(--color-text-muted)]">
          janela = a região acima (início {win.startIdx} · fim {win.endIdx}, baseline {win.baselineMode === 'linear' ? 'reta' : 'fixa'})
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Modo
          <select
            className={inputClass}
            value={s.mode}
            onChange={(e) => {
              const mode = e.target.value as DeconvMode
              // tolerâncias de partida de cada modo (o molde precisa de mais folga na largura)
              setS({ ...s, mode, ...(mode === 'template' ? { tolC: 25, tolW: 40 } : mode === 'guided' ? { tolC: 20, tolW: 30 } : {}) })
              onModeChange?.(mode)
            }}
          >
            <option value="free">Livre</option>
            <option value="guided">Guiada por referências (picos)</option>
            <option value="template">Molde do material puro</option>
          </select>
        </label>
        {s.mode !== 'template' && (
          <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Forma do pico
            <select className={inputClass} value={s.shape} onChange={(e) => setS({ ...s, shape: e.target.value as DeconvShape })}>
              <option value="bigaussian">Gaussiana assimétrica</option>
              <option value="gaussian">Gaussiana</option>
            </select>
          </label>
        )}
        {s.mode === 'free' ? (
          <>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
              Nº de picos
              <input
                type="number"
                min={1}
                max={8}
                className={inputClass}
                value={s.nPeaks}
                onChange={(e) => setS({ ...s, nPeaks: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
              Nomes (material)
              <input className={inputClass} value={s.names} placeholder="ex.: PS" onChange={(e) => setS({ ...s, names: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)] md:col-span-2">
              Centros iniciais (°C, opcional)
              <input
                className={inputClass}
                value={s.guesses}
                placeholder="ex.: 440, 495 — vazio = automático"
                onChange={(e) => setS({ ...s, guesses: e.target.value })}
              />
            </label>
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
              Tolerância do centro (± °C)
              <input type="number" min={0} className={inputClass} value={s.tolC} onChange={(e) => setS({ ...s, tolC: Number(e.target.value) || 0 })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
              {s.mode === 'template' ? 'Dilatação do molde (± %)' : 'Tolerância da largura (± %)'}
              <input type="number" min={0} className={inputClass} value={s.tolW} onChange={(e) => setS({ ...s, tolW: Number(e.target.value) || 0 })} />
            </label>
            <label className="flex items-center gap-2 self-end text-xs md:col-span-2">
              <input type="checkbox" checked={s.byComposition} onChange={(e) => setS({ ...s, byComposition: e.target.checked })} />
              referências pela composição de cada análise
            </label>
          </>
        )}
      </div>

      {s.mode === 'template' && (
        <p className="text-xs text-[var(--color-text-muted)]">
          Cada componente é a <strong>curva média do material puro</strong> (o molde, com área 1). O ajuste solta a área e,
          dentro dos limites, a posição (± °C) e a <strong>dilatação</strong> — esticar ou encolher o molde no tempo (× 1,05 =
          5 % mais largo), mantendo a área. Os limites não são o valor: o ajuste escolhe o melhor dentro deles. Use a
          "dilatação natural" da aba Referências como guia (o dobro dela é uma boa folga). Para as curvas de calibração,
          ajuste também os puros neste modo e salve.
        </p>
      )}
      {(s.mode === 'guided' || s.mode === 'template') && (
        <div className="text-xs">
          {cycleRefs.length === 0 ? (
            <span className="text-[var(--color-text-muted)]">
              Nenhuma referência neste ciclo ainda — ajuste as corridas do material puro no modo Livre (nomeie o pico, ex.: PS),
              salve e crie a referência abaixo.
            </span>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[var(--color-text-muted)]">Referências:</span>
              {cycleRefs.map((r) => {
                const auto = s.byComposition && Object.keys(analysis?.composition ?? {}).includes(r.name)
                return (
                  <label key={r.id} className="flex items-center gap-1" title={`${r.n_runs} corrida(s) · ${r.cycle_label}`}>
                    <input
                      type="checkbox"
                      disabled={s.byComposition}
                      checked={s.byComposition ? auto : s.refIds.includes(r.id)}
                      onChange={(e) =>
                        setS({ ...s, refIds: e.target.checked ? [...s.refIds, r.id] : s.refIds.filter((id) => id !== r.id) })
                      }
                    />
                    {r.name} ({r.peaks.map((p) => `${p.mu_c?.toFixed(0)} °C`).join(', ')})
                    {s.mode === 'template' && !r.has_template && (
                      <span className="text-[var(--color-danger)]" title="criada antes do molde — apague e crie de novo"> sem molde</span>
                    )}
                  </label>
                )
              })}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnClass} onClick={() => void run([token])} disabled={busy}>
          Ajustar
        </button>
        {openTokens.length > 1 && (
          <button type="button" className={btnClass} onClick={() => void run(openTokens)} disabled={busy}>
            Ajustar todas as abertas ({openTokens.length})
          </button>
        )}
        {entry && !entry.removed && (
          <button type="button" className={btnClass} onClick={onRemove} disabled={busy}>
            {entry.savedId ? 'Remover deconvolução' : 'Descartar ajuste'}
          </button>
        )}
        {entry && (
          <span className="text-xs" style={{ color: entry.dirty ? 'var(--color-warning, #b26a00)' : 'var(--color-text-muted)' }}>
            {entry.removed ? 'será removida ao salvar' : entry.dirty ? 'não salva' : 'salva'}
          </span>
        )}
      </div>
      {message && <p className="text-xs text-[var(--color-text-muted)]">{message}</p>}

      {result && !entry?.removed && (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
            <span>R² {result.r2.toFixed(4)}</span>
            <span>BIC {result.bic.toFixed(0)}</span>
            <span>
              Σ picos = {((100 * result.total_area_s) / (result.window_area_s || 1)).toFixed(1)} % da área da janela
            </span>
            {result.spec.mode !== 'template' && <span>{result.spec.shape === 'bigaussian' ? 'gaussiana assimétrica' : 'gaussiana'}</span>}
            <span>
              {result.spec.mode === 'template'
                ? `molde do puro (± ${result.spec.tol_c} °C, dilatação ± ${result.spec.tol_width_pct} %)`
                : result.spec.mode === 'guided'
                  ? `guiada (± ${result.spec.tol_c} °C, ± ${result.spec.tol_width_pct} %)`
                  : 'livre'}
            </span>
          </div>
          {result.warnings.map((w) => (
            <p key={w} className="text-xs text-[var(--color-danger)]">
              {w}
            </p>
          ))}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[var(--color-text-muted)]">
                <tr>
                  <th className="py-1 pr-3">Pico</th>
                  <th className="py-1 pr-3">Tpico (°C)</th>
                  <th className="py-1 pr-3">ΔTmax vs ref.</th>
                  <th className="py-1 pr-3">Área (sinal·s)</th>
                  <th className="py-1 pr-3">% do total</th>
                  <th className="py-1 pr-3">Largura (s)</th>
                  {result.spec.mode === 'template' && <th className="py-1 pr-3">Largura puro → mistura (°C)</th>}
                  <th className="py-1 pr-3">Δlargura vs ref.</th>
                </tr>
              </thead>
              <tbody>
                {result.peaks.map((p, i) => (
                  <tr key={i} className="border-t border-[var(--color-border)]">
                    <td className="py-1 pr-3">
                      <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full" style={{ background: PEAK_COLORS[i % PEAK_COLORS.length] }} />
                      {result.spec.mode === 'free' ? (
                        <input
                          className={`${inputClass} inline-block w-24 text-xs`}
                          value={p.name}
                          title="nome do material deste pico (vira a amostra virtual)"
                          onChange={(e) => renamePeak(i, e.target.value)}
                        />
                      ) : (
                        <span className="font-medium">{p.name}</span>
                      )}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">{p.mu_c?.toFixed(1) ?? '—'}</td>
                    <td className="py-1 pr-3 tabular-nums">
                      {p.delta_mu_c !== null ? `${p.delta_mu_c >= 0 ? '+' : ''}${p.delta_mu_c.toFixed(1)} °C` : '—'}
                      {p.at_bound && <span title="no limite da tolerância"> ⚠</span>}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">
                      {fmtNum(p.area_s)} ± {fmtNum(p.u_area_s)}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">{p.pct_of_total.toFixed(1)} %</td>
                    <td className="py-1 pr-3 tabular-nums">
                      {fmtNum(p.fwhm_s)}
                      {result.spec.mode === 'template' && p.stretch != null ? (
                        <span className="block text-[10px] text-[var(--color-text-dim)]">dilatação × {p.stretch.toFixed(3)}</span>
                      ) : (
                        result.spec.shape === 'bigaussian' && (
                          <span className="block text-[10px] text-[var(--color-text-dim)]">
                            σ esq. {p.sigma_l_s.toFixed(1)} · dir. {p.sigma_r_s.toFixed(1)}
                          </span>
                        )
                      )}
                    </td>
                    {result.spec.mode === 'template' && (
                      <td className="py-1 pr-3 tabular-nums" title="largura à meia altura">
                        {p.pure_fwhm_c != null && p.fwhm_c != null ? `${p.pure_fwhm_c.toFixed(1)} → ${p.fwhm_c.toFixed(1)}` : '—'}
                      </td>
                    )}
                    <td className="py-1 pr-3 tabular-nums">
                      {p.delta_width_pct !== null ? `${p.delta_width_pct >= 0 ? '+' : ''}${p.delta_width_pct.toFixed(0)} %` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shapeSeries.length > 0 && (
            <div>
              <span className="text-xs text-[var(--color-text-muted)]">
                Forma: molde do puro (pontilhado) × componente na mistura (cheio), cada um dividido pela própria altura e
                centrado no próprio máximo — sem o deslocamento e sem a área, sobra só a mudança de forma. Os dois lados
                alargando por igual = a dilatação uniforme do modelo vale; só um lado = a mistura mudou a forma.
              </span>
              <PostRunLinesPlot
                series={shapeSeries}
                xLabel="temperatura em relação ao máximo (°C)"
                yLabel="sinal ÷ altura"
                height={240}
                vLines={[{ x: 0, label: 'máximo' }]}
                legend={result.peaks.map((pk, i) => ({ label: pk.name, color: PEAK_COLORS[i % PEAK_COLORS.length] }))}
              />
            </div>
          )}
          {residuals.length > 0 && (
            <div>
              <span className="text-xs text-[var(--color-text-muted)]">Resíduo (sinal − ajuste) ao longo da janela — sem padrão = bom ajuste</span>
              <PostRunScatterPlot points={residuals} xLabel="tempo (s)" yLabel="resíduo" hLine={0} height={170} xFromData asLine />
            </div>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <span>
          Referências dos materiais puros: {references.filter((r) => r.channel === channel).length} neste canal.
        </span>
        {onOpenReferences && (
          <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={onOpenReferences}>
            fazer tudo passo a passo na aba Deconvolução →
          </button>
        )}
      </div>
    </div>
  )
}
