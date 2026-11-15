import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import {
  studyApi,
  type AnalysisSummary,
  type DeconvMethod,
  type ValidationConfig,
  type ValidationReport,
  type ValidationRole,
} from '../api/postrun'
import { materialColor } from '../lib/postrunColors'
import { fmtNum } from '../lib/postrunFormat'
import { btnClass, btnPrimaryClass } from '../ui/classes'
import { Segmented } from '../ui/Segmented'
import { recoveryColor } from './PostRunRecoveryViz'
import { ExportFigure } from '../ui/ExportFigure'

type RoleChoice = ValidationRole | 'nenhum'

const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '—' : `${v.toFixed(d)} %`)

/** F3 do artigo: validação independente dentro do estudo — papel de cada
 * análise (calibração × validação, nunca as duas), modo cego, métricas
 * (RMSEP, viés, recuperação, precisão intermediária por ANOVA com o dia como
 * fator) e o gráfico encontrada × adicionada com a reta 1:1 e a banda de U95. */
export function PostRunValidationPanel({
  studyId,
  analyses,
  method,
  editable,
}: {
  studyId: number
  analyses: { token: string; summary: AnalysisSummary | null }[]
  method: DeconvMethod
  editable: boolean
}) {
  const [config, setConfig] = useState<ValidationConfig | null>(null)
  const [roles, setRoles] = useState<Record<string, RoleChoice>>({})
  const [report, setReport] = useState<ValidationReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setReport(null)
    setMessage(null)
    studyApi
      .validationConfig(studyId)
      .then((c) => {
        setConfig(c)
        setRoles(c.roles)
      })
      .catch(() => setConfig(null))
  }, [studyId])

  const revealed = !!config?.revealed_at
  const hidden = !!config?.blind && !revealed
  const dirty = useMemo(() => {
    const a = Object.entries(roles).filter(([, r]) => r !== 'nenhum')
    const b = Object.entries(config?.roles ?? {})
    return a.length !== b.length || a.some(([t, r]) => config?.roles[t] !== r)
  }, [roles, config])
  const count = (r: ValidationRole) => Object.values(roles).filter((x) => x === r).length

  async function act<T>(fn: () => Promise<T>, ok?: string): Promise<T | null> {
    setBusy(true)
    setMessage(null)
    try {
      const r = await fn()
      if (ok) setMessage(ok)
      return r
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro na validação')
      return null
    } finally {
      setBusy(false)
    }
  }

  async function save(blind = config?.blind ?? false) {
    const clean = Object.fromEntries(Object.entries(roles).filter(([, r]) => r !== 'nenhum')) as Record<string, ValidationRole>
    const c = await act(() => studyApi.setValidationConfig(studyId, { roles: clean, blind }), 'Papéis guardados.')
    if (c) {
      setConfig(c)
      setRoles(c.roles)
      setReport(null)
    }
  }

  async function quantify() {
    const r = await act(() => studyApi.validation(studyId, method))
    if (r) setReport(r)
  }

  async function reveal() {
    if (
      !window.confirm(
        'Revelar as composições e as massas adicionadas? As massas encontradas agora ficam guardadas como a resposta cega, ' +
          'e o conjunto de validação fica travado. Não dá para voltar.',
      )
    )
      return
    const r = await act(() => studyApi.revealValidation(studyId, method), 'Respostas reveladas.')
    if (r) {
      setReport(r)
      setConfig(r.config)
    }
  }

  const sorted = useMemo(
    () => [...analyses].sort((a, b) => (a.summary?.filename ?? a.token).localeCompare(b.summary?.filename ?? b.token)),
    [analyses],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-[var(--color-surface)] px-2.5 py-1">
          {count('calibracao')} calibração · {count('validacao')} validação
        </span>
        {config?.blind && (
          <span
            className="rounded-full px-2.5 py-1 font-medium"
            style={{ background: 'var(--color-primary-soft)', color: 'var(--color-primary)' }}
          >
            {revealed
              ? `modo cego · revelado em ${new Date(config.revealed_at as string).toLocaleString('pt-BR')} por ${config.revealed_by}`
              : 'modo cego ligado'}
          </span>
        )}
        {message && <span className="text-[var(--color-text-muted)]">{message}</span>}
      </div>

      {/* papéis */}
      <details className="rounded-xl border border-[var(--color-border)] p-3" open={!config || Object.keys(config.roles).length === 0}>
        <summary className="cursor-pointer text-sm font-medium">Papel de cada análise</summary>
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          <strong>Calibração</strong>: as corridas das curvas. <strong>Validação</strong>: corridas independentes,
          quantificadas pelas curvas e comparadas com a massa pesada. Uma corrida tem um papel só; se uma de validação for
          ponto de uma curva, ela sai das métricas.
          {hidden && ' No modo cego, os nomes das corridas de validação ficam escondidos.'}
        </p>
        <div className="mt-2 max-h-[300px] overflow-auto">
          <table className="w-full text-left text-sm">
            <tbody>
              {sorted.map((a) => {
                const role = roles[a.token] ?? 'nenhum'
                const masked = hidden && config?.roles[a.token] === 'validacao'
                return (
                  <tr key={a.token} className="border-t border-[var(--color-border)]">
                    <td className="py-1 pr-3">
                      {masked ? (
                        <span className="italic text-[var(--color-text-dim)]">corrida de validação (nome escondido)</span>
                      ) : (
                        <>
                          <span className="block">{a.summary?.sample ?? a.token}</span>
                          <span className="block font-mono text-[10px] text-[var(--color-text-dim)]">{a.summary?.filename}</span>
                        </>
                      )}
                    </td>
                    <td className="py-1 text-right">
                      <Segmented
                        size="xs"
                        ariaLabel="papel"
                        value={role}
                        onChange={(v) => setRoles((prev) => ({ ...prev, [a.token]: v }))}
                        options={[
                          { value: 'nenhum', label: '—', disabled: !editable || revealed },
                          { value: 'calibracao', label: 'calibração', disabled: !editable || (revealed && role === 'validacao') },
                          { value: 'validacao', label: 'validação', disabled: !editable || revealed },
                        ]}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {editable && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={btnClass} disabled={busy || !dirty} onClick={() => void save()}>
              Guardar papéis
            </button>
            {!revealed && (
              <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
                <input type="checkbox" checked={!!config?.blind} disabled={busy} onChange={(e) => void save(e.target.checked)} />
                modo cego — esconder composição, massa adicionada e recuperação das corridas de validação até revelar
              </label>
            )}
          </div>
        )}
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimaryClass} disabled={busy || count('validacao') === 0} onClick={() => void quantify()}>
          Quantificar a validação
        </button>
        {hidden && report && editable && (
          <button type="button" className={btnClass} disabled={busy} onClick={() => void reveal()}>
            Revelar as respostas…
          </button>
        )}
      </div>

      {report && <ValidationResult report={report} />}
    </div>
  )
}

function ValidationResult({ report }: { report: ValidationReport }) {
  const mats = [...new Set(report.runs.flatMap((r) => r.materials.map((m) => m.material)))]
  const colorOf = (m: string) => materialColor(m, mats)  // F5: cor fixa por polímero
  return (
    <div className="flex flex-col gap-3">
      {[...report.conflicts, ...report.warnings].length > 0 && (
        <ul className="list-disc pl-5 text-xs text-[var(--color-warning)]">
          {[...report.conflicts, ...report.warnings].map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {report.metrics.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-[var(--color-text-muted)]">
              <tr>
                <th className="py-1 pr-3">Material</th>
                <th className="py-1 pr-3">n (dias)</th>
                <th className="py-1 pr-3">Recuperação</th>
                <th className="py-1 pr-3">Viés</th>
                <th className="py-1 pr-3">RMSEP</th>
                <th className="py-1 pr-3" title="ANOVA de um fator, dia como fator, sobre a recuperação %">
                  s_r · s_entre dias · s_PI
                </th>
                <th className="py-1 pr-3">Encontrada = a + b × adicionada</th>
              </tr>
            </thead>
            <tbody>
              {report.metrics.map((m) => (
                <tr key={m.material} className="border-t border-[var(--color-border)] align-top">
                  <td className="py-1 pr-3 font-medium">
                    <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full" style={{ background: colorOf(m.material) }} />
                    {m.material}
                  </td>
                  <td className="py-1 pr-3 tabular-nums">
                    {m.n} ({m.n_days})
                  </td>
                  <td className="py-1 pr-3 tabular-nums font-semibold" style={{ color: recoveryColor(m.recovery_mean) }}>
                    {m.recovery_mean.toFixed(1)}
                    {m.recovery_sd !== null ? ` ± ${m.recovery_sd.toFixed(1)}` : ''} %
                  </td>
                  <td className="py-1 pr-3 tabular-nums">
                    {m.bias_mg >= 0 ? '+' : ''}
                    {fmtNum(m.bias_mg)} mg
                    <span className="block text-[11px] text-[var(--color-text-muted)]">
                      {m.bias_pct >= 0 ? '+' : ''}
                      {m.bias_pct.toFixed(1)} %
                    </span>
                  </td>
                  <td className="py-1 pr-3 tabular-nums">{fmtNum(m.rmsep_mg)} mg</td>
                  <td className="py-1 pr-3 tabular-nums">
                    {pct(m.anova.s_r)} · {pct(m.anova.s_between)} · <strong>{pct(m.anova.s_ip)}</strong>
                    {m.anova.warnings.map((w) => (
                      <span key={w} className="block text-[10px] text-[var(--color-text-dim)]">
                        {w}
                      </span>
                    ))}
                  </td>
                  <td className="py-1 pr-3 tabular-nums text-xs">
                    {m.slope !== null && m.intercept !== null
                      ? `${fmtNum(m.intercept)} + ${m.slope.toFixed(3)} × m (R² ${m.r2?.toFixed(4) ?? '—'})`
                      : '— (precisa de 3+ pontos com massas adicionadas diferentes)'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.points.length > 0 && <FoundVsAdded report={report} colorOf={colorOf} />}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-[var(--color-text-muted)]">
            <tr>
              <th className="py-1 pr-3">Corrida</th>
              <th className="py-1 pr-3">Dia</th>
              <th className="py-1 pr-3">Material</th>
              <th className="py-1 pr-3">Encontrada (mg)</th>
              <th className="py-1 pr-3">Adicionada (mg)</th>
              <th className="py-1 pr-3">Recuperação</th>
            </tr>
          </thead>
          <tbody>
            {report.runs.map((r) =>
              (r.materials.length ? r.materials : [null]).map((m, i) => (
                <tr key={`${r.code}|${m?.material ?? ''}`} className={i === 0 ? 'border-t border-[var(--color-border)]' : ''}
                  style={!r.included ? { opacity: 0.55 } : undefined}>
                  {i === 0 && (
                    <>
                      <td className="py-1 pr-3 align-top" rowSpan={Math.max(1, r.materials.length)}>
                        <span className="font-mono text-xs">{r.label}</span>
                        {r.reason && <span className="block text-[11px] text-[var(--color-warning)]">{r.reason}</span>}
                        {r.changed_since_reveal && (
                          <span className="block text-[11px] text-[var(--color-danger)]">mudou depois da revelação</span>
                        )}
                      </td>
                      <td className="py-1 pr-3 align-top text-xs" rowSpan={Math.max(1, r.materials.length)}>{r.day}</td>
                    </>
                  )}
                  <td className="py-1 pr-3">{m?.material ?? '—'}</td>
                  <td className="py-1 pr-3 tabular-nums">
                    {m?.found_mg != null ? `${fmtNum(m.found_mg)}${m.U95_mg != null ? ` ± ${fmtNum(m.U95_mg)}` : ''}` : '—'}
                  </td>
                  <td className="py-1 pr-3 tabular-nums">{report.hidden ? '•••' : m?.added_mg != null ? fmtNum(m.added_mg) : '—'}</td>
                  <td className="py-1 pr-3 tabular-nums" style={{ color: recoveryColor(m?.recovery_pct ?? null) }}>
                    {report.hidden ? '•••' : pct(m?.recovery_pct)}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Encontrada × adicionada: reta 1:1, regressão de cada material, banda de
 * ± U95 relativo médio em torno da 1:1 e barras de U95 em cada ponto. */
function FoundVsAdded({ report, colorOf }: { report: ValidationReport; colorOf: (m: string) => string }) {
  const W = 520
  const H = 360
  const L = 56
  const B = 44
  const T = 12
  const R = 14
  const vmax = Math.max(...report.points.flatMap((p) => [p.added_mg, p.found_mg + (p.U95_mg ?? 0)])) * 1.08 || 1
  const sx = (v: number) => L + (v / vmax) * (W - L - R)
  const sy = (v: number) => H - B - (v / vmax) * (H - B - T)
  const ticks = Array.from({ length: 6 }, (_, i) => (vmax * i) / 5)
  const relU = report.metrics.map((m) => m.mean_rel_U95_pct).filter((v): v is number => v !== null)
  const band = relU.length ? relU.reduce((a, b) => a + b, 0) / relU.length / 100 : null
  return (
    <div className="flex flex-col items-center">
      <ExportFigure name="encontrada_x_adicionada" className="w-full max-w-xl">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Massa encontrada × adicionada">
        {band !== null && (
          <polygon
            points={`${sx(0)},${sy(0)} ${sx(vmax)},${sy(vmax * (1 + band))} ${sx(vmax)},${sy(vmax * (1 - band))}`}
            fill="var(--color-primary)"
            opacity={0.1}
          />
        )}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={sx(t)} x2={sx(t)} y1={T} y2={H - B} stroke="var(--color-border)" strokeWidth={0.6} />
            <line x1={L} x2={W - R} y1={sy(t)} y2={sy(t)} stroke="var(--color-border)" strokeWidth={0.6} />
            <text x={sx(t)} y={H - B + 16} textAnchor="middle" fontSize={10} fill="var(--color-text-muted)">{fmtNum(t)}</text>
            <text x={L - 6} y={sy(t) + 3} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">{fmtNum(t)}</text>
          </g>
        ))}
        <line x1={sx(0)} y1={sy(0)} x2={sx(vmax)} y2={sy(vmax)} stroke="var(--color-text)" strokeDasharray="5 4" strokeWidth={1} />
        {report.metrics.map((m) =>
          m.slope !== null && m.intercept !== null ? (
            <line key={m.material} x1={sx(0)} y1={sy(m.intercept)} x2={sx(vmax)} y2={sy(m.intercept + m.slope * vmax)}
              stroke={colorOf(m.material)} strokeWidth={1.4} opacity={0.8} />
          ) : null,
        )}
        {report.points.map((p, i) => (
          <g key={i}>
            {p.U95_mg !== null && (
              <line x1={sx(p.added_mg)} x2={sx(p.added_mg)} y1={sy(p.found_mg - p.U95_mg)} y2={sy(p.found_mg + p.U95_mg)}
                stroke={colorOf(p.material)} strokeWidth={1} />
            )}
            <circle cx={sx(p.added_mg)} cy={sy(p.found_mg)} r={3.6} fill={colorOf(p.material)}>
              <title>{`${p.material}: adicionada ${fmtNum(p.added_mg)} mg · encontrada ${fmtNum(p.found_mg)} mg`}</title>
            </circle>
          </g>
        ))}
        <text x={(L + W - R) / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--color-text-muted)">massa adicionada (mg)</text>
        <text x={14} y={(T + H - B) / 2} textAnchor="middle" fontSize={11} fill="var(--color-text-muted)"
          transform={`rotate(-90 14 ${(T + H - B) / 2})`}>massa encontrada (mg)</text>
      </svg>
      </ExportFigure>
      <p className="text-center text-[11px] text-[var(--color-text-muted)]">
        tracejada = 1:1 · linhas coloridas = regressão de cada material · barras = U95 de cada ponto
        {band !== null && ` · faixa = ± ${(100 * band).toFixed(1)} % (U95 relativo médio)`}
      </p>
    </div>
  )
}
