#!/usr/bin/env node
// A tiny stub external MCP server for e2e (p31). Speaks JSON-RPC 2.0. Two transports:
//   node mcp-stub-server.mjs                → stdio (newline-delimited JSON-RPC on stdin/stdout)
//   node mcp-stub-server.mjs --http <port>  → Streamable-HTTP (POST JSON-RPC, application/json reply)
//
// Tools:
//   echo{text}          → returns the text back
//   greet{name}         → returns "hi <name>"
//   env_echo{key}       → returns process.env[key]  (proves stdio secret → env injection)
//   header_echo{name}   → returns the named request header (proves http secret → header injection)
//
// Deliberately dependency-free (no MCP SDK) so the client side is what's under test.

const TOOLS = [
  { name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'greet', description: 'Greet a name', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'env_echo', description: 'Return an env var value', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'header_echo', description: 'Return a request header value', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  // Interactive-login simulation (generic QR-login flow, e2e-p33): get_login_qrcode returns an image
  // (QR), check_login_status flips to logged-in once the QR has been "shown + scanned".
  { name: 'get_login_qrcode', description: 'Return a QR image to scan for login', inputSchema: { type: 'object', properties: {} } },
  { name: 'check_login_status', description: 'Whether login has completed', inputSchema: { type: 'object', properties: {} } },
];

// A small PNG QR-ish image content (a black square) — stands in for the login QR.
const FAKE_QR_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAAAAAA6mKC9AAAAHElEQVR4nGNgYPjPQAz+P0oNA0PDqNRQ1AwAAObABQVOW7WYAAAAAElFTkSuQmCC';
// Simulate the phone scan with a short delay: check_login_status reports logged-in only a few
// seconds after the QR was requested — long enough for the UI to render the QR first.
let qrShownAt = 0;
const LOGIN_DELAY_MS = 3000;

const text = (s) => ({ content: [{ type: 'text', text: String(s ?? '') }], isError: false });

// Resolve a method to a JSON-RPC `result` (or null for notifications). `headers` is the current
// request's header bag (http mode) or {} (stdio).
function handle(method, params, headers) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mcp-stub', version: '1.0' } };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const name = params?.name;
      const a = params?.arguments ?? {};
      if (name === 'echo') return text(a.text);
      if (name === 'greet') return text(`hi ${a.name}`);
      if (name === 'env_echo') return text(process.env[a.key] ?? '');
      if (name === 'header_echo') return text(headers[String(a.name || '').toLowerCase()] ?? '');
      if (name === 'get_login_qrcode') {
        qrShownAt = Date.now(); // start the simulated scan window
        return { content: [
          { type: 'image', data: FAKE_QR_PNG, mimeType: 'image/png' },
          { type: 'text', text: '请用手机扫码登录' },
        ], isError: false };
      }
      if (name === 'check_login_status') {
        const loggedIn = qrShownAt > 0 && Date.now() - qrShownAt > LOGIN_DELAY_MS;
        return text(loggedIn ? '已登录 logged_in' : '未登录（请扫码）');
      }
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
    }
    default:
      return null; // notifications & unknown methods → no result
  }
}

const httpFlag = process.argv.indexOf('--http');
if (httpFlag !== -1) {
  const port = Number(process.argv[httpFlag + 1] || 0);
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const result = handle(msg.method, msg.params, req.headers);
      if (msg.id === undefined || result === null && msg.id === undefined) {
        // notification
        res.writeHead(202).end();
        return;
      }
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: result ?? {} });
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'stub-session' });
      res.end(payload);
    });
  });
  server.listen(port, '127.0.0.1', () => console.error(`[mcp-stub] http on ${port}`));
} else {
  // stdio: newline-delimited JSON-RPC.
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const result = handle(msg.method, msg.params, {});
      if (msg.id === undefined) continue; // notification → no reply
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }) + '\n');
    }
  });
}
