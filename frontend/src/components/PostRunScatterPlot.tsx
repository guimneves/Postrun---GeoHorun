import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { fmtNum } from '../lib/postrunFormat'
import { ExportFigure } from '../ui/ExportFigure'

// Gráfico de pontos + linha ajustada (curvas de calibração do PostRun).
// SVG desenhado à mão, mesmo estilo de PostRunCurveViewer (sem lib de
// gráficos): largura escala com o container, texto acompanha.
//
// Interativo (pedido do usuário, 16/10/2026): passar o mouse mostra o ponto;
// com `onPointClick`, clicar tira/devolve o ponto do ajuste (vazado = fora);
// com `onBoxSelect`, arrastar um retângulo tira os pontos de dentro (com
// Shift, devolve).
const WIDTH = 560
const PAD = { left: 64, right: 14, top: 12, bottom: 40 }

export interface PlotPoint {
  x: number
  y: number
  /** ponto fora do ajuste (vazado) */
  hollow?: boolean
  title?: string
  /** cor própria (séries diferentes no mesmo gráfico) */
  color?: string
  /** barra de erro vertical (± valor) */
  yErr?: number
  /** identificador devolvido nos cliques/seleções (ex.: índice do ponto da curva) */
  id?: number
  /** linhas da caixa que aparece ao passar o mouse */
  tip?: string[]
}

interface Props {
  points: PlotPoint[]
  xLabel: string
  yLabel: string
  /** linha ajustada y = f(x), desenhada de x=0 até a maior massa */
  line?: (x: number) => number
  /** faixa horizontal (ex.: média ± desvio do fator de resposta) */
  band?: { y0: number; y1: number }
  /** várias faixas horizontais coloridas (ex.: dilatação natural de cada material) */
  hBands?: { y0: number; y1: number; color: string }[]
  hLine?: number
  vLines?: { x: number; label: string }[]
  height?: number
  /** eixo Y começa em zero */
  yFromZero?: boolean
  /** eixo X da menor à maior x (senão, de zero) — ex.: temperatura */
  xFromData?: boolean
  /** só linhas ligando os pontos, sem marcadores (ex.: resíduos de uma curva) */
  asLine?: boolean
  legend?: { label: string; color: string }[]
  /** traço da linha ajustada (ex.: "6 4" = pontilhada) */
  lineDash?: string
  onPointClick?: (id: number) => void
  /** retângulo arrastado: ids dos pontos dentro; `include` = Shift apertado */
  onBoxSelect?: (ids: number[], include: boolean) => void
}

function ticks(lo: number, hi: number, count = 5): number[] {
  const span = hi - lo || Math.abs(hi) || 1
  const step0 = span / count
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)))
  return out
}

export function PostRunScatterPlot({
  points, xLabel, yLabel, line, band, hBands = [], hLine, vLines = [], height = 300, yFromZero, xFromData, asLine, legend,
  lineDash, onPointClick, onBoxSelect,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number; include: boolean } | null>(null)
  const plotW = WIDTH - PAD.left - PAD.right
  const plotH = height - PAD.top - PAD.bottom
  const { xMin, xMax, yMin, yMax, linePath } = useMemo(() => {
    const xs = points.map((p) => p.x)
    const span0 = xs.length ? Math.max(...xs) - Math.min(...xs) : 0
    const xMin = xFromData && xs.length ? Math.min(...xs) - span0 * 0.04 : 0
    const xMax = xFromData && xs.length ? Math.max(...xs) + span0 * 0.04 || Math.max(...xs) + 1 : Math.max(...xs, ...vLines.map((v) => v.x), 0) * 1.08 || 1
    const samples = line ? Array.from({ length: 61 }, (_, i) => (xMax * i) / 60) : []
    const lineYs = samples.map((x) => line!(x))
    const ys = [...points.flatMap((p) => (p.yErr ? [p.y - p.yErr, p.y + p.yErr] : [p.y])), ...lineYs, ...(band ? [band.y0, band.y1] : []), ...hBands.flatMap((b) => [b.y0, b.y1]), ...(hLine !== undefined ? [hLine] : [])]
    let yMin = Math.min(...ys)
    let yMax = Math.max(...ys)
    if (yFromZero) yMin = Math.min(0, yMin)
    if (yMax === yMin) {
      yMax += Math.abs(yMax) * 0.1 || 1
      yMin -= Math.abs(yMin) * 0.1 || 1
    }
    const pad = (yMax - yMin) * 0.06
    yMax += pad
    if (!yFromZero || yMin < 0) yMin -= pad
    const sx = (x: number) => PAD.left + ((x - xMin) / (xMax - xMin || 1)) * plotW
    const sy = (y: number) => PAD.top + plotH - ((y - yMin) / (yMax - yMin)) * plotH
    const linePath = samples.length
      ? samples.map((x, i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(lineYs[i]).toFixed(1)}`).join(' ')
      : ''
    return { xMin, xMax, yMin, yMax, linePath }
  }, [points, line, band, hBands, hLine, vLines, yFromZero, xFromData, plotW, plotH])

  const sx = (x: number) => PAD.left + ((x - xMin) / (xMax - xMin || 1)) * plotW
  const sy = (y: number) => PAD.top + plotH - ((y - yMin) / (yMax - yMin)) * plotH
  const xt = ticks(xMin, xMax)
  const yt = ticks(yMin, yMax)

  function toView(e: ReactPointerEvent<SVGSVGElement>): { x: number; y: number } {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * WIDTH, y: ((e.clientY - r.top) / r.height) * height }
  }

  function onDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (!onBoxSelect || e.button !== 0) return
    const v = toView(e)
    try {
      svgRef.current?.setPointerCapture(e.pointerId)
    } catch {
      // segue sem captura
    }
    setBox({ x0: v.x, y0: v.y, x1: v.x, y1: v.y, include: e.shiftKey })
  }

  function onMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!box) return
    const v = toView(e)
    setBox({ ...box, x1: v.x, y1: v.y })
  }

  function onUp() {
    if (!box || !onBoxSelect) return
    const [xa, xb] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)]
    const [ya, yb] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)]
    setBox(null)
    if (xb - xa < 4 && yb - ya < 4) return // foi um clique, não um retângulo
    const ids = points
      .filter((p) => p.id !== undefined && sx(p.x) >= xa && sx(p.x) <= xb && sy(p.y) >= ya && sy(p.y) <= yb)
      .map((p) => p.id as number)
    if (ids.length) onBoxSelect(ids, box.include)
  }

  const hp = hover !== null ? points[hover] : null
  const tipLines = hp ? (hp.tip ?? (hp.title ? [hp.title] : [`${fmtNum(hp.x)} · ${fmtNum(hp.y)}`])) : []
  const tipW = Math.max(...tipLines.map((l) => l.length), 10) * 5.6 + 12
  const tipH = tipLines.length * 13 + 8
  const tipX = hp ? (sx(hp.x) + 10 + tipW > WIDTH ? sx(hp.x) - 10 - tipW : sx(hp.x) + 10) : 0
  const tipY = hp ? Math.min(Math.max(sy(hp.y) - tipH / 2, 2), height - tipH - 2) : 0

  return (
    <ExportFigure name={`${yLabel} x ${xLabel}`}>
    <svg
      ref={svgRef}
      viewBox={`0 0 ${WIDTH} ${height}`}
      className={`mx-auto block w-full ${onBoxSelect ? 'touch-none select-none' : ''}`}
      // numa tela larga o SVG (w-full) crescia sem fim — largura máxima, mantendo a
      // proporção (o mouse continua batendo com os pontos) (22/10/2026)
      style={{ maxWidth: WIDTH * 1.25, ...(onBoxSelect ? { cursor: 'crosshair' } : {}) }}
      role="img"
      aria-label={`${yLabel} × ${xLabel}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => setHover(null)}
    >
      {yt.map((v) => (
        <g key={`y${v}`}>
          <line x1={PAD.left} x2={WIDTH - PAD.right} y1={sy(v)} y2={sy(v)} stroke="var(--color-border)" strokeWidth={0.6} />
          <text x={PAD.left - 6} y={sy(v) + 3} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">
            {fmtNum(v)}
          </text>
        </g>
      ))}
      {xt.map((v) => (
        <text key={`x${v}`} x={sx(v)} y={PAD.top + plotH + 14} textAnchor="middle" fontSize={10} fill="var(--color-text-muted)">
          {fmtNum(v)}
        </text>
      ))}
      <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--color-text-muted)" strokeWidth={0.8} />
      <line
        x1={PAD.left}
        x2={WIDTH - PAD.right}
        y1={PAD.top + plotH}
        y2={PAD.top + plotH}
        stroke="var(--color-text-muted)"
        strokeWidth={0.8}
      />
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
      {band && (
        <rect
          x={PAD.left}
          width={plotW}
          y={sy(Math.max(band.y0, band.y1))}
          height={Math.abs(sy(band.y0) - sy(band.y1))}
          fill="var(--color-primary)"
          opacity={0.1}
        />
      )}
      {hBands.map((b, i) => (
        <rect
          key={i}
          x={PAD.left}
          width={plotW}
          y={sy(Math.max(b.y0, b.y1))}
          height={Math.abs(sy(b.y0) - sy(b.y1))}
          fill={b.color}
          opacity={0.13}
        />
      ))}
      {hLine !== undefined && (
        <line x1={PAD.left} x2={WIDTH - PAD.right} y1={sy(hLine)} y2={sy(hLine)} stroke="var(--color-primary)" strokeDasharray="5 4" />
      )}
      {vLines.map((v) => (
        <g key={v.label}>
          <line x1={sx(v.x)} x2={sx(v.x)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--color-text-muted)" strokeDasharray="3 3" />
          <text x={sx(v.x) + 3} y={PAD.top + 10} fontSize={9} fill="var(--color-text-muted)">
            {v.label}
          </text>
        </g>
      ))}
      {linePath && <path d={linePath} fill="none" stroke="var(--color-primary)" strokeWidth={1.8} strokeDasharray={lineDash} />}
      {asLine && points.length > 1 && (
        <polyline
          points={points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ')}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth={1.2}
        />
      )}
      {!asLine &&
        points.map((p, i) =>
          p.yErr ? (
            <line
              key={`e${i}`}
              x1={sx(p.x)}
              x2={sx(p.x)}
              y1={sy(p.y - p.yErr)}
              y2={sy(p.y + p.yErr)}
              stroke={p.color ?? 'var(--color-primary)'}
              strokeWidth={1.2}
            />
          ) : null,
        )}
      {legend && (
        <g>
          {legend.map((l, i) => (
            <g key={l.label} transform={`translate(${PAD.left + 8 + i * 90}, ${PAD.top + 8})`}>
              <circle r={4} fill={l.color} />
              <text x={8} y={3} fontSize={10} fill="var(--color-text-muted)">
                {l.label}
              </text>
            </g>
          ))}
        </g>
      )}
      {!asLine && points.map((p, i) => (
        <g
          key={i}
          onPointerEnter={() => setHover(i)}
          onPointerLeave={() => setHover((h) => (h === i ? null : h))}
          onPointerDown={(e) => onPointClick && e.stopPropagation()}
          onClick={() => p.id !== undefined && onPointClick?.(p.id)}
          style={onPointClick ? { cursor: 'pointer' } : undefined}
        >
          {/* área de clique maior que o marcador */}
          <circle cx={sx(p.x)} cy={sy(p.y)} r={9} fill="transparent" />
          <circle
            cx={sx(p.x)}
            cy={sy(p.y)}
            r={hover === i ? 5.5 : 4}
            fill={p.hollow ? 'var(--color-bg-elevated)' : (p.color ?? 'var(--color-primary)')}
            stroke={p.color ?? 'var(--color-primary)'}
            strokeWidth={1.5}
            opacity={p.hollow ? 0.75 : 0.9}
          />
        </g>
      ))}
      {box && (
        <rect
          x={Math.min(box.x0, box.x1)}
          y={Math.min(box.y0, box.y1)}
          width={Math.abs(box.x1 - box.x0)}
          height={Math.abs(box.y1 - box.y0)}
          fill={box.include ? '#1baf7a' : 'var(--color-danger, #c0392b)'}
          fillOpacity={0.1}
          stroke={box.include ? '#1baf7a' : 'var(--color-danger, #c0392b)'}
          strokeDasharray="4 3"
          pointerEvents="none"
        />
      )}
      {hp && (
        <g pointerEvents="none">
          <rect x={tipX} y={tipY} width={tipW} height={tipH} rx={4} fill="var(--color-bg-elevated)" stroke="var(--color-border)" />
          {tipLines.map((l, k) => (
            <text key={k} x={tipX + 6} y={tipY + 15 + k * 13} fontSize={10} fill="var(--color-text)">
              {l}
            </text>
          ))}
        </g>
      )}
    </svg>
    </ExportFigure>
  )
}
