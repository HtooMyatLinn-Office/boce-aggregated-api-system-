# Boce Aggregated API System

Unified API for [Boce.com](https://www.boce.com) detection (website speed, DNS, etc.) with metrics, IP whitelist validation, and anomaly detection. Built with Node.js and Docker.

## Prerequisites

- Docker and Docker Compose
- (Optional) Node 18+ and npm for local dev without Docker

## Quick start with Docker

1. **Clone and set env**

   ```bash
   cp .env.example .env
   # Edit .env and set BOCE_API_KEY (get it from https://www.boce.com)
   ```

2. **Run everything**

   ```bash
   docker compose up --build
   ```

   App: http://localhost:3000  
   Health: http://localhost:3000/health  

3. **Dev mode (source mounted, no image build)**

   ```bash
   docker compose -f docker-compose.dev.yml up
   ```

   Code changes apply after restart or with ts-node-dev.

## Local development (no Docker)

```bash
npm install
cp .env.example .env
# Set BOCE_API_KEY, REDIS_URL=redis://localhost:6379 if using Redis
npm run dev
```

## Project structure

```
src/
  config/         # Env and app config
  routes/         # HTTP routes (health, future /api/detect)
  services/
    boce/         # Boce API client (create task, get result)
  types/          # DetectionRequest, DetectionResult, etc.
```

## Implementation steps (test step by step)

1. ✅ Project + Docker — health check
2. Boce create task only
3. Boce get result + polling
4. Client wrapper + errors
5. Node list + region mapping
6. Normalize result → internal schema
7. Metrics (availability)
8. IP whitelist validation
9. Anomaly rules + summary
10. Detection pipeline
11. Persist results (DB)
12. `POST /api/detect`
13. Rate limit + timeout
14. Task queue (async)
15. Retries
16. History API
17. Docs + examples
18. Test suite + CI

## API (planned)

- `GET /health` — OK (implemented)
- `POST /api/detect` — body: `{ "url": "https://example.com", "ipWhitelist": [] }` (coming)

## License

MIT
