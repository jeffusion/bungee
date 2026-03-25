# Deployment (Docker)

This guide matches the current `docker-compose.yml` in the repository.

---

## 1) Prerequisites

- Docker Engine
- Docker Compose v2+

---

## 2) Default Compose Model

The default service uses image-first strategy:

- Image: `ghcr.io/${GITHUB_REPOSITORY_OWNER:-jeffusion}/bungee:${BUNGEE_VERSION:-latest}`
- Optional local build via `docker compose up --build`

Persistent volumes:

- `data:/usr/app/data` (contains config and plugin runtime data)
- `logs:/usr/app/logs`

Key env values from compose:

- `BUNGEE_ROLE=master`
- `WORKER_COUNT=2`
- `PORT=8088`
- `CONFIG_PATH=/usr/app/data/config.json`

---

## 3) Quick Start

```bash
# Pull image and start service
docker compose up -d

# Check health and status
docker compose ps

# Follow logs
docker compose logs -f bungee
```

---

## 4) First-Time Configuration

The runtime can auto-create minimal config when missing. For explicit configuration:

```bash
# Copy example locally (optional)
cp config.example.json config.json
```

If you want to inject a custom config into the containerized runtime, copy it into the data volume path expected by `CONFIG_PATH`.

---

## 5) Health Checks

Container health check is configured as:

```yaml
healthcheck:
  test: ["CMD", "/usr/app/healthcheck.sh"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 40s
```

Manual checks:

```bash
docker compose ps
curl http://localhost:8088/health
```

---

## 6) Operational Commands

```bash
# Recreate with latest image
docker compose pull
docker compose up -d

# Rebuild from local source
docker compose up -d --build

# Stop services
docker compose down
```

---

## 7) Security and Reliability Notes

- Keep secrets in environment or secret manager; do not commit real tokens.
- Keep `data` and `logs` volumes persistent across restarts.
- Use external reverse proxy / ingress if you need public TLS termination.
- Tune `WORKER_COUNT` and resource limits based on host CPU/memory.
