# FeaturePulse-Dev
A Next.js reimplementation of the original FeaturePulse hackathon project, migrating from Vite to a production-ready stack.

## Database — Neon Postgres

FeaturePulse uses [Neon](https://neon.tech) for Postgres hosting. The backend and dashboard connect to the same Neon project but via **different endpoints** — getting this wrong will either exhaust connection limits or break query semantics.

### Connection string split

Neon provides two connection strings per project:

| Variable | Endpoint | Used by | Why |
|----------|----------|---------|-----|
| `DATABASE_URL` | **Direct** — `ep-name-hash.region…` | Backend (`src/`) on Railway | `pg.Pool` holds long-lived TCP connections; direct endpoint is correct. PgBouncer transaction mode is incompatible with pg.Pool's prepared statements. |
| `DATABASE_URL_POOLED` | **Pooled** — `ep-name-hash-pooler.region…` | Dashboard (`dashboard/`) on Vercel | Concurrent Vercel invocations each open WebSocket connections. The `-pooler` PgBouncer endpoint multiplexes them so direct connection limits aren't exhausted. `@neondatabase/serverless` is explicitly designed to work with PgBouncer. |

Both strings require `?sslmode=require`.

### Getting the strings

1. Create a Neon project at [console.neon.tech](https://console.neon.tech).
2. On the project dashboard, copy **both** connection strings shown under "Connection Details" (toggle between Direct and Pooled).
3. Paste them:

| Variable | Where to set it |
|----------|----------------|
| `DATABASE_URL` | Railway service → Variables tab |
| `DATABASE_URL_POOLED` | Vercel project → Settings → Environment Variables (all environments) |
| Both | Local `.env` at repo root AND `dashboard/.env.local` (can both point to the direct URL for local dev — no PgBouncer needed locally) |

### Running schema migrations

Run the DDL in `src/db/schema.sql` (or your migration tool) using the **direct** connection string once after creating the project.

## Deploying to Render

See [`render.yaml`](./render.yaml) for the full config. Summary:

| Setting | Value |
|---------|-------|
| **Build command** | `npm install && npm run build` |
| **Start command** | `node dist/index.js` |
| **Health check path** | `/health` |
| **Plan** | Free (auto-sleeps after 15 min idle) |

**To prevent auto-sleep:** set up UptimeRobot (free) to GET `https://<your-app>.onrender.com/health` every 14 minutes.

**Env vars to set in Render dashboard** (Settings → Environment):

| Variable | Description |
|----------|-------------|
| `APP_ID` | GitHub App numeric ID |
| `PRIVATE_KEY` | GitHub App private key PEM (paste verbatim, multi-line) |
| `WEBHOOK_SECRET` | GitHub webhook secret |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `DATABASE_URL` | Neon **direct** connection string (see Database section above) |
| `REDIS_URL` | Upstash `rediss://` connection string — **not** the REST URL |

`PORT` is set automatically by Render. Do not override it.

## Running locally

### Prerequisites

Redis is required for BullMQ (the PR analysis job queue). Start it once before running:

```bash
docker compose up -d redis
```

This uses [docker-compose.yml](./docker-compose.yml) (`redis:7-alpine`, port 6379). Stop with `docker compose down`.

### Single process — worker is embedded

The BullMQ worker now starts inside the same process as the Express server (`src/index.ts`). You only need **one terminal** for the backend:

```bash
npm run dev        # repo root — starts Express + embedded BullMQ worker
```

For the dashboard:

```bash
cd dashboard && npm run dev    # starts Next.js on port 3000
```

> **Note:** `npm run worker` has been removed. Running `worker.ts` standalone alongside `index.ts` would create duplicate consumers on the same queue. If you later upgrade to a paid Render tier with a separate worker service, re-add `"worker": "tsx src/worker.ts"` to `package.json` and remove the `startWorker()` call from `src/index.ts`.

### Services

| Service | Command | Default port |
|---------|---------|-------------|
| Backend (Express + webhooks + worker) | `npm run dev` (repo root) | **3001** |
| Dashboard (Next.js) | `npm run dev` (inside `dashboard/`) | **3000** |

Copy `.env.example` to `.env` (repo root) and to `dashboard/.env.local`, then fill in values before starting either server.

