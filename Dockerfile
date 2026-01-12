# ============================================
# Prompt Manager - Production Dockerfile
# Multi-stage build for smaller image size
# ============================================

# Stage 1: Build dependencies
FROM python:3.11-slim as builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt


# Stage 2: Production image
FROM python:3.11-slim

LABEL maintainer="vioaki"
LABEL description="Prompt Manager - AI Art & Prompt Management System"

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai \
    # Gunicorn defaults
    GUNICORN_WORKERS=2 \
    GUNICORN_THREADS=4 \
    GUNICORN_BIND=0.0.0.0:5000 \
    GUNICORN_LOG_LEVEL=info

WORKDIR /app

# Install runtime dependencies only
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libffi8 \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Copy Python packages from builder
COPY --from=builder /root/.local /root/.local
ENV PATH=/root/.local/bin:$PATH

# Copy application code
COPY . .

# Create necessary directories
RUN mkdir -p /app/instance /app/static/uploads /app/logs \
    && chmod -R 755 /app

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:5000/ || exit 1

# Start script
COPY <<'EOF' /app/start.sh
#!/bin/bash
set -e

# Initialize database if needed
python manage_db.py

# Start Gunicorn
exec gunicorn app:app \
    --workers ${GUNICORN_WORKERS} \
    --threads ${GUNICORN_THREADS} \
    --bind ${GUNICORN_BIND} \
    --log-level ${GUNICORN_LOG_LEVEL} \
    --access-logfile - \
    --error-logfile - \
    --capture-output \
    --timeout 120 \
    --graceful-timeout 30
EOF

RUN chmod +x /app/start.sh

CMD ["/app/start.sh"]
