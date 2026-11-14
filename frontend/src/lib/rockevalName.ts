// Pedido do usuário (2026-10-14): o RockSeven Supervisor dá conflito com
// pontuação no nome da análise — `. , / \ : ;` são proibidos no nome/código
// das amostras da biblioteca e no "extra" (tudo isso vira parte do nome
// AAAA-MM-DD_código_extra_réplica). Mesma regra do backend
// (`naming.FORBIDDEN_NAME_CHARS`); a tela só avisa e desabilita o botão —
// nunca troca o texto sozinha.
export const FORBIDDEN_NAME_CHARS = ['.', ',', '/', '\\', ':', ';'] as const

export const FORBIDDEN_NAME_CHARS_TEXT = FORBIDDEN_NAME_CHARS.join(' ')

/** Os caracteres proibidos presentes em `value` (vazio = tudo certo). */
export function forbiddenChars(value: string | null | undefined): string[] {
  if (!value) return []
  return FORBIDDEN_NAME_CHARS.filter((c) => value.includes(c))
}

export function hasForbiddenChars(value: string | null | undefined): boolean {
  return forbiddenChars(value).length > 0
}
