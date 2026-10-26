# ============================================
# Bungee Reverse Proxy - Production Docker Image
# ============================================
# Multi-stage build:
#   1. deps: Install workspace dependencies
#   2. build: Build UI + bundle assets + native release archive
#   3. production: Binary runtime with bundled plugin dependencies

# ---- Base Stage ----
FROM oven/bun:1.4.2 AS base
WORKDIR /usr/app

# ---- Dependencies Stage ----
FROM base AS deps
# Copy workspace configuration
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/types/package.json ./packages/types/
COPY packages/ui/package.json ./packages/ui/
COPY packages/cli/package.json ./packages/cli/
COPY packages/llms/package.json ./packages/llms/

# Install all dependencies (including workspace packages)
RUN bun install --frozen-lockfile

# ---- Build Stage ----
FROM deps AS build
# Copy all source code
COPY packages/ui ./packages/ui
COPY packages/types ./packages/types
COPY packages/core ./packages/core
COPY packages/llms ./packages/llms
COPY plugins ./plugins
COPY scripts/build/bundle-ui.ts ./scripts/build/
COPY scripts/build/build-external-plugins.ts ./scripts/build/
COPY scripts/build/build-binaries.ts ./scripts/build/
COPY scripts/checks/check-gateway-architecture.ts ./scripts/checks/
COPY scripts/tests/unit/checks/check-gateway-architecture.test.ts ./scripts/tests/unit/checks/

# Run complete build pipeline
# 1. Build Types (typescript) → packages/types/dist/
# 2. Build UI (vite) → packages/ui/dist/
# 3. Bundle UI assets into TypeScript → packages/core/src/ui/assets.ts
RUN bun run check:architecture && \
    bun run build:types && \
    bun run build:ui && \
    bun run bundle:ui && \
    bun run build:llms && \
    binary_name="$(bun -e 'import { getBinaryName } from "./packages/core/src/updates/names.ts"; console.log(getBinaryName())')" && \
    bun run build:binaries --target "$binary_name" && \
    version="$(bun -e 'console.log(require("./package.json").version)')" && \
    printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' && \
    mkdir -p "runtime/bin/$version" && \
    tar -xzf "bin/$binary_name.tar.gz" -C "runtime/bin/$version" && \
    printf '%s\n' "$version" > runtime/version.txt

# ---- Production Stage ----
FROM base AS production

# Install wget for health checks and tini for proper PID 1 handling
RUN apt-get update && \
    apt-get install -y --no-install-recommends wget tini && \
    rm -rf /var/lib/apt/lists/*

# Keep Bun and installed dependencies for dynamically loaded plugin artifacts.
COPY --from=deps /usr/app/node_modules ./node_modules

# Copy built types package (with dist/ containing .d.ts files)
COPY --from=build /usr/app/packages/types/dist ./packages/types/dist
COPY --from=build /usr/app/packages/types/package.json ./packages/types/

# Copy the selected release executable and its adjacent plugins.
COPY --from=build /usr/app/runtime ./runtime

# Copy package metadata for runtime dependency resolution.
COPY package.json ./
COPY packages/core/package.json ./packages/core/

# Copy healthcheck script
COPY scripts/runtime/healthcheck.sh ./
COPY scripts/runtime/docker-entrypoint.sh ./
RUN chmod 0755 healthcheck.sh docker-entrypoint.sh

# Create data and logs directories with proper permissions
RUN mkdir -p data logs && chown -R bun:bun data logs runtime

# Set environment variables
ENV NODE_ENV=production \
    BUNGEE_INSTALL_ROOT=/usr/app/runtime \
    PORT=8088 \
    BUNGEE_MANAGEMENT_HOST=0.0.0.0 \
    BUNGEE_MANAGEMENT_PORT=8089 \
    BUNGEE_MASTER_CONTROL_PORT=3011 \
    BUNGEE_ROLE=master \
    DAEMON_MODE=true

# Expose public proxy and management ports. The private master control port
# is intentionally not exposed.
EXPOSE 8088 8089

# Use non-root user for security
USER bun

# Health check using custom script
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD /usr/app/healthcheck.sh

# Use tini as PID 1 to properly handle signals and reap zombie processes
ENTRYPOINT ["/usr/bin/tini", "--"]

# Exec the selected release binary under tini.
CMD ["./docker-entrypoint.sh"]
