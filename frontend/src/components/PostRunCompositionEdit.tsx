import { useState } from 'react'
import { ApiError } from '../api/client'
import { postrunApi, type AnalysisSummary, type CompositionStatus } from '../api/postrun'
import { inputInlineClass as inputClass } from '../ui/classes'

// Ver e informar a composição de UMA corrida ali mesmo (pedido do usuário,
// 16/11/2026: "onde eu insiro a composição?"). Mostra o que o Horun entendeu
// do nome — completa, sem proporção ou não identificada — e, ao clicar,
// abre um campo com exemplos. Grava na hora, como a massa (PostRunMassEdit).
// Vazio = volta ao que o nome do arquivo diz.

const STATUS_STYLE: Record<CompositionStatus, { color: string; border: string; hint: string }> = {
  completa: { color: 'var(--color-text)', border: 'var(--color-border)', hint: '' },
  sem_proporcao: {
    color: '#b26a00',
    border: '#b26a00',
    hint: 'sem a proporção: os picos são separados e a massa de cada um sai da curva, mas não dá para calcular a recuperação',
  },
  desconhecida: {
    color: 'var(--color-text-muted)',
    border: 'var(--color-text-muted)',
    hint: 'nenhum material conhecido no nome — fica de fora; se for um material, clique e informe',
  },
}

export function compositionLabel(a: Pick<AnalysisSummary, 'composition_status' | 'composition_text'>): string {
  if (a.composition_status === 'desconhecida' || !a.composition_text) return 'composição?'
  return a.composition_text
}

export function PostRunCompositionEdit({
  token,
  summary,
  onSaved,
  compact = false,
}: {
  token: string
  summary: Pick<AnalysisSummary, 'composition_status' | 'composition_text' | 'composition_note' | 'composition_source' | 'components' | 'composition'>
  onSaved: (updated: AnalysisSummary[]) => void
  /** só o selo, sem a linha de explicação abaixo */
  compact?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = summary.composition_status ?? 'desconhecida'
  // na lista de análises (compacto) a maioria das corridas são rochas e
  // padrões, sem composição de polímero — "composição?" discreto, não vermelho
  const style =
    compact && status === 'desconhecida'
      ? { ...STATUS_STYLE.desconhecida, color: 'var(--color-text-dim)', border: 'var(--color-border)' }
      : STATUS_STYLE[status]
  const manual = summary.composition_source === 'manual'

  function start(e: React.MouseEvent) {
    e.stopPropagation()
    // o campo começa com o que já vale, no formato que se digita
    const comp = summary.composition
    setValue(
      comp && Object.keys(comp).length > 1
        ? Object.entries(comp)
            .map(([k, v]) => `${k} ${+(100 * v).toFixed(2)}`.replace('.', ','))
            .join(', ')
        : (summary.components ?? []).join(', '),
    )
    setError(null)
    setEditing(true)
  }

  async function save(text: string) {
    setBusy(true)
    try {
      const updated = await postrunApi.updateMeta([{ token, composition_text: text.trim() }])
      onSaved(updated)
      setEditing(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erro ao salvar')
    } finally {
      setBusy(false)
    }
  }

  const title = [summary.composition_note, style.hint, 'clique para informar ou corrigir'].filter(Boolean).join(' — ')

  if (!editing)
    return (
      <span className="inline-flex flex-col">
        <button
          type="button"
          onClick={start}
          title={title}
          className="inline-flex w-fit items-center gap-1 rounded-full border border-dashed px-1.5 text-[11px] leading-4 hover:bg-[var(--color-surface)]"
          style={{ color: style.color, borderColor: style.border }}
        >
          {compositionLabel(summary)}
          {manual ? ' ✎' : ''}
        </button>
        {!compact && status !== 'completa' && (
          <span className="text-[10px] text-[var(--color-text-dim)]">{style.hint}</span>
        )}
      </span>
    )

  return (
    <span
      className="mt-1 flex w-full min-w-[240px] flex-col gap-1 rounded-lg border p-2 text-xs border-[var(--color-border)] bg-[var(--color-bg-elevated)]"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-[var(--color-text-muted)]">
        Composição desta corrida{summary.composition_note ? ` — hoje: ${summary.composition_note}` : ''}
      </span>
      <input
        autoFocus
        className={`${inputClass} w-full`}
        value={value}
        placeholder="ex.: PS · PP 50, PS 50 · PP, PS"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save(value)
          if (e.key === 'Escape') setEditing(false)
        }}
        disabled={busy}
        aria-label="composição"
      />
      <span className="text-[10.5px] leading-snug text-[var(--color-text-muted)]">
        <strong>PS</strong> = puro · <strong>PP 50, PS 50</strong> = mistura com a proporção (dá a recuperação) ·{' '}
        <strong>PP, PS</strong> = sei o que tem, não a proporção (dá só a massa de cada um). Qualquer nome de material vale; um
        material novo informado aqui passa a ser reconhecido no nome das próximas corridas.
      </span>
      {error && <span className="text-[var(--color-danger)]">{error}</span>}
      <span className="flex flex-wrap gap-2">
        <button type="button" className="rounded-md bg-[var(--color-primary)] px-2 py-0.5 text-[var(--color-primary-contrast)]" disabled={busy} onClick={() => void save(value)}>
          {busy ? 'salvando…' : 'Salvar'}
        </button>
        {manual && (
          <button type="button" className="text-[var(--color-text-muted)] hover:underline" disabled={busy} onClick={() => void save('')} title="apaga o que foi informado aqui e volta a ler o nome do arquivo">
            voltar ao nome do arquivo
          </button>
        )}
        <button type="button" className="text-[var(--color-text-muted)] hover:underline" disabled={busy} onClick={() => setEditing(false)}>
          cancelar
        </button>
      </span>
    </span>
  )
}
