// Quem está usando — vem do Core (cabeçalhos) através de GET /api/me. Não há
// login próprio: o papel é calculado do cargo no Horun (coordenação = admin).
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api/client'

export interface Me {
  username: string
  role: 'admin' | 'user'
  level: number
  /** arquivos pelo Agente Horun (produção) ou pasta local (desenvolvimento) */
  agent_mode: boolean
  /** rotas internas do RE7S configuradas */
  re7s_linked: boolean
}

const AuthContext = createContext<{ user: Me | null; loading: boolean }>({ user: null, loading: true })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    api
      .get<Me>('/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])
  return <AuthContext.Provider value={{ user, loading }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
