import { useRef, useState, type ReactNode } from 'react'
import { exportFigure, type FigureFormat } from '../lib/figureExport'

/** Envolve um gráfico SVG com o botão de exportar para publicação (F5):
 * aparece ao passar o mouse, no canto de cima à direita. */
export function ExportFigure({ name, children, className = '' }: { name: string; children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function go(format: FigureFormat) {
    setOpen(false)
    setError(null)
    const svg = box.current?.querySelector('svg')
    if (!svg) return
    try {
      await exportFigure(svg, name, format)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'falha ao exportar')
    }
  }

  return (
    <div ref={box} className={`group/fig relative ${className}`}>
      {children}
      <div className="no-print absolute right-1 top-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/fig:opacity-100">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title="exportar a figura para publicação (SVG vetorial ou PNG 300 dpi)"
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-muted)] shadow-[var(--shadow-xs)] hover:text-[var(--color-primary)]"
        >
          ⤓ figura
        </button>
        {open && (
          <div className="absolute right-0 z-10 mt-1 flex w-56 flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1 text-xs shadow-[var(--shadow-card)]">
            {(
              [
                ['svg', 'SVG (vetorial)'],
                ['png-col', 'PNG 300 dpi — 1 coluna (1063 px)'],
                ['png-page', 'PNG 300 dpi — página inteira (2244 px)'],
              ] as const
            ).map(([f, label]) => (
              <button key={f} type="button" className="rounded px-2 py-1.5 text-left hover:bg-[var(--color-surface)]" onClick={() => void go(f)}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  )
}
