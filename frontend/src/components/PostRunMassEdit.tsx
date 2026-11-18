import { useState } from 'react'
import { ApiError } from '../api/client'
import { postrunApi, type AnalysisSummary } from '../api/postrun'

// Editar a massa de UMA corrida ali mesmo (pedido do usuário, 16/10/2026) —
// clica no valor, digita, Enter. Grava na hora (é uma correção do dado, não
// um rascunho da análise) e só mexe na massa: a composição corrigida, se
// houver, fica como estava. Desde 23/10/2026 a massa vai também para o
// próprio .B00 (linha Quant=); vazio = grava de volta a massa original.
export function PostRunMassEdit({
  token,
  massMg,
  manual,
  fileMassMg,
  originalMassMg,
  onSaved,
  className = '',
}: {
  token: string
  massMg: number | null
  /** a massa atual é uma correção feita na tela */
  manual: boolean
  /** massa gravada no .B00 (para mostrar ao corrigir) */
  fileMassMg?: number | null
  /** massa que estava no .B00 antes da correção (a tela grava a nova no arquivo) */
  originalMassMg?: number | null
  onSaved: (updated: AnalysisSummary[]) => void
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // salvo no Horun, mas o .B00 não pôde ser gravado (ex. Agente só leitura)
  const [note, setNote] = useState<string | null>(null)

  function start(e: React.MouseEvent) {
    e.stopPropagation()
    setValue(manual && massMg != null ? String(massMg).replace('.', ',') : '')
    setError(null)
    setEditing(true)
  }

  async function save() {
    const text = value.trim().replace(',', '.')
    const mass = text ? Number(text) : null
    if (mass !== null && !(mass > 0)) {
      setError('massa inválida')
      return
    }
    setBusy(true)
    try {
      const updated = await postrunApi.updateMeta([{ token, mass_mg: mass }])
      setNote(updated.find((u) => u.token === token)?.file_note ?? null)
      onSaved(updated)
      setEditing(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erro ao salvar')
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    const bad = !(massMg != null && massMg > 0)
    const original = originalMassMg != null ? ` (gravada no arquivo; original ${originalMassMg.toFixed(3)} mg)` : ''
    return (
      <>
      <button
        type="button"
        onClick={start}
        className={`font-medium underline decoration-dotted underline-offset-2 hover:text-[var(--color-primary)] ${className}`}
        style={{ color: bad ? 'var(--color-danger)' : undefined }}
        title={
          (manual ? `massa corrigida na tela${original}` : bad ? 'massa zero no arquivo' : 'massa do arquivo') + ' — clique para editar'
        }
      >
        {massMg != null ? `${massMg.toFixed(3)} mg` : '— mg'}
        {manual ? ' ✎' : ''}
      </button>
      {note && (
        <span className="ml-1 text-[10px] text-[var(--color-warning,var(--color-danger))]" title={note}>
          ⚠ só no Horun
        </span>
      )}
      </>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        inputMode="decimal"
        className="w-20 rounded border px-1 py-0.5 text-xs border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)]"
        value={value}
        placeholder={originalMassMg != null ? `${originalMassMg} (original)` : fileMassMg != null ? `${fileMassMg} (.B00)` : 'mg'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
          if (e.key === 'Escape') setEditing(false)
        }}
        disabled={busy}
      />
      <span className="text-[10px] text-[var(--color-text-dim)]">mg</span>
      <button type="button" className="px-1 text-[var(--color-primary)]" onClick={() => void save()} disabled={busy} title="salvar">
        ✓
      </button>
      <button type="button" className="px-1 text-[var(--color-text-dim)]" onClick={() => setEditing(false)} disabled={busy} title="cancelar">
        ✕
      </button>
      {error ? (
        <span className="text-[10px] text-[var(--color-danger)]">{error}</span>
      ) : (
        <span className="text-[10px] text-[var(--color-text-dim)]">grava também no .B00 · vazio = massa original</span>
      )}
    </span>
  )
}
