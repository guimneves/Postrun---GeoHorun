/** Pesagem por tabela colada (pedido do usuário): alternativa ao pendrive
 * — cola uma tabela de 2 colunas copiada do Excel numa caixa de texto.
 * Coluna 1 = posição inicial do carrossel (só precisa vir preenchida na
 * primeira linha; as linhas seguintes herdam a posição anterior + 1).
 * Coluna 2 = massa (mg), uma por linha, na ordem física das posições.
 *
 * Se o usuário preferir preencher a coluna 1 em toda linha (em vez de só
 * na primeira), também funciona — cada linha com posição explícita usa
 * esse valor, sem depender do incremento automático.
 */

export interface ParsedWeighRow {
  line: number // 1-based, útil pra apontar erro de digitação
  crucible: number
  massMg: number
}

export interface ParsedWeighTable {
  rows: ParsedWeighRow[]
  errors: string[]
}

export function splitColumns(line: string): string[] {
  // Excel copia como TSV (tab); aceita vírgula/ponto-e-vírgula como
  // reserva pra quem colar de um .csv em vez de direto da planilha.
  if (line.includes('\t')) return line.split('\t')
  if (line.includes(';')) return line.split(';')
  return line.split(',')
}

/** Aceita tanto `12,345` (decimal brasileiro) quanto `12.345` (decimal
 * americano) e `1.234,56` / `1,234.56` (milhar + decimal). */
export function parseMassNumber(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null
  let normalized = text
  const hasComma = text.includes(',')
  const hasDot = text.includes('.')
  if (hasComma && hasDot) {
    // o último separador é o decimal; o outro é milhar — remove o milhar
    const lastComma = text.lastIndexOf(',')
    const lastDot = text.lastIndexOf('.')
    normalized = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '')
  } else if (hasComma) {
    normalized = text.replace(',', '.')
  }
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

export function parseWeighTable(text: string): ParsedWeighTable {
  const rows: ParsedWeighRow[] = []
  const errors: string[] = []
  let nextPos: number | null = null

  const lines = text.split(/\r?\n/)
  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim()
    if (!line) return
    const lineNumber = idx + 1
    const cols = splitColumns(rawLine)
    const posText = (cols[0] ?? '').trim()
    const massText = (cols[1] ?? '').trim()

    if (!massText) {
      errors.push(`Linha ${lineNumber}: sem massa na 2ª coluna.`)
      return
    }
    const mass = parseMassNumber(massText)
    if (mass === null) {
      errors.push(`Linha ${lineNumber}: massa "${massText}" não é um número válido.`)
      return
    }

    let crucible: number
    if (posText) {
      const parsed = Number.parseInt(posText, 10)
      if (!Number.isInteger(parsed)) {
        errors.push(`Linha ${lineNumber}: posição "${posText}" não é um número inteiro válido.`)
        return
      }
      crucible = parsed
    } else if (nextPos !== null) {
      crucible = nextPos
    } else {
      errors.push(`Linha ${lineNumber}: informe a posição inicial na 1ª coluna da primeira linha.`)
      return
    }

    if (crucible < 1 || crucible > 48) {
      errors.push(`Linha ${lineNumber}: posição ${crucible} fora do intervalo 1–48.`)
      nextPos = crucible + 1
      return
    }

    rows.push({ line: lineNumber, crucible, massMg: mass })
    nextPos = crucible + 1
  })

  return { rows, errors }
}
