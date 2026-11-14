// Tipos que vêm do RE7S pelas rotas internas (através do backend do GeoHorun).

/** Padrão certificado do catálogo do RE7S (para a calibração). */
export interface StandardOut {
  id: number
  name: string
  kind?: string
}
