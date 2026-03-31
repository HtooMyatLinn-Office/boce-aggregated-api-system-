import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import tls from 'node:tls';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { detectOnce } from '../services/detection/detect';

type CertCheckResult = {
  ok: boolean;
  host: string;
  resolvedIps: string[];
  issuerCn?: string;
  subjectCn?: string;
  validFrom?: string;
  validTo?: string;
  daysRemaining?: number;
  expiresSoon?: boolean;
  error?: string;
};

function pickString(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

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
  const place = node.nodeName ?? node.ispName ?? node.region ?? `node`;
  const latency = compactLatency(node.latencyMs);
  const status = node.statusCode ?? '-';
  const ip = node.responseIp ?? '-';
  const err = node.boceError ? ` / err ${node.boceError}` : '';
  return `${place} / ${latency} / status ${status} / ${ip}${err}`;
}

function formatProbeSummaryText(input: {
  domain: string;
  requestId: string;
  taskId: string;
  overallStatus: string;
  summary: string;
  availabilityRate: number;
  totalProbes: number;
  successProbes: number;
  anomalyCount: number;
  nodeLines: string[];
}): string {
  const lines: string[] = [
    `domain: ${input.domain}`,
    `final_status: ${input.overallStatus}`,
    `summary: ${input.summary}`,
    `availability_rate: ${input.availabilityRate}`,
    `probes: ${input.successProbes}/${input.totalProbes}`,
    `anomaly_count: ${input.anomalyCount}`,
    `request_id: ${input.requestId}`,
    `task_id: ${input.taskId}`,
  ];

  if (input.nodeLines.length > 0) {
    lines.push('nodes_compact:');
    input.nodeLines.forEach((line, i) => lines.push(`${i + 1}. ${line}`));
  }

  return lines.join('\n');
}

function formatCertSummaryText(cert: CertCheckResult): string {
  return [
    `domain: ${cert.host}`,
    `certificate_ok: ${cert.ok}`,
    `subject_cn: ${cert.subjectCn ?? '-'}`,
    `issuer_cn: ${cert.issuerCn ?? '-'}`,
    `valid_to: ${cert.validTo ?? '-'}`,
    `days_remaining: ${cert.daysRemaining ?? '-'}`,
    `expires_soon: ${cert.expiresSoon ?? '-'}`,
    `resolved_ips: ${cert.resolvedIps.join(',') || '-'}`,
    `error: ${cert.error ?? '-'}`,
  ].join('\n');
}

type InvestigationSummary = {
  host: string;
  finalStatus: 'HEALTHY' | 'ATTENTION_REQUIRED';
  flags: string[];
  probeStatus: string;
  probeSummary: string;
  availabilityRate: number;
  successProbes: number;
  totalProbes: number;
  anomalyCount: number;
  requestId: string;
  taskId: string;
  certificateOk: boolean;
  subjectCn?: string;
  issuerCn?: string;
  validTo?: string;
  daysRemaining?: number;
  expiresSoon?: boolean;
  certError?: string;
  nodeLines: string[];
};

function summarizeInvestigation(input: {
  host: string;
  probe: Awaited<ReturnType<typeof detectOnce>>;
  cert: CertCheckResult;
}): InvestigationSummary {
  const { host, probe, cert } = input;
  const flags: string[] = [];
  if (probe.summary.overallStatus !== 'HEALTHY') flags.push(`probe_status=${probe.summary.overallStatus}`);
  if (!cert.ok) flags.push('certificate_check_failed');
  if (cert.expiresSoon) flags.push('certificate_expiring_soon');

  const nodeLines = probe.probes
    .filter((p) => (p.statusCode ?? 0) < 200 || (p.statusCode ?? 0) >= 300 || !!p.boceError)
    .slice(0, 12)
    .map((p) => toNodeLine(p));

  return {
    host,
    finalStatus: flags.length === 0 ? 'HEALTHY' : 'ATTENTION_REQUIRED',
    flags,
    probeStatus: probe.summary.overallStatus,
    probeSummary: probe.summary.message,
    availabilityRate: Number(probe.availability.global.availabilityRate.toFixed(4)),
    successProbes: probe.availability.global.success,
    totalProbes: probe.availability.global.total,
    anomalyCount: probe.anomalies.length,
    requestId: probe.requestId,
    taskId: probe.taskId,
    certificateOk: cert.ok,
    subjectCn: cert.subjectCn,
    issuerCn: cert.issuerCn,
    validTo: cert.validTo,
    daysRemaining: cert.daysRemaining,
    expiresSoon: cert.expiresSoon,
    certError: cert.error,
    nodeLines,
  };
}

async function investigateOneDomain(input: {
  domain: string;
  nodeIds?: string;
  ipWhitelist?: string[];
}): Promise<InvestigationSummary> {
  const host = normalizeHost(input.domain);
  const [probe, cert] = await Promise.all([
    detectOnce({ url: host, nodeIds: input.nodeIds, ipWhitelist: input.ipWhitelist }),
    runCertCheck(host),
  ]);
  return summarizeInvestigation({ host, probe, cert });
}

async function runCertCheck(host: string): Promise<CertCheckResult> {
  const resolvedIps = await dns.resolve4(host).catch(() => []);
  return new Promise<CertCheckResult>((resolve) => {
    const socket = tls.connect(
      {
        host,
        port: 443,
        servername: host,
        rejectUnauthorized: false,
        timeout: 8000,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          socket.end();

          if (!cert || Object.keys(cert).length === 0) {
            resolve({
              ok: false,
              host,
              resolvedIps,
              error: 'No certificate received from endpoint',
            });
            return;
          }

          const validFrom = cert.valid_from ? new Date(cert.valid_from) : undefined;
          const validTo = cert.valid_to ? new Date(cert.valid_to) : undefined;
          const now = Date.now();
          const daysRemaining =
            validTo && Number.isFinite(validTo.getTime())
              ? Math.floor((validTo.getTime() - now) / (24 * 60 * 60 * 1000))
              : undefined;

          resolve({
            ok: true,
            host,
            resolvedIps,
            issuerCn: pickString(cert.issuer?.CN),
            subjectCn: pickString(cert.subject?.CN),
            validFrom: validFrom?.toISOString(),
            validTo: validTo?.toISOString(),
            daysRemaining,
            expiresSoon: typeof daysRemaining === 'number' ? daysRemaining <= 30 : undefined,
          });
        } catch (e) {
          resolve({
            ok: false,
            host,
            resolvedIps,
            error: e instanceof Error ? e.message : 'Certificate parse failed',
          });
        }
      }
    );

    socket.on('error', (e) => {
      resolve({
        ok: false,
        host,
        resolvedIps,
        error: e.message,
      });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({
        ok: false,
        host,
        resolvedIps,
        error: 'TLS connect timeout',
      });
    });
  });
}

function createServer(): McpServer {
  const server = new McpServer({
    name: 'boce-aggregated-investigation',
    version: '0.1.0',
  });

  server.registerTool(
    'boce_probe_summary',
    {
      description:
        'Run Boce probe flow for one domain and return compact summary (no raw probe dump).',
      inputSchema: {
        domain: z.string().min(1).describe('Domain or URL (e.g. www.baidu.com)'),
        nodeIds: z.string().optional().describe('Comma-separated node IDs (e.g. 31,32)'),
        ipWhitelist: z.array(z.string()).optional().describe('Optional expected response IP list'),
      },
    },
    async ({ domain, nodeIds, ipWhitelist }) => {
      const host = normalizeHost(domain);
      const result = await detectOnce({ url: host, nodeIds, ipWhitelist });
      const nodeLines = result.probes
        .filter((p) => (p.statusCode ?? 0) < 200 || (p.statusCode ?? 0) >= 300 || !!p.boceError)
        .slice(0, 12)
        .map((p) => toNodeLine(p));
      const compactText = formatProbeSummaryText({
        domain: host,
        requestId: result.requestId,
        taskId: result.taskId,
        overallStatus: result.summary.overallStatus,
        summary: result.summary.message,
        availabilityRate: Number(result.availability.global.availabilityRate.toFixed(4)),
        totalProbes: result.availability.global.total,
        successProbes: result.availability.global.success,
        anomalyCount: result.anomalies.length,
        nodeLines,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: compactText,
          },
        ],
      };
    }
  );

  server.registerTool(
    'certificate_summary',
    {
      description:
        'Check DNS + TLS certificate for one domain and return minimal certificate health summary.',
      inputSchema: {
        domain: z.string().min(1).describe('Domain or URL (e.g. www.baidu.com)'),
      },
    },
    async ({ domain }) => {
      const host = normalizeHost(domain);
      const cert = await runCertCheck(host);
      return {
        content: [
          {
            type: 'text' as const,
            text: formatCertSummaryText(cert),
          },
        ],
      };
    }
  );

  server.registerTool(
    'investigate_domain',
    {
      description:
        'Run Boce probe summary + certificate summary, then return one concise final investigation report.',
      inputSchema: {
        domain: z.string().min(1).describe('Domain or URL (e.g. www.baidu.com)'),
        nodeIds: z.string().optional().describe('Comma-separated node IDs (e.g. 31,32)'),
        ipWhitelist: z.array(z.string()).optional().describe('Optional expected response IP list'),
      },
    },
    async ({ domain, nodeIds, ipWhitelist }) => {
      const summary = await investigateOneDomain({ domain, nodeIds, ipWhitelist });

      const report = [
        `domain: ${summary.host}`,
        `final_status: ${summary.finalStatus}`,
        `flags: ${summary.flags.length ? summary.flags.join(', ') : '-'}`,
        `probe_status: ${summary.probeStatus}`,
        `probe_summary: ${summary.probeSummary}`,
        `availability_rate: ${summary.availabilityRate}`,
        `probes: ${summary.successProbes}/${summary.totalProbes}`,
        `anomaly_count: ${summary.anomalyCount}`,
        `request_id: ${summary.requestId}`,
        `task_id: ${summary.taskId}`,
        `certificate_ok: ${summary.certificateOk}`,
        `subject_cn: ${summary.subjectCn ?? '-'}`,
        `issuer_cn: ${summary.issuerCn ?? '-'}`,
        `valid_to: ${summary.validTo ?? '-'}`,
        `days_remaining: ${summary.daysRemaining ?? '-'}`,
        `expires_soon: ${summary.expiresSoon ?? '-'}`,
        `cert_error: ${summary.certError ?? '-'}`,
      ];

      if (summary.nodeLines.length > 0) {
        report.push('nodes_compact:');
        summary.nodeLines.forEach((line, i) => report.push(`${i + 1}. ${line}`));
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: report.join('\n'),
          },
        ],
      };
    }
  );

  server.registerTool(
    'investigate_domains_batch',
    {
      description:
        'Investigate one or more domains in one call with compact per-domain verdict lines and summary counts.',
      inputSchema: {
        domains: z
          .array(z.string().min(1))
          .min(1)
          .max(20)
          .describe('One or more domains/URLs to investigate (max 20 per call)'),
        nodeIds: z.string().optional().describe('Comma-separated node IDs (e.g. 31,32)'),
        ipWhitelist: z.array(z.string()).optional().describe('Optional expected response IP list'),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe('Parallelism for checks (1-5, default 3)'),
      },
    },
    async ({ domains, nodeIds, ipWhitelist, concurrency }) => {
      const maxWorkers = concurrency ?? 3;
      const queue = [...domains];
      const rows: string[] = [];
      let healthyCount = 0;
      let attentionCount = 0;
      let failedCount = 0;

      async function worker(): Promise<void> {
        while (queue.length > 0) {
          const domain = queue.shift();
          if (!domain) return;
          try {
            const item = await investigateOneDomain({ domain, nodeIds, ipWhitelist });
            if (item.finalStatus === 'HEALTHY') healthyCount += 1;
            else attentionCount += 1;
            const leadFlag = item.flags[0] ?? '-';
            rows.push(
              `${item.host} / ${item.finalStatus} / avail ${item.availabilityRate} / cert ${item.certificateOk} / flag ${leadFlag}`
            );
          } catch (e) {
            failedCount += 1;
            const host = domain.trim() || domain;
            const msg = e instanceof Error ? e.message : 'unknown_error';
            rows.push(`${host} / ERROR / avail - / cert - / flag ${msg}`);
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(maxWorkers, domains.length) }, () => worker()));

      const text = [
        `batch_total: ${domains.length}`,
        `healthy_count: ${healthyCount}`,
        `attention_required_count: ${attentionCount}`,
        `failed_count: ${failedCount}`,
        'domains_compact:',
        ...rows.map((line, i) => `${i + 1}. ${line}`),
      ].join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text,
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

