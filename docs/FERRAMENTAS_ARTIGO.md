# PostRun · GeoHorun — ferramentas novas para o artigo

Especificação de 13/11/2026 (do mantenedor). Cada ferramenta corresponde a uma
lacuna do "Plano do artigo — JAAP".

## Prioridade 1: essenciais para a submissão

### F1. Recuperação por componente e total (correção)
- **Problema:** hoje a lista de projetos mostra um único % por composição, sem dizer o que ele mede.
- **O que fazer:** mostrar lado a lado a recuperação de cada componente, a recuperação total (soma das massas encontradas ÷ massa pesada) e, quando houver PEAD + PP, a recuperação das poliolefinas somadas.
- **Saída:** média ± DP por composição, com o n de réplicas válidas.

### F2. Brancos de matriz e limites em ppm
- **Entrada:** corridas de branco da matriz (sílica) e a massa de matriz por cadinho.
- **Cálculos:** LOB, LOD e LOQ (Armbruster & Pry, como no PMP-009); 3,3σ₀/b e 10σ₀/b (a partir da curva).
- **Saída:** limites em mg e em ppm (µg/g), com o critério usado indicado.
- **Lembrete:** alertar quando houver menos de 10 brancos.

### F3. Módulo de validação
- **Separação dos dados:** marcar cada corrida como calibração ou validação, sem que uma mesma corrida apareça nos dois conjuntos.
- **Modo cego:** esconder a composição tirada do nome até a quantificação; ela é revelada depois.
- **Métricas:** RMSEP, viés, recuperação média ± DP e precisão intermediária, separando a variância entre dias da variância dentro do dia (ANOVA de um fator).
- **Gráfico:** massa encontrada × massa adicionada, com a reta 1:1, a regressão e a banda de U₉₅ (Fig. 3 do artigo).

### F4. Rastreabilidade e exclusões
- **Exclusões:** excluir uma corrida exige um motivo de uma lista (corrida falha, massa ausente, troca de nome suspeita, outro) e um comentário.
- **Metadados por corrida:** massa de matriz, lote ou fabricante do polímero, granulometria, data e operador.
- **Relatório do projeto:** versão do Horun, parâmetros do ajuste (limites, janela, pontos de partida), lista de exclusões e checksum dos .B00.

### F5. Exportação para publicação
- **Figuras:** PDF/SVG vetorial ou PNG a 300 dpi ou mais, no mínimo 1063 px (uma coluna) e 2244 px (página inteira) — exigência da JAAP.
- **Estilo:** paleta fixa por polímero em todas as figuras, segura para daltônicos, eixos rotulados.
- **Tabelas:** XLSX/CSV editáveis, sem formatação visual.

## Prioridade 2: fortalecem o artigo

### F6. Comparador de modelos
- Roda nos mesmos dados: molde, molde sem deformação do tempo (CLS puro), gaussiana guiada, bigaussiana e soma ponderada no estilo do PMP-008.
- **Saída:** recuperação, RMSEP e BIC por modelo (Fig. 4).
- **Ablação:** desligar a deformação por partes (fixar c, fixar s, fixar os dois).

### F7. Painel de interação na co-pirólise
- ΔTmax e Δlargura em função da fração de cada componente (Fig. 5).
- **Curva de diferença:** medido menos a soma ponderada dos moldes sem deformação (análoga ao ΔM do PMP-008).
- **Alerta:** parâmetro no limite (ex.: +40 % do PEAD com PS).

### F8. Robustez dos moldes
- Leave-one-run-out no molde e nova quantificação.
- Comparação de moldes de lotes/grades/granulometrias (correlação, distância L2, efeito na recuperação).
- Incerteza combinada com um termo do molde.

### F9. Diagnóstico de identificabilidade
- Matriz de correlação das áreas, aviso com |ρ| > 0,9 (já existe).
- Bootstrap de resíduos.
- Reportar a soma (PEAD + PP) quando mal condicionado.

## Prioridade 3: diferenciais e trabalho futuro

### F10. Ajuste conjunto de várias rampas e canais (áreas compartilhadas, deslocamento por rampa; CO e CO₂ da pirólise).
### F11. Componente "matéria orgânica natural" (molde de brancos de solo/sedimento; subtração de branco).
### F12. Pacote de dados aberto (.B00, metadados, parâmetros, resultados, versão do código — Zenodo, Data in Brief, MethodsX).

| Lacuna do plano | Ferramenta |
|---|---|
| LD/LQ em ppm | F2 |
| Validação independente e precisão intermediária | F3 |
| Pendências de recuperação e exclusões | F1, F4 |
| Figuras com a resolução da JAAP | F5 |
| Comparação de modelos | F6 |
| Co-pirólise × PMP-008 | F7 |
| Robustez do molde | F8, F9 |
| PEAD/PP, PET/PVC, solo real | F10, F11 |
| Código e dados abertos | F12 |
