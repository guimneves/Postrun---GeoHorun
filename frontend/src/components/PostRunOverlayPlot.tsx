import { useEffect, useMemo, useState } from 'react'
import type { AnalysisDetail, AnalysisSummary } from '../api/postrun'
import { PEAK_COLORS } from '../lib/postrunColors'
import { PostRunLinesPlot, type LineSeries } from './PostRunLinesPlot'

/** Sobreposição de pirogramas (pedido do usuário, 23/10/2026): todas as
 * análises abertas no mesmo gráfico, sem integração (nada de região nem de
 * cursores), com a cor escolhida por amostra ou por réplica. As cores
 * escolhidas ficam guardadas neste navegador. */

const STORE = 'postrun-overlay-colors'
const DASHES = [undefined, '6 3', '2 3', '8 3 2 3', '1 2']
const MAX_POINTS = 1200 // por curva, para o gráfico continuar leve com dezenas de análises

type XMode = 'temp' | 'time'
type NormMode = 'none' | 'mass' | 'height'
type ColorMode = 'sample' | 'replica'

const selectClass =
  'rounded-lg border px-2 py-1 text-xs border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)]'

function loadColors(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}')
  } catch {
    return {}
  }
}

const stem = (f: string) => f.replace(/\.[A-Za-z]00$/i, '')

/** Cor automática: a paleta dos picos e, depois dela, tons espaçados pelo
 * ângulo áureo (dezenas de réplicas sem repetir cor) — em hex, para o
 * seletor de cor. */
function autoColor(i: number): string {
  if (i < PEAK_COLORS.length) return PEAK_COLORS[i]
  const h = ((i - PEAK_COLORS.length) * 137.508 + 20) % 360
  const s = 0.62
  const l = i % 2 ? 0.42 : 0.55
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * c).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

export function PostRunOverlayPlot({
  tokens,
  details,
  analysesByToken,
  curve,
  channel,
  channelLabel,
}: {
  tokens: string[]
  details: Record<string, AnalysisDetail>
  analysesByToken: Record<string, AnalysisSummary>
  curve: 'pyro' | 'oxi'
  channel: string
  channelLabel: string
}) {
  const [xMode, setXMode] = useState<XMode>('time')
  const [norm, setNorm] = useState<NormMode>('none')
  const [baseline, setBaseline] = useState(true)
  const [colorMode, setColorMode] = useState<ColorMode>('sample')
  const [colors, setColors] = useState<Record<string, string>>(loadColors)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [hover, setHover] = useState<string | null>(null)
  const [showLegend, setShowLegend] = useState(true)
  const [showRamp, setShowRamp] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(colors))
    } catch {
      // sem localStorage: as cores só não ficam guardadas
    }
  }, [colors])

  // análises com a curva/canal pedidos, agrupadas por amostra
  const items = useMemo(() => {
    const out = tokens
      .filter((t) => details[t]?.[curve]?.channels[channel]?.length)
      .map((t) => {
        const d = details[t]
        const a = analysesByToken[t]
        return { token: t, sample: d.sample || a?.sample || '(sem nome)', name: stem(a?.filename ?? t.split('/').pop() ?? t), detail: d, summary: a }
      })
    out.sort((a, b) => a.sample.localeCompare(b.sample) || a.name.localeCompare(b.name))
    return out
  }, [tokens, details, analysesByToken, curve, channel])

  const samples = useMemo(() => [...new Set(items.map((i) => i.sample))], [items])
  const defaultColor = (key: string, index: number) => colors[key] ?? autoColor(index)
  const colorOf = (it: (typeof items)[number]) => {
    if (colorMode === 'replica') {
      const k = `r:${it.token}`
      return colors[k] ?? autoColor(items.indexOf(it))
    }
    return defaultColor(`s:${it.sample}`, samples.indexOf(it.sample))
  }
  // por amostra: as réplicas da mesma amostra mudam o traço
  const dashOf = (it: (typeof items)[number]) => {
    if (colorMode === 'replica') return undefined
    const same = items.filter((x) => x.sample === it.sample)
    return DASHES[same.indexOf(it) % DASHES.length]
  }

  const series = useMemo<LineSeries[]>(() => {
    const out: LineSeries[] = []
    for (const it of items) {
      if (hidden.has(it.token)) continue
      const c = it.detail[curve]!
      const raw = c.channels[channel]
      const step = Math.max(1, Math.ceil(raw.length / MAX_POINTS))
      const lb = baseline ? (it.detail.baseline[`${curve}:${channel}`] ?? Math.min(...raw.slice(0, 20))) : 0
      const mass = it.summary?.mass_mg || it.detail.quantity_mg || 0
      let ys: number[] = []
      let xs: number[] = []
      for (let i = 0; i < raw.length; i += step) {
        ys.push(raw[i] - lb)
        xs.push(xMode === 'temp' ? c.temp[i] : c.idx[i] * (it.detail.seconds_per_point || 1))
      }
      if (norm === 'mass') ys = mass > 0 ? ys.map((v) => v / mass) : []
      if (norm === 'height') {
        const top = Math.max(...ys) || 1
        ys = ys.map((v) => v / top)
      }
      if (!ys.length) {
        xs = []
        continue
      }
      const emph = hover === null || hover === it.token
      out.push({
        key: it.token, x: xs, y: ys, color: colorOf(it), dash: dashOf(it), width: hover === it.token ? 2.6 : 1.5,
        opacity: emph ? 1 : 0.25, label: `${it.sample} · ${it.name}`,
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, hidden, curve, channel, xMode, norm, baseline, colorMode, colors, hover])

  // legenda no gráfico: só o que está visível (as amostras/réplicas marcadas abaixo)
  const legend = !showLegend
    ? []
    : colorMode === 'sample'
      ? samples
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => items.some((it) => it.sample === s && !hidden.has(it.token)))
          .map(({ s, i }) => ({ label: s, color: defaultColor(`s:${s}`, i) }))
      : items.filter((it) => !hidden.has(it.token)).map((it) => ({ label: `${it.sample} · ${it.name.split('_').pop()}`, color: colorOf(it) }))
  // rampa de temperatura × tempo (da 1ª análise visível — o ciclo é o mesmo nas sobrepostas)
  const ramp = useMemo(() => {
    if (!showRamp || xMode !== 'time') return undefined
    const it = items.find((i) => !hidden.has(i.token))
    const c = it?.detail[curve]
    if (!it || !c) return undefined
    const step = Math.max(1, Math.ceil(c.temp.length / MAX_POINTS))
    const x: number[] = []
    const y: number[] = []
    for (let i = 0; i < c.temp.length; i += step) {
      x.push(c.idx[i] * (it.detail.seconds_per_point || 1))
      y.push(c.temp[i])
    }
    return { x, y, label: 'temperatura (°C)', color: 'var(--color-text-muted)' }
  }, [showRamp, xMode, items, hidden, curve])
  const yLabel = norm === 'mass' ? 'sinal / mg' : norm === 'height' ? 'sinal ÷ altura' : 'sinal'
  const noMass = norm === 'mass' ? items.filter((i) => !(i.summary?.mass_mg || i.detail.quantity_mg)) : []

  function setColor(key: string, value: string) {
    setColors((prev) => ({ ...prev, [key]: value }))
  }
  function toggle(tokensToToggle: string[]) {
    setHidden((prev) => {
      const next = new Set(prev)
      const allHidden = tokensToToggle.every((t) => next.has(t))
      tokensToToggle.forEach((t) => (allHidden ? next.delete(t) : next.add(t)))
      return next
    })
  }

  if (!items.length)
    return <p className="text-sm text-[var(--color-text-muted)]">Nenhuma análise aberta tem {channelLabel}.</p>

  return (
    <div className="flex flex-col gap-3 rounded-2xl border p-4 border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-sm">{channelLabel}</span>
        <span className="text-[var(--color-text-muted)]">· {items.length} análises · sem integração</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1">
            eixo X
            <select className={selectClass} value={xMode} onChange={(e) => setXMode(e.target.value as XMode)}>
              <option value="temp">temperatura (°C)</option>
              <option value="time">tempo (s)</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            escala
            <select className={selectClass} value={norm} onChange={(e) => setNorm(e.target.value as NormMode)}>
              <option value="none">sinal bruto</option>
              <option value="mass">por mg de amostra</option>
              <option value="height">pela altura (máx. = 1)</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            cor
            <select className={selectClass} value={colorMode} onChange={(e) => setColorMode(e.target.value as ColorMode)}>
              <option value="sample">por amostra</option>
              <option value="replica">por réplica</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={baseline} onChange={(e) => setBaseline(e.target.checked)} />
            descontar linha de base
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showLegend} onChange={(e) => setShowLegend(e.target.checked)} />
            legenda no gráfico
          </label>
          <label className="flex items-center gap-1" title="só com o eixo X em tempo">
            <input
              type="checkbox"
              checked={showRamp}
              onChange={(e) => {
                setShowRamp(e.target.checked)
                if (e.target.checked) setXMode('time')
              }}
            />
            rampa de temperatura
          </label>
        </span>
      </div>

      <PostRunLinesPlot
        series={series}
        xLabel={xMode === 'temp' ? 'temperatura (°C)' : 'tempo (s)'}
        yLabel={yLabel}
        height={300}
        legend={legend.length && legend.length <= 14 ? legend : undefined}
        onHover={setHover}
        y2={ramp}
      />
      {showLegend && legend.length > 14 && (
        <p className="-mt-2 text-[11px] text-[var(--color-text-muted)]">
          Legenda escondida: {legend.length} itens não cabem no gráfico — desmarque abaixo os que não precisa ver.
        </p>
      )}
      {noMass.length > 0 && (
        <p className="text-[11px] text-[var(--color-warning,#b26a00)]">Sem massa (fora da escala por mg): {noMass.map((i) => i.name).join(', ')}</p>
      )}

      {/* amostras e réplicas: mostrar/ocultar e escolher a cor */}
      <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto text-xs">
        {samples.map((s, si) => {
          const reps = items.filter((i) => i.sample === s)
          const allHidden = reps.every((r) => hidden.has(r.token))
          return (
            <div key={s} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-1.5 border-[var(--color-border)]">
              <label className="flex w-44 shrink-0 items-center gap-1.5 font-medium">
                <input type="checkbox" checked={!allHidden} onChange={() => toggle(reps.map((r) => r.token))} />
                {colorMode === 'sample' && (
                  <input
                    type="color"
                    className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
                    value={defaultColor(`s:${s}`, si)}
                    onChange={(e) => setColor(`s:${s}`, e.target.value)}
                    title={`cor da amostra ${s}`}
                  />
                )}
                <span className="truncate" title={s}>{s}</span>
              </label>
              {reps.map((r) => (
                <label
                  key={r.token}
                  className="flex items-center gap-1 text-[var(--color-text-muted)]"
                  onMouseEnter={() => setHover(r.token)}
                  onMouseLeave={() => setHover(null)}
                >
                  <input type="checkbox" checked={!hidden.has(r.token)} onChange={() => toggle([r.token])} />
                  {colorMode === 'replica' ? (
                    <input
                      type="color"
                      className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
                      value={colorOf(r)}
                      onChange={(e) => setColor(`r:${r.token}`, e.target.value)}
                      title={`cor da réplica ${r.name}`}
                    />
                  ) : (
                    <svg width="22" height="8" aria-hidden>
                      <line x1="0" x2="22" y1="4" y2="4" stroke={colorOf(r)} strokeWidth="2" strokeDasharray={dashOf(r)} />
                    </svg>
                  )}
                  <span className="font-mono">{r.name.split('_').pop()}</span>
                </label>
              ))}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-[var(--color-text-muted)]">
        <span>Por amostra: uma cor por amostra, réplicas com traços diferentes. Por réplica: uma cor para cada análise.</span>
        {Object.keys(colors).length > 0 && (
          <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => setColors({})}>
            voltar às cores automáticas
          </button>
        )}
      </div>
    </div>
  )
}
