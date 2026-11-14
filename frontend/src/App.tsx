import { HorunFooter, ThemeProvider, ThemeToggle } from '@horun/design-system'
import { AuthProvider } from './auth/AuthContext'
import { PostRunPage } from './pages/PostRunPage'

// PostRun · GeoHorun — Fase 1: o PostRun que estava no RE7S (docs/PLANO.md).
export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <div className="flex min-h-screen flex-col">
          <header
            className="flex items-center justify-between border-b px-4 py-3"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-elevated)' }}
          >
            <div className="flex items-center gap-3">
              <a href="/" className="text-sm hover:underline" style={{ color: 'var(--color-text-muted)' }}>
                ← Voltar ao Horun
              </a>
              <h1 className="text-lg font-semibold" style={{ color: 'var(--color-primary)' }}>
                PostRun · GeoHorun
              </h1>
            </div>
            <ThemeToggle />
          </header>

          <main className="mx-auto w-full max-w-[1600px] flex-1 p-4 sm:p-6">
            <PostRunPage />
          </main>

          <HorunFooter moduleName="PostRun · GeoHorun" />
        </div>
      </AuthProvider>
    </ThemeProvider>
  )
}
