# PostRun · GeoHorun — implantação e troca com o RE7S

Passo a passo para pôr o GeoHorun no servidor e tirar o PostRun do RE7S
(docs/PLANO.md, Fase 1, passos 6 e 7). Nada aqui apaga dados do RE7S: ele
guarda as tabelas do PostRun até a remoção final, e a migração só **lê** de
lá.

Convenções do servidor: repositórios em `C:\Horun\<repo>`, backups em
`C:\HorunBackups\Horun-<módulo>-backup`, rede Docker `horun-network` já
criada pelo Core.

## 1. Token entre os dois módulos

Gere **um** valor aleatório longo (no PowerShell do servidor):

```powershell
python -c "import secrets; print(secrets.token_hex(32))"
```

Ele vai em dois lugares, com o mesmo valor:

- `.env` do RE7S → `RE7S_GEOHORUN_TOKEN=<valor>`
- `.env` do GeoHorun → `RE7S_INTERNAL_TOKEN=<valor>`

Com o token preenchido no RE7S:

- as rotas `/internal/geohorun/*` passam a responder (fila, histórico,
  biblioteca, padrões e exportação para a migração);
- renomear, mover e trocar a amostra de análises **deixam de funcionar no
  RE7S** e passam a ser feitos só no GeoHorun.

Por isso o token entra no RE7S **no mesmo momento** em que o GeoHorun sobe
(passo 3).

## 2. Clonar e configurar o GeoHorun

```powershell
cd C:\Horun
git clone https://github.com/guimneves/Postrun---GeoHorun.git PostRun-GeoHorun
cd PostRun-GeoHorun
copy .env.example .env
notepad .env
```

No `.env`: `POSTGRES_PASSWORD` (senha nova, forte), `RE7S_INTERNAL_TOKEN`
(passo 1) e `BACKUP_DIR=C:/HorunBackups/Horun-geohorun-backup` (crie a pasta).

## 3. Subir (e religar o RE7S com o token)

```powershell
cd C:\Horun\Horun RE7S
notepad .env                      # RE7S_GEOHORUN_TOKEN=<valor do passo 1>
git pull
docker compose up -d --build backend

cd C:\Horun\PostRun-GeoHorun
docker compose up -d --build
docker compose ps                  # geohorun-db, geohorun-backend, geohorun-frontend, db-backup
```

## 4. Migrar os dados do PostRun

Primeiro uma simulação, que só conta o que seria copiado e não grava nada:

```powershell
docker compose exec geohorun-backend python -m app.scripts.migrar_do_re7s --simular
```

Se os números baterem com o que existe no RE7S (regiões, curvas,
deconvoluções, referências, estudos, renomeações…), migre:

```powershell
docker compose exec geohorun-backend python -m app.scripts.migrar_do_re7s
```

A migração é tudo ou nada e recusa rodar de novo num banco que já tem dados,
então nada é duplicado. Os ids são os mesmos do RE7S. Quem criou cada coisa
vira o mesmo usuário do Core no GeoHorun.

## 5. Cadastrar no Core

Core → Admin → Módulos → novo módulo:

| campo | valor |
|---|---|
| id | `geohorun` |
| nome | PostRun · GeoHorun |
| ícone | 📈 |
| URL interna (API) | `http://geohorun-backend:8000` |
| URL interna (tela) | `http://geohorun-frontend:80` |
| health | `/health` |

Dê acesso a quem usava o PostRun no RE7S.

## 6. Agente do PC do Rock-Eval

O mesmo Agente que atende o RE7S passa a atender também o GeoHorun, com um
**segundo bloco** em `servers` no `config.json` dele. Cada módulo enrola o
Agente separadamente.

1. No GeoHorun, botão **Agente** no cabeçalho (só coordenação) → **Gerar
   código de instalação**.
2. No PC do Rock-Eval, acrescente no `config.json` (os caminhos são os
   mesmos do bloco do RE7S):

   ```json
   {
     "url": "http://<ip-do-servidor>:8003",
     "enroll_code": "<código gerado>",
     "device_token": "",
     "roots": {
       "jobs": { "path": "<mesma pasta RE7raw-data do bloco do RE7S>", "mode": "read-write" },
       "data": { "path": "<mesma pasta data\\system do bloco do RE7S>", "mode": "read" }
     }
   }
   ```

   - `jobs` precisa de `read-write`: renomear e mover usam a permissão de
     mover, e trocar a amostra grava o `Sample=` dentro do `.B00`. Com
     `read-move`, renomear e mover funcionam e só a troca de amostra é
     recusada.
   - `data` só é lido (`standard.ini`).
3. Reinicie o Agente. No painel do Agente do GeoHorun, a instalação aparece
   como **conectado**.
4. Libere a porta **8003** no firewall do servidor para o IP do PC do
   Rock-Eval, igual à 8001 do RE7S. Essa mudança no sistema é feita por você.

## 7. Conferir em produção

- A lista de jobs e os pirogramas abrem no GeoHorun.
- Estudos, curvas, deconvoluções e calibrações migrados aparecem.
- Renomear uma análise de teste no GeoHorun: no RE7S, o Histórico mostra o
  nome atual, e cadastrar uma amostra com o nome novo é recusado.
- No RE7S, renomear responde que agora é feito no GeoHorun.

## 8. Retirar o PostRun do RE7S

Só depois do passo 7 conferido, e depois de pelo menos um backup do RE7S
feito após a migração. Esse passo é uma mudança à parte no código do RE7S
(retirar a aba, as rotas e o código do PostRun). As tabelas ficam no banco
até o backup seguinte.

## Se algo der errado

- **Voltar atrás antes do passo 8:** apague `RE7S_GEOHORUN_TOKEN` do `.env`
  do RE7S e recrie o backend dele. O PostRun antigo do RE7S volta a
  renomear como antes. As renomeações feitas no GeoHorun nesse meio-tempo já
  estão no RE7S, porque chegaram como réplica.
- **O GeoHorun diz "RE7S inacessível":** confira se o `re7s-backend` está de
  pé e se os dois tokens são iguais. As renomeações feitas nesse período
  ficam numa fila e são reenviadas sozinhas.
