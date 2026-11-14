// Espelha app/modules/postrun_calc.py — mesma regra do trapézio, pra
// recalcular a área ao vivo no navegador enquanto o usuário arrasta um
// cursor, sem round-trip ao servidor a cada pixel. O valor "oficial"
// (persistido) vem do backend depois que o arraste termina — mesmo
// algoritmo, deve bater exatamente.
import type { BaselineMode } from '../api/postrun'

export interface AreaResult {
  area: number
  nPoints: number
  peakValue: number
  peakIdx: number
}

export function computeArea(
  idx: number[],
  signal: number[],
  startIdx: number,
  endIdx: number,
  baselineMode: BaselineMode = 'fixed',
  fixedBaseline = 0,
): AreaResult | null {
  if (idx.length !== signal.length || idx.length === 0) return null

  const lo = Math.min(startIdx, endIdx)
  const hi = Math.max(startIdx, endIdx)
  const indexOf = new Map(idx.map((v, i) => [v, i]))
  const positions: number[] = []
  for (let v = lo; v <= hi; v++) {
    const pos = indexOf.get(v)
    if (pos !== undefined) positions.push(pos)
  }
  if (positions.length < 2) return null

  const xs = positions.map((p) => idx[p])
  const ys = positions.map((p) => signal[p])

  let corrected: number[]
  if (baselineMode === 'linear') {
    const y0 = ys[0]
    const y1 = ys[ys.length - 1]
    const span = xs[xs.length - 1] - xs[0]
    corrected = xs.map((x, i) => ys[i] - (span === 0 ? y0 : y0 + ((y1 - y0) * (x - xs[0])) / span))
  } else {
    corrected = ys.map((y) => y - fixedBaseline)
  }

  let area = 0
  for (let i = 0; i < xs.length - 1; i++) {
    const dx = xs[i + 1] - xs[i]
    area += (dx * (corrected[i] + corrected[i + 1])) / 2
  }

  let peakPos = 0
  for (let i = 1; i < ys.length; i++) if (ys[i] > ys[peakPos]) peakPos = i

  return { area, nPoints: xs.length, peakValue: ys[peakPos], peakIdx: xs[peakPos] }
}
