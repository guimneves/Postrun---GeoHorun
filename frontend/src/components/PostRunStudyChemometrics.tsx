import { useMemo, useState, type ReactNode } from 'react'
import { ApiError } from '../api/client'
import {
  studyApi,
  type ChemNormalize,
  type ChemPrep,
  type ChemPrepIn,
  type ChemRun,
  type PlsCv,
  type PlsTarget,
} from '../api/postrun'
import { materialColor } from '../lib/postrunColors'
import { PostRunLinesPlot, type LineSeries } from './PostRunLinesPlot'
import { PostRunScatterPlot, type PlotPoint } from './PostRunScatterPlot'
import { btnPrimaryClass, inputInlineClass as inputClass } from '../ui/classes'

// PCA e PLS das curvas do estudo (pedido do usuário, 17/11/2026). Cada corrida
// é uma LINHA da matriz X, cada temperatura uma COLUNA. A tela mostra cada etapa: a matriz depois do
// pré-tratamento, a variância explicada, os scores (quem se parece com quem),
// os loadings × temperatura (por quê) e os outliers (T² × Q); na PLS, a
// escolha das variáveis latentes, previsto × esperado, o vetor b e o VIP.

const NORM_LABEL: Record<ChemNormalize, string> = {
  area: 'pela área (compara a forma)',
  mass: 'pela massa (sinal por mg)',
  max: 'pela altura máxima',
  none: 'nenhuma (quantidade + forma)',
}
const MIX_COLORS = ['#E69F00', '#CC79A7', '#7b61c9', '#8c8a2a', '#e34948', '#0f9fb5', '#56B4E9', '#000000']
const DAY_COLORS = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#7b61c9', '#8c8a2a', '#e34948', '#000000']
const f = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d))
const stem = (s: string) => s.replace(/\.B00$/i, '')

function blend(hex: string, t: number): string {
  // do cinza-claro (fração 0) até a cor do material (fração 1)
  const a = [0xd9, 0xd9, 0xd9]
  const b = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))))
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

type ColorBy = 'grupo' | 'dia' | `fracao:${string}`

/** cor de cada corrida + a legenda, pelo critério escolhido */
function useColoring(runs: ChemRun[], by: ColorBy) {
  return useMemo(() => {
    if (by === 'dia') {
      const days = [...new Set(runs.map((r) => r.day ?? 'sem data'))].sort()
      const col = (r: ChemRun) => DAY_COLORS[days.indexOf(r.day ?? 'sem data') % DAY_COLORS.length]
      return { color: col, legend: days.map((d, i) => ({ label: d, color: DAY_COLORS[i % DAY_COLORS.length] })) }
    }
    if (by.startsWith('fracao:')) {
      const mat = by.slice(7)
      const base = materialColor(mat)
      const col = (r: ChemRun) => (r.composition ? blend(base, r.composition[mat] ?? 0) : '#9a9a9a')
      return {
        color: col,
        legend: [0, 0.5, 1].map((t) => ({ label: `${mat} ${t * 100} %`, color: blend(base, t) })).concat([{ label: 'sem composição', color: '#9a9a9a' }]),
      }
    }
    const groups = [...new Set(runs.map((r) => r.group))]
    const mixGroups = groups.filter((g) => runs.find((r) => r.group === g)?.kind !== 'puro')
    const groupColor = (g: string) => {
      const r = runs.find((x) => x.group === g)
      if (r?.kind === 'puro' && r.composition) return materialColor(Object.keys(r.composition)[0])
      return MIX_COLORS[mixGroups.indexOf(g) % MIX_COLORS.length]
    }
    return { color: (r: ChemRun) => groupColor(r.group), legend: groups.map((g) => ({ label: g, color: groupColor(g) })) }
  }, [runs, by])
}

function Step({ n, title, children, note }: { n: number; title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="rounded-xl border p-3 border-[var(--color-border)]">
      <h5 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-primary)] text-[11px] text-white">{n}</span>
        {title}
      </h5>
      {children}
      {note && <p className="mt-1.5 text-[11px] leading-snug text-[var(--color-text-muted)]">{note}</p>}
    </section>
  )
}

// -------------------------------------------------------------- pré-tratamento

function PrepControls({
  value,
  onChange,
  autoNormLabel,
}: {
  value: ChemPrepIn
  onChange: (v: ChemPrepIn) => void
  /** texto da opção "automática" (só na PLS) */
  autoNormLabel?: string
}) {
  const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')))
  return (
    <div className="flex flex-wrap items-end gap-3 text-xs">
      <label className="flex flex-col gap-1 text-[var(--color-text-muted)]">
        Normalização
        <select
          className={`${inputClass} w-56`}
          value={value.normalize ?? 'auto'}
          onChange={(e) => onChange({ ...value, normalize: e.target.value === 'auto' ? null : (e.target.value as ChemNormalize) })}
        >
          {autoNormLabel && <option value="auto">{autoNormLabel}</option>}
          {(Object.keys(NORM_LABEL) as ChemNormalize[]).map((k) => (
            <option key={k} value={k}>
              {NORM_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[var(--color-text-muted)]">
        Derivada
        <select className={`${inputClass} w-36`} value={value.derivative ?? 0} onChange={(e) => onChange({ ...value, derivative: Number(e.target.value) })}>
          <option value={0}>nenhuma</option>
          <option value={1}>1ª (realça ombros)</option>
          <option value={2}>2ª</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5 pb-1.5 text-[var(--color-text-muted)]" title="desloca cada curva para o máximo cair na mesma temperatura (mediana)">
        <input type="checkbox" checked={!!value.align} onChange={(e) => onChange({ ...value, align: e.target.checked })} />
        alinhar pelo máximo
      </label>
      <label className="flex flex-col gap-1 text-[var(--color-text-muted)]">
        Faixa (°C, vazio = a comum a todas)
        <span className="flex items-center gap-1">
          <input className={`${inputClass} w-20`} placeholder="de" value={value.t_min ?? ''} onChange={(e) => onChange({ ...value, t_min: num(e.target.value) })} />
          <input className={`${inputClass} w-20`} placeholder="até" value={value.t_max ?? ''} onChange={(e) => onChange({ ...value, t_max: num(e.target.value) })} />
        </span>
      </label>
    </div>
  )
}

function MatrixLine({ prep, n }: { prep: ChemPrep; n: number }) {
  const p = Math.round((prep.t_max - prep.t_min) / prep.step) + 1
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[var(--color-surface)] px-3 py-2 text-xs">
      <span className="font-mono font-semibold">
        X = {n} corridas × {p} temperaturas
      </span>
      <span className="text-[var(--color-text-muted)]">
        {prep.t_min.toFixed(0)}–{prep.t_max.toFixed(0)} °C, de {prep.step} em {prep.step} °C · normalização {NORM_LABEL[prep.normalize]}
        {prep.derivative ? ` · ${prep.derivative}ª derivada` : ''}
        {prep.align ? ' · alinhadas pelo máximo' : ''} · centrada na média
      </span>
    </div>
  )
}

function Explained({ explained, k }: { explained: number[]; k: number }) {
  let acc = 0
  return (
    <div className="flex flex-col gap-1">
      {explained.slice(0, Math.max(k, 6)).map((v, i) => {
        acc += v
        return (
          <div key={i} className="flex items-center gap-2 text-xs tabular-nums">
            <span className="w-10 font-medium">PC{i + 1}</span>
            <span className="relative h-3.5 flex-1 rounded bg-[var(--color-surface)]">
              <span className="absolute inset-y-0 left-0 rounded bg-[var(--color-primary)]" style={{ width: `${Math.max(0.5, v * 100)}%`, opacity: i < k ? 1 : 0.35 }} />
            </span>
            <span className="w-14 text-right">{(v * 100).toFixed(1)} %</span>
            <span className="w-20 text-right text-[var(--color-text-muted)]">acum. {(acc * 100).toFixed(1)} %</span>
          </div>
        )
      })}
    </div>
  )
}

function useRun<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run() {
    setBusy(true)
    setError(null)
    try {
      setData(await fn())
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao calcular')
    } finally {
      setBusy(false)
    }
  }
  return { data, busy, error, run }
}

// ------------------------------------------------------------------------ PCA

export function PostRunStudyPCA({ studyId }: { studyId: number }) {
  const [prep, setPrep] = useState<ChemPrepIn>({ normalize: 'area', derivative: 0, align: false })
  const [nComp, setNComp] = useState(4)
  const { data, busy, error, run } = useRun(() => studyApi.pca(studyId, { ...prep, n_comp: nComp }))
  const [pcX, setPcX] = useState(0)
  const [pcY, setPcY] = useState(1)
  const [colorBy, setColorBy] = useState<ColorBy>('grupo')
  const [picked, setPicked] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const runs = useMemo(() => data?.runs ?? [], [data])
  const { color, legend } = useColoring(runs, colorBy)
  const k = data?.scores[0]?.length ?? 0
  const focus = hover ?? picked

  const xSeries = useMemo<LineSeries[]>(() => {
    if (!data) return []
    const out: LineSeries[] = data.x.map((row, i) => ({
      key: data.runs[i].token,
      x: data.grid,
      y: row,
      color: color(data.runs[i]),
      width: focus === data.runs[i].token ? 2.6 : 1.1,
      opacity: focus && focus !== data.runs[i].token ? 0.25 : 0.85,
      label: `${stem(data.runs[i].filename)} · ${data.runs[i].group}`,
    }))
    out.push({ key: '__mean', x: data.grid, y: data.mean, color: 'var(--color-text)', width: 2, dash: '6 4', label: 'média (o centro da nuvem)' })
    return out
  }, [data, color, focus])

  const scorePts = useMemo<PlotPoint[]>(() => {
    if (!data || k < 1) return []
    return data.runs.map((r, i) => ({
      x: data.scores[i][Math.min(pcX, k - 1)],
      y: k > 1 ? data.scores[i][Math.min(pcY, k - 1)] : 0,
      color: color(r),
      id: i,
      hollow: focus !== null && focus !== r.token,
      tip: [stem(r.filename), r.group, `PC${pcX + 1} ${f(data.scores[i][pcX], 3)} · PC${pcY + 1} ${f(data.scores[i][pcY], 3)}`, r.day ?? ''],
    }))
  }, [data, k, pcX, pcY, color, focus])

  const loadSeries = useMemo<LineSeries[]>(() => {
    if (!data) return []
    const pcs = [...new Set([pcX, pcY])].filter((i) => i < k)
    const cols = ['var(--color-primary)', '#D55E00']
    return pcs.map((i, j) => ({ key: `pc${i}`, x: data.grid, y: data.loadings[i], color: cols[j], width: 2, label: `loading PC${i + 1}` }))
  }, [data, pcX, pcY, k])

  const outPts = useMemo<PlotPoint[]>(() => {
    if (!data) return []
    return data.runs.map((r, i) => ({
      x: data.t2[i],
      y: data.q[i],
      color: color(r),
      id: i,
      tip: [stem(r.filename), r.group, `T² ${f(data.t2[i])} · Q ${f(data.q[i], 4)}`],
    }))
  }, [data, color])
  const flagged = data
    ? data.runs
        .map((r, i) => ({ r, t2: data.t2[i], q: data.q[i] }))
        .filter((o) => (data.t2_limit !== null && o.t2 > data.t2_limit) || (data.q_limit !== null && o.q > data.q_limit))
    : []
  const pickedIdx = data && picked ? data.runs.findIndex((r) => r.token === picked) : -1

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <PrepControls value={prep} onChange={setPrep} />
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Componentes
          <select className={`${inputClass} w-20`} value={nComp} onChange={(e) => setNComp(Number(e.target.value))}>
            {[2, 3, 4, 5, 6].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={btnPrimaryClass} onClick={() => void run()} disabled={busy}>
          {busy ? 'Montando a matriz…' : 'Calcular a PCA'}
        </button>
      </div>
      {error && <p className="text-xs text-[var(--color-danger,#c0392b)]">{error}</p>}

      {data && (
        <>
          <MatrixLine prep={data.prep} n={data.runs.length} />
          {data.errors.length > 0 && <p className="text-[11px] text-[var(--color-warning,#b26a00)]">Ficaram de fora: {data.errors.join('; ')}</p>}

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-[var(--color-text-muted)]">colorir por</span>
            <select className={`${inputClass} w-48`} value={colorBy} onChange={(e) => setColorBy(e.target.value as ColorBy)}>
              <option value="grupo">composição</option>
              <option value="dia">dia da análise</option>
              {data.materials.map((m) => (
                <option key={m} value={`fracao:${m}`}>
                  fração de {m}
                </option>
              ))}
            </select>
            {picked && (
              <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => setPicked(null)}>
                limpar seleção ({stem(runs[pickedIdx]?.filename ?? '')})
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <Step
              n={1}
              title="A matriz X — cada linha é uma corrida"
              note="As curvas como entram na conta (depois do pré-tratamento). O tracejado é a média: a PCA estuda o quanto cada corrida se afasta dela. Passe o mouse para destacar uma corrida."
            >
              <PostRunLinesPlot
                series={xSeries}
                xLabel="temperatura (°C)"
                yLabel={data.prep.derivative ? 'derivada (relativa)' : 'sinal tratado (relativo)'}
                height={250}
                legend={legend}
                onHover={(key) => setHover(key && key !== '__mean' ? key : null)}
              />
            </Step>
            <Step
              n={2}
              title="Quanto cada componente explica"
              note="Cada PC é um novo eixo; o PC1 aponta para onde as corridas mais diferem. Pare onde a barra fica pequena e o loading começa a parecer ruído."
            >
              <Explained explained={data.explained} k={k} />
            </Step>
            <Step
              n={3}
              title="Scores — quem se parece com quem"
              note="Cada ponto é uma corrida. Perto = curvas parecidas. Réplicas devem ficar juntas; um gradiente ao longo de um eixo é uma propriedade que varia (ex.: a fração). Clique num ponto para destacar a curva dela."
            >
              <div className="mb-1 flex items-center gap-2 text-xs">
                eixo x
                <select className={`${inputClass} w-20`} value={pcX} onChange={(e) => setPcX(Number(e.target.value))}>
                  {Array.from({ length: k }, (_, i) => <option key={i} value={i}>PC{i + 1}</option>)}
                </select>
                eixo y
                <select className={`${inputClass} w-20`} value={pcY} onChange={(e) => setPcY(Number(e.target.value))}>
                  {Array.from({ length: k }, (_, i) => <option key={i} value={i}>PC{i + 1}</option>)}
                </select>
              </div>
              <PostRunScatterPlot
                points={scorePts}
                xLabel={`PC${pcX + 1} (${f((data.explained[pcX] ?? 0) * 100, 1)} %)`}
                yLabel={`PC${pcY + 1} (${f((data.explained[pcY] ?? 0) * 100, 1)} %)`}
                xFromData
                hLine={0}
                vLines={[{ x: 0, label: '' }]}
                height={280}
                legend={legend}
                onPointClick={(id) => setPicked((cur) => (cur === runs[id].token ? null : runs[id].token))}
              />
            </Step>
            <Step
              n={4}
              title="Loadings — o porquê, ao longo da temperatura"
              note="O loading de um PC lido como curva: onde é positivo, as corridas com score alto nesse PC têm MAIS sinal (depois do pré-tratamento); onde é negativo, menos. Um lóbulo positivo num pico e negativo no outro = troca de um material pelo outro. Lóbulos nas laterais de um pico = alargamento."
            >
              <PostRunLinesPlot
                series={[{ key: '__zero', x: [data.grid[0], data.grid[data.grid.length - 1]], y: [0, 0], color: 'var(--color-border)', width: 1 }, ...loadSeries]}
                xLabel="temperatura (°C)"
                yLabel="peso (loading)"
                height={250}
                legend={loadSeries.map((s) => ({ label: s.label ?? '', color: s.color }))}
              />
            </Step>
          </div>

          <Step
            n={5}
            title="Corridas fora do padrão — T² × Q"
            note={
              <>
                <strong>T²</strong> (Hotelling): a corrida está dentro do modelo, mas longe do centro — extrema, porém do mesmo
                tipo. <strong>Q</strong> (resíduo): ela tem algo que os {k} PCs não descrevem — forma nova, contaminação, pico
                extra, problema na corrida. As linhas são os limites de 95 %. Investigue antes de excluir: pode ser exatamente
                o efeito químico interessante.
              </>
            }
          >
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <PostRunScatterPlot
                points={outPts}
                xLabel="T² de Hotelling"
                yLabel="Q (resíduo)"
                xFromData
                yFromZero
                hLine={data.q_limit ?? undefined}
                vLines={data.t2_limit !== null ? [{ x: data.t2_limit, label: 'T² 95 %' }] : []}
                height={240}
                onPointClick={(id) => setPicked(runs[id].token)}
              />
              <div className="text-xs">
                {flagged.length === 0 ? (
                  <p className="text-[var(--color-text-muted)]">Nenhuma corrida passou dos limites de 95 %.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {flagged.map((o) => (
                      <li key={o.r.token}>
                        <button type="button" className="text-left hover:underline" onClick={() => setPicked(o.r.token)}>
                          <span className="font-mono">{stem(o.r.filename)}</span>{' '}
                          <span className="text-[var(--color-text-muted)]">
                            ({o.r.group}) —{' '}
                            {[
                              data.t2_limit !== null && o.t2 > data.t2_limit ? 'extrema (T²)' : '',
                              data.q_limit !== null && o.q > data.q_limit ? 'forma diferente (Q)' : '',
                            ]
                              .filter(Boolean)
                              .join(' e ')}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {pickedIdx >= 0 && (
                  <p className="mt-2 rounded-lg bg-[var(--color-surface)] px-2 py-1.5 tabular-nums">
                    <span className="font-mono">{stem(runs[pickedIdx].filename)}</span> · {runs[pickedIdx].group}
                    <br />
                    scores: {data.scores[pickedIdx].map((v, i) => `PC${i + 1} ${f(v, 3)}`).join(' · ')}
                    <br />
                    T² {f(data.t2[pickedIdx])} · Q {f(data.q[pickedIdx], 4)} · Tmax {f(runs[pickedIdx].tmax_c, 0)} °C
                    {runs[pickedIdx].shift_c ? ` (deslocada ${f(runs[pickedIdx].shift_c, 0)} °C)` : ''}
                  </p>
                )}
              </div>
            </div>
          </Step>
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------ PLS

export function PostRunStudyPLS({ studyId }: { studyId: number }) {
  const [prep, setPrep] = useState<ChemPrepIn>({ normalize: null, derivative: 0, align: false })
  const [target, setTarget] = useState<PlsTarget>('mass')
  const [cv, setCv] = useState<PlsCv>('composicao')
  const [nLv, setNLv] = useState<number | null>(null)
  const { data, busy, error, run } = useRun(() => studyApi.pls(studyId, { ...prep, target, cv, n_lv: nLv }))
  const [matSel, setMatSel] = useState<string | null>(null)
  const runs = useMemo(() => data?.runs ?? [], [data])
  const { color, legend } = useColoring(runs, 'grupo')
  const mats = data?.materials ?? []
  const m = mats.find((x) => x.material === matSel) ?? mats[0] ?? null
  const unit = data?.unit ?? ''

  const lvSeries = useMemo<LineSeries[]>(() => {
    if (!m || m.error) return []
    const x = m.rmsec.map((_, i) => i + 1)
    return [
      { key: 'c', x, y: m.rmsec, color: 'var(--color-text-muted)', width: 1.6, dash: '4 3', label: 'RMSEC (treino — sempre cai)' },
      { key: 'cv', x, y: m.rmsecv, color: 'var(--color-primary)', width: 2.6, label: 'RMSECV (validação cruzada)' },
    ]
  }, [m])

  const predPts = useMemo<PlotPoint[]>(() => {
    if (!m || m.error) return []
    return m.preds.map((p, i) => {
      const r = runs.find((x) => x.token === p.token)!
      return {
        x: p.y,
        y: p.y_cv,
        color: color(r),
        id: i,
        tip: [stem(r.filename), r.group, `esperado ${f(p.y, 3)} · previsto ${f(p.y_cv, 3)} ${unit}`, p.recovery_cv_pct !== null ? `recuperação ${f(p.recovery_cv_pct, 1)} %` : ''],
      }
    })
  }, [m, runs, color, unit])

  const bSeries = useMemo<LineSeries[]>(() => {
    if (!data || !m || m.error) return []
    return [
      { key: '__zero', x: [data.grid[0], data.grid[data.grid.length - 1]], y: [0, 0], color: 'var(--color-border)', width: 1 },
      { key: 'b', x: data.grid, y: m.b, color: materialColor(m.material, mats.map((x) => x.material)), width: 2, label: 'vetor de regressão b' },
    ]
  }, [data, m, mats])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3 text-xs">
        <label className="flex flex-col gap-1 text-[var(--color-text-muted)]">
          Prever
          <select className={`${inputClass} w-44`} value={target} onChange={(e) => setTarget(e.target.value as PlsTarget)}>
            <option value="mass">massa de cada material (mg)</option>
            <option value="fraction">fração de cada material (%)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[var(--color-text-muted)]">
          Validação cruzada
          <select className={`${inputClass} w-60`} value={cv} onChange={(e) => setCv(e.target.value as PlsCv)}>
            <option value="composicao">deixa uma composição de fora (honesta)</option>
            <option value="corrida">deixa uma corrida de fora (otimista)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[var(--color-text-muted)]">
          Variáveis latentes
          <select className={`${inputClass} w-28`} value={nLv ?? 'auto'} onChange={(e) => setNLv(e.target.value === 'auto' ? null : Number(e.target.value))}>
            <option value="auto">automático</option>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <PrepControls value={prep} onChange={setPrep} autoNormLabel="automática (nenhuma p/ massa; área p/ fração)" />
        <button type="button" className={btnPrimaryClass} onClick={() => void run()} disabled={busy}>
          {busy ? 'Ajustando os modelos…' : 'Calcular a PLS'}
        </button>
      </div>
      {error && <p className="text-xs text-[var(--color-danger,#c0392b)]">{error}</p>}

      {data && (
        <>
          <MatrixLine prep={data.prep} n={data.runs.length} />
          {(data.excluded.length > 0 || data.errors.length > 0) && (
            <p className="text-[11px] text-[var(--color-warning,#b26a00)]">
              {data.excluded.length > 0 && `Sem composição completa (fora da PLS): ${data.excluded.map(stem).join(', ')}. `}
              {data.errors.length > 0 && `Não carregaram: ${data.errors.join('; ')}`}
            </p>
          )}

          <div className="flex flex-wrap gap-2" role="tablist">
            {mats.map((x) => {
              const active = x.material === m?.material
              const c = materialColor(x.material, mats.map((y) => y.material))
              return (
                <button
                  key={x.material}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setMatSel(x.material)}
                  className="flex flex-col rounded-xl border px-3 py-1.5 text-left text-xs border-[var(--color-border)]"
                  style={active ? { borderColor: c, boxShadow: `0 0 0 1.5px ${c}`, background: `${c}12` } : undefined}
                >
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />
                    {x.material}
                  </span>
                  {x.error ? (
                    <span className="text-[var(--color-warning,#b26a00)]">{x.error}</span>
                  ) : (
                    <span className="tabular-nums text-[var(--color-text-muted)]">
                      {x.n_lv} LV · RMSECV {f(x.rmsecv[x.n_lv - 1], 3)} {unit} · Q² {f(x.q2, 3)}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {m && !m.error && (
            <>
              <div className="flex flex-wrap gap-2 text-xs tabular-nums">
                {[
                  ['variáveis latentes', String(m.n_lv)],
                  ['RMSECV', `${f(m.rmsecv[m.n_lv - 1], 3)} ${unit}`],
                  ['Q² (validação)', f(m.q2, 3)],
                  ['R² (calibração)', f(m.r2_cal, 4)],
                  ['recuperação nas misturas (validação)', m.rmse_recovery_mix_pct !== null ? `RMSE ${f(m.rmse_recovery_mix_pct, 1)} %` : '—'],
                ].map(([a, b]) => (
                  <div key={a} className="rounded-xl border px-3 py-1.5 border-[var(--color-border)] bg-[var(--color-bg)]">
                    <div className="text-[11px] text-[var(--color-text-muted)]">{a}</div>
                    <div className="text-base font-semibold">{b}</div>
                  </div>
                ))}
              </div>
              {m.notes.length > 0 && <p className="text-[11px] text-[var(--color-warning,#b26a00)]">{m.notes.join('; ')}</p>}

              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <Step
                  n={1}
                  title="Quantas variáveis latentes?"
                  note={
                    <>
                      O erro no treino (RMSEC) sempre cai com mais LVs — o modelo vai decorando. O que vale é o da validação
                      cruzada (RMSECV): {cv === 'composicao' ? 'cada composição, com todas as réplicas, é prevista por um modelo feito sem ela' : 'cada corrida é prevista por um modelo feito sem ela — as réplicas dela continuam no treino, por isso é otimista'}.
                      Automático = a menor quantidade com RMSECV até 5 % acima do mínimo.
                    </>
                  }
                >
                  <PostRunLinesPlot
                    series={lvSeries}
                    xLabel="número de variáveis latentes"
                    yLabel={`erro (${unit})`}
                    height={230}
                    vLines={[{ x: m.n_lv, label: `${m.n_lv} LV` }]}
                    legend={lvSeries.map((s) => ({ label: s.label ?? '', color: s.color, dash: s.dash }))}
                  />
                </Step>
                <Step
                  n={2}
                  title="Previsto × esperado (validação cruzada)"
                  note="Cada ponto é uma corrida prevista por um modelo que não a viu. Na diagonal = acerto. Lembre: a PLS não extrapola — uma composição nos extremos (ex.: o puro) prevista sem ela no treino costuma errar mais."
                >
                  <PostRunScatterPlot points={predPts} xLabel={`esperado (${unit})`} yLabel={`previsto (${unit})`} line={(x) => x} lineDash="5 4" height={260} legend={legend} />
                </Step>
                <Step
                  n={3}
                  title="Onde a PLS olha — vetor b e VIP"
                  note="b: previsão = Σ (sinal em cada temperatura × b) + constante. Positivo onde mais sinal → mais deste material; negativo onde mais sinal → menos. VIP > 1 (eixo da direita) = temperatura importante. Se b tiver picos onde não há sinal químico, o modelo está aprendendo ruído."
                >
                  <PostRunLinesPlot
                    series={bSeries}
                    xLabel="temperatura (°C)"
                    yLabel="b"
                    height={250}
                    y2={{ x: data.grid, y: m.vip, label: 'VIP', color: 'var(--color-text-muted)' }}
                    legend={[{ label: 'b', color: bSeries[1]?.color ?? '' }, { label: 'VIP', color: 'var(--color-text-muted)' }]}
                  />
                </Step>
                <Step n={4} title="Corrida a corrida">
                  <div className="max-h-[260px] overflow-auto">
                    <table className="w-full text-left text-xs tabular-nums">
                      <thead className="sticky top-0 bg-[var(--color-bg)] text-[var(--color-text-muted)]">
                        <tr>
                          <th className="py-1 pr-2">Corrida</th>
                          <th className="py-1 pr-2">Composição</th>
                          <th className="py-1 pr-2">Esperado</th>
                          <th className="py-1 pr-2">Previsto</th>
                          <th className="py-1 pr-2">Recuperação</th>
                        </tr>
                      </thead>
                      <tbody>
                        {m.preds.map((p) => {
                          const r = runs.find((x) => x.token === p.token)!
                          return (
                            <tr key={p.token} className="border-t border-[var(--color-border)]">
                              <td className="py-0.5 pr-2 font-mono">{stem(r.filename)}</td>
                              <td className="py-0.5 pr-2">{r.group}</td>
                              <td className="py-0.5 pr-2">{f(p.y, 3)}</td>
                              <td className="py-0.5 pr-2">{f(p.y_cv, 3)}</td>
                              <td className="py-0.5 pr-2">{p.recovery_cv_pct !== null ? `${f(p.recovery_cv_pct, 1)} %` : '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </Step>
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Recuperação = previsto (validação cruzada) ÷ esperado — o mesmo critério da deconvolução, para comparar. A PLS
                aprende a mistura como ela é (inclusive a interação entre os materiais), mas só vale dentro das composições da
                calibração: {data.n_groups} grupos de validação neste estudo. Para um resultado publicável, confirme com corridas
                independentes, que não entraram em nenhum modelo.
              </p>
            </>
          )}
        </>
      )}
    </div>
  )
}
