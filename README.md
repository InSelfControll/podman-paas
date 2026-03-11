# PodPaaS — Podman-Native Self-Hosted PaaS

A production-ready, self-hosted PaaS running on **Podman** (rootless, daemonless). Drop-in alternative to Dokploy/Coolify for servers without Docker.

## Features

- 🐳 **Deploy apps** from Git repos or container images
- 📦 **Compose stacks** via Podman Compose with container tracking
- 🧩 **Templates** — import from Portainer Community or Dokploy with one click
- 🌐 **Reverse proxy** via Caddy (automatic routing, HTTPS support)
- 📊 **Dashboard** — live container stats, deployment logs, health monitoring
- 🔐 **Auth** — JWT, bcrypt, rate limiting, multi-user support
- 📡 **WebSocket** — real-time log streaming with reconnection
- 💾 **Backup/Restore** — export/import full platform state
- 🔔 **Webhooks** — GitHub/Gitea auto-deploy on push

## Quick Start

```bash
# 1. Clone the repository
git clone <repo-url> podman-paas && cd podman-paas

# 2. Run setup (installs deps, creates .env, enables Podman socket)
bash scripts/setup.sh

# 3. Start with podman-compose
export PODMAN_SOCKET=/run/user/$(id -u)/podman/podman.sock
podman-compose up -d

# 4. Open http://localhost:5173
# Login: admin / admin  ← CHANGE AFTER FIRST LOGIN!
```

See [PRODUCTION.md](PRODUCTION.md) for detailed production deployment instructions.

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | For development only |
| Podman | ≥ 4.0 | Rootless recommended |
| podman-compose | latest | Required for stack support |
| Caddy | 2.x | Optional — for domain routing |

## Architecture

```
React (Vite) ↔ Fastify API ↔ Podman REST API (unix socket)
                           ↔ Caddy Admin API (dynamic routing)
                           ↔ SQLite (state + logs)
                           ↔ Portainer/Dokploy template registries
```

## Project Structure

```
podman-paas/
├── api/                    # Fastify API server
│   ├── src/
│   │   ├── index.js       # Server entry
│   │   ├── db/            # Database & migrations
│   │   ├── routes/        # API endpoints
│   │   └── services/      # Business logic (podman, deploy, etc.)
│   ├── package.json
│   └── Dockerfile
├── frontend/              # React + Vite frontend
│   ├── src/
│   │   ├── pages/         # Page components
│   │   ├── components/    # UI components
│   │   └── lib/           # API client, store
│   ├── package.json
│   ├── Dockerfile
│   └── nginx.conf
├── caddy/                 # Caddy configuration
├── scripts/               # Setup & utility scripts
├── deploy/                # Deployment configs (systemd)
├── compose.yml            # Main orchestration file
└── PRODUCTION.md          # Production deployment guide
```

## Development

```bash
# Terminal 1: API
cd api && npm run dev

# Terminal 2: Frontend
cd frontend && npm run dev

# Access: http://localhost:5173
```

## Templates

Go to **Templates** → **Sync Sources** to pull from:

- **Portainer Community** — 500+ community templates (Lissy93/portainer-templates)
- **Dokploy** — Official Dokploy compose stacks
- **Custom URL** — any Portainer JSON or `docker-compose.yml` URL

## Environment Variables

Create `api/.env` for development or `.env` for production:

```env
# Required
JWT_SECRET=your-secure-random-secret-min-32-chars
NODE_ENV=production

# Podman
PODMAN_SOCKET=/run/user/1000/podman/podman.sock

# Frontend (for CORS)
FRONTEND_URL=https://your-domain.com

# Optional resource limits
DEFAULT_MEMORY_LIMIT=536870912   # 512MB
DEFAULT_CPU_LIMIT=1.0
```

## Troubleshooting

### WebSocket Connection Failed

- Check `FRONTEND_URL` matches your actual URL
- Verify firewall allows WebSocket connections
- Check browser console for CORS errors

### Stacks Not Deploying

```bash
# Verify podman-compose is installed
podman-compose --version

# Check Podman socket is accessible
systemctl --user status podman.socket
curl --unix-socket /run/user/$(id -u)/podman/podman.sock http://d/v4.0.0/libpod/_ping
```

### Permission Denied (Rootless)

```bash
# Ensure subUID/subGID mappings exist
grep $USER /etc/subuid /etc/subgid

# Add if missing (requires root)
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER
```

## Security

- Change default password immediately after first login
- Use strong JWT secret (min 32 chars, random)
- Enable HTTPS in production (Caddy auto-HTTPS)
- Never expose Podman socket to untrusted networks
- Keep Podman and base images updated

## License

MIT

## Credits

- Templates from [Portainer Community](https://github.com/Lissy93/portainer-templates) and [Dokploy](https://github.com/Dokploy/templates)
- Built with Fastify, React, Podman, and Caddy
