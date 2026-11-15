import { isValidElement, useMemo, useState, type ReactNode } from 'react'
import { MANUAL_INTRO, MANUAL_SECTIONS } from '../manual/content'
import { btnClass, cardClass, inputClass } from '../ui/classes'
import { IconSearch } from '../ui/icons'

/** Texto puro de um trecho JSX estático — para a busca do manual. */
function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join(' ')
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode }
    return nodeText(props.children)
  }
  return ''
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Aba "Manual" (Prompt_Horun_Modulo.md, seção 12): índice, busca por texto e
 * "Imprimir / salvar PDF". Conteúdo em manual/content.tsx. */
export function ManualTab() {
  const [query, setQuery] = useState('')
  const indexed = useMemo(
    () => MANUAL_SECTIONS.map((s) => ({ ...s, text: normalize(`${s.title} ${nodeText(s.body)}`) })),
    [],
  )
  const q = normalize(query.trim())
  const visible = q ? indexed.filter((s) => s.text.includes(q)) : indexed

  return (
    <article className="manual grid grid-cols-1 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="no-print flex flex-col gap-3 self-start lg:sticky lg:top-[120px]">
        <div className="relative">
          <IconSearch size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]" />
          <input
            type="search"
            className={`${inputClass} pl-8`}
            placeholder="Buscar no manual…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar no manual"
          />
        </div>
        <nav aria-label="Índice" className={`${cardClass} p-3`}>
          <ol className="flex flex-col text-sm">
            {visible.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="block rounded-md px-2 py-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-primary)]"
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
          {visible.length === 0 && (
            <p className="px-2 py-1 text-sm text-[var(--color-text-muted)]">Nada encontrado para "{query}".</p>
          )}
        </nav>
        <button type="button" onClick={() => window.print()} className={btnClass}>
          Imprimir / salvar PDF
        </button>
      </aside>

      <div className="flex min-w-0 flex-col gap-4">
        <div className={cardClass}>
          <h2 className="text-lg font-semibold">Manual de uso</h2>
          <div className="mt-1 text-sm leading-relaxed text-[var(--color-text-muted)]">{MANUAL_INTRO}</div>
        </div>
        {visible.map((s) => (
          <section
            key={s.id}
            id={s.id}
            className={`${cardClass} manual-section scroll-mt-32 p-5 text-sm leading-relaxed
                       [&_code]:break-all [&_code]:rounded [&_code]:bg-[var(--color-surface)] [&_code]:px-1
                       [&_li]:mb-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2.5 [&_ul]:list-disc [&_ul]:pl-5`}
          >
            <h3 className="mb-2 text-base font-semibold text-[var(--color-primary)]">{s.title}</h3>
            {s.body}
          </section>
        ))}
      </div>
    </article>
  )
}
