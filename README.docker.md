# Bungee Docker Deployment Guide

Complete guide for deploying Bungee reverse proxy using Docker and Docker Compose.

## Quick Start

### 1. Prerequisites

- Docker Engine 20.10+
- Docker Compose 2.0+
- At least 1GB available RAM
- Port 8088 available (or configure a different port)

### 2. Prepare Configuration

Copy the example configuration and update with your settings:

```bash
cp config.example.json config.json
```

Edit `config.json` and update:
- API tokens for your routes
- Upstream targets
- Authentication settings
- Failover and health check configurations

**Security Warning**: Never commit `config.json` with real tokens to version control!

### 3. Build and Run

```bash
# Build the Docker image
docker-compose build

# Start the service
docker-compose up -d

# Check logs
docker-compose logs -f

# Check health status
docker-compose ps
```

### 4. Verify Deployment

```bash
# Check health endpoint
curl http://localhost:8088/health

# Test a proxied request (example)
curl http://localhost:8088/api/test \
  -H "Authorization: Bearer your-token"
```

## Architecture

The Docker image uses a multi-stage build process:

```
┌─────────────────────────────────────────┐
│ Stage 1: deps                            │
│ Install workspace dependencies          │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│ Stage 2: ui-build                        │
│ Build Web UI dashboard (Vite + Svelte) │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│ Stage 3: bundle                          │
│ Bundle UI assets into core package      │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│ Stage 4: build                           │
│ Build core package (Bun build)          │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│ Stage 5: production                      │
│ Minimal runtime image (~200MB)          │
│ - Only runtime dependencies             │
│ - Non-root user (bun)                   │
│ - Health check script included          │
└─────────────────────────────────────────┘
```

## Configuration

### Environment Variables

Configure via `docker-compose.yml` or `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Runtime environment |
| `PORT` | `8088` | HTTP port to listen on |
| `BUNGEE_ROLE` | `master` | Process role (master/worker) |
| `WORKER_COUNT` | `2` | Number of worker processes |
| `LOG_LEVEL` | `info` | Logging level (debug/info/warn/error) |
| `CONFIG_PATH` | `/usr/app/config.json` | Configuration file path |

### Volume Mounts

The docker-compose.yml includes these volume mounts:

```yaml
volumes:
  # Your actual configuration (required)
  - ./config.json:/usr/app/config.json:ro

  # Persistent logs (recommended)
  - ./logs:/usr/app/logs

  # Optional: Environment secrets
  # - ./.env:/usr/app/.env:ro
```

### Port Mapping

Change the host port in `docker-compose.yml`:

```yaml
ports:
  - "8080:8088"  # Maps host:8080 to container:8088
```

## Health Checks

The container includes automatic health monitoring:

- **Endpoint**: `http://localhost:8088/health`
- **Interval**: 30 seconds
- **Timeout**: 10 seconds
- **Start Period**: 40 seconds (allows time for initialization)
- **Retries**: 3 consecutive failures before marking unhealthy

Check health status:

```bash
# Using docker-compose
docker-compose ps

# Using docker directly
docker inspect --format='{{.State.Health.Status}}' bungee

# View health check logs
docker inspect --format='{{json .State.Health}}' bungee | jq
```

## Resource Management

Default resource limits (adjust in `docker-compose.yml`):

```yaml
deploy:
  resources:
    limits:
      cpus: '2'
      memory: 1G
    reservations:
      cpus: '0.5'
      memory: 256M
```

## Logging

Logs are managed both inside and outside the container:

### Container Logs

```bash
# View all logs
docker-compose logs

# Follow logs in real-time
docker-compose logs -f

# View logs for specific time range
docker-compose logs --since 30m

# View last 100 lines
docker-compose logs --tail=100
```

### Application Logs

Mounted to `./logs` directory:
- Access logs with request/response details
- Error logs
- Daily rotation (configurable in config.json)

## Production Deployment

### Security Best Practices

1. **Never use config.example.json in production**
   ```bash
   cp config.example.json config.json
   # Edit config.json with production values
   ```

2. **Use secrets management**
   ```yaml
   # Option 1: Use Docker secrets
   secrets:
     api_token:
       external: true

   # Option 2: Use environment variables
   environment:
     - GLOBAL_API_TOKEN=${GLOBAL_API_TOKEN}
   ```

3. **Run behind a reverse proxy**
   ```nginx
   # nginx example
   location /api {
       proxy_pass http://localhost:8088;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
   }
   ```

4. **Enable HTTPS** (handled by upstream reverse proxy)

### Scaling

Run multiple instances behind a load balancer:

```yaml
# docker-compose.yml
services:
  bungee:
    # ... existing config
    deploy:
      replicas: 3  # Run 3 instances
```

Or use Docker Swarm / Kubernetes for advanced orchestration.

### Monitoring

Access the built-in Web UI dashboard:

```
http://localhost:8088/
```

Features:
- Real-time metrics
- Upstream health status
- Request statistics
- Configuration overview

For production monitoring, you can integrate with external monitoring solutions:
- Prometheus (metrics)
- Grafana (visualization)
- ELK Stack (log aggregation)
- Or any other monitoring system via the built-in API endpoints

## Troubleshooting

### Container won't start

```bash
# Check logs
docker-compose logs bungee

# Common issues:
# 1. Port already in use
sudo lsof -i :8088

# 2. Config file not found
ls -la config.json

# 3. Permission issues
sudo chown -R $(id -u):$(id -g) logs/
```

### Health check failing

```bash
# Test health endpoint manually
docker-compose exec bungee wget -O- http://localhost:8088/health

# Check if application started
docker-compose exec bungee ps aux

# View detailed health status
docker inspect bungee | jq '.[0].State.Health'
```

### High memory usage

```bash
# Check current usage
docker stats bungee

# Reduce worker count
# Edit docker-compose.yml: WORKER_COUNT=1
docker-compose up -d

# Adjust memory limits
# Edit docker-compose.yml deploy.resources.limits.memory
```

### Build failures

```bash
# Clean build (no cache)
docker-compose build --no-cache

# Check disk space
df -h

# View build logs
docker-compose build --progress=plain
```

## Updating

### Update Application Code

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose up -d --build
```

### Update Configuration Only

```bash
# Edit config.json
vim config.json

# Restart to apply changes
docker-compose restart
```

### Zero-Downtime Update

```bash
# Build new image
docker-compose build

# Scale up with new version
docker-compose up -d --scale bungee=2

# Wait for health checks to pass
sleep 60

# Scale down old version
docker-compose up -d --scale bungee=1
```

## Advanced Usage

### Custom Dockerfile

For customization, create `Dockerfile.custom`:

```dockerfile
FROM your-registry/bungee:latest

# Add custom certificates
COPY custom-ca.crt /usr/local/share/ca-certificates/
RUN update-ca-certificates

# Add custom scripts
COPY custom-entrypoint.sh /
RUN chmod +x /custom-entrypoint.sh

CMD ["/custom-entrypoint.sh"]
```

### Multi-Environment Setup

Use different compose files:

```bash
# Development
docker-compose -f docker-compose.yml \
               -f docker-compose.dev.yml up

# Production
docker-compose -f docker-compose.yml \
               -f docker-compose.prod.yml up
```

### Integration Testing

```bash
# Start services
docker-compose up -d

# Run tests
docker-compose exec bungee bun test

# Cleanup
docker-compose down
```

## Uninstall

```bash
# Stop and remove containers
docker-compose down

# Remove volumes (WARNING: deletes logs)
docker-compose down -v

# Remove images
docker rmi bungee:latest

# Clean up all Docker resources
docker system prune -a
```

## Support

- Issues: [GitHub Issues](https://github.com/jeffusion/bungee/issues)
- Documentation: [Main README](./README.md)
- Configuration Examples: [config.example.json](./config.example.json)
