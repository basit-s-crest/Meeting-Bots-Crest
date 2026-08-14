# Deployment Plan — CrestMeet for First 100 Users

This plan is a **decision-first, actionable roadmap** for taking the meeting-bot product to a
seamless production experience for the first 100 users. It includes a **hosting comparison
with pricing**, a **phased rollout**, the **exact configuration changes** the codebase needs,
and a **runbook**. It is a living document — keep it updated as decisions change.

> **Note:** the product currently runs on a Windows desktop via `start.ps1` (backend :3000,
> frontend :3001, memory :8001, ngrok). The bots spawn headless Chrome/Playwright. There is
> **no Docker or CI/CD** in the repo today. This plan designs the cloud footprint and the
> small code/config changes required, and **bakes in the "per-user bot Google account" feature**
> (one separate Google account per user, logged in once through the UI via a virtual display).

---

## 1. Architecture at a glance

```
                          ┌──────────────────────────────────────────────┐
   Users (browser) ─────► │  Caddy / Nginx (public HTTPS)               │
                          │   app.crestmeet.com  →  frontend :3001      │
                          │   api.crestmeet.com  →  backend  :3000      │
                          └───────────────┬──────────────────────────────┘
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        │                                 │                                 │
        ▼                                 ▼                                 ▼
  Frontend (Next.js)              Backend (Express)                  Memory Service (FastAPI)
  dashboard/frontend              dashboard/backend :3000            memory-service :8001
  next build + next start         server.js (all intervals:          uvicorn (no reload)
  :3001                           calendar poller, auto-join,
                                  stale-session cleanup)
        │                                 │                                 │
        │                                 └──────────────┬──────────────────┘
        │                                                ▼
        │                                    ┌──────────────────────────┐
        │                                    │  Bot VM (dedicated)      │
        │                                    │  systemd: bot-manager    │
        │                                    │  spawns Chrome/Playwright│
        │                                    │  per session (headless)  │
        │                                    │  Xvfb + noVNC for login  │
        │                                    └──────────────────────────┘
        │                                                │
        ▼                                                ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Supabase (hosted):  Postgres+pgvector · Storage bucket "transcripts"│
  │  · Auth/JWT · RPC search fns · Redis (managed)                      │
  └──────────────────────────────────────────────────────────────────────┘
```

### Components
- **Frontend** — Next.js (React 19). Production: `next build && next start -p 3001`.
- **Backend** — Express on :3000. Hosts all timers (calendar watch renewal, 30s auto-join
  poll, stale-session cleanup), spawns bots, Deepgram/Google/Groq integrations, JWT auth.
- **Memory service** — FastAPI/uvicorn on :8001. Loads the BGE embedding model (~2 GB RAM)
  at startup; Supabase + Redis. Must run **without** `reload=True` in production.
- **Bots** — Google Meet / Zoom / Teams Playwright bots, one Node child + one Chrome tree per
  session (~0.5–1 GB RAM each). Need `npx playwright install --with-deps chromium`.
- **Supabase** — hosted; schema in `migration.sql` + `memory-service/schema.sql` (pgvector,
  pg_trgm, HNSW/GIN indexes, 2 RPC search functions, `transcripts` storage bucket).
- **Redis** — optional today (live-buffer Q&A + session delete), default `localhost:6379`.
  Use managed Redis once multi-VM.
- **Caddy/nginx** — reverse proxy + automatic HTTPS. Replaces the ngrok dependency.

---

## 2. Hosting options: comparison with pricing

### A. One dedicated bot VM + one app VM (recommended)
Bots run on a separate VM (so Chrome load never starves the API), with Xvfb + noVNC for the
one-time per-user Google login. App VM runs backend + frontend + memory.

| Provider | VM | Specs | Monthly | Notes |
|---|---|---|---|---|
| **Hetzner** (EU/US, budget) | App VM: CX32 | 4 vCPU / 8 GB / 160 GB | **€15.40** | Backend+frontend+memory fit comfortably |
| | Bot VM: CX42 | 8 vCPU / 16 GB / 160 GB | **€16.40** | ~6–8 concurrent Chrome sessions |
| | | | **≈ €31.80/mo total** | ~$34–37/mo |
| **DigitalOcean** (US/global, simple) | App VM: s-4vcpu-8gb | 4 vCPU / 8 GB / 160 GB | $48 | |
| | Bot VM: s-8vcpu-16gb | 8 vCPU / 16 GB / 320 GB | $96 | |
| | | | **$144/mo total** | ~4× Hetzner |
| **AWS Lightsail** (enterprise-friendly) | 8 GB app + 16 GB bot | 2 vCPU/8 GB + 4 vCPU/16 GB | ~$40 + ~$80 = **~$120/mo** | predictable, more managed services |

### B. Single VM (everything on one box) — cheapest start
| Provider | VM | Specs | Monthly | Concurrency |
|---|---|---|---|---|
| Hetzner | CX42 | 8 vCPU / 16 GB / 160 GB | €16.40 | ~4–6 concurrent sessions before API suffers |
| Hetzner | CX52 | 16 vCPU / 32 GB / 320 GB | €32.40 | ~8–12 concurrent |
| DigitalOcean | s-8vcpu-16gb | 8 vCPU / 16 GB / 320 GB | $96 | ~6–8 |

### C. Comparison

| | **Dedicated bot VM** (A) | **Single VM** (B) |
|---|---|---|
| **Best price** | ~$34–37/mo (Hetzner) | ~$18–35/mo (Hetzner) |
| **Isolation** | Chrome crash/CPU can't take down API | A heavy meeting can starve the API/memory service |
| **Scale to 100+** | Add bot VMs, keep app stable | Must migrate to split VMs later |
| **Login UX (bot account)** | Xvfb+noVNC on the bot VM only | Same VM, shared resources |
| **Operational complexity** | Two VMs, one bot-manager service | Simplest |
| **Best for** | **Seamless 100-user experience** | Dev/staging, tight budget, <10 concurrent |

**Recommendation:** **Hetzner CX42 (app) + CX42 (bot)** = ~€31.80/mo, the best price/perf for
a smooth experience. If you prefer a US/global provider with simpler billing, **DigitalOcean
s-4vcpu-8gb + s-8vcpu-16gb** ($144/mo) is the drop-in equivalent. If budget is the absolute
priority and concurrency stays low, **start on a single Hetzner CX42** and split later.

> Pricing verified Aug 2026: Hetzner CX32 €15.40, CX42 €16.40, CX52 €32.40;
> DigitalOcean s-4vcpu-8gb $48, s-8vcpu-16gb $96. See Sources at the end.

---

## 3. Phased rollout

### Phase 0 — Pre-flight code/config changes (1–2 days)
Make the codebase cloud-ready (details in §4). Everything here is small and low-risk.

### Phase 1 — Provision infrastructure (0.5–1 day)
1. **Supabase** project (hosted): enable `vector` + `pg_trgm`, run `migration.sql` +
   `memory-service/schema.sql`, create `transcripts` storage bucket, add the 2 RPC functions.
2. **Hetzner (or DO)** VMs: app VM + bot VM (Ubuntu 22.04/24.04).
3. **Redis** (managed or on app VM) and note `REDIS_URL`.
4. **DNS**: `app.crestmeet.com` → app VM; `api.crestmeet.com` → app VM (Caddy handles both).
5. **Firewalls**: only 80/443 public; bot VM reachable from app VM on the bot-manager port.

### Phase 2 — Deploy services (1 day)
1. Clone repo on app VM; `npm ci` for backend/frontend/bots; `npx playwright install --with-deps chromium` on the bot VM.
2. Create `.env` from `.env.example` with production values (§4.1); **rotate all secrets** (the
   committed `.env` has real keys — do not reuse).
3. Build frontend (`next build`), start backend + memory under systemd (§5.1), frontend under
   systemd/Caddy.
4. Set up the **bot-manager** service on the bot VM; verify a test bot session spawns and
   streams to the backend.
5. Point `PUBLIC_BACKEND_URL=https://api.crestmeet.com`; verify Google Calendar watch channel
   registers.

### Phase 3 — Bot-account onboarding + login UX (1–2 days)
1. Implement the per-user bot-account feature (Settings UI + `bot-accounts/<userId>.json` +
   `--auth-path` per spawn) — planned separately; this plan assumes it lands.
2. On the bot VM: **Xvfb :99** + **noVNC** so a user can complete the one-time Google login in
   a browser view (the `--login` flow is headful by design).
3. Test: new user → Settings → Connect bot account → noVNC login → Done → Connected → start a
   meeting → bot joins signed in as their bot account.

### Phase 4 — Verify, monitor, harden (1 day)
- Health checks for backend `/health`, memory `/health`, frontend.
- Logging: systemd journal + a log aggregator (Loki/Grafana or just file + `journalctl`).
- Alerts: uptime (UptimeRobot/healthchecks.io), OOM watch, bot spawn failures.
- Backups: Supabase (PITR) + nightly snapshot of app/bot VM (or DO snapshots).
- Security: rotate all keys, HTTPS only, disable public signups if invite-only for the first 100.

---

## 4. Code/config changes required (the "cloud-ready" checklist)

### 4.1 Environment
- **Rotate every secret** in `.env` (Deepgram, Groq, Supabase URL/key, JWT_SECRET,
  Google Drive + Calendar client id/secret, refresh tokens). The repo's `.env` is real and
  committed; do not ship it.
- Set `PUBLIC_BACKEND_URL=https://api.crestmeet.com` (replaces the ngrok tunnel; used by
  Google Calendar webhooks).
- Set `FRONTEND_URL=https://app.crestmeet.com` and `BACKEND_URL=https://api.crestmeet.com`.
- Set `JWT_SECRET` to a fresh strong value (backend **fails hard** if missing — server.js:45).
- Set `DEEPGRAM_API_KEY`, `GROQ_API_KEY` (required for Meet/Zoom transcription + reports).
- Google OAuth redirect URIs: update `GOOGLE_REDIRECT_URI` and
  `GOOGLE_CALENDAR_REDIRECT_URI` to `https://api.crestmeet.com/api/auth/google/callback` and
  `https://api.crestmeet.com/api/calendar/auth/callback`, **and register the same URIs in the
  Google Cloud Console**.
- Optional: `CALENDAR_TIMEZONE`, `DEFAULT_DURATION_MINUTES`, `GMAIL_USER`/`GMAIL_APP_PASSWORD`.

### 4.2 Frontend — remove hardcoded localhost (required for remote users)
The frontend hardcodes `http://localhost:3000` in 4 files; remote users' browsers can't reach
it. Change to read from a public env var at build time (Next.js `NEXT_PUBLIC_BACKEND_URL`),
defaulting to the current value for local dev:
- `dashboard/frontend/src/context/AuthContext.tsx` (line 23) — `BACKEND_URL`
- `dashboard/frontend/src/app/(public)/approve/page.tsx` (line 21)
- `dashboard/frontend/src/app/(app)/calendar/page.tsx` (line 22)
- `dashboard/frontend/src/app/(app)/projects/[projectId]/meeting/page.tsx` (line 394) —
  WebSocket URL `ws://localhost:3000/ws/transcripts` → `wss://api.crestmeet.com/ws/transcripts`

### 4.3 Backend — CORS + WS + token path
- **CORS** (`server.js:42`) is pinned to `origin: 'http://localhost:3001'`. Allow
  `https://app.crestmeet.com` (and keep localhost for dev).
- **WebSocket** upgrade path is `wss://api.crestmeet.com/ws/transcripts` — Caddy must proxy
  WebSocket upgrades to the backend (`http` reverse proxy with upgrade support; or set
  `X-Forwarded-*` headers).
- **`google_refresh_token.json` path** (`google-drive-helper.js:14`) uses `process.cwd()`.
  Under systemd/pm2 the cwd may differ; fix to `__dirname`-based path so Drive tokens always
  land in the backend dir.
- Add **startup reconciliation** for orphaned `transcripts/*.jsonl` (crash mid-meeting leaves
  files that never upload). Sweep on boot: re-attempt `saveSessionEnd`/upload for rows still
  in `capturing/starting/...` (complements `cleanupStaleSessions`).

### 4.4 Bots — Linux + headless + auth
- Run `npx playwright install --with-deps chromium` on the bot VM (installs system libs:
  `libgbm1`, `libasound2`, etc.).
- **Teams hardcoded Windows paths** are catch-wrapped (non-fatal on Linux) but should be fixed:
  `Microsoft Teams/src/join/teams-bot.js:972,1041` and
  `Microsoft Teams/src/capture/caption-scraper.js:9,470,493` → use `path.join(__dirname, ...)`.
- **Bot-account feature** (planned): store per-user `storageState` in
  `dashboard/backend/bot-accounts/<userId>.json`; `spawnBot` passes `--auth-path` per user;
  the **Teams bot needs `--auth-path` CLI support** added (only the constructor accepts
  `options.authPath` today) so Teams sessions also run under the user's account.
- **Login flow on headless VM**: the `--login` flow forces headful Chrome. Provide
  **Xvfb + noVNC** on the bot VM so users can complete Google login in a browser view, and
  replace the stdin-ENTER trigger with an API signal (the planned `POST /api/bot-account/done`).

### 4.5 Memory service — production mode
- Run `uvicorn app.main:app --host 0.0.0.0 --port 8001` (no `reload=True`; `main.py:42` uses
  reload in `start()` — invoke uvicorn directly in systemd).
- Pre-download the BGE embedding model on the app VM during deploy (or bake into a build step)
  to avoid a multi-minute first-boot download and ensure startup succeeds offline.
- Use managed Redis and set `REDIS_URL`.

---

## 5. Service management & deployment mechanics

### 5.1 systemd units (Linux)
Three units on the app VM, one on the bot VM:
- `crestmeet-backend.service` — `node server.js` in `dashboard/backend`; `Restart=always`,
  `WorkingDirectory` fixed, env from `/etc/crestmeet/.env`.
- `crestmeet-frontend.service` — `npm run start` (Next.js prod server on :3001).
- `crestmeet-memory.service` — `uvicorn app.main:app ...` in `memory-service`.
- `crestmeet-bots.service` — the bot-manager (spawns per-session bot children; children inherit
  the backend's env so `PARENT_PID` watchdog works). On the **bot VM**, the app backend must be
  able to reach it; use a private network / firewall rule, and set `BOT_MANAGER_URL` (or have
  the backend SSH/HTTP to the bot VM).

> **Concurrency guard:** ensure only ONE backend runs the calendar/auto-join timers. If you
> scale to multiple backend instances later, extract those jobs into a dedicated worker.

### 5.2 Reverse proxy (Caddy)
```caddyfile
app.crestmeet.com {
    reverse_proxy 127.0.0.1:3001
}
api.crestmeet.com {
    reverse_proxy 127.0.0.1:3000
}
```
Caddy gives automatic HTTPS + WebSocket upgrade support. (nginx is equivalent; use whatever the
team knows.)

### 5.3 Deploy method
**Git-pull + systemd restart** is fine for 100 users (simplest, no new tooling):
```
git pull && npm ci && (frontend) next build
sudo systemctl restart crestmeet-backend crestmeet-frontend crestmeet-memory
```
Optionally add a `deploy.sh` that does this and a GitHub Action on push to a `production` branch.
Docker is NOT required for 100 users; skip it unless the team prefers containers.

---

## 6. Seamless user experience for 100 users

### 6.1 Onboarding flow (new user)
1. User signs up / is invited → lands on **Settings → Bot account**.
2. "Connect bot account" → backend spawns the login bot on the **bot VM** under Xvfb; the UI
   shows an embedded **noVNC** view (or a "sign in in the opened window" state).
3. User signs into their **separate** bot Google account (2FA works in the browser view).
4. Clicks **Done** → `POST /api/bot-account/done` → `bot-accounts/<userId>.json` saved →
   Settings shows **Connected**.
5. User creates/opens a project and starts a meeting → bot joins signed in as their bot account.
6. Calendar auto-join uses the same account. Transcripts/reports appear as today.

### 6.2 Performance budget
- Backend+frontend+memory on 8 GB: comfortable.
- Each concurrent meeting ≈ 1 bot Node process + 1 Chrome tree ≈ **0.5–1 GB RAM**.
  A 16 GB bot VM comfortably runs **8–12 concurrent sessions** (plenty for 100 users, since
  not all meet at once). Watch CPU on the bot VM; scale by adding bot VMs.

### 6.3 Reliability / continuity
- Backend restart loses in-memory scheduled timers — the 30s auto-join poller and boot scan
  re-schedule after restart; document a ~1-min recovery window.
- Keep `transcripts/`, `bot-accounts/`, refresh-token JSONs, auto-join config on a **persistent
  volume** (or ensure systemd WorkingDirectory is stable). Back them up nightly.
- **Supabase** is the source of truth for sessions/segments; if the app VM is lost, only the
  local auth files and token JSONs need restoring (reconnect via UI otherwise).

---

## 7. Security checklist
- [ ] Rotate ALL secrets before first deploy; never commit `.env`.
- [ ] HTTPS only (Caddy automatic).
- [ ] Google Cloud Console: register production redirect URIs; remove localhost.
- [ ] Firewall: public 80/443 only; bot VM not publicly reachable.
- [ ] JWT_SECRET strong + unique; consider short-lived tokens (already JWT-based).
- [ ] Restrict signups (invite-only) for the first 100 users if you don't want public signup.
- [ ] Keep `bot-accounts/` out of git (add to `.gitignore`); treat auth files as credentials.
- [ ] Weekly VM snapshots + Supabase PITR backups.

---

## 8. Runbook (day-1 operations)

### Start / stop
```bash
sudo systemctl start/stop/restart crestmeet-backend crestmeet-frontend crestmeet-memory crestmeet-bots
```
### View logs
```bash
journalctl -u crestmeet-backend -f
journalctl -u crestmeet-bots -f
```
### Bot not joining?
Check `journalctl -u crestmeet-bots`, confirm `auth.json`/`bot-accounts/` exist, verify the
bot VM has Playwright chromium + deps, and that the bot VM can reach the backend.
### OOM / slow?
Check `free -h` on bot VM; reduce concurrent sessions or add a bot VM.
### Calendar events not auto-joining?
Confirm `PUBLIC_BACKEND_URL` is set and the watch channel is registered (see backend log);
else rely on the 30s poller.

---

## 9. What's needed before Day 1 (summary)

| # | Item | Owner |
|---|---|---|
| 1 | Rotate secrets; create prod `.env` | Dev |
| 2 | Fix frontend hardcoded URLs + backend CORS/WS | Dev |
| 3 | Fix `google_refresh_token.json` path + startup reconciliation | Dev |
| 4 | Implement per-user bot-account feature + Teams `--auth-path` | Dev |
| 5 | Fix Teams hardcoded Windows paths | Dev |
| 6 | Provision Supabase (schema, bucket, RPC) | Dev |
| 7 | Provision 2 VMs + DNS + Caddy + systemd | Ops |
| 8 | Xvfb + noVNC on bot VM for login | Ops |
| 9 | Pre-download BGE model; run memory without reload | Ops |
| 10 | Monitoring + backups + security checklist | Ops |

---

## Sources
- [Hetzner new cloud plans (CX22/CX32/CX42/CX52 pricing)](https://www.hetzner.com/pressroom/new-cx-plans/)
- [DigitalOcean Droplet pricing (Jan 2026 per-second billing)](https://www.digitalocean.com/pricing/droplets)
- [Zoom README (Xvfb requirement for headless Linux)](C:\Projects-Crest\Meeting-Bots-Crest\Zoom\README.md)
- [Google Meet bot plan (virtual display recommendation)](C:\Projects-Crest\Meeting-Bots-Crest\Google Meet\GOOGLE_MEET_BOT_PLAN.md)
