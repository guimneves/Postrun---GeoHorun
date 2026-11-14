// Regra explícita ao lado dos campos que viram nome de análise (nome/código
// da biblioteca, "extra"): `. , / \ : ;` são proibidos — o RockSeven
// Supervisor rejeita. Em vermelho quando o valor digitado tem algum deles.
import { FORBIDDEN_NAME_CHARS_TEXT, forbiddenChars } from '../lib/rockevalName'

export function RockEvalNameHint({ value }: { value: string | null | undefined }) {
  const found = forbiddenChars(value)
  if (found.length > 0) {
    return (
      <span role="alert" className="block text-xs font-normal text-[var(--color-danger)]">
        Remova {found.map((c) => `"${c}"`).join(' ')} — o RockSeven Supervisor não aceita{' '}
        <code>{FORBIDDEN_NAME_CHARS_TEXT}</code> no nome.
      </span>
    )
  }
  return (
    <span className="block text-xs font-normal text-[var(--color-text-dim)]">
      Sem <code>{FORBIDDEN_NAME_CHARS_TEXT}</code> (o RockSeven Supervisor não aceita).
    </span>
  )
}

/** Aviso pequeno para registros ANTIGOS que já têm esses caracteres (a
 * listagem continua normal; só alerta que o Supervisor vai rejeitar). */
export function RockEvalNameWarning({ value }: { value: string | null | undefined }) {
  const found = forbiddenChars(value)
  if (found.length === 0) return null
  return (
    <span
      className="ml-1 cursor-help text-xs"
      style={{ color: '#d97706' }}
      title={`Tem ${found.join(' ')} — o RockSeven Supervisor rejeita esses caracteres. Edite o nome/código.`}
      aria-label="nome com caracteres que o RockSeven Supervisor rejeita"
    >
      ⚠
    </span>
  )
}
