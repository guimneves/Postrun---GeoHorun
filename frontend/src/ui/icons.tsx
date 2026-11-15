// Ícones de traço (24×24, currentColor) desenhados à mão — sem biblioteca.
import type { ReactNode, SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

function Base({ size = 16, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Pirograma (lista de análises). */
export const IconPyrogram = (p: P) => (
  <Base {...p}>
    <path d="M3 20h18" />
    <path d="M4 19c3 0 3.5-2 5-7s2.5-8 3.5-8 2 3 3.5 8 2 7 4 7" />
  </Base>
)
export const IconStudy = (p: P) => (
  <Base {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" />
  </Base>
)
/** Deconvolução: picos sobrepostos. */
export const IconDeconv = (p: P) => (
  <Base {...p}>
    <path d="M3 20h18" />
    <path d="M3 19c2.5 0 3-9 6-9s3.5 9 6 9" />
    <path d="M9 19c2.5 0 3-12 6-12s3.5 12 6 12" />
  </Base>
)
/** Curvas de calibração: pontos + reta. */
export const IconCurve = (p: P) => (
  <Base {...p}>
    <path d="M4 4v16h16" />
    <path d="M7 16 19 6" />
    <circle cx="9" cy="14" r="1" fill="currentColor" />
    <circle cx="13" cy="11.5" r="1" fill="currentColor" />
    <circle cx="16.5" cy="8" r="1" fill="currentColor" />
  </Base>
)
export const IconReport = (p: P) => (
  <Base {...p}>
    <path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v5h5M9 13h6M9 17h6" />
  </Base>
)
/** Calibração: balança/ajuste. */
export const IconCalib = (p: P) => (
  <Base {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </Base>
)
export const IconSearch = (p: P) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Base>
)
export const IconArrowLeft = (p: P) => (
  <Base {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Base>
)
export const IconFolder = (p: P) => (
  <Base {...p}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
  </Base>
)
export const IconPencil = (p: P) => (
  <Base {...p}>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
    <path d="m13.5 6.5 4 4" />
  </Base>
)
export const IconEyeOff = (p: P) => (
  <Base {...p}>
    <path d="M3 3l18 18" />
    <path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.5 9 6-.3.8-1.2 2.3-2.6 3.6M6.4 7.4C4.5 8.7 3.4 10.6 3 12c.5 1.5 4 6 9 6 1.6 0 3-.4 4.2-1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Base>
)
export const IconUndo = (p: P) => (
  <Base {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Base>
)
export const IconChevron = (p: P) => (
  <Base {...p}>
    <path d="m9 6 6 6-6 6" />
  </Base>
)
export const IconIntegral = (p: P) => (
  <Base {...p}>
    <path d="M15 4.5c-1.5-1-3.5-.5-4 1.5L9 18c-.5 2-2.5 2.5-4 1.5" />
  </Base>
)
export const IconSave = (p: P) => (
  <Base {...p}>
    <path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
    <path d="M8 4v5h7V4M8 20v-6h8v6" />
  </Base>
)
export const IconClose = (p: P) => (
  <Base {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Base>
)
/** Agente Horun: computador do equipamento. */
export const IconAgent = (p: P) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M8 20h8M12 16v4" />
    <path d="m9 10 2 2 4-4" />
  </Base>
)
/** Manual: livro aberto com marcador. */
export const IconManual = (p: P) => (
  <Base {...p}>
    <path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" />
    <path d="M5 18a2 2 0 0 1 2-2h11" />
    <path d="M9 8h5M9 11h4" />
  </Base>
)
/** Ficha da corrida (metadados, exclusão). */
export const IconTag = (p: P) => (
  <Base {...p}>
    <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />
    <circle cx="8" cy="8" r="1.5" />
  </Base>
)
export const IconBan = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m6 6 12 12" />
  </Base>
)
