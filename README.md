# FeaturePulse-Dev
A Next.js reimplementation of the original FeaturePulse hackathon project, migrating from Vite to a production-ready stack.

## Running locally

### Prerequisites

Phase 4 (BullMQ queue) requires a local Redis instance. Start it once before running the backend:

```bash
docker compose up -d redis
```

This uses [docker-compose.yml](./docker-compose.yml) (`redis:7-alpine`, port 6379). Stop with `docker compose down`.

### Services

| Service | Command | Default port |
|---------|---------|-------------|
| Backend (Express + webhooks) | `npm run dev` (repo root) | **3001** |
| Dashboard (Next.js) | `npm run dev` (inside `dashboard/`) | **3000** |

Copy `.env.example` to `.env` and fill in values before starting either server. Override `PORT` if `3001` is already taken.

