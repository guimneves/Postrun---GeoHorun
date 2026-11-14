import { useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { studyApi, type StudySensitivity } from '../api/postrun'
import { PEAK_COLORS } from '../lib/postrunColors'
import { PostRunLinesPlot, type LineSeries } from './PostRunLinesPlot'
import { inputInlineClass as inputClass, btnPrimaryClass } from '../ui/classes'

const f1 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(1))
const signed = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(0)} %`)

/** Tolerância ótima de dilatação do sistema (pedido do usuário, 23/10/2026):
 * reajusta as misturas do estudo (molde) em várias tolerâncias, sem gravar,
 * e mostra o RMSE da recuperação (em relação às massas conhecidas) × a
 * tolerância. A menor tolerância no mínimo do RMSE é a ótima; se a curva vira
 * um platô, os picos pararam de bater no limite e a Δlargura ajustada ali é a
 * melhor estimativa da dilatação "real" de cada polímero na mistura. */
export function PostRunStudyTolerance({ studyId }: { studyId: number }) {
  const [text, setText] = useState('10, 15, 20, 25, 30, 40, 50, 60, 80')
  const [data, setData] = useState<StudySensitivity | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tolerances = text
    .split(/[;,\s]+/)
    .map((v) => Number(v.replace(',', '.')))
    .filter((v) => Number.isFinite(v) && v > 0)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      setData(await studyApi.sensitivity(studyId, tolerances))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao calcular')
    } finally {
      setBusy(false)
    }
  }

  const mats = useMemo(() => [...new Set((data?.points ?? []).flatMap((p) => Object.keys(p.rmse_by_material)))].sort(), [data])
  const series = useMemo<LineSeries[]>(() => {
    if (!data) return []
    const pts = data.points.filter((p) => p.rmse !== null)
    const x = pts.map((p) => p.tol_width_pct)
    const out: LineSeries[] = mats.map((m, i) => ({
      key: m,
      x: pts.filter((p) => p.rmse_by_material[m] !== undefined).map((p) => p.tol_width_pct),
      y: pts.filter((p) => p.rmse_by_material[m] !== undefined).map((p) => p.rmse_by_material[m]),
      color: PEAK_COLORS[i % PEAK_COLORS.length],
      width: 1.6,
      label: `RMSE ${m}`,
    }))
    const tot = pts.filter((p) => p.rmse_total !== null)
    out.push({ key: 'total', x: tot.map((p) => p.tol_width_pct), y: tot.map((p) => p.rmse_total as number), color: 'var(--color-text-muted)', width: 1.4, dash: '4 3', label: 'RMSE da recuperação total' })
    out.push({ key: 'all', x, y: pts.map((p) => p.rmse as number), color: 'var(--color-text)', width: 2.6, label: 'RMSE (todos os componentes)' })
    return out
  }, [data, mats])

  const best = data?.points.find((p) => p.tol_width_pct === data.best_tol) ?? null
  const vLines = [
    ...(data?.best_tol != null ? [{ x: data.best_tol, label: `ótima ±${data.best_tol} %` }] : []),
    ...(data?.saved_tol ?? []).filter((t) => t !== data?.best_tol).map((t) => ({ x: t, label: `salva ±${t} %` })),
  ]
  const legend = [
    { label: 'todos', color: 'var(--color-text)' },
    ...mats.map((m, i) => ({ label: m, color: PEAK_COLORS[i % PEAK_COLORS.length] })),
    { label: 'total da mistura', color: 'var(--color-text-muted)', dash: '4 3' },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Tolerâncias de largura a testar (± %)
          <input className={`${inputClass} w-72`} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <button type="button" className={btnPrimaryClass} onClick={() => void run()} disabled={busy || tolerances.length === 0}>
          {busy ? 'Reajustando as misturas…' : 'Calcular'}
        </button>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          reajusta só as misturas (molde), sem gravar; curvas e puros ficam fixos
        </span>
      </div>
      {error && <p className="text-xs text-[var(--color-danger,#c0392b)]">{error}</p>}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <PostRunLinesPlot series={series} xLabel="tolerância de largura (± %)" yLabel="RMSE da recuperação (%)" height={260} vLines={vLines} legend={legend} />
            <div className="flex flex-col gap-2 text-sm">
              {best && (
                <div className="rounded-xl border p-3 border-[var(--color-border)] bg-[var(--color-bg)]">
                  <div className="text-[11px] text-[var(--color-text-muted)]">tolerância ótima ({data.n_mixtures} misturas)</div>
                  <div className="text-2xl font-semibold tabular-nums">±{data.best_tol} %</div>
                  <div className="text-xs tabular-nums text-[var(--color-text-muted)]">
                    RMSE {f1(data.best_rmse)} % · {best.n_at_bound} pico(s) no limite
                    {data.rmse_loco !== null && ` · validação (deixa uma composição de fora): ${f1(data.rmse_loco)} %`}
                  </div>
                </div>
              )}
              {best && (
                <div className="rounded-xl border p-3 border-[var(--color-border)] bg-[var(--color-bg)]">
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    dilatação ajustada na ótima (média das réplicas, só picos fora do limite) × natural dos puros
                  </div>
                  <table className="mt-1 w-full text-xs tabular-nums">
                    <tbody>
                      {mats.map((m, i) => (
                        <tr key={m}>
                          <td className="py-0.5 pr-2">
                            <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: PEAK_COLORS[i % PEAK_COLORS.length] }} />
                            {m}
                          </td>
                          <td className="py-0.5 pr-2 font-semibold">{signed(best.width_by_material[m]?.mean)}</td>
                          <td className="py-0.5 text-[var(--color-text-muted)]">
                            puros: {signed(data.natural_width[m]?.mean)}
                            {data.natural_width[m]?.sd != null && ` ± ${data.natural_width[m].sd!.toFixed(0)}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {best && best.n_at_bound > 0 && (
                <p className="text-[11px] text-[var(--color-warning,#b26a00)]">
                  Na ótima ainda há picos no limite: a Δlargura deles é o teto, não o valor ajustado — veja se o RMSE continua
                  caindo com tolerâncias maiores.
                </p>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs tabular-nums">
              <thead className="text-[var(--color-text-muted)]">
                <tr>
                  <th className="py-1 pr-3">Tolerância</th>
                  <th className="py-1 pr-3">RMSE</th>
                  {mats.map((m) => <th key={m} className="py-1 pr-3">RMSE {m}</th>)}
                  <th className="py-1 pr-3">RMSE total</th>
                  <th className="py-1 pr-3">No limite</th>
                  <th className="py-1 pr-3">R² médio</th>
                  <th className="py-1 pr-3">Recuperação média por composição</th>
                </tr>
              </thead>
              <tbody>
                {data.points.map((p) => (
                  <tr
                    key={p.tol_width_pct}
                    className="border-t border-[var(--color-border)]"
                    style={p.tol_width_pct === data.best_tol ? { background: 'var(--color-surface)', fontWeight: 600 } : undefined}
                  >
                    <td className="py-1 pr-3">±{p.tol_width_pct} %</td>
                    <td className="py-1 pr-3">{f1(p.rmse)}</td>
                    {mats.map((m) => <td key={m} className="py-1 pr-3">{f1(p.rmse_by_material[m])}</td>)}
                    <td className="py-1 pr-3">{f1(p.rmse_total)}</td>
                    <td className="py-1 pr-3">{p.n_at_bound}{p.n_failed ? ` · ${p.n_failed} falharam` : ''}</td>
                    <td className="py-1 pr-3">{p.mean_r2 !== null ? p.mean_r2.toFixed(4) : '—'}</td>
                    <td className="py-1 pr-3 font-normal text-[var(--color-text-muted)]">
                      {Object.entries(p.recovery_by_group)
                        .map(([g, d]) => `${g}: ${Object.entries(d).map(([m, v]) => `${m} ${v.toFixed(0)}`).join(' / ')}`)
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.loco.length > 0 && (
            <div className="text-xs">
              <span className="font-medium">Validação — deixa uma composição de fora</span>
              <span className="text-[var(--color-text-muted)]"> (a tolerância escolhida sem ela, e o erro nela):</span>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                {data.loco.map((l) => (
                  <li key={l.group}>
                    {l.group}: ±{l.chosen_tol} % → RMSE {f1(l.rmse_at_group)} %
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                Se a tolerância escolhida muda pouco de uma composição para outra, a ótima é estável; se muda muito, a escolha
                do modelo é incerta e deve entrar na incerteza.
              </p>
            </div>
          )}
          {data.errors.length > 0 && (
            <p className="text-[11px] text-[var(--color-warning,#b26a00)]">Não ajustaram: {data.errors.join('; ')}</p>
          )}
          <p className="text-[11px] text-[var(--color-text-muted)]">
            RMSE = √média (recuperação − 100)² dos componentes das misturas (com as massas reais, se informadas). Abaixo da
            ótima, os picos ficam presos no limite e dividem mal o sinal; acima dela, com o RMSE em platô, o ajuste já não usa
            a folga. Um RMSE que volta a subir com tolerâncias grandes indica um pico &quot;invadindo&quot; o vizinho.
          </p>
        </>
      )}
    </div>
  )
}
