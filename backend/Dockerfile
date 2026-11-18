FROM python:3.11-slim

WORKDIR /app

# 1) Dependências ANTES do código (17/11/2026): esta camada fica guardada
#    pelo Docker enquanto o pyproject.toml não mudar — atualizar só o código
#    não baixa mais numpy/scipy/... do PyPI a cada build. Antes, o COPY app
#    vinha primeiro e qualquer mudança refazia o download inteiro (e a rede
#    lenta do servidor estourava o tempo do pip: "Read timed out").
#    Espera maior e mais tentativas para essa rede.
COPY pyproject.toml ./
RUN python -c 'import tomllib; p = tomllib.load(open("pyproject.toml", "rb"))["project"]; print("\n".join(p["dependencies"] + p["optional-dependencies"]["postgres"]))' > /tmp/requirements.txt \
    && pip install --no-cache-dir --timeout 120 --retries 10 -r /tmp/requirements.txt

# 2) O código. Instala o pacote sem dependências e sem isolamento de build
#    (usa o setuptools que já vem na imagem): nada é baixado nesta etapa.
#    O pacote instalado é o que dá a versão em metadata.version("geohorun").
COPY app ./app
RUN pip install --no-cache-dir --no-deps --no-build-isolation . && rm -rf build *.egg-info

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
