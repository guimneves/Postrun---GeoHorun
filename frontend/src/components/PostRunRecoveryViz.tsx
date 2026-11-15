import type { ReactNode } from 'react'
import { materialColor } from '../lib/postrunColors'
import { ExportFigure } from '../ui/ExportFigure'

/** Recuperação em destaque (pedido do usuário, 22/10/2026): cartões por
 * composição com a recuperação de cada componente em número grande, e um
 * gráfico de barras com a faixa 95–105 % e a linha dos 100 %. Usado no
 * Relatório e na aba Estudos.
 *
 * F1 do artigo: lado a lado, (1) cada componente, (2) as poliolefinas somadas
 * (PEAD + PP), quando a mistura tem duas ou mais, e (3) o total = Σ massas
 * encontradas ÷ massa pesada — cada um com média ± DP e o n de réplicas
 * válidas (com curva para todos os componentes envolvidos). */

export interface RecoveryStat {
  mean: number | null
  sd: number | null
  n: number
}

export interface RecoveryGroup {
  key: string
  n_runs: number
  total: RecoveryStat
  /** poliolefinas somadas; null = não se aplica */
  polyolefins: (RecoveryStat & { label: string }) | null
  materials: ({ material: string; fraction: number | null } & RecoveryStat)[]
}

export const TOTAL_HELP = 'total = soma das massas encontradas ÷ massa pesada da corrida'
export const POLY_HELP =
  'poliolefinas somadas: os picos de PEAD e PP se sobrepõem na pirólise; a divisão da área entre eles é incerta, a soma não'

/** "n=3" ou "n=2 de 3" quando alguma réplica não entrou. */
export function nValid(n: number, nRuns: number): string {
  return n === nRuns ? `n=${n}` : `n=${n} de ${nRuns}`
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
  return (mat) => materialColor(mat, mats)  // F5: cor fixa por polímero
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
              <Kpi
                key={m.material}
                label={
                  <>
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: colorOf(m.material) }} />
                    {m.material}
                    {m.fraction !== null && ` · ${(100 * m.fraction).toFixed(0)} %`}
                  </>
                }
                stat={m}
                nRuns={g.n_runs}
                empty="sem curva"
              />
            ))}
            {g.polyolefins && (
              <Kpi label={g.polyolefins.label} stat={g.polyolefins} nRuns={g.n_runs} title={POLY_HELP} divider />
            )}
            {g.materials.length > 1 && (
              <Kpi label="total" stat={g.total} nRuns={g.n_runs} title={TOTAL_HELP} divider={!g.polyolefins} />
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function Kpi({
  label,
  stat,
  nRuns,
  title,
  empty = '',
  divider = false,
}: {
  label: ReactNode
  stat: RecoveryStat
  nRuns: number
  title?: string
  empty?: string
  divider?: boolean
}) {
  return (
    <div className={`flex flex-col ${divider ? 'border-l border-[var(--color-border)] pl-4' : ''}`} title={title}>
      <span className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">{label}</span>
      <span className="text-2xl font-semibold tabular-nums leading-tight" style={{ color: recoveryColor(stat.mean) }}>
        {stat.mean !== null ? `${stat.mean.toFixed(1)} %` : '—'}
      </span>
      <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">
        {stat.mean === null
          ? empty
          : `${stat.sd !== null ? `± ${stat.sd.toFixed(1)} % · ` : ''}${nValid(stat.n, nRuns)}`}
      </span>
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
    ...(g.polyolefins
      ? [{ kind: 'bar' as const, label: g.polyolefins.label, mean: g.polyolefins.mean, sd: g.polyolefins.sd, color: 'var(--color-text-dim)' }]
      : []),
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
    <ExportFigure name="recuperacao_por_componente">
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
    </ExportFigure>
  )
}

/** Converte os grupos do relatório no formato dos cartões/barras. */
export function groupsFromReport(groups: {
  key: string
  n_runs: number
  total_recovery_pct: RecoveryStat
  polyolefins?: string[]
  polyolefins_recovery_pct?: RecoveryStat
  materials: { material: string; fraction: number | null; recovery_pct: RecoveryStat }[]
}[]): RecoveryGroup[] {
  return groups.map((g) => ({
    key: g.key,
    n_runs: g.n_runs,
    total: { ...g.total_recovery_pct },
    polyolefins:
      g.polyolefins && g.polyolefins.length >= 2 && g.polyolefins_recovery_pct
        ? { label: g.polyolefins.join(' + '), ...g.polyolefins_recovery_pct }
        : null,
    materials: g.materials.map((m) => ({ material: m.material, fraction: m.fraction, ...m.recovery_pct })),
  }))
}
