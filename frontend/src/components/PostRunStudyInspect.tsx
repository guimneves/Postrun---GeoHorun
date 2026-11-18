import { useEffect, useMemo, useState } from 'react'
import { postrunApi, type DeconvMethod, type DeconvResult, type RecoveryReport } from '../api/postrun'
import { materialColor } from '../lib/postrunColors'
import { overlaySeriesOf, shapeSeriesOf } from '../lib/postrunShape'
import { PostRunLinesPlot } from './PostRunLinesPlot'
import { recoveryColor } from './PostRunRecoveryViz'

const stem = (f: string) => f.replace(/\.[A-Za-z]00$/i, '')
const signed = (v: number | null | undefined, unit: string, d = 1) =>
  v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)} ${unit}`

/** Inspetor de réplicas da aba Estudos (pedido do usuário, 22/10/2026: os
 * gráficos do molde fazem mais sentido no estudo do que na aba Análises).
 * Escolhe uma réplica e mostra a corrida com o molde do puro sobreposto, a
 * forma normalizada e as larguras — as réplicas com pico no limite da
 * tolerância vêm marcadas (⚠) e a primeira delas já vem aberta. */
export function PostRunStudyInspect({ report, method }: { report: RecoveryReport; method: DeconvMethod }) {
  const atBound = (r: RecoveryReport['runs'][number]) => r.materials.some((m) => m.flags.some((f) => f.includes('limite')))
  const groups = useMemo(() => {
    const keys = [...new Set(report.runs.map((r) => r.group))]
    return keys.map((k) => ({ key: k, runs: report.runs.filter((r) => r.group === k) }))
  }, [report])
  const firstFlagged = report.runs.find(atBound) ?? report.runs.find((r) => r.materials.length > 1) ?? report.runs[0]
  const [token, setToken] = useState<string | null>(firstFlagged?.token ?? null)
  const [result, setResult] = useState<DeconvResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [showPure, setShowPure] = useState(true)

  useEffect(() => {
    if (!report.runs.some((r) => r.token === token)) setToken(firstFlagged?.token ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report])

  useEffect(() => {
    if (!token) return
    let alive = true
    setLoading(true)
    postrunApi
      .listDeconv([token], method)
      .then((rows) => alive && setResult(rows.find((r) => r.spec.channel === 'pyro:FID') ?? rows[0] ?? null))
      .catch(() => alive && setResult(null))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [token, method])

  const run = report.runs.find((r) => r.token === token) ?? null
  const overlay = useMemo(() => overlaySeriesOf(result, showPure), [result, showPure])
  const shape = useMemo(() => shapeSeriesOf(result), [result])
  const tol = result?.spec.tol_width_pct
  const names = (result?.peaks ?? []).map((p) => p.name)
  const legend = (result?.peaks ?? []).map((p) => ({ label: p.name, color: materialColor(p.name, names) }))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        {groups.map((g) => (
          <div key={g.key} className="flex flex-wrap items-center gap-1.5">
            <span className="w-36 shrink-0 truncate text-xs font-medium" title={g.key}>{g.key}</span>
            {g.runs.map((r) => {
              const flagged = atBound(r)
              return (
                <button
                  key={r.token}
                  type="button"
                  onClick={() => setToken(r.token)}
                  title={`${stem(r.filename)}${flagged ? ' — pico no limite da tolerância' : ''}`}
                  className="rounded-full border px-2 py-0.5 text-[11px] tabular-nums border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                  style={token === r.token ? { borderColor: 'var(--color-primary)', boxShadow: '0 0 0 1px var(--color-primary)' } : undefined}
                >
                  {flagged && <span className="mr-0.5 text-[#eda100]">⚠</span>}
                  {stem(r.filename).split('_').pop()}
                  <span className="ml-1 font-semibold" style={{ color: recoveryColor(r.total_recovery_pct) }}>
                    {r.total_recovery_pct !== null ? `${r.total_recovery_pct.toFixed(0)}%` : '—'}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Cada botão é uma réplica (número do arquivo · recuperação total). ⚠ = algum pico ficou no limite da tolerância de largura.
        </p>
      </div>

      {run && (
        <div className="rounded-xl border p-3 border-[var(--color-border)]">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-sm">{stem(run.filename)}</span>
            <span className="text-xs text-[var(--color-text-muted)]">
              {run.composition_text} · {run.mass_mg.toFixed(3)} mg · R² {run.r2.toFixed(4)}
              {tol !== undefined && method === 'molde' && ` · tolerância de largura ±${tol} %`}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[var(--color-text-muted)]">
                <tr>
                  <th className="py-1 pr-3">Componente</th>
                  <th className="py-1 pr-3">Recuperação</th>
                  <th className="py-1 pr-3">ΔTmax</th>
                  <th className="py-1 pr-3">Δlargura</th>
                  {method === 'molde' && <th className="py-1 pr-3">Largura ½ altura puro → mistura</th>}
                  <th className="py-1 pr-3">Avisos</th>
                </tr>
              </thead>
              <tbody>
                {run.materials.map((m) => {
                  const pk = result?.peaks.find((p) => p.material === m.material)
                  // mesma cor do gráfico (ordem dos picos)
                  const ci = result ? result.peaks.findIndex((p) => p.material === m.material) : -1
                  return (
                    <tr key={m.material} className="border-t border-[var(--color-border)]">
                      <td className="py-1 pr-3">
                        <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full" style={{ background: materialColor(ci >= 0 && result ? result.peaks[ci].name : m.material, names) }} />
                        {m.material}
                      </td>
                      <td className="py-1 pr-3 font-semibold tabular-nums" style={{ color: recoveryColor(m.recovery_pct) }}>
                        {m.recovery_pct !== null ? `${m.recovery_pct.toFixed(1)} %` : '—'}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">{signed(m.delta_mu_c, '°C')}</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {signed(m.delta_width_pct, '%')}
                        {pk?.at_bound && <span className="ml-1 text-[#eda100]" title="no limite da tolerância">⚠ limite</span>}
                      </td>
                      {method === 'molde' && (
                        <td className="py-1 pr-3 tabular-nums">
                          {pk?.pure_fwhm_c != null && pk.fwhm_c != null ? `${pk.pure_fwhm_c.toFixed(1)} → ${pk.fwhm_c.toFixed(1)} °C` : '—'}
                        </td>
                      )}
                      <td className="py-1 pr-3 text-[var(--color-warning,#b26a00)]">{m.flags.join('; ')}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {run.materials.some((m) => m.flags.some((f) => f.includes('limite'))) && (
            <p className="mt-2 text-[11px] text-[var(--color-warning,#b26a00)]">
              Pico no limite: o ajuste queria alargar mais do que a tolerância permite — o Δlargura mostrado é o teto, não o
              alargamento real. Compare os gráficos abaixo: se o componente alarga dos dois lados em todas as réplicas, é
              interação; se só uma cauda cresce, ele está puxando sinal do vizinho ou da linha de base.
            </p>
          )}

          {loading && <p className="mt-2 text-xs text-[var(--color-text-muted)]">Carregando a deconvolução…</p>}
          {!loading && !result && <p className="mt-2 text-xs text-[var(--color-text-muted)]">Sem deconvolução salva neste método.</p>}
          {result && (
            <div className="mt-3 grid grid-cols-1 gap-4 xl:grid-cols-2">
              <div>
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium">Corrida e componentes</span>
                  {method === 'molde' && (
                    <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                      <input type="checkbox" checked={showPure} onChange={(e) => setShowPure(e.target.checked)} />
                      molde do puro (pontilhado, mesma área)
                    </label>
                  )}
                </div>
                <PostRunLinesPlot series={overlay} xLabel="temperatura (°C)" yLabel="sinal − linha de base" height={260} legend={legend} />
              </div>
              {shape.length > 0 ? (
                <div>
                  <span className="mb-1 block text-xs font-medium">Forma (cada curva ÷ a própria altura, centrada no máximo)</span>
                  <PostRunLinesPlot
                    series={shape}
                    xLabel="temperatura em relação ao máximo (°C)"
                    yLabel="sinal ÷ altura"
                    height={260}
                    vLines={[{ x: 0, label: 'máximo' }]}
                    legend={[...legend, { label: 'puro', color: 'var(--color-text-muted)', dash: '2 3' }]}
                  />
                  <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                    Pontilhado = molde do puro; cheio = o componente na mistura. Os dois lados alargando por igual = a dilatação
                    uniforme do modelo vale; só um lado = a mistura mudou a forma.
                  </p>
                </div>
              ) : (
                <p className="self-center text-xs text-[var(--color-text-muted)]">
                  O gráfico de forma é do método Molde (compara com o molde do puro).
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
