import { PEAK_COLORS } from '../lib/postrunColors'

/** Recuperação em destaque (pedido do usuário, 22/10/2026): cartões por
 * composição com a recuperação de cada componente em número grande, e um
 * gráfico de barras com a faixa 95–105 % e a linha dos 100 %. Usado no
 * Relatório e na aba Estudos. */

export interface RecoveryGroup {
  key: string
  n_runs: number
  total: { mean: number | null; sd: number | null }
  materials: { material: string; fraction: number | null; mean: number | null; sd: number | null; n: number }[]
}

const OK = '#1baf7a'
const WARN = '#eda100'
const BAD = '#e34948'

/** Verde: até ±5 % de 100; âmbar: até ±10 %; vermelho: além. */
export function recoveryColor(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return 'var(--color-text-muted)'
  const d = Math.abs(v - 100)
  return d <= 5 ? OK : d <= 10 ? WARN : BAD
}

function fmt(mean: number | null, sd: number | null): string {
  if (mean === null) return '—'
  return sd !== null ? `${mean.toFixed(1)} ± ${sd.toFixed(1)}` : mean.toFixed(1)
}

export function materialColors(groups: RecoveryGroup[]): (mat: string) => string {
  const mats = [...new Set(groups.flatMap((g) => g.materials.map((m) => m.material)))]
  return (mat) => PEAK_COLORS[Math.max(0, mats.indexOf(mat)) % PEAK_COLORS.length]
}

export function RecoveryKpis({ groups, compact = false }: { groups: RecoveryGroup[]; compact?: boolean }) {
  const colorOf = materialColors(groups)
  if (!groups.length) return null
  return (
    <div className={`grid gap-3 ${compact ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1 md:grid-cols-2 2xl:grid-cols-3'}`}>
      {groups.map((g) => (
        <div key={g.key} className="rounded-xl border p-3 border-[var(--color-border)] bg-[var(--color-bg)]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold">{g.key}</span>
            <span className="text-[11px] text-[var(--color-text-muted)]">{g.n_runs} réplica(s)</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {g.materials.map((m) => (
              <div key={m.material} className="flex flex-col">
                <span className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: colorOf(m.material) }} />
                  {m.material}
                  {m.fraction !== null && ` · ${(100 * m.fraction).toFixed(0)} %`}
                </span>
                <span className="text-2xl font-semibold tabular-nums leading-tight" style={{ color: recoveryColor(m.mean) }}>
                  {m.mean !== null ? `${m.mean.toFixed(1)} %` : '—'}
                </span>
                <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">
                  {m.sd !== null ? `± ${m.sd.toFixed(1)} % (dp, n=${m.n})` : m.n ? `n=${m.n}` : 'sem curva'}
                </span>
              </div>
            ))}
            {g.materials.length > 1 && (
              <div className="flex flex-col border-l pl-4 border-[var(--color-border)]">
                <span className="text-[11px] text-[var(--color-text-muted)]">total</span>
                <span className="text-2xl font-semibold tabular-nums leading-tight" style={{ color: recoveryColor(g.total.mean) }}>
                  {g.total.mean !== null ? `${g.total.mean.toFixed(1)} %` : '—'}
                </span>
                <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">
                  {g.total.sd !== null ? `± ${g.total.sd.toFixed(1)} %` : ''}
                </span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Barras horizontais: uma linha por componente de cada composição, com o
 * desvio-padrão, a faixa 95–105 % e a linha dos 100 %. */
export function RecoveryBars({ groups }: { groups: RecoveryGroup[] }) {
  const colorOf = materialColors(groups)
  const rows = groups.flatMap((g) => [
    { kind: 'head' as const, label: g.key },
    ...g.materials.map((m) => ({ kind: 'bar' as const, label: m.material, mean: m.mean, sd: m.sd, color: colorOf(m.material) })),
    ...(g.materials.length > 1
      ? [{ kind: 'bar' as const, label: 'total', mean: g.total.mean, sd: g.total.sd, color: 'var(--color-text-muted)' }]
      : []),
  ])
  if (!rows.length) return null
  const vals = rows.flatMap((r) => (r.kind === 'bar' && r.mean !== null ? [r.mean + (r.sd ?? 0)] : []))
  const xMax = Math.max(120, Math.ceil((Math.max(...vals, 0) + 5) / 10) * 10)
  const W = 560
  const L = 92
  const R = 54
  const ROW = 18
  const HEAD = 20
  const top = 6
  const H = top + rows.reduce((h, r) => h + (r.kind === 'head' ? HEAD : ROW), 0) + 24
  const sx = (v: number) => L + (Math.max(0, Math.min(v, xMax)) / xMax) * (W - L - R)
  let y = top
  const ticks = Array.from({ length: Math.floor(xMax / 20) + 1 }, (_, i) => i * 20)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: Math.max(160, H * 1.15) }} role="img" aria-label="Recuperação por componente">
      <rect x={sx(95)} y={top} width={sx(105) - sx(95)} height={H - top - 24} fill={OK} opacity={0.12} />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={sx(t)} x2={sx(t)} y1={top} y2={H - 24} stroke="var(--color-border)" strokeWidth={0.6} />
          <text x={sx(t)} y={H - 10} textAnchor="middle" fontSize={10} fill="var(--color-text-muted)">{t}</text>
        </g>
      ))}
      <line x1={sx(100)} x2={sx(100)} y1={top} y2={H - 24} stroke="var(--color-text)" strokeDasharray="4 3" strokeWidth={1} />
      {rows.map((r, i) => {
        const y0 = y
        y += r.kind === 'head' ? HEAD : ROW
        if (r.kind === 'head')
          return (
            <text key={i} x={4} y={y0 + 14} fontSize={11} fontWeight={600} fill="var(--color-text)">{r.label}</text>
          )
        const cy = y0 + ROW / 2
        return (
          <g key={i}>
            <text x={L - 6} y={cy + 4} textAnchor="end" fontSize={10.5} fill="var(--color-text-muted)">{r.label}</text>
            {r.mean !== null && (
              <>
                <rect x={L} y={cy - 5.5} width={Math.max(0, sx(r.mean) - L)} height={11} rx={3} fill={r.color} opacity={0.85} />
                {r.sd !== null && (
                  <g stroke="var(--color-text)" strokeWidth={1}>
                    <line x1={sx(r.mean - r.sd)} x2={sx(r.mean + r.sd)} y1={cy} y2={cy} />
                    <line x1={sx(r.mean - r.sd)} x2={sx(r.mean - r.sd)} y1={cy - 4} y2={cy + 4} />
                    <line x1={sx(r.mean + r.sd)} x2={sx(r.mean + r.sd)} y1={cy - 4} y2={cy + 4} />
                  </g>
                )}
                <text x={W - R + 4} y={cy + 4} fontSize={10.5} fontWeight={600} fill={recoveryColor(r.mean)} className="tabular-nums">
                  {fmt(r.mean, null)} %
                </text>
              </>
            )}
          </g>
        )
      })}
      <text x={W - R} y={H - 10} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">recuperação (%)</text>
    </svg>
  )
}

/** Converte os grupos do relatório no formato dos cartões/barras. */
export function groupsFromReport(groups: {
  key: string
  n_runs: number
  total_recovery_pct: { mean: number | null; sd: number | null }
  materials: { material: string; fraction: number | null; recovery_pct: { mean: number | null; sd: number | null; n: number } }[]
}[]): RecoveryGroup[] {
  return groups.map((g) => ({
    key: g.key,
    n_runs: g.n_runs,
    total: { mean: g.total_recovery_pct.mean, sd: g.total_recovery_pct.sd },
    materials: g.materials.map((m) => ({ material: m.material, fraction: m.fraction, mean: m.recovery_pct.mean, sd: m.recovery_pct.sd, n: m.recovery_pct.n })),
  }))
}
