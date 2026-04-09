import { randomUUID } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Request, Response } from 'express';
import { z } from 'zod';
import { config, getMcpAllowedHostsForExpress } from '../config';
import { detectOnce } from '../services/detection/detect';
import { BoceApiError, nodeCache, refreshNodeCache } from '../services/boce';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const ADAPTIVE_POLL_MIN_MS = 2_000;
const ADAPTIVE_POLL_MAX_MS = 60_000;

/** MCP node list: small default + hard per-response cap to avoid context overflow (hundreds of nodes). */
const MCP_NODE_LIST_DEFAULT_LIMIT = 30;
const MCP_NODE_LIST_MAX_PER_RESPONSE = 100;
const MCP_NODE_RESOURCE_DEFAULT_LIMIT = 20;

type BatchTaskStatus = 'pending' | 'running' | 'completed' | 'failed';
type BatchTaskStage = 'QUEUED' | 'CONNECTING' | 'PROBING' | 'COMPLETED' | 'TIMEOUT';

type DomainResult = {
  domain: string;
  finalStatus: 'HEALTHY' | 'ATTENTION_REQUIRED';
  availabilityRate: number;
  flag: string;
  nodeCompact?: string;
  lineComparisons: Array<{
    nodeId?: number;
    nodeName?: string;
    ispName?: string;
    region?: string;
    statusCode?: number;
    latencyMs?: number;
    responseIp?: string;
    boceError?: string;
  }>;
};

type BatchTask = {
  taskId: string;
  status: BatchTaskStatus;
  stage: BatchTaskStage;
  domains: string[];
  nodeIds?: string;
  ipWhitelist?: string[];
  pollInterval: number;
  completed: string[];
  remaining: string[];
  results: DomainResult[];
  errors: { domain: string; error: string }[];
  progress: number;
  updatedAt: number;
  warnings: string[];
};

const batchTasks = new Map<string, BatchTask>();

function getAuthTokenFromRequest(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice('bearer '.length).trim();
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string') return apiKey.trim();
  if (config.mcp.authAllowQueryToken) {
    const queryToken = req.query?.mcp_auth_token;
    if (typeof queryToken === 'string') return queryToken.trim();
  }
  return undefined;
}

function rejectUnauthorized(res: Response): void {
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null,
  });
}

function getMcpSessionIdFromRequest(req: Request): string | undefined {
  const h = req.headers;
  const candidates = ['mcp-session-id', 'x-mcp-session-id'] as const;
  for (const name of candidates) {
    const v = h[name];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && v[0]?.trim()) return v[0].trim();
  }
  return undefined;
}

function sendMcpSessionRequired(res: Response, method: 'GET' | 'DELETE'): void {
  res.status(400).json({
    error: 'MCP_SESSION_REQUIRED',
    message:
      method === 'GET'
        ? 'Streamable HTTP requires POST /mcp with JSON-RPC initialize first; the response sets Mcp-Session-Id. This GET is for the SSE stream only after a session exists.'
        : 'DELETE /mcp requires a valid Mcp-Session-Id header from an active session.',
    healthCheckUrl: '/mcp/health',
    hint: 'For uptime/load balancers use GET /mcp/health (no session). For multi-pod deployments use sticky sessions or a single MCP replica — sessions are in-memory per process.',
  });
}

function ensureHttpAuth(req: Request, res: Response): boolean {
  if (!config.mcp.authEnabled) return true;
  if (!config.mcp.authToken) {
    // Misconfiguration: enabled auth but no token set.
    res.status(503).json({
      jsonrpc: '2.0',
      error: { code: -32002, message: 'MCP auth misconfigured on server' },
      id: null,
    });
    return false;
  }
  const token = getAuthTokenFromRequest(req);
  if (!token || token !== config.mcp.authToken) {
    rejectUnauthorized(res);
    return false;
  }
  return true;
}

function normalizeProbeTarget(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('url/domain is required');
  const looksLikeUrl = raw.includes('://') || raw.includes('/') || raw.includes('?');
  const withScheme = raw.includes('://') ? raw : `https://${raw}`;
  const parsed = new URL(withScheme);
  if (!parsed.hostname) throw new Error('invalid domain');
  // Keep full URL (path/query) for URL-like input; keep host-only style for host input.
  if (looksLikeUrl) {
    parsed.hash = '';
    return parsed.toString();
  }
  return parsed.hostname;
}

/** Same normalized target only once per batch; preserves first-seen order. */
function dedupeNormalizedTargets(targets: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of targets) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function compactLatency(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-';
  return `${(ms / 1000).toFixed(1)}s`;
}

function toNodeLine(node: {
  nodeName?: string;
  ispName?: string;
  region?: string;
  latencyMs?: number;
  statusCode?: number;
  responseIp?: string;
  boceError?: string;
}): string {
  const place = node.nodeName ?? node.ispName ?? node.region ?? 'node';
  const latency = compactLatency(node.latencyMs);
  const status = node.statusCode ?? '-';
  const ip = node.responseIp ?? '-';
  const err = node.boceError ? ` / err ${node.boceError}` : '';
  return `${place} / ${latency} / status ${status} / ${ip}${err}`;
}

function toEnglishNodeLabel(nodeName?: string, ispName?: string): string {
  const nodeMap: Record<string, string> = {
    广东: 'Guangdong',
  };
  const ispMap: Record<string, string> = {
    移动: 'Mobile',
    联通: 'Unicom',
    电信: 'Telecom',
  };
  const n = nodeName ? (nodeMap[nodeName] ?? nodeName) : 'Unknown';
  const i = ispName ? (ispMap[ispName] ?? ispName) : '';
  return `${n}${i ? ` ${i}` : ''}`.trim();
}

function toEnglishRegion(nodeName?: string): string {
  const nodeMap: Record<string, string> = {
    广东: 'Guangdong',
  };
  if (!nodeName) return 'Unknown';
  return nodeMap[nodeName] ?? nodeName;
}

function toEnglishIsp(ispName?: string): string {
  const ispMap: Record<string, string> = {
    移动: 'Mobile',
    联通: 'Unicom',
    电信: 'Telecom',
  };
  if (!ispName) return 'Unknown';
  return ispMap[ispName] ?? ispName;
}

function toNodeSelectionLabel(nodeId: number, nodeName?: string, ispName?: string): string {
  return `${toEnglishNodeLabel(nodeName, ispName)} (nodeId: ${nodeId})`;
}

function tokenizeSearchText(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function expandSearchToken(token: string): string[] {
  const aliasMap: Record<string, string[]> = {
    gd: ['guangdong', '广东'],
    guangdong: ['gd', '广东'],
    mobile: ['移动', 'yd'],
    yd: ['mobile', '移动'],
    unicom: ['联通', 'lt'],
    lt: ['unicom', '联通'],
    telecom: ['电信', 'dx'],
    dx: ['telecom', '电信'],
  };
  return [token, ...(aliasMap[token] ?? [])];
}

function scoreNodeForQuery(
  query: string,
  node: { id: number; nodeName: string; ispName: string; region: string; area: string }
): number {
  const queryTokens = tokenizeSearchText(query);
  if (queryTokens.length === 0) return 0;

  const region = toEnglishRegion(node.nodeName).toLowerCase();
  const isp = toEnglishIsp(node.ispName).toLowerCase();
  const label = toNodeSelectionLabel(node.id, node.nodeName, node.ispName).toLowerCase();
  const haystack = `${node.nodeName} ${node.ispName} ${region} ${isp} ${node.region} ${node.area} ${node.id} ${label}`.toLowerCase();
  const candidateTokens = new Set(tokenizeSearchText(haystack));

  let score = 0;
  let coveredTokens = 0;
  for (const qt of queryTokens) {
    const expanded = expandSearchToken(qt);
    let matched = false;
    for (const token of expanded) {
      if (candidateTokens.has(token)) {
        score += 6;
        matched = true;
        break;
      }
      if (region.startsWith(token) || isp.startsWith(token)) {
        score += 4;
        matched = true;
        break;
      }
      if (haystack.includes(token)) {
        score += 2;
        matched = true;
        break;
      }
    }
    if (matched) coveredTokens += 1;
  }
  if (coveredTokens === queryTokens.length) score += 10;
  if (haystack.includes(query.toLowerCase())) score += 4;
  return score;
}

function parsePositiveIntOrDefault(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const n = Number.parseInt(input, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function safeDecodeQueryValue(input: string | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Suggested wait before next `probe_domains_batch_status` call.
 * Larger batches stretch delay slightly; fewer domains remaining tightens it (faster finish detection).
 * Clamped to [ADAPTIVE_POLL_MIN_MS, ADAPTIVE_POLL_MAX_MS]. `pollInterval` is the base from the client.
 */
function computeStatusPollDelayMs(task: BatchTask): number {
  const base = task.pollInterval;
  const n = Math.max(1, task.domains.length);
  const remaining = task.remaining.length;
  const remainingRatio = remaining / n;
  const batchWeight = 1 + Math.min(0.4, (n - 1) * 0.025);
  const urgency = 0.3 + 0.7 * remainingRatio;
  const raw = base * batchWeight * urgency;
  return Math.round(Math.min(ADAPTIVE_POLL_MAX_MS, Math.max(ADAPTIVE_POLL_MIN_MS, raw)));
}

function statusPayload(task: BatchTask): Record<string, unknown> {
  const base: Record<string, unknown> = {
    taskId: task.taskId,
    status: task.status,
    stage: task.stage,
    progress: task.progress,
    completed: task.completed,
    remaining: task.remaining,
    warnings: task.warnings,
  };

  if (task.status === 'pending' || task.status === 'running') {
    const delayMs = computeStatusPollDelayMs(task);
    base.pollInterval = task.pollInterval;
    base.nextStep = {
      action: 'call_tool',
      tool: 'probe_domains_batch_status',
      arguments: { taskId: task.taskId },
      schedule: { delayMs },
    };
    return base;
  }

  if (task.status === 'completed') {
    base.nextStep = {
      action: 'call_tool',
      tool: 'probe_domains_batch_result',
      arguments: { taskId: task.taskId },
    };
    return base;
  }

  if (task.status === 'failed') {
    base.nextStep = {
      action: 'call_tool',
      tool: 'probe_domains_batch_result',
      arguments: { taskId: task.taskId },
    };
  }

  return base;
}

async function probeOneDomain(targetUrl: string, nodeIds?: string, ipWhitelist?: string[]): Promise<DomainResult> {
  const url = normalizeProbeTarget(targetUrl);
  const probe = await detectOnce({ url, nodeIds, ipWhitelist });
  const availabilityRate = Number(probe.availability.global.availabilityRate.toFixed(4));
  const isHealthy = probe.summary.overallStatus === 'HEALTHY';
  const anomalyProbe = probe.probes.find(
    (p) => (p.statusCode ?? 0) < 200 || (p.statusCode ?? 0) >= 300 || !!p.boceError
  );
  // Always expose one representative node line (healthy or not) so ops can see status/latency quickly.
  const representativeProbe = anomalyProbe ?? probe.probes[0];
  const nodeCompact = representativeProbe ? toNodeLine(representativeProbe) : undefined;
  const lineComparisons = probe.probes
    .map((p) => ({
      nodeId: p.nodeId,
      nodeName: p.nodeName,
      ispName: p.ispName,
      region: p.region,
      statusCode: p.statusCode,
      latencyMs: p.latencyMs,
      responseIp: p.responseIp,
      boceError: p.boceError || undefined,
    }))
    .sort((a, b) => {
      const ax = typeof a.latencyMs === 'number' ? a.latencyMs : Number.POSITIVE_INFINITY;
      const bx = typeof b.latencyMs === 'number' ? b.latencyMs : Number.POSITIVE_INFINITY;
      return ax - bx;
    });
  return {
    domain: url,
    finalStatus: isHealthy ? 'HEALTHY' : 'ATTENTION_REQUIRED',
    availabilityRate,
    flag: isHealthy ? '-' : `probe_status=${probe.summary.overallStatus}`,
    nodeCompact,
    lineComparisons,
  };
}

async function runBatchTask(taskId: string): Promise<void> {
  const task = batchTasks.get(taskId);
  if (!task) return;
  task.status = 'running';
  task.stage = 'CONNECTING';
  task.updatedAt = Date.now();

  try {
    let sawTimeout = false;
    for (const domain of task.domains) {
      task.stage = 'PROBING';
      try {
        const result = await probeOneDomain(domain, task.nodeIds, task.ipWhitelist);
        task.results.push(result);
        task.completed.push(result.domain);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown_error';
        if (msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('did not complete within')) {
          sawTimeout = true;
        }
        task.errors.push({ domain, error: msg });
      }
      // task.domains and task.remaining are already normalized at batch_start.
      task.remaining = task.remaining.filter((d) => d !== domain);
      const processed = task.domains.length - task.remaining.length;
      task.progress =
        task.domains.length === 0 ? 100 : Math.floor((processed / task.domains.length) * 100);
      task.updatedAt = Date.now();
    }
    task.progress = 100;
    if (task.completed.length === 0 && sawTimeout) {
      task.status = 'failed';
      task.stage = 'TIMEOUT';
    } else {
      task.status = 'completed';
      task.stage = 'COMPLETED';
    }
    task.updatedAt = Date.now();
  } catch (e) {
    // Fatal safeguard: unexpected loop-level error.
    const msg = e instanceof Error ? e.message : 'unknown_error';
    task.errors.push({ domain: 'batch_runtime', error: msg });
    task.status = 'failed';
    task.stage = msg.toLowerCase().includes('timeout') ? 'TIMEOUT' : 'COMPLETED';
    task.updatedAt = Date.now();
  }
}

function createServer(): McpServer {
  const server = new McpServer({
    name: 'boce-aggregated-investigation',
    version: '0.1.0',
  });

  const buildNodesResource = (uri: URL) => {
      const query = safeDecodeQueryValue(uri.searchParams.get('query') ?? undefined);
      const regionFilter = safeDecodeQueryValue(uri.searchParams.get('region') ?? undefined).toLowerCase();
      const ispFilter = safeDecodeQueryValue(uri.searchParams.get('isp') ?? undefined).toLowerCase();
      const offset = Math.max(0, parsePositiveIntOrDefault(uri.searchParams.get('offset') ?? undefined, 0));
      const requestedLimit = parsePositiveIntOrDefault(
        uri.searchParams.get('limit') ?? undefined,
        MCP_NODE_RESOURCE_DEFAULT_LIMIT
      );
      const limit = Math.min(
        MCP_NODE_LIST_MAX_PER_RESPONSE,
        Math.max(1, requestedLimit || MCP_NODE_RESOURCE_DEFAULT_LIMIT)
      );

      const snapshot = nodeCache.snapshot();
      let rows: Array<{
        id: number;
        region: string;
        ispName: string;
        nodeName: string;
        rawIspName: string;
        area: string;
        regionCode: string;
        score?: number;
      }> = nodeCache.listNodes().map((n) => ({
        id: n.id,
        region: toEnglishRegion(n.nodeName),
        ispName: toEnglishIsp(n.ispName),
        nodeName: n.nodeName,
        rawIspName: n.ispName,
        area: n.area,
        regionCode: n.region,
      }));

      if (query) {
        rows = rows
          .map((n) => ({
            ...n,
            score: scoreNodeForQuery(query, {
              id: n.id,
              nodeName: n.nodeName,
              ispName: n.rawIspName,
              area: n.area,
              region: n.regionCode,
            }),
          }))
          .filter((n) => (n.score ?? 0) > 0)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id - b.id);
      }

      if (regionFilter) {
        rows = rows.filter((n) => n.region.toLowerCase().includes(regionFilter));
      }
      if (ispFilter) {
        rows = rows.filter((n) => n.ispName.toLowerCase().includes(ispFilter));
      }

      const total = rows.length;
      const page = rows.slice(offset, offset + limit);
      const nodes = page.map((n) => ({
        nodeId: n.id,
        region: n.region,
        ispName: n.ispName,
        label: toNodeSelectionLabel(n.id, n.nodeName, n.rawIspName),
        score: query ? n.score : undefined,
      }));
      return {
        contents: [
          {
            uri: uri.toString(),
            text: JSON.stringify(
              {
                version: '1.0',
                updatedAt: snapshot.updatedAt ?? null,
                snapshot: {
                  mainlandCount: snapshot.mainlandCount,
                  overseaCount: snapshot.overseaCount,
                  total: snapshot.total,
                },
                total,
                limit,
                offset,
                nodes,
              },
              null,
              2
            ),
          },
        ],
      };
  };

  server.registerResource(
    'probe-nodes',
    'boce://nodes/list',
    {
      title: 'Boce Probe Nodes',
      description:
        'Cached probe nodes with optional query/region/isp filtering and pagination for LLM clients.',
      mimeType: 'application/json',
    },
    async (uri) => buildNodesResource(uri)
  );

  server.registerResource(
    'probe-nodes-query',
    new ResourceTemplate('boce://nodes/list{+suffix}', { list: undefined }),
    {
      title: 'Boce Probe Nodes Query',
      description:
        'Queryable boce://nodes/list resource. Supports query, region, isp, limit, offset.',
      mimeType: 'application/json',
    },
    async (uri) => buildNodesResource(uri)
  );

  server.registerTool(
    'probe_nodes_refresh',
    {
      description:
        'Refresh Boce node cache from upstream (mainland + oversea) and return snapshot counts.',
      inputSchema: {},
    },
    async () => {
      try {
        const snapshot = await refreshNodeCache();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                snapshot,
                workflowHint:
                  'Use probe_nodes_list with detail=summary or small detail=list+limit+search before probe_domains_batch_start; responses are capped per call to avoid hundreds of nodes in one message.',
              }),
            },
          ],
        };
      } catch (e) {
        if (e instanceof BoceApiError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: e.message,
                  errorCode: e.errorCode,
                }),
              },
            ],
          };
        }
        throw e;
      }
    }
  );

  server.registerTool(
    'probe_nodes_list',
    {
      description:
        'List Boce probe nodes from cache (refresh optional). Use detail=summary first for counts only; use list+limit+offset+search to avoid returning hundreds of nodes in one response. Workflow: list/summary -> pick nodeIds -> probe_domains_batch_start. For HK-focused probes, try search (e.g. 香港) or area=oversea.',
      inputSchema: {
        refresh: z.boolean().optional(),
        detail: z.enum(['summary', 'list']).optional(),
        area: z.enum(['mainland', 'oversea']).optional(),
        nodeId: z.number().int().positive().optional(),
        query: z.string().max(64).optional(),
        search: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).max(50_000).optional(),
      },
    },
    async ({ refresh, detail, area, nodeId, query, search, limit, offset }) => {
      try {
        if (refresh) await refreshNodeCache();
      } catch (e) {
        if (e instanceof BoceApiError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: e.message,
                  errorCode: e.errorCode,
                }),
              },
            ],
          };
        }
        throw e;
      }

      const snapshot = nodeCache.snapshot();
      if (typeof nodeId === 'number') {
        const node = nodeCache.getNode(nodeId);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: !!node,
                snapshot,
                node: node ?? null,
                selectedLabel: node
                  ? toNodeSelectionLabel(node.id, node.nodeName, node.ispName)
                  : undefined,
                error: node ? undefined : 'NODE_NOT_FOUND_IN_CACHE',
                hint: node ? undefined : 'Call with {"refresh": true} and try again.',
                overflowProtection: {
                  note: 'Single-node lookup; no bulk list returned.',
                },
              }),
            },
          ],
        };
      }

      const mode = detail ?? 'list';
      const allRows = nodeCache.listNodes();
      let rows = allRows;
      if (area) rows = rows.filter((n) => n.area === area);
      const q = (query ?? search)?.trim();
      if (q) {
        rows = rows
          .map((n) => ({ row: n, score: scoreNodeForQuery(q, n) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score || a.row.id - b.row.id)
          .map((x) => x.row);
      }

      const requestedLimit = limit ?? MCP_NODE_LIST_DEFAULT_LIMIT;
      const appliedLimit = Math.min(requestedLimit, MCP_NODE_LIST_MAX_PER_RESPONSE);
      const start = offset ?? 0;

      if (mode === 'summary') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                detail: 'summary',
                snapshot,
                filter: { area: area ?? null, search: q ?? null },
                totals: {
                  mainlandCount: snapshot.mainlandCount,
                  overseaCount: snapshot.overseaCount,
                  totalInCache: allRows.length,
                  matchedAfterFilter: rows.length,
                },
                overflowProtection: {
                  defaultListLimit: MCP_NODE_LIST_DEFAULT_LIMIT,
                  maxNodesPerResponse: MCP_NODE_LIST_MAX_PER_RESPONSE,
                  note: 'Summary only — no node array. Use detail=list with limit+offset (and search for HK-related nodes) before probe_domains_batch_start.',
                },
                workflowHint:
                  'list nodes (summary or small page) -> choose nodeIds -> probe_domains_batch_start. Prefer search (e.g. 香港 / Hong Kong) or area=oversea to narrow nodes.',
              }),
            },
          ],
        };
      }

      const page = rows.slice(start, start + appliedLimit);
      const compact = page.map((n) => ({
        id: n.id,
        nodeId: n.id,
        nodeName: n.nodeName,
        ispName: n.ispName,
        regionLabel: toEnglishRegion(n.nodeName),
        ispLabel: toEnglishIsp(n.ispName),
        label: toNodeSelectionLabel(n.id, n.nodeName, n.ispName),
        area: n.area,
        region: n.region,
        score: q ? scoreNodeForQuery(q, n) : undefined,
      }));
      const hasMore = start + appliedLimit < rows.length;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              detail: 'list',
              snapshot,
              filter: { area: area ?? null, search: q ?? null, offset: start },
              totalMatched: rows.length,
              returned: compact.length,
              truncated: hasMore,
              nextOffset: hasMore ? start + appliedLimit : null,
              overflowProtection: {
                defaultListLimit: MCP_NODE_LIST_DEFAULT_LIMIT,
                maxNodesPerResponse: MCP_NODE_LIST_MAX_PER_RESPONSE,
                requestedLimit,
                appliedLimit,
                clamped: requestedLimit > MCP_NODE_LIST_MAX_PER_RESPONSE,
              },
              nodes: compact,
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    'probe_domains_batch_start',
    {
      description:
        'Start an HTTP probe batch task and return taskId only. Full URL (path/query) is preserved and probed as-is. Duplicate normalized targets are deduplicated.',
      inputSchema: {
        domains: z.array(z.string().min(1)).min(1).max(20),
        nodeIds: z.string().optional(),
        ipWhitelist: z.array(z.string()).optional(),
        pollInterval: z.number().int().optional(),
      },
    },
    async ({ domains, nodeIds, ipWhitelist, pollInterval }) => {
      const warnings: string[] = [];
      let effectivePollInterval = pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
      if (effectivePollInterval < 1000) {
        effectivePollInterval = 1000;
        warnings.push('pollInterval adjusted to minimum 1000ms');
      } else if (effectivePollInterval > 60_000) {
        effectivePollInterval = 60_000;
        warnings.push('pollInterval adjusted to maximum 60000ms');
      }
      const normalized = dedupeNormalizedTargets(domains.map(normalizeProbeTarget));
      const taskId = randomUUID();
      const task: BatchTask = {
        taskId,
        status: 'pending',
        stage: 'QUEUED',
        domains: normalized,
        nodeIds,
        ipWhitelist,
        pollInterval: effectivePollInterval,
        completed: [],
        remaining: [...normalized],
        results: [],
        errors: [],
        progress: 0,
        updatedAt: Date.now(),
        warnings,
      };
      batchTasks.set(taskId, task);
      void runBatchTask(taskId);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              taskId,
              status: task.status,
              stage: task.stage,
              normalizedInput: { pollInterval: effectivePollInterval },
              warnings,
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    'probe_domains_batch_status',
    {
      description:
        'Batch progress: progress = % of domains processed; completed = hostnames that probed successfully; remaining = not yet processed. nextStep guides poll vs result.',
      inputSchema: {
        taskId: z.string().min(1),
      },
    },
    async ({ taskId }) => {
      const task = batchTasks.get(taskId);
      if (!task) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ taskId, found: false, error: 'TASK_NOT_FOUND' }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(statusPayload(task)),
          },
        ],
      };
    }
  );

  server.registerTool(
    'probe_domains_batch_result',
    {
      description:
        'Final compact report when batch is completed or failed. domainErrorCount = per-domain probe exceptions (batch may still be status completed).',
      inputSchema: {
        taskId: z.string().min(1),
      },
    },
    async ({ taskId }) => {
      const task = batchTasks.get(taskId);
      if (!task) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ taskId, found: false, error: 'TASK_NOT_FOUND' }),
            },
          ],
        };
      }

      if (task.status === 'pending' || task.status === 'running') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(statusPayload(task)),
            },
          ],
        };
      }

      const healthyCount = task.results.filter((r) => r.finalStatus === 'HEALTHY').length;
      const attentionCount = task.results.filter((r) => r.finalStatus === 'ATTENTION_REQUIRED').length;
      const lines = task.results.map((r) =>
        `${r.domain} / ${r.finalStatus} / avail ${r.availabilityRate} / flag ${r.flag}${r.nodeCompact ? ` / ${r.nodeCompact}` : ''}`
      );
      const lineComparisons = task.results
        .flatMap((r) =>
          r.lineComparisons.map((x) => ({
            nodeId: x.nodeId,
            nodeName: x.nodeName,
            ispName: x.ispName,
            url: r.domain,
            statusCode: x.statusCode,
            latencyMs: x.latencyMs,
            responseIp: x.responseIp,
            error: x.boceError,
          }))
        )
        .sort((a, b) => {
          const ax = typeof a.latencyMs === 'number' ? a.latencyMs : Number.POSITIVE_INFINITY;
          const bx = typeof b.latencyMs === 'number' ? b.latencyMs : Number.POSITIVE_INFINITY;
          return ax - bx;
        });
      const lineComparisonSummary = task.results.map((r) => {
        const isSuccess = (x: { statusCode?: number; boceError?: string }) =>
          typeof x.statusCode === 'number' && x.statusCode >= 200 && x.statusCode <= 399 && !x.boceError;
        const successCount = r.lineComparisons.filter(isSuccess).length;
        const failureCount = r.lineComparisons.length - successCount;
        const successRate =
          r.lineComparisons.length === 0 ? 0 : Math.round((successCount / r.lineComparisons.length) * 100);

        // For speed ranking, only use successful responses (avoid mixing failures into performance).
        const valid = r.lineComparisons.filter(
          (x) => typeof x.latencyMs === 'number' && isSuccess(x)
        );
        if (valid.length === 0) {
          return {
            domain: r.domain,
            sampledLines: r.lineComparisons.length,
            measurableLines: 0, // measurable successful lines
            successCount,
            failureCount,
            successRate,
            fastest: null,
            slowest: null,
            avgLatencyMs: null,
            latencySpreadMs: null,
          };
        }
        const sorted = [...valid].sort((a, b) => (a.latencyMs as number) - (b.latencyMs as number));
        const fastest = sorted[0];
        const slowest = sorted[sorted.length - 1];
        const sum = sorted.reduce((acc, x) => acc + (x.latencyMs as number), 0);
        const avgLatencyMs = Math.round((sum / sorted.length) * 100) / 100;
        return {
          domain: r.domain,
          sampledLines: r.lineComparisons.length,
          measurableLines: sorted.length,
          successCount,
          failureCount,
          successRate,
          fastest: {
            nodeId: fastest.nodeId,
            nodeName: fastest.nodeName,
            ispName: fastest.ispName,
            latencyMs: fastest.latencyMs,
            statusCode: fastest.statusCode,
            responseIp: fastest.responseIp,
          },
          slowest: {
            nodeId: slowest.nodeId,
            nodeName: slowest.nodeName,
            ispName: slowest.ispName,
            latencyMs: slowest.latencyMs,
            statusCode: slowest.statusCode,
            responseIp: slowest.responseIp,
          },
          avgLatencyMs,
          latencySpreadMs: (slowest.latencyMs as number) - (fastest.latencyMs as number),
        };
      });
      const compactComparisons = task.results.map((r) => {
        const groups = new Map<
          string,
          {
            displayName: string;
            latencyValues: number[];
            statusCode?: number;
            responseIp?: string;
          }
        >();
        for (const item of r.lineComparisons) {
          const displayName = toEnglishNodeLabel(item.nodeName, item.ispName);
          const key = `${item.nodeName ?? ''}|${item.ispName ?? ''}`;
          if (!groups.has(key)) {
            groups.set(key, {
              displayName,
              latencyValues: [],
              statusCode: item.statusCode,
              responseIp: item.responseIp,
            });
          }
          const g = groups.get(key)!;
          if (typeof item.latencyMs === 'number') g.latencyValues.push(item.latencyMs);
          // Latest seen representative values for status/ip.
          if (typeof item.statusCode === 'number') g.statusCode = item.statusCode;
          if (item.responseIp) g.responseIp = item.responseIp;
        }
        const lines = Array.from(groups.values())
          .map((g) => {
            const avgMs =
              g.latencyValues.length > 0
                ? g.latencyValues.reduce((a, b) => a + b, 0) / g.latencyValues.length
                : NaN;
            const avgSec = Number.isFinite(avgMs) ? (avgMs / 1000).toFixed(2) : '-';
            const status = typeof g.statusCode === 'number' ? g.statusCode : '-';
            const ip = g.responseIp ?? '-';
            return {
              sortLatency: Number.isFinite(avgMs) ? avgMs : Number.POSITIVE_INFINITY,
              text: `${g.displayName} / ${avgSec}s / status ${status} / ${ip}`,
            };
          })
          .sort((a, b) => a.sortLatency - b.sortLatency)
          .map((x) => x.text);
        return {
          domain: r.domain,
          lines,
        };
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              taskId: task.taskId,
              status: task.status,
              stage: task.stage,
              warnings: task.warnings,
              compactComparisons,
            }),
          },
        ],
      };
    }
  );

  return server;
}

async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Boce investigation MCP server running on stdio');
}

async function startHttpServer(): Promise<void> {
  const mcpPort = Number(process.env.MCP_PORT ?? '3010');
  const allowedHosts = getMcpAllowedHostsForExpress();
  const app = allowedHosts
    ? createMcpExpressApp({ allowedHosts })
    : createMcpExpressApp();
  if (allowedHosts?.length) {
    console.error(
      `[MCP HTTP] Host allow list active (${allowedHosts.length}): ${allowedHosts.join(', ')}`
    );
  } else {
    console.error(
      '[MCP HTTP] Host allow list: SDK default (localhost, 127.0.0.1, [::1] only). Set MCP_ALLOWED_HOSTS for public Host headers.'
    );
  }
  if (config.mcp.authEnabled) {
    const tokenSource = config.mcp.authAllowQueryToken
      ? 'Authorization: Bearer <token> / X-API-Key / ?mcp_auth_token='
      : 'Authorization: Bearer <token> or X-API-Key';
    console.error('[MCP HTTP] Token auth: ENABLED');
    console.error(`[MCP HTTP] Token sources accepted: ${tokenSource}`);
  } else {
    console.error('[MCP HTTP] Token auth: DISABLED');
  }
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // DevOps / LB: not part of MCP protocol — avoids "Invalid session" when probing GET /mcp
  app.get('/mcp/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'boce-mcp',
    });
  });

  app.post('/mcp', async (req, res) => {
    if (!ensureHttpAuth(req, res)) return;
    const sessionId = getMcpSessionIdFromRequest(req);
    try {
      let transport: StreamableHTTPServerTransport | undefined;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport!;
          },
        });
        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid && transports[sid]) delete transports[sid];
        };
        const server = createServer();
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP HTTP POST error:', e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', async (req, res) => {
    if (!ensureHttpAuth(req, res)) return;
    const sessionId = getMcpSessionIdFromRequest(req);
    if (!sessionId || !transports[sessionId]) {
      sendMcpSessionRequired(res, 'GET');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    if (!ensureHttpAuth(req, res)) return;
    const sessionId = getMcpSessionIdFromRequest(req);
    if (!sessionId || !transports[sessionId]) {
      sendMcpSessionRequired(res, 'DELETE');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.listen(mcpPort, () => {
    console.error(
      `Boce investigation MCP server running on Stream HTTP :${mcpPort} at /mcp (health: GET /mcp/health)`
    );
  });
}

function detectTransportMode(): 'stdio' | 'http' {
  const arg = process.argv.find((a) => a.startsWith('--transport='));
  const cli = arg?.split('=')[1];
  const mode = (cli || process.env.MCP_TRANSPORT || 'http').toLowerCase();
  return mode === 'stdio' ? 'stdio' : 'http';
}

async function main(): Promise<void> {
  const mode = detectTransportMode();
  if (mode === 'stdio') {
    await startStdioServer();
    return;
  }
  await startHttpServer();
}

main().catch((e) => {
  console.error('Fatal MCP server error:', e);
  process.exit(1);
});
