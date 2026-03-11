# PodPaaS Production Deployment Guide

## Prerequisites

- Podman 4.0+ installed and configured
- Node.js 20+ (for development, not needed for containerized deployment)
- A Linux server (Ubuntu 22.04+, Fedora 38+, or similar)
- Domain name (optional, for HTTPS)

## Quick Start (Containerized)

### 1. Clone and Setup

```bash
git clone <your-repo-url> podman-paas
cd podman-paas

# Run setup to check dependencies and generate secrets
bash scripts/setup.sh
```

### 2. Configure Environment

```bash
# Copy production environment template
cp .env.production.example .env

# Edit the .env file with your settings
nano .env
```

Required settings:
```env
JWT_SECRET=your-secure-random-secret-here-min-32-chars
NODE_ENV=production
FRONTEND_URL=https://your-domain.com
PODMAN_SOCKET=/run/user/1000/podman/podman.sock  # Adjust UID
```

Generate a secure JWT secret:
```bash
openssl rand -hex 32
```

### 3. Start with Podman Compose

```bash
# Ensure podman socket is running
systemctl --user enable --now podman.socket

# Set the socket path
export PODMAN_SOCKET=/run/user/$(id -u)/podman/podman.sock

# Start all services
podman-compose up -d

# Or with docker-compose compatibility:
# docker-compose up -d
```

### 4. Verify Installation

```bash
# Check all containers are running
podman ps

# Check API health
curl http://localhost:3001/health

# Check logs
podman logs podman-paas_api_1
podman logs podman-paas_frontend_1
```

### 5. Access the UI

- Local: http://localhost:5173
- With domain: Configure your reverse proxy (Caddy/nginx) to point to the frontend

Default login: `admin` / `admin` ⚠️ **Change this immediately!**

## Production Hardening

### 1. Change Default Password

Login and go to Settings → Account to change the default admin password.

### 2. Enable HTTPS

Edit `caddy/Caddyfile`:

```caddy
{
    admin localhost:2019
    auto_https on
    email your-email@example.com
}

your-domain.com {
    # PodPaaS API
    handle_path /api/* {
        reverse_proxy localhost:3001
    }
    
    # PodPaaS Frontend
    reverse_proxy localhost:5173
}
```

Restart Caddy:
```bash
podman restart podman-paas_caddy_1
```

### 3. Firewall Configuration

```bash
# Allow HTTP/HTTPS
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https

# Allow PodPaaS ports (if needed)
sudo firewall-cmd --permanent --add-port=3001/tcp
sudo firewall-cmd --permanent --add-port=5173/tcp

sudo firewall-cmd --reload
```

### 4. Systemd Service (Auto-start)

Create a systemd user service:

```bash
mkdir -p ~/.config/systemd/user/
cp deploy/podman-paas.service ~/.config/systemd/user/

# Edit if needed
nano ~/.config/systemd/user/podman-paas.service

# Enable and start
systemctl --user daemon-reload
systemctl --user enable podman-paas
systemctl --user start podman-paas
```

### 5. Log Rotation

Podman containers already have log rotation configured in compose.yml (10MB max, 3 files).

For additional log management:

```bash
# Install logrotate if not present
sudo dnf install logrotate  # or apt install logrotate

# Create logrotate config
sudo tee /etc/logrotate.d/podman-paas << 'EOF'
/var/lib/containers/storage/overlay-containers/*/userdata/ctr.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
}
EOF
```

### 6. Backup Strategy

Use the built-in backup feature:

```bash
# Automated daily backup
0 2 * * * cd /path/to/podman-paas && podman exec podman-paas_api_1 node -e "require('./src/db/database.js').backup()" > /dev/null 2>&1

# Or use the API/UI to export backups periodically
```

Backup locations:
- Database: `./data/podman-paas.db`
- Stack files: `/tmp/podman-paas-stacks/`

### 7. Monitoring

Basic health checks:

```bash
# Add to crontab for monitoring
curl -f http://localhost:3001/health || echo "PodPaaS unhealthy" | mail -s "Alert" admin@example.com
```

For production monitoring, integrate with:
- Prometheus + Grafana
- Uptime Kuma
- Nagios/Zabbix

## Troubleshooting

### "Cannot connect to Podman socket"

```bash
# Check socket exists
ls -la /run/user/$(id -u)/podman/podman.sock

# Start socket if missing
systemctl --user start podman.socket

# Test API
curl --unix-socket /run/user/$(id -u)/podman/podman.sock http://d/v4.0.0/libpod/_ping
```

### "Stacks not deploying"

Check podman-compose is installed:
```bash
podman-compose --version
# If not installed: pip3 install podman-compose
```

Check compose file syntax:
```bash
podman-compose -f your-stack.yml config
```

### "WebSocket connection failed"

Check FRONTEND_URL env var matches your actual URL:
```bash
# Should match what you type in browser
echo $FRONTEND_URL
```

### Container permission issues (rootless)

```bash
# Ensure subordinate UIDs/GIDs are configured
grep $USER /etc/subuid
grep $USER /etc/subgid

# If missing, add them
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER
```

## Updating

```bash
cd podman-paas
git pull

# Rebuild and restart
podman-compose down
podman-compose up -d --build
```

## Uninstall

```bash
cd podman-paas

# Stop and remove all containers
podman-compose down -v

# Remove images (optional)
podman rmi podman-paas_api podman-paas_frontend

# Remove data (⚠️ DANGER - deletes all apps and settings)
rm -rf data/
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Caddy (80/443)│────▶│  Frontend (80)  │────▶│   API (3001)    │
│  Reverse Proxy  │     │   React/Vite    │     │   Fastify API   │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                              ┌─────────────────────────┼─────────────────────────┐
                              │                         │                         │
                              ▼                         ▼                         ▼
                    ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
                    │  Podman Socket  │      │  SQLite (data/) │      │  Caddy Admin    │
                    │  (containers)   │      │  (state/logs)   │      │  (2019)         │
                    └─────────────────┘      └─────────────────┘      └─────────────────┘
```

## Security Considerations

1. **JWT Secret**: Must be cryptographically secure and kept secret
2. **Podman Socket**: Never expose the socket to untrusted networks
3. **Default Password**: Change immediately after first login
4. **HTTPS**: Always use HTTPS in production (Let's Encrypt via Caddy)
5. **Firewall**: Only expose necessary ports (80, 443)
6. **Updates**: Keep Podman and base images updated

## Support

- Issues: GitHub Issues
- Documentation: README.md
- Podman Docs: https://docs.podman.io/
