// Trocar a AMOSTRA de análises já feitas (pedido do usuário, 2026-10-20: "a
// pessoa cadastrou uma amostra na biblioteca com o nome errado, foi para o
// B00 errado") — POST /postrun/analyses/change-sample. Só amostras da
// biblioteca (filtro por grupo e subgrupo). Troca o Sample= dentro do .B00 e
// o código no nome do arquivo; data, extra e réplica ficam — se o nome novo
// já existir, a réplica vai para o próximo número livre. Prévia no servidor
// antes de confirmar; depois, o que aconteceu com cada análise.
//
// Desde 2026-11-19 ("quero que dê para trocar para diferentes amostras ao
// mesmo tempo"): cada análise tem a sua amostra certa. Marque análises e
// toque numa amostra — ela vai para as marcadas; sem nenhuma marcada, vai
// para todas as que ainda não têm amostra (com uma amostra só, é um clique).
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { libraryApi, type LibrarySampleOut, type SampleGroupOut } from '../api/library'
import { postrunApi, type ChangeSampleItem, type ChangeSampleResult } from '../api/postrun'
import { inputLgClass as inputClass } from '../ui/classes'

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
  return (token.split('/').pop() ?? token).replace(/\.[A-Za-z]00$/i, '')
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
  /** token → amostra certa escolhida */
  const [assigned, setAssigned] = useState<Record<string, LibrarySampleOut>>({})
  /** análises marcadas para receber a próxima amostra tocada */
  const [marked, setMarked] = useState<Set<string>>(new Set())
  const lastClicked = useRef<number | null>(null)
  const [preview, setPreview] = useState<{ key: string; result: ChangeSampleResult } | null>(null)
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

  const assignments = useMemo(
    () => tokens.filter((t) => assigned[t]).map((t) => ({ token: t, library_sample_id: assigned[t].id })),
    [tokens, assigned],
  )
  const assignmentsKey = JSON.stringify(assignments)
  /** quantas análises vão para cada amostra (para marcar na lista da biblioteca) */
  const usage = useMemo(() => {
    const m = new Map<number, number>()
    for (const a of assignments) m.set(a.library_sample_id, (m.get(a.library_sample_id) ?? 0) + 1)
    return m
  }, [assignments])
  const unassigned = tokens.filter((t) => !assigned[t])

  // prévia validada no servidor (lê cada .B00 e calcula o nome novo), um
  // instante depois da última escolha
  useEffect(() => {
    setPreviewError(null)
    if (result || assignments.length === 0) {
      setPreview(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      postrunApi
        .changeSample({ assignments, dry_run: true })
        .then((r) => {
          if (!cancelled) setPreview({ key: assignmentsKey, result: r })
        })
        .catch((err) => {
          if (!cancelled) setPreviewError(err instanceof ApiError ? err.message : 'Erro ao conferir')
        })
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentsKey, result])

  const currentPreview = preview?.key === assignmentsKey ? preview.result : null
  const plannedCount = currentPreview?.items.filter((i) => i.status === 'planned').length ?? 0

  function chooseSample(sample: LibrarySampleOut) {
    const targets = marked.size > 0 ? tokens.filter((t) => marked.has(t)) : unassigned
    if (targets.length === 0) return
    setAssigned((prev) => {
      const next = { ...prev }
      for (const t of targets) next[t] = sample
      return next
    })
    setMarked(new Set())
    lastClicked.current = null
  }

  function unassign(token: string) {
    setAssigned((prev) => {
      const next = { ...prev }
      delete next[token]
      return next
    })
  }

  // clique marca/desmarca; com Shift, marca o intervalo desde o último clique
  function toggleMark(index: number, shift: boolean) {
    setMarked((prev) => {
      const next = new Set(prev)
      const token = tokens[index]
      if (shift && lastClicked.current !== null) {
        const [a, b] = [Math.min(lastClicked.current, index), Math.max(lastClicked.current, index)]
        for (let i = a; i <= b; i++) next.add(tokens[i])
      } else if (next.has(token)) next.delete(token)
      else next.add(token)
      return next
    })
    lastClicked.current = index
  }

  async function confirm() {
    if (assignments.length === 0) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      setResult(await postrunApi.changeSample({ assignments }))
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

  const shown = result ?? currentPreview
  const targetHint =
    marked.size > 0
      ? `Toque na amostra certa para ${marked.size === 1 ? 'a análise marcada' : `as ${marked.size} marcadas`}.`
      : unassigned.length === tokens.length
        ? 'Toque na amostra certa: vai para todas. Para amostras diferentes, marque antes as análises de cada uma (Shift marca um intervalo).'
        : unassigned.length > 0
          ? `Marque análises e toque numa amostra — ou toque direto: vai para ${
              unassigned.length === 1 ? 'a que ainda está sem amostra' : `as ${unassigned.length} sem amostra`
            }.`
          : 'Todas têm amostra. Para trocar a de alguma, marque-a e toque em outra amostra.'
  const resultCodes = result ? new Set(result.items.filter((i) => i.status === 'done' && i.code).map((i) => i.code)) : null

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
          certa). O resto do arquivo não muda; regiões, deconvoluções e curvas acompanham. Cada análise pode ir para uma amostra
          diferente.
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
            <p className="text-xs font-medium text-[var(--color-text)]">{targetHint}</p>
            <ul className="max-h-48 overflow-y-auto rounded-lg border border-[var(--color-border)] text-sm" role="listbox" aria-label="Amostras da biblioteca">
              {filtered.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-text-muted)]">Nenhuma amostra com esse filtro.</li>}
              {filtered.map((s) => {
                const used = usage.get(s.id) ?? 0
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={used > 0}
                      onClick={() => chooseSample(s)}
                      className="flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left hover:bg-[var(--color-surface)]"
                      style={used > 0 ? { background: 'color-mix(in srgb, var(--color-primary) 14%, transparent)' } : undefined}
                    >
                      <span className="min-w-0">
                        <span className="font-mono font-medium">{s.code}</span> <span className="opacity-80">· {s.name}</span>
                      </span>
                      <span className="shrink-0 text-[11px] opacity-70">
                        {used > 0 && (
                          <strong className="mr-2 text-[var(--color-primary)]">
                            {used} análise{used === 1 ? '' : 's'}
                          </strong>
                        )}
                        {s.group_parent_name ? `${s.group_parent_name} › ` : ''}
                        {s.group_name ?? 'sem grupo'}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {previewError && !result && <p className="mb-3 text-sm text-[var(--color-danger)]">{previewError}</p>}
        {result && (
          <p className="mb-3 text-sm text-[var(--color-text)]">
            {result.code ? (
              <>
                Amostra <strong className="font-mono">{result.code}</strong>:
              </>
            ) : (
              <>
                {resultCodes?.size ?? 0} amostra{resultCodes?.size === 1 ? '' : 's'}:
              </>
            )}{' '}
            {result.done} trocada{result.done === 1 ? '' : 's'}
            {result.failed > 0 && <>, {result.failed} não trocada{result.failed === 1 ? '' : 's'}</>}
            {result.skipped > 0 && <>, {result.skipped} ignorada{result.skipped === 1 ? '' : 's'}</>}.
          </p>
        )}

        {!result && (
          <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => setMarked(new Set(tokens))}>
              marcar todas
            </button>
            {unassigned.length > 0 && unassigned.length < tokens.length && (
              <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => setMarked(new Set(unassigned))}>
                marcar as sem amostra
              </button>
            )}
            {marked.size > 0 && (
              <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => setMarked(new Set())}>
                desmarcar
              </button>
            )}
            {assignments.length > 0 && (
              <button
                type="button"
                className="text-[var(--color-text-muted)] hover:underline"
                onClick={() => {
                  setAssigned({})
                  setMarked(new Set())
                }}
              >
                limpar escolhas
              </button>
            )}
          </div>
        )}

        <ul className="mb-3 max-h-[40vh] divide-y divide-[var(--color-border)] overflow-y-auto rounded-lg border border-[var(--color-border)] text-xs">
          {tokens.map((t, index) => {
            const item = shown?.items.find((i) => i.token === t)
            const sample = assigned[t]
            const isMarked = marked.has(t)
            return (
              <li
                key={t}
                className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
                style={isMarked ? { background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)' } : undefined}
              >
                <label className="flex min-w-0 cursor-pointer items-start gap-2 break-all">
                  {!result && (
                    <input
                      type="checkbox"
                      className="mt-0.5 shrink-0"
                      checked={isMarked}
                      onChange={() => {}}
                      onClick={(e) => toggleMark(index, e.shiftKey)}
                      aria-label={`Marcar ${nameOf(t)}`}
                    />
                  )}
                  <span className="min-w-0">
                    <span className="font-mono text-[var(--color-text)]">{nameOf(t)}</span>
                    {item?.old_sample && <span className="block text-[var(--color-text-dim)]">Sample={item.old_sample}</span>}
                  </span>
                </label>
                <span className="shrink-0 sm:max-w-[55%] sm:text-right">
                  {sample && !result && (
                    <span className="block">
                      <span className="text-[var(--color-text-muted)]">amostra certa: </span>
                      <strong className="font-mono text-[var(--color-text)]">{sample.code}</strong>
                      <button
                        type="button"
                        className="ml-1.5 text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"
                        onClick={() => unassign(t)}
                        aria-label={`Tirar a amostra de ${nameOf(t)}`}
                        title="Tirar a amostra (esta análise não muda)"
                      >
                        ×
                      </button>
                    </span>
                  )}
                  {item ? (
                    <span className="block" style={{ color: STATUS_COLOR[item.status] }}>
                      {STATUS_LABEL[item.status]}
                      {item.new_analysis_name && item.status !== 'failed' && item.status !== 'skipped' && (
                        <span className="block break-all font-mono">{item.new_analysis_name}</span>
                      )}
                      {item.renumbered && <span className="block">réplica renumerada (o nome já existia)</span>}
                      {item.error && <span className="block break-words">{item.error}</span>}
                    </span>
                  ) : (
                    <span className="block text-[var(--color-text-dim)]">
                      {result ? 'não mudou' : sample ? 'conferindo…' : 'sem amostra — não muda'}
                    </span>
                  )}
                </span>
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
              disabled={!currentPreview || plannedCount === 0 || submitting}
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
