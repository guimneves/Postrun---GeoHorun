// Trocar a AMOSTRA de análises já feitas (pedido do usuário, 2026-10-20: "a
// pessoa cadastrou uma amostra na biblioteca com o nome errado, foi para o
// B00 errado") — POST /postrun/analyses/change-sample. Só amostras da
// biblioteca (filtro por grupo e subgrupo). Troca o Sample= dentro do .B00 e
// o código no nome do arquivo; data, extra e réplica ficam — se o nome novo
// já existir, a réplica vai para o próximo número livre. Prévia no servidor
// antes de confirmar; depois, o que aconteceu com cada análise.
import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { libraryApi, type LibrarySampleOut, type SampleGroupOut } from '../api/library'
import { postrunApi, type ChangeSampleItem, type ChangeSampleResult } from '../api/postrun'

const inputClass =
  'w-full rounded-lg border px-3 py-2 text-sm border-[var(--color-border)] ' +
  'bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none ' +
  'focus:ring-2 focus:ring-[var(--color-primary)]'

const STATUS_LABEL: Record<ChangeSampleItem['status'], string> = {
  planned: 'vai virar',
  done: 'trocada →',
  failed: 'não trocada',
  skipped: 'ignorada',
}
const STATUS_COLOR: Record<ChangeSampleItem['status'], string> = {
  planned: 'var(--color-text-muted)',
  done: '#15803d',
  failed: 'var(--color-danger)',
  skipped: '#b45309',
}

function nameOf(token: string): string {
  return (token.split('/').pop() ?? token).replace(/\.B00$/, '')
}

interface Props {
  tokens: string[]
  onClose: () => void
  /** chamado ao fechar depois de trocar (mesmo que só parte tenha andado) */
  onDone: (result: ChangeSampleResult) => void
}

export function ChangeSampleModal({ tokens, onClose, onDone }: Props) {
  const [groups, setGroups] = useState<SampleGroupOut[]>([])
  const [samples, setSamples] = useState<LibrarySampleOut[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [groupId, setGroupId] = useState<number | ''>('')
  const [subgroupId, setSubgroupId] = useState<number | ''>('')
  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState<LibrarySampleOut | null>(null)
  const [preview, setPreview] = useState<ChangeSampleResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<ChangeSampleResult | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([libraryApi.listGroups(), libraryApi.listSamples()])
      .then(([g, s]) => {
        setGroups(g)
        setSamples(s)
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Erro ao ler a biblioteca'))
  }, [])

  const topGroups = groups.filter((g) => g.parent_group_id === null).sort((a, b) => a.name.localeCompare(b.name))
  const subgroups = groups.filter((g) => groupId !== '' && g.parent_group_id === groupId).sort((a, b) => a.name.localeCompare(b.name))
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const inGroup = (s: LibrarySampleOut) => {
      if (subgroupId !== '') return s.group_id === subgroupId
      if (groupId === '') return true
      return s.group_id === groupId || groups.some((g) => g.id === s.group_id && g.parent_group_id === groupId)
    }
    return samples.filter((s) => inGroup(s) && (!q || `${s.code} ${s.name}`.toLowerCase().includes(q))).slice(0, 200)
  }, [samples, groups, groupId, subgroupId, search])

  // prévia validada no servidor (lê cada .B00 e calcula o nome novo)
  useEffect(() => {
    setPreview(null)
    setPreviewError(null)
    if (!chosen || result) return
    postrunApi
      .changeSample({ tokens, library_sample_id: chosen.id, dry_run: true })
      .then(setPreview)
      .catch((err) => setPreviewError(err instanceof ApiError ? err.message : 'Erro ao conferir'))
  }, [chosen, tokens, result])

  const plannedCount = preview?.items.filter((i) => i.status === 'planned').length ?? 0

  async function confirm() {
    if (!chosen) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      setResult(await postrunApi.changeSample({ tokens, library_sample_id: chosen.id }))
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Erro ao trocar a amostra')
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
        aria-label="Trocar a amostra das análises"
        className="flex max-h-[100dvh] w-full max-w-2xl flex-col overflow-y-auto rounded-t-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5 shadow-xl sm:max-h-[92vh] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-base font-semibold text-[var(--color-text)]">
          Trocar a amostra de {tokens.length} análise{tokens.length === 1 ? '' : 's'}
        </h2>
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">
          Para quando a amostra errada da biblioteca foi escolhida no cadastro. Troca o nome da amostra <strong>dentro</strong> do{' '}
          <code>.B00</code> (linha <code>Sample=</code>) e o código no <strong>nome da análise</strong> — data, extra e réplica ficam.
          Se o nome novo já existir, a réplica passa para o próximo número livre (réplicas da amostra errada viram as seguintes da
          certa). O resto do arquivo não muda; regiões, deconvoluções e curvas acompanham.
        </p>

        {!result && (
          <div className="mb-3 flex flex-col gap-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <select
                className={inputClass}
                value={groupId}
                onChange={(e) => {
                  setGroupId(e.target.value ? Number(e.target.value) : '')
                  setSubgroupId('')
                }}
                aria-label="Grupo"
              >
                <option value="">Todos os grupos</option>
                {topGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <select
                className={inputClass}
                value={subgroupId}
                onChange={(e) => setSubgroupId(e.target.value ? Number(e.target.value) : '')}
                disabled={groupId === '' || subgroups.length === 0}
                aria-label="Subgrupo"
              >
                <option value="">{groupId !== '' && subgroups.length === 0 ? 'sem subgrupos' : 'Todos os subgrupos'}</option>
                {subgroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <input className={inputClass} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="buscar código ou nome…" />
            </div>
            {loadError && <p className="text-sm text-[var(--color-danger)]">{loadError}</p>}
            <ul className="max-h-48 overflow-y-auto rounded-lg border border-[var(--color-border)] text-sm" role="listbox" aria-label="Amostras da biblioteca">
              {filtered.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-text-muted)]">Nenhuma amostra com esse filtro.</li>}
              {filtered.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={chosen?.id === s.id}
                    onClick={() => setChosen(s)}
                    className="flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left hover:bg-[var(--color-surface)]"
                    style={chosen?.id === s.id ? { background: 'var(--color-primary)', color: 'var(--color-primary-contrast)' } : undefined}
                  >
                    <span className="min-w-0">
                      <span className="font-mono font-medium">{s.code}</span> <span className="opacity-80">· {s.name}</span>
                    </span>
                    <span className="shrink-0 text-[11px] opacity-70">
                      {s.group_parent_name ? `${s.group_parent_name} › ` : ''}
                      {s.group_name ?? 'sem grupo'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {chosen && !result && (
          <p className="mb-2 text-sm">
            Amostra certa: <strong className="font-mono">{chosen.code}</strong> <span className="text-[var(--color-text-muted)]">({chosen.name})</span>
          </p>
        )}
        {previewError && !result && <p className="mb-3 text-sm text-[var(--color-danger)]">{previewError}</p>}
        {result && (
          <p className="mb-3 text-sm text-[var(--color-text)]">
            Amostra <strong className="font-mono">{result.code}</strong>: {result.done} trocada{result.done === 1 ? '' : 's'}
            {result.failed > 0 && <>, {result.failed} não trocada{result.failed === 1 ? '' : 's'}</>}
            {result.skipped > 0 && <>, {result.skipped} ignorada{result.skipped === 1 ? '' : 's'}</>}.
          </p>
        )}

        <ul className="mb-3 max-h-[40vh] divide-y divide-[var(--color-border)] overflow-y-auto rounded-lg border border-[var(--color-border)] text-xs">
          {tokens.map((t) => {
            const item = shown?.items.find((i) => i.token === t)
            return (
              <li key={t} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <span className="min-w-0 break-all">
                  <span className="font-mono text-[var(--color-text)]">{nameOf(t)}</span>
                  {item?.old_sample && <span className="block text-[var(--color-text-dim)]">Sample={item.old_sample}</span>}
                </span>
                {item ? (
                  <span className="shrink-0 sm:max-w-[55%] sm:text-right" style={{ color: STATUS_COLOR[item.status] }}>
                    {STATUS_LABEL[item.status]}
                    {item.new_analysis_name && item.status !== 'failed' && item.status !== 'skipped' && (
                      <span className="block break-all font-mono">{item.new_analysis_name}</span>
                    )}
                    {item.renumbered && <span className="block">réplica renumerada (o nome já existia)</span>}
                    {item.error && <span className="block break-words">{item.error}</span>}
                  </span>
                ) : (
                  <span className="shrink-0 text-[var(--color-text-dim)]">{chosen ? 'conferindo…' : 'escolha a amostra certa'}</span>
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
              {submitting ? 'Trocando…' : `Trocar em ${plannedCount} análise${plannedCount === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
