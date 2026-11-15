import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { postrunApi, robustnessApi, type AnalysisSummary, type DeconvReference, type RobustnessResult } from '../api/postrun'
import { materialColor } from '../lib/postrunColors'
import { fmtNum } from '../lib/postrunFormat'
import { btnPrimaryClass, inputInlineClass } from '../ui/classes'
import { recoveryColor } from './PostRunRecoveryViz'

const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v.toFixed(d)} %`)

/** F8 do artigo: quanto a quantificação depende do molde — deixa-uma-corrida-
 * de-fora, incerteza combinada com o termo do molde e comparação com o molde
 * de outro lote/grade/granulometria. Nada é gravado. */
export function PostRunRobustnessPanel({
  studyId,
  analyses,
}: {
  studyId: number
  analyses: { token: string; summary: AnalysisSummary | null }[]
}) {
  const materials = useMemo(
    () => [...new Set(analyses.flatMap((a) => Object.keys(a.summary?.composition ?? {})))].sort(),
    [analyses],
  )
  const [material, setMaterial] = useState(materials[0] ?? '')
  const [refs, setRefs] = useState<DeconvReference[]>([])
  const [alt, setAlt] = useState<number | null>(null)
  const [data, setData] = useState<RobustnessResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    postrunApi.listReferences().then((rs) => setRefs(rs.filter((r) => r.has_template))).catch(() => setRefs([]))
  }, [])
  useEffect(() => {
    if (!material && materials.length) setMaterial(materials[0])
  }, [materials, material])

  async function run() {
    setBusy(true)
    setMessage(null)
    try {
      setData(await robustnessApi.run(studyId, material, alt))
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao calcular a robustez')
    } finally {
      setBusy(false)
    }
  }

  const color = materialColor(material, materials)
  const recs = (data?.loro ?? []).filter((l) => l.recovery_mean !== null)
  const lo = Math.min(...recs.map((l) => l.recovery_mean as number), data?.baseline_recovery ?? 100) - 1
  const hi = Math.max(...recs.map((l) => l.recovery_mean as number), data?.baseline_recovery ?? 100) + 1

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3 text-xs text-[var(--color-text-muted)]">
        <label className="flex flex-col gap-1">
          Material
          <select className={inputInlineClass} value={material} onChange={(e) => setMaterial(e.target.value)}>
            {materials.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Comparar com outro molde (opcional)
          <select className={inputInlineClass} value={alt ?? ''} onChange={(e) => setAlt(e.target.value ? Number(e.target.value) : null)}>
            <option value="">— nenhum —</option>
            {refs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.n_runs} corrida(s) · {r.cycle_label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={btnPrimaryClass} disabled={busy || !material} onClick={() => void run()}>
          {busy ? 'Refazendo os moldes…' : 'Calcular a robustez'}
        </button>
        {message && <span className="text-[var(--color-danger)]">{message}</span>}
      </div>

      {data && (
        <>
          {data.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-[var(--color-warning)]">
              {data.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="rounded-xl bg-[var(--color-surface)] p-3 text-sm">
              <div className="text-xs text-[var(--color-text-muted)]">
                Molde {data.reference_name} · {data.n_template_runs} corrida(s) · {data.n_pures} puro(s) · {data.n_mixtures} mistura(s)
              </div>
              <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1">
                <span>
                  recuperação de {data.material}:{' '}
                  <strong style={{ color: recoveryColor(data.baseline_recovery) }}>{pct(data.baseline_recovery)}</strong>
                </span>
                <span title="desvio-padrão da recuperação média entre os moldes deixa-uma-corrida-de-fora">
                  efeito do molde (dp): <strong>{data.template_sd_recovery != null ? `${data.template_sd_recovery.toFixed(2)} p.p.` : '—'}</strong>
                </span>
              </div>
              {recs.length > 0 && (
                <div className="mt-3 flex flex-col gap-1">
                  <span className="text-xs text-[var(--color-text-muted)]">deixando de fora…</span>
                  {data.loro.map((l) => (
                    <div key={l.left_out} className="flex items-center gap-2 text-xs">
                      <span className="w-48 truncate font-mono" title={l.filename}>{l.filename.replace(/\.B00$/i, '')}</span>
                      {l.recovery_mean !== null ? (
                        <>
                          <span className="relative h-2 flex-1 rounded bg-[var(--color-bg-elevated)]">
                            <span className="absolute top-0 h-2 w-1 rounded" style={{ left: `${(100 * (l.recovery_mean - lo)) / (hi - lo)}%`, background: color }} />
                            {data.baseline_recovery !== null && (
                              <span className="absolute -top-0.5 h-3 w-px bg-[var(--color-text)]" style={{ left: `${(100 * (data.baseline_recovery - lo)) / (hi - lo)}%` }} />
                            )}
                          </span>
                          <span className="w-14 text-right tabular-nums">{pct(l.recovery_mean)}</span>
                        </>
                      ) : (
                        <span className="text-[var(--color-danger)]">{l.error}</span>
                      )}
                    </div>
                  ))}
                  <span className="text-[10px] text-[var(--color-text-dim)]">traço preto = com o molde completo</span>
                </div>
              )}
            </div>

            {data.compare && (
              <div className="rounded-xl bg-[var(--color-surface)] p-3 text-sm">
                <div className="text-xs text-[var(--color-text-muted)]">Comparação com o molde {data.compare.name}</div>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                  <dt className="text-[var(--color-text-muted)]">correlação das formas</dt>
                  <dd className="tabular-nums">{data.compare.correlation?.toFixed(4) ?? '—'}</dd>
                  <dt className="text-[var(--color-text-muted)]">distância L2</dt>
                  <dd className="tabular-nums">{data.compare.l2 != null ? `${fmtNum(data.compare.l2)} (${pct(data.compare.l2_rel_pct)})` : '—'}</dd>
                  <dt className="text-[var(--color-text-muted)]">posição do máximo</dt>
                  <dd className="tabular-nums">{data.compare.max_c_diff != null ? `${data.compare.max_c_diff >= 0 ? '+' : ''}${data.compare.max_c_diff.toFixed(1)} °C` : '—'}</dd>
                  <dt className="text-[var(--color-text-muted)]">recuperação com ele</dt>
                  <dd className="tabular-nums">
                    {pct(data.compare.recovery_mean)}
                    {data.compare.delta_recovery != null && ` (${data.compare.delta_recovery >= 0 ? '+' : ''}${data.compare.delta_recovery.toFixed(1)} p.p.)`}
                  </dd>
                </dl>
              </div>
            )}
          </div>

          {data.combined.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-[var(--color-text-muted)]">
                  <tr>
                    <th className="py-1 pr-3">Mistura</th>
                    <th className="py-1 pr-3">{data.material} encontrado (mg)</th>
                    <th className="py-1 pr-3">u ajuste</th>
                    <th className="py-1 pr-3">u molde</th>
                    <th className="py-1 pr-3">U95 combinada</th>
                    <th className="py-1 pr-3">parte do molde</th>
                  </tr>
                </thead>
                <tbody>
                  {data.combined.map((c) => (
                    <tr key={c.token} className="border-t border-[var(--color-border)]">
                      <td className="py-1 pr-3 font-mono text-xs">{c.filename.replace(/\.B00$/i, '')}</td>
                      <td className="py-1 pr-3 tabular-nums">{c.found_mg != null ? fmtNum(c.found_mg) : '—'}</td>
                      <td className="py-1 pr-3 tabular-nums">{c.u_fit_mg != null ? fmtNum(c.u_fit_mg) : '—'}</td>
                      <td className="py-1 pr-3 tabular-nums">{c.u_template_mg != null ? fmtNum(c.u_template_mg) : '—'}</td>
                      <td className="py-1 pr-3 tabular-nums font-semibold">{c.U95_combined_mg != null ? fmtNum(c.U95_combined_mg) : '—'}</td>
                      <td className="py-1 pr-3 tabular-nums">{pct(c.template_share_pct, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                u² = u_ajuste² + u_molde²; u_ajuste = U95 da curva ÷ 2; u_molde = desvio da massa encontrada entre os moldes
                deixa-uma-corrida-de-fora; "parte do molde" = u_molde² ÷ u².
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
