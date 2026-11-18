/** Massas reais das réplicas coladas do Excel (pedido do usuário, 22/10/2026):
 * em vez de digitar réplica por réplica na sub-aba Réplicas.
 *
 * Formatos aceitos (tab do Excel; ";" de um .csv também serve):
 *  1. Com cabeçalho — `Amostra | PEAD | PS`, depois uma linha por réplica.
 *     É o formato do modelo baixado pela tela.
 *  2. Sem cabeçalho, com nome — `PP_PS_50-50_1 | PEAD 1,012 | PS 0,998`, ou só
 *     os números na ordem dos componentes mostrada na tabela.
 *  3. Sem nome (1ª coluna já é número) — cada linha vai para a réplica
 *     seguinte, na ordem da tabela.
 *
 * O nome casa com o arquivo (com ou sem .B00) ou com a amostra; se não casar
 * exato, aceita um trecho que aponte para uma única réplica.
 */
import { parseMassNumber, splitColumns } from './weighingPaste'

export interface MassPasteRun {
  token: string
  filename: string
  sample: string
  materials: string[]
}

export interface MassPasteResult {
  edits: Record<string, Record<string, string>> // token → {PEAD: "1,012", PS: "0,998"}
  errors: string[]
}

const NAME_RE = /^[A-Za-zÀ-ÿ][\w.+\-]*$/
const PAIR_RE = /^([A-Za-zÀ-ÿ][\w.+\-]*)\s*[:=]?\s*(\d[\d.,]*)\s*(?:mg)?$/i

const norm = (s: string) => s.trim().toLowerCase().replace(/\.b00$/, '')
export const fmtMass = (v: number) => String(Number(v.toFixed(4))).replace('.', ',')

function findRun(name: string, runs: MassPasteRun[]): MassPasteRun | string {
  const n = norm(name)
  const exact = runs.filter((r) => norm(r.filename) === n)
  if (exact.length === 1) return exact[0]
  const bySample = runs.filter((r) => norm(r.sample) === n)
  if (bySample.length === 1) return bySample[0]
  if (bySample.length > 1) return `"${name}" é a amostra de ${bySample.length} réplicas — use o nome do arquivo`
  const partial = runs.filter((r) => norm(r.filename).includes(n))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) return `"${name}" casa com ${partial.length} réplicas — use o nome completo do arquivo`
  return `"${name}" não é nenhuma réplica deste relatório`
}

export function parseComponentMasses(text: string, runs: MassPasteRun[]): MassPasteResult {
  const edits: Record<string, Record<string, string>> = {}
  const errors: string[] = []
  const known = new Set(runs.flatMap((r) => r.materials.map((m) => m.toUpperCase())))
  let header: string[] | null = null
  let nextUnnamed = 0

  text.split(/\r?\n/).forEach((raw, idx) => {
    if (!raw.trim()) return
    const line = idx + 1
    const cells = splitColumns(raw).map((c) => c.trim())
    const rest = cells.slice(1).filter((c) => c !== '')

    // cabeçalho: 2ª coluna em diante só com nomes (PEAD, PS…); se a 1ª
    // também for um componente, o cabeçalho não tem a coluna do nome
    if (header === null && rest.length > 0 && rest.every((c) => NAME_RE.test(c))) {
      const withName = !known.has((cells[0] ?? '').toUpperCase())
      header = (withName ? cells.slice(1) : cells).map((c) => c.toUpperCase())
      return
    }

    let run: MassPasteRun
    let values: string[]
    if (!cells[0] || parseMassNumber(cells[0]) !== null) {
      // sem nome (célula vazia ou já um número): próxima réplica, na ordem da tabela
      if (nextUnnamed >= runs.length) {
        errors.push(`Linha ${line}: há mais linhas sem nome do que réplicas (${runs.length}).`)
        return
      }
      run = runs[nextUnnamed++]
      values = cells[0] ? cells : cells.slice(1)
    } else {
      const found = findRun(cells[0] ?? '', runs)
      if (typeof found === 'string') {
        errors.push(`Linha ${line}: ${found}.`)
        return
      }
      run = found
      values = cells.slice(1)
    }

    const masses: Record<string, string> = {}
    for (let k = 0; k < values.length; k++) {
      const cell = values[k]
      if (!cell) continue
      const pair = cell.match(PAIR_RE)
      const name = pair ? pair[1].toUpperCase() : (header?.[k] ?? run.materials[k])
      const value = parseMassNumber(pair ? pair[2] : cell)
      if (!name) {
        errors.push(`Linha ${line}: a coluna ${k + 2} não tem componente (cabeçalho ou "PEAD 1,012").`)
        return
      }
      if (value === null || value <= 0) {
        errors.push(`Linha ${line}: "${cell}" não é uma massa válida.`)
        return
      }
      masses[name] = fmtMass(value)
    }
    if (!Object.keys(masses).length) {
      errors.push(`Linha ${line}: ${run.filename} sem nenhuma massa.`)
      return
    }
    edits[run.token] = masses
  })

  return { edits, errors }
}

/** Modelo para o Excel: uma coluna por componente, uma linha por réplica,
 * com as massas que já existirem. CSV ";" com BOM (Excel em português). */
export function massTemplateCsv(runs: (MassPasteRun & { masses?: Record<string, number> | null })[]): string {
  const mats = [...new Set(runs.flatMap((r) => r.materials))]
  const lines = [['Amostra', ...mats].join(';')]
  for (const r of runs) {
    lines.push([r.filename.replace(/.[A-Za-z]00$/i, ''), ...mats.map((m) => (r.masses?.[m] != null ? fmtMass(r.masses[m]) : ''))].join(';'))
  }
  return '﻿' + lines.join('\r\n') + '\r\n'
}
