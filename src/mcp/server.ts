import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { detectOnce } from '../services/detection/detect';

const DEFAULT_POLL_INTERVAL_MS = 10_000;

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

function statusPayload(task: BatchTask): Record<string, unknown> {
  const base: Record<string, unknown> = {
    taskId: task.taskId,
    status: task.status,
    progress: task.progress,
    completed: task.completed,
    remaining: task.remaining,
    pollInterval: task.pollInterval,
  };
  if (task.status === 'pending' || task.status === 'running') {
    base.nextStep = {
      action: 'call_tool',
      tool: 'probe_domains_batch_status',
      arguments: { taskId: task.taskId },
      schedule: { delayMs: task.pollInterval },
    };
    return base;
  }

  if (task.status === 'completed') {
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
      const result = await probeOneDomain(domain, task.nodeIds, task.ipWhitelist);
      task.results.push(result);
      task.completed.push(result.domain);
      task.remaining = task.remaining.filter((d) => normalizeHost(d) !== result.domain);
      task.progress = Math.floor((task.completed.length / task.domains.length) * 100);
      task.updatedAt = Date.now();
    }
    task.status = 'completed';
    task.progress = 100;
    task.updatedAt = Date.now();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown_error';
    const remainingDomain = task.remaining[0] ?? task.domains.find((d) => !task.completed.includes(d));
    if (remainingDomain) task.errors.push({ domain: remainingDomain, error: msg });
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
      description: 'Start an HTTP probe batch task and return taskId only.',
      inputSchema: {
        domains: z.array(z.string().min(1)).min(1).max(20),
        nodeIds: z.string().optional(),
        ipWhitelist: z.array(z.string()).optional(),
        pollInterval: z.number().int().min(1000).max(60000).optional(),
      },
    },
    async ({ domains, nodeIds, ipWhitelist, pollInterval }) => {
      const normalized = domains.map(normalizeHost);
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
      description: 'Get batch probe task progress and next polling step hint.',
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
              text: JSON.stringify({ taskId, status: 'not_found' }),
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
      description: 'Get compact final batch probe report (or polling hint if still running).',
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
              text: JSON.stringify({ taskId, status: 'not_found' }),
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
              failedCount: task.errors.length,
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
  const app = createMcpExpressApp();
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
