import { useEffect, useState } from 'react'
import { agentApi, type AgentDevice, type EnrollCode } from '../api/agent'
import { ApiError } from '../api/client'
import { btnClass } from '../ui/classes'
import { IconClose } from '../ui/icons'

// Mesma janela que o servidor usa para considerar o agente conectado
// (online_window_seconds em app/agent_server/settings.py).
const ONLINE_WINDOW_MS = 120_000

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('pt-BR') : '—'
}

function deviceState(d: AgentDevice): { label: string; color: string } {
  if (d.revoked_at) return { label: 'revogado', color: 'var(--color-text-dim)' }
  if (d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < ONLINE_WINDOW_MS)
    return { label: 'conectado', color: 'var(--color-status-ready)' }
  return { label: 'sem sinal', color: 'var(--color-warning)' }
}

/** Administração do Agente Horun no GeoHorun (veio do Painel do RE7S): gerar o
 * código de instalação, ver as instalações conectadas e revogar. Cada módulo
 * enrola o Agente separadamente — o mesmo PC atende o RE7S e o GeoHorun, com
 * um bloco para cada um em `servers` no config.json. */
export function AgentPanel({ agentMode, onClose }: { agentMode: boolean; onClose: () => void }) {
  const [devices, setDevices] = useState<AgentDevice[] | null>(null)
  const [code, setCode] = useState<EnrollCode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function refresh() {
    agentApi
      .listDevices()
      .then((list) => {
        setDevices(list)
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Erro ao listar as instalações do agente'))
  }

  useEffect(() => {
    refresh()
    // "visto por último" muda a cada consulta do agente (poucos segundos)
    const timer = window.setInterval(refresh, 15_000)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  function generateCode() {
    setBusy(true)
    agentApi
      .createEnrollCode()
      .then(setCode)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Erro ao gerar o código'))
      .finally(() => setBusy(false))
  }

  function revoke(d: AgentDevice) {
    const ok = window.confirm(
      `Revogar a instalação "${d.device_name}"? O agente desse PC para de receber tarefas do GeoHorun na hora; ` +
        'para voltar, é preciso gerar um código novo e enrolar de novo.',
    )
    if (!ok) return
    setBusy(true)
    agentApi
      .revokeDevice(d.id)
      .then(refresh)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Erro ao revogar'))
      .finally(() => setBusy(false))
  }

  const active = (devices ?? []).filter((d) => !d.revoked_at)
  const revoked = (devices ?? []).filter((d) => d.revoked_at)

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-20 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Agente Horun"
        className="flex w-full max-w-3xl flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5 shadow-[var(--shadow-card)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Agente Horun · PC do Rock-Eval</h2>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              {agentMode
                ? 'Os .B00 e o standard.ini são lidos pelo Agente (pastas "jobs" e "data" do config.json).'
                : 'Modo agente desligado (POSTRUN_AGENT_MODE): os arquivos vêm de uma pasta local.'}
            </p>
          </div>
          <button type="button" className={btnClass} onClick={onClose} aria-label="fechar">
            <IconClose size={15} />
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--color-surface)] p-3 text-sm">
          <span className="text-[var(--color-text-muted)]">Instalação nova ou reinstalação do Agente:</span>
          <button type="button" className={btnClass} onClick={generateCode} disabled={busy}>
            Gerar código de instalação
          </button>
        </div>

        {code && (
          <div className="rounded-xl border border-[var(--color-primary)] p-3 text-sm">
            <div>
              Código: <code className="select-all text-base font-semibold tracking-widest">{code.code}</code>
              {code.expires_at && (
                <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                  vale até {formatDateTime(code.expires_at)}, uso único
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              No PC do equipamento, no <code>config.json</code> do agente: no bloco do GeoHorun em{' '}
              <code>servers</code> (url <code>http://&lt;servidor&gt;:8003</code>), ponha o código em{' '}
              <code>enroll_code</code> e reinicie o agente — ele troca o código por um token permanente.
            </p>
          </div>
        )}

        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

        {devices === null && !error && <p className="text-xs text-[var(--color-text-muted)]">carregando…</p>}
        {devices !== null && active.length === 0 && (
          <p className="text-sm text-[var(--color-text-muted)]">
            Nenhuma instalação ativa. Gere um código e enrole o agente no PC do equipamento.
          </p>
        )}

        {active.length + revoked.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-[var(--color-text-muted)]">
                <tr>
                  <th className="p-2 font-medium">Instalação</th>
                  <th className="p-2 font-medium">Estado</th>
                  <th className="p-2 font-medium">Visto por último</th>
                  <th className="p-2 font-medium">Versão</th>
                  <th className="p-2 font-medium">Enrolado em</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {[...active, ...revoked].map((d) => {
                  const state = deviceState(d)
                  return (
                    <tr
                      key={d.id}
                      className="border-t border-[var(--color-border)]"
                      style={d.revoked_at ? { opacity: 0.55 } : undefined}
                    >
                      <td className="p-2 font-medium">{d.device_name}</td>
                      <td className="p-2">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: state.color }} />
                          {state.label}
                        </span>
                      </td>
                      <td className="whitespace-nowrap p-2">{formatDateTime(d.last_seen_at)}</td>
                      <td className="p-2">{d.agent_version ?? 'antiga (< 0.3)'}</td>
                      <td className="whitespace-nowrap p-2">{formatDateTime(d.enrolled_at)}</td>
                      <td className="p-2 text-right">
                        {!d.revoked_at && (
                          <button
                            type="button"
                            className="text-xs text-[var(--color-danger)] hover:underline disabled:opacity-50"
                            onClick={() => revoke(d)}
                            disabled={busy}
                          >
                            revogar
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
