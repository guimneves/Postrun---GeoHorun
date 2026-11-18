import { useState, type ReactNode } from 'react'
import { METHOD_LABEL, type DeconvMethod, type RecoveryReport, type StudyDetail } from '../api/postrun'
import { PostRunStudyInspect } from './PostRunStudyInspect'
import { PostRunStudyTolerance } from './PostRunStudyTolerance'
import { PostRunValidationPanel } from './PostRunValidationPanel'
import { PostRunModelCompare } from './PostRunModelCompare'
import { PostRunInteractionPanel } from './PostRunInteractionPanel'
import { PostRunRobustnessPanel } from './PostRunRobustnessPanel'
import { PostRunIdentifiabilityPanel } from './PostRunIdentifiabilityPanel'
import { PostRunStudyPCA, PostRunStudyPLS } from './PostRunStudyChemometrics'
import { cardClass } from '../ui/classes'

// Ferramentas do estudo (pedido do usuário, 16/11/2026: "muitas funções em
// estudo — ícones grandes com uma breve explicação, mais intuitivo, interativo
// e visual"). Uma grade de cartões; clicar abre SÓ aquela ferramenta embaixo
// (antes eram sete cartões empilhados, todos abertos e calculando de uma vez).

type ToolKey = 'validacao' | 'replicas' | 'tolerancia' | 'comparador' | 'interacao' | 'robustez' | 'identificabilidade' | 'pca' | 'pls'

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width={30} height={30} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

const ICONS: Record<ToolKey, ReactNode> = {
  // alvo: o valor medido contra o pesado
  validacao: (
    <Svg>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 12l7-7M16 5h3v3" />
    </Svg>
  ),
  // lupa sobre um pico
  replicas: (
    <Svg>
      <path d="M2.5 17c2 0 2.5-1.5 3.5-5s1.6-5.5 2.4-5.5 1.4 2 2.4 5.5" />
      <circle cx="16" cy="14" r="4" />
      <path d="M19 17l2.5 2.5" />
    </Svg>
  ),
  // curva em U com o mínimo marcado
  tolerancia: (
    <Svg>
      <path d="M3 20h18M3 4v16" />
      <path d="M5 6c2 8 4 10 7 10s5-2 7-10" />
      <circle cx="12" cy="16" r="1.6" fill="currentColor" />
    </Svg>
  ),
  // colunas lado a lado
  comparador: (
    <Svg>
      <path d="M3 20h18" />
      <rect x="4.5" y="10" width="3.5" height="10" rx="0.8" />
      <rect x="10.25" y="5" width="3.5" height="15" rx="0.8" />
      <rect x="16" y="12.5" width="3.5" height="7.5" rx="0.8" />
    </Svg>
  ),
  // previsto (tracejado) × medido, e a diferença
  interacao: (
    <Svg>
      <path d="M3 17c2.5 0 3-2 4.5-6S10 4 11.5 4s2 3.5 3.5 7 2 6 4.5 6" strokeDasharray="2.5 2.5" />
      <path d="M3 17c2.5 0 3.5-1.5 5-5s2.5-6.5 4-6.5 2.5 3 4 6.5 2 5 5 5" />
      <path d="M3 21h18" />
    </Svg>
  ),
  // escudo: o resultado aguenta trocar o molde?
  robustez: (
    <Svg>
      <path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </Svg>
  ),
  // dois picos sobrepostos
  identificabilidade: (
    <Svg>
      <path d="M2.5 19c2 0 3-2 4.5-6.5S9 5 10 5s2 3 3.5 7.5S15.5 19 17.5 19" />
      <path d="M6.5 19c2 0 3-2 4.5-6.5S13 5 14 5s2 3 3.5 7.5S19.5 19 21.5 19" />
      <path d="M2 21h20" />
    </Svg>
  ),
  // nuvem de pontos com os dois eixos novos (PC1 longo, PC2 curto)
  pca: (
    <Svg>
      <circle cx="7" cy="16" r="1.2" fill="currentColor" />
      <circle cx="10" cy="13.5" r="1.2" fill="currentColor" />
      <circle cx="12.5" cy="11" r="1.2" fill="currentColor" />
      <circle cx="15" cy="9.5" r="1.2" fill="currentColor" />
      <circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" />
      <path d="M4 19L20.5 4" />
      <path d="M9.5 8.5l5 5" strokeDasharray="2 2" />
    </Svg>
  ),
  // curva → seta → número previsto, sobre a diagonal
  pls: (
    <Svg>
      <path d="M3 21h18M3 21V3" />
      <path d="M4 20L20 4" strokeDasharray="2.5 2.5" />
      <circle cx="8" cy="15" r="1.3" fill="currentColor" />
      <circle cx="12" cy="12.5" r="1.3" fill="currentColor" />
      <circle cx="16.5" cy="7" r="1.3" fill="currentColor" />
    </Svg>
  ),
}

const TOOLS: { key: ToolKey; title: string; color: string; question: string; what: string }[] = [
  {
    key: 'validacao',
    title: 'Validação',
    color: '#0072B2',
    question: 'O método acerta amostras que não entraram na curva?',
    what: 'Quantifica as corridas de validação e compara com a massa pesada: recuperação, viés, RMSEP e repetibilidade entre dias.',
  },
  {
    key: 'replicas',
    title: 'Réplicas',
    color: '#56B4E9',
    question: 'Como ficou cada corrida, uma a uma?',
    what: 'A corrida com o molde do puro por cima, a forma normalizada e quanto o pico deslocou e alargou.',
  },
  {
    key: 'tolerancia',
    title: 'Tolerância ótima',
    color: '#009E73',
    question: 'Quanto o molde pode esticar?',
    what: 'Reajusta as misturas em várias tolerâncias de dilatação e mostra qual deixa a recuperação mais perto da massa conhecida.',
  },
  {
    key: 'comparador',
    title: 'Comparar modelos',
    color: '#E69F00',
    question: 'Molde, gaussiana ou soma ponderada — qual quantifica melhor?',
    what: 'Ajusta os mesmos dados com vários modelos e põe recuperação, RMSE e BIC lado a lado.',
  },
  {
    key: 'interacao',
    title: 'Interação',
    color: '#D55E00',
    question: 'Os polímeros se influenciam ao pirolisar juntos?',
    what: 'Cada mistura contra a previsão sem interação: a curva de diferença, o deslocamento do pico e o alargamento.',
  },
  {
    key: 'robustez',
    title: 'Robustez',
    color: '#CC79A7',
    question: 'O resultado muda se o molde for outro?',
    what: 'Refaz o molde sem cada corrida pura (deixa-uma-de-fora) e mede quanto a massa encontrada varia.',
  },
  {
    key: 'identificabilidade',
    title: 'Picos sobrepostos',
    color: '#7f7f7f',
    question: 'Dá para separar dois materiais de picos parecidos?',
    what: 'Mostra quando o ajuste acerta o total mas não sabe dividir a área (ex.: PEAD e PP) — aí, reporte a soma.',
  },
  {
    key: 'pca',
    title: 'PCA',
    color: '#0f9fb5',
    question: 'Como as corridas se agrupam — e quais fogem do padrão?',
    what: 'Cada curva vira um ponto: réplicas juntas, misturas entre os puros, outliers e deriva entre dias. Os loadings mostram em que temperatura está a diferença.',
  },
  {
    key: 'pls',
    title: 'PLS',
    color: '#7b61c9',
    question: 'Dá para quantificar pela curva inteira, sem deconvoluir?',
    what: 'Aprende com as misturas conhecidas a prever a massa (ou fração) de cada material — interação incluída. Validação cruzada por composição.',
  },
]

export function PostRunStudyTools({
  detail,
  report,
  method,
}: {
  detail: StudyDetail
  report: { report: RecoveryReport; frozen: boolean } | null
  /** método escolhido no alto (Molde ou Gaussiana) */
  method: DeconvMethod
}) {
  const [open, setOpen] = useState<ToolKey | null>(null)
  const empty = detail.tokens.length === 0
  const disabledWhy = (k: ToolKey): string | null => {
    if (empty) return 'o estudo ainda não tem análises'
    if ((k === 'pca' || k === 'pls') && detail.tokens.length < 3) return 'precisa de pelo menos 3 corridas'
    if (k === 'replicas' && !(report && report.report.runs.length > 0)) return 'sem deconvolução salva neste método'
    return null
  }
  const tool = TOOLS.find((t) => t.key === open) ?? null

  return (
    <div className={cardClass}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">Ferramentas do estudo</h3>
        <span className="text-xs text-[var(--color-text-muted)]">
          clique numa ferramenta para abri-la · método: <strong>{METHOD_LABEL[method]}</strong> (troque no alto, em Recuperação)
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {TOOLS.map((t) => {
          const why = disabledWhy(t.key)
          const active = open === t.key
          return (
            <button
              key={t.key}
              type="button"
              disabled={!!why}
              aria-pressed={active}
              onClick={() => setOpen(active ? null : t.key)}
              title={why ?? t.what}
              className="group flex flex-col gap-2 rounded-2xl border p-3 text-left transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-card)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 disabled:hover:shadow-none border-[var(--color-border)]"
              style={
                active
                  ? { borderColor: t.color, boxShadow: `0 0 0 1.5px ${t.color}`, background: `${t.color}12` }
                  : undefined
              }
            >
              <span className="flex items-center gap-2.5">
                <span
                  className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
                  style={{ color: t.color, background: `${t.color}1f` }}
                >
                  {ICONS[t.key]}
                </span>
                <span className="text-[15px] font-semibold leading-tight">{t.title}</span>
              </span>
              <span className="text-[12.5px] font-medium leading-snug text-[var(--color-text)]">{t.question}</span>
              <span className="text-[11.5px] leading-snug text-[var(--color-text-muted)]">{why ?? t.what}</span>
            </button>
          )
        })}
      </div>

      {tool && (
        <div className="mt-4 rounded-2xl border p-3 border-[var(--color-border)]" style={{ borderTop: `3px solid ${tool.color}` }}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h4 className="flex items-center gap-2 font-semibold">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg [&>svg]:h-5 [&>svg]:w-5" style={{ color: tool.color, background: `${tool.color}1f` }}>
                {ICONS[tool.key]}
              </span>
              {tool.title}
              <span className="text-xs font-normal text-[var(--color-text-muted)]">— {tool.question}</span>
            </h4>
            <button type="button" className="text-xs text-[var(--color-text-muted)] hover:underline" onClick={() => setOpen(null)}>
              fechar
            </button>
          </div>
          <ToolBody tool={tool.key} detail={detail} report={report} method={method} />
        </div>
      )}
    </div>
  )
}

function Help({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-xs text-[var(--color-text-muted)]">{children}</p>
}

function ToolBody({
  tool,
  detail,
  report,
  method,
}: {
  tool: ToolKey
  detail: StudyDetail
  report: { report: RecoveryReport; frozen: boolean } | null
  method: DeconvMethod
}) {
  switch (tool) {
    case 'validacao':
      return (
        <>
          <Help>
            Marque as corridas de calibração e as de validação (independentes das curvas). As de validação são quantificadas
            pelas curvas e comparadas com a massa pesada: recuperação, viés, RMSEP e precisão intermediária (ANOVA com o dia
            como fator) — {METHOD_LABEL[method]}.
          </Help>
          <PostRunValidationPanel key={detail.id} studyId={detail.id} analyses={detail.analyses} method={method} editable={detail.status === 'aberto'} />
        </>
      )
    case 'replicas':
      return report ? (
        <>
          <Help>Escolha uma réplica para ver a corrida com o molde do puro sobreposto e a forma normalizada ({METHOD_LABEL[method]}).</Help>
          <PostRunStudyInspect report={report.report} method={method} />
        </>
      ) : null
    case 'tolerancia':
      return (
        <>
          <Help>
            Qual tolerância de largura (dilatação do molde) faz a recuperação das misturas chegar mais perto das massas
            conhecidas — a curva RMSE × tolerância deste sistema. Nada é gravado.
          </Help>
          <PostRunStudyTolerance key={detail.id} studyId={detail.id} />
        </>
      )
    case 'comparador':
      return (
        <>
          <Help>
            Puros e misturas do estudo ajustados por vários modelos — mesma janela, mesmas referências — cada um com as
            próprias curvas (refeitas com os puros no mesmo modelo). Recuperação, RMSE e BIC lado a lado; as ablações do molde
            mostram o que a deformação (centro, dilatação) acrescenta. A soma ponderada segue a ideia de Pawar e Kim (2025).
          </Help>
          <PostRunModelCompare key={detail.id} studyId={detail.id} />
        </>
      )
    case 'interacao':
      return (
        <>
          <Help>
            Cada mistura contra a previsão sem interação (os moldes dos puros com as massas esperadas): a curva de diferença e
            o ΔM, como em Pawar e Kim (2025); ΔTmax e Δlargura × fração; e os parâmetros que bateram no limite —{' '}
            {METHOD_LABEL[method]}.
          </Help>
          <PostRunInteractionPanel key={`${detail.id}-${method}`} studyId={detail.id} method={method} />
        </>
      )
    case 'robustez':
      return (
        <>
          <Help>
            Quanto a quantificação depende do molde: refaz o molde do material sem cada corrida pura (deixa-uma-de-fora),
            reajusta puros e misturas e requantifica — sem gravar. Daí sai o termo do molde na incerteza combinada. Opcional:
            compara com o molde de outro lote, grade ou granulometria.
          </Help>
          <PostRunRobustnessPanel key={detail.id} studyId={detail.id} analyses={detail.analyses} />
        </>
      )
    case 'pca':
      return (
        <>
          <Help>
            Análise de componentes principais (PCA): cada corrida vira uma linha da matriz X (o sinal em cada temperatura, na
            janela e linha de base salvas), e a PCA gira os eixos para a direção em que as corridas mais diferem. Exploração,
            sem usar a composição — ela só colore os pontos. Nada é gravado.
          </Help>
          <PostRunStudyPCA key={detail.id} studyId={detail.id} totalRuns={detail.tokens.length} channel={detail.channel} />
        </>
      )
    case 'pls':
      return (
        <>
          <Help>
            Regressão por mínimos quadrados parciais (PLS): um modelo por material que liga a curva inteira à massa (ou fração)
            conhecida. Ao contrário da deconvolução, não supõe que a mistura seja a soma dos puros — mas precisa de misturas de
            calibração e não vale fora delas. Usa as corridas com composição completa (puros e misturas). Nada é gravado.
          </Help>
          <PostRunStudyPLS key={detail.id} studyId={detail.id} />
        </>
      )
    case 'identificabilidade':
      return (
        <>
          <Help>
            Picos muito sobrepostos (ex.: PEAD e PP): o ajuste acerta o total, mas não sabe dividir a área — as áreas saem
            fortemente correlacionadas. Com |ρ| &gt; 0,9, reporte a soma do par. O bootstrap dos resíduos reajusta a mistura
            muitas vezes e mostra quanto a massa de cada material (e a da soma) varia — {METHOD_LABEL[method]}.
          </Help>
          <PostRunIdentifiabilityPanel key={`${detail.id}-${method}`} studyId={detail.id} method={method} />
        </>
      )
  }
}
