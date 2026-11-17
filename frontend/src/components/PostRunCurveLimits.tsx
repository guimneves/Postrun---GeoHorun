import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { postrunApi, type AnalysisSummary, type LimitsOut, type SavedCurve } from '../api/postrun'
import { fmtNum } from '../lib/postrunFormat'
import { btnPrimaryClass, cardClass, inputClass } from '../ui/classes'
import { Segmented } from '../ui/Segmented'

type Role = 'fora' | 'branco' | 'baixo'

/** Nome com "branco" ou "blank": já vem marcado como branco. A matriz pode
 * ser qualquer uma (areia, sedimento, solo, sílica…) — não se supõe nenhuma
 * pelo nome (16/11/2026); o resto a pessoa marca. */
function looksLikeBlank(a: AnalysisSummary | undefined): boolean {
  if (!a) return false
  const text = `${a.sample} ${a.filename}`.toUpperCase()
  return /BRANCO|BLANK/.test(text)
}

function fmtPpm(v: number | null): string {
  if (v === null) return '—'
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)
}

/** F2 do artigo: brancos de matriz → LoB/LoD/LoQ (Armbruster & Pry) e LD/LQ
 * da curva, em mg e em ppm (µg/g de matriz). Os brancos e as réplicas de nível
 * baixo vêm das análises abertas; o resultado fica guardado na curva. */
export function PostRunCurveLimits({
  curve,
  openTokens,
  analysesByToken,
  onSaved,
}: {
  curve: SavedCurve
  openTokens: string[]
  analysesByToken: Record<string, AnalysisSummary>
  onSaved: () => void
}) {
  const curveTokens = useMemo(() => new Set(curve.points.map((p) => p.token)), [curve])
  // candidatas: análises abertas que não são pontos da curva
  const candidates = useMemo(() => openTokens.filter((t) => !curveTokens.has(t)), [openTokens, curveTokens])
  const saved = curve.limits ?? null

  const [roles, setRoles] = useState<Record<string, Role>>({})
  const [matrix, setMatrix] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [result, setResult] = useState<LimitsOut | null>(saved)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // ao trocar de curva: começa do que está guardado nela
  useEffect(() => {
    setResult(curve.limits ?? null)
    const init: Record<string, Role> = {}
    for (const b of curve.limits?.blanks ?? []) init[b.token] = 'branco'
    for (const b of curve.limits?.low ?? []) init[b.token] = 'baixo'
    setRoles(init)
    setMatrix(curve.limits?.matrix_mass_source === 'informada' ? String(curve.limits.matrix_mass_mg ?? '') : '')
    setStart(curve.limits ? String(curve.limits.start_idx) : '')
    setEnd(curve.limits ? String(curve.limits.end_idx) : '')
    setMessage(null)
  }, [curve])

  const roleOf = (t: string): Role => roles[t] ?? (looksLikeBlank(analysesByToken[t]) ? 'branco' : 'fora')
  const rows = useMemo(() => {
    const extra = Object.keys(roles).filter((t) => !candidates.includes(t) && roles[t] !== 'fora')
    return [...candidates, ...extra]
  }, [candidates, roles])
  const blanks = rows.filter((t) => roleOf(t) === 'branco')
  const low = rows.filter((t) => roleOf(t) === 'baixo')

  async function compute() {
    setBusy(true)
    setMessage(null)
    const num = (v: string) => (v.trim() ? Number(v.replace(',', '.')) : null)
    try {
      const out = await postrunApi.curveLimits(curve.id, {
        blank_tokens: blanks,
        low_tokens: low,
        matrix_mass_mg: num(matrix),
        start_idx: num(start),
        end_idx: num(end),
        save: true,
      })
      setResult(out)
      setStart(String(out.start_idx))
      setEnd(String(out.end_idx))
      onSaved()
      setMessage('Limites calculados e guardados na curva.')
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro ao calcular os limites')
    } finally {
      setBusy(false)
    }
  }

  const runOf = (t: string) => result?.blanks.find((b) => b.token === t) ?? result?.low.find((b) => b.token === t)

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">Brancos de matriz e limites (mg e ppm)</h3>
        {saved && (
          <span className="text-xs text-[var(--color-text-muted)]">
            guardado em {new Date(saved.computed_at).toLocaleString('pt-BR')}
          </span>
        )}
      </div>
      <p className="mb-3 mt-1 text-xs text-[var(--color-text-muted)]">
        Abra na aba Análises as corridas de <strong>branco da matriz</strong> — a matriz das suas amostras sem o analito
        (areia, sedimento, solo, sílica… o que for o caso) — e, se tiver, as réplicas de uma amostra de{' '}
        <strong>baixa concentração</strong>; depois marque o papel de cada uma. Cada corrida é integrada no intervalo da curva e
        convertida em massa aparente pela própria curva. Só corridas com "branco" ou "blank" no nome já vêm marcadas; as
        outras você marca.
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          Nenhuma análise aberta fora dos pontos da curva. Abra os brancos na aba Análises.
        </p>
      ) : (
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-[var(--color-text-muted)]">
              <tr>
                <th className="py-1 pr-3">Corrida</th>
                <th className="py-1 pr-3">Papel</th>
                <th className="py-1 pr-3">Massa no arquivo (mg)</th>
                <th className="py-1 pr-3">Área (sinal·s)</th>
                <th className="py-1 pr-3">Massa aparente (mg)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const a = analysesByToken[t]
                const r = runOf(t)
                return (
                  <tr key={t} className="border-t border-[var(--color-border)] align-top">
                    <td className="py-1 pr-3">
                      <span className="block">{a?.sample ?? r?.sample ?? t}</span>
                      <span className="block font-mono text-[10px] text-[var(--color-text-dim)]">{a?.filename ?? t.split('/').pop()}</span>
                      {r?.error && <span className="block text-xs text-[var(--color-danger)]">{r.error}</span>}
                    </td>
                    <td className="py-1 pr-3">
                      <Segmented
                        size="xs"
                        ariaLabel={`papel de ${a?.filename ?? t}`}
                        value={roleOf(t)}
                        onChange={(v) => setRoles((prev) => ({ ...prev, [t]: v }))}
                        options={[
                          { value: 'fora', label: 'fora' },
                          { value: 'branco', label: 'branco' },
                          { value: 'baixo', label: 'nível baixo' },
                        ]}
                      />
                    </td>
                    <td className="py-1 pr-3 tabular-nums">{a ? fmtNum(a.mass_mg) : '—'}</td>
                    <td className="py-1 pr-3 tabular-nums">{r?.area_s != null ? fmtNum(r.area_s) : '—'}</td>
                    <td className="py-1 pr-3 tabular-nums">{r?.apparent_mg != null ? fmtNum(r.apparent_mg) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Massa de matriz por cadinho (mg)
          <input
            className={`${inputClass} w-44`}
            inputMode="decimal"
            value={matrix}
            onChange={(e) => setMatrix(e.target.value)}
            placeholder="vazio = média dos brancos"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Início (idx)
          <input className={`${inputClass} w-24`} inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value)} placeholder="da curva" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Fim (idx)
          <input className={`${inputClass} w-24`} inputMode="numeric" value={end} onChange={(e) => setEnd(e.target.value)} placeholder="da curva" />
        </label>
        <button type="button" className={btnPrimaryClass} onClick={() => void compute()} disabled={busy || blanks.length < 2}>
          Calcular limites ({blanks.length} branco{blanks.length === 1 ? '' : 's'}
          {low.length ? ` · ${low.length} nível baixo` : ''})
        </button>
        {message && <span className="text-xs text-[var(--color-text-muted)]">{message}</span>}
      </div>
      {blanks.length > 0 && blanks.length < 10 && (
        <p className="mt-2 text-xs text-[var(--color-warning)]">
          Menos de 10 brancos: o desvio-padrão do branco fica pouco confiável.
        </p>
      )}

      {result && (
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-[var(--color-text-muted)]">
                <tr>
                  <th className="py-1 pr-3">Limite</th>
                  <th className="py-1 pr-3">mg</th>
                  <th className="py-1 pr-3">ppm (µg/g)</th>
                  <th className="py-1 pr-3">Critério</th>
                </tr>
              </thead>
              <tbody>
                {result.limits.map((l) => (
                  <tr key={l.key} className="border-t border-[var(--color-border)]">
                    <td className="py-1 pr-3 font-semibold">{l.label}</td>
                    <td className="py-1 pr-3 tabular-nums">{l.mg !== null ? fmtNum(l.mg) : '—'}</td>
                    <td className="py-1 pr-3 tabular-nums">{fmtPpm(l.ppm)}</td>
                    <td className="py-1 pr-3 text-xs text-[var(--color-text-muted)]">{l.criterion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="grid grid-cols-[auto_1fr] content-start gap-x-3 gap-y-1 rounded-xl bg-[var(--color-surface)] p-3 text-xs">
            <dt className="text-[var(--color-text-muted)]">Brancos</dt>
            <dd className="tabular-nums">
              n={result.n_blanks} · {fmtNum(result.blank_mean_mg)} ± {fmtNum(result.blank_sd_mg)} mg
            </dd>
            <dt className="text-[var(--color-text-muted)]">Nível baixo</dt>
            <dd className="tabular-nums">
              {result.n_low ? `n=${result.n_low}${result.low_sd_mg !== null ? ` · σ ${fmtNum(result.low_sd_mg)} mg` : ''}` : '—'}
            </dd>
            <dt className="text-[var(--color-text-muted)]">Matriz</dt>
            <dd className="tabular-nums">
              {result.matrix_mass_mg !== null ? `${fmtNum(result.matrix_mass_mg)} mg (${result.matrix_mass_source})` : '—'}
            </dd>
            <dt className="text-[var(--color-text-muted)]">Intervalo</dt>
            <dd className="tabular-nums">
              idx {result.start_idx}–{result.end_idx} · linha de base {result.baseline_mode === 'linear' ? 'linear' : 'fixa'}
            </dd>
          </dl>
          {result.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-[var(--color-warning)] lg:col-span-2">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
