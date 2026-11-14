import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { BaselineMode } from '../api/postrun'
import { computeArea } from '../lib/postrunArea'
import { fmtNum } from '../lib/postrunFormat'
import { ticks } from './PostRunLinesPlot'

const RAMP_STORE = 'postrun-show-ramp'

// Pedido do usuário: a visualização estava pequena demais. O SVG já
// escala a largura pro container via `w-full` (a página reserva mais
// espaço pro visualizador, ver o grid em PostRunPage.tsx) — o que faltava
// era altura: como o navegador preserva a proporção W:H do viewBox,
// manter WIDTH fixo e só aumentar HEIGHT deixa o gráfico bem mais alto
// sem encolher texto/marcadores (que escalam com largura/WIDTH, não com
// HEIGHT).
const WIDTH = 860
const HEIGHT = 360 // era 460: ocupava a tela toda (22/10/2026)
const PAD = { left: 64, right: 52, top: 16, bottom: 36 } // direita: eixo da rampa de temperatura
const PLOT_W = WIDTH - PAD.left - PAD.right
const PLOT_H = HEIGHT - PAD.top - PAD.bottom

interface Props {
  idx: number[]
  temp: number[]
  values: number[]
  channelLabel: string
  startIdx: number
  endIdx: number
  baselineMode: BaselineMode
  fixedBaseline: number
  /** Cursores que o próprio GeoWorks gravou nessa corrida (auto/manu) —
   * só uma referência visual, tracejada, não é editável nem vira região
   * automaticamente (pedido do usuário: PostRun não assume o que cada
   * ponto do GeoWorks significa, o usuário desenha a própria região). */
  referenceMarks?: number[]
  /** Deconvolução: curvas por cima do sinal (mesma escala), alinhadas por idx. */
  overlays?: { idx: number[]; values: number[]; color: string; width?: number; dash?: string; label?: string }[]
  /** segundos por ponto de varredura — eixo X em tempo (s) */
  secondsPerPoint?: number
  onChange: (startIdx: number, endIdx: number) => void
  onCommit: (startIdx: number, endIdx: number) => void
}

/** Curva de sinal bruto (FID/CO/CO2/SO2) com uma região arrastável — aba
 * PostRun (pedido do usuário). SVG desenhado à mão, mesmo estilo de
 * `CycleChart.tsx` (sem lib de charting), estendido com pointer events
 * pros dois marcadores de região. Eixo X = índice de varredura do `.B00`
 * (mesma referência usada pelos cursores do GeoWorks — o arquivo não grava
 * um eixo de tempo real); a temperatura de cada ponto aparece na régua
 * inferior como referência. */
export function PostRunCurveViewer({
  idx, temp, values, channelLabel,
  startIdx, endIdx, baselineMode, fixedBaseline,
  referenceMarks = [],
  overlays = [],
  secondsPerPoint = 1,
  onChange, onCommit,
}: Props) {
  const n = idx.length
  const svgRef = useRef<SVGSVGElement>(null)
  // pedido do usuário (12/11/2026): ver cada amostra em tempo × sinal, com a
  // opção de pôr a rampa de temperatura × tempo no mesmo gráfico (eixo à direita)
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
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null)
  // Posição "ao vivo" do arraste, sempre síncrona (mutação direta, fora do
  // ciclo de render do React) — handleMove atualiza a cada movimento, e
  // handleUp lê daqui, não das props `startIdx`/`endIdx`. Ler das props em
  // handleUp arriscaria pegar um valor desatualizado: pointermove tem
  // prioridade "contínua" no React e pode não ter sido processado ainda
  // quando pointerup chega logo em seguida (visto na prática: um arraste
  // rápido seguido de soltar salvava a região com a posição de ANTES do
  // arraste). O ref garante que o valor commitado é sempre o último real.
  const dragPosRef = useRef<{ start: number; end: number } | null>(null)

  const { minV, maxV } = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const v of values) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (!Number.isFinite(lo)) return { minV: 0, maxV: 1 }
    return { minV: lo, maxV: hi }
  }, [values])
  const vSpan = maxV - minV || 1

  const x = (pos: number) => PAD.left + (pos / Math.max(1, n - 1)) * PLOT_W
  const y = (v: number) => PAD.top + (1 - (v - minV) / vSpan) * PLOT_H
  // eixo de tempo: idx × segundos por ponto (varredura em passo constante)
  const tMin = n ? idx[0] * secondsPerPoint : 0
  const tMax = n > 1 && idx[n - 1] > idx[0] ? idx[n - 1] * secondsPerPoint : tMin + Math.max(1, n - 1) * secondsPerPoint
  const xT = (t: number) => PAD.left + ((t - tMin) / (tMax - tMin || 1)) * PLOT_W
  const { tLo, tHi } = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const v of temp) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    return Number.isFinite(lo) ? { tLo: lo, tHi: hi > lo ? hi : lo + 1 } : { tLo: 0, tHi: 1 }
  }, [temp])
  const yTemp = (v: number) => PAD.top + (1 - (v - tLo) / (tHi - tLo)) * PLOT_H

  function posFromClientX(clientX: number): number {
    const svg = svgRef.current
    if (!svg || n === 0) return 0
    const rect = svg.getBoundingClientRect()
    const px = ((clientX - rect.left) / rect.width) * WIDTH
    const frac = (px - PAD.left) / PLOT_W
    return Math.round(Math.min(1, Math.max(0, frac)) * (n - 1))
  }

  function startDrag(which: 'start' | 'end') {
    return (e: ReactPointerEvent<SVGGElement>) => {
      e.stopPropagation()
      // setPointerCapture pode falhar (ex. pointerId sem sessão ativa de
      // verdade) — nunca deve impedir o arraste de começar, só é uma
      // melhoria pra continuar recebendo pointermove fora do SVG.
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // ignora — o drag continua funcionando via os listeners no <svg>
      }
      dragPosRef.current = { start: startIdx, end: endIdx }
      setDragging(which)
    }
  }

  function handleMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!dragging || n === 0 || !dragPosRef.current) return
    const pos = posFromClientX(e.clientX)
    const value = idx[pos]
    if (dragging === 'start') dragPosRef.current.start = value
    else dragPosRef.current.end = value
    onChange(dragPosRef.current.start, dragPosRef.current.end)
  }

  function handleUp() {
    if (!dragging || !dragPosRef.current) return
    const { start, end } = dragPosRef.current
    setDragging(null)
    dragPosRef.current = null
    onCommit(start, end)
  }

  const areaResult = useMemo(
    () => computeArea(idx, values, startIdx, endIdx, baselineMode, fixedBaseline),
    [idx, values, startIdx, endIdx, baselineMode, fixedBaseline],
  )

  const startPos = idx.indexOf(startIdx)
  const endPos = idx.indexOf(endIdx)
  const lo = Math.max(0, Math.min(startPos, endPos))
  const hi = Math.max(startPos, endPos)

  const linePoints = values.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const shadedPoints =
    startPos >= 0 && endPos >= 0
      ? [`${x(lo)},${y(minV)}`, ...values.slice(lo, hi + 1).map((v, k) => `${x(lo + k)},${y(v)}`), `${x(hi)},${y(minV)}`].join(' ')
      : ''

  const rampPoints = showRamp ? temp.map((v, i) => `${x(i)},${yTemp(v)}`).join(' ') : ''
  const tempAt = (pos: number) => (pos >= 0 && pos < temp.length ? temp[pos].toFixed(0) : '—')

  return (
    <div className="rounded-2xl border p-4 border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-semibold">{channelLabel}</span>
        <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
          <input type="checkbox" checked={showRamp} onChange={(e) => toggleRamp(e.target.checked)} />
          rampa de temperatura
        </label>
        <span className="font-mono text-xs text-[var(--color-text-muted)]">
          {areaResult
            ? `área ${areaResult.area.toFixed(2)} · pico ${areaResult.peakValue.toFixed(2)} @ idx ${areaResult.peakIdx} (${tempAt(areaResult.peakIdx)}°C)`
            : 'região sem pontos suficientes'}
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full touch-none select-none text-[var(--color-text-muted)]"
        onPointerMove={handleMove}
        onPointerUp={handleUp}
      >
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="var(--color-border)" />
        <line
          x1={PAD.left} x2={WIDTH - PAD.right}
          y1={HEIGHT - PAD.bottom} y2={HEIGHT - PAD.bottom}
          stroke="var(--color-border)"
        />
        <text x={4} y={PAD.top - 4} fontSize={10} fill="currentColor">
          sinal
        </text>
        {ticks(minV, maxV).map((v) => (
          <g key={`ys${v}`}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--color-border)" strokeWidth={0.5} opacity={0.6} />
            <text x={PAD.left - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="currentColor">
              {fmtNum(v)}
            </text>
          </g>
        ))}
        {ticks(tMin, tMax, 8).map((t) => (
          <text key={`xt${t}`} x={xT(t)} y={HEIGHT - PAD.bottom + 14} textAnchor="middle" fontSize={10} fill="currentColor">
            {fmtNum(t)}
          </text>
        ))}
        <text x={PAD.left + PLOT_W / 2} y={HEIGHT - 4} textAnchor="middle" fontSize={10} fill="currentColor">
          tempo (s)
        </text>
        {showRamp && (
          <g pointerEvents="none" fill="var(--color-text-muted)">
            <line x1={WIDTH - PAD.right} x2={WIDTH - PAD.right} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="var(--color-text-muted)" strokeWidth={0.8} />
            {ticks(tLo, tHi).map((v) => (
              <text key={`yt${v}`} x={WIDTH - PAD.right + 5} y={yTemp(v) + 3} fontSize={10}>
                {fmtNum(v)}
              </text>
            ))}
            <text x={WIDTH - 6} y={PAD.top + PLOT_H / 2} textAnchor="middle" fontSize={10} transform={`rotate(90 ${WIDTH - 6} ${PAD.top + PLOT_H / 2})`}>
              temperatura (°C)
            </text>
            <polyline points={rampPoints} fill="none" stroke="var(--color-text-muted)" strokeWidth={1.2} strokeDasharray="5 3" />
          </g>
        )}

        {shadedPoints && <polygon points={shadedPoints} fill="#7c8cff" opacity={0.22} />}

        {referenceMarks.map((pos, i) => {
          const p = idx.indexOf(pos)
          if (p < 0) return null
          return (
            <line
              key={`ref-${i}`}
              x1={x(p)} x2={x(p)}
              y1={PAD.top} y2={HEIGHT - PAD.bottom}
              stroke="currentColor"
              strokeDasharray="2 3"
              opacity={0.4}
            />
          )
        })}

        <polyline points={linePoints} fill="none" stroke="var(--color-flame, #ff6a35)" strokeWidth={1.4} />

        {overlays.map((o, k) => {
          const pos = new Map(idx.map((v, i) => [v, i]))
          const pts = o.idx
            .map((v, i) => (pos.has(v) ? `${x(pos.get(v)!)},${y(o.values[i])}` : null))
            .filter(Boolean)
            .join(' ')
          return (
            <polyline
              key={`ov-${k}`}
              points={pts}
              fill="none"
              stroke={o.color}
              strokeWidth={o.width ?? 1.6}
              strokeDasharray={o.dash}
              pointerEvents="none"
            >
              {o.label && <title>{o.label}</title>}
            </polyline>
          )
        })}

        {startPos >= 0 && (
          <g onPointerDown={startDrag('start')} style={{ cursor: 'ew-resize' }}>
            <rect x={x(startPos) - 8} y={PAD.top} width={16} height={PLOT_H} fill="transparent" />
            <line x1={x(startPos)} x2={x(startPos)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="#7c8cff" strokeWidth={2} />
            <circle cx={x(startPos)} cy={PAD.top + 6} r={6} fill="#7c8cff" />
          </g>
        )}
        {endPos >= 0 && (
          <g onPointerDown={startDrag('end')} style={{ cursor: 'ew-resize' }}>
            <rect x={x(endPos) - 8} y={PAD.top} width={16} height={PLOT_H} fill="transparent" />
            <line x1={x(endPos)} x2={x(endPos)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="#7c8cff" strokeWidth={2} />
            <circle cx={x(endPos)} cy={PAD.top + 6} r={6} fill="#7c8cff" />
          </g>
        )}
      </svg>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        Arraste os marcadores azuis pra ajustar a região (início {startIdx} · fim {endIdx}; idx = ponto da varredura). Linhas
        tracejadas finas = cursores que o próprio GeoWorks gravou nessa corrida, só de referência.
      </p>
    </div>
  )
}
