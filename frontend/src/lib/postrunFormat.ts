/** Número curto para tabelas e eixos do PostRun: notação científica para
 * áreas grandes (4,9e+06), vírgula decimal. */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(2).replace('.', ',')
  return Number(v.toPrecision(4)).toLocaleString('pt-BR')
}
