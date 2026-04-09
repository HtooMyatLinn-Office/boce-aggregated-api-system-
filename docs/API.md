# Boce Aggregated API — Complete API Documentation

> Canonical machine-readable API spec: `docs/openapi.yaml`

Base URL for all examples: **`http://localhost:3000`** (or your deployed host).

This document lists every endpoint **in the recommended order to test** (health → single detect → storage → batch detect).

---

## MCP API (AI Agent Tools)

This service also exposes MCP tools for AI-agent workflows.

### Server

- Entry: `src/mcp/server.ts`
- Start (Stream HTTP): `npm run mcp:start`
- Dev (Stream HTTP): `npm run mcp:dev`
- Debug (stdio): `npm run mcp:start:stdio`
- Stream HTTP endpoint: `http://localhost:3010/mcp` (override via `MCP_PORT`)
- **Health check (no MCP session):** `GET /mcp/health` → `200` JSON. Use this for Cloudflare / k8s / uptime probes.
- **`GET /mcp` without `Mcp-Session-Id` is not a liveness check.** After `POST /mcp` with JSON-RPC `initialize`, the client receives a session id and must send it on subsequent `GET` (SSE) / `DELETE`. Probing `GET https://your-host/mcp` in a browser returns `400` with `MCP_SESSION_REQUIRED` — expected until a real MCP client completes initialize.
- **Horizontal scaling:** Sessions live in **process memory**. Multiple replicas without **sticky sessions** cause “invalid / missing session”. Prefer one MCP replica or enable session affinity for `/mcp`.

**Production / reverse proxy:** The MCP SDK validates the HTTP `Host` header. If you expose MCP on a public domain (e.g. `https://boce-center.example.com/mcp`), set **`MCP_ALLOWED_HOSTS`** to that hostname (comma-separated if several), e.g. `MCP_ALLOWED_HOSTS=boce-center.example.com`. Otherwise requests return JSON-RPC error `Invalid Host: <hostname>`.

### MCP authentication (Stream HTTP, optional)

When **`MCP_AUTH_ENABLED=true`** (see `.env.example`):

- Set **`MCP_AUTH_TOKEN`** to a strong secret on the MCP server process.
- Clients must send either:
  - `Authorization: Bearer <token>`, or
  - `X-API-Key: <token>`
- Optional (not recommended for production): **`MCP_AUTH_ALLOW_QUERY_TOKEN=true`** allows `?mcp_auth_token=<token>` on the MCP URL for clients that cannot set headers.

**Cursor (HTTP MCP):** In `./.cursor/mcp.json`, prefer headers with env interpolation, e.g. `"Authorization": "Bearer ${env:MCP_AUTH_TOKEN}"`, and ensure that variable is set for the Cursor process (restart Cursor after changing OS env).

**Custom CLI:** `npm run mcp:client` → `auth-token <token>` then `connect`.

### Cursor setup (stdio debug)

Configure project MCP file `./.cursor/mcp.json`:

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

Reload Cursor window after saving config.

### Stream HTTP Quick Test

Run this exact flow to verify Stream HTTP MCP end-to-end:

1) Start server:

```bash
npm run mcp:start
```

2) Start custom client in another terminal:

```bash
npm run mcp:client
```

3) In client prompt:

```text
connect http://localhost:3010/mcp
list-tools
auth-token <token>            # if MCP_AUTH_ENABLED=true
disconnect
connect http://localhost:3010/mcp
call-tool probe_nodes_refresh {}
call-tool probe_nodes_list {"detail":"summary"}
call-tool probe_nodes_list {"detail":"list","limit":10,"offset":0}
check-batch www.baidu.com,www.qq.com 31,32
# copy taskId from output, then:
status <taskId>
result <taskId>
```

Expected:
- tools are listed successfully
- status contains `nextStep.schedule.delayMs` for controlled polling (adaptive from `pollInterval`, batch size, and remaining work; clamped 2s–60s)
- result returns compact final output when completed

**Field semantics (batch lifecycle):** `status` is always `pending` \| `running` \| `completed` \| `failed`. Unknown `taskId` returns `found: false` and `error: "TASK_NOT_FOUND"` (not a batch `status`). `progress` is **percent of domains processed** (work done), not success rate. `completed` lists **hostnames that finished probing successfully**; domains that threw are only in `errors` / `domainErrorCount`.

### MCP tools

Recommended agent workflow: **refresh or list nodes → pick `nodeIds` → `probe_domains_batch_start` → status → result**.

#### MCP resource: `boce://nodes/list`

Queryable node-discovery resource optimized for LLM usage.

**Query parameters (all optional):**

- `query` (string): ranked keyword search, e.g. `gd mobile`
- `region` (string): region filter, e.g. `Guangdong`
- `isp` (string): ISP filter, e.g. `Mobile` / `Unicom` / `Telecom`
- `limit` (number): max returned rows (default `20`)
- `offset` (number): pagination offset (default `0`)

Examples:

```text
read-resource boce://nodes/list
read-resource boce://nodes/list?query=gd%20mobile
read-resource boce://nodes/list?region=Guangdong&isp=Mobile
read-resource boce://nodes/list?limit=5&offset=5
```

**Response shape:**

```json
{
  "version": "1.0",
  "updatedAt": "2026-04-07T03:00:00.000Z",
  "snapshot": { "mainlandCount": 120, "overseaCount": 80, "total": 200 },
  "total": 42,
  "limit": 5,
  "offset": 5,
  "nodes": [
    {
      "nodeId": 19,
      "region": "Guangdong",
      "ispName": "Mobile",
      "label": "Guangdong Mobile (nodeId: 19)",
      "score": 18
    }
  ]
}
```

Notes:

- No params returns the first page (default limit 20), not the full list.
- Query/region/isp values are safely decoded (`gd%20mobile` and `gd mobile` behave the same).
- Filtering + pagination run in-memory on cached nodes.

---

#### 1) `probe_nodes_refresh`

Reloads the in-memory node cache from Boce (mainland + oversea).

**Input:** `{}`

**Output (success):** `success`, `snapshot` (`updatedAt`, `mainlandCount`, `overseaCount`, `total`), `workflowHint` (points to bounded `probe_nodes_list` usage before batch start).

**Output (Boce error):** `success: false`, `error`, `errorCode`.

---

#### 2) `probe_nodes_list`

Reads the node cache for choosing `nodeIds` before probing. Designed for **overflow protection**: avoid returning hundreds of nodes in a single tool response.

**Input schema (summary):**

- `refresh` (boolean, optional) — refresh cache from Boce before read
- `detail` (string, optional) — `"summary"` \| `"list"`; default **`list`**
- `area` (string, optional) — `"mainland"` \| `"oversea"`
- `query` (string, optional, max 64) — ranked keyword search
- `search` (string, optional, max 64) — backward-compatible alias for `query`
- `limit` (integer, optional, 1..1000) — requested page size; **server clamps to 100 per response** (see `overflowProtection`)
- `offset` (integer, optional, default `0`) — pagination start index
- `nodeId` (integer, optional) — if set, returns a **single-node lookup** instead of list/summary (other list fields omitted)

**`detail: "summary"`** — Counts and hints only; **no `nodes` array**. Use first to see cache size and matched filter size without blowing context.

**`detail: "list"`** — Returns a page of compact nodes: `id`, `nodeName`, `ispName`, `area`, `region`. Includes:

- `totalMatched`, `returned`, `truncated`, `nextOffset` (when more pages exist)
- `overflowProtection`: `defaultListLimit` (30), `maxNodesPerResponse` (100), `requestedLimit`, `appliedLimit`, `clamped`

**Example calls (Cursor chat):**

```text
Call MCP tool probe_nodes_list with {"detail":"summary","refresh":true} and print raw output only.
Call MCP tool probe_nodes_list with {"detail":"list","area":"oversea","query":"gd mobile","limit":30,"offset":0} and print raw output only.
Call MCP tool probe_nodes_list with {"nodeId":31} and print raw output only.
```

---

#### 3) `probe_domains_batch_start`

Starts async HTTP probe batch task.

**Input schema (summary):**

- `domains` (string[], required, 1..20)
- `nodeIds` (string, optional)
- `ipWhitelist` (string[], optional)
- `pollInterval` (number, optional, milliseconds, default `10000`)

**Example call:**

```text
Call MCP tool probe_domains_batch_start with {"domains":["www.baidu.com","www.qq.com"],"nodeIds":"31,32"} and print raw output only.
```

**Output shape:**

```json
{ "taskId": "abc123", "status": "pending", "stage": "QUEUED", "warnings": [] }
```

#### 4) `probe_domains_batch_status`

Returns current progress and next polling hint.

**Input schema (summary):**

- `taskId` (string, required)

**Example output (running):**

```json
{
  "taskId": "abc123",
  "status": "running",
  "progress": 50,
  "completed": ["a.com"],
  "remaining": ["b.com"],
  "pollInterval": 10000,
  "nextStep": {
    "action": "call_tool",
    "tool": "probe_domains_batch_status",
    "arguments": { "taskId": "abc123" },
    "schedule": { "delayMs": 6663 }
  }
}
```

`delayMs` is derived from `pollInterval` (base), batch size, and share of domains still `remaining` (nearing the end, polls tighten). Clamped between 2s and 60s. `pollInterval` is always the client-provided base from `probe_domains_batch_start`.

**Example output (completed — fetch final report next):** `pollInterval` is omitted. `nextStep` points to `probe_domains_batch_result` (no `schedule`).

**Example output (failed — fatal batch error):** same `nextStep` shape as completed: call `probe_domains_batch_result` to read `errors` (includes `batch_runtime` if applicable).

**Unknown task:**

```json
{ "taskId": "…", "found": false, "error": "TASK_NOT_FOUND" }
```

#### 5) `probe_domains_batch_result`

Returns final **minimal MCP comparison payload** when completed/failed; while running it returns status + nextStep.

**Input schema (summary):**

- `taskId` (string, required)

**Example output (completed):**

```json
{
  "taskId": "abc123",
  "status": "completed",
  "stage": "COMPLETED",
  "warnings": [],
  "compactComparisons": [
    {
      "domain": "https://example.com/play",
      "lines": [
        "Guangdong Mobile / 0.21s / status 200 / 162.209.175.250",
        "Guangdong Unicom / 0.29s / status 200 / 192.151.192.11",
        "Guangdong Telecom / 0.44s / status 200 / 172.247.18.166"
      ]
    }
  ]
}
```

`compactComparisons` rules:

- Group by `domain` (full URL target).
- Within a domain, group probe rows by line key (`nodeName + ispName`).
- Latency per line is averaged (`avg(latencyMs)`), converted to seconds with 2 decimals.
- Status code / response IP are representative latest values for the line group.
- Output lines are sorted by latency ascending for direct side-by-side comparison.

### MCP output design note

MCP responses are intentionally compressed to prevent context overflow and keep MCP output directly comparable.

---

## Recommended test order

| # | Method | Path | Purpose |
|---|--------|------|--------|
| 1 | GET | `/health` | Liveness |
| 2 | POST | `/api/detect` | Single URL detection (sync) |
| 3 | POST | `/api/detect?async=1` | Single URL detection (async) |
| 4 | GET | `/api/detect/jobs/:jobId` | Async job status/result |
| 5 | GET | `/api/detect/results/:requestId` | Full stored result by ID |
| 6 | GET | `/api/detect/history?url=...&limit=...` | Lightweight history list (ID retrieval) |
| 7 | POST | `/api/batch-detect` | Batch submit (波点 pre-check, 100/5000 domains) |
| 8 | GET | `/api/batch-detect/:jobId` | Batch job progress |
| 9 | GET | `/api/batch-detect/:jobId/items` | Batch job items (per-domain status) |
| 10 | POST | `/api/batch-detect/:jobId/pause` | Pause batch dispatch |
| 11 | POST | `/api/batch-detect/:jobId/resume` | Resume batch dispatch |
| 12 | POST | `/api/batch-detect/:jobId/cancel` | Cancel pending/queued batch items |
| 13 | POST | `/api/batch-detect/:jobId/priority` | Change batch priority |
| 14 | GET | `/api/dev/check-env` *(dev only)* | Verify runtime env visibility |
| 15 | GET | `/api/dev/create-task` *(dev only)* | Create Boce task directly |
| 16 | GET | `/api/dev/get-result` *(dev only)* | Get Boce result once |
| 17 | GET | `/api/dev/poll-result` *(dev only)* | Poll Boce result until done |
| 18 | GET | `/api/dev/run-detection` *(dev only)* | One-call create + poll |
| 19 | GET | `/api/dev/nodes` *(dev only)* | Node cache snapshot |
| 20 | POST | `/api/dev/nodes/refresh` *(dev only)* | Refresh node cache |
| 21 | GET | `/api/dev/nodes/lookup` *(dev only)* | Lookup node metadata |

---

## Task scheduling (core): how we handle 5000 domains

Task scheduling is the core of the batch API. Here is how the system handles up to **5000 domains** without timeouts or blocking.

1. **One scan job, DB-first task records**  
   `POST /api/batch-detect` creates a single **scan job** in the database (with `total_items`, `finished_items`, etc.) and inserts one row per domain in `scan_job_domains` as `PENDING`.
   Dispatcher then periodically fetches pending rows and submits BullMQ jobs to `batch-domain` queue by priority.  
   For 5000 domains: 1 scan job + 5000 DB task rows, then queue jobs are produced in dispatch cycles.

2. **DB-first producer/consumer scheduling**  
   - `scan_job_domains` rows are inserted in DB chunks of **2000** per SQL write.  
   - Dispatcher periodically fetches `PENDING` rows from DB (ordered by priority) and enqueues them to Redis queue.  
   - This gives operational control (pause/cancel/priority) from DB state while keeping queue as execution layer.

3. **Worker concurrency**  
   A single worker process runs with **concurrency** `QUEUE_CONCURRENCY` (default 5). So at any time up to N domains are being processed (each: create Boce task → poll result → normalize → save detection → update scan job counters). For faster completion of 5000 domains, increase `QUEUE_CONCURRENCY` (e.g. 10–20), respecting Boce rate limits and your own CPU/network.

4. **Progress and recovery**  
   - **Progress:** `GET /api/batch-detect/:jobId` returns `finishedItems`, `successItems`, `failedItems`, and `status` (`PENDING`/`RUNNING`/`PAUSED` → terminal).  
   - **Per-domain status:** `GET /api/batch-detect/:jobId/items?status=FAILED` lists failed domains for retry or inspection.  
   - **Recovery:** Jobs and progress live in Redis (BullMQ) and Postgres. After a restart, the worker continues processing remaining jobs; the scan job row stays consistent via `finished_items` / `success_items` / `failed_items` updates.

5. **Predictable cost**  
   Before accepting the batch, the API calls Boce 波点查询 (`/v3/balance`). If available points are less than `domains.length × nodeIds.length`, the request fails with **402** and does not enqueue. Fee is 1 node = 1 point per domain task.

**Summary for 5000 domains:** The API returns quickly after persisting DB tasks; dispatcher enqueues by priority in cycles; workers process with controlled concurrency; progress is visible via batch job/items endpoints; and 波点 is checked up front.

6. **Webhook priority and usage**  
   Webhook URL priority is: **task-level `webhookUrl` > client-level default webhook > app-level `APP_WEBHOOK_URL`**.  
   App-level webhooks are useful as platform default. Task-level override is for application-specific integration.

**Single-domain testing is not blocked by batch.** Single-domain requests use the **`detect`** queue (or run synchronously in the request); batch domain items use the **`batch-domain`** queue. They are processed by separate workers, so you can run `POST /api/detect` or `POST /api/detect?async=1` for one domain at any time, even while a 5000-domain batch is running.

---

## Authentication (commercial mode)

When `AUTH_ENABLED=true`, these business endpoints require headers:

- `X-Client-Id: <client id>`
- `X-Api-Key: <api key>`

Protected routes:
- `/api/detect/*`
- `/api/batch-detect/*`
- `/api/analytics/*`

Health and dev routes are unchanged (`/health`, `/api/dev/*`).

Bootstrap (first client) is configured via env:
- `BOOTSTRAP_CLIENT_ID`
- `BOOTSTRAP_CLIENT_NAME`
- `BOOTSTRAP_API_KEY`

Static mode (single fixed key/client, no DB lookup):
- `AUTH_STATIC_MODE=true`
- `AUTH_STATIC_CLIENT_ID`
- `AUTH_STATIC_API_KEY`
- optional: `AUTH_STATIC_MAX_BATCH_SIZE`, `AUTH_STATIC_DEFAULT_WEBHOOK_URL`

Example with headers:

```bash
curl -X POST "http://localhost:3000/api/detect" ^
  -H "Content-Type: application/json" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key" ^
  -d "{\"url\":\"www.baidu.com\",\"nodeIds\":\"31,32\"}"
```

Optional reliability header for batch submit retries:
- `X-Idempotency-Key: <unique key from your client>`

Admin routes use separate header:
- `X-Admin-Token: <ADMIN_TOKEN>`
- `/api/admin/*` does not use `X-Client-Id` / `X-Api-Key`

---

## 1. Health

### `GET /`

Service metadata endpoint.

```bash
curl "http://localhost:3000/"
```

Example response:

```json
{
  "name": "Boce Aggregated API System",
  "version": "0.1.0",
  "docs": { "health": "/health", "detect": "POST /api/detect" }
}
```

### `GET /health`

**Purpose:** Liveness check. No auth.

**Request:** None.

**Example:**

```bash
curl "http://localhost:3000/health"
```

**Response (200):**

```text
OK
```

---

## 2. Single detection (sync)

### `POST /api/detect`

**Purpose:** Run one Boce HTTP detection (create task + poll until done), normalize, compute metrics and anomalies, return full result. Result is stored; use `requestId` for `GET /api/detect/results/:requestId`.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| url | string | Yes | Host/URL to test (e.g. `www.baidu.com`) |
| nodeIds | string | No | Comma-separated Boce node IDs; default `31,32` |
| ipWhitelist | string[] | No | Allowed response IPs; mismatches become anomalies |

**Example:**

```bash
curl -X POST "http://localhost:3000/api/detect" ^
  -H "Content-Type: application/json" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key" ^
  -d "{\"url\":\"www.baidu.com\",\"nodeIds\":\"31,32\",\"ipWhitelist\":[\"157.148.69.186\"]}"
```

**Response (200):**

```json
{
  "success": true,
  "mode": "sync",
  "data": {
    "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
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
    "anomalies": [],
    "summary": {
      "overallStatus": "HEALTHY",
      "message": "All probes successful."
    }
  }
}
```

**Error (400, Boce/workflow):**

```json
{
  "success": false,
  "error": "Boce API error message",
  "kind": "INSUFFICIENT_POINTS",
  "errorCode": 3,
  "boceError": ""
}
```

---

## 3. Single detection (async)

### `POST /api/detect?async=1`

**Purpose:** Enqueue one detection job; returns immediately. Poll `GET /api/detect/jobs/:jobId` for status and result.

**Request body:** Same as sync (`url`, optional `nodeIds`, `ipWhitelist`).

**Example:**

```bash
curl -X POST "http://localhost:3000/api/detect?async=1" ^
  -H "Content-Type: application/json" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key" ^
  -d "{\"url\":\"www.baidu.com\",\"nodeIds\":\"31,32\"}"
```

**Response (202):**

```json
{
  "success": true,
  "mode": "async",
  "jobId": "123",
  "statusUrl": "/api/detect/jobs/123"
}
```

---

## 4. Async job status

### `GET /api/detect/jobs/:jobId`

**Purpose:** Get BullMQ job state and, when completed, the full detection result.

**Example:**

```bash
curl "http://localhost:3000/api/detect/jobs/123" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key"
```

**Response (200, completed):**

```json
{
  "success": true,
  "jobId": "123",
  "state": "completed",
  "attemptsMade": 1,
  "progress": 100,
  "failedReason": null,
  "result": {
    "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "url": "www.baidu.com",
    "taskId": "20260318_xxx",
    "timestamp": "2026-03-18T07:16:00.677Z",
    "probes": [],
    "availability": { "regional": [], "global": { "total": 2, "success": 2, "availabilityRate": 1 } },
    "anomalies": [],
    "summary": { "overallStatus": "HEALTHY", "message": "All probes successful." }
  }
}
```

**Response (200, waiting/failed):** Same shape; `state` may be `waiting`, `active`, `failed`; `result` null until completed; `failedReason` set on failure.

**Response (404):**

```json
{
  "success": false,
  "error": "Job not found"
}
```

---

## 5. Stored result by ID

### `GET /api/detect/results/:requestId`

**Purpose:** Fetch full stored detection result by `requestId` (from sync response or async job `result.requestId`). Use after history list to load full payload by ID.

**Example:**

```bash
curl "http://localhost:3000/api/detect/results/a1b2c3d4-e5f6-7890-abcd-ef1234567890" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key"
```

**Response (200):**

```json
{
  "success": true,
  "data": {
    "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "url": "www.baidu.com",
    "taskId": "20260318_xxx",
    "timestamp": "2026-03-18T07:16:00.677Z",
    "probes": [],
    "availability": { "regional": [], "global": { "total": 2, "success": 2, "availabilityRate": 1 } },
    "anomalies": [],
    "summary": { "overallStatus": "HEALTHY", "message": "All probes successful." }
  }
}
```

**Response (404):**

```json
{
  "success": false,
  "error": "Not found"
}
```

---

## 6. History (lightweight list, ID retrieval)

### `GET /api/detect/history?url=...&limit=...&cursor=...`

**Purpose:** List stored detection entries for a URL, newest first. Returns **lightweight rows** (IDs + summary fields), not full `result_json`. Use `requestId` with `GET /api/detect/results/:requestId` to load full result.

**Query parameters:**

| Name | Required | Description |
|------|----------|-------------|
| url | Yes | URL exactly as used in `POST /api/detect` |
| limit | No | 1–200, default 20 |
| cursor | No | Pagination: `createdAt|requestId` from previous `nextCursor` |

**Example (first page):**

```bash
curl "http://localhost:3000/api/detect/history?url=www.baidu.com&limit=20" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key"
```

**Example (next page):**

```bash
curl "http://localhost:3000/api/detect/history?url=www.baidu.com&limit=20&cursor=2026-03-17T02:10:11.000Z|a1b2c3d4-1111-2222-3333-444455556666" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key"
```

**Response (200):**

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

When there are more pages, `nextCursor` is a string like `2026-03-17T02:10:11.000Z|a1b2c3d4-1111-2222-3333-444455556666`; pass it as the `cursor` query parameter for the next page.

**Response (400, missing url):**

```json
{
  "success": false,
  "error": "Missing query: url"
}
```

---

## 7. Batch submit (波点 pre-check, 100/5000 domains)

### `POST /api/batch-detect`

**Purpose:** Submit a batch of domains for detection. Uses Boce **波点查询** (`/v3/balance`) to pre-check points; fails with 402 if estimated points exceed available. Fee is predictable: 1 node × 1 point per domain. Max 5000 domains per request. **Task scheduling:** this endpoint persists tasks to DB first (`PENDING`), then dispatcher moves tasks from DB to queue by priority; see [Task scheduling (core): how we handle 5000 domains](#task-scheduling-core-how-we-handle-5000-domains) above.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| domains | string[] | Yes | List of host/URLs to test |
| nodeIds | string | Yes | Comma-separated node IDs (e.g. `31,32`) |
| ipWhitelist | string[] | No | Optional IP whitelist per task |
| webhookUrl | string | No | Task-level webhook callback URL (`http/https`) |
| clientId | string | No | Optional application/client identifier for future auth/audit |
| idempotencyKey | string | No | Optional dedupe key for safe retries (or use `X-Idempotency-Key` header) |

**Example:**

```bash
curl -X POST "http://localhost:3000/api/batch-detect" ^
  -H "Content-Type: application/json" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key" ^
  -H "X-Idempotency-Key: batch-001" ^
  -d "{\"domains\":[\"www.baidu.com\",\"www.qq.com\"],\"nodeIds\":\"31,32\",\"ipWhitelist\":[],\"webhookUrl\":\"https://example.com/webhooks/boce\"}"
```

**Response (200):**

```json
{
  "success": true,
  "jobId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "estimatedPoints": 4,
  "totalItems": 2,
  "statusUrl": "/api/batch-detect/b2c3d4e5-f6a7-8901-bcde-f12345678901"
}
```

**Response (400, invalid webhook):**

```json
{
  "success": false,
  "error": "invalid `webhookUrl`"
}
```

**Response (409, idempotency conflict):**

```json
{
  "success": false,
  "error": "Idempotency key is already used with different request payload"
}
```

**Response (200, idempotency replay):**

```json
{
  "success": true,
  "replayed": true,
  "jobId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "statusUrl": "/api/batch-detect/b2c3d4e5-f6a7-8901-bcde-f12345678901"
}
```

**Response (400, bad input):**

```json
{
  "success": false,
  "error": "`domains` is required"
}
```

```json
{
  "success": false,
  "error": "too many domains (max 5000)"
}
```

**Response (402, insufficient 波点):**

```json
{
  "success": false,
  "error": "Insufficient BOCE points",
  "point": 100,
  "estimatedPoints": 200
}
```

**Response (502, balance API failure):**

```json
{
  "success": false,
  "error": "Failed to query BOCE balance"
}
```

---

## 8. Batch job progress

### `GET /api/batch-detect/:jobId`

**Purpose:** Get overall batch job status and progress (for recovery and monitoring).

**Example:**

```bash
curl "http://localhost:3000/api/batch-detect/b2c3d4e5-f6a7-8901-bcde-f12345678901" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key"
```

**Response (200):**

```json
{
  "success": true,
  "jobId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "status": "RUNNING",
  "totalItems": 10,
  "finishedItems": 3,
  "successItems": 2,
  "failedItems": 1,
  "estimatedPoints": 20,
  "lastError": null,
  "createdAt": "2026-03-18T08:00:00.000Z",
  "updatedAt": "2026-03-18T08:01:00.000Z"
}
```

`status` is one of: `PENDING`, `RUNNING`, `PAUSED`, `COMPLETED`, `FAILED`, `CANCELLED`. When `status` is `COMPLETED` or `FAILED` or `CANCELLED`, `finishedItems` is terminal.

**Response (404):**

```json
{
  "success": false,
  "error": "job not found"
}
```

---

## 9. Batch job items (per-domain status)

### `GET /api/batch-detect/:jobId/items?status=...&limit=...`

**Purpose:** List individual domain items in a batch job. Optional filter by `status` for retries or inspection.

**Query parameters:**

| Name | Required | Description |
|------|----------|-------------|
| status | No | Filter: `PENDING`, `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED` |
| limit | No | 1–200, default 50 |

**Example (all items):**

```bash
curl "http://localhost:3000/api/batch-detect/b2c3d4e5-f6a7-8901-bcde-f12345678901/items?limit=50" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key"
```

**Example (failed only):**

```bash
curl "http://localhost:3000/api/batch-detect/b2c3d4e5-f6a7-8901-bcde-f12345678901/items?status=FAILED&limit=50" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key"
```

**Response (200):**

```json
{
  "success": true,
  "items": [
    {
      "id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
      "domain": "www.baidu.com",
      "status": "COMPLETED",
      "requestId": "d4e5f6a7-b8c9-0123-def0-234567890123",
      "taskId": "20260318_xxx",
      "attempts": 1,
      "lastError": null
    },
    {
      "id": "d4e5f6a7-b8c9-0123-def0-234567890124",
      "domain": "www.qq.com",
      "status": "FAILED",
      "requestId": null,
      "taskId": null,
      "attempts": 2,
      "lastError": "Boce API error: 波点不足"
    }
  ]
}
```

**Response (404):** Same as job status (`error: "job not found"`).

---

## 10. Batch control endpoints (commercial operations)

### `POST /api/batch-detect/:jobId/pause`

Pause dispatching new DB-pending items to queue.

```bash
curl -X POST "http://localhost:3000/api/batch-detect/<JOB_ID>/pause" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key"
```

### `POST /api/batch-detect/:jobId/resume`

Resume dispatching for a paused job.

```bash
curl -X POST "http://localhost:3000/api/batch-detect/<JOB_ID>/resume" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key"
```

### `POST /api/batch-detect/:jobId/cancel`

Cancel job and clean DB pending/queued items (already running items are allowed to finish).

```bash
curl -X POST "http://localhost:3000/api/batch-detect/<JOB_ID>/cancel" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key"
```

### `POST /api/batch-detect/:jobId/priority`

Set batch priority (0..100). Dispatcher fetches higher priority first.

```bash
curl -X POST "http://localhost:3000/api/batch-detect/<JOB_ID>/priority" ^
  -H "Content-Type: application/json" ^
  -H "X-Client-Id: demo-client" ^
  -H "X-Api-Key: change_me_to_strong_key" ^
  -d "{\"priority\": 90}"
```

---

## 10.1 Batch completion webhook callback

When a batch reaches terminal state (`COMPLETED`/`FAILED`/`CANCELLED`) and webhook is configured, the system sends:

- **Method:** `POST`
- **Target:** task-level `webhookUrl` if provided, otherwise app-level `APP_WEBHOOK_URL`
- **Event name:** `batch.detect.completed`
- **Headers:**  
  - `X-Boce-Event: batch.detect.completed`  
  - `X-Boce-Signature: sha256=<hmac>` (present when `WEBHOOK_SIGNING_SECRET` is configured)

Receiver verification rule:
- Compute `HMAC_SHA256(rawBody, WEBHOOK_SIGNING_SECRET)`.
- Compare with `X-Boce-Signature` (format: `sha256=<hex>`).

**Payload:**

```json
{
  "event": "batch.detect.completed",
  "sentAt": "2026-03-18T09:00:00.000Z",
  "data": {
    "jobId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    "status": "COMPLETED",
    "totalItems": 2000,
    "finishedItems": 2000,
    "successItems": 1995,
    "failedItems": 5,
    "estimatedPoints": 4000,
    "updatedAt": "2026-03-18T09:00:00.000Z"
  }
}
```

---

## 11. Admin APIs (key management)

These endpoints are for platform operators.
Required header: `X-Admin-Token`.

### `POST /api/admin/clients`

Create or update a client application.

```bash
curl -X POST "http://localhost:3000/api/admin/clients" ^
  -H "Content-Type: application/json" ^
  -H "X-Admin-Token: change_me_admin_token" ^
  -d "{\"clientId\":\"biz-a\",\"name\":\"Business A\",\"defaultWebhookUrl\":\"https://example.com/hook\",\"maxBatchSize\":3000}"
```

### `POST /api/admin/clients/:clientId/keys`

Create API key for a client (plaintext returned once).

```bash
curl -X POST "http://localhost:3000/api/admin/clients/biz-a/keys" ^
  -H "Content-Type: application/json" ^
  -H "X-Admin-Token: change_me_admin_token" ^
  -d "{\"name\":\"prod-key-1\"}"
```

### `POST /api/admin/keys/:keyId/revoke`

Revoke API key.

```bash
curl -X POST "http://localhost:3000/api/admin/keys/12/revoke" ^
  -H "X-Admin-Token: change_me_admin_token"
```

---

## 12. Analytics APIs (business-level summary)

### `GET /api/analytics/clients/:clientId/monthly?month=YYYY-MM`

Returns business category stats for a month:
- `totalChecks`
- `uniqueDomains`
- `avgAvailabilityRate`

```bash
curl "http://localhost:3000/api/analytics/clients/biz-a/monthly?month=2026-03" ^
  -H "X-Client-Id: biz-a" ^
  -H "X-Api-Key: <biz-a-key>"
```

Example response:

```json
{
  "success": true,
  "clientId": "biz-a",
  "month": "2026-03",
  "totalChecks": 12500,
  "uniqueDomains": 3200,
  "avgAvailabilityRate": 0.9823
}
```

---

## 13. Dev APIs (development only)

Available when `NODE_ENV=development`.

### `GET /api/dev/check-env`

Check whether runtime can see key/base URL values (masked-style diagnostics).

```bash
curl "http://localhost:3000/api/dev/check-env"
```

### `GET /api/dev/create-task?host=...&node_ids=...`

Create Boce task directly and return task ID.

```bash
curl "http://localhost:3000/api/dev/create-task?host=www.baidu.com&node_ids=31,32"
```

### `GET /api/dev/get-result?taskId=...`

Fetch Boce result once (`done` may be false).

```bash
curl "http://localhost:3000/api/dev/get-result?taskId=<TASK_ID>"
```

### `GET /api/dev/poll-result?taskId=...`

Poll Boce result until done.

```bash
curl "http://localhost:3000/api/dev/poll-result?taskId=<TASK_ID>"
```

### `GET /api/dev/run-detection?host=...&node_ids=...`

One-call create + poll helper.

```bash
curl "http://localhost:3000/api/dev/run-detection?host=www.baidu.com&node_ids=31,32"
```

### `GET /api/dev/nodes`

**Purpose:** Node cache snapshot (mainland + oversea).

**Example:**

```bash
curl "http://localhost:3000/api/dev/nodes"
```

**Response (200):** JSON with node list metadata (structure depends on cache implementation).

### `POST /api/dev/nodes/refresh`

**Purpose:** Trigger node list refresh now.

### `GET /api/dev/nodes/lookup?nodeId=31`

**Purpose:** Get metadata for one node ID.

---

## Error responses (common)

### Rate limiting (429)

```json
{
  "success": false,
  "error": "Rate limit exceeded"
}
```

Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Window`.

### Not found (404)

```json
{
  "success": false,
  "error": "Not found"
}
```

(or `"Job not found"`, `"job not found"` depending on endpoint)

### Server error (500)

```json
{
  "error": "Internal Server Error",
  "message": "Optional detail"
}
```

---

## Boce error codes (reference)

| error_code | Meaning (Boce) |
|-----------:|----------------|
| -1 | 节点异常 (node error) |
| 0 | 成功 |
| 1 | 鉴权失败 (auth fail) |
| 2 | 参数错误 (parameter error) |
| 3 | 波点不足或波点未配置 (insufficient points) |
| 4 | 生成任务id失败或任务id失效 (task id failed/expired) |

**Our workflow `kind` (returned on 400 by `POST /api/detect`):** `AUTH_FAILED`, `PARAM_ERROR`, `INSUFFICIENT_POINTS`, `TASK_ID_FAILED_OR_EXPIRED`, `NODE_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, `UNKNOWN`.
