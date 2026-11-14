import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { postrunApi, type AnalysisSummary, type ScanStatus } from '../api/postrun'

const POLL_MS = 2000

/** Leitura dos .B00 do job em segundo plano (pedido do usuário, 16/10/2026):
 * ao escolher o job (e em "Verificar novamente") o servidor lista e lê os
 * arquivos sem pressa; aqui só acompanhamos o progresso e avisamos
 * `onProgress` a cada arquivo novo — a pessoa já trabalha nas análises que
 * chegaram enquanto o resto é lido. */
export function useJobScan(job: string, onProgress: () => void) {
  const [status, setStatus] = useState<ScanStatus | null>(null)
  const [nonce, setNonce] = useState(0)
  const progress = useRef(onProgress)
  progress.current = onProgress

  useEffect(() => {
    if (!job) {
      setStatus(null)
      return
    }
    let alive = true
    let timer: number | undefined
    let last = ''
    const tick = async (start: boolean) => {
      try {
        const s = start ? await postrunApi.startScan(job) : await postrunApi.getScan(job)
        if (!alive) return
        setStatus(s)
        const signature = `${s.state}|${s.listing}|${s.read}|${s.failed}`
        if (signature !== last) {
          last = signature
          progress.current()
        }
        if (s.state === 'running') timer = window.setTimeout(() => void tick(false), POLL_MS)
      } catch (err) {
        if (!alive) return
        setStatus({
          job, state: 'error', listing: false, total: 0, read: 0, failed: 0,
          error: err instanceof ApiError ? err.message : 'sem resposta do servidor',
          started_at: null, finished_at: null,
        })
        progress.current() // mostra pelo menos o que já está no cache
      }
    }
    void tick(true)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [job, nonce])

  const rescan = useCallback(() => setNonce((n) => n + 1), [])
  return { status, rescan }
}

/** Análises de um job, lidas em segundo plano (para o job STD da
 * calibração). */
export function useJobAnalyses(job: string) {
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)

  const reload = useCallback(() => {
    const r = ++request.current
    if (!job) {
      setAnalyses([])
      return
    }
    postrunApi
      .listAnalyses(job)
      .then((items) => {
        if (r === request.current) {
          setAnalyses(items)
          setError(null)
        }
      })
      .catch((err) => {
        if (r === request.current) setError(err instanceof ApiError ? err.message : 'Erro ao listar análises')
      })
  }, [job])

  const scan = useJobScan(job, reload)
  return { analyses, error, ...scan }
}

/** Jobs de padrões (STD): "STD", "STD 2026", "std_bulk"... */
export function isStdJob(name: string): boolean {
  return /^std($|[\s_\-.])/i.test(name)
}
