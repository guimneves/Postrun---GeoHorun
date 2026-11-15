/** cores dos picos (ordem do centro) — também usadas no visualizador */
export const PEAK_COLORS = ['#2a78d6', '#1baf7a', '#e34948', '#7b61c9', '#eda100', '#0f9fb5', '#e87ba4', '#8c8a2a']

/**
 * Paleta FIXA por polímero (F5 do artigo): a mesma cor em todas as figuras,
 * qualquer que seja a ordem em que o material aparece. Cores de Okabe & Ito
 * (2008), seguras para daltônicos e legíveis em preto e branco por contraste.
 */
const OKABE_ITO = {
  blue: '#0072B2',
  vermillion: '#D55E00',
  green: '#009E73',
  sky: '#56B4E9',
  purple: '#CC79A7',
  orange: '#E69F00',
  black: '#000000',
  yellow: '#F0E442',
}

const BY_MATERIAL: Record<string, string> = {
  PEAD: OKABE_ITO.blue,
  HDPE: OKABE_ITO.blue,
  PE: OKABE_ITO.sky,
  PEBD: OKABE_ITO.sky,
  LDPE: OKABE_ITO.sky,
  PELBD: OKABE_ITO.sky,
  LLDPE: OKABE_ITO.sky,
  PP: OKABE_ITO.vermillion,
  PS: OKABE_ITO.green,
  PET: OKABE_ITO.purple,
  PVC: OKABE_ITO.orange,
  PA: OKABE_ITO.black,
}

// materiais fora da lista: cores que sobram, na ordem, e depois as dos picos
const SPARE = [OKABE_ITO.purple, OKABE_ITO.orange, OKABE_ITO.black, OKABE_ITO.sky, ...PEAK_COLORS]

/** Cor de um material. `others` = a lista de materiais da figura, para os
 * desconhecidos ganharem cores distintas e estáveis dentro dela. */
export function materialColor(material: string, others: string[] = []): string {
  const key = material.trim().toUpperCase()
  if (BY_MATERIAL[key]) return BY_MATERIAL[key]
  const unknown = [...new Set(others.map((m) => m.trim().toUpperCase()))].filter((m) => !BY_MATERIAL[m])
  const i = Math.max(0, unknown.indexOf(key))
  return SPARE[i % SPARE.length]
}
