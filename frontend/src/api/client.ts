// Cliente HTTP da API do PostRun · GeoHorun. Todas as rotas ficam sob /api:
// atrás do Core o módulo é servido em /m/geohorun/ e a API em
// /m/geohorun/api; em desenvolvimento o Vite repassa /api para o backend
// local (vite.config.ts). Veio do RE7S (13/11/2026).
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`

export class ApiError extends Error {
  status: number
  // Pedido do usuário: aviso de nome de análise duplicado (só admin) —
  // o backend manda `detail` como objeto ({message, duplicate_warning})
  // em vez de string simples nesse caso específico, pra distinguir "erro
  // definitivo" de "pergunta se quer continuar mesmo assim".
  duplicateWarning: boolean
  /** `detail` do backend quando vem como objeto (ex.: conflitos do TABSAMPLE) */
  detail: Record<string, unknown> | null
  constructor(status: number, message: string, duplicateWarning = false, detail: Record<string, unknown> | null = null) {
    super(message)
    this.status = status
    this.duplicateWarning = duplicateWarning
    this.detail = detail
  }
}

/** Sessão do Horun expirou com a página aberta (16/11/2026 — a tela ficava
 * em "Não autenticado" sem saída): atrás do Core (/m/...), vai para o login e
 * volta para esta mesma página depois. Em desenvolvimento, sem Core, não faz
 * nada. O 401 aqui só vem de sessão ausente/encerrada (o do Agente não passa
 * pelo navegador). */
let goingToLogin = false
function toLoginIfSessionEnded(status: number) {
  if (status !== 401 || goingToLogin || !window.location.pathname.startsWith('/m/')) return
  goingToLogin = true
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.assign(`/login?next=${encodeURIComponent(here)}`)
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include', // cookie de sessão HTTPOnly
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (!res.ok) {
    let message = res.statusText
    let duplicateWarning = false
    let detailObj: Record<string, unknown> | null = null
    try {
      const body = await res.json()
      const detail = body.detail
      if (typeof detail === 'string') {
        message = detail
      } else if (detail && typeof detail === 'object') {
        message = detail.message ?? message
        duplicateWarning = Boolean(detail.duplicate_warning)
        detailObj = detail
      }
    } catch {
      // resposta sem corpo JSON
    }
    toLoginIfSessionEnded(res.status)
    throw new ApiError(res.status, message, duplicateWarning, detailObj)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** POST (ou GET, sem corpo) que devolve um arquivo (ex.: Excel) em vez de JSON. */
async function requestBlob(path: string, body?: unknown): Promise<Blob> {
  const res = await fetch(
    `${API_BASE}${path}`,
    body === undefined
      ? { method: 'GET', credentials: 'include' }
      : { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
  if (!res.ok) {
    let message = res.statusText
    try {
      const data = await res.json()
      if (typeof data.detail === 'string') message = data.detail
    } catch {
      // sem corpo JSON
    }
    toLoginIfSessionEnded(res.status)
    throw new ApiError(res.status, message)
  }
  return res.blob()
}

export const api = {
  postBlob: (path: string, body: unknown) => requestBlob(path, body),
  getBlob: (path: string) => requestBlob(path),
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', body: body ? JSON.stringify(body) : undefined }),
}
