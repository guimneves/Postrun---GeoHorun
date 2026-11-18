import { useMemo, useState } from 'react'
import type { AnalysisDetail, AnalysisSummary } from '../api/postrun'
import { PostRunLinesPlot, type LineSeries } from './PostRunLinesPlot'

/** Multi (pedido do usuário, 12/11/2026): todos os sinais (FID, CO, CO₂,
 * SO₂) da pirólise OU da oxidação no mesmo gráfico, cada sinal com a sua
 * cor fixa — azul FID, verde CO, vermelho CO₂, amarelo enxofre. Por padrão
 * a análise ativa; dá para ver todas as abertas (réplicas com traços
 * diferentes). Sem integração. */

export const SIGNAL_COLORS: Record<string, string> = {
  FID: '#2a78d6',
  CO: '#1baf7a',
  CO2: '#e34948',
  SO2: '#d9a400',
}
const SIGNAL_ORDER = ['FID', 'CO', 'CO2', 'SO2']
const DASHES = [undefined, '6 3', '2 3', '8 3 2 3', '1 2']
const MAX_POINTS = 1200

const selectClass =
  'rounded-lg border px-2 py-1 text-xs border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)]'

const stem = (f: string) => f.replace(/\.[A-Za-z]00$/i, '')

export function PostRunMultiPlot({
  activeToken,
  tokens,
  details,
  analysesByToken,
  curve,
  channelLabels,
}: {
  activeToken: string
  tokens: string[]
  details: Record<string, AnalysisDetail>
  analysesByToken: Record<string, AnalysisSummary>
  curve: 'pyro' | 'oxi'
  channelLabels: Record<string, string>
}) {
  const [which, setWhich] = useState<'active' | 'all'>('active')
  const [xMode, setXMode] = useState<'temp' | 'time'>('time')
  // os sinais têm escalas muito diferentes (FID ≫ SO₂): pela altura por padrão
  const [norm, setNorm] = useState<'none' | 'height'>('height')
  const [baseline, setBaseline] = useState(true)
  const [showLegend, setShowLegend] = useState(true)
  const [showRamp, setShowRamp] = useState(false)
  const [off, setOff] = useState<Set<string>>(new Set())

  const shown = (which === 'active' ? [activeToken] : tokens).filter((t) => details[t]?.[curve])
  const signals = useMemo(() => {
    const present = new Set<string>()
    for (const t of shown) {
      const ch = details[t][curve]!.channels
      for (const k of SIGNAL_ORDER) if (ch[k]?.some((v) => v !== 0)) present.add(k)
    }
    return SIGNAL_ORDER.filter((k) => present.has(k))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.join('|'), details, curve])

  const nameOf = (t: string) => {
    const a = analysesByToken[t]
    return `${details[t].sample || a?.sample || ''} · ${stem(a?.filename ?? t.split('/').pop() ?? t).split('_').pop()}`
  }

  const series = useMemo<LineSeries[]>(() => {
    const out: LineSeries[] = []
    shown.forEach((t, ti) => {
      const d = details[t]
      const c = d[curve]!
      for (const k of signals) {
        if (off.has(k)) continue
        const raw = c.channels[k]
        if (!raw?.length) continue
        const step = Math.max(1, Math.ceil(raw.length / MAX_POINTS))
        const lb = baseline ? (d.baseline[`${curve}:${k}`] ?? Math.min(...raw.slice(0, 20))) : 0
        let ys: number[] = []
        const xs: number[] = []
        for (let i = 0; i < raw.length; i += step) {
          ys.push(raw[i] - lb)
          xs.push(xMode === 'temp' ? c.temp[i] : c.idx[i] * (d.seconds_per_point || 1))
        }
        if (norm === 'height') {
          const top = Math.max(...ys) || 1
          ys = ys.map((v) => v / top)
        }
        out.push({
          key: `${t}|${k}`, x: xs, y: ys, color: SIGNAL_COLORS[k], dash: DASHES[ti % DASHES.length], width: 1.5,
          label: shown.length > 1 ? `${channelLabels[k] ?? k} · ${nameOf(t)}` : (channelLabels[k] ?? k),
        })
      }
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.join('|'), details, curve, signals, off, xMode, norm, baseline])

  const ramp = useMemo(() => {
    if (!showRamp || xMode !== 'time' || !shown.length) return undefined
    const d = details[shown[0]]
    const c = d[curve]!
    const step = Math.max(1, Math.ceil(c.temp.length / MAX_POINTS))
    const x: number[] = []
    const y: number[] = []
    for (let i = 0; i < c.temp.length; i += step) {
      x.push(c.idx[i] * (d.seconds_per_point || 1))
      y.push(c.temp[i])
    }
    return { x, y, label: 'temperatura (°C)', color: 'var(--color-text-muted)' }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRamp, xMode, shown.join('|'), details, curve])

  const legend = showLegend
    ? [
        ...signals.filter((k) => !off.has(k)).map((k) => ({ label: channelLabels[k] ?? k, color: SIGNAL_COLORS[k] })),
        ...(shown.length > 1
          ? shown.slice(0, 6).map((t, ti) => ({ label: nameOf(t), color: 'var(--color-text-muted)', dash: DASHES[ti % DASHES.length] }))
          : []),
      ]
    : []

  if (!shown.length) return <p className="text-sm text-[var(--color-text-muted)]">Esta análise não tem {curve === 'pyro' ? 'pirólise' : 'oxidação'}.</p>

  return (
    <div className="flex flex-col gap-3 rounded-2xl border p-4 border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-sm">{curve === 'pyro' ? 'Pirólise' : 'Oxidação'} · todos os sinais</span>
        <span className="text-[var(--color-text-muted)]">· {which === 'active' ? nameOf(activeToken) : `${shown.length} análises`}</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1">
            análises
            <select className={selectClass} value={which} onChange={(e) => setWhich(e.target.value as 'active' | 'all')}>
              <option value="active">só a ativa</option>
              <option value="all">todas as abertas ({tokens.length})</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            eixo X
            <select className={selectClass} value={xMode} onChange={(e) => setXMode(e.target.value as 'temp' | 'time')}>
              <option value="temp">temperatura (°C)</option>
              <option value="time">tempo (s)</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            escala
            <select className={selectClass} value={norm} onChange={(e) => setNorm(e.target.value as 'none' | 'height')}>
              <option value="height">pela altura (máx. = 1)</option>
              <option value="none">sinal bruto</option>
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
          <label className="flex items-center gap-1">
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

      <div className="flex flex-wrap gap-3 text-xs">
        {signals.map((k) => (
          <label key={k} className="flex items-center gap-1.5 font-medium">
            <input
              type="checkbox"
              checked={!off.has(k)}
              onChange={() =>
                setOff((prev) => {
                  const next = new Set(prev)
                  if (next.has(k)) next.delete(k)
                  else next.add(k)
                  return next
                })
              }
            />
            <span className="inline-block h-2 w-5 rounded" style={{ backgroundColor: SIGNAL_COLORS[k] }} />
            {channelLabels[k] ?? k}
          </label>
        ))}
      </div>

      <PostRunLinesPlot
        series={series}
        xLabel={xMode === 'temp' ? 'temperatura (°C)' : 'tempo (s)'}
        yLabel={norm === 'height' ? 'sinal ÷ altura' : 'sinal'}
        height={300}
        legend={legend.length ? legend : undefined}
        onHover={() => undefined}
        y2={ramp}
      />
      {norm === 'none' && (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Sinal bruto: os sinais têm escalas bem diferentes (o FID costuma ser muito maior) — use “pela altura” para comparar a forma.
        </p>
      )}
    </div>
  )
}
