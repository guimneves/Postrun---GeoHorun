import { useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { interactionApi, type DeconvMethod, type InteractionResult } from '../api/postrun'
import { materialColor } from '../lib/postrunColors'
import { btnPrimaryClass } from '../ui/classes'
import { PostRunLinesPlot, type LineSeries } from './PostRunLinesPlot'
import { PostRunScatterPlot } from './PostRunScatterPlot'

const signed = (v: number | null, unit: string, d = 1) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)} ${unit}`)

/** F7 do artigo: o que a co-pirólise muda. Para cada mistura, o medido contra a
 * previsão SEM interação (moldes rígidos dos puros × massa esperada), a curva
 * de diferença (ΔM), e ΔTmax/Δlargura × fração, com o alerta de parâmetro no
 * limite da tolerância. */
export function PostRunInteractionPanel({ studyId, method }: { studyId: number; method: DeconvMethod }) {
  const [data, setData] = useState<InteractionResult | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setMessage(null)
    try {
      const r = await interactionApi.run(studyId, method)
      setData(r)
      setActive(r.runs[0]?.token ?? null)
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao calcular a interação')
    } finally {
      setBusy(false)
    }
  }

  const mats = useMemo(() => [...new Set((data?.trends ?? []).map((p) => p.material))].sort(), [data])
  const run1 = data?.runs.find((r) => r.token === active) ?? null
  const series: LineSeries[] = run1
    ? [
        { key: 'medido', x: run1.temp_c, y: run1.measured, color: 'var(--color-text)', width: 1.6, label: 'medido' },
        { key: 'previsto', x: run1.temp_c, y: run1.predicted, color: 'var(--color-text-muted)', width: 1.6, dash: '6 4', label: 'previsto sem interação' },
        ...run1.components.map((c, i) => {
          const mat = run1.component_info.filter((ci) => !ci.error)[i]?.material ?? `${i}`
          return { key: `c${i}`, x: run1.temp_c, y: c, color: materialColor(mat, mats), width: 1.1, dash: '2 3', label: `${mat} (molde rígido)` }
        }),
      ]
    : []

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimaryClass} disabled={busy} onClick={() => void run()}>
          {busy ? 'Calculando…' : 'Calcular a interação'}
        </button>
        {message && <span className="text-xs text-[var(--color-danger)]">{message}</span>}
      </div>

      {data && (
        <>
          {data.alerts.length > 0 && (
            <div className="rounded-xl border border-[var(--color-warning)] p-3 text-xs">
              <strong className="text-[var(--color-warning)]">Parâmetros no limite da tolerância</strong> — a interação passa
              da folga dada ao ajuste (aumente a tolerância ou reporte como limite):
              <ul className="mt-1 list-disc pl-5">
                {data.alerts.map((a, i) => (
                  <li key={i}>
                    <span className="font-mono">{a.filename.replace(/\.[A-Za-z]00$/i, '')}</span> · {a.material}: ΔTmax{' '}
                    {signed(a.delta_mu_c, '°C')} (± {a.tol_c} °C), Δlargura {signed(a.delta_width_pct, '%')} (± {a.tol_width_pct} %)
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-[var(--color-text-muted)]">
                  <tr>
                    <th className="py-1 pr-3">Mistura</th>
                    <th className="py-1 pr-3" title="(∫medido − ∫previsto) ÷ ∫previsto">ΔM</th>
                    <th className="py-1 pr-3" title="maior |medido − previsto| ÷ máximo previsto">desvio máx.</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.token} onClick={() => setActive(r.token)}
                      className="cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                      style={active === r.token ? { background: 'var(--color-row-selected)' } : undefined}>
                      <td className="py-1 pr-3">
                        <span className="block font-mono text-[11px]">{r.filename.replace(/\.[A-Za-z]00$/i, '')}</span>
                        <span className="block text-[10px] text-[var(--color-text-dim)]">{r.composition_text}</span>
                        {r.error && <span className="block text-[10px] text-[var(--color-danger)]">{r.error}</span>}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">{signed(r.delta_m_pct, '%')}</td>
                      <td className="py-1 pr-3 tabular-nums">{r.max_dev_pct !== null ? `${r.max_dev_pct.toFixed(1)} %` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {run1 && run1.t_s.length > 0 && (
              <div className="flex flex-col gap-2">
                <PostRunLinesPlot series={series} xLabel="temperatura (°C)" yLabel="sinal FID" height={260}
                  legend={series.map((s) => ({ label: s.label ?? s.key, color: s.color, dash: s.dash }))} />
                <PostRunLinesPlot
                  series={[{ key: 'dif', x: run1.temp_c, y: run1.difference, color: 'var(--color-primary)', width: 1.4, label: 'medido − previsto' }]}
                  xLabel="temperatura (°C)" yLabel="medido − previsto" height={170}
                />
              </div>
            )}
          </div>

          {data.trends.length > 0 && (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {(
                [
                  ['delta_mu_c', 'ΔTmax (°C)'],
                  ['delta_width_pct', 'Δlargura (%)'],
                ] as const
              ).map(([k, label]) => (
                <PostRunScatterPlot
                  key={k}
                  points={data.trends
                    .filter((p) => p[k] !== null)
                    .map((p) => ({ x: 100 * p.fraction, y: p[k] as number, color: materialColor(p.material, mats), hollow: p.at_bound,
                      tip: [`${p.material} · fração ${(100 * p.fraction).toFixed(0)} %`, `${label}: ${(p[k] as number).toFixed(1)}`, p.at_bound ? 'no limite da tolerância' : ''] }))}
                  xLabel="fração do componente (%)" yLabel={label} hLine={0} height={240}
                  legend={mats.map((m) => ({ label: m, color: materialColor(m, mats) }))}
                />
              ))}
            </div>
          )}
          <p className="text-[11px] text-[var(--color-text-muted)]">
            Previsão sem interação = soma dos moldes dos puros na posição da referência, sem dilatação, cada um com a área que a
            curva do material dá para a massa esperada. Pontos vazados = no limite da tolerância.
          </p>
        </>
      )}
    </div>
  )
}
