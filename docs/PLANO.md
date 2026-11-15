# PostRun · GeoHorun — plano

Módulo do Horun para o pós-corrida do **Rock-Eval 7S**: curvas, parâmetros no
estilo GeoWorks, deconvolução, calibração, estudos e as ferramentas do artigo
(JAAP). Gerado em 13/11/2026 pelo modelo de PostRun do Horun Core
(`Prompt_Horun_PostRun.md`). Id no Core: `geohorun` (`/m/geohorun/`).

## Decisões (13/11/2026)

- **Repositório público.** Nunca entram: dados reais (`.B00` reais, planilhas,
  bancos), nem arquivos do GeoWorks (ajuda, métodos `*_params.xrk7`,
  `*_cursors.xml`, `standards.ini`, ábacos) — são da Vinci Technologies. O
  GeoHorun **importa os métodos do GeoWorks instalado** no laboratório em tempo
  de execução; o padrão embutido vem do livro do Rock-Eval e da literatura,
  com referências.
- **Renomear / mover / trocar amostra de análise vai para o GeoHorun.** O RE7S
  expõe rotas internas para o que só ele sabe (amostra no carrossel, histórico,
  biblioteca, nome duplicado) e lê as renomeações do GeoHorun.
- Testes com `.B00` **sintéticos** (os testes do PostRun no RE7S usam 4 `.B00`
  reais, versionados desde 27/08 — decidir à parte se saem do RE7S).
- O RE7S mantém o PostRun até a troca ser conferida em produção; só então perde.

## Fase 1 — Separação do RE7S (este repositório)

Levantamento do PostRun no RE7S (13/11/2026):

- Backend ~6.200 linhas: `routes_postrun.py` (1491), `routes_postrun_curves.py`
  (464), `_deconv` (844), `_report` (456), `_study` (911), `_workflow` (436);
  `modules/postrun_{b00,calc,calibration,composition,deconv,regression,scan,timebase}.py`.
- Grupo renomear: `routes_analysis_rename.py` (559), `modules/analysis_rename.py`
  (292), `modules/b00_sample.py` (95).
- Frontend ~10.600 linhas: `PostRunPage.tsx` (2420), 19 `components/PostRun*.tsx`,
  `api/postrun.ts`, `lib/postrun*.ts`, `hooks/usePostrunScan.ts`, modais de
  renomear/mover/trocar amostra, `lib/componentMassPaste.ts`, seção do manual.
- Tabelas: `PostrunRegion`, `PostrunCalibration`, `PostrunAnalysisMeta`,
  `PostrunCurve`, `PostrunDeconvolution`, `PostrunDeconvReference`,
  `PostrunStudy`, `PostrunB00Cache` (+ `AnalysisRename`, que vem junto).
- 95 testes do PostRun + 39 do grupo renomear.

Passos:

1. **Backend portado** — módulos e rotas copiados; trocas: autenticação pela
   identidade do Core (`created_by_id` → id/nome do usuário do Core), `settings`
   próprios (modo Agente, raízes `jobs` e `data`), sem `User` local.
2. **Leitura dos `.B00`** pelo Agente com as raízes `jobs` (leitura/movimento/
   escrita) e `data` (`standard.ini`) — o mesmo Agente do PC do Rock-Eval passa
   a atender também o GeoHorun.
3. **Rotas internas entre RE7S e GeoHorun** (rede `horun-network`, token por
   módulo): RE7S → posições no carrossel, nome duplicado, entrada de histórico,
   amostras da biblioteca, padrões e valores de referência; GeoHorun →
   renomeações feitas (para o histórico e os contadores do RE7S).
   Desenho (13/11/2026) — o grupo renomear só LÊ tabelas da fila:
   - **RE7S → GeoHorun (leitura)**, `GET /internal/geohorun/...` com token:
     `analysis-name/{nome}` (no carrossel? posição; nome já usado na fila;
     entrada de histórico `{id, extra}`), `history/{id}`, `library` (grupos e
     amostras `{id, code, name}`), `standards` e `standards/{id}` (nome +
     valores certificados).
   - **GeoHorun → RE7S (réplica)**: cada renomeação/mudança de amostra é
     enviada a `POST /internal/geohorun/renames` (fila de saída com nova
     tentativa). O RE7S mantém `AnalysisRename` como réplica, e o código da
     fila (nome duplicado, histórico, contadores da biblioteca) não muda.
   - `_existing_b00_names` do RE7S (desmarcar analisadas) passa a usar um
     auxiliar próprio de listagem dos `.B00` (já tem o Agente).
   - Nos testes do GeoHorun, o RE7S é um falso em memória (`re7s_link`).
4. **Frontend portado** — a página e os componentes do PostRun entram como as
   abas do GeoHorun; o que é comum de PostRun (`postrun-core`) é usado onde já
   cobre (lista, publicação no Resultados).
5. **Testes** portados com `.B00` sintéticos (gerador no próprio repositório).
6. **Migração dos dados**: script que copia as 8 tabelas + `AnalysisRename` do
   Postgres do RE7S para o do GeoHorun, convertendo os ids de usuário.
7. **Troca**: Core cadastra `geohorun`; conferido em produção, o RE7S remove o
   PostRun (aba, rotas, tabelas ficam até o backup seguinte).

Andamento (14/11/2026):
- ✅ 1 backend portado (deps pela identidade do Core, `re7s_link`, tabelas iguais às do RE7S);
- ✅ 2 leitura dos `.B00` (local e pelo Agente, raízes `jobs`/`data`);
- ✅ 3 rotas internas dos dois lados — no RE7S (commits dc05451, 925ee87):
  `/internal/geohorun/*` com `RE7S_GEOHORUN_TOKEN` (sem token: 503, nunca 404),
  réplica das renomeações gravada em `AnalysisRename` com o mesmo id, renomear/
  mover/trocar amostra no RE7S responde 409 quando o token está ligado, e a
  listagem dos `.B00` do carrossel saiu para `app/modules/b00_listing.py`;
- ✅ 4 tela portada (abas Análises, Estudos, Deconvolução, Curvas, Relatório,
  Calibração) e redesenhada; painel do Agente no cabeçalho (coordenação);
- ✅ 5 testes com `.B00` sintéticos (`tests/b00_factory.py`);
- ✅ 6 migração: `python -m app.scripts.migrar_do_re7s [--simular]`, pelos dados
  exportados do RE7S (`/internal/geohorun/export/<tabela>`), tudo ou nada, mesmos
  ids, usuários pelo id do Core. Conferido de ponta a ponta com uma cópia do
  banco de teste do RE7S (39 regiões, 66 deconvoluções… iguais);
- ✅ compose de produção (Postgres, backup, porta estreita 8003 do Agente) e
  guia `docs/DEPLOY.md`;
- ✅ 7 troca feita no servidor (14/11/2026: GeoHorun em produção, dados migrados,
  Agente com o bloco do GeoHorun); PostRun retirado do RE7S (commit 29bb61f —
  `/postrun` leva ao GeoHorun; as tabelas `Postrun*` continuam no banco do RE7S
  até o backup seguinte; os 4 `.B00` reais saíram dos testes de lá, ficam só no
  histórico do git). Manual do PostRun passou para a aba **Manual** daqui.

**Fase 1 concluída.**

Bug corrigido na passagem (✅ GeoHorun; ✅ RE7S, commit 5f081d0): `analysis_rename.py:203-206` recria
`PostrunAnalysisMeta` sem `file_mass_before_mg` e `component_masses` (perdidos
ao renomear/mover).

## Fase 2 — Artigo, prioridade 1 (F1–F5)

Especificação completa: `docs/FERRAMENTAS_ARTIGO.md`. F1 recuperação por
componente e total; F2 brancos de matriz, LOB/LOD/LOQ e ppm; F3 validação
(calibração × validação, modo cego, RMSEP, viés, precisão intermediária por
ANOVA, gráfico 1:1 com U95); F4 rastreabilidade e exclusões com motivo; F5
exportação para publicação (vetorial/300 dpi, larguras JAAP, paleta fixa).

Andamento da Fase 2 (14/11/2026):
- ✅ F1 (commit 0d0c573): recuperação de cada componente, das poliolefinas somadas
  (PEAD + PP…, `routes_postrun_report.POLYOLEFINS`) e total (Σ encontrada ÷ massa
  pesada), média ± DP e n de réplicas válidas — Relatório, cartões, Excel, lista
  de Estudos, Manual.
- ✅ F2: `app/modules/postrun_limits.py` (LoB/LoD/LoQ de Armbruster & Pry + LD/LQ da
  curva, mg e ppm, aviso com < 10 brancos), `POST /api/postrun/curves/{id}/limits`
  (resultado guardado em `PostrunCurve.limits`) e o cartão "Brancos e limites" na
  aba Curvas (papel de cada análise aberta: branco / nível baixo / fora; massa de
  matriz; intervalo). Manual atualizado. **Aberto:** conferir o LoQ com o PMP-009
  (hoje μ_branco + 10σ_branco — perguntado ao usuário).
- ✅ F3: `app/modules/postrun_validation.py` (viés, RMSEP, recuperação, regressão,
  ANOVA de um fator com o dia como fator → s_r, s_entre, s_PI) e
  `routes_postrun_validation.py` (papéis calibração/validação por estudo em
  `PostrunStudy.validation`; corrida de validação que é ponto de curva sai das
  métricas; modo cego esconde nome/proporções/massa adicionada/recuperação até
  "revelar", que guarda as massas encontradas e trava o conjunto). Cartão
  "Validação independente" no detalhe do estudo, com o gráfico encontrada ×
  adicionada (1:1, regressão, U95). Manual atualizado.
- ✅ F4: `PostrunRunRecord` (exclusão com motivo da lista + comentário obrigatório,
  metadados: massa de matriz, lote, granulometria, operador, data) e
  `PostrunExclusionLog` (histórico imutável) — tabelas novas, acompanham o
  renomear; `routes_postrun_runs.py`; corrida excluída sai do relatório, da
  validação e das curvas com o motivo; ficha da corrida na lista (etiqueta) e
  "excluir…" em lote; Excel do estudo com as abas Arquivos e metadados (SHA-256 de
  cada .B00), Parâmetros dos ajustes, Exclusões e histórico, e a versão do
  GeoHorun em "Sobre" (`GEOHORUN_BUILD` opcional no ambiente). Manual atualizado.
- ✅ F5: botão "⤓ figura" em todo gráfico (`ui/ExportFigure.tsx`,
  `lib/figureExport.ts`): SVG vetorial autônomo ou PNG 300 dpi (pHYs gravado) com
  1063 px (1 coluna) ou 2244 px (página), fundo branco e tema claro sempre; paleta
  FIXA por polímero (Okabe-Ito, `materialColor` em `lib/postrunColors.ts`) em
  todas as figuras de material; "Excel para publicação" (`?simples=true`, só
  valores) no Relatório e no estudo. Manual atualizado.

**Fase 2 (P1 do artigo) concluída** — próximos: Fase 3 (núcleo do GeoWorks; precisa
do livro do Rock-Eval) ou P2 do artigo (F6–F9).

Andamento da Fase 4 (P2 do artigo, 14/11/2026):
- ✅ F6: `routes_postrun_compare.py` — `POST /api/postrun/studies/{id}/compare-models`:
  molde, molde centro fixo, molde sem dilatação, CLS, gaussiana e bigaussiana
  guiadas e "soma ponderada (PMP-008)" (= moldes rígidos + fator de resposta médio,
  reta pela origem com peso 1/m² — leitura nossa, a conferir com o PMP-008);
  reajusta puros e misturas sem gravar, curvas por modelo em memória
  (`build_report(curve_cache=…)`); recuperação, RMSE, RMSEP, BIC, R², picos no
  limite. Cartão "Comparador de modelos" no estudo, barras exportáveis.
- ⬜ F7, F8, F9.

## Fase 3 — GeoWorks, núcleo

Do levantamento da ajuda e dos arquivos de configuração do GeoWorks (sem
copiar nada deles):

1. **Motor de fórmulas** — a mesma linguagem dos métodos e dos parâmetros do
   usuário: operadores (`** * / + - < <= > >= == != && || ^^ ?:`), funções
   (ABS, CLAMP, EXP, LN, LOG10, POW, SQRT, IF, NULL…), NULL que se propaga,
   nomes normalizados (S3'CO → S3_CO).
2. **Motor de cursores** — início/fim da rampa pela temperatura; cursores de
   temperatura fixa, mínimo e máximo dentro de janelas; áreas entre limites;
   `Cur_n_Temp/Val/Time` e `Surf_n`.
3. **Parâmetros BulkRock** (padrão próprio a partir do livro/literatura):
   S1, S2, S3, S3CO, S3'CO, S4, S5, Tmax (TpkS2 corrigido pelo padrão e pela
   taxa), PC, RC, TOC, MinC, HI, OI, OICO, PI e enxofre.
4. **Importar métodos do GeoWorks instalado** (BulkRock, Kerogen, Coal,
   PureOil, Reservoir, GasShales, MultiHeatingRates, Blank) — arquivos lidos
   da instalação, guardados no banco do módulo, nunca no repositório.
5. **Calibração por padrão** — fator K por gás e ciclo (lei ganho ou linear,
   R² e sigma), correção do Tmax pelo Tpeak do padrão, pontos com validade.
6. **Edição de cursores** na curva (inicial × corrigido, validar/desfazer).
7. **Relatório** por método (colunas básico/detalhado), exportação.
8. **Diagramas** HI×OI, HI×Tmax e fator de forma, com as curvas de tipo de
   querogênio importadas do GeoWorks instalado (ou da literatura), cor por
   terceiro parâmetro, regressão.

## Fase 4 — Artigo P2 (F6–F9) e GeoWorks P2

Comparador de modelos e ablação; painel de interação na co-pirólise; robustez
dos moldes (leave-one-run-out, comparação de lotes, incerteza do molde);
diagnóstico de identificabilidade (bootstrap). Brancos e remoção de lama,
comparação de análises sobrepostas.

## Fase 5 — Artigo P3 (F10–F12) e GeoWorks avançado

Ajuste conjunto de rampas e canais; componente "matéria orgânica natural";
pacote de dados aberto. Cinética (distribuição discreta de energias de
ativação, Kissinger), modelagem com histórico de soterramento, carbono do solo
(percentis T10…T90, PARTYsoc), destilação simulada.

## Pontos que precisam do livro do Rock-Eval / literatura

Regras exatas de linha de base e numeração das áreas (confirmar com amostra
conhecida); definição do fator de ganho por canal; origem dos coeficientes de
enxofre, TR, coque, gás e Qsat (para citar); índices R/I e Cp (Sebag et al.
2016); conversão TR → Ro na modelagem; algoritmo da cinética. Possíveis erros
nos métodos do GeoWorks a conferir: índice do cursor do F2; sinal da correção
de Tmax do método Coal; ciclo/cursores do GasShales.
