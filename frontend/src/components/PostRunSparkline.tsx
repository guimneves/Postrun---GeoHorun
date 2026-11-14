const W = 92
const H = 26
const PAD = 2

/** Miniatura do sinal de FID de pirólise (pedido do usuário): bater o olho
 * na lista e descartar rápido as corridas ruins. `values` são ~48 pontos
 * já normalizados 0-1 pelo backend. SVG desenhado à mão, sem lib, mesmo
 * estilo do resto do PostRun. A linha fininha em baixo é a base — "reta
 * colada na base = corrida sem sinal" salta aos olhos. */
export function PostRunSparkline({
  values,
  error,
  loading,
}: {
  values: number[] | null | undefined
  error?: string | null
  loading?: boolean
}) {
  if (loading) {
    return <span className="inline-block h-[26px] w-[92px] rounded bg-[var(--color-surface)]" />
  }
  if (error || !values || values.length === 0) {
    return (
      <span
        className="inline-flex h-[26px] w-[92px] items-center justify-center rounded border text-[9px] text-[var(--color-text-dim)] border-[var(--color-border)]"
        title={error ?? 'sem miniatura'}
      >
        —
      </span>
    )
  }

  const plotW = W - 2 * PAD
  const plotH = H - 2 * PAD
  const x = (i: number) => PAD + (i / Math.max(1, values.length - 1)) * plotW
  const y = (v: number) => PAD + (1 - v) * plotH
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' ')

  // heurística leve só pra cor: pico muito baixo = provável corrida ruim
  const peak = Math.max(...values)
  const flat = peak < 0.15
  const stroke = flat ? 'var(--color-danger)' : 'var(--color-flame, #ff6a35)'

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[26px] w-[92px] shrink-0" preserveAspectRatio="none">
      <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} stroke="var(--color-border)" strokeWidth={1} />
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.2} />
    </svg>
  )
}
