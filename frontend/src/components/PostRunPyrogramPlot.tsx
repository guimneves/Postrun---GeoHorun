import { useMemo, useState } from 'react'
import type { AnalysisDetail } from '../api/postrun'
import { PostRunLinesPlot } from './PostRunLinesPlot'

/** Pirograma simples (pedido do usuário, 12/11/2026): é o que abre por
 * padrão — tempo × intensidade, sem região nem cursores. A integração virou
 * uma ferramenta à parte (botão "Integrar"). */

const RAMP_STORE = 'postrun-show-ramp'
const MAX_POINTS = 2000

export function PostRunPyrogramPlot({
  detail,
  curve,
  channel,
  title,
  color = 'var(--color-flame, #ff6a35)',
}: {
  detail: AnalysisDetail
  curve: 'pyro' | 'oxi'
  channel: string
  title: string
  color?: string
}) {
  const [showRamp, setShowRamp] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RAMP_STORE) === '1'
    } catch {
      return false
    }
  })
  function toggleRamp(on: boolean) {
    setShowRamp(on)
    try {
      localStorage.setItem(RAMP_STORE, on ? '1' : '0')
    } catch {
      // sem localStorage: só não lembra a escolha
    }
  }

  const c = detail[curve]
  const spp = detail.seconds_per_point || 1
  const { series, ramp } = useMemo(() => {
    const raw = c?.channels[channel] ?? []
    const step = Math.max(1, Math.ceil(raw.length / MAX_POINTS))
    const x: number[] = []
    const y: number[] = []
    const rx: number[] = []
    const ry: number[] = []
    for (let i = 0; i < raw.length; i += step) {
      x.push(c!.idx[i] * spp)
      y.push(raw[i])
      rx.push(c!.idx[i] * spp)
      ry.push(c!.temp[i])
    }
    return {
      series: [{ key: 'sinal', x, y, color, width: 1.5 }],
      ramp: { x: rx, y: ry, label: 'temperatura (°C)', color: 'var(--color-text-muted)' },
    }
  }, [c, channel, spp, color])

  if (!c?.channels[channel]?.length)
    return <p className="text-sm text-[var(--color-text-muted)]">Esta análise não tem {title}.</p>

  return (
    <div className="flex flex-col gap-2 rounded-2xl border p-4 border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-semibold">{title}</span>
        <label className="ml-auto flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
          <input type="checkbox" checked={showRamp} onChange={(e) => toggleRamp(e.target.checked)} />
          rampa de temperatura
        </label>
      </div>
      <PostRunLinesPlot
        series={series}
        xLabel="tempo (s)"
        yLabel="intensidade"
        height={300}
        y2={showRamp ? ramp : undefined}
      />
    </div>
  )
}
