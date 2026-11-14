# PostRun · GeoHorun

Pós-corrida do **Rock-Eval 7S** no Projeto Horun: lê os `.B00` que o
equipamento grava, mostra os pirogramas, integra, deconvolui, calibra,
quantifica, organiza estudos e (em breve) calcula os parâmetros no estilo do
GeoWorks e as ferramentas do artigo. Separado do módulo RE7S em 13/11/2026 —
o RE7S fica com a fila e o carrossel.

- **Plano, decisões e estado:** [`docs/PLANO.md`](docs/PLANO.md)
- **Ferramentas do artigo (F1–F12):** [`docs/FERRAMENTAS_ARTIGO.md`](docs/FERRAMENTAS_ARTIGO.md)
- **Contrato de todo PostRun do Horun:** `Prompt_Horun_PostRun.md` (Horun Core)

## Regras

- **Repositório público:** nunca entram dados reais (`.B00` reais, planilhas,
  bancos) nem arquivos do GeoWorks (ajuda, métodos, `standards.ini`, ábacos —
  propriedade da Vinci Technologies). Testes usam `.B00` sintéticos.
- **Cópias que não se editam aqui:** `backend/app/postrun_core/` e
  `frontend/src/postrun-core/` (Horun Core, `scripts/vendor_postrun_core.py`),
  `backend/app/agent_server/` (Agent-Horun, `scripts/vendor_server.py`),
  `frontend/vendor/horun-design-system/` (Horun Core).
- **Servidor em Python 3.11:** nada de sintaxe 3.12+.
- **Dependências com versão exata** em `backend/pyproject.toml`.
- Campo novo em tabela existente → `_ensure_column` em `backend/app/db/session.py` no mesmo commit.

## Desenvolvendo

```powershell
# backend (lê os .B00 de backend/sample_data ou de POSTRUN_DATA_DIR)
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install fastapi==0.141.1 "uvicorn[standard]==0.52.3" sqlmodel==0.0.47 pydantic==2.13.4 numpy==2.3.4 scipy==1.16.3 openpyxl==3.1.5 lxml==6.0.2 pytest==9.1.1 httpx==0.28.1
$env:HORUN_DEV_MODE = "true"
uvicorn app.main:app --reload
python -m pytest -q

# frontend (outro terminal) — repassa /api para o backend
cd frontend
npm install
npm run dev
```

## Produção (atrás do Core)

Id `geohorun`, endereço `/m/geohorun/`. Variáveis do backend em
`backend/app/core/config.py`: `MODULE_DATABASE_URL`, `POSTRUN_AGENT_MODE=true`
(pastas `jobs` e `data` liberadas no `config.json` do Agente do PC do
Rock-Eval), `RE7S_INTERNAL_URL` / `RE7S_INTERNAL_TOKEN` (rotas internas do
RE7S) e `POSTRUN_RESULTADOS_URL` / `POSTRUN_RESULTADOS_TOKEN`.
