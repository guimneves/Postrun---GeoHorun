// Renomear nome e/ou job de uma análise já feita — move o .B00 e o .B00~ na
// RE7raw-data do equipamento (backend/app/api/routes_analysis_rename.py).
// O caso típico é ter esquecido o "extra" no cadastro: para nomes na
// convenção AAAA-MM-DD_código_réplica, basta digitar o extra. Toda mudança
// é conferida no servidor (dry_run) antes de habilitar o botão.
import { useEffect, useState } from 'react'
import { ApiError } from '../api/client'
import { postrunApi, type AnalysisSummary, type RenameInfo, type RenameResult } from '../api/postrun'
import { RockEvalNameHint } from './RockEvalNameHint'
import { inputLgClass as inputClass } from '../ui/classes'

type Mode = 'extra' | 'full'

interface Props {
  analysis: AnalysisSummary
  jobs: string[]
  onClose: () => void
  onDone: (result: RenameResult) => void
}

export function RenameAnalysisModal({ analysis, jobs, onClose, onDone }: Props) {
  const [info, setInfo] = useState<RenameInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('extra')
  const [extra, setExtra] = useState('')
  const [fullName, setFullName] = useState('')
  const [job, setJob] = useState(analysis.job)
  const [preview, setPreview] = useState<RenameResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    postrunApi
      .renameInfo(analysis.token)
      .then((i) => {
        setInfo(i)
        setFullName(i.analysis_name)
        setMode(i.follows_convention ? 'extra' : 'full')
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Erro ao carregar a análise'))
  }, [analysis.token])

  const body = {
    token: analysis.token,
    extra: mode === 'extra' && extra.trim() ? extra.trim() : undefined,
    analysis_name: mode === 'full' && info && fullName.trim() !== info.analysis_name ? fullName.trim() : undefined,
    job: job.trim() && job.trim() !== analysis.job ? job.trim() : undefined,
  }
  const nothingChanged = !body.extra && !body.analysis_name && !body.job

  // prévia validada pelo servidor (mesmas regras do rename de verdade)
  useEffect(() => {
    setPreview(null)
    setPreviewError(null)
    if (!info || info.blocked_reason || nothingChanged) return
    const timer = setTimeout(() => {
      postrunApi
        .renameAnalysis({ ...body, dry_run: true })
        .then(setPreview)
        .catch((err) => setPreviewError(err instanceof ApiError ? err.message : 'Erro ao validar'))
    }, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, mode, extra, fullName, job])

  async function confirm() {
    setSubmitting(true)
    setSubmitError(null)
    try {
      onDone(await postrunApi.renameAnalysis(body))
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Erro ao renomear')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Renomear análise"
        className="max-h-[100dvh] w-full max-w-lg overflow-y-auto rounded-t-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5 shadow-xl sm:max-h-[90vh] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-base font-semibold text-[var(--color-text)]">Renomear análise</h2>
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">
          Move o <code>.B00</code> e o <code>.B00~</code> no equipamento. O conteúdo dos arquivos não muda; o histórico
          guarda o nome original e passa a mostrar o atual.
        </p>

        {loadError && <p className="mb-3 text-sm text-red-600">{loadError}</p>}
        {!info && !loadError && <p className="text-sm text-[var(--color-text-muted)]">Carregando…</p>}

        {info && (
          <>
            <div className="mb-3 rounded-lg bg-[var(--color-surface)] px-3 py-2 text-xs">
              <div className="font-mono text-[var(--color-text)]">{info.analysis_name}</div>
              <div className="text-[var(--color-text-muted)]">
                job {info.job}
                {info.renamed_from ? ` · renomeada de ${info.renamed_from}` : ''}
              </div>
            </div>

            {info.blocked_reason ? (
              <p className="mb-3 rounded-lg px-3 py-2 text-sm" style={{ background: '#fef3c7', color: '#92400e' }}>
                {info.blocked_reason}
              </p>
            ) : (
              <>
                {info.follows_convention && (
                  <div className="mb-3 flex gap-4 text-sm">
                    <label className="flex items-center gap-1.5">
                      <input type="radio" checked={mode === 'extra'} onChange={() => setMode('extra')} />
                      Acrescentar extra
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" checked={mode === 'full'} onChange={() => setMode('full')} />
                      Nome completo
                    </label>
                  </div>
                )}

                {mode === 'extra' ? (
                  <label className="mb-3 block text-sm">
                    <span className="mb-1 block text-[var(--color-text-muted)]">
                      Extra {info.current_extra ? `(hoje: ${info.current_extra})` : ''}
                    </span>
                    <input
                      className={inputClass}
                      value={extra}
                      onChange={(e) => setExtra(e.target.value)}
                      placeholder="ex. rep, moido, ciclo2"
                      autoFocus
                    />
                    <RockEvalNameHint value={extra} />
                  </label>
                ) : (
                  <label className="mb-3 block text-sm">
                    <span className="mb-1 block text-[var(--color-text-muted)]">Nome da análise</span>
                    <input className={`${inputClass} font-mono`} value={fullName} onChange={(e) => setFullName(e.target.value)} />
                    {info && fullName.trim() !== info.analysis_name && <RockEvalNameHint value={fullName} />}
                  </label>
                )}

                <label className="mb-3 block text-sm">
                  <span className="mb-1 block text-[var(--color-text-muted)]">Job (pasta)</span>
                  <input className={inputClass} list="rename-jobs" value={job} onChange={(e) => setJob(e.target.value)} />
                  <datalist id="rename-jobs">
                    {jobs.map((j) => (
                      <option key={j} value={j} />
                    ))}
                  </datalist>
                </label>

                <div className="mb-3 min-h-[2.5rem] text-xs">
                  {previewError && <p className="text-red-600">{previewError}</p>}
                  {preview && (
                    <p className="text-[var(--color-text-muted)]">
                      Vai ficar: <span className="font-mono text-[var(--color-text)]">{preview.new_token}</span>
                      <br />
                      (e o <code>.B00~</code> junto, se existir)
                    </p>
                  )}
                </div>
              </>
            )}

            {submitError && <p className="mb-3 text-sm text-red-600">{submitError}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-lg px-4 py-2 text-sm text-[var(--color-text-muted)]" onClick={onClose}>
                Cancelar
              </button>
              {!info.blocked_reason && (
                <button
                  type="button"
                  disabled={!preview || submitting}
                  onClick={confirm}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-contrast)]
                             bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
                >
                  {submitting ? 'Renomeando…' : 'Renomear'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
