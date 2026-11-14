/** Séries dos gráficos de dilatação do modo molde (24/10/2026) — usadas no
 * painel da deconvolução (aba Análises) e no inspetor da aba Estudos. */
import type { DeconvResult } from '../api/postrun'
import type { LineSeries } from '../components/PostRunLinesPlot'
import { PEAK_COLORS } from './postrunColors'

/** Forma: puro × mistura, cada um ÷ a própria altura e centrado no próprio
 * máximo — sem o deslocamento e sem a área, sobra só a mudança de forma. */
export function shapeSeriesOf(r: DeconvResult | null | undefined): LineSeries[] {
  const c = r?.curve
  if (!r || !c?.temps?.length || !c.pure_components?.length) return []
  const temps = c.temps
  const norm = (vals: number[]) => {
    let im = 0
    vals.forEach((v, i) => {
      if (v > vals[im]) im = i
    })
    const top = vals[im] || 1
    return { x: temps.map((t) => t - temps[im]), y: vals.map((v) => v / top) }
  }
  const out: LineSeries[] = []
  c.components.forEach((vals, k) => {
    const pure = c.pure_components?.[k]
    if (!pure?.length) return
    const color = PEAK_COLORS[k % PEAK_COLORS.length]
    out.push({ key: `pure${k}`, ...norm(pure), color, width: 1.4, dash: '2 3', label: `${r.peaks[k]?.name} · puro` })
    out.push({ key: `mix${k}`, ...norm(vals), color, width: 2, label: `${r.peaks[k]?.name} · mistura` })
  })
  return out
}

/** A corrida em °C: sinal, soma dos picos, cada componente (cheio) e o molde
 * do puro dele (pontilhado, mesma área). */
export function overlaySeriesOf(r: DeconvResult | null | undefined, withPure = true): LineSeries[] {
  const c = r?.curve
  if (!r || !c?.temps?.length) return []
  const x = c.temps
  const out: LineSeries[] = [
    { key: 'signal', x, y: c.signal, color: 'var(--color-text-muted)', width: 1.2, opacity: 0.8, label: 'sinal' },
  ]
  c.components.forEach((vals, k) => {
    const color = PEAK_COLORS[k % PEAK_COLORS.length]
    out.push({ key: `comp${k}`, x, y: vals, color, width: 2, label: r.peaks[k]?.name })
    const pure = c.pure_components?.[k]
    if (withPure && pure?.length) out.push({ key: `pure${k}`, x, y: pure, color, width: 1.4, dash: '2 3', label: `${r.peaks[k]?.name} · molde do puro` })
  })
  out.push({ key: 'fit', x, y: c.fitted, color: 'var(--color-text)', width: 1.2, dash: '5 3', label: 'soma dos picos' })
  return out
}
