# Multi-stage build for gajae-way

# Build stage: compile all binaries
FROM oven/bun:1.4.0 AS builder

WORKDIR /build

# Copy source
COPY package.json bun.lock tsconfig.json biome.json bunfig.toml ./
COPY packages ./packages
COPY scripts ./scripts

# Install dependencies and build
RUN bun install --frozen-lockfile
RUN bun run build

# Runtime stage: minimal image with compiled binaries
FROM oven/bun:1.4.0

# Install system dependencies: procps (for healthcheck)
RUN apt-get update && apt-get install -y --no-install-recommends \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled binaries from builder
COPY --from=builder /build/dist /usr/local/bin

# Create non-root user for security (use existing user if available, else create with UID 1001)
RUN id gajaeway 2>/dev/null || useradd -m -u 1001 gajaeway

# Set up home directory with proper permissions
RUN mkdir -p /home/gajaeway/.gajaeway && \
    mkdir -p /home/gajaeway/.gjc && \
    chown -R gajaeway:gajaeway /home/gajaeway 2>/dev/null || true

USER gajaeway

# Environment setup
ENV GAJAEWAY_HOME=/home/gajaeway/.gajaeway
ENV HOME=/home/gajaeway
# GJC_EXECUTABLE must be provided by the host via PATH or mount
# See docker-compose.yaml for mount examples
ENV GJC_CODING_AGENT_DIR=/home/gajaeway/.gjc

# Expose gateway socket for direct connection (if needed)
VOLUME ${GAJAEWAY_HOME}
VOLUME /home/gajaeway/.gjc

# Health check: verify the gateway is responsive
# Note: healthcheck will fail until GJC_EXECUTABLE is available and config is set
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD gajaeway status > /dev/null 2>&1 || exit 1

# Run the gateway in daemon mode
CMD ["gajaeway-gateway", "daemon"]
