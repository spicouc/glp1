# API de dades de glp1 — Python stdlib (sense dependències de tercers)
FROM python:3.12-alpine

WORKDIR /app

# Només el codi de l'API: test_server.py no es copia a la imatge
COPY api/server.py /app/server.py

ENV GLP1_DATA=/data \
    GLP1_API_PORT=8001

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8001/api/health', timeout=4).status == 200 else 1)"

CMD ["python3", "-u", "/app/server.py"]
