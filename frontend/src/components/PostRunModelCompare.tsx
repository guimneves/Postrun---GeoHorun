import { useState } from 'react'
import { ApiError } from '../api/client'
import { compareApi, type CompareModelKey, type CompareResult } from '../api/postrun'
import { materialColor } from '../lib/postrunColors'
import { fmtNum } from '../lib/postrunFormat'
import { btnPrimaryClass } from '../ui/classes'
import { ExportFigure } from '../ui/ExportFigure'
import { recoveryColor } from './PostRunRecoveryViz'

const MODELS: [CompareModelKey, string, string][] = [
  ['molde', 'Molde', 'centro e dilatação livres (o modelo salvo)'],
  ['molde_c_fixo', 'Molde, centro fixo', 'ablação: só a dilatação solta'],
  ['molde_s_fixo', 'Molde, sem dilatação', 'ablação: só o centro solto'],
  ['cls', 'Molde rígido (CLS)', 'centro e dilatação fixos'],
  ['gauss', 'Gaussiana guiada', ''],
  ['bigauss', 'Bigaussiana guiada', ''],
  ['pmp008', 'Soma ponderada (Pawar e Kim, 2025)', 'moldes rígidos + fator de resposta médio dos puros'],
]

/** F6 do artigo: o mesmo conjunto (puros e misturas do estudo) ajustado por
 * vários modelos, sem gravar nada; cada modelo com as próprias curvas. */
export function PostRunModelCompare({ studyId }: { studyId: number }) {
  const [chosen, setChosen] = useState<Set<CompareModelKey>>(() => new Set(MODELS.map(([k]) => k)))
  const [result, setResult] = useState<CompareResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setMessage(null)
    try {
      setResult(await compareApi.run(studyId, MODELS.map(([k]) => k).filter((k) => chosen.has(k))))
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao comparar os modelos')
    } finally {
      setBusy(false)
    }
  }

  const mats = result ? [...new Set(result.models.flatMap((m) => Object.keys(m.recovery)))].sort() : []

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {MODELS.map(([k, label, hint]) => (
          <label key={k} className="flex items-center gap-1.5" title={hint}>
            <input
              type="checkbox"
              checked={chosen.has(k)}
              onChange={(e) =>
                setChosen((prev) => {
                  const next = new Set(prev)
                  if (e.target.checked) next.add(k)
                  else next.delete(k)
                  return next
                })
              }
            />
            {label}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimaryClass} disabled={busy || chosen.size === 0} onClick={() => void run()}>
          {busy ? 'Ajustando todos os modelos…' : 'Comparar modelos'}
        </button>
        <span className="text-xs text-[var(--color-text-muted)]">
          Nada é gravado. Pode levar alguns segundos por modelo (cada um reajusta puros e misturas).
        </span>
        {message && <span className="text-xs text-[var(--color-danger)]">{message}</span>}
      </div>

      {result && (
        <>
          <p className="text-xs text-[var(--color-text-muted)]">
            {result.n_pure} puro(s) e {result.n_mixtures} mistura(s). RMSE = raiz da média de (recuperação − 100)² em todos
            os componentes das misturas; o menor está destacado.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-[var(--color-text-muted)]">
                <tr>
                  <th className="py-1 pr-3">Modelo</th>
                  {mats.map((m) => (
                    <th key={m} className="py-1 pr-3">
                      <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: materialColor(m, mats) }} />
                      {m}
                    </th>
                  ))}
                  <th className="py-1 pr-3">Total</th>
                  <th className="py-1 pr-3">RMSE recuperação</th>
                  <th className="py-1 pr-3">RMSEP (mg)</th>
                  <th className="py-1 pr-3">BIC médio</th>
                  <th className="py-1 pr-3">R² médio</th>
                  <th className="py-1 pr-3" title="picos no limite da tolerância (não se aplica a parâmetro fixo)">no limite</th>
                </tr>
              </thead>
              <tbody>
                {result.models.map((m) => {
                  const best = m.key === result.best
                  return (
                    <tr key={m.key} className="border-t border-[var(--color-border)] align-top"
                      style={best ? { background: 'var(--color-row-selected)' } : undefined}>
                      <td className="py-1 pr-3 font-medium">
                        {m.label}
                        {best && <span className="ml-1 text-[10px] text-[var(--color-primary)]">menor RMSE</span>}
                        {m.n_failed > 0 && <span className="block text-[11px] text-[var(--color-danger)]">{m.n_failed} mistura(s) falharam</span>}
                        {m.errors.map((e) => (
                          <span key={e} className="block text-[10px] text-[var(--color-text-dim)]">{e}</span>
                        ))}
                      </td>
                      {mats.map((mat) => {
                        const r = m.recovery[mat]
                        return (
                          <td key={mat} className="py-1 pr-3 tabular-nums" style={{ color: recoveryColor(r?.mean ?? null) }}>
                            {r?.mean != null ? `${r.mean.toFixed(1)}${r.sd != null ? ` ± ${r.sd.toFixed(1)}` : ''} %` : '—'}
                          </td>
                        )
                      })}
                      <td className="py-1 pr-3 tabular-nums" style={{ color: recoveryColor(m.total_recovery.mean) }}>
                        {m.total_recovery.mean != null ? `${m.total_recovery.mean.toFixed(1)} %` : '—'}
                      </td>
                      <td className="py-1 pr-3 tabular-nums font-semibold">{m.rmse_recovery_pct != null ? `${m.rmse_recovery_pct.toFixed(2)} %` : '—'}</td>
                      <td className="py-1 pr-3 text-xs tabular-nums">
                        {Object.entries(m.rmsep_mg).map(([mat, v]) => (
                          <span key={mat} className="block">{mat} {fmtNum(v)}</span>
                        ))}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">{m.bic_mean != null ? m.bic_mean.toFixed(0) : '—'}</td>
                      <td className="py-1 pr-3 tabular-nums">{m.r2_mean != null ? m.r2_mean.toFixed(4) : '—'}</td>
                      <td className="py-1 pr-3 tabular-nums">{m.n_at_bound ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <RmseBars result={result} />
        </>
      )}
    </div>
  )
}

/** Barras: RMSE da recuperação por modelo (Fig. 4 do artigo). */
function RmseBars({ result }: { result: CompareResult }) {
  const rows = result.models.filter((m) => m.rmse_recovery_pct != null)
  if (!rows.length) return null
  const W = 560
  const L = 190
  const R = 60
  const ROW = 22
  const T = 8
  const H = T + rows.length * ROW + 30
  const vmax = Math.max(...rows.map((m) => m.rmse_recovery_pct as number)) * 1.1 || 1
  const sx = (v: number) => L + (v / vmax) * (W - L - R)
  const ticks = Array.from({ length: 5 }, (_, i) => (vmax * i) / 4)
  return (
    <ExportFigure name="comparacao_de_modelos_rmse" className="mx-auto w-full max-w-2xl">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="RMSE da recuperação por modelo">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={sx(t)} x2={sx(t)} y1={T} y2={H - 26} stroke="var(--color-border)" strokeWidth={0.6} />
            <text x={sx(t)} y={H - 12} textAnchor="middle" fontSize={10} fill="var(--color-text-muted)">{t.toFixed(t < 1 ? 2 : 1)}</text>
          </g>
        ))}
        {rows.map((m, i) => {
          const y = T + i * ROW
          const best = m.key === result.best
          return (
            <g key={m.key}>
              <text x={L - 6} y={y + ROW / 2 + 4} textAnchor="end" fontSize={11} fill="var(--color-text)" fontWeight={best ? 600 : 400}>{m.label}</text>
              <rect x={L} y={y + 4} width={Math.max(1, sx(m.rmse_recovery_pct as number) - L)} height={ROW - 8} rx={3}
                fill={best ? 'var(--color-primary)' : 'var(--color-text-dim)'} opacity={best ? 0.9 : 0.6} />
              <text x={sx(m.rmse_recovery_pct as number) + 4} y={y + ROW / 2 + 4} fontSize={10.5} fill="var(--color-text-muted)">
                {(m.rmse_recovery_pct as number).toFixed(2)} %
              </text>
            </g>
          )
        })}
        <text x={(L + W - R) / 2} y={H - 1} textAnchor="middle" fontSize={10.5} fill="var(--color-text-muted)">RMSE da recuperação (%)</text>
      </svg>
    </ExportFigure>
  )
}
