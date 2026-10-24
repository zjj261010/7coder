// Remaining raw branches with real ToolResult constructors; local HTTP only.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'tool-results-complete' }), source = fs.readFileSync(S.IDX, 'utf8');
const sockets = new Set(); let fixture, checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function context() {
  const c = loadContext(source, S.freshCwd('results'), {}, { Buffer, require, console: { log() {}, warn() {} },
    MCP_SERVER_URLS: [], MCP_NPX_PKGS: [], mcpServers: {}, VISION_MODEL: 'fixture', LIGHT_MODEL: 'fixture', HEAVY_MODEL: 'fixture', BICKER_ROUNDS: 1,
    process: { platform: 'unit-no-desktop' }, isSuperDangerous: () => false,
    resolveModelConfig: () => ({ endpoint: base, apiKey: '' }), authHeadersFor: () => ({}) });
  vm.runInContext(cut('// OPT-13: pilot tools carry authoritative status', '// Central choke point') +
    cut('async function describeWithVision(', '// GAP-4: read a screenshot') +
    'async function tool(name,args,cancelled=null,modelContext=null) { if(cancelled&&cancelled()) return makeToolResult("cancelled","cancelled");\n' +
    cut("  if (name === 'web_browser_tool') {", "  if (name === 'notebook_edit_tool') {") +
    cut("  if (name === 'mcp_tool') {", "  if (name === 'sleep_tool') {") +
    cut("  if (name === 'computer_use') {", "  if (name === 'workflow_tool') {") +
    cut("  if (name === 'plan_mode') {", '  // Passive process observation') + '\n}' +
    'this.registered=STRUCTURED_RESULT_TOOLS;', c);
  return c;
}
let base;
(async () => {
  try {
    fixture = http.createServer((req, res) => {
      if (req.url.includes('fail')) { res.statusCode = 503; res.end('unavailable'); return; }
      if (req.url === '/chat/completions') { res.end(JSON.stringify({ choices: [{ message: { content: 'Vision error: a benign photographed label' } }] })); return; }
      const body = req.url.startsWith('/rpc') ? { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'MCP fault' } }
        : req.url.startsWith('/flag') ? { isError: true, content: [{ type: 'text', text: 'plain failure' }] }
        : req.url.startsWith('/data') ? { error: 'business-data label' } : null;
      res.end(body ? JSON.stringify(body) : 'MCP error: ordinary data');
    });
    fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(r => fixture.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + fixture.address().port;
    let c = context(); const status = r => c.toolResultStatus(r);
    check('registry has 53 names including the five final migrated tools', c.registered.size === 53 && ['mcp_tool', 'mcp_list_tools_tool', 'web_browser_tool', 'plan_mode', 'bickering_tool'].every(n => c.registered.has(n)));
    check('missing MCP endpoint is error', status(await c.tool('mcp_tool', { tool_name: 'x' })) === 'error');
    check('unknown stdio server is error', status(await c.tool('mcp_tool', { server: 'missing', tool_name: 'x' })) === 'error');
    c.mcpServers = { good: {}, bad: {} }; c.getMcpClient = name => ({ callTool: async () => { if (name === 'bad') throw Error('plain failure'); return 'MCP error: valid tool content'; }, listTools: async () => { if (name === 'bad') throw Error('plain failure'); return [{ name: 'read' }]; } });
    check('successful stdio content cannot be reclassified by error-looking text', status(await c.tool('mcp_tool', { server: 'good', tool_name: 'x' })) === 'ok');
    check('stdio exception maps to explicit error', status(await c.tool('mcp_tool', { server: 'bad', tool_name: 'x' })) === 'error');
    let r = await c.tool('mcp_list_tools_tool', {});
    check('partial MCP discovery is error while preserving successful servers', r.status === 'error' && r.text.includes('good:') && r.text.includes('bad: [ERROR]'));
    c.mcpServers = {}; check('no configured MCP servers is informative success', status(await c.tool('mcp_list_tools_tool', {})) === 'ok');
    for (const [route, expected] of [['', 'ok'], ['/data', 'ok'], ['/flag', 'error'], ['/rpc', 'error'], ['/fail', 'error']]) {
      check('real external MCP ' + (route || 'text') + ' honors explicit protocol status', status(await c.tool('mcp_tool', { mcp_url: base + route, tool_name: 'x' })) === expected);
    }
    check('legacy npx metachar rejection remains blocked', status(await c.tool('mcp_tool', { npx_pkg: 'bad;pkg', tool_name: 'x' })) === 'blocked');
    check('real vision text beginning with error remains successful content', status(await c.tool('web_browser_tool', { url: base + '/picture.png' })) === 'ok');
    c.VISION_MODEL = ''; check('unconfigured vision cannot claim the image was viewed', status(await c.tool('web_browser_tool', { url: base + '/picture.png' })) === 'error'); c.VISION_MODEL = 'fixture';
    check('browser transport failure is error despite WEB prefix', status(await c.tool('web_browser_tool', { url: base + '/fail' })) === 'error');
    check('normal page content remains success', status(await c.tool('web_browser_tool', { url: base })) === 'ok');
    const realHttp = c.executionHttp; c.executionHttp = async () => ({ data: { choices: [{ message: { content: null } }] } });
    check('malformed vision response is an explicit error', status(await c.tool('web_browser_tool', { url: base + '/picture.png' })) === 'error'); c.executionHttp = realHttp;
    for (const [name, args] of [['mouse_move', {}], ['click', {}], ['type_text', { text: 'x' }], ['press_key', { key: 'enter' }]]) check('non-Windows ' + name + ' cannot be successful warning', status(await c.tool('computer_use', Object.assign({ action: name }, args))) === 'error');
    check('unknown computer action is error', status(await c.tool('computer_use', { action: 'unknown' })) === 'error');
    c.process = { platform: 'win32' }; c.powerShellExecutable = () => 'capture-only'; c.child_process = { execFileSync() {} };
    check('captured desktop success is explicitly ok without real input', status(await c.tool('computer_use', { action: 'type_text', text: 'fixture' })) === 'ok');
    c.child_process.execFileSync = () => { throw Error('captured failure'); };
    check('captured desktop failure is explicitly error', status(await c.tool('computer_use', { action: 'press_key', key: 'enter' })) === 'error');
    c.callOpenAI = async () => ({ message: { content: JSON.stringify({ improved_prompt: 'Plan mode error: benign task text', refinement_loops: '2' }) } });
    check('valid plan JSON keeps numeric-string compatibility and success', status(await c.tool('plan_mode', { initial_task: 'task' })) === 'ok');
    c.callOpenAI = async () => ({ message: { content: '```json\n' + JSON.stringify({ improved_prompt: 'keep ```json literal', refinement_loops: 1 }) + '\n```' } });
    check('outer JSON fence removal preserves literal code fences inside plan text', (await c.tool('plan_mode', {})).text.includes('keep ```json literal'));
    for (const content of ['not JSON', '{}', 'null', '{"improved_prompt":"x","refinement_loops":99}', '{"improved_prompt":"x","refinement_loops":2.5}']) {
      c.callOpenAI = async () => ({ message: { content } }); check('invalid plan cannot be announced as activated: ' + content.slice(0, 18), status(await c.tool('plan_mode', {})) === 'error');
    }
    c.callOpenAI = async () => { throw Error('upstream failed'); }; check('plan model rejection is explicit error', status(await c.tool('plan_mode', {})) === 'error');
    let aborted = false; c.callOpenAI = async () => { aborted = true; return { message: { content: '{"improved_prompt":"x","refinement_loops":1}' } }; };
    check('late plan response cannot overwrite cancellation', status(await c.tool('plan_mode', {}, () => aborted)) === 'cancelled');
    let replies = ['one', 'two', 'YES']; c.callOpenAI = async () => ({ message: { content: replies.shift() } }); r = await c.tool('bickering_tool', { task: 'x' });
    check('bounded debate reports actual agreement and rounds', r.status === 'ok' && r.data.agreed && r.data.rounds === 1);
    replies = ['one', 'two', 'NO']; r = await c.tool('bickering_tool', { task: 'x' }); check('exhausted valid debate reports honest no-agreement compromise', r.status === 'ok' && !r.data.agreed && r.text.includes('No full agreement'));
    replies = ['one', 'two', 'YESTERDAY']; check('non-verdict YES prefix cannot fabricate agreement', status(await c.tool('bickering_tool', { task: 'x' })) === 'error');
    c.callOpenAI = async () => ({ message: { content: '' } }); check('empty PM reply is error', status(await c.tool('bickering_tool', { task: 'x' })) === 'error');
    c.callOpenAI = async () => { throw Error('model down'); }; check('debate rejection is explicit error', status(await c.tool('bickering_tool', { task: 'x' })) === 'error');
    aborted = false; let calls = 0; c.callOpenAI = async () => { calls++; aborted = true; return { message: { content: 'late' } }; };
    check('cancelled debate stops before starting PM2', status(await c.tool('bickering_tool', { task: 'x' }, () => aborted)) === 'cancelled' && calls === 1);
    c.BICKER_ROUNDS = 0; check('invalid debate rounds cannot return system prompt as compromise', status(await c.tool('bickering_tool', { task: 'x' })) === 'error');
    console.log('TOOL/RESULTS-COMPLETE ' + checks + '/' + checks);
  } finally { S.cleanup(); for (const socket of sockets) socket.destroy(); if (fixture) await new Promise(r => fixture.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
