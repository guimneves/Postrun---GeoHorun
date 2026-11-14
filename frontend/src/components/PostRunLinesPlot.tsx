import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { fmtNum } from '../lib/postrunFormat'

// Várias curvas no mesmo eixo (aba Referências do PostRun): molde, faixa
// ± desvio e as corridas puras. SVG à mão, no estilo do PostRunScatterPlot.
const WIDTH = 560
const PAD = { left: 64, right: 14, top: 12, bottom: 40 }

export interface LineSeries {
  key: string
  x: number[]
  y: number[]
  color: string
  width?: number
  dash?: string
  opacity?: number
  label?: string
}

interface Props {
  series: LineSeries[]
  /** faixa preenchida (ex.: molde ± desvio) */
  band?: { x: number[]; lo: number[]; hi: number[]; color: string }
  xLabel: string
  yLabel: string
  height?: number
  vLines?: { x: number; label: string }[]
  legend?: { label: string; color: string; dash?: string }[]
  /** ao passar o mouse: a série mais próxima (key) */
  onHover?: (key: string | null) => void
  /** segunda curva com eixo próprio à direita (ex.: rampa de temperatura × tempo) */
  y2?: { x: number[]; y: number[]; label: string; color: string }
}

export function ticks(lo: number, hi: number, count = 5): number[] {
  const span = hi - lo || Math.abs(hi) || 1
  const step0 = span / count
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)))
  return out
}

export function PostRunLinesPlot({ series, band, xLabel, yLabel, height = 300, vLines = [], legend, onHover, y2 }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  // série sob o mouse: o nome aparece DENTRO do gráfico. Antes ia num <p>
  // abaixo dele, que mudava a altura da página a cada hover — a barra de
  // rolagem aparecia/sumia, o gráfico mudava de tamanho, o mouse saía da
  // curva e o nome sumia: ficava piscando (relato do usuário, 12/11/2026).
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const lastHover = useRef<string | null>(null)
  function emitHover(key: string | null) {
    if (lastHover.current === key) return
    lastHover.current = key
    setHoverKey(key)
    onHover?.(key)
  }
  const padRight = y2 ? 52 : PAD.right
  const plotW = WIDTH - PAD.left - padRight
  const plotH = height - PAD.top - PAD.bottom
  const y2Range = useMemo(() => {
    if (!y2 || !y2.y.length) return null
    const lo = Math.min(...y2.y)
    const hi = Math.max(...y2.y)
    return { lo, hi: hi > lo ? hi : lo + 1 }
  }, [y2])
  const { xMin, xMax, yMin, yMax } = useMemo(() => {
    const xs = [...series.flatMap((s) => s.x), ...(band?.x ?? []), ...(y2?.x ?? [])]
    const ys = [...series.flatMap((s) => s.y), ...(band?.lo ?? []), ...(band?.hi ?? [])]
    if (!xs.length) return { xMin: 0, xMax: 1, yMin: 0, yMax: 1 }
    const xMin = Math.min(...xs)
    const xMax = Math.max(...xs)
    const yMin = Math.min(0, ...ys)
    const yMax = Math.max(...ys) * 1.06 || 1
    return { xMin, xMax: xMax > xMin ? xMax : xMin + 1, yMin, yMax }
  }, [series, band, y2])
  const sx = (x: number) => PAD.left + ((x - xMin) / (xMax - xMin)) * plotW
  const sy = (y: number) => PAD.top + plotH - ((y - yMin) / (yMax - yMin || 1)) * plotH
  const sy2 = (y: number) => (y2Range ? PAD.top + plotH - ((y - y2Range.lo) / (y2Range.hi - y2Range.lo)) * plotH : 0)
  const path = (x: number[], y: number[]) => x.map((v, i) => `${i ? 'L' : 'M'}${sx(v).toFixed(1)},${sy(y[i]).toFixed(1)}`).join(' ')

  function onMove(e: ReactPointerEvent<SVGSVGElement>) {
    const r = svgRef.current!.getBoundingClientRect()
    const vx = ((e.clientX - r.left) / r.width) * WIDTH
    const vy = ((e.clientY - r.top) / r.height) * height
    if (vx < PAD.left || vx > WIDTH - padRight) {
      setCursor(null)
      emitHover(null)
      return
    }
    const x = xMin + ((vx - PAD.left) / plotW) * (xMax - xMin)
    setCursor(x)
    if (!onHover) return
    // série mais perto do mouse na vertical
    let best: string | null = null
    let bestD = 14
    for (const s of series) {
      if (!s.x.length) continue
      let i = 0
      while (i < s.x.length - 1 && s.x[i] < x) i++
      const d = Math.abs(sy(s.y[i]) - vy)
      if (d < bestD) {
        bestD = d
        best = s.key
      }
    }
    emitHover(best)
  }

  const hovered = hoverKey ? series.find((s) => s.key === hoverKey) : undefined
  // valor da rampa sob o cursor (para a régua)
  const y2At = (x: number) => {
    if (!y2 || !y2.x.length) return null
    let i = 0
    while (i < y2.x.length - 1 && y2.x[i] < x) i++
    return y2.y[i]
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${WIDTH} ${height}`}
      className="mx-auto block w-full"
      style={{ maxWidth: WIDTH * 1.25 }}
      role="img"
      aria-label={`${yLabel} × ${xLabel}`}
      onPointerMove={onMove}
      onPointerLeave={() => {
        setCursor(null)
        emitHover(null)
      }}
    >
      {ticks(yMin, yMax).map((v) => (
        <g key={`y${v}`}>
          <line x1={PAD.left} x2={WIDTH - padRight} y1={sy(v)} y2={sy(v)} stroke="var(--color-border)" strokeWidth={0.6} />
          <text x={PAD.left - 6} y={sy(v) + 3} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">
            {fmtNum(v)}
          </text>
        </g>
      ))}
      {ticks(xMin, xMax).map((v) => (
        <text key={`x${v}`} x={sx(v)} y={PAD.top + plotH + 14} textAnchor="middle" fontSize={10} fill="var(--color-text-muted)">
          {fmtNum(v)}
        </text>
      ))}
      <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--color-text-muted)" strokeWidth={0.8} />
      <line x1={PAD.left} x2={WIDTH - padRight} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="var(--color-text-muted)" strokeWidth={0.8} />
      <text x={PAD.left + plotW / 2} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--color-text-muted)">
        {xLabel}
      </text>
      <text
        x={12}
        y={PAD.top + plotH / 2}
        textAnchor="middle"
        fontSize={11}
        fill="var(--color-text-muted)"
        transform={`rotate(-90 12 ${PAD.top + plotH / 2})`}
      >
        {yLabel}
      </text>
      {band && band.x.length > 1 && (
        <path
          d={`${path(band.x, band.hi)} ${band.x
            .slice()
            .reverse()
            .map((v, i) => `L${sx(v).toFixed(1)},${sy(band.lo[band.x.length - 1 - i]).toFixed(1)}`)
            .join(' ')} Z`}
          fill={band.color}
          opacity={0.18}
          stroke="none"
        />
      )}
      {vLines.map((v) => (
        <g key={v.label}>
          <line x1={sx(v.x)} x2={sx(v.x)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--color-text-muted)" strokeDasharray="3 3" />
          <text x={sx(v.x) + 3} y={PAD.top + plotH - 18} fontSize={9} fill="var(--color-text-muted)">
            {v.label}
          </text>
        </g>
      ))}
      {series.map((s) =>
        s.x.length > 1 ? (
          <path
            key={s.key}
            d={path(s.x, s.y)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.width ?? 1.2}
            strokeDasharray={s.dash}
            opacity={s.opacity ?? 1}
          />
        ) : null,
      )}
      {y2 && y2Range && y2.x.length > 1 && (
        <g pointerEvents="none">
          <line x1={WIDTH - padRight} x2={WIDTH - padRight} y1={PAD.top} y2={PAD.top + plotH} stroke={y2.color} strokeWidth={0.8} />
          {ticks(y2Range.lo, y2Range.hi).map((v) => (
            <text key={`y2${v}`} x={WIDTH - padRight + 5} y={sy2(v) + 3} fontSize={10} fill={y2.color}>
              {fmtNum(v)}
            </text>
          ))}
          <text
            x={WIDTH - 8}
            y={PAD.top + plotH / 2}
            textAnchor="middle"
            fontSize={11}
            fill={y2.color}
            transform={`rotate(90 ${WIDTH - 8} ${PAD.top + plotH / 2})`}
          >
            {y2.label}
          </text>
          <path
            d={y2.x.map((v, i) => `${i ? 'L' : 'M'}${sx(v).toFixed(1)},${sy2(y2.y[i]).toFixed(1)}`).join(' ')}
            fill="none"
            stroke={y2.color}
            strokeWidth={1.2}
            strokeDasharray="5 3"
          />
        </g>
      )}
      {cursor !== null && (
        <g pointerEvents="none">
          <line x1={sx(cursor)} x2={sx(cursor)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--color-text-dim, #999)" strokeWidth={0.6} />
          <text x={sx(cursor) + 4} y={PAD.top + plotH - 4} fontSize={9} fill="var(--color-text-muted)">
            {fmtNum(cursor)}
            {y2 && y2At(cursor) !== null ? ` · ${fmtNum(y2At(cursor)!)} °C` : ''}
          </text>
        </g>
      )}
      {hovered?.label && (
        <text x={PAD.left + 6} y={PAD.top + 11} fontSize={11} fontWeight={600} fill={hovered.color} pointerEvents="none">
          {hovered.label}
        </text>
      )}
      {legend && (
        <g>
          {legend.map((l, i) => (
            <g key={l.label} transform={`translate(${WIDTH - padRight - 110}, ${PAD.top + 8 + i * 14})`}>
              <line x1={-6} x2={6} y1={0} y2={0} stroke={l.color} strokeWidth={2.4} strokeDasharray={l.dash} />
              <text x={10} y={3} fontSize={10} fill="var(--color-text-muted)">
                {l.label}
              </text>
            </g>
          ))}
        </g>
      )}
    </svg>
  )
}
