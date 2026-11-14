import { useCallback, useState } from 'react'
import { HorunFooter, ThemeProvider, ThemeToggle } from '@horun/design-system'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { PostRunPage } from './pages/PostRunPage'
import { AgentPanel } from './components/AgentPanel'
import { IconAgent, IconArrowLeft } from './ui/icons'

// PostRun · GeoHorun — Fase 1: o PostRun que estava no RE7S (docs/PLANO.md).
export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <div className="flex min-h-screen flex-col">
          <AppHeader />
          <main className="mx-auto w-full max-w-[1680px] flex-1 px-4 pb-8 pt-4 sm:px-6">
            <PostRunPage />
          </main>
          <HorunFooter moduleName="PostRun · GeoHorun" />
        </div>
      </AuthProvider>
    </ThemeProvider>
  )
}

/** Marca do módulo: um pirograma estilizado sobre o azul do Horun. */
function BrandMark() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="gh-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1f2f8f" />
          <stop offset="1" stopColor="#15216f" />
        </linearGradient>
        <linearGradient id="gh-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff6a35" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ff6a35" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="34" height="34" rx="9" fill="url(#gh-bg)" />
      <path d="M5 26c3 0 4-1 5.5-2.5S13 13 17 9s5 11 6.5 14 3 3 5.5 3v2H5z" fill="url(#gh-fill)" />
      <path
        d="M5 26c3 0 4-1 5.5-2.5S13 13 17 9s5 11 6.5 14 3 3 5.5 3"
        fill="none"
        stroke="#ff8a5c"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M5 28.5h24" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="1" />
    </svg>
  )
}

function AppHeader() {
  const { user } = useAuth()
  const [agentOpen, setAgentOpen] = useState(false)
  const closeAgent = useCallback(() => setAgentOpen(false), [])
  const initials = (user?.username ?? '?')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('')
  return (
    <>
    <header
      className="sticky top-0 z-30 border-b border-[var(--color-border)] backdrop-blur-md"
      style={{ background: 'var(--header-bg)' }}
    >
      <div className="mx-auto flex w-full max-w-[1680px] items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <a
            href="/"
            title="Voltar ao Horun"
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            <IconArrowLeft />
            <span className="hidden sm:inline">Horun</span>
          </a>
          <span className="h-6 w-px bg-[var(--color-border)]" aria-hidden />
          <BrandMark />
          <div className="min-w-0 leading-tight">
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-[var(--color-text)]">
              PostRun <span className="text-[var(--color-flame)]">·</span> GeoHorun
            </h1>
            <p className="hidden truncate text-xs text-[var(--color-text-muted)] sm:block">
              Rock-Eval 7S · pós-corrida
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {user && (
            <div
              className="hidden items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] py-1 pl-1 pr-3 md:flex"
              title={`nível ${user.level} no Horun`}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-primary)] text-[11px] font-semibold text-[var(--color-primary-contrast)]">
                {initials}
              </span>
              <span className="flex flex-col leading-tight">
                <span className="text-xs font-medium text-[var(--color-text)]">{user.username}</span>
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  {user.role === 'admin' ? 'Coordenação' : 'Colaborador(a)'}
                </span>
              </span>
            </div>
          )}
          {user?.role === 'admin' && (
            <button
              type="button"
              onClick={() => setAgentOpen(true)}
              title="Agente Horun do PC do Rock-Eval: código de instalação e instalações conectadas"
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-elevated)]"
            >
              <IconAgent size={15} />
              <span className="hidden sm:inline">Agente</span>
            </button>
          )}
          <ThemeToggle />
        </div>
      </div>
    </header>
    {/* fora do header: o desfoque dele prenderia o "fixed" do painel */}
    {agentOpen && <AgentPanel agentMode={user?.agent_mode ?? false} onClose={closeAgent} />}
    </>
  )
}
