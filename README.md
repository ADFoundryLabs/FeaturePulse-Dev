# FeaturePulse-Dev
A Next.js reimplementation of the original FeaturePulse hackathon project, migrating from Vite to a production-ready stack.

## Running locally

| Service | Command | Default port |
|---------|---------|-------------|
| Backend (Express + webhooks) | `npm run dev` (repo root) | **3001** |
| Dashboard (Next.js) | `npm run dev` (inside `dashboard/`) | **3000** |

Copy `.env.example` to `.env` and fill in values before starting either server. Override `PORT` if `3001` is already taken.

