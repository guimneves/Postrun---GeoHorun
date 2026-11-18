/**
 * Réplicas pelo nome (pedido do usuário, 18/11/2026): antes do Horun, cada
 * réplica muitas vezes ganhou um nome de amostra próprio — "ZOMO_MACA1",
 * "ZOMO_MACA2", "ZOMO_MACA3" ou "MINT-2", "MINT-3". Esses nomes passam a ser
 * a MESMA amostra (as réplicas dela).
 *
 * Regra (conferida nos dados reais, onde há os dois casos):
 * - o nome termina em UM algarismo de 1 a 9, logo depois de uma letra ou de
 *   um separador (-, _ ou espaço): "X1", "X-2", "X_3", "X 3";
 * - cada um desses nomes tem UMA corrida só (em cada método: a mesma amostra
 *   analisada em bulk rock e em multi-heating rates conta uma em cada). Um nome que já tem várias
 *   corridas é uma amostra com as próprias réplicas, não uma réplica:
 *   "DOPOLAB 1" … "DOPOLAB 7" (3 corridas cada) e "PARAFINA 1" … "PARAFINA 4"
 *   continuam amostras diferentes;
 * - pelo menos dois nomes com a mesma base, com algarismos diferentes.
 * Números maiores (HP280, TITAN_10, STD160000) nunca são réplica.
 */

const TAIL = /^(.*?[^0-9])[\s_-]*([1-9])$/

export interface ReplicateGroup {
  /** nome da amostra (a base, sem o algarismo) */
  name: string
  /** os nomes originais juntados */
  members: string[]
}

const norm = (s: string) => s.trim().toUpperCase()

/** nome → grupo de réplicas, só para os nomes que a regra juntou.
 * `items`: as corridas (nome da amostra e, se houver, o método). */
export function replicateGroups(items: (string | { sample: string; method?: string })[]): Map<string, ReplicateGroup> {
  const perMethod = new Map<string, number>() // método + nome → corridas
  const original = new Map<string, string>()
  for (const it of items) {
    const s = typeof it === 'string' ? it : it.sample
    const method = typeof it === 'string' ? '' : norm(it.method ?? '')
    const k = norm(s)
    perMethod.set(`${method}\u0001${k}`, (perMethod.get(`${method}\u0001${k}`) ?? 0) + 1)
    if (!original.has(k)) original.set(k, s.trim())
  }
  // um nome vale como réplica só se tem UMA corrida em cada método em que aparece
  const single = new Map<string, boolean>()
  for (const [mk, n] of perMethod) {
    const k = mk.slice(mk.indexOf('\u0001') + 1)
    single.set(k, (single.get(k) ?? true) && n === 1)
  }
  const byBase = new Map<string, { key: string; digit: string }[]>()
  for (const [k, ok] of single) {
    if (!ok) continue
    const m = TAIL.exec(k)
    if (!m) continue
    const base = m[1].replace(/[\s_-]+$/, '')
    if (!base) continue
    const list = byBase.get(base) ?? []
    list.push({ key: k, digit: m[2] })
    byBase.set(base, list)
  }
  const out = new Map<string, ReplicateGroup>()
  for (const [base, list] of byBase) {
    if (list.length < 2 || new Set(list.map((x) => x.digit)).size !== list.length) continue
    const first = original.get(list[0].key) ?? base
    const name = (TAIL.exec(first)?.[1] ?? first).replace(/[\s_-]+$/, '')
    const members = list.sort((a, b) => a.digit.localeCompare(b.digit)).map((x) => original.get(x.key) ?? x.key)
    const group = { name, members }
    for (const x of list) out.set(x.key, group)
  }
  return out
}

/** A amostra de uma corrida: o grupo de réplicas, se a regra juntou; senão o próprio nome. */
export function sampleOf(sample: string, groups: Map<string, ReplicateGroup>): string {
  return groups.get(norm(sample))?.name ?? (sample.trim() || '(sem nome)')
}
