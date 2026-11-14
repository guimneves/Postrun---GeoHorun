// Mover várias análises do PostRun para outro job de uma vez (pedido do
// usuário, 2026-10-14: "Postrun mover em lote") — POST
// /postrun/analyses/move-batch. Cada análise passa pelas MESMAS regras do
// mover/renomear individual (RenameAnalysisModal); não é tudo ou nada: a
// tela mostra, análise por análise, o que vai acontecer (prévia no servidor)
// e depois o que aconteceu.
import { useEffect, useState } from 'react'
import { ApiError } from '../api/client'
import { postrunApi, type MoveBatchItem, type MoveBatchResult } from '../api/postrun'

const inputClass =
  'w-full rounded-lg border px-3 py-2 text-sm border-[var(--color-border)] ' +
  'bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none ' +
  'focus:ring-2 focus:ring-[var(--color-primary)]'

const STATUS_LABEL: Record<MoveBatchItem['status'], string> = {
  planned: 'vai mover',
  done: 'movida',
  failed: 'não movida',
  skipped: 'ignorada',
}

const STATUS_COLOR: Record<MoveBatchItem['status'], string> = {
  planned: 'var(--color-text-muted)',
  done: '#15803d',
  failed: 'var(--color-danger)',
  skipped: '#b45309',
}

function nameOf(token: string): string {
  const file = token.split('/').pop() ?? token
  return file.replace(/\.B00$/, '')
}

interface Props {
  tokens: string[]
  jobs: string[]
  currentJob: string
  onClose: () => void
  /** chamado ao fechar depois de mover (mesmo que só parte tenha andado) */
  onDone: (result: MoveBatchResult) => void
}

export function MoveAnalysesBatchModal({ tokens, jobs, currentJob, onClose, onDone }: Props) {
  const [job, setJob] = useState('')
  const [preview, setPreview] = useState<MoveBatchResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<MoveBatchResult | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const target = job.trim()

  // prévia validada pelo servidor (mesmas regras do mover de verdade)
  useEffect(() => {
    setPreview(null)
    setPreviewError(null)
    if (!target || result) return
    const timer = setTimeout(() => {
      postrunApi
        .moveBatch({ tokens, job: target, dry_run: true })
        .then(setPreview)
        .catch((err) => setPreviewError(err instanceof ApiError ? err.message : 'Erro ao validar'))
    }, 300)
    return () => clearTimeout(timer)
  }, [target, tokens, result])

  const plannedCount = preview?.items.filter((i) => i.status === 'planned').length ?? 0

  async function confirm() {
    setSubmitting(true)
    setSubmitError(null)
    try {
      setResult(await postrunApi.moveBatch({ tokens, job: target }))
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Erro ao mover')
    } finally {
      setSubmitting(false)
    }
  }

  function close() {
    if (result) onDone(result)
    else onClose()
  }

  const shown = result ?? preview
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={close}>
      <div
        role="dialog"
        aria-label="Mover análises em lote"
        className="flex max-h-[100dvh] w-full max-w-xl flex-col overflow-y-auto rounded-t-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5 shadow-xl sm:max-h-[90vh] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-base font-semibold text-[var(--color-text)]">
          Mover {tokens.length} análise{tokens.length === 1 ? '' : 's'} para outro job
        </h2>
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">
          Move o <code>.B00</code> e o <code>.B00~</code> de cada uma para a pasta do job escolhido, na mesma pasta de
          método. O conteúdo não muda. Cada análise é conferida separadamente: se uma não puder ser movida (ainda no
          carrossel, nome já existente no destino…), as outras andam mesmo assim.
        </p>

        {!result && (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-[var(--color-text-muted)]">Job de destino (pasta)</span>
            <input
              className={inputClass}
              list="move-batch-jobs"
              value={job}
              onChange={(e) => setJob(e.target.value)}
              placeholder="escolha um job ou digite um novo"
              autoFocus
            />
            <datalist id="move-batch-jobs">
              {jobs
                .filter((j) => j !== currentJob)
                .map((j) => (
                  <option key={j} value={j} />
                ))}
            </datalist>
          </label>
        )}

        {previewError && !result && <p className="mb-3 text-sm text-[var(--color-danger)]">{previewError}</p>}

        {result && (
          <p className="mb-3 text-sm text-[var(--color-text)]">
            Job <strong>{result.job}</strong>: {result.done} movida{result.done === 1 ? '' : 's'}
            {result.failed > 0 && <>, {result.failed} não movida{result.failed === 1 ? '' : 's'}</>}
            {result.skipped > 0 && <>, {result.skipped} ignorada{result.skipped === 1 ? '' : 's'}</>}.
          </p>
        )}

        <ul className="mb-3 max-h-[45vh] divide-y divide-[var(--color-border)] overflow-y-auto rounded-lg border border-[var(--color-border)] text-xs">
          {tokens.map((t) => {
            const item = shown?.items.find((i) => i.token === t)
            return (
              <li key={t} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <span className="min-w-0 break-all font-mono text-[var(--color-text)]">{nameOf(t)}</span>
                {item ? (
                  <span className="shrink-0 sm:max-w-[55%] sm:text-right" style={{ color: STATUS_COLOR[item.status] }}>
                    {STATUS_LABEL[item.status]}
                    {item.error && <span className="block break-words">{item.error}</span>}
                  </span>
                ) : (
                  <span className="shrink-0 text-[var(--color-text-dim)]">
                    {target ? 'conferindo…' : t.split('/')[0]}
                  </span>
                )}
              </li>
            )
          })}
        </ul>

        {submitError && <p className="mb-3 text-sm text-[var(--color-danger)]">{submitError}</p>}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="rounded-lg px-4 py-2 text-sm text-[var(--color-text-muted)]" onClick={close}>
            {result ? 'Fechar' : 'Cancelar'}
          </button>
          {!result && (
            <button
              type="button"
              disabled={!preview || plannedCount === 0 || submitting}
              onClick={confirm}
              className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-contrast)]
                         bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
            >
              {submitting ? 'Movendo…' : `Mover ${plannedCount} análise${plannedCount === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
