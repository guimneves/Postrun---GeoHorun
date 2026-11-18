import { useState } from 'react'
import { ApiError } from '../api/client'
import { identifiabilityApi, type BootstrapResult, type DeconvMethod, type IdentifiabilityResult } from '../api/postrun'
import { materialColor } from '../lib/postrunColors'
import { fmtNum } from '../lib/postrunFormat'
import { btnClass, btnPrimaryClass, inputInlineClass } from '../ui/classes'
import { PostRunScatterPlot } from './PostRunScatterPlot'
import { recoveryColor } from './PostRunRecoveryViz'

const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v.toFixed(d)} %`)

function rhoColor(r: number): string {
  const a = Math.abs(r)
  return a > 0.9 ? 'var(--color-danger)' : a > 0.7 ? 'var(--color-warning)' : 'var(--color-text-muted)'
}

/** F9 do artigo: identificabilidade — correlação das áreas, recomendação de
 * reportar a soma do par mal condicionado e bootstrap dos resíduos. */
export function PostRunIdentifiabilityPanel({ studyId, method }: { studyId: number; method: DeconvMethod }) {
  const [data, setData] = useState<IdentifiabilityResult | null>(null)
  const [boot, setBoot] = useState<BootstrapResult | null>(null)
  const [bootToken, setBootToken] = useState<string | null>(null)
  const [nBoot, setNBoot] = useState(100)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setMessage(null)
    setBoot(null)
    try {
      setData(await identifiabilityApi.run(studyId, method))
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro no diagnóstico')
    } finally {
      setBusy(false)
    }
  }

  async function runBoot(token: string) {
    setBusy(true)
    setMessage(null)
    setBootToken(token)
    try {
      setBoot(await identifiabilityApi.bootstrap(studyId, token, method, nBoot))
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro no bootstrap')
    } finally {
      setBusy(false)
    }
  }

  const bootMats = boot ? Object.keys(boot.samples) : []
  const worst = boot?.pairs.slice().sort((p, q) => Math.abs(q.rho ?? 0) - Math.abs(p.rho ?? 0))[0] ?? null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimaryClass} disabled={busy} onClick={() => void run()}>
          Diagnosticar
        </button>
        <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
          reamostragens do bootstrap
          <select className={inputInlineClass} value={nBoot} onChange={(e) => setNBoot(Number(e.target.value))}>
            {[50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {busy && <span className="text-xs text-[var(--color-text-muted)]">calculando…</span>}
        {message && <span className="text-xs text-[var(--color-danger)]">{message}</span>}
      </div>

      {data && (
        <>
          {data.recommendations.length > 0 ? (
            <ul className="list-disc rounded-xl border border-[var(--color-warning)] p-3 pl-7 text-xs">
              {data.recommendations.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[var(--color-status-ready)]">Nenhum par com |ρ| &gt; 0,9: as áreas de cada material estão bem determinadas.</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-[var(--color-text-muted)]">
                <tr>
                  <th className="py-1 pr-3">Mistura</th>
                  <th className="py-1 pr-3">Par</th>
                  <th className="py-1 pr-3" title="correlação entre as áreas dos dois materiais no ajuste">ρ áreas</th>
                  <th className="py-1 pr-3">Recuperação de cada</th>
                  <th className="py-1 pr-3">Recuperação da soma</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) =>
                  r.pairs.map((p, i) => (
                    <tr key={`${r.token}|${p.a}|${p.b}`} className={i === 0 ? 'border-t border-[var(--color-border)]' : ''}
                      style={bootToken === r.token && boot ? { background: 'var(--color-row-selected)' } : undefined}>
                      {i === 0 && (
                        <td className="py-1 pr-3 align-top" rowSpan={r.pairs.length}>
                          <span className="block font-mono text-[11px]">{r.filename.replace(/\.[A-Za-z]00$/i, '')}</span>
                          <span className="block text-[10px] text-[var(--color-text-dim)]">{r.composition_text}</span>
                        </td>
                      )}
                      <td className="py-1 pr-3">
                        {p.a} + {p.b}
                      </td>
                      <td className="py-1 pr-3 tabular-nums font-semibold" style={{ color: rhoColor(p.rho) }}>
                        {p.rho.toFixed(3)}
                      </td>
                      <td className="py-1 pr-3 tabular-nums text-xs">
                        <span style={{ color: recoveryColor(p.recovery_a) }}>{pct(p.recovery_a)}</span> ·{' '}
                        <span style={{ color: recoveryColor(p.recovery_b) }}>{pct(p.recovery_b)}</span>
                      </td>
                      <td className="py-1 pr-3 tabular-nums font-semibold" style={{ color: recoveryColor(p.recovery_sum) }}>
                        {pct(p.recovery_sum)}
                      </td>
                      {i === 0 && (
                        <td className="py-1 align-top" rowSpan={r.pairs.length}>
                          <button type="button" className={`${btnClass} text-xs`} disabled={busy} onClick={() => void runBoot(r.token)}>
                            bootstrap
                          </button>
                        </td>
                      )}
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {boot && (
        <div className="grid grid-cols-1 gap-3 rounded-xl bg-[var(--color-surface)] p-3 lg:grid-cols-2">
          <div className="flex flex-col gap-2 text-sm">
            <div className="text-xs text-[var(--color-text-muted)]">
              Bootstrap dos resíduos (em blocos) — <span className="font-mono">{boot.filename.replace(/\.[A-Za-z]00$/i, '')}</span>:{' '}
              {boot.n_ok} reajustes{boot.n_failed ? `, ${boot.n_failed} falharam` : ''}
            </div>
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-[var(--color-text-muted)]">
                <tr>
                  <th className="py-1 pr-3">Material</th>
                  <th className="py-1 pr-3">Massa (mg)</th>
                  <th className="py-1 pr-3">IC 95 %</th>
                  <th className="py-1 pr-3">dp recuperação</th>
                </tr>
              </thead>
              <tbody>
                {boot.materials.map((m) => (
                  <tr key={m.material} className="border-t border-[var(--color-border)]">
                    <td className="py-1 pr-3">
                      <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: materialColor(m.material, bootMats) }} />
                      {m.material}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">
                      {m.found_mean != null ? fmtNum(m.found_mean) : '—'}
                      {m.found_sd != null && ` ± ${fmtNum(m.found_sd)}`}
                    </td>
                    <td className="py-1 pr-3 tabular-nums text-xs">
                      {m.found_p2_5 != null && m.found_p97_5 != null ? `${fmtNum(m.found_p2_5)} – ${fmtNum(m.found_p97_5)}` : '—'}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">{pct(m.recovery_sd_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {boot.pairs.map((p) => (
              <p key={`${p.a}${p.b}`} className="text-xs">
                {p.a} × {p.b}: ρ das massas = <strong style={{ color: rhoColor(p.rho ?? 0) }}>{p.rho?.toFixed(3) ?? '—'}</strong>; CV{' '}
                {p.a} {pct(p.a_cv_pct)}, {p.b} {pct(p.b_cv_pct)}, <strong>soma {pct(p.sum_cv_pct)}</strong>
              </p>
            ))}
          </div>
          {worst && boot.samples[worst.a] && boot.samples[worst.b] && (
            <PostRunScatterPlot
              points={boot.samples[worst.a].map((x, i) => ({ x, y: boot.samples[worst.b][i], color: 'var(--color-primary)' }))}
              xLabel={`${worst.a} encontrado (mg)`}
              yLabel={`${worst.b} encontrado (mg)`}
              height={260}
              xFromData
            />
          )}
        </div>
      )}
    </div>
  )
}
