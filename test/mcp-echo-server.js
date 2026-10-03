// mcp-echo-server.js - minimal MCP stdio server for the offline test suite.
// Speaks the real protocol over stdin/stdout (newline-delimited JSON-RPC 2.0):
//   initialize -> capabilities echo, notifications/initialized (logged)
//   tools/list -> echo (echoes text) + add (sums two numbers) + boom (isError)
//   tools/call -> dispatch
// Every received line is appended to MCP_ECHO_LOG (handshake assertions).
// Usage: MCP_ECHO_LOG=path node test/mcp-echo-server.js
const fs = require('fs');
const LOG = process.env.MCP_ECHO_LOG || '';
function logReceived(line) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}
const TOOLS = [
  { name: 'echo', description: 'Echo the given text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'boom', description: 'Always reports an error result.', inputSchema: { type: 'object', properties: {} } }
];
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.substring(0, nl).replace(/\r$/, '');
    buf = buf.substring(nl + 1);
    if (!line.trim()) continue;
    logReceived(line);
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.id !== undefined && msg.method) {
      let out;
      if (msg.method === 'initialize') {
        out = { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mcp-echo-server', version: '1.0.0' } } };
      } else if (msg.method === 'tools/list') {
        out = { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
      } else if (msg.method === 'tools/call') {
        const t = msg.params && msg.params.name;
        const a = (msg.params && msg.params.arguments) || {};
        if (t === 'echo') out = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ECHO:' + String(a.text == null ? '' : a.text) }] } };
        else if (t === 'add') out = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }] } };
        else if (t === 'boom') out = { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'boom as requested' }] } };
        else out = { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool: ' + t } };
      } else if (msg.method === 'ping') {
        out = { jsonrpc: '2.0', id: msg.id, result: {} };
      } else {
        out = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } };
      }
      process.stdout.write(JSON.stringify(out) + '\n');
    }
    // notifications (incl. notifications/initialized): received + logged, no reply
  }
});
process.stdin.on('end', () => process.exit(0));
