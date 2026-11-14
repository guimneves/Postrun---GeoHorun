import { api } from './client'
import type { StandardOut } from './types'

// Catálogo de padrões certificados — fica no RE7S; o GeoHorun repassa.
export const standardsApi = {
  list: () => api.get<StandardOut[]>('/postrun/standards'),
}
