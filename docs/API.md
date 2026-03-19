# Boce Aggregated API — Complete API Documentation

Base URL for all examples: **`http://localhost:3000`** (or your deployed host).

This document lists every endpoint **in the recommended order to test** (health → single detect → storage → batch detect).

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
| 10 | GET | `/api/dev/nodes` *(dev only)* | Node cache snapshot |

---

## Task scheduling (core): how we handle 5000 domains

Task scheduling is the core of the batch API. Here is how the system handles up to **5000 domains** without timeouts or blocking.

1. **One scan job, many queue jobs**  
   `POST /api/batch-detect` creates a single **scan job** in the database (with `total_items`, `finished_items`, etc.) and inserts one row per domain in `scan_job_domains`. It then enqueues **one BullMQ job per domain** into the `batch-domain` queue. So 5000 domains ⇒ 1 scan job + 5000 queue jobs.

2. **Bulk enqueue (no 5k sequential round-trips)**  
   All domain jobs are added via **BullMQ `addBulk()`** in chunks of 1000. The HTTP request does **not** wait for 5000 sequential Redis calls: it creates the scan job, runs a few bulk adds, and returns immediately with `jobId` and `statusUrl`. Clients can poll `GET /api/batch-detect/:jobId` for progress.

3. **Worker concurrency**  
   A single worker process runs with **concurrency** `QUEUE_CONCURRENCY` (default 5). So at any time up to N domains are being processed (each: create Boce task → poll result → normalize → save detection → update scan job counters). For faster completion of 5000 domains, increase `QUEUE_CONCURRENCY` (e.g. 10–20), respecting Boce rate limits and your own CPU/network.

4. **Progress and recovery**  
   - **Progress:** `GET /api/batch-detect/:jobId` returns `finishedItems`, `successItems`, `failedItems`, and `status` (`PENDING` → `RUNNING` → `COMPLETED`/`FAILED`).  
   - **Per-domain status:** `GET /api/batch-detect/:jobId/items?status=FAILED` lists failed domains for retry or inspection.  
   - **Recovery:** Jobs and progress live in Redis (BullMQ) and Postgres. After a restart, the worker continues processing remaining jobs; the scan job row stays consistent via `finished_items` / `success_items` / `failed_items` updates.

5. **Predictable cost**  
   Before accepting the batch, the API calls Boce 波点查询 (`/v3/balance`). If available points are less than `domains.length × nodeIds.length`, the request fails with **402** and does not enqueue. Fee is 1 node = 1 point per domain task.

**Summary for 5000 domains:** The API returns quickly after bulk-enqueuing 5000 jobs; the worker processes them at a controlled concurrency; progress is visible via the batch job and items endpoints; and 波点 is checked up front.

**Single-domain testing is not blocked by batch.** Single-domain requests use the **`detect`** queue (or run synchronously in the request); batch domain items use the **`batch-domain`** queue. They are processed by separate workers, so you can run `POST /api/detect` or `POST /api/detect?async=1` for one domain at any time, even while a 5000-domain batch is running.

---

## 1. Health

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
curl "http://localhost:3000/api/detect/jobs/123"
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
curl "http://localhost:3000/api/detect/results/a1b2c3d4-e5f6-7890-abcd-ef1234567890"
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
curl "http://localhost:3000/api/detect/history?url=www.baidu.com&limit=20"
```

**Example (next page):**

```bash
curl "http://localhost:3000/api/detect/history?url=www.baidu.com&limit=20&cursor=2026-03-17T02:10:11.000Z|a1b2c3d4-1111-2222-3333-444455556666"
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

**Purpose:** Submit a batch of domains for detection. Uses Boce **波点查询** (`/v3/balance`) to pre-check points; fails with 402 if estimated points exceed available. Fee is predictable: 1 node × 1 point per domain. Max 5000 domains per request. **Task scheduling:** domains are enqueued in bulk (BullMQ `addBulk` in chunks of 1000), so the API returns quickly even for 5000 domains; see [Task scheduling (core): how we handle 5000 domains](#task-scheduling-core-how-we-handle-5000-domains) above.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| domains | string[] | Yes | List of host/URLs to test |
| nodeIds | string | Yes | Comma-separated node IDs (e.g. `31,32`) |
| ipWhitelist | string[] | No | Optional IP whitelist per task |

**Example:**

```bash
curl -X POST "http://localhost:3000/api/batch-detect" ^
  -H "Content-Type: application/json" ^
  -d "{\"domains\":[\"www.baidu.com\",\"www.qq.com\"],\"nodeIds\":\"31,32\",\"ipWhitelist\":[]}"
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
curl "http://localhost:3000/api/batch-detect/b2c3d4e5-f6a7-8901-bcde-f12345678901"
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

`status` is one of: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`. When `status` is `COMPLETED` or `FAILED`, `finishedItems` equals `totalItems`.

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
| status | No | Filter: `PENDING`, `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED` |
| limit | No | 1–200, default 50 |

**Example (all items):**

```bash
curl "http://localhost:3000/api/batch-detect/b2c3d4e5-f6a7-8901-bcde-f12345678901/items?limit=50"
```

**Example (failed only):**

```bash
curl "http://localhost:3000/api/batch-detect/b2c3d4e5-f6a7-8901-bcde-f12345678901/items?status=FAILED&limit=50"
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

## 10. Dev: node list (development only)

Available when `NODE_ENV=development`.

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
