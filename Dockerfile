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

# Runtime stage: minimal image with compiled binaries and gjc
FROM oven/bun:1.4.0

# Install system dependencies for healthcheck and signal handling
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled binaries from builder
COPY --from=builder /build/dist /usr/local/bin

# Create non-root user for security
RUN useradd -m -u 1000 gajaeway

# Set up home directory with proper permissions
RUN mkdir -p /home/gajaeway/.gajaeway && \
    chown -R gajaeway:gajaeway /home/gajaeway

USER gajaeway

# Environment setup
ENV GAJAEWAY_HOME=/home/gajaeway/.gajaeway
ENV HOME=/home/gajaeway

# Expose gateway socket for direct connection (if needed)
VOLUME ${GAJAEWAY_HOME}

# Health check: verify the gateway is responsive
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD gajaeway status > /dev/null 2>&1 || exit 1

# Run the gateway in daemon mode
CMD ["gajaeway-gateway", "daemon"]
