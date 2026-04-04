import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getMcpAllowedHostsForExpress } from '../config';
import { detectOnce } from '../services/detection/detect';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const ADAPTIVE_POLL_MIN_MS = 2_000;
const ADAPTIVE_POLL_MAX_MS = 60_000;

type BatchTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

type DomainResult = {
  domain: string;
  finalStatus: 'HEALTHY' | 'ATTENTION_REQUIRED';
  availabilityRate: number;
  flag: string;
  nodeCompact?: string;
};

type BatchTask = {
  taskId: string;
  status: BatchTaskStatus;
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
};

const batchTasks = new Map<string, BatchTask>();

function normalizeHost(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('domain is required');
  const withScheme = raw.includes('://') ? raw : `https://${raw}`;
  const parsed = new URL(withScheme);
  if (!parsed.hostname) throw new Error('invalid domain');
  return parsed.hostname;
}

/** Same hostname only once per batch; preserves first-seen order. */
function dedupeNormalizedDomains(hostnames: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hostnames) {
    if (!seen.has(h)) {
      seen.add(h);
      out.push(h);
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
    progress: task.progress,
    completed: task.completed,
    remaining: task.remaining,
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

async function probeOneDomain(domain: string, nodeIds?: string, ipWhitelist?: string[]): Promise<DomainResult> {
  const host = normalizeHost(domain);
  const probe = await detectOnce({ url: host, nodeIds, ipWhitelist });
  const availabilityRate = Number(probe.availability.global.availabilityRate.toFixed(4));
  const isHealthy = probe.summary.overallStatus === 'HEALTHY';
  const nodeCompact = probe.probes
    .filter((p) => (p.statusCode ?? 0) < 200 || (p.statusCode ?? 0) >= 300 || !!p.boceError)
    .slice(0, 1)
    .map((p) => toNodeLine(p))[0];
  return {
    domain: host,
    finalStatus: isHealthy ? 'HEALTHY' : 'ATTENTION_REQUIRED',
    availabilityRate,
    flag: isHealthy ? '-' : `probe_status=${probe.summary.overallStatus}`,
    nodeCompact,
  };
}

async function runBatchTask(taskId: string): Promise<void> {
  const task = batchTasks.get(taskId);
  if (!task) return;
  task.status = 'running';
  task.updatedAt = Date.now();

  try {
    for (const domain of task.domains) {
      try {
        const result = await probeOneDomain(domain, task.nodeIds, task.ipWhitelist);
        task.results.push(result);
        task.completed.push(result.domain);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown_error';
        task.errors.push({ domain, error: msg });
      }
      // task.domains and task.remaining are already normalized at batch_start.
      task.remaining = task.remaining.filter((d) => d !== domain);
      const processed = task.domains.length - task.remaining.length;
      task.progress =
        task.domains.length === 0 ? 100 : Math.floor((processed / task.domains.length) * 100);
      task.updatedAt = Date.now();
    }
    task.status = 'completed';
    task.progress = 100;
    task.updatedAt = Date.now();
  } catch (e) {
    // Fatal safeguard: unexpected loop-level error.
    const msg = e instanceof Error ? e.message : 'unknown_error';
    task.errors.push({ domain: 'batch_runtime', error: msg });
    task.status = 'failed';
    task.updatedAt = Date.now();
  }
}

function createServer(): McpServer {
  const server = new McpServer({
    name: 'boce-aggregated-investigation',
    version: '0.1.0',
  });

  server.registerTool(
    'probe_domains_batch_start',
    {
      description:
        'Start an HTTP probe batch task and return taskId only. Duplicate hostnames (after normalization) are deduplicated.',
      inputSchema: {
        domains: z.array(z.string().min(1)).min(1).max(20),
        nodeIds: z.string().optional(),
        ipWhitelist: z.array(z.string()).optional(),
        pollInterval: z.number().int().min(1000).max(60000).optional(),
      },
    },
    async ({ domains, nodeIds, ipWhitelist, pollInterval }) => {
      const normalized = dedupeNormalizedDomains(domains.map(normalizeHost));
      const taskId = randomUUID();
      const task: BatchTask = {
        taskId,
        status: 'pending',
        domains: normalized,
        nodeIds,
        ipWhitelist,
        pollInterval: pollInterval ?? DEFAULT_POLL_INTERVAL_MS,
        completed: [],
        remaining: [...normalized],
        results: [],
        errors: [],
        progress: 0,
        updatedAt: Date.now(),
      };
      batchTasks.set(taskId, task);
      void runBatchTask(taskId);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ taskId }),
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              taskId: task.taskId,
              status: task.status,
              progress: task.progress,
              batchTotal: task.domains.length,
              healthyCount,
              attentionRequiredCount: attentionCount,
              domainErrorCount: task.errors.length,
              completed: task.completed,
              remaining: task.remaining,
              domainsCompact: lines,
              errors: task.errors,
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
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
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
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.listen(mcpPort, () => {
    console.error(`Boce investigation MCP server running on Stream HTTP :${mcpPort} at /mcp`);
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
