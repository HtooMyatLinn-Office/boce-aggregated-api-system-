# Boce Aggregated API System

Unified API for [Boce.com](https://www.boce.com) detection (website speed, DNS, etc.) with metrics, IP whitelist validation, and anomaly detection. Built with Node.js and Docker.

## Status

- **Implemented**: Boce create task + poll result, node list cache refresh, unified `/api/detect` (sync + async), metrics + anomalies, Redis queue + rate limit, Postgres storage + history.
- **Known prerequisites**: Boce account must have API enabled and **波点 > 0** (otherwise task creation fails).

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

   Notes:
   - Step 8 requires Postgres container to start successfully (Docker needs writable storage).

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
  middleware/     # rate limiting middleware
  routes/         # HTTP routes (health, /api/detect, dev tools)
  services/
    boce/         # Boce API client (create task, get result)
    detection/    # normalize + metrics + anomalies + detectOnce pipeline
    queue/        # BullMQ queue + Redis
    db/           # Postgres storage
  types/          # DetectionRequest, DetectionResult, etc.
```

## Environment variables

Copy `.env.example` to `.env` and edit.

### Required

- **BOCE_API_KEY**: your Boce API key (HTTP检测 / 网站检测).  
  Docs: Boce create task uses `key` query param ([创建任务](https://www.boce.com/document/api/137/12)).

### Common

- **BOCE_BASE_URL**: default `https://api.boce.com`
- **PORT**: default `3000`
- **NODE_ENV**: `development` to enable `/api/dev/*`

### Redis / Queue (Step 7)

- **REDIS_URL**: e.g. `redis://localhost:6379` (Docker uses `redis://redis:6379`)
- **QUEUE_ENABLED**: `true|false`
- **QUEUE_CONCURRENCY**: default `5`
- **QUEUE_JOB_TIMEOUT_MS**: default `150000` (2m30s)
- **RATE_LIMIT_ENABLED**: `true|false`
- **RATE_LIMIT_WINDOW_SEC**: default `60`
- **RATE_LIMIT_MAX**: default `30`

### Postgres (Step 8)

- **DATABASE_URL**: e.g. `postgresql://boce:boce@localhost:5432/boce_api`

### Webhook (application-level default)

- **APP_WEBHOOK_URL**: optional default webhook URL for batch completion callbacks
- **WEBHOOK_SIGNING_SECRET**: optional HMAC secret for webhook signature header `X-Boce-Signature`

### Client auth (commercial mode)

- **AUTH_ENABLED**: `true|false` (default `false`, keeps backward compatibility)
- **AUTH_STATIC_MODE**: `true|false` (when true, use one fixed env key/client; no DB lookup)
- **AUTH_STATIC_CLIENT_ID**: fixed client id for static mode
- **AUTH_STATIC_API_KEY**: fixed API key for static mode
- **AUTH_STATIC_CLIENT_NAME**: display name in static mode
- **AUTH_STATIC_MAX_BATCH_SIZE**: max domains for static mode tenant (capped to 5000)
- **AUTH_STATIC_DEFAULT_WEBHOOK_URL**: optional tenant default webhook in static mode
- **BOOTSTRAP_CLIENT_ID**: initial client id to create on startup (when auth enabled)
- **BOOTSTRAP_CLIENT_NAME**: initial client display name
- **BOOTSTRAP_API_KEY**: initial client API key

When enabled, call business APIs with headers:
- `X-Client-Id`
- `X-Api-Key`
- `X-Idempotency-Key` (optional, recommended for safe retry of `POST /api/batch-detect`)

### Node list refresh (Step 5)

- **BOCE_NODE_REFRESH_HOURS**: default `6` (refresh once every N hours after program starts)

## API Documentation

**OpenAPI spec (canonical):** [docs/openapi.yaml](docs/openapi.yaml)

**Complete API doc (all endpoints, full request/response, in test order):** [docs/API.md](docs/API.md)

## MCP Support (AI Agent Integration)

This project includes an MCP server for agent-first domain investigation.

### MCP server entrypoint

- Source: `src/mcp/server.ts`
- Build output: `dist/mcp/server.js`
- Scripts:
  - `npm run mcp:start` (Stream HTTP, default, production)
  - `npm run mcp:dev` (Stream HTTP, dev)
  - `npm run mcp:start:stdio` (stdio, local debug)

### MCP tools (async batch workflow)

- `probe_domains_batch_start`
  - Input: `{ "domains": ["www.baidu.com", "www.qq.com"], "nodeIds": "31,32" }`
  - Output: `{ "taskId": "abc123" }`
- `probe_domains_batch_status`
  - Input: `{ "taskId": "abc123" }`
  - Output (running): `status`, `progress` (% of domains **processed**), `completed` (successful probes only), `remaining`, `pollInterval`, and `nextStep.schedule.delayMs`
  - Output (completed / failed): `pollInterval` omitted; `nextStep` points to `probe_domains_batch_result` (no delay)
  - Unknown id: `{ "found": false, "error": "TASK_NOT_FOUND" }` (not a batch `status` value)
- `probe_domains_batch_result`
  - Input: `{ "taskId": "abc123" }`
  - Output: final compact domain lines; while running it returns same polling shape as status

All MCP responses are intentionally compressed to avoid context overflow while preserving final judgment.

### Cursor MCP config (project-level)

For local Cursor tool-debug via stdio, create `./.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "user-boce-investigation": {
      "command": "npm",
      "args": ["run", "mcp:start:stdio"],
      "cwd": "E:/develop-X/Boce-Aggregated-API-System"
    }
  }
}
```

For remote MCP clients, use Stream HTTP endpoint:

- URL: `http://localhost:3010/mcp`
- Port can be overridden with `MCP_PORT`
- Behind a public domain, set **`MCP_ALLOWED_HOSTS`** (hostname only, comma-separated) so the MCP SDK accepts your `Host` header (avoids `Invalid Host` errors).

### Stream HTTP Quick Test (2 minutes)

1. Start MCP server (Stream HTTP):

```bash
npm run mcp:start
```

2. In a second terminal, start the custom MCP client:

```bash
npm run mcp:client
```

3. In the client prompt, run:

```text
connect http://localhost:3010/mcp
list-tools
check-batch www.baidu.com,www.qq.com 31,32
# copy taskId from response, then:
status <taskId>
result <taskId>
```

Expected:
- `list-tools` shows the 3 batch tools above
- While `pending`/`running`, `status` includes `pollInterval` (base) and `nextStep.schedule.delayMs` (adaptive from batch size + remaining work, clamped 2s–60s)
- When `completed` or `failed`, `pollInterval` is omitted and `nextStep.tool` is `probe_domains_batch_result` (no `schedule`)
- `result` returns the compact report; `domainErrorCount` counts per-domain probe failures (batch may still be `completed`)

### Quick MCP test prompts (in Cursor chat)

- `Call MCP tool probe_domains_batch_start with {"domains":["www.baidu.com","www.qq.com"],"nodeIds":"31,32"} and print raw output only.`
- `Call MCP tool probe_domains_batch_status with {"taskId":"<taskId>"} and print raw output only.`
- `Call MCP tool probe_domains_batch_result with {"taskId":"<taskId>"} and print raw output only.`

Summary below. Base URL: `http://localhost:3000`.

### Health

#### `GET /health`

**Response**

```text
OK
```

---

## Unified detection API

### `POST /api/detect` (sync mode)

Creates a Boce HTTP detection task, polls until `done=true` (every ~10s, max ~2 min), normalizes results, computes metrics, applies optional whitelist/anomaly rules, and returns a standardized JSON payload.

**Request body**

```json
{
  "url": "www.baidu.com",
  "nodeIds": "31,32",
  "ipWhitelist": ["157.148.69.186"]
}
```

- `url` (**required**): the host/url to test (Boce uses `host`).
- `nodeIds` (**optional**): comma-separated Boce node IDs (`node_ids` in Boce API). If omitted, defaults to `"31,32"`.
- `ipWhitelist` (**optional**): array of allowed response IPs; mismatches become anomalies.

**Example**

```bash
curl -X POST "http://localhost:3000/api/detect" ^
  -H "Content-Type: application/json" ^
  -d "{\"url\":\"www.baidu.com\",\"nodeIds\":\"31,32\",\"ipWhitelist\":[\"157.148.69.186\"]}"
```

**Response (success)**

```json
{
  "success": true,
  "mode": "sync",
  "data": {
    "requestId": "uuid",
    "url": "www.baidu.com",
    "taskId": "20260318_xxx",
    "timestamp": "2026-03-18T07:16:00.677Z",
    "probes": [
      {
        "nodeId": 31,
        "nodeName": "福建",
        "ispName": "移动",
        "region": "CN",
        "statusCode": 200,
        "responseIp": "36.152.44.132",
        "latencyMs": 187,
        "boceErrorCode": 0,
        "boceError": ""
      }
    ],
    "availability": {
      "regional": [
        { "region": "CN", "total": 2, "success": 2, "availabilityRate": 1 }
      ],
      "global": { "total": 2, "success": 2, "availabilityRate": 1 }
    },
    "anomalies": [
      {
        "region": "CN",
        "nodeId": 31,
        "ip": "36.152.44.132",
        "statusCode": 200,
        "reason": "IP_NOT_IN_WHITELIST",
        "message": "IP 36.152.44.132 not in whitelist"
      }
    ],
    "summary": {
      "overallStatus": "DEGRADED",
      "message": "Availability 100.0% with 1 anomalies."
    }
  }
}
```

---

### `POST /api/detect?async=1` (async queue mode)

Enqueues a detection job into Redis/BullMQ and returns a job id immediately.

**Request body** is the same as sync.

**Example**

```bash
curl -X POST "http://localhost:3000/api/detect?async=1" ^
  -H "Content-Type: application/json" ^
  -d "{\"url\":\"www.baidu.com\",\"nodeIds\":\"31,32\"}"
```

**Response**

```json
{
  "success": true,
  "mode": "async",
  "jobId": "123",
  "statusUrl": "/api/detect/jobs/123"
}
```

---

### `GET /api/detect/jobs/:jobId`

Fetch BullMQ job status/result.

**Example**

```bash
curl "http://localhost:3000/api/detect/jobs/123"
```

**Response**

```json
{
  "success": true,
  "jobId": "123",
  "state": "completed",
  "attemptsMade": 1,
  "progress": 100,
  "failedReason": null,
  "result": { "requestId": "uuid", "url": "www.baidu.com", "...": "..." }
}
```

---

## Storage APIs (Step 8)

### `GET /api/detect/results/:requestId`

Fetch a stored detection result by `requestId`.

```bash
curl "http://localhost:3000/api/detect/results/<REQUEST_ID>"
```

### `GET /api/detect/history?url=...&limit=...`

List stored results for a URL, newest first.

```bash
curl "http://localhost:3000/api/detect/history?url=www.baidu.com&limit=20"
```

**Optimization note**

This endpoint returns a **lightweight history list** (IDs + a few fields) and does **not** return full `result_json`.
Fetch the full payload by calling `GET /api/detect/results/:requestId`.

**Query parameters**

- `url` (**required**): host/url string exactly as stored (what you send in `POST /api/detect`).
- `limit` (**optional**): `1..200`, default `20`.
- `cursor` (**optional**): pagination cursor in the form `createdAt|requestId` (use `nextCursor` from previous response).

**Response**

```json
{
  "success": true,
  "url": "www.baidu.com",
  "count": 2,
  "items": [
    {
      "requestId": "5f4d8d4b-6c44-4a5d-9b0a-9e1a6d2c5c2b",
      "taskId": "20260318_xxx",
      "url": "www.baidu.com",
      "createdAt": "2026-03-18T07:16:00.677Z",
      "overallStatus": "HEALTHY",
      "availabilityRate": 1
    },
    {
      "requestId": "a1b2c3d4-1111-2222-3333-444455556666",
      "taskId": "20260317_yyy",
      "url": "www.baidu.com",
      "createdAt": "2026-03-17T02:10:11.000Z",
      "overallStatus": "DEGRADED",
      "availabilityRate": 0.875
    }
  ],
  "nextCursor": null
}
```

**Pagination example**

```bash
curl "http://localhost:3000/api/detect/history?url=www.baidu.com&limit=20&cursor=2026-03-17T02:10:11.000Z|a1b2c3d4-1111-2222-3333-444455556666"
```

---

## Node list APIs (dev, Step 5)

> Available only when `NODE_ENV=development`.

- `GET /api/dev/nodes` — node cache snapshot
- `POST /api/dev/nodes/refresh` — refresh node list now (mainland + oversea)
- `GET /api/dev/nodes/lookup?nodeId=31` — get node metadata

Boce node list upstream doc: [节点列表](https://www.boce.com/document/api/70/72)

---

## Error Codes

### Boce public error codes (`error_code`)

From Boce docs: [公共错误码](https://www.boce.com/document/api/70/73)

| error_code | Meaning (Boce) |
|-----------:|----------------|
| -1 | 节点异常 (node error) |
| 0 | 成功 |
| 1 | 鉴权失败 (auth fail) |
| 2 | 参数错误 (parameter error) |
| 3 | 波点不足或波点未配置 (insufficient points) |
| 4 | 生成任务id失败或任务id失效 (task id failed/expired) |

### Our workflow error kinds (returned by `POST /api/detect` on 400)

These are mapped from Boce error codes above and local conditions.

| kind | When it happens |
|------|-----------------|
| AUTH_FAILED | `error_code=1` or missing key |
| PARAM_ERROR | `error_code=2` |
| INSUFFICIENT_POINTS | `error_code=3` |
| TASK_ID_FAILED_OR_EXPIRED | `error_code=4` |
| NODE_ERROR | `error_code=-1` |
| TIMEOUT | result did not finish within timeout (polling cap) |
| NETWORK_ERROR | network request failed (e.g. DNS/proxy) |
| UNKNOWN | unrecognized error_code |

### Rate limiting

When rate limited, API returns **HTTP 429**:

```json
{ "success": false, "error": "Rate limit exceeded" }
```

## License

MIT
