import { api } from './client'

// Biblioteca de amostras — fica no RE7S; o GeoHorun repassa (trocar a amostra de uma análise).
export interface SampleGroupOut {
  id: number
  name: string
  parent_group_id: number | null
}

export interface LibrarySampleOut {
  id: number
  name: string
  code: string
  group_id: number | null
  group_name: string | null
  group_parent_name: string | null
}

export const libraryApi = {
  listGroups: () => api.get<SampleGroupOut[]>('/postrun/library/groups'),
  listSamples: () => api.get<LibrarySampleOut[]>('/postrun/library/samples'),
}
