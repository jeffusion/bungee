# ============================================
# Bungee Reverse Proxy - Production Docker Image
# ============================================
# Multi-stage build (3 stages):
#   1. deps: Install workspace dependencies
#   2. build: Build UI + bundle assets + build core
#   3. production: Minimal runtime image (~200MB)

# ---- Base Stage ----
FROM oven/bun:1 AS base
WORKDIR /usr/app

# ---- Dependencies Stage ----
FROM base AS deps
# Copy workspace configuration
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/types/package.json ./packages/types/
COPY packages/ui/package.json ./packages/ui/
COPY packages/cli/package.json ./packages/cli/

# Install all dependencies (including workspace packages)
RUN bun install --frozen-lockfile

# ---- Build Stage ----
FROM deps AS build
# Copy all source code
COPY packages/ui ./packages/ui
COPY packages/types ./packages/types
COPY packages/core ./packages/core
COPY scripts/bundle-ui.ts ./scripts/

# Run complete build pipeline
# 1. Build Types (typescript) → packages/types/dist/
# 2. Build UI (vite) → packages/ui/dist/
# 3. Bundle UI assets into TypeScript → packages/core/src/ui/assets.ts
# 4. Build core (bun + tsc) → packages/core/dist/ (includes main.js, master.js, worker.js)
RUN bun run build:types && \
    bun run build:ui && \
    bun run bundle:ui && \
    bun run build:core

# ---- Production Stage ----
FROM base AS production

# Install wget for health checks and tini for proper PID 1 handling
RUN apt-get update && \
    apt-get install -y --no-install-recommends wget tini && \
    rm -rf /var/lib/apt/lists/*

# Copy dependencies from deps stage
COPY --from=deps /usr/app/node_modules ./node_modules

# Copy built types package (with dist/ containing .d.ts files)
COPY --from=build /usr/app/packages/types/dist ./packages/types/dist
COPY --from=build /usr/app/packages/types/package.json ./packages/types/

# Copy built core artifacts (ONLY dist/, not src/)
COPY --from=build /usr/app/packages/core/dist ./packages/core/dist

# Copy package files and configuration
COPY package.json ./
COPY packages/core/package.json ./packages/core/
COPY config.example.json ./

# Copy healthcheck script
COPY healthcheck.sh ./
RUN chmod +x healthcheck.sh

# Create data and logs directories with proper permissions
RUN mkdir -p data logs && chown -R bun:bun data logs

# Set environment variables
ENV NODE_ENV=production \
    PORT=8088 \
    BUNGEE_ROLE=master \
    DAEMON_MODE=true

# Expose port
EXPOSE 8088

# Use non-root user for security
USER bun

# Health check using custom script
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD /usr/app/healthcheck.sh

# Use tini as PID 1 to properly handle signals and reap zombie processes
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start application using compiled main.js entry point
CMD ["bun", "run", "packages/core/dist/main.js"]
