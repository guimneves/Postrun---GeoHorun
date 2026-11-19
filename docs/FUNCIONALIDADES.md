# PostRun · GeoHorun — implementações e funcionalidades

Descrição completa do que o GeoHorun faz hoje (18/11/2026): cada tela, cada
cálculo e onde ele está no código. O passo a passo de uso fica na aba
**Manual** (`frontend/src/manual/content.tsx`); o plano e o que falta, em
[`PLANO.md`](PLANO.md); os conceitos de referência, molde e gaussiana, em
[`CONCEITOS_REFERENCIA_MOLDE_GAUSSIANA.md`](CONCEITOS_REFERENCIA_MOLDE_GAUSSIANA.md).

---

## Sumário

1. [O que é o GeoHorun](#1-o-que-é-o-geohorun)
2. [Arquitetura](#2-arquitetura)
3. [Leitura dos arquivos do Rock-Eval](#3-leitura-dos-arquivos-do-rock-eval)
4. [Aba Análises](#4-aba-análises)
5. [Gráficos: Pirograma, Sobrepor e Multi](#5-gráficos-pirograma-sobrepor-e-multi)
6. [Integração por região](#6-integração-por-região)
7. [Massa da corrida](#7-massa-da-corrida)
8. [Ficha da corrida, exclusões e rastreabilidade](#8-ficha-da-corrida-exclusões-e-rastreabilidade)
9. [Calibração do FID com o padrão (aba Calibração)](#9-calibração-do-fid-com-o-padrão-aba-calibração)
10. [Curvas de calibração e quantificação (aba Curvas)](#10-curvas-de-calibração-e-quantificação-aba-curvas)
11. [Brancos de matriz e limites (LoB, LoD, LoQ)](#11-brancos-de-matriz-e-limites-lob-lod-loq)
12. [Composição das corridas](#12-composição-das-corridas)
13. [Deconvolução](#13-deconvolução)
14. [Relatório de recuperação (aba Relatório)](#14-relatório-de-recuperação-aba-relatório)
15. [Estudos](#15-estudos)
16. [Ferramentas do estudo](#16-ferramentas-do-estudo)
17. [Quimiometria: PCA e PLS](#17-quimiometria-pca-e-pls)
18. [Figuras e tabelas para publicação](#18-figuras-e-tabelas-para-publicação)
19. [Renomear, mover e trocar a amostra](#19-renomear-mover-e-trocar-a-amostra)
20. [Agente do PC do Rock-Eval](#20-agente-do-pc-do-rock-eval)
21. [Permissões](#21-permissões)
22. [Integração com o RE7S e o Resultados](#22-integração-com-o-re7s-e-o-resultados)
23. [API (rotas)](#23-api-rotas)
24. [Banco de dados](#24-banco-de-dados)
25. [Testes](#25-testes)
26. [Implantação](#26-implantação)
27. [O que o GeoHorun ainda não faz](#27-o-que-o-geohorun-ainda-não-faz)

---

## 1. O que é o GeoHorun

O **PostRun · GeoHorun** é o módulo do Horun para o **pós-corrida do Rock-Eval
7S**. Ele lê os arquivos que o equipamento grava (um por análise) e trabalha o
**sinal bruto** dos detectores. Esse sinal é o que o software do fabricante
(GeoWorks) usa por dentro, mas não deixa trabalhar:

- **FID**, na pirólise;
- **CO, CO₂ e SO₂** (infravermelho), na pirólise e na oxidação.

Com esse sinal, o GeoHorun:

- mostra os pirogramas, sozinhos, sobrepostos ou com todos os detectores juntos;
- integra áreas por região, com linha de base;
- calibra o FID com padrões certificados;
- monta curvas de calibração massa × área e quantifica corridas novas, com incerteza;
- calcula limites de detecção e quantificação com brancos de matriz;
- **deconvolui** misturas (por exemplo, de polímeros) em componentes, usando gaussianas ou o **molde** do material puro;
- calcula a **recuperação** e a validação independente;
- diagnostica a interação na co-pirólise, a robustez dos moldes e os picos sobrepostos;
- faz **PCA e PLS** das curvas inteiras;
- organiza tudo em **estudos** e exporta Excel e figuras prontas para artigo.

Os parâmetros geoquímicos do GeoWorks (S1, S2, S3, Tmax, TOC, HI, OI…) **ainda
não** são calculados aqui. São a Fase 3 do plano (seção 27).

Histórico: o PostRun nasceu dentro do módulo RE7S, que cuida da fila e do
carrossel do equipamento. Virou módulo próprio em 13–14/11/2026, com os dados
migrados (`backend/app/scripts/migrar_do_re7s.py`).

- Id no Core: `geohorun`.
- Endereço: `/m/geohorun/`.
- Repositório público: `guimneves/Postrun---GeoHorun`.

---

## 2. Arquitetura

| Parte | Tecnologia | Onde |
|---|---|---|
| Backend | Python 3.11 (servidor), FastAPI, SQLModel, numpy, scipy, openpyxl | `backend/app/` |
| Banco | Postgres em produção, SQLite em desenvolvimento e testes | `backend/app/db/` |
| Frontend | React + Vite + TypeScript, design system do Horun | `frontend/src/` |
| Acesso aos arquivos | Agente Horun no PC do Rock-Eval (produção) ou pasta local (`POSTRUN_DATA_DIR`) | `backend/app/agent_server/` (cópia), `modules/agent_bridge.py` |
| Identidade | Cabeçalhos `X-Horun-*` do Core; papel recalculado a cada pedido | `core/identity.py`, `api/deps.py` |

### 2.1 Organização do backend

- **`modules/`**: cálculo puro, sem banco e sem HTTP. São testados direto. Inclui o parser, a integração, a regressão, a deconvolução, a quimiometria, os limites, a validação, a composição e a base de tempo.
- **`api/routes_*.py`**: rotas, uma por assunto. Cada rota lê do banco e dos arquivos, chama `modules/` e devolve o resultado.
- **`db/models.py`**: tabelas. Uma coluna nova em tabela existente entra por `_ensure_column` em `db/session.py`, no mesmo commit, e assim o banco se atualiza sozinho ao subir.

### 2.2 Cópias que não se editam aqui

- `backend/app/agent_server/`: servidor do Agente, vindo do repositório Agent-Horun.
- `backend/app/postrun_core/` e `frontend/src/postrun-core/`: pacote comum de todo PostRun, vindo do Horun Core. Está copiado, mas a tela do GeoHorun é própria.
- `frontend/vendor/horun-design-system/`: design system do Horun.

### 2.3 Regras do repositório

- **Público.** Não entram dados reais (`.B00` reais, planilhas, bancos) nem arquivos do GeoWorks, que são da Vinci Technologies. Os testes usam `.B00` **sintéticos** (`backend/tests/b00_factory.py`).
- O servidor roda Python 3.11, então nada de sintaxe 3.12+.
- As dependências têm versão exata em `backend/pyproject.toml`.
- O Dockerfile instala as dependências com `--timeout 120 --retries 10`, numa camada separada do código. Uma queda do PyPI não refaz tudo, e mudar só o código não reinstala as dependências.

---

## 3. Leitura dos arquivos do Rock-Eval

### 3.1 Formato

**Código:** `modules/postrun_b00.py`.

O arquivo de cada análise é texto no formato INI (seções `[Nome]`, linhas
`chave=valor`, fim de linha `\r\n`). O GeoHorun lê:

- **`[Param]`:** `Sample` (amostra), `CyclT` (pasta do método, ex.: `BULK ROCK`), `CyclN` (nome do ciclo, ex.: `BASIC`) e `Quant` (massa em mg).
- **`[Identity]`:** `Date=MM-DD-AAAA:HH-MM-SS`. O mês vem antes do dia, ao contrário do nome do arquivo; isso foi conferido em arquivos reais.
- **`[GasName]` e as curvas `Curves Pyro` e `Curves Oxi`:** índice do ponto, temperatura e um canal por detector.
- **Programa do forno** (`Rate`, `Temp`, `Iso`): vira um `CycleProgram`.
- **`[Calibration:Geoworks]` e os cursores do GeoWorks:** a lei de ganho e os pontos `Curs_n`. São usados como sugestão de região.

### 3.2 Todos os métodos do equipamento

O formato é o mesmo para todo método; muda só a extensão, sempre "letra + 00":

| Extensão | Método (pasta) |
|---|---|
| `.B00` | BULK ROCK |
| `.M00` | MULTI-HEATING RATES |
| `.O00` | PURE OIL |
| `.Q00` | COAL |
| … | qualquer outro "letra + 00" |

- A regra é `is_analysis_file`, com a expressão `\.[A-Za-z]00$`. A listagem usa o padrão `*.?00`, local ou pelo Agente.
- O arquivo com `~` no fim (`.B00~`) é o backup do GeoWorks e fica de fora.
- O teste foi feito com 61 `.M00`, 37 `.O00` e 1 `.Q00` reais; todos abriram.
- **Programa em vários trechos** (multi-heating rates): `Rate1/Temp1/Iso1`, `Rate2/…`. Fica em `CycleProgram.steps` e `segments()`. O rótulo do ciclo mostra todas as rampas. A chave de um programa de rampa única não mudou, então as curvas antigas continuam valendo.

### 3.3 Eixo de tempo

**Código:** `modules/postrun_timebase.py`.

O arquivo só grava o **índice** de cada ponto. O tempo vem do programa do
forno: segundos por ponto = (rampa ÷ 60) ÷ (°C por ponto medido na rampa).

- Em arquivos reais com 25 °C/min, deu 0,99–1,00 s por ponto: o equipamento grava a 1 Hz.
- Com vários trechos, cada trecho é estimado separadamente e vale o trecho com mais pontos.
- Todas as **áreas são no tempo**, em sinal × s. Por isso uma curva de calibração vale para um ciclo só.

### 3.4 Leitura em segundo plano e cache

**Código:** `modules/postrun_scan.py`, `PostrunB00Cache`, `hooks/usePostrunScan.ts`.

- Abrir um job dispara uma *thread*. Ela lista as análises e lê uma por uma, guardando o resultado no cache do banco.
- A lista na tela vai aparecendo enquanto o Agente responde, e dá para trabalhar nas que já chegaram.
- **Verificar novamente** procura análises novas e relê as que falharam (rede lenta, Agente ocupado).
- Isso substitui a leitura dentro da própria requisição, que o proxy do Core cortava em 30 s.

### 3.5 `standard.ini`

**Código:** `modules/standard_ini.py`.

Lê os padrões carregados nas três posições de padrão do equipamento
(STD1–STD3): nome, Tmax e S2 certificados. Uma posição com zeros é vaga, não
erro.

---

## 4. Aba Análises

**Código:** `pages/PostRunPage.tsx`.

### 4.1 Lista de jobs e análises

- **Jobs:** a primeira pasta da RE7raw-data, com busca.
- **Análises:** uma linha por arquivo. Mostra a amostra, a réplica, a massa (editável), o método, a data e a miniatura da curva (*sparkline*, `POST /analyses/sparklines`).
- **Modo Completa ou Simples:** o Simples é uma linha só, com nome e massa. A escolha fica lembrada no navegador.
- As réplicas ficam agrupadas por amostra e podem ser recolhidas. A caixa da amostra marca todas as réplicas dela.

### 4.2 Filtros

- **Busca:** nome.
- **Método:** pasta do método no job (BULK ROCK, MULTI-HEATING RATES, PURE OIL…).
- **Ciclo:** nome do ciclo no arquivo. A lista de ciclos segue o método escolhido.
- **Ordem e Data.**
- **Ocultar** (olho riscado): só esconde a análise da lista; não apaga nada.

### 4.3 Réplicas pelo nome

**Código:** `lib/replicates.ts`.

Algumas amostras de antes do Horun ganharam um nome por réplica: `X1`, `X2`,
`X3` ou `X-1`, `X-2`… Elas viram a amostra `X`, com o selo **"réplicas pelo
nome"**. Para juntar, todas as condições abaixo valem:

- o nome termina num **único algarismo de 1 a 9**, depois de uma letra ou de um separador (espaço, `_`, `-`);
- cada nome tem **uma corrida só por método**; uma série em que cada nome já tem várias corridas continua sendo de amostras diferentes;
- são pelo menos dois nomes, com algarismos diferentes;
- números de dois dígitos (`…280`, `…_10`) nunca juntam.

A regra foi conferida nos 1024 arquivos reais: 12 grupos genuínos, nenhum
falso. Ela também vale para "colorir por amostra" na PCA.

### 4.4 Workspace

- As análises marcadas ficam abertas no **Workspace**, no alto da tela; uma delas é a **ativa**.
- Na lista, a barra azul marca as abertas e a laranja, a ativa.
- As outras abas (Deconvolução, Curvas, Relatório) trabalham sobre as análises abertas.

### 4.5 Ações em lote

Com várias análises marcadas, dá para:

- marcar todas;
- **excluir…** (com motivo, seção 8);
- **Mover para outro job…** e **Trocar amostra…** (seção 19).

---

## 5. Gráficos: Pirograma, Sobrepor e Multi

**Código:** `PostRunPyrogramPlot.tsx`, `PostRunOverlayPlot.tsx`, `PostRunMultiPlot.tsx`, `PostRunCurveViewer.tsx`.

- **Pirograma:** tempo (s) × intensidade da análise ativa.
  - Escolha **Pirólise** ou **Oxidação** e o **Canal** (FID, CO, CO₂, SO₂).
  - A opção **rampa de temperatura** põe a temperatura × tempo num segundo eixo.
- **Sobrepor:** todas as abertas num gráfico, no canal escolhido.
  - Eixo X: temperatura ou tempo.
  - Escala: bruta, por mg ou pela altura (máximo = 1). A linha de base pode ser descontada.
  - Cor **por amostra** (réplicas com traços diferentes) ou **por réplica**. Clique no quadradinho para escolher a cor, que fica guardada no navegador.
  - Caixas mostram ou ocultam cada curva; passar o mouse destaca a curva e mostra o nome.
- **Multi:** todos os detectores juntos, cada um com a sua cor (azul FID, verde CO, vermelho CO₂, amarelo SO₂).
  - Mostra a ativa ou todas as abertas.
  - A escala pela altura compara a forma, já que o FID é muito maior que os outros detectores.

Todo gráfico tem **⤓ figura** (seção 18).

---

## 6. Integração por região

**Código:** `modules/postrun_calc.py`, rotas `/regions*`, `PostRunPage.tsx` (etapas).

Ao tocar em **Integrar**, aparecem três etapas: **1 · Região**,
**2 · Deconvolução** e **3 · Calibração do canal**.

- **Região:** início e fim em índice. Dá para arrastar os marcadores ou digitar.
  - A **linha de base** é subtraída antes de integrar. Sem região marcada, a sugestão é o cursor do GeoWorks (**Usar esta região**).
  - A área é calculada pelo trapézio, no tempo (sinal × s).
- **Aplicar a todas as abertas** (ou às marcadas): copia faixa, rótulo e linha de base para as outras análises (`POST /regions/apply`).
- **Nada é gravado até Salvar.**
  - Até lá, as regiões aparecem como *não salvo*, com a área já calculada (`POST /regions/preview`). A bolinha laranja indica alteração pendente.
  - **Desfazer alterações** volta ao que estava salvo; **Remover região** só apaga ao salvar.
  - Fechar a página com algo pendente pede confirmação.
- **Resumo das regiões:** áreas, picos, valores calibrados, situação e **Exportar CSV**.

---

## 7. Massa da corrida

**Código:** `PostRunMassEdit.tsx`, `PUT /analyses/meta`.

- Clique na massa, digite o valor em mg e tecle Enter. A massa corrigida vale para curvas, quantificação e recuperação e aparece com ✎.
- A massa é gravada **também no próprio arquivo** (linha `Quant=`, e no backup `~`), para o GeoWorks ver a mesma massa.
- A original fica guardada (`file_mass_before_mg`): apagar o valor volta a ela.
- Se o Agente estiver só leitura ou fora do ar, a correção vale no Horun e aparece "⚠ só no Horun". Ao verificar as análises de novo, o arquivo é atualizado sozinho.
- A correção também aparece na tabela da aba Referências.

---

## 8. Ficha da corrida, exclusões e rastreabilidade

Item F4 do artigo. **Código:** `modules/run_records.py`, `routes_postrun_runs.py`, `RunRecordModal.tsx`, `api/study_trace.py`.

- **Metadados** que o arquivo não guarda: massa de matriz, lote ou fabricante do polímero, granulometria, operador(a), data (vazio = a do arquivo) e observações.
- **Exclusão com motivo:** o motivo vem de uma lista (corrida falha, massa ausente, troca de nome suspeita, outro), e o comentário é obrigatório.
  - A corrida sai do relatório de recuperação, da validação e dos pontos das curvas, sempre com o motivo à vista.
  - **Nada é apagado:** dá para **restaurar**.
  - Dá para excluir em lote.
- **Histórico imutável** (`PostrunExclusionLog`): cada exclusão e restauração, com quem e quando.
- **Excel do estudo:** traz as abas de rastreabilidade:
  - *Arquivos e metadados*, com o **SHA-256** de cada arquivo (prova de que é o mesmo arquivo);
  - *Parâmetros dos ajustes*: janela, forma, modo, tolerâncias, chutes, referências, R² e BIC;
  - *Exclusões* e *Exclusões (histórico)*;
  - *Sobre*, com a versão do GeoHorun (`GEOHORUN_BUILD`).

---

## 9. Calibração do FID com o padrão (aba Calibração)

**Código:** `modules/postrun_calibration.py`, rotas `/calibration*`, `PostRunCalibrationPanel.tsx`.

- Usa as corridas do job de padrões (**STD**) e, se quiser, as de outro job, com os padrões certificados do catálogo do RE7S ou do `standard.ini`.
- A **prévia** mostra a área, o S2 conhecido e o Tmax. A pessoa aceita ou rejeita; a calibração nunca é automática. Dois modos:
  - **Ganho puro**: 1 ponto, mg = K1 × área. É a "Gain law" do GeoWorks; todo arquivo real tem `K0 = 0`.
  - **Com intercepto**: 2 ou mais pontos, regressão com K0, K1 e R².
- O fator é **próprio**, ajustado contra a área do GeoHorun. O K1 do GeoWorks não serve, porque foi ajustado contra a área calculada do jeito dele.
- Cada calibração tem **nome** (sugestão: padrão + mês), observação, a data em que o padrão foi rodado e a data de validação.
- **Vigente:** dá para guardar uma calibração antiga sem trocar a atual, e depois **tornar vigente** a que deve valer.

---

## 10. Curvas de calibração e quantificação (aba Curvas)

**Código:** `modules/postrun_regression.py`, `routes_postrun_curves.py`, `PostRunCurvesTab.tsx`, `PostRunScatterPlot.tsx`, `PostRunLinesPlot.tsx`.

### 10.1 Pontos

- Cada ponto é **uma análise com uma região** (ou um pico da deconvolução).
- **X:** massa da **amostra** ou de **um componente** (massa × fração da composição).
- **Y:** área no tempo. A **área de** pode ser a da região, a de um **pico gaussiano** ou a de um **pico ajustado pelo molde**.
- Uma curva vale para **um ciclo**: pontos de ciclos diferentes são recusados.

### 10.2 Modelos e pesos

- **Modelos:**
  - `linear`: a + b·m;
  - `origin`: b·m, como a lei de ganho;
  - `quadratic`: a + b·m + c·m², para perto da saturação do FID.
- **Pesos:** nenhum, 1/m ou **1/m²**. O 1/m² é o recomendado quando as massas vão de 0,1 a 4 mg, porque a dispersão cresce com a massa.

### 10.3 Gráficos

São três, interativos:

- **área × massa**, com LD e LQ;
- **área ÷ mg**, que deve ser constante: tendência indica saturação ou perda;
- **resíduos**, em % do previsto (o que o peso 1/m² minimiza) ou em sinal·s, com a faixa de ± 2 × a dispersão.

No gráfico, clicar num ponto tira ele do ajuste (fica vazado) ou devolve.
Arrastar um retângulo tira vários, e Shift + arrastar devolve.

### 10.4 Quantificar (inversa)

- A massa é m₀ tal que f(m₀) = A₀ (área medida).
- A incerteza vem pelo **método delta**: u(m₀)² = [s²/w(m₀) + gᵀ·Cov·g] ÷ f′(m₀)².
- Ela é expandida com t de Student (95 %).
- O resultado sai com a massa esperada e a **recuperação %**. Há aviso quando a área cai fora da faixa da curva ou abaixo do LD/LQ.

### 10.5 LD e LQ da curva

- Pela ICH Q2: 3,3·σ₀/b e 10·σ₀/b.
- σ₀ é o erro-padrão no zero (o do intercepto).
- Na reta pela origem, σ₀ vem das réplicas do menor nível.

---

## 11. Brancos de matriz e limites (LoB, LoD, LoQ)

Item F2 do artigo. **Código:** `modules/postrun_limits.py`, `POST /curves/{id}/limits`, `PostRunCurveLimits.tsx`.

- **Entrada:** corridas de **branco da matriz** (areia, sedimento, solo, sílica…, sem o analito; o recomendado é 10 ou mais) e, opcionalmente, réplicas de **nível baixo**.
  - O papel de cada corrida é marcado na tela. Nomes com "branco" ou "blank" já vêm marcados como branco.
- Cada corrida é integrada no intervalo da curva e convertida em **massa aparente** pela própria curva.
- **Critérios**, sempre escritos ao lado do resultado:
  - **LoB** = μ_branco + 1,645·σ_branco (Armbruster & Pry, 2008; CLSI EP17);
  - **LoD** = LoB + 1,645·σ_baixo. Sem réplicas de nível baixo, usa σ_branco, com aviso;
  - **LoQ** = μ_branco + 10·σ_branco;
  - **LD e LQ da curva** (ICH Q2), lado a lado.
- O resultado sai em **mg e em ppm** (µg/g = mg de analito ÷ mg de matriz × 10⁶). A massa de matriz por cadinho é informada; vazio usa a média dos brancos.
- Com menos de 10 brancos aparece um aviso. O resultado fica guardado na curva (`PostrunCurve.limits`).

---

## 12. Composição das corridas

**Código:** `modules/postrun_composition.py`, `PostRunCompositionEdit.tsx`.

A composição diz **quais materiais procurar** numa corrida e **quanto se
esperava** de cada um.

- **Só a deconvolução usa a composição.** Quem só integra regiões nunca a vê.
- Ela aparece como selo na aba Deconvolução. Fora dela, não há chip de composição.

### 12.1 Leitura pelo nome, nesta ordem

1. **Amostra no formato de mistura:** `PE + PS (50-50)` → 50/50; `PE + PS` → componentes sem proporção.
2. **Arquivo com proporção:** `…_PEAD_PP_PS_50-25-25_1` → 50/25/25. Os nomes antes dos números são os componentes, quaisquer que sejam.
3. **Arquivo com "+":** `PP+PS_1` → PP e PS sem proporção, **só se todos os nomes forem materiais conhecidos**. Por isso `PY+OXY`, que é um ciclo do Rock-Eval, não vira mistura.
4. **Arquivo sem proporção:** só contam os pedaços que são material conhecido. `PEAD_040_2` → PEAD puro (040 = 4,0 mg nominais); "rep" e letras soltas são ignorados.

### 12.2 Materiais conhecidos e casos especiais

- **Materiais conhecidos:** os polímeros comuns (PE, PEAD, PEBD, PELBD, PP, PS, PET, PVC, PA, PC, PMMA, PLA, ABS, PU…) e todo material que o laboratório já usou numa referência, numa curva ou informado na tela.
- **Não identificada:** selo "composição?". Rochas, padrões e brancos não entram em referências nem em curvas por engano.
- **Sem proporção:** os picos são separados e a massa de cada um sai da curva, mas sem recuperação, porque falta a massa esperada. É o caso de uma amostra real a quantificar.
- **Correção manual:** sempre vale mais que o nome.
  - Exemplos: `PS`, `PP 50, PS 50` ou `PP, PS`. Porcentagens que não somam 100 viram proporção, com aviso.
  - Um material novo informado uma vez passa a ser reconhecido no nome das próximas corridas.

---

## 13. Deconvolução

**Código:** `modules/postrun_deconv.py`, `routes_postrun_deconv.py`, `routes_postrun_workflow.py`, `PostRunDeconvTab.tsx`, `PostRunDeconvPanel.tsx`, `PostRunReferencesTab.tsx`, `PostRunRecoveryViz.tsx`.

### 13.1 Modelo

- Sinal(t) − linha de base = Σ componentes, com t em segundos.
- O ajuste é por mínimos quadrados não lineares com limites (`scipy.optimize.least_squares`).

| Forma | Fórmula | Parâmetros |
|---|---|---|
| Gaussiana | h·exp(−(t−μ)²/2σ²); área h·σ·√(2π) | h, μ, σ |
| Gaussiana assimétrica (bigaussiana) | σ diferente de cada lado; área h·√(π/2)·(σₑ+σ𝒹) | h, μ, σₑ, σ𝒹 |
| **Molde** | a curva média real do puro (área 1), deslocada e dilatada no tempo | área, posição, dilatação |

PP e PEAD têm cauda para o lado frio (esquerdo ~30–40 % mais largo); PS é
simétrico. Por isso existem a bigaussiana e o molde.

### 13.2 Modos

- **Livre:** N picos. Os chutes saem dos máximos do sinal suavizado e dos "ombros" (mínimos da 2ª derivada).
- **Gaussiana guiada:** cada pico parte do centro e da largura da **referência** do material (vinda da composição), com uma **tolerância** de ± °C no centro e ± % na largura.
  - O deslocamento aparece como **ΔTmax** e **Δlargura**, em vez de ficar escondido.
  - ⚠ marca pico no limite da tolerância ou picos sobrepostos demais.
- **Molde:** cada componente é a forma real do puro, com núcleo e caudas, e só a área, a posição (± °C) e a dilatação (± %) ficam livres.
  - É o recomendado para misturas.
  - O molde do puro aparece pontilhado sobre o componente ajustado.
  - O gráfico **Forma** mostra os dois normalizados pela altura e centrados, e sobra só a mudança de forma.
  - A tabela mostra a largura à meia altura "puro → mistura".
- **Incerteza da área:** vem da covariância do ajuste. Uma correlação alta entre duas áreas indica que a divisão entre elas não é confiável.
- **Qualidade:** R², BIC e o gráfico de resíduos. `/fit` não grava nada; `/save` reajusta no servidor com as mesmas escolhas e grava.
- **Gaussiana e molde ficam salvos lado a lado:** uma deconvolução por análise, canal e método. Trocar o método mostra o outro sem apagar nada.

### 13.3 Referências

**Código:** `PostrunDeconvReference`, aba Referências.

Cada referência é de um material e de um ciclo, feita das corridas puras, e
guarda duas coisas:

- a **gaussiana de referência**: centro e larguras médios, com o desvio entre as corridas;
- o **molde**: média das corridas com área 1, alinhadas pelo máximo.

A tela da referência mostra:

- o molde com cada corrida sobreposta e a faixa ± desvio;
- por corrida: Tmax, largura, **dilatação** (largura ÷ largura do molde) e o quanto a forma foge do molde, com ⚠ nas que destoam;
- a **dilatação natural** do material, usada como guia: a sugestão de tolerância é o dobro dela;
- **Comparar**: sobrepõe os moldes de vários materiais. Moldes que quase se cobrem não se separam numa mistura.

Uma corrida pode ser tirada da referência e continua fora quando a referência
é refeita.

### 13.4 Aba Deconvolução: os 4 passos

**Código:** `routes_postrun_workflow.py`.

1. **Puros → referência e molde:** cada puro é ajustado com 1 pico livre (assimétrico) e a referência do material no ciclo é criada ou refeita.
2. **Ajustar e salvar** puros e misturas no método escolhido (**Molde** ou **Gaussiana guiada**).
3. **Curvas automáticas** por material, só com os puros e no mesmo método. A curva tem de usar o mesmo tipo de área da quantificação.
4. **Recuperação:** o relatório (seção 14).

`/status` mostra, por análise, o que já existe (região, composição,
deconvolução de cada método) e quais referências e curvas existem, com ✓ e ✗.

- **Puros só uma vez por ciclo:** depois de criadas as referências e curvas, para misturas novas basta abrir as misturas e rodar os passos 2 e 4.
- A recuperação dos próprios puros (100 %) é circular, porque são as corridas da curva, e não valida o método.

### 13.5 Gaussianas como "amostras virtuais"

- Cada pico salvo (análise + material) entra nas curvas de calibração e no quantificador.
- **Quantificar gaussianas** dá a massa ± incerteza, a esperada e a recuperação.

---

## 14. Relatório de recuperação (aba Relatório)

Item F1 do artigo. **Código:** `routes_postrun_report.py`, `PostRunReportTab.tsx`, `lib/componentMassPaste.ts`.

### 14.1 O que mostra

- Parte das deconvoluções **salvas**. As réplicas são agrupadas por composição e ciclo.
- Cada material, somando os picos dele, é quantificado pela curva mais recente do mesmo canal e ciclo, ou pela que for escolhida na tela.
- **Por componente:** média ± desvio da massa encontrada, da **recuperação %**, do **ΔTmax** e da **Δlargura**, mais o pior R².
- **Os três números de recuperação**, sempre com média ± desvio e o **n de réplicas válidas** ("n=3 de 4"):
  - **de cada componente:** encontrada ÷ esperada;
  - **das poliolefinas somadas** (PEAD + PP…), quando há duas ou mais: a divisão entre elas é incerta, mas a soma não;
  - **total:** Σ encontradas ÷ massa pesada, ou ÷ soma das massas reais dos componentes.
- **Destaque no topo:** um cartão por composição (verde até ±5 % de 100, âmbar até ±10 %, vermelho além) e as barras com o desvio, a faixa 95–105 % e a linha dos 100 %.
- **Gráficos:** recuperação, ΔTmax e Δlargura × fração, com a faixa da dilatação natural dos puros (média ± 2 desvios). Ponto vazado = no limite da tolerância.

### 14.2 Massa real dos componentes

- A sub-aba **Réplicas** tem a massa real pesada de cada polímero. Com ela, a massa esperada deixa de ser fração nominal × massa.
- **Baixar modelo (.csv)** traz uma linha por réplica; **Colar do Excel** preenche as caixas para conferir antes de salvar.

### 14.3 Excel

- **Baixar Excel:** abas Resumo, Corridas, Curvas, Referências, Deconvoluções e o que ficou de fora.
- Versão **para publicação** (só valores, seção 18).

---

## 15. Estudos

**Código:** `routes_postrun_study.py`, `PostRunStudiesTab.tsx`, `PostRunStudyTools.tsx`.

O estudo é o **envelope** de uma série de trabalho. Ele guarda:

- as análises (puros e misturas), que podem ser de jobs diferentes; as deconvoluções vêm com elas;
- as referências e moldes;
- as curvas de calibração;
- as calibrações STD;
- as classes (PCA) e os papéis da validação.

### 15.1 Ciclo de vida

- **Criar** e **Guardar workspace no estudo:** entram as análises abertas e o que elas usam.
- **Método oficial:** Molde ou Gaussiana, escolhido ao criar e mudável enquanto o estudo está em andamento.
  - É o que aparece no cartão e o que vai para o Resultados.
  - O outro método continua calculado, para comparar.
- **Ativar:** abre tudo de uma vez, como um job. A barra **Estudo** fica nas abas Deconvolução, Curvas e Relatório.
- **Situação:** só o ativo tem o selo ATIVO; os outros aparecem *em andamento* ou *finalizado*.
- **Finalizar:** congela o relatório dos dois métodos (*snapshot*) e tira as referências e curvas dele das listas gerais. Elas continuam no estudo, e dá para desfazer.
- **Proteções:** uma curva ou referência num estudo não pode ser apagada. Apagar o estudo apaga só o envelope.
- **Exportar Excel completo:** tudo, com as abas de rastreabilidade (seção 8).
  - A aba **Horun_Resultados** está em formato longo (`horun-postrun-estudo` v1) e é a que o módulo Resultados importa.

---

## 16. Ferramentas do estudo

No detalhe do estudo, as ferramentas aparecem como cartões com ícone e a
pergunta que cada uma responde. Clicar abre só aquela ferramenta.
**Nenhuma ferramenta grava resultado de ajuste:** todas reajustam em memória.

### 16.1 Validação independente

Item F3 do artigo. **Código:** `modules/postrun_validation.py`, `routes_postrun_validation.py`, `PostRunValidationPanel.tsx`.

- **Papéis:** cada corrida é **calibração** ou **validação**, nunca as duas. Uma corrida de validação que seja ponto de uma curva usada sai das métricas, com o motivo.
- **Modo cego:** até revelar, as corridas de validação aparecem como V01, V02… só com a massa encontrada. Nome, proporções, massa adicionada e recuperação ficam escondidos.
  - **Revelar as respostas** guarda as massas daquele momento e trava o conjunto.
  - Se uma corrida mudar depois, ela aparece marcada "mudou depois da revelação".
- **Métricas por material:**
  - **viés**, em mg e em %;
  - **RMSEP** = √média((encontrada − adicionada)²);
  - **recuperação** média ± DP;
  - **regressão** encontrada = a + b × adicionada, com 3 ou mais níveis;
  - **precisão intermediária** por ANOVA de um fator, com o **dia** como fator (ISO 5725-3, Eurachem). Dá s_r, s_entre e s_PI = √(s_r² + s_entre²); para grupos desiguais, n₀ = (N − Σnᵢ²/N)/(k − 1).
- **Gráfico:** encontrada × adicionada, com a reta 1:1, a regressão por material, as barras de U95 e a faixa do U95 relativo.

### 16.2 Réplicas (inspetor)

**Código:** `PostRunStudyInspect.tsx`.

- Escolha uma réplica: aparece a corrida com o molde do puro sobreposto, a forma normalizada e as larguras.
- As réplicas com pico no limite vêm marcadas (⚠), e a primeira delas já abre.
- Cada componente tem a cor fixa do material, a mesma da legenda.

### 16.3 Tolerância ótima

**Código:** `POST /studies/{id}/sensitivity`, `PostRunStudyTolerance.tsx`.

- Reajusta só as **misturas** (molde) em várias tolerâncias de largura. O padrão é 10, 15, 20, 25, 30, 40, 50, 60 e 80 %. As curvas e os puros ficam fixos.
- Traça o **RMSE da recuperação** (recuperação − 100) × a tolerância. A ótima é a **menor tolerância no mínimo** da curva; um platô indica que os picos pararam de bater no limite.
- **Validação deixa-uma-composição-de-fora:** a tolerância é escolhida sem uma composição e o erro é medido nela. Se a escolha muda muito, a tolerância é instável.

### 16.4 Comparar modelos (e ablação do molde)

Item F6 do artigo. **Código:** `routes_postrun_compare.py`, `PostRunModelCompare.tsx`.

Os mesmos puros e misturas, com a mesma janela e as mesmas referências, são
reajustados em cada modelo. Cada modelo ganha as **próprias curvas**:

| Modelo | O que fica livre |
|---|---|
| Molde | centro e dilatação (dentro das tolerâncias) |
| Molde, centro fixo | só dilatação (ablação) |
| Molde, sem dilatação | só centro (ablação) |
| Molde rígido (CLS) | nada além da área: mínimos quadrados clássicos |
| Gaussiana guiada / Bigaussiana guiada | centro e largura (tolerâncias) |
| Soma ponderada (Pawar e Kim, 2025) | moldes rígidos + fator de resposta médio dos puros (área/mg) |

A tabela traz a recuperação por material e total, o **RMSE da recuperação**
(o menor fica destacado), o RMSEP em mg, o BIC e o R² médios e os picos no
limite. O gráfico de barras é exportável.

### 16.5 Interação na co-pirólise

Item F7 do artigo. **Código:** `routes_postrun_interaction.py`, `PostRunInteractionPanel.tsx`.

- **Previsão sem interação:** soma dos moldes **rígidos** dos puros, cada um com a área que a curva dá para a massa esperada.
- **Curva de diferença** = medido − previsto, análoga ao ΔM de Pawar e Kim (2025).
  - ΔM (%) = (∫medido − ∫previsto) ÷ ∫previsto, junto com o maior desvio local.
- **ΔTmax e Δlargura × fração**, das deconvoluções salvas.
- **Alerta** dos parâmetros que bateram no limite: a interação passou da folga dada ao ajuste.

### 16.6 Robustez dos moldes

Item F8 do artigo. **Código:** `routes_postrun_robustness.py`, `PostRunRobustnessPanel.tsx`.

- **Deixa-uma-corrida-de-fora:** o molde é refeito sem cada corrida pura. Puros e misturas são reajustados, a curva é refeita e as misturas são requantificadas. O resultado é o **efeito do molde** em pontos percentuais.
- **Incerteza combinada**, por mistura: u² = u_ajuste² + u_molde². Aqui u_ajuste = U95 da curva ÷ 2 e u_molde = desvio da massa entre os moldes deixa-um-de-fora. Também mostra a fração da variância que vem do molde.
- **Comparar com outro molde** (outro lote, grade ou granulometria): correlação e distância L2 das formas, diferença na posição do máximo e Δ recuperação.

### 16.7 Picos sobrepostos (identificabilidade)

Item F9 do artigo. **Código:** `routes_postrun_identifiability.py`, `PostRunIdentifiabilityPanel.tsx`.

- **Correlação das áreas** (ρ, da covariância do ajuste salvo) para cada mistura e par. Vermelho com |ρ| > 0,9, com a recuperação de cada material e **a da soma**.
- **Recomendação** de reportar a soma quando o par é mal condicionado na maioria das misturas.
- **Bootstrap** de uma mistura: sinal ajustado + resíduos reamostrados **em blocos** (os resíduos de um pirograma são autocorrelacionados), reajustado de 50 a 200 vezes. Dá o IC 95 % de cada massa, os CVs e a nuvem massa A × massa B. A "banana" descendente indica que só a soma é determinada.

---

## 17. Quimiometria: PCA e PLS

**Código:** `modules/postrun_chemometrics.py` (só numpy e scipy), `routes_postrun_chemometrics.py`, `PostRunStudyChemometrics.tsx`. Fundamentos em `docs/QUIMIOMETRIA_PCA_PLS.md` (roteiro de slides, local).

### 17.1 Matriz X

Cada corrida vira uma **linha** e cada temperatura, uma **coluna**.

- **Janela e linha de base:** as da deconvolução salva (método do estudo; senão o outro). Sem deconvolução, a da **maior** região salva.
- **Grade comum** de 1 em 1 °C na faixa que todas as corridas cobrem. Só entram os trechos em que a temperatura sobe (`monotonic`).
  - Se as faixas não se sobrepõem, o erro explica qual corrida destoa.
  - Uma faixa informada à mão completa com zeros, com aviso.
- **Pré-tratamento** (`Prep`):
  - normalização pela **área** (compara a forma), pela **massa** (sinal por mg) ou nenhuma;
  - **derivada** (Savitzky-Golay, realça ombros);
  - **alinhamento pelo máximo** (corrige o Tmax "andando").

### 17.2 PCA

- **Cálculo:** SVD da X centrada, X = T·Pᵀ + E, com os sinais orientados de forma estável.
- **Saídas:**
  - variância explicada;
  - **scores** (cada ponto é uma corrida);
  - **loadings** × temperatura. Lóbulos de sinais opostos em dois picos indicam troca de material; lóbulos nas laterais, alargamento;
  - **T² de Hotelling × Q** (resíduo), com limites de 95 %: F para o T² e Jackson–Mudholkar para o Q. T² alto = corrida extrema; Q alto = forma diferente.
- **Colorir por:** grupo, dia, **classe**, ciclo, método, amostra (com a regra das réplicas pelo nome) ou fração de um material.
- **Classes** (`PostrunStudy.classes`): até 20 classes por estudo (1, 2, 3… ou nomes).
  - Seleção no gráfico ou na lista: clique; **Ctrl+clique** soma ou tira; **Shift+clique** soma (na lista, um intervalo); arrastar um retângulo.
  - Aplicar a classe com um clique ou pelas teclas **1–9** (0 tira, Esc limpa).
  - As classes ficam salvas sozinhas e só mudam a cor dos pontos. Servem para comparar os agrupamentos com o que se sabe das amostras, uma prática comum na literatura de PCA exploratória.
- **Subconjuntos:** com corridas selecionadas, **PCA só com elas** ou **PCA sem elas** (por exemplo, tirar um outlier).
  - Um aviso mostra quantas corridas entraram; *voltar a todas* desfaz.
  - Nada sai do estudo.
- **PCA multibloco:** marque mais de um detector (FID, CO, CO₂, SO₂) e eles entram **lado a lado** na mesma matriz.
  - **Escalonamento por bloco:** cada detector com variância total 1 × **peso** (Westerhuis, Kourti e MacGregor, 1998). Assim o FID não domina só por ter números maiores.
  - **Bloco sem variação:** recebe peso 0 com aviso, em vez de gerar NaN.
  - **Atraso** (s) por detector: cada ponto ganha a temperatura de quando o gás saiu da amostra, T_emissão = interp(t − atraso). O padrão é 0. No padrão de CHNS (SMTA), CO e CO₂ não mostraram atraso em relação ao FID, e o deslocamento do SO₂ é químico.
  - **Linha de base:** a mesma janela da corrida em todos os detectores; nos IR, reta pela **média** das pontas.
  - **Normalização e alinhamento** vêm do FID e valem para todos os detectores, o que preserva as razões CO/FID. A **derivada** é calculada dentro de cada bloco.
  - **Saídas:** abas com a matriz de cada detector, os **loadings por detector** na mesma escala e o **Q por detector** (em que detector a corrida foge do modelo; limite pela aproximação de Box, g·χ²(h)).
  - **Cuidado:** um detector só com ruído também pesa 1 e dilui a PCA. Dê peso menor ou 0.

### 17.3 PLS

- **Modelo:** um PLS1 (NIPALS) **por material**, prevendo a **massa (mg)** ou a **fração (%)** pela curva.
- **Corridas:** os puros e as misturas com composição completa.
- **Saídas:**
  - pesos W, scores, loadings, vetor b = W(PᵀW)⁻¹q e **VIP**;
  - RMSEC × RMSECV por número de variáveis latentes;
  - previsto × esperado;
  - b e VIP × temperatura;
  - recuperação por corrida, com o mesmo critério da deconvolução, para comparar.
- **Validação cruzada por grupo:** tira uma **composição inteira**, com as réplicas, por vez; tirar réplicas soltas deixaria o erro otimista. Também existe a opção por corrida.
  - Com menos de 6 grupos, um aviso.
- **Número de variáveis latentes:** o menor com RMSECV ≤ 1,05 × o mínimo (parcimônia), ou um número fixo.
- **Limites:** a PLS aprende a interação entre os materiais, mas não vale fora das composições da calibração.

Os resultados foram conferidos nos testes contra os autovalores da
covariância, a pseudoinversa e exemplos de brinquedo calculados à parte.

---

## 18. Figuras e tabelas para publicação

Item F5 do artigo. **Código:** `ui/ExportFigure.tsx`, `lib/figureExport.ts`, `lib/postrunColors.ts`.

- **⤓ figura**, em todo gráfico:
  - **SVG** vetorial e autônomo;
  - **PNG 300 dpi** (gravado no arquivo) com **1063 px** (1 coluna) ou **2244 px** (página inteira), as larguras pedidas pela JAAP.
- A figura sai sempre com fundo branco, as cores do tema claro e fonte Arial/Helvetica.
- **Cor fixa por material** em todas as figuras (Okabe & Ito, segura para daltônicos): PEAD azul, PEBD/PE azul-claro, PP vermelhão, PS verde, PET roxo, PVC laranja, PA preto. Os outros materiais recebem as cores que sobram.
- **Excel para publicação** (`?simples=true`): o mesmo Excel só com valores, sem formatação.

---

## 19. Renomear, mover e trocar a amostra

**Código:** `modules/analysis_rename.py`, `modules/b00_sample.py`, `routes_analysis_rename.py`, modais `RenameAnalysisModal`, `MoveAnalysesBatchModal` e `ChangeSampleModal`.

Só a coordenação pode usar. Na RE7raw-data, o nome da análise é o **nome do
arquivo** e o job é a **primeira pasta**:
`<job>/<pasta do método>/<nome>.?00`. O conteúdo do arquivo não cita nenhum
dos dois.

- **Renomear ou trocar de job:** move o arquivo e o backup `~`, com qualquer extensão de método.
  - Regiões, deconvoluções, curvas, metadados e exclusões acompanham.
  - Uma análise ainda no carrossel, não confirmada como analisada, não pode ser renomeada: o equipamento pode estar gravando.
- **Mover várias:** a janela confere cada uma antes. A que não puder ir (no carrossel, nome já existente no destino…) fica para trás com o motivo; as outras são movidas.
- **Trocar amostra:** quando a amostra errada da biblioteca foi escolhida no cadastro.
  - Troca a linha `Sample=` **nos bytes** do arquivo e do backup, sem mexer no resto.
  - Renomeia o arquivo trocando o código da amostra; data, extra e réplica ficam.
  - A biblioteca vem do RE7S, com filtro por grupo e subgrupo.
  - Cada análise pode ir para uma amostra diferente no mesmo lote: marque as análises e toque na amostra; sem nenhuma marcada, ela vai para as que ainda não têm. A API aceita `assignments` (token → amostra) além do formato antigo (`tokens` + `library_sample_id`).
- **Nomes:** `lib/rockevalName.ts` e `RockEvalNameHint.tsx` avisam de caracteres que o Rock-Eval não aceita.
- **Requisito:** a pasta `jobs` precisa de `"mode": "read-write"` no `config.json` do Agente.

---

## 20. Agente do PC do Rock-Eval

**Código:** `agent_server/` (cópia), `modules/agent_bridge.py`, `routes_agent.py`, `AgentPanel.tsx`.

- O mesmo Agente Horun que atende o RE7S, com um bloco próprio do GeoHorun no `config.json`.
- **Raízes:**
  - `jobs`: RE7raw-data, para ler, gravar a massa e mover;
  - `data`: pasta do `standard.ini`.
- **Botão Agente** no cabeçalho (coordenação): gera o **código de instalação** (uso único) e lista as instalações (conectado, sem sinal ou revogado), com a versão e a hora em que foram vistas por último.
- As rotas do próprio Agente chegam por uma porta estreita (8003), nunca pelo gateway do Core.
- O `glob` do Agente aceita `?` desde a versão 0.4.0, e é isso que permite listar `*.?00`.

---

## 21. Permissões

**Código:** `core/identity.py`, `api/deps.py`.

- Não há senha de módulo. O papel vem do **cargo no Core** a cada pedido: níveis 1 até `GEOHORUN_ADMIN_MAX_LEVEL` são coordenação; o resto é colaborador.
- **Qualquer pessoa autenticada:** lê as análises e trabalha regiões, deconvoluções, curvas, estudos e ferramentas.
- **Coordenação:** renomear, mover, trocar amostra e administrar o Agente.
- Cada pessoa ganha uma linha local em `User` (id do Core + nome) só para as colunas `*_by_id`.

---

## 22. Integração com o RE7S e o Resultados

### 22.1 RE7S

**Código:** `modules/re7s_link.py`. Usa a rede `horun-network`, com `RE7S_INTERNAL_URL` e `RE7S_INTERNAL_TOKEN`.

- **Leitura:** análise no carrossel, nome já usado, entrada de histórico, biblioteca de amostras e catálogo de padrões.
- **Réplica:** cada renomeação ou troca de amostra vai para o RE7S, numa fila de saída com nova tentativa (`_start_replica_worker`). O RE7S usa essas réplicas no histórico, nos contadores e na checagem de nome duplicado.
- RE7S fora do ar dá erro claro, nunca um "liberado" silencioso.

### 22.2 Resultados

- Importa o Excel do estudo (aba `Horun_Resultados`).
- O envio direto (`postrun_core/publish.py`, contrato `horun.postrun.result/1`) está copiado, mas ainda não ligado.

---

## 23. API (rotas)

Todas ficam sob `/api` e passam pelo proxy do Core.

| Grupo | Rotas |
|---|---|
| Sessão | `GET /me`, `GET /postrun/library/groups`, `GET /postrun/library/samples`, `GET /health` |
| Leitura | `GET /postrun/jobs`, `GET /postrun/analyses`, `PUT /postrun/analyses/meta`, `GET /postrun/analyses/detail`, `POST /postrun/analyses/batch`, `POST /postrun/analyses/sparklines`, `POST/GET /postrun/scan`, `GET /postrun/standards` |
| Regiões | `GET/POST/DELETE /postrun/regions`, `PATCH/DELETE /postrun/regions/{id}`, `POST /postrun/regions/preview`, `PUT /postrun/regions/save`, `POST /postrun/regions/apply` |
| Calibração STD | `GET /postrun/calibration/candidate`, `POST/GET /postrun/calibration`, `PATCH /postrun/calibration/{id}` |
| Curvas | `POST /postrun/curves/preview`, `POST/GET /postrun/curves`, `GET/PUT/DELETE /postrun/curves/{id}`, `POST /postrun/curves/{id}/limits`, `POST /postrun/quantify` |
| Deconvolução | `POST /postrun/deconvolution/fit`, `GET /postrun/deconvolution`, `PUT /postrun/deconvolution/save`, `GET/POST /postrun/deconvolution/references`, `PUT …/references/{id}/runs`, `GET …/references/{id}/detail`, `DELETE …/references/{id}` |
| Fluxo em 4 passos | `GET/POST /postrun/workflow/status`, `POST /postrun/workflow/references`, `POST /postrun/workflow/fit`, `POST /postrun/workflow/curves` |
| Relatório | `POST /postrun/report/recovery`, `POST /postrun/report/recovery.xlsx` |
| Corridas | `GET /postrun/runs/reasons`, `POST/PUT /postrun/runs/records`, `POST /postrun/runs/exclude`, `POST /postrun/runs/restore`, `POST /postrun/runs/exclusions/log` |
| Estudos | `GET/POST /postrun/studies`, `GET/PUT/DELETE /postrun/studies/{id}`, `POST …/{id}/items`, `POST …/{id}/collect`, `POST …/{id}/report`, `GET …/{id}/export.xlsx`, `POST …/{id}/sensitivity` |
| Ferramentas | `GET/PUT …/{id}/validation/config`, `POST …/{id}/validation`, `POST …/{id}/validation/reveal`, `POST …/{id}/compare-models`, `POST …/{id}/interaction`, `POST …/{id}/template-robustness`, `POST …/{id}/identifiability`, `POST …/{id}/identifiability/bootstrap` |
| Quimiometria | `POST …/{id}/pca`, `POST …/{id}/pls`, `GET/PUT …/{id}/classes` |
| Renomear | `GET /postrun/analyses/rename-info`, `POST /postrun/analyses/rename`, `POST /postrun/analyses/move-batch`, `POST /postrun/analyses/change-sample` |
| Agente | `POST /agent/enroll-codes`, `GET /agent/devices`, `POST /agent/devices/{id}/revoke`, `POST /agent/enroll`, `GET /agent/tasks`, `POST /agent/tasks/{id}/result` |

---

## 24. Banco de dados

| Tabela | Guarda |
|---|---|
| `User` | id do Core + nome (para os `*_by_id`) |
| `PostrunRegion` | regiões salvas: análise, canal, faixa, linha de base, rótulo |
| `PostrunCalibration` | calibrações STD: K0, K1, R², padrão, nome, vigente, datas |
| `PostrunAnalysisMeta` | massa corrigida (e a original), composição informada, massas reais dos componentes |
| `PostrunCurve` | curvas de calibração: pontos, modelo, peso, ciclo, fonte da área, limites (F2) |
| `PostrunDeconvolution` | deconvolução salva por análise + canal + método: picos, parâmetros, covariância, R², BIC |
| `PostrunDeconvReference` | referências por material e ciclo: gaussiana média, molde, corridas usadas |
| `PostrunStudy` | estudos: itens, método oficial, situação, *snapshot*, papéis da validação, **classes** |
| `AnalysisRename` | histórico de renomeações e trocas de amostra (réplica no RE7S) |
| `PostrunRunRecord` | ficha da corrida: metadados e exclusão (motivo, comentário) |
| `PostrunExclusionLog` | histórico imutável de exclusões e restaurações |
| `PostrunB00Cache` | cache da leitura dos arquivos (leitura em segundo plano) |
| `AgentEnrollCode`, `AgentDevice`, `AgentTask` | Agente: códigos, instalações, tarefas |
| `PostrunFile`, `PostrunRun`, `PostrunTreatment`, `PostrunOutbox` | pacote comum do PostRun (cópia, ainda sem uso na tela) |

---

## 25. Testes

`backend/tests/`: 33 arquivos e **261 testes**, todos passando em
18/11/2026. Rodam com `python -m pytest -q`.

- **Arquivos sintéticos:** `b00_factory.py` gera arquivos com picos gaussianos e assimétricos, massa, ciclo e vários métodos.
- **Agente falso:** em memória, com `fnmatch`, para testar o modo Agente.
- **RE7S falso:** em memória (`re7s_link`).
- **Cobertura:** parser e métodos, base de tempo, integração, calibração, regressão e inversa, limites, composição, deconvolução (as três formas), fluxo em 4 passos, relatório, estudos, validação (ANOVA), comparador, interação, robustez, identificabilidade, quimiometria (PCA, PLS, VIP, CV, multibloco, classes, subconjuntos), exclusões, renomear/mover/trocar amostra, migração, colunas novas do banco e caracteres proibidos no nome.

---

## 26. Implantação

Guia completo em [`DEPLOY.md`](DEPLOY.md).

- **Docker Compose:** backend, frontend, Postgres e backup, atrás do Core em `/m/geohorun/`.
- **Variáveis do backend** (`backend/app/core/config.py`):
  - `MODULE_DATABASE_URL`;
  - `POSTRUN_AGENT_MODE=true`;
  - `RE7S_INTERNAL_URL`, `RE7S_INTERNAL_TOKEN`;
  - `POSTRUN_RESULTADOS_URL`, `POSTRUN_RESULTADOS_TOKEN`;
  - `GEOHORUN_BUILD`;
  - `GEOHORUN_ADMIN_MAX_LEVEL`.
- **Atualizar no servidor:** `git pull` e depois `docker compose up -d --build`, na pasta do GeoHorun. As colunas novas entram sozinhas (`_ensure_column`).

---

## 27. O que o GeoHorun ainda não faz

| Item | Situação |
|---|---|
| **Parâmetros do GeoWorks** (S1, S2, S3, Tmax corrigido, TOC, HI, OI, PI, MinC, enxofre…) | Fase 3. Precisa do livro do Rock-Eval: motor de fórmulas, motor de cursores, importar os métodos do GeoWorks instalado, diagramas HI×OI e HI×Tmax |
| F10: ajuste conjunto de várias rampas e canais | planejado; a PCA multibloco já junta os canais na exploração |
| F11: componente "matéria orgânica natural" (molde de brancos de solo/sedimento) | planejado |
| F12: pacote de dados aberto (Zenodo, Data in Brief) | planejado |
| PLS-DA (classificar pelas classes do estudo) | sugerido |
| Cinética (energias de ativação, Kissinger) com os `.M00` | planejado (Fase 5) |
| Envio direto ao Resultados (sem o Excel) | pacote copiado, não ligado |
| Conferir o LoQ com Romero-Sarmiento et al. (2025) | aberto |
| Medir o atraso do SO₂ com duas taxas de aquecimento | sugerido |
