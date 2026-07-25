# syntax=docker/dockerfile:1

# ---- build: install dependencies into a venv ----
# 3.13 matches the Lambda runtime (see infra/services/mcp.ts) so local and cloud
# resolve the same wheels.
FROM python:3.13-slim AS build
WORKDIR /src

# Dependencies as their own layer: only re-installs when requirements.txt changes.
# The image uses the human-maintained ranges, not requirements-lambda.lock — the
# lock is pinned to Lambda's arm64 manylinux platform, which this image may not be.
COPY requirements.txt ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# ---- runtime: interpreter + the built venv only ----
FROM python:3.13-slim AS runtime
WORKDIR /app
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 \
    PORT=8000

COPY --from=build /opt/venv /opt/venv
COPY server.py ./
COPY looped_in_mcp ./looped_in_mcp

# Non-root, matching the frontend and backend images.
RUN useradd --create-home --uid 10001 mcp
USER mcp
EXPOSE 8000
CMD ["python", "server.py"]
