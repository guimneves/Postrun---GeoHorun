import type { ReactNode } from 'react'

export interface SegmentedOption<T> {
  value: T
  label: ReactNode
  title?: string
  disabled?: boolean
}

/** Seletor em pílula (um valor de cada vez) — o mesmo desenho em todo o módulo. */
export function Segmented<T extends string | boolean>({
  options,
  value,
  onChange,
  size = 'sm',
  ariaLabel,
  className = '',
}: {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (v: T) => void
  size?: 'xs' | 'sm'
  ariaLabel?: string
  className?: string
}) {
  const pad = size === 'xs' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-xs sm:text-[13px]'
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 ${className}`}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={o.disabled}
            title={o.title}
            onClick={() => !active && onChange(o.value)}
            className={`whitespace-nowrap rounded-full font-medium transition-colors disabled:opacity-30 ${pad} ${
              active
                ? 'bg-[var(--color-bg-elevated)] text-[var(--color-primary)] shadow-[var(--shadow-xs)] ring-1 ring-[var(--color-border)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
