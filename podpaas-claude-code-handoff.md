# סיכום פרויקט PodPaaS — העברה ל-Claude Code

> העתק הודעה זו והדבק אותה ל-Claude Code עם הוראה:
> "זה פרויקט שבניתי עם Claude. הנה סיכום המצב הנוכחי — אנחנו רוצים להמשיך לפתח אותו:"

---

## מה זה
פלטפורמה עצמאית (self-hosted PaaS) מבוססת **Podman** במקום Docker — חלופה ל-Dokploy/Coolify לשרתים עם Podman. כולל תמיכה מלאה בתבניות Portainer ו-Dokploy.

---

## ארכיטקטורה
```
React (Vite, port 5173) ↔ Fastify API (port 3001) ↔ Podman REST API (unix socket)
                                                    ↔ Caddy Admin API (port 2019)
                                                    ↔ SQLite (./data/)
                                                    ↔ Portainer/Dokploy template registries
```

---

## מבנה הפרויקט (לאחר unzip של podman-paas-complete.zip)
```
podman-paas-final/
├── api/
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── index.js                    # Fastify server entry
│       ├── db/database.js              # SQLite schema + init
│       ├── routes/
│       │   ├── auth.js                 # Login, JWT, bcrypt
│       │   ├── apps.js                 # CRUD + deploy/stop/restart/env
│       │   ├── deployments.js          # היסטוריית deployments
│       │   ├── logs.js                 # REST + WebSocket log streaming
│       │   ├── metrics.js              # overview + containers
│       │   ├── settings.js             # הגדרות פלטפורמה
│       │   ├── stacks.js               # Podman Compose stacks
│       │   └── templates.js            # Portainer + Dokploy templates
│       └── services/
│           ├── podman.js               # Podman REST API client (unix socket)
│           ├── caddy.js                # Caddy Admin API client
│           ├── build.js                # git clone → build (Dockerfile/Nixpacks)
│           ├── deploy.js               # orchestration + DB log streaming
│           ├── stacks.js               # podman compose up/down
│           └── templates.js            # parse + fetch Portainer/Dokploy formats
├── frontend/
│   ├── package.json
│   ├── vite.config.js                  # proxy /api → localhost:3001
│   └── src/
│       ├── App.jsx                     # Router
│       ├── index.css                   # CSS variables (dark theme)
│       ├── main.jsx
│       ├── components/
│       │   ├── Sidebar.jsx             # ניווט
│       │   └── ui.jsx                  # Button, Card, Modal, Badge, LogViewer...
│       ├── lib/
│       │   ├── api.js                  # כל ה-API calls
│       │   └── store.js                # Zustand store
│       └── pages/
│           ├── Dashboard.jsx
│           ├── Apps.jsx
│           ├── AppDetail.jsx           # tabs: overview, logs, env, deployments
│           ├── Templates.jsx           # Portainer/Dokploy template browser
│           └── OtherPages.jsx          # Stacks, Containers, Deployments, Settings, Login
├── caddy/Caddyfile
├── scripts/setup.sh                    # one-time setup
├── deploy/podman-paas-api.service      # systemd user unit
└── README.md
```

---

## Stack טכני
| שכבה | טכנולוגיה |
|---|---|
| Backend | Node.js 20+, Fastify 4.x, better-sqlite3 |
| Auth | @fastify/jwt (JWT), bcryptjs, @fastify/rate-limit |
| Frontend | React 18, Vite, Zustand, lucide-react |
| Container runtime | Podman REST API v4 via unix socket |
| Reverse proxy | Caddy Admin API (dynamic routing) |
| DB | SQLite (WAL mode) |
| Build | Buildah / Nixpacks |

---

## הרצה מהירה
```bash
unzip podman-paas-complete.zip
cd podman-paas-final
bash scripts/setup.sh          # מתקין deps, יוצר .env עם JWT secret, מפעיל podman socket

# Terminal 1
cd api && npm run dev

# Terminal 2
cd frontend && npm run dev

# פותח http://localhost:5173
# login: admin / admin
```

---

## משתני סביבה חשובים (api/.env)
```env
JWT_SECRET=<נוצר אוטומטית>
PORT=3001
PODMAN_SOCKET=/run/user/1000/podman/podman.sock
FRONTEND_URL=http://localhost:5173
DATA_DIR=./data
BUILD_DIR=/tmp/podman-paas-builds
STACKS_DIR=/tmp/podman-paas-stacks
NODE_ENV=development
```

---

## טבלאות SQLite
- `users` — auth
- `apps` — app definitions
- `deployments` — deployment history + logs (capped 500KB)
- `env_vars` — per-app env vars (encrypted secrets flag)
- `stacks` — compose stacks
- `settings` — key/value config
- `template_catalog` — cached Portainer/Dokploy templates

---

## מערכת תבניות

### תמיכה בשני פורמטים:

**Portainer JSON** (`{ version, templates: [...] }`):
- Type 1 = container app → מפרס image, ports, volumes, env
- Type 3 = compose stack → מביא docker-compose.yml מ-GitHub

**Dokploy** (GitHub repo `Dokploy/templates`):
- `meta.json` → catalog
- `docker-compose.yml` + `config.toml` → נטענים on-demand
- פרסור משתנים מ-`[variables]` section ב-TOML

### API endpoints:
```
GET    /api/templates                   # חיפוש/סינון
GET    /api/templates/sources           # סטטיסטיקות לפי מקור
POST   /api/templates/sync              # { source: 'portainer'|'portainer-community'|'dokploy' }
POST   /api/templates/import            # { url, label } — custom URL
DELETE /api/templates/source/:src       # מחיקת כל תבניות ממקור
GET    /api/templates/:id               # פרטים + compose content (on-demand)
POST   /api/templates/:id/deploy/app    # deploy כ-App
POST   /api/templates/:id/deploy/stack  # deploy כ-Stack
```

---

## Deploy flow לאפליקציה
```
ensureNetwork → git clone / pull image → stop+remove old container
→ findFreePort → createContainer → startContainer
→ registerAppRoute (Caddy) → update SQLite → stream logs via WebSocket
```

---

## נקודות חשובות ל-Claude Code
- כל ה-imports הם ESM (`type: "module"`)
- Fastify גרסה **4.x בלבד** (לא 5) — שים לב לתאימות plugins
- `@fastify/helmet` **לא** בשימוש — גרסה לא תואמת עם Fastify 4. Security headers מיושמים ב-`onSend` hook inline ב-`index.js`
- Podman socket path: `/run/user/$(id -u)/podman/podman.sock` (rootless)
- WebSocket auth דרך query param `?token=` (כי WS לא תומך headers)
- Template data נשמר כ-JSON blob בעמודת `data` בטבלה `template_catalog`
- `bcryptjs` (לא `bcrypt`) — pure JS, לא צריך native compilation

---

## מה עוד צריך לעשות (known TODOs)
1. **WebHooks** — GitHub/Gitea webhooks לauto-deploy על push
2. **Multi-user** — כרגע יש user אחד (admin), צריך roles
3. **SSL אוטומטי** — אינטגרציה עם Caddy TLS + ACME
4. **Backup** — export/import של SQLite + compose files
5. **Registry auth** — login לפרטי registries (GHCR, custom)
6. **Health checks** — monitor containers ו-restart on failure
7. **Resource limits** — memory/CPU limits ב-createContainer
8. **Stack logs** — כרגע רק app logs יש WebSocket streaming
