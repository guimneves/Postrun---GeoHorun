import type { ScanStatus } from '../api/postrun'

/** Progresso da leitura em segundo plano + "Verificar novamente". */
export function PostRunScanBar({ status, onRescan }: { status: ScanStatus | null; onRescan: () => void }) {
  if (!status) return null
  const running = status.state === 'running'
  const pct = status.total > 0 ? Math.round((100 * status.read) / status.total) : 0
  let text: string
  if (running && status.listing) text = 'Procurando as análises do job no equipamento…'
  else if (running)
    text = `Lendo em segundo plano: ${status.read} de ${status.total} — já dá para trabalhar nas que aparecem.`
  else if (status.state === 'error') text = `Leitura interrompida: ${status.error ?? 'erro'}.`
  else
    text =
      `${status.read} de ${status.total} análise(s) lida(s)` +
      (status.failed ? ` · ${status.failed} não responderam — toque em Verificar novamente` : '') +
      '.'
  return (
    <div
      className="flex flex-col gap-1 rounded-lg px-2 py-1.5 text-xs"
      style={{
        background: 'var(--color-surface)',
        color: status.state === 'error' ? 'var(--color-danger)' : 'var(--color-text-muted)',
      }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2">
        <span>{text}</span>
        <button
          type="button"
          className="shrink-0 rounded border px-2 py-0.5 text-[var(--color-primary)] border-[var(--color-border)] hover:bg-[var(--color-bg)] disabled:opacity-40"
          onClick={onRescan}
          disabled={running}
          title="procura análises novas no equipamento e lê, em segundo plano, as que ainda não chegaram"
        >
          Verificar novamente
        </button>
      </div>
      {running && !status.listing && status.total > 0 && (
        <div className="h-1 w-full overflow-hidden rounded" style={{ background: 'var(--color-border)' }}>
          <div className="h-full" style={{ width: `${pct}%`, background: 'var(--color-primary)' }} />
        </div>
      )}
    </div>
  )
}
