FROM python:3.12-slim AS base

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY src/ ./src/

RUN pip install --no-cache-dir -e ".[web]"

COPY examples/ ./examples/
COPY configs/ ./configs/

EXPOSE 8484

ENV EDAGENT_RUNTIME_DIR=/data/.edagent

CMD ["uvicorn", "edagent_vivado.web.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8484"]
