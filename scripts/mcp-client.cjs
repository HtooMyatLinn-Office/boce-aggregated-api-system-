const readline = require('node:readline');
const { Client } = require('@modelcontextprotocol/sdk/client');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

let client = null;
let transport = null;
let serverUrl = 'http://localhost:3010/mcp';
let rawOutput = false;
let authToken = process.env.MCP_AUTH_TOKEN || '';

function printHelp() {
  console.log('Commands:');
  console.log('  connect [url]             Connect to MCP Stream HTTP server');
  console.log('  disconnect                Disconnect current session');
  console.log('  list-tools                List available MCP tools');
  console.log('  call-tool <name> <json>   Call a tool with JSON args');
  console.log('  check <domain> [nodeIds]  Start batch for one domain');
  console.log('  check-batch <d1,d2> [nodeIds] Start batch for multiple domains');
  console.log('  status <taskId>           Check batch progress');
  console.log('  result <taskId>           Get final batch result');
  console.log('  auth-token <token|clear>  Set/clear MCP auth token');
  console.log('  raw on|off                Toggle raw JSON output');
  console.log('  clear                     Clear terminal screen');
  console.log('  help                      Show commands');
  console.log('  quit                      Exit');
}

function clearScreen() {
  process.stdout.write('\x1Bc');
}

async function connect(url) {
  if (client) {
    console.log('Already connected. Use disconnect first.');
    return;
  }
  if (url) serverUrl = url;
  const nextClient = new Client({ name: 'boce-custom-cli', version: '0.1.0' });
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
  const nextTransport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: headers ? { headers } : undefined,
  });
  try {
    await nextClient.connect(nextTransport);
  } catch (e) {
    // Keep local state clean so users can retry connect directly after auth/token fixes.
    await nextClient.close().catch(() => undefined);
    throw e;
  }
  client = nextClient;
  transport = nextTransport;
  console.log(`Connected: ${serverUrl}${authToken ? ' (auth token set)' : ''}`);
}

async function disconnect() {
  if (!client) {
    console.log('Not connected.');
    return;
  }
  await client.close();
  client = null;
  transport = null;
  console.log('Disconnected.');
}

async function listTools() {
  if (!client) {
    console.log('Not connected. Run: connect');
    return;
  }
  const result = await client.listTools();
  if (!result.tools?.length) {
    console.log('No tools found.');
    return;
  }
  console.log('Available tools:');
  result.tools.forEach((tool) => {
    console.log(`- ${tool.name}: ${tool.description ?? '-'}`);
  });
}

async function callTool(name, argsRaw) {
  if (!client) {
    console.log('Not connected. Run: connect');
    return;
  }
  if (!name) {
    console.log('Usage: call-tool <name> <json>');
    return;
  }
  let args = {};
  if (argsRaw && argsRaw.trim().length > 0) {
    try {
      args = JSON.parse(argsRaw);
    } catch {
      console.log('Invalid JSON args.');
      return;
    }
  }
  const result = await client.callTool({ name, arguments: args });
  printToolResult(result);
}

async function checkDomain(domain, nodeIds) {
  if (!domain) {
    console.log('Usage: check <domain> [nodeIds]');
    return;
  }
  const payload = { domains: [domain] };
  if (nodeIds) payload.nodeIds = nodeIds;
  const result = await client.callTool({ name: 'probe_domains_batch_start', arguments: payload });
  printToolResult(result);
}

async function checkBatch(domainsCsv, nodeIds) {
  if (!domainsCsv) {
    console.log('Usage: check-batch <domain1,domain2,...> [nodeIds]');
    return;
  }
  const domains = domainsCsv
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  if (domains.length === 0) {
    console.log('No valid domains provided.');
    return;
  }
  const payload = { domains };
  if (nodeIds) payload.nodeIds = nodeIds;
  const result = await client.callTool({ name: 'probe_domains_batch_start', arguments: payload });
  printToolResult(result);
}

async function checkStatus(taskId) {
  if (!taskId) {
    console.log('Usage: status <taskId>');
    return;
  }
  const result = await client.callTool({ name: 'probe_domains_batch_status', arguments: { taskId } });
  printToolResult(result);
}

async function checkResult(taskId) {
  if (!taskId) {
    console.log('Usage: result <taskId>');
    return;
  }
  const result = await client.callTool({ name: 'probe_domains_batch_result', arguments: { taskId } });
  printToolResult(result);
}

function printToolResult(result) {
  if (rawOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const chunks = result?.content ?? [];
  const textParts = chunks
    .filter((item) => item?.type === 'text' && typeof item?.text === 'string')
    .map((item) => item.text);
  if (textParts.length > 0) {
    console.log(textParts.join('\n'));
    return;
  }
  // fallback for unexpected response shape
  console.log(JSON.stringify(result, null, 2));
}

function setRawMode(value) {
  if (value === 'on') {
    rawOutput = true;
    console.log('Raw output: ON');
    return;
  }
  if (value === 'off') {
    rawOutput = false;
    console.log('Raw output: OFF');
    return;
  }
  console.log('Usage: raw on|off');
}

function setAuthToken(value) {
  if (!value) {
    console.log('Usage: auth-token <token|clear>');
    return;
  }
  if (value === 'clear') {
    authToken = '';
    console.log('Auth token cleared.');
    return;
  }
  authToken = value;
  console.log('Auth token set. Reconnect to apply.');
}

async function main() {
  console.log('Boce MCP Custom Client');
  printHelp();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();
  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    const [command, ...rest] = input.split(' ');
    try {
      switch (command) {
        case 'connect':
          await connect(rest[0]);
          break;
        case 'disconnect':
          await disconnect();
          break;
        case 'list-tools':
          await listTools();
          break;
        case 'call-tool': {
          const toolName = rest[0];
          const argsRaw = rest.slice(1).join(' ');
          await callTool(toolName, argsRaw);
          break;
        }
        case 'check':
          await checkDomain(rest[0], rest[1]);
          break;
        case 'check-batch':
          await checkBatch(rest[0], rest[1]);
          break;
        case 'status':
          await checkStatus(rest[0]);
          break;
        case 'result':
          await checkResult(rest[0]);
          break;
        case 'raw':
          setRawMode(rest[0]);
          break;
        case 'auth-token':
          setAuthToken(rest.join(' '));
          break;
        case 'clear':
          clearScreen();
          printHelp();
          break;
        case 'help':
          printHelp();
          break;
        case 'quit':
        case 'exit':
          await disconnect().catch(() => undefined);
          rl.close();
          return;
        default:
          console.log(`Unknown command: ${command}`);
      }
    } catch (e) {
      console.log(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

