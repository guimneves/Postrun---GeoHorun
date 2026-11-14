// Classes comuns da interface do GeoHorun — antes cada componente tinha a sua
// cópia (vinda do RE7S); agora a aparência muda num lugar só.

const field =
  'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-sm text-[var(--color-text)] ' +
  'transition-[border-color,box-shadow] placeholder:text-[var(--color-text-dim)] ' +
  'hover:border-[var(--color-border-strong)] focus:border-[var(--color-primary)] focus:outline-none ' +
  'focus:ring-3 focus:ring-[var(--color-primary-soft)] disabled:opacity-50'

/** Campo que ocupa a largura toda. */
export const inputClass = `w-full px-2.5 py-1.5 ${field}`
/** Campo do tamanho do conteúdo (em linhas de controles). */
export const inputInlineClass = `px-2.5 py-1.5 ${field}`
/** Campo maior, dos modais. */
export const inputLgClass = `w-full px-3 py-2 ${field}`

export const btnClass =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] ' +
  'bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm font-medium text-[var(--color-text)] shadow-[var(--shadow-xs)] ' +
  'transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface)] ' +
  'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[var(--color-primary-soft)] ' +
  'disabled:pointer-events-none disabled:opacity-40'

export const btnPrimaryClass =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-primary)] ' +
  'bg-[var(--color-primary)] px-3 py-1.5 text-sm font-semibold text-[var(--color-primary-contrast)] ' +
  'shadow-[var(--shadow-xs)] transition-colors hover:border-[var(--color-primary-hover)] hover:bg-[var(--color-primary-hover)] ' +
  'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[var(--color-primary-soft)] ' +
  'disabled:pointer-events-none disabled:opacity-40'

/** Botão só de texto (ações pequenas: "selecionar todas", "limpar"). */
export const linkBtnClass =
  'rounded px-1 text-xs font-medium text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary-soft)]'

/** Botão de ícone (ações da linha). */
export const iconBtnClass =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-dim)] ' +
  'transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]'

export const cardClass =
  'rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4 shadow-[var(--shadow-card)]'
