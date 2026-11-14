import { api } from './client'

/** Uma instalação do Agente Horun (o programa no PC do Rock-Eval). */
export interface AgentDevice {
  id: number
  device_name: string
  enrolled_at: string
  last_seen_at: string | null
  revoked_at: string | null
  /** versão que o agente informou na última consulta (antes da 0.3.0, nula) */
  agent_version: string | null
}

export interface EnrollCode {
  code: string
  expires_at: string | null
}

/** Rotas de administração do pacote do servidor do agente (só coordenação).
 * As do próprio agente (/agent/enroll, /agent/tasks) chegam pela porta
 * estreita 8003, nunca por aqui. */
export const agentApi = {
  listDevices: () => api.get<AgentDevice[]>('/agent/devices'),
  createEnrollCode: () => api.post<EnrollCode>('/agent/enroll-codes'),
  revokeDevice: (id: number) => api.post<unknown>(`/agent/devices/${id}/revoke`),
}
