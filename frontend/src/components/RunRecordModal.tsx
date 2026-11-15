import { useEffect, useState } from 'react'
import { ApiError } from '../api/client'
import {
  runsApi,
  type ExclusionLogEntry,
  type ExclusionReason,
  type RunRecord,
} from '../api/postrun'
import { btnClass, btnPrimaryClass, inputClass } from '../ui/classes'
import { IconClose } from '../ui/icons'

const REASONS: [ExclusionReason, string][] = [
  ['falha', 'corrida falha'],
  ['massa_ausente', 'massa ausente'],
  ['nome_suspeito', 'troca de nome suspeita'],
  ['outro', 'outro'],
]

/** Ficha de rastreabilidade (F4 do artigo). Com UMA corrida: metadados,
 * exclusão/restauração e o histórico. Com várias (marcadas na lista): só
 * excluir ou restaurar todas de uma vez. */
export function RunRecordModal({
  tokens,
  labelOf,
  onClose,
  onChanged,
}: {
  tokens: string[]
  labelOf: (token: string) => string
  onClose: () => void
  onChanged: (records: RunRecord[]) => void
}) {
  const single = tokens.length === 1
  const [records, setRecords] = useState<RunRecord[] | null>(null)
  const [log, setLog] = useState<ExclusionLogEntry[]>([])
  const [meta, setMeta] = useState({ matrix: '', lot: '', gran: '', operator: '', date: '', notes: '' })
  const [reason, setReason] = useState<ExclusionReason>('falha')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const tokensKey = tokens.join('|')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const tokens = tokensKey.split('|')
    runsApi
      .records(tokens)
      .then((rs) => {
        setRecords(rs)
        if (rs.length === 1) {
          const r = rs[0]
          setMeta({
            matrix: r.matrix_mass_mg !== null ? String(r.matrix_mass_mg) : '',
            lot: r.polymer_lot, gran: r.granulometry, operator: r.operator, date: r.run_date, notes: r.notes,
          })
        }
      })
      .catch((err) => setMessage(err instanceof ApiError ? err.message : 'Erro ao ler a ficha'))
    runsApi.log(tokens).then(setLog).catch(() => setLog([]))
  }, [tokensKey])

  const nExcluded = (records ?? []).filter((r) => r.excluded).length

  async function act(fn: () => Promise<RunRecord[]>, ok: string) {
    setBusy(true)
    setMessage(null)
    try {
      const changed = await fn()
      const fresh = await runsApi.records(tokens)
      setRecords(fresh)
      runsApi.log(tokens).then(setLog).catch(() => undefined)
      onChanged(changed.length ? fresh : [])
      setComment('')
      setMessage(ok)
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Erro')
    } finally {
      setBusy(false)
    }
  }

  const saveMeta = () =>
    act(
      () =>
        runsApi.saveRecords([
          {
            token: tokens[0],
            matrix_mass_mg: meta.matrix.trim() ? Number(meta.matrix.replace(',', '.')) : null,
            polymer_lot: meta.lot, granulometry: meta.gran, operator: meta.operator, run_date: meta.date, notes: meta.notes,
          },
        ]),
      'Metadados salvos.',
    )

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Ficha da corrida"
        className="flex w-full max-w-2xl flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5 shadow-[var(--shadow-card)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{single ? 'Ficha da corrida' : `${tokens.length} corridas marcadas`}</h2>
            <p className="truncate font-mono text-xs text-[var(--color-text-muted)]">
              {single ? labelOf(tokens[0]) : tokens.slice(0, 3).map(labelOf).join(', ') + (tokens.length > 3 ? '…' : '')}
            </p>
          </div>
          <button type="button" className={btnClass} onClick={onClose} aria-label="fechar">
            <IconClose size={15} />
          </button>
        </div>

        {single && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Metadados</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(
                [
                  ['matrix', 'Massa de matriz (mg)', 'ex.: 60'],
                  ['lot', 'Lote / fabricante do polímero', ''],
                  ['gran', 'Granulometria', 'ex.: < 250 µm'],
                  ['operator', 'Operador(a)', ''],
                  ['date', 'Data (AAAA-MM-DD)', 'vazio = a do .B00'],
                ] as const
              ).map(([k, label, ph]) => (
                <label key={k} className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                  {label}
                  <input className={inputClass} value={meta[k]} placeholder={ph}
                    onChange={(e) => setMeta((m) => ({ ...m, [k]: e.target.value }))} />
                </label>
              ))}
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)] sm:col-span-3">
                Observações
                <input className={inputClass} value={meta.notes} onChange={(e) => setMeta((m) => ({ ...m, notes: e.target.value }))} />
              </label>
            </div>
            <div>
              <button type="button" className={btnClass} disabled={busy || !records} onClick={() => void saveMeta()}>
                Salvar metadados
              </button>
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] p-3">
          <h3 className="text-sm font-semibold">Exclusão</h3>
          {records && nExcluded > 0 && (
            <ul className="text-xs text-[var(--color-danger)]">
              {records.filter((r) => r.excluded).map((r) => (
                <li key={r.token}>
                  {!single && <span className="font-mono">{labelOf(r.token)}: </span>}
                  excluída — {r.exclusion_reason_label}
                  {r.exclusion_comment && `: ${r.exclusion_comment}`} ({r.excluded_by},{' '}
                  {r.excluded_at ? new Date(r.excluded_at).toLocaleString('pt-BR') : ''})
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-[var(--color-text-muted)]">
            Excluída, a corrida sai do relatório de recuperação, da validação e dos pontos das curvas — com o motivo à vista.
            Nada é apagado, e dá para restaurar.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[200px_1fr]">
            <select className={inputClass} value={reason} onChange={(e) => setReason(e.target.value as ExclusionReason)}>
              {REASONS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <input className={inputClass} value={comment} onChange={(e) => setComment(e.target.value)}
              placeholder="comentário (obrigatório para excluir)" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnPrimaryClass} disabled={busy || !comment.trim() || (records !== null && nExcluded === tokens.length)}
              onClick={() => void act(() => runsApi.exclude(tokens, reason, comment), 'Excluída(s).')}>
              Excluir{single ? '' : ` ${tokens.length - nExcluded}`}
            </button>
            {nExcluded > 0 && (
              <button type="button" className={btnClass} disabled={busy}
                onClick={() => void act(() => runsApi.restore(tokens, comment), 'Restaurada(s).')}>
                Restaurar{single ? '' : ` ${nExcluded}`}
              </button>
            )}
          </div>
        </section>

        {log.length > 0 && (
          <section className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">Histórico</h3>
            <ul className="max-h-40 overflow-auto text-xs text-[var(--color-text-muted)]">
              {log.map((g, i) => (
                <li key={i}>
                  {new Date(g.at).toLocaleString('pt-BR')} · {g.user} · <strong>{g.action}</strong>
                  {!single && <span className="font-mono"> {labelOf(g.token)}</span>} — {g.reason_label}
                  {g.comment && `: ${g.comment}`}
                </li>
              ))}
            </ul>
          </section>
        )}
        {message && <p className="text-xs text-[var(--color-text-muted)]">{message}</p>}
      </div>
    </div>
  )
}
