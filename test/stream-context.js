// T22-04/05: asynchronous stream faults, lossless compression commit boundary,
// and recovery of the real HTTP backend. No external model or desktop access.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { PassThrough } = require('stream');
const http = require('http');
const S = require('./_shared').create({ suite: 'stream-context' });
const src = fs.readFileSync(S.IDX, 'utf8');
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const parse = vm.runInNewContext(src.match(/^const MODEL_RESPONSE_MAX_BYTES = .*;$/m)[0] + '\n(' + cut('function parseSSEStream(', 'async function callOpenAI(') + ')', { Buffer });
let checks = 0, backend, upstream;
function check(name, condition) { assert.ok(condition, name); checks++; console.log('PASS ' + name); }
const tick = () => new Promise(resolve => setImmediate(resolve));
const frame = value => 'data: ' + JSON.stringify(value) + '\n\n';
async function rejectsFrame(value) {
  const input = new PassThrough();
  const result = parse(input, () => {}).then(() => null, e => e);
  setImmediate(() => input.end(frame(value)));
  const error = await result; await tick();
  return error && /^upstream error:/.test(error.message) && input.destroyed &&
    ['data', 'end', 'error', 'close', 'aborted'].every(event => input.listenerCount(event) === 0);
}
function context(callOpenAI, budget = 1000) {
  const sandbox = vm.createContext({ console: { log() {}, warn() {} }, LIGHT_MODEL: 'fixture', HEAVY_MODEL: 'fixture',
    createModelContext: main => ({ main, light: 'fixture', summary: 'fixture' }),
    CONTEXT_CHARS: budget, MAX_TOOL_STEPS: 2, callOpenAI, READ_ONLY_TOOLS: new Set(), capToolResult: String,
    safeExecuteTool: () => { throw Error('tool must not run after compression failure'); } });
  vm.runInContext(cut('function charUnits(', '// ====================== TASK CHANGE SUMMARY'), sandbox);
  return sandbox;
}
const history = () => [{ role: 'system', content: 'system' },
  { role: 'user', content: 'PRESERVE_DATABASE ' + 'x'.repeat(1500) },
  { role: 'assistant', content: 'old result' }, { role: 'user', content: 'continue' }];
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('test deadline')), 10000); })]); }
  finally { clearTimeout(timer); }
}
(async () => {
  try {
    for (const [name, value] of [
      ['null', null], ['array', []], ['primitive', true], ['choices object', { choices: {} }],
      ['null choice', { choices: [null] }], ['delta primitive', { choices: [{ delta: false }] }],
      ['content object', { choices: [{ delta: { content: {} } }] }],
      ['tool_calls object', { choices: [{ delta: { tool_calls: {} } }] }],
      ['null tool call', { choices: [{ delta: { tool_calls: [null] } }] }],
      ['negative index', { choices: [{ delta: { tool_calls: [{ index: -1 }] } }] }],
      ['huge index', { choices: [{ delta: { tool_calls: [{ index: 1e9 }] } }] }],
      ['invalid arguments', { choices: [{ delta: { tool_calls: [{ function: { arguments: {} } }] } }] }]
    ]) check('reject/close/clean ' + name, await rejectsFrame(value));

    const input = new PassThrough(); let visible = '';
    const success = parse(input, t => visible += t);
    setImmediate(() => input.end(': comment\n' + 'data: {broken\n\n' +
      frame({ choices: [{ delta: { content: '中文', tool_calls: [{ index: 0, id: 't1', function: { name: 'read_', arguments: '{"path":' } }] } }] }) +
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: '"a"}' } }] }, finish_reason: 'tool_calls' }] }) +
      frame({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }) + 'data: [DONE]\n\n'));
    const choice = await success;
    check('valid UTF8/fragments/usage/noisy JSON stay compatible', visible === '中文' && choice.message.tool_calls[0].function.name === 'read_file' && choice.message.tool_calls[0].function.arguments === '{"path":"a"}' && choice.usage.prompt_tokens === 2);
    check('success detaches parser listeners', ['data', 'end', 'error', 'close', 'aborted'].every(event => input.listenerCount(event) === 0));
    for (const event of ['close', 'aborted', 'error']) {
      const broken = new PassThrough();
      const result = parse(broken, () => {}).then(() => false, () => true);
      setImmediate(() => broken.emit(event, Error('fixture failure')));
      check('premature ' + event + ' rejects', await result);
    }
    const callbackStream = new PassThrough();
    const callbackFailure = parse(callbackStream, () => { throw Error('consumer failed'); }).then(() => false, () => true);
    setImmediate(() => callbackStream.end(frame({ choices: [{ delta: { content: 'x' } }] })));
    check('consumer callback exception is contained', await callbackFailure);
    const partial = new PassThrough();
    const incomplete = parse(partial, () => {}).then(() => false, e => e.message.includes('without completion'));
    setImmediate(() => partial.end(frame({ choices: [{ delta: { content: 'partial' } }] })));
    check('unfinished EOF still rejects', await incomplete);

    for (const response of ['throw', '', '   ', null]) {
      let mainCalls = 0;
      const ctx = context(async (messages, options) => {
        if (options.useTools !== false) { mainCalls++; throw Error('unexpected main call'); }
        if (response === 'throw') throw Error('summary offline');
        return { message: { content: response } };
      });
      const original = history(), before = JSON.stringify(original);
      let error;
      try { await ctx.processWithTools(original); } catch (e) { error = e; }
      check('failed/empty digest preserves history and stops main: ' + JSON.stringify(response), error && error.message.includes('original history preserved') && JSON.stringify(original) === before && mainCalls === 0);
    }
    let chunks = [];
    const ctx = context(async messages => {
      const text = messages[0].content;
      chunks.push(text.slice(text.indexOf('\n\n') + 2));
      return { message: { content: 'summary including completed side effects' } };
    });
    const long = [{ role: 'assistant', content: 'a'.repeat(19988) + '😀' + 'b'.repeat(22000) + 'TAIL_CONSTRAINT' }];
    const summary = await ctx.summarizeConversation(long);
    check('all >20K input including tail reaches summarizer', chunks.length === 3 && chunks.join('') === 'assistant: ' + long[0].content && chunks.every(p => p.length <= 20000 && !(p.charCodeAt(p.length - 1) >= 0xD800 && p.charCodeAt(p.length - 1) <= 0xDBFF)) && summary.includes('completed side effects'));
    let attempts = 0;
    const failedPart = context(async () => { if (++attempts === 2) throw Error('part two failed'); return { message: { content: 'part one' } }; });
    const multiple = [{ role: 'system', content: 's' }, { role: 'user', content: 'x'.repeat(25000) }, { role: 'assistant', content: 'old result' }, { role: 'user', content: 'continue' }];
    const multipleBefore = JSON.stringify(multiple);
    let multipartError;
    try { await failedPart.compressConversationIfNeeded(multiple); } catch (e) { multipartError = e; }
    check('later summary part failure commits nothing', attempts === 2 && multipartError && JSON.stringify(multiple) === multipleBefore);
    const active = { role: 'user', content: 'DO_NOT_REPEAT completed write; keep database unchanged' };
    const calls = [{ id: 'c1', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"done"}' } }];
    const live = [{ role: 'system', content: 's' }, active,
      { role: 'assistant', content: '', tool_calls: calls }, { role: 'tool', tool_call_id: 'c1', content: 'completed '.repeat(150) },
      { role: 'assistant', content: 'tail '.repeat(150) }];
    chunks = []; await ctx.compressConversationIfNeeded(live);
    check('active instruction remains verbatim after compression', live.includes(active) && active.content.startsWith('DO_NOT_REPEAT'));
    check('completed tool result and exact arguments reach digest', chunks.join('').includes('completed') && chunks.join('').includes('a.txt'));
    check('kept tail has no orphan tool message', !live.some((m, i) => m.role === 'tool' && (!live[i - 1] || !['assistant', 'tool'].includes(live[i - 1].role))));

    let upstreamCalls = 0;
    upstream = http.createServer((req, res) => {
      req.resume(); req.on('end', () => {
        upstreamCalls++; res.setHeader('Content-Type', 'text/event-stream');
        res.end(upstreamCalls === 1 ? 'data: null\n\n' : frame({ choices: [{ delta: { content: 'RECOVERED' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
      });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const portProbe = http.createServer();
    await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
    backend = S.spawn(S.NODE_BIN, [S.IDX, '--server'], { cwd: S.freshCwd('http'), stdio: 'ignore', env: Object.assign({}, process.env, {
      HTTP_PORT: String(port), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: '', OPENAI_ENDPOINT: 'http://127.0.0.1:' + upstream.address().port + '/v1',
      OPENAI_API_KEY: '', HEAVY_MODEL: 'fixture', MAX_RETRIES: '1', PERMISSION_MODE: 'denial', DREAM_ALLOW: 'false'
    }) });
    await bounded((async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { if ((await S.httpReq(port, 'GET', '/api/info', null)).status === 200) return; } catch (e) {}
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw Error('backend did not become ready');
    })());
    const chat = { stream: true, messages: [{ role: 'user', content: 'fixture' }] };
    const bad = await bounded(S.httpReq(port, 'POST', '/v1/chat/completions', chat));
    check('real backend returns SSE error for null payload', bad.body.includes('invalid SSE data') && bad.body.includes('[DONE]'));
    check('real backend remains healthy after invalid payload', (await bounded(S.httpReq(port, 'GET', '/api/info', null))).status === 200);
    const good = await bounded(S.httpReq(port, 'POST', '/v1/chat/completions', chat));
    check('next real request succeeds and gate is released', good.body.includes('RECOVERED') && upstreamCalls === 2);
    console.log('STREAM/CONTEXT: ' + checks + '/' + checks);
  } finally {
    S.cleanup();
    if (upstream) await new Promise(resolve => upstream.close(resolve));
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
