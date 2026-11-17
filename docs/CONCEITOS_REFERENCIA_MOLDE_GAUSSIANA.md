# Referência, molde, gaussiana e ajustes — o que é cada coisa no GeoHorun

> Roteiro para virar apresentação: cada bloco separado por `---` é um slide.
> **Título**, até 5 tópicos curtos, **Visual sugerido** (o desenho do slide) e
> **Fala** (notas do apresentador). Exemplo usado: PEAD (pico em ~513 °C) e PS
> (~434 °C), mas tudo vale para qualquer material.

---

## 1. O problema em uma frase

- O Rock-Eval queima a amostra e o detector (FID) registra um **sinal ao longo da temperatura** — o pirograma.
- Um polímero puro dá **um pico**. Uma mistura dá **picos somados**, muitas vezes sobrepostos.
- Queremos saber: **quantos mg de cada material** há na mistura.

**Visual sugerido:** dois gráficos lado a lado. Esquerda: um pico só (PS puro). Direita: um sinal com dois picos encostados (PEAD + PS), com a pergunta "quanto é de cada um?".

**Fala:** tudo o que o GeoHorun faz é responder a essa pergunta, em etapas.

---

## 2. O caminho inteiro (visão geral)

1. **Região** — o trecho do sinal que interessa e a linha de base.
2. **Referência** — como é o pico de cada material **puro**.
3. **Ajuste (deconvolução)** — separa a área da mistura entre os materiais, usando as referências.
4. **Curva de calibração** — converte área em massa (mg).
5. **Recuperação** — compara a massa encontrada com a pesada.

**Visual sugerido:** fluxograma horizontal com 5 caixas e setas:
`Região → Referência → Ajuste → Curva → Massa / Recuperação`.
Embaixo das caixas 2 e 4, uma etiqueta: "feitas com as corridas PURAS". Embaixo da 3 e da 5: "aplicadas às MISTURAS".

**Fala:** os puros ensinam (forma do pico e área por mg); as misturas são medidas com o que os puros ensinaram.

---

## 3. Corridas puras × misturas

- **Pura**: só um material (ex.: PS_1, PEAD_040). Servem para **aprender**: a forma do pico e quanta área dá cada mg.
- **Mistura**: dois ou mais materiais (ex.: PEAD_PS_75-25). São o que se quer **quantificar**.
- A **composição** (o que tem e em que proporção) vem do nome do arquivo ou é informada na tela.

**Visual sugerido:** duas colunas — "Puras (professores)" com 3 picos isolados; "Misturas (alunos)" com sinais compostos.

**Fala:** sem puras não há referência nem curva; sem misturas não há o que quantificar.

---

## 4. Referência = o retrato do pico do material puro

- É feita com **várias corridas puras** do mesmo material (ex.: PEAD, 16 corridas).
- Diz **onde** o pico sai (centro, em °C) e **com que forma** (largura, caudas).
- Guarda **duas descrições do mesmo pico**, feitas juntas, das mesmas corridas:
  - a **gaussiana de referência**;
  - o **molde**.
- Vale para um **ciclo** de forno (o mesmo programa de temperatura).

**Visual sugerido:** um "cartão de identidade" do PEAD: foto = o pico; campos = centro 513 °C, largura, nº de corridas = 16; dois carimbos no cartão: "gaussiana ✓" e "molde ✓".

**Fala:** a referência não diz massa nenhuma — diz só como o pico do material se parece.

---

## 5. A gaussiana de referência — o desenho idealizado

- Cada corrida pura é ajustada com **um sino matemático** (gaussiana **assimétrica**: largura própria à esquerda e à direita).
- A referência guarda a **média**: centro (°C), largura esquerda, largura direita.
- **Vantagem:** poucos números, forma lisa, fácil de mover e esticar.
- **Limite:** a forma real nem sempre é um sino — as **caudas** ficam de fora.
- O GeoHorun mostra quanto: "**forma que a gaussiana não descreve: X %**".

**Visual sugerido:** um sino tracejado sobre o sinal real de uma corrida pura; destacar em cor a área da cauda que o sino não cobre.

**Fala:** é um retrato falado — parecido, mas desenhado.

---

## 6. O molde — a forma real, em média

- Pega o **sinal de verdade** de cada corrida pura.
- Divide cada uma pela **própria área** (todas ficam com área 1) e alinha pelo **máximo**.
- O molde é a **média** dessas curvas (com a faixa ± 1 desvio entre as corridas).
- **Vantagem:** tem a forma real, com as caudas.
- **Limite:** precisa de boas corridas puras; uma corrida ruim deforma o molde (dá para tirá-la).

**Visual sugerido:** 5 curvas finas cinza sobrepostas (as corridas, todas com área 1) e uma curva grossa colorida no meio (o molde), com uma faixa clara em volta.

**Fala:** é uma fotografia média — a forma de verdade, não um desenho.

---

## 7. Gaussiana × molde, lado a lado

| | Gaussiana de referência | Molde |
|---|---|---|
| O que é | um sino matemático | a forma real média |
| Feita de | centro + larguras médios | o sinal das corridas, área 1 |
| Caudas | não descreve | descreve |
| Usada pelo método | **Gaussiana guiada** | **Molde** |
| Analogia | retrato falado | fotografia / carimbo |

**Visual sugerido:** o gráfico da referência do GeoHorun — molde em linha cheia, gaussiana tracejada por cima. Uma seta apontando onde as duas se separam.

**Fala:** as duas estão sempre guardadas na mesma referência; o **método** escolhido decide qual se usa.

---

## 8. Dilatação natural

- Mesmo puras, as corridas não são idênticas: o pico de uma pode sair um pouco **mais largo** que o de outra.
- **Dilatação** = largura da corrida ÷ largura do molde (× 1,05 = 5 % mais largo).
- A "dilatação natural" mostra quanto os **puros** variam entre si.
- Ela orienta a **tolerância** do ajuste: um bom ponto de partida é o dobro dela.

**Visual sugerido:** três picos do mesmo material, um estreito, um médio, um largo, com a régua "× 0,97 · × 1,00 · × 1,03".

**Fala:** se os próprios puros variam 3 %, não dá para exigir que a mistura varie menos que isso.

---

## 9. O ajuste (deconvolução) — a ideia

- O sinal da mistura é visto como **uma soma de picos**, um por material.
- Cada pico = **área** × **forma** (a forma vem da referência).
- O programa procura as **áreas** (e pequenos ajustes de posição e largura, dentro dos limites) que fazem a soma **coincidir** com o sinal medido.
- "Coincidir" = a menor diferença possível ponto a ponto (mínimos quadrados).
- Saídas: a **área de cada material**, o R² e o **resíduo** (o que sobrou).

**Visual sugerido:** o sinal da mistura (preto), os dois picos ajustados (azul = PEAD, verde = PS) e a soma tracejada sobre o preto; embaixo, uma faixa fina com o resíduo perto de zero.

**Fala:** é como montar o sinal com dois carimbos: o programa decide com quanta tinta (área) carimbar cada um.

---

## 10. Os três tipos de ajuste

| Ajuste | Forma do pico | Quando o GeoHorun usa |
|---|---|---|
| **Gaussiana livre** | sino solto, sem referência | nas corridas **puras**: é o que cria a gaussiana de referência e mede a área do puro no método Gaussiana |
| **Gaussiana guiada** | sino preso perto da gaussiana de referência | nas **misturas**, método Gaussiana |
| **Molde** | o molde do puro, com área livre | em puros e misturas, método Molde |

**Visual sugerido:** três mini-gráficos: (1) sino livre num pico isolado; (2) dois sinos com "cercas" marcando até onde podem se mover; (3) dois moldes encaixados no sinal.

**Fala:** "guiada" quer dizer: o sino não pode ir para qualquer lugar — fica perto do que a referência diz.

---

## 11. Tolerâncias — quanto o pico pode mudar na mistura

- Na mistura, um polímero pode **deslocar** e **alargar** um pouco (interação na pirólise).
- **Centro ± °C**: quanto o pico pode andar.
- **Largura (gaussiana) / dilatação (molde) ± %**: quanto pode alargar ou estreitar.
- O ajuste escolhe o melhor valor **dentro** dos limites; os limites não são o valor.
- Aviso "**no limite da tolerância**": o pico queria ir além — aumente o limite e ajuste de novo.
- O deslocamento aparece como **ΔTmax** e o alargamento como **Δlargura**.

**Visual sugerido:** um pico com duas "cercas" verticais (± °C) e uma seta horizontal de esticar (± %).

**Fala:** limites folgados demais deixam os picos trocarem de lugar; apertados demais forçam um ajuste ruim.

---

## 12. Curva de calibração — de área para massa

- Feita com as **corridas puras**: cada uma é um ponto (massa pesada × área do pico).
- Uma **reta** liga os pontos: área = a + b · massa.
- Na mistura, a área de cada material **vira massa** pela reta (com a incerteza U95).
- Peso 1/m² (recomendado): dá a mesma importância relativa a massas pequenas e grandes.
- **Automática** = criada pelo passo 3 da aba Deconvolução, uma por material e por método; refazer o passo atualiza a mesma curva.

**Visual sugerido:** gráfico de dispersão com 16 pontos (massa no X, área no Y) e a reta passando por eles; uma seta saindo de uma área no eixo Y, batendo na reta e descendo até a massa no eixo X.

**Fala:** é a balança do método: transforma "área do pico" em "mg".

---

## 13. Por que uma curva por método

- A **mesma** corrida pura dá áreas um pouco diferentes conforme o jeito de medir:
  - pela gaussiana, as caudas ficam de fora → área menor;
  - pelo molde, a forma real → área completa.
- Por isso a curva tem de ser feita **do mesmo jeito** que a área da mistura será medida.
- Molde com curva de molde; gaussiana com curva de gaussiana. O relatório escolhe sozinho.

**Visual sugerido:** o mesmo pico puro duas vezes: à esquerda pintado pelo molde (área inteira), à direita pelo sino (área sem as caudas); embaixo, duas retas de inclinações um pouco diferentes.

**Fala:** misturar os dois seria medir com uma régua e converter com a tabela de outra.

---

## 14. Referência × curva — não confundir

| | Referência | Curva de calibração |
|---|---|---|
| Pergunta | como é o pico? | quanta área por mg? |
| Serve para | **separar** a área da mistura | **converter** a área em massa |
| Por método? | não — guarda gaussiana **e** molde | sim — uma curva por método |
| Feita com | as corridas puras | as mesmas corridas puras, com a massa |

**Visual sugerido:** duas peças de quebra-cabeça que se encaixam: "Referência → separa" + "Curva → converte" = "massa de cada material".

**Fala:** a referência faz a divisão; a curva faz a conversão. As duas saem das corridas puras.

---

## 15. Recuperação — o método acertou?

- **Recuperação** de um material = massa encontrada ÷ massa esperada × 100.
- Massa esperada = massa da corrida × fração do material (ou a massa real pesada, se informada).
- **Total** = soma das massas encontradas ÷ massa pesada — uma média **pesada pela massa** de cada material.
- Exemplo (PEAD 75 %, PS 25 %): PEAD 97,1 %, PS 119,8 % → total ≈ 0,75 × 97,1 + 0,25 × 119,8 ≈ **102,8 %**.
- Verde até ± 5 %, âmbar até ± 10 %, vermelho além.

**Visual sugerido:** o cartão de recuperação do GeoHorun (dois números grandes e o total), com a conta escrita embaixo.

**Fala:** o PS errou mais, mas é só um quarto da massa — por isso pesa pouco no total.

---

## 16. Picos sobrepostos (ex.: PEAD e PP)

- Quando dois materiais têm picos quase no mesmo lugar e com a mesma forma, o ajuste **acerta o total**, mas não sabe **dividir** a área.
- Sintoma: um sai alto e o outro baixo, e a soma continua boa.
- Nesse caso, reporte a **soma do par** (ex.: "poliolefinas: PEAD + PP").
- A ferramenta **Picos sobrepostos** do estudo mostra quando isso acontece.

**Visual sugerido:** dois sinos quase em cima um do outro, com um ponto de interrogação entre eles; ao lado, uma caixa "soma = confiável".

**Fala:** não é falha do programa — a informação para separar simplesmente não está no sinal.

---

## 17. Os 4 passos da aba Deconvolução

1. **Referências** — das corridas puras abertas: cria/refaz a referência (gaussiana + molde) de cada material.
2. **Ajustar** — no método escolhido (Molde ou Gaussiana guiada): ajusta e salva puros e misturas.
3. **Curvas** — no mesmo método: uma curva por material, com os puros (as "automáticas").
4. **Recuperação** — quantifica as misturas e compara com o pesado.

Molde e Gaussiana ficam **salvos lado a lado**: trocar o método mostra o outro, sem apagar nada.

**Visual sugerido:** os 4 passos numerados na vertical, com uma chave "Molde | Gaussiana" ao lado dos passos 2, 3 e 4 (o passo 1 serve aos dois).

**Fala:** o passo 1 é comum; os passos 2 a 4 se repetem para cada método que se quer comparar.

---

## 18. Estudo — o envelope

- Guarda junto: análises, referências, curvas e calibrações.
- **Ativar** o estudo abre tudo o que ele guarda; nada é ativado sozinho.
- **Resultado oficial** = o método (Molde ou Gaussiana) que vale como resposta do estudo (o que o Resultados importa); o outro fica para comparação.
- **Ferramentas**: validação, réplicas, tolerância ótima, comparar modelos, interação, robustez, picos sobrepostos.
- **Finalizar** congela o relatório.

**Visual sugerido:** uma pasta aberta com quatro abas (Análises, Referências, Curvas, Calibrações) e um selo "resultado oficial: Molde".

**Fala:** o estudo não calcula nada novo — organiza e congela o que foi feito.

---

## 19. Glossário rápido

- **Pirograma** — o sinal do FID ao longo da pirólise.
- **Região** — o trecho do sinal analisado e a linha de base.
- **Referência** — o retrato do pico de um material puro (gaussiana + molde).
- **Gaussiana de referência** — o sino médio (centro e larguras).
- **Molde** — a forma real média, com área 1.
- **Dilatação** — quanto um pico está mais largo ou estreito que o molde.
- **Ajuste / deconvolução** — separar a área da mistura entre os materiais.
- **Curva de calibração** — reta área × massa, por material e por método.
- **Recuperação** — encontrado ÷ esperado.
- **Resíduo** — o que o ajuste não explicou.

**Visual sugerido:** duas colunas de cartões pequenos, um termo por cartão, com um mini-ícone.

---

## 20. Em uma frase

**Os puros ensinam a forma do pico (referência: gaussiana ou molde) e quanta área dá cada mg (curva); o ajuste usa a forma para dividir a área da mistura, e a curva transforma cada área em massa.**

**Visual sugerido:** o fluxograma do slide 2 de novo, agora com os ícones de cada conceito dentro das caixas.
