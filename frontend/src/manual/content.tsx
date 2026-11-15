import type { ReactNode } from 'react'

/**
 * Conteúdo da aba "Manual" (Prompt_Horun_Modulo.md, seção 12) — separado do
 * layout (pages/ManualTab.tsx) para ser fácil de atualizar. Mudou uma tela,
 * atualize aqui no mesmo commit. Nomes de botões em negrito, exatamente como
 * aparecem na tela. Sem nomes de pessoas nem valores reais nos exemplos.
 * Veio do manual do RE7S (seção PostRun) quando o PostRun saiu de lá.
 */

export interface ManualSection {
  id: string
  title: string
  body: ReactNode
}

export const MANUAL_INTRO = (
  <p>
    Passo a passo do <strong>PostRun · GeoHorun</strong>: as curvas do Rock-Eval 7S lidas direto dos{' '}
    <code>.B00</code> — pirograma, integração, deconvolução, calibração, curvas de calibração, relatório de
    recuperação e estudos. Os parâmetros do GeoWorks (S1, S2, S3, Tmax, TOC, HI, OI…) ainda são calculados no
    software do fabricante; eles chegam ao GeoHorun numa próxima etapa.
  </p>
)

export const MANUAL_SECTIONS: ManualSection[] = [
  {
    id: 'analises',
    title: 'Abrir as análises de um job',
    body: (
      <ol>
        <li>
          Na aba <strong>Análises</strong>, escolha um job (use a busca para filtrar). As análises são lidas{' '}
          <strong>em segundo plano</strong>: a lista vai aparecendo enquanto o equipamento responde, e você já pode
          trabalhar nas que chegaram. <strong>Verificar novamente</strong> procura análises novas e lê as que faltaram
          (rede lenta, agente ocupado). <strong>Todos</strong> volta à lista de jobs.
        </li>
        <li>
          Marque as análises que quer abrir (a caixa do nome da amostra marca todas as réplicas). Use a busca, a{' '}
          <strong>Ordem</strong> e o filtro de <strong>Data</strong> para achar mais rápido. O ícone de olho riscado, que
          aparece ao passar o mouse na linha, só esconde a análise da lista; não apaga nada.
        </li>
        <li>
          As análises abertas aparecem no alto, em <strong>Workspace</strong> (amostra e réplica): toque numa para ela
          ser a ativa. Na lista, a barra azul marca as abertas e a laranja, a ativa.
        </li>
        <li>
          Lista <strong>Completa</strong> (miniatura da curva, método, data) ou <strong>Simples</strong> (uma linha por
          análise: nome e massa — o modo fica lembrado). A seta ao lado de cada amostra recolhe as réplicas dela;{' '}
          <strong>recolher</strong> e <strong>expandir</strong> fazem isso com todas.
        </li>
      </ol>
    ),
  },
  {
    id: 'graficos',
    title: 'Pirograma, Sobrepor e Multi',
    body: (
      <>
        <p>
          <strong>Pirograma</strong>: é o que abre ao marcar uma análise — tempo (s) × intensidade da análise ativa, sem
          região nem cursores. Escolha <strong>Pirólise</strong> ou <strong>Oxidação</strong> e o <strong>Canal</strong>{' '}
          (FID, CO, CO₂, SO₂). A caixa <strong>rampa de temperatura</strong> põe a temperatura × tempo no mesmo gráfico
          (eixo à direita).
        </p>
        <p>
          <strong>Sobrepor</strong>: todas as análises abertas no mesmo gráfico, no canal escolhido, sem integração. Eixo X
          em temperatura ou tempo; escala em sinal bruto, por mg de amostra ou pela altura (máx. = 1); linha de base
          descontada (opcional). <strong>Cor por amostra</strong>: uma cor por amostra e as réplicas com traços
          diferentes; <strong>por réplica</strong>: uma cor para cada análise. Clique no quadradinho de cor para escolher
          outra (fica guardada neste navegador) e use as caixas para mostrar/ocultar amostras ou réplicas; passar o mouse
          destaca a curva e mostra o nome dela no alto do gráfico. <strong>Legenda no gráfico</strong> mostra só o que
          está marcado.
        </p>
        <p>
          <strong>Multi</strong>: todos os sinais da pirólise ou da oxidação no mesmo gráfico, cada um com a sua cor —
          azul FID, verde CO, vermelho CO₂, amarelo SO₂. Por padrão a análise ativa (ou todas as abertas, com traços
          diferentes); escala pela altura para comparar a forma, já que o FID é bem maior que os outros.
        </p>
      </>
    ),
  },
  {
    id: 'integrar',
    title: 'Integrar uma região e salvar',
    body: (
      <>
        <p>
          Toque em <strong>Integrar</strong>: aparecem os marcadores da região e as etapas, logo abaixo da curva —{' '}
          <strong>1 · Região</strong> (janela, baseline, aplicar às outras, resumo das regiões),{' '}
          <strong>2 · Deconvolução</strong> (picos e a tabela de gaussianas) e <strong>3 · Calibração do canal</strong>.{' '}
          <strong>Fechar integração</strong> volta ao pirograma.
        </p>
        <ol>
          <li>
            Para medir uma área, arraste os marcadores sobre a curva ou digite <strong>Início (idx)</strong> e{' '}
            <strong>Fim (idx)</strong>, escolha a <strong>Baseline</strong> (sem nada marcado, a sugestão é o cursor do
            GeoWorks — toque em <strong>Usar esta região</strong>). <strong>Aplicar a todas as abertas</strong> (ou{' '}
            <strong>às marcadas</strong>) copia a mesma região — faixa, rótulo e baseline — para as outras análises.
          </li>
          <li>
            <strong>Nada é gravado até você tocar em Salvar</strong> (no alto, ao lado das abas — a bolinha fica laranja
            quando há alterações pendentes). Até lá, as regiões aparecem como <em>não salvo</em>, com a área já calculada;{' '}
            <strong>Desfazer alterações</strong> volta ao que estava salvo e <strong>Remover região</strong> só apaga ao
            salvar. Fechar a página com alterações pendentes pede confirmação.
          </li>
          <li>
            O <strong>Resumo das regiões</strong> lista áreas, picos, valores calibrados e a situação (salvo / não salvo);{' '}
            <strong>Exportar CSV</strong> baixa a tabela.
          </li>
        </ol>
      </>
    ),
  },
  {
    id: 'massa',
    title: 'Corrigir a massa de uma corrida',
    body: (
      <p>
        Na lista de análises (e na tabela da aba Referências), clique na massa, digite o valor em mg e Enter. Grava na
        hora e vale para curvas, quantificação e recuperação; a massa corrigida aparece com ✎. A massa é gravada também
        no próprio <strong>.B00</strong> (linha Quant=, e no .B00~) — o GeoWorks passa a ver a mesma massa — e a massa
        original fica guardada: apagar o valor e dar Enter grava de volta a original. Se o arquivo não puder ser gravado
        (Agente do equipamento só leitura ou fora do ar), a correção vale no Horun e aparece "⚠ só no Horun"; ao
        verificar as análises de novo, o .B00 é atualizado sozinho.
      </p>
    ),
  },
  {
    id: 'calibracao',
    title: 'Calibração do FID com o padrão',
    body: (
      <>
        <p>
          A aba <strong>Calibração</strong> faz a calibração do FID com as corridas do job de padrões (
          <strong>STD</strong>) e, se quiser, as de outro job. Escolha a corrida, o padrão certificado, confira a prévia
          (área, S2 conhecido, Tmax) e toque em <strong>Aceitar calibração</strong>. O painel de calibração da etapa 3 da
          integração também mostra as corridas do job STD.
        </p>
        <p>
          Dê um <strong>nome</strong> à calibração ao aceitá-la (ex.: "IFP160000 — agosto/2026"; o GeoHorun sugere padrão
          + mês da corrida) e, se quiser, uma observação. No histórico aparecem o nome (✎ para renomear), a{' '}
          <strong>data em que o padrão foi rodado</strong> e quando foi validada. Para guardar uma calibração antiga sem
          trocar a atual, desmarque <strong>tornar esta a calibração vigente</strong>; depois,{' '}
          <strong>tornar vigente</strong> no histórico escolhe qual vale para os valores em mg.
        </p>
      </>
    ),
  },
  {
    id: 'curvas',
    title: 'Curvas de calibração (massa × área) e quantificação',
    body: (
      <>
        <p>
          Na aba <strong>Curvas</strong>, cada ponto é uma análise com a sua região do FID. A área é no{' '}
          <strong>tempo</strong> (sinal × s — o Rock-Eval grava 1 ponto por segundo, conferido pela rampa do ciclo de
          cada arquivo), e a massa pode ser a <strong>da amostra</strong> ou a de <strong>um componente</strong> (massa ×
          fração da composição). Uma curva vale para <strong>um ciclo</strong>: pontos de ciclos diferentes são recusados.
        </p>
        <ol>
          <li>
            Na aba Análises, marque as corridas (ex.: a série de um polímero puro), ajuste a região, toque em Aplicar a
            todas e em Salvar.
          </li>
          <li>
            Em Curvas, toque em <strong>Usar as regiões das análises abertas</strong>. Escolha o modelo (reta, reta pela
            origem ou quadrática) e o peso (1/m² é o recomendado quando as massas vão de 0,1 a 4 mg). Desmarque um ponto
            para tirá-lo do ajuste.
          </li>
          <li>
            Confira os três gráficos: <strong>área × massa</strong> (com LD e LQ), <strong>área ÷ mg</strong> (deve ser
            constante — tendência indica saturação ou perda) e os <strong>resíduos</strong>. Nos gráficos,{' '}
            <strong>clique</strong> num ponto para tirá-lo do ajuste (fica vazado) ou devolvê-lo,{' '}
            <strong>arraste</strong> um retângulo para tirar vários (Shift + arrastar devolve) e passe o mouse para ver
            amostra, massa, área e resíduo; a curva ajustada é a linha pontilhada. Os resíduos podem ser vistos em{' '}
            <strong>% do previsto</strong> (padrão — com peso 1/m² é o que o ajuste minimiza; devem se espalhar por igual
            em torno de zero, faixa = ± 2 × a dispersão) ou em sinal·s. Dê um nome e toque em{' '}
            <strong>Salvar curva</strong>.
          </li>
          <li>
            Massa zero no arquivo ou mistura sem proporção no nome: corrija na tabela de pontos (massa e composição, ex.:
            "PP 50, PS 50") e toque em <strong>Salvar correções</strong>. A composição é lida do nome quando ele diz
            (PEAD_PP_PS_50-25-25, "PE + PS (50-50)", PS_040 = PS puro, 4,0 mg nominais).
          </li>
        </ol>
        <p>
          <strong>Quantificar</strong>: no Resumo das regiões, escolha a curva em <strong>Quantificar com</strong> e toque
          em <strong>Calcular massas</strong>. Sai a massa pela curva ± incerteza (95 %), a massa esperada (pesada, ou a do
          componente pela composição) e a <strong>recuperação %</strong>, com aviso quando a área cai fora da faixa da
          curva ou abaixo do LD/LQ. O Exportar CSV leva essas colunas.
        </p>
      </>
    ),
  },
  {
    id: 'limites',
    title: 'Brancos de matriz e limites (LoB, LoD, LoQ em mg e ppm)',
    body: (
      <>
        <p>
          Abra uma curva salva na aba <strong>Curvas</strong>: embaixo aparece o cartão{' '}
          <strong>Brancos de matriz e limites</strong>. Antes, na aba Análises, abra as corridas de{' '}
          <strong>branco da matriz</strong> (sílica sem polímero, mesmo ciclo da curva — o recomendado é 10 ou mais) e, se
          tiver, as réplicas de uma amostra de <strong>baixa concentração</strong>.
        </p>
        <ol>
          <li>
            No cartão, marque o papel de cada análise aberta: <strong>branco</strong>, <strong>nível baixo</strong> ou{' '}
            <strong>fora</strong>. Corridas com "branco", "sílica" ou "SiO2" no nome já vêm como branco.
          </li>
          <li>
            Informe a <strong>massa de matriz por cadinho</strong> (mg) — vazio usa a média das massas dos brancos. O
            intervalo de integração vem da curva (pode mudar).
          </li>
          <li>
            <strong>Calcular limites</strong>: cada corrida é integrada no intervalo e convertida em massa aparente pela
            própria curva. O resultado fica guardado na curva.
          </li>
        </ol>
        <p>Os limites, em mg e em ppm (µg/g de matriz = mg ÷ mg de matriz × 10⁶), com o critério escrito ao lado:</p>
        <ul>
          <li>
            <strong>LoB</strong> = média dos brancos + 1,645 × desvio dos brancos (Armbruster &amp; Pry);
          </li>
          <li>
            <strong>LoD</strong> = LoB + 1,645 × desvio das réplicas de nível baixo (sem elas, o desvio dos brancos — aviso);
          </li>
          <li>
            <strong>LoQ</strong> = média dos brancos + 10 × desvio dos brancos;
          </li>
          <li>
            <strong>LD / LQ da curva</strong> = 3,3·σ₀/b e 10·σ₀/b, com σ₀ e a inclinação b da própria curva (na reta pela
            origem, σ₀ vem das réplicas do menor nível — são precisas pelo menos 2).
          </li>
        </ul>
        <p>Com menos de 10 brancos aparece um aviso: o desvio do branco, e com ele os limites, fica pouco confiável.</p>
      </>
    ),
  },
  {
    id: 'deconvolucao',
    title: 'Deconvolução: referências, moldes e misturas',
    body: (
      <>
        <p>
          <strong>Aba Deconvolução (o caminho recomendado)</strong>: abra na aba Análises os puros de cada material e as
          misturas, com a região de cada uma salva, e siga os 4 passos — <strong>1</strong> referências e moldes dos puros
          (criadas ou refeitas; as corridas que você tirou de uma referência continuam fora), <strong>2</strong> ajustar e
          salvar puros e misturas no método escolhido (<strong>Molde</strong> ou <strong>Gaussiana guiada</strong>),{' '}
          <strong>3</strong> curvas de calibração automáticas por material (só com os puros, no mesmo método) e{' '}
          <strong>4</strong> a recuperação. Gaussiana e molde ficam salvos lado a lado: trocar o método mostra o outro sem
          apagar nada — é assim que se comparam os dois. O relatório (aba Relatório) também tem a escolha do método.
        </p>
        <p>
          <strong>Puros só uma vez por ciclo.</strong> Os passos 1 e 3 só <strong>criam</strong> referências e curvas a
          partir dos puros abertos — por isso, sem puros abertos, os botões deles ficam desligados. Depois de criadas,
          elas ficam salvas: para quantificar misturas novas, abra só as misturas e rode os passos <strong>2</strong> e{' '}
          <strong>4</strong>. Os passos 1 e 3 mostram quais referências e curvas já salvas serão usadas (✓) e o que falta
          (✗ — aí sim abra os puros daquele material). Abrir os puros de novo só é preciso para refazer moldes ou curvas.
          A recuperação dos próprios puros (100 %) é circular — são as corridas da curva — e não valida o método.
        </p>
        <p>
          <strong>Deconvolução de uma corrida (picos = amostras virtuais)</strong>: na etapa{' '}
          <strong>2 · Deconvolução</strong> da integração, o sinal da região é dividido em picos —{' '}
          <strong>gaussiana</strong> ou <strong>gaussiana assimétrica</strong> (larguras diferentes de cada lado; PP e PEAD
          têm cauda para o lado frio). As curvas de cada pico e a soma aparecem sobre o sinal, com o gráfico de resíduos.
          Nada é gravado até o <strong>Salvar</strong>.
        </p>
        <ol>
          <li>
            <strong>Referência do material puro</strong>: abra as corridas do puro, modo <strong>Livre</strong>, 1 pico,
            nome "PS", <strong>Ajustar todas as abertas</strong>, Salvar. Na aba <strong>Referências</strong>, digite PS (o
            mesmo nome do pico) e toque em <strong>Criar</strong> (centro e largura médios, com o desvio entre as corridas,
            e o molde). A aba mostra o <strong>molde</strong> com cada corrida sobreposta (área 1, alinhadas pelo máximo) e
            a faixa ± desvio; a tabela dá, por corrida, Tmax, largura, a <strong>dilatação</strong> (largura ÷ largura do
            molde) e o quanto a forma foge do molde, com ⚠ nas que destoam. "Comparar" sobrepõe os moldes de vários
            materiais — moldes que quase se cobrem não se separam numa mistura.
          </li>
          <li>
            <strong>Curva da gaussiana</strong>: com as mesmas corridas abertas, aba Curvas,{' '}
            <strong>Área de: Gaussiana</strong>, componente PS, <strong>Usar as gaussianas salvas</strong>, Salvar curva.
          </li>
          <li>
            <strong>Misturas</strong>: abra as réplicas, modo <strong>Guiada por referências</strong> (as referências saem
            da composição de cada análise), tolerância do centro (± °C) e da largura (± %), Ajustar todas, Salvar. O pico
            fica livre dentro da tolerância: o deslocamento aparece como <strong>ΔTmax</strong> e{' '}
            <strong>Δlargura</strong>; ⚠ = pico no limite da tolerância (aumente-a) ou picos sobrepostos demais (a divisão
            da área entre eles é incerta).
          </li>
          <li>
            <strong>Molde do material puro</strong> (recomendado para misturas): em vez de gaussianas, cada componente é a{' '}
            <strong>curva média do puro</strong> (guardada ao criar a referência), e o ajuste só solta a área, a posição (±
            °C) e a dilatação no tempo (± %) — esticar ou encolher o molde mantendo a área. Os ± são limites, não o valor: o
            ajuste escolhe o melhor dentro deles. Use como guia a "dilatação natural" da aba Referências (a sugestão é o
            dobro dela); limite largo demais deixa um material "engolir" o sinal do vizinho. A forma real, com as caudas,
            entra exata. A dilatação aparece como Δlargura (ex.: +22 % = pico 22 % mais largo que no puro).{' '}
            <strong>Regra:</strong> a curva de calibração tem de usar o mesmo tipo de área — ajuste também os puros no modo
            Molde, salve e crie a curva de gaussiana com eles. Para <strong>ver a dilatação</strong>: no gráfico da corrida,
            o molde do puro de cada componente aparece pontilhado (mesma área) por cima do componente ajustado; a tabela
            mostra a largura à meia altura "puro → mistura" em °C; e o gráfico <strong>Forma</strong> põe os dois
            divididos pela própria altura e centrados no próprio máximo — sobra só a mudança de forma.
          </li>
          <li>
            Na tabela <strong>Gaussianas (amostras virtuais)</strong>, <strong>Quantificar gaussianas</strong> usa a curva
            de gaussiana de cada material: massa ± incerteza, massa esperada (fração × massa pesada) e{' '}
            <strong>recuperação %</strong> — a medida da interferência na pirólise. Exportar CSV leva tudo.
          </li>
        </ol>
      </>
    ),
  },
  {
    id: 'relatorio',
    title: 'Relatório de recuperação',
    body: (
      <>
      <p>
        Com as análises abertas (puros e misturas, deconvoluções salvas), a aba <strong>Relatório</strong> agrupa as
        réplicas por composição e mostra, para cada componente, a média ± desvio da massa encontrada, da{' '}
        <strong>recuperação %</strong>, do <strong>ΔTmax</strong> e da <strong>Δlargura</strong>, mais a recuperação total
        da mistura e o pior R². Cada componente usa a curva de gaussiana mais recente do mesmo ciclo — ou a que você
        escolher na caixa "Curva de …". Os gráficos mostram recuperação × fração, ΔTmax × fração e Δlargura × fração — com
        a faixa da dilatação natural dos puros (média ± 2 desvios); ponto vazado = no limite da tolerância. A sub-aba{' '}
        <strong>Réplicas</strong> mostra cada réplica, com uma caixa de <strong>massa real</strong> (mg) para cada
        polímero: a esperada passa a ser a massa pesada em vez de fração nominal × massa. Para muitas réplicas,{' '}
        <strong>Baixar modelo (.csv)</strong> traz uma linha por réplica e uma coluna por polímero; preencha no Excel,
        copie com o cabeçalho e use <strong>Colar do Excel</strong> — as caixas são preenchidas para conferir antes de
        salvar. <strong>Baixar Excel</strong> gera a planilha com as abas Resumo, Corridas, Curvas, Referências,
        Deconvoluções e o que ficou de fora. No topo, a <strong>recuperação</strong> aparece em destaque: um cartão por
        composição (verde até ±5 % de 100, âmbar até ±10 %, vermelho além) e as barras com o desvio, a faixa 95–105 % e a
        linha dos 100 %.
      </p>
      <p>
        <strong>Os três números de recuperação</strong> (em cada cartão, na tabela e na lista de Estudos), sempre com média
        ± desvio e o <strong>n de réplicas válidas</strong> ("n=3 de 4" quando uma réplica não entrou — por exemplo, um
        componente sem curva):
      </p>
      <ul>
        <li>
          <strong>de cada componente</strong> — massa encontrada pela curva ÷ massa esperada daquele componente;
        </li>
        <li>
          <strong>PEAD + PP</strong> (poliolefinas somadas), quando a mistura tem duas ou mais — os picos delas se sobrepõem
          na pirólise, então a divisão da área entre elas é incerta, mas a soma não; é o número a reportar quando as
          recuperações separadas se compensam (uma alta, outra baixa);
        </li>
        <li>
          <strong>total</strong> — soma das massas encontradas ÷ massa pesada da corrida (ou soma das massas reais dos
          componentes, quando informadas).
        </li>
      </ul>
      </>
    ),
  },
  {
    id: 'estudos',
    title: 'Estudos',
    body: (
      <p>
        Guardam num lugar só tudo de um estudo — as análises (puros e misturas), as referências e moldes, as curvas de
        calibração e as calibrações STD (as deconvoluções vêm junto com as análises). Na aba <strong>Estudos</strong>,
        crie o estudo, abra as análises na aba Análises e use <strong>Guardar workspace no estudo</strong>: entram as
        análises abertas e as referências, moldes e curvas que elas usam. Nas abas Deconvolução, Curvas e Relatório, a
        barra <strong>Estudo</strong> abre tudo o que ele guarda de uma vez, como um job (as análises podem ser de jobs
        diferentes). Ao terminar, <strong>Finalizar estudo</strong> congela o relatório dos dois métodos e tira as
        referências e curvas dele das listas gerais — continuam guardadas no estudo, e dá para reabrir. Uma curva ou
        referência que está num estudo não pode ser apagada (tire-a do estudo antes). Apagar o estudo apaga só o
        "envelope". O cartão <strong>Tolerância ótima de dilatação</strong> reajusta só as misturas (molde) em várias
        tolerâncias de largura, sem gravar nada, e traça o RMSE da recuperação × a tolerância: a ótima é a menor tolerância
        no mínimo da curva. <strong>Exportar Excel completo</strong> leva tudo; a aba <em>Horun_Resultados</em> é a que o
        módulo Resultados importa.
      </p>
    ),
  },
  {
    id: 'validacao',
    title: 'Validação independente (calibração × validação, modo cego)',
    body: (
      <>
        <p>
          No detalhe de um estudo (aba <strong>Estudos</strong>), o cartão <strong>Validação independente</strong>:
        </p>
        <ol>
          <li>
            Em <strong>Papel de cada análise</strong>, marque as corridas de <strong>calibração</strong> (as das curvas) e as
            de <strong>validação</strong> (independentes: nunca usadas nas curvas) e toque em <strong>Guardar papéis</strong>.
            Cada corrida tem um papel só; se uma de validação for ponto de uma curva usada, ela sai das métricas, com o motivo.
          </li>
          <li>
            <strong>Modo cego</strong> (opcional): até revelar, as corridas de validação aparecem só como V01, V02… com a massa{' '}
            <strong>encontrada</strong> — o nome do arquivo, a composição (proporções), a massa adicionada e a recuperação
            ficam escondidos. Quais materiais há em cada corrida não dá para esconder: a deconvolução guiada precisa disso.
          </li>
          <li>
            <strong>Quantificar a validação</strong> usa as curvas do estudo (no método escolhido no alto do cartão de
            recuperação).
          </li>
          <li>
            <strong>Revelar as respostas…</strong> (modo cego): as massas encontradas naquele momento ficam guardadas como a
            resposta cega, e o conjunto de validação fica travado. Se depois uma deconvolução ou curva for refeita e a massa
            mudar, a corrida aparece marcada "mudou depois da revelação".
          </li>
        </ol>
        <p>Por material:</p>
        <ul>
          <li>
            <strong>Recuperação</strong> média ± desvio, <strong>viés</strong> (encontrada − adicionada, em mg e %) e{' '}
            <strong>RMSEP</strong> (raiz da média dos erros ao quadrado, mg);
          </li>
          <li>
            <strong>precisão intermediária</strong> pela ANOVA de um fator com o <strong>dia</strong> (data da corrida) como
            fator, sobre a recuperação: s_r (dentro do dia), s_entre dias e s_PI = √(s_r² + s_entre²) — precisa de pelo menos 2
            dias e réplicas dentro do dia;
          </li>
          <li>
            a regressão <strong>encontrada = a + b × adicionada</strong> (precisa de 3 ou mais massas diferentes) e o gráfico
            com a reta 1:1 (tracejada), a regressão de cada material, as barras de U95 e a faixa do U95 relativo médio.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'renomear',
    title: 'Renomear, mover e trocar a amostra (coordenação)',
    body: (
      <>
        <p>
          Só a coordenação (níveis 1 e 2 do Horun). O RE7S fica sabendo de cada renomeação: o Histórico e a Biblioteca de
          lá mostram o nome atual, e um nome usado aqui não pode ser cadastrado de novo no carrossel.
        </p>
        <p>
          <strong>Renomear ou trocar de job</strong>: passe o mouse na análise e toque no lápis. Uma análise que ainda está
          no carrossel sem ter sido confirmada como analisada não pode ser renomeada (o equipamento pode estar gravando o
          arquivo).
        </p>
        <p>
          <strong>Mover várias de uma vez</strong>: marque as análises e toque em <strong>Mover para outro job…</strong>.
          Escolha ou digite o <strong>Job de destino</strong>: a janela confere cada análise antes e mostra o que vai
          acontecer com cada uma. Se alguma não puder ir (ainda no carrossel, nome já existente no destino…), só ela fica
          para trás, com o motivo; as outras são movidas.
        </p>
        <p>
          <strong>Trocar amostra…</strong> — quando a amostra errada da biblioteca foi escolhida no cadastro e o{' '}
          <code>.B00</code> saiu com o nome errado: marque as análises, filtre por <strong>grupo</strong> e{' '}
          <strong>subgrupo</strong> (ou busque) e escolha a amostra certa. A janela mostra, para cada análise, o{' '}
          <code>Sample=</code> gravado no arquivo e o nome novo: o código no meio do nome muda; data, extra e réplica
          ficam. Ao confirmar, o nome da amostra muda <strong>dentro</strong> do <code>.B00</code> (e do{' '}
          <code>.B00~</code>) e o arquivo é renomeado; regiões, deconvoluções e curvas acompanham. O Agente do equipamento
          precisa poder escrever na RE7raw-data (pasta <code>jobs</code> com{' '}
          <code>&quot;mode&quot;: &quot;read-write&quot;</code> no <code>config.json</code>).
        </p>
      </>
    ),
  },
  {
    id: 'agente',
    title: 'Agente do PC do Rock-Eval (coordenação)',
    body: (
      <p>
        Os <code>.B00</code> e o <code>standard.ini</code> são lidos pelo Agente Horun instalado no PC do equipamento —
        o mesmo que atende o RE7S, com um bloco próprio do GeoHorun no <code>config.json</code>. O botão{' '}
        <strong>Agente</strong> no cabeçalho gera o <strong>código de instalação</strong> (uso único) e mostra as
        instalações: <strong>conectado</strong>, <strong>sem sinal</strong> ou revogado, com a versão e a hora em que foi
        visto por último. Lista de análises que não aparece ou "Verificar novamente" que não termina costumam ser o Agente
        sem sinal.
      </p>
    ),
  },
]
