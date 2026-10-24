// All pathological matching runs in owned children, never in this supervisor.
const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http');
const S = require('./_shared').create({ suite: 'grep-deadline' }), sockets = new Set();
let fixture, checks = 0;
const deadline = setTimeout(() => { console.error('GREP/DEADLINE suite deadline'); S.cleanup(); process.exit(1); }, 15000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
async function until(test, label) { const end = Date.now() + 5000; while (!await test()) { if (Date.now() > end) throw Error('Timed out: ' + label); await new Promise(r => setTimeout(r, 5)); } }
async function port() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function api(p, url, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: p, path: url, method: data === null ? 'GET' : 'POST', timeout: 2500, headers: { 'Content-Type': 'application/json' } }, res => { res.setEncoding('utf8'); let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode, body })); res.on('error', reject); });
    req.on('error', reject); req.on('timeout', () => req.destroy(Error('Agent response deadline exceeded'))); req.end(data === null ? null : JSON.stringify(data));
  });
}
(async () => {
  try {
    const cwd = S.freshCwd('regex 中文'); fs.writeFileSync(path.join(cwd, 'input.txt'), 'a'.repeat(45) + '!');
    const script = path.join(S.runDir, 'match-owned.js');
    fs.writeFileSync(script, `const fs=require('fs'),vm=require('vm');const{loadContext}=require(${JSON.stringify(path.resolve(__dirname, 'download-commit.js'))});
const source=fs.readFileSync(${JSON.stringify(S.IDX)},'utf8');let reads=0;
const c=loadContext(source,${JSON.stringify(cwd)},{readFileSync(file,...args){reads++;return fs.readFileSync(file,...args)}},{Buffer,SCAN_SKIP_DIRS:[]});
const a=source.indexOf('function grepSearch('),b=source.indexOf('// Keep the handle until close',a);vm.runInContext(source.slice(a,b),c);
console.log('MATCH_STARTED');const first=c.grepSearch('(a|aa)+$','input.txt',{skipHeavy:true});console.log('BOUNDED '+first);
console.log('NEXT '+c.grepSearch('a','input.txt',{skipHeavy:true}));const before=reads;
console.log('EXPIRED '+c.grepSearch('(a|aa)+$','input.txt',{skipHeavy:true,deadlineAt:Date.now()-1}));console.log('READS_AFTER_EXPIRY '+(reads-before));
`);
    const child = S.spawn(S.NODE_BIN, [script], { cwd }); let output = '', expired = false, matchTimer;
    const startupTimer = setTimeout(() => { expired = true; child.kill(); }, 4000);
    child.stdout.on('data', d => { output += d; if (output.includes('MATCH_STARTED') && !matchTimer) { clearTimeout(startupTimer); matchTimer = setTimeout(() => { expired = true; child.kill(); }, 1000); } }); child.stderr.on('data', d => output += d);
    await new Promise(r => child.once('close', r)); clearTimeout(startupTimer); clearTimeout(matchTimer);
    check('actual source ambiguous regex returns within strict supervisor deadline', !expired && child.exitCode === 0 && output.includes('100ms matching budget exceeded'));
    check('same child remains usable after regex timeout', output.includes('NEXT input.txt: matches "a"'));
    check('inherited expired deadline avoids file reads and does not claim no matches', output.includes('EXPIRED [scan incomplete: time budget exhausted]') && output.includes('READS_AFTER_EXPIRY 0'));

    fixture = http.createServer((req, res) => {
      let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
        const body = JSON.parse(raw); const done = body.messages.some(m => m.role === 'tool');
        const bad = body.messages.some(m => String(m.content || '').includes('GREP_BAD'));
        const message = done ? { role: 'assistant', content: 'GREP_RECOVERED' } : { role: 'assistant', content: null, tool_calls: [{ id: 'grep-owned', type: 'function', function: { name: 'grep_tool', arguments: JSON.stringify({ path: 'input.txt', pattern: bad ? '(a|aa)+$' : '!$' }) } }] };
        res.end(JSON.stringify({ choices: [{ message }] }));
      });
    });
    fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(r => fixture.listen(0, '127.0.0.1', r));
    const p = await port(), agent = S.spawn(S.NODE_BIN, [S.IDX, '--server'], { cwd, env: Object.assign({}, process.env, { HTTP_PORT: String(p), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: '', PERMISSION_MODE: 'bypass', DREAM_ALLOW: 'false',
      OPENAI_ENDPOINT: 'http://127.0.0.1:' + fixture.address().port, OPENAI_API_KEY: '', HEAVY_MODEL: 'fixture', LIGHT_MODEL: '', SUMMARY_MODEL: '', AUDIT_LOG: 'true' }) });
    let agentOutput = ''; agent.stdout.on('data', d => agentOutput += d); agent.stderr.on('data', d => agentOutput += d);
    await until(async () => { if (agent.exitCode != null) throw Error(agentOutput); try { return (await api(p, '/api/info')).status === 200; } catch (e) { if (e.code !== 'ECONNREFUSED') throw e; return false; } }, 'Agent ready');
    let start = Date.now(), r = await api(p, '/v1/chat/completions', { messages: [{ role: 'user', content: 'GREP_BAD' }] });
    check('real Agent completes pathological tool request without wedging HTTP', r.status === 200 && r.body.includes('GREP_RECOVERED') && Date.now() - start < 2000);
    let log = fs.readFileSync(path.join(cwd, '.7coder', 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.type === 'tool');
    check('regex timeout is audited as error, not successful empty search', log[0].tool === 'grep_tool' && log[0].status === 'error' && log[0].result.includes('matching budget exceeded'));
    r = await api(p, '/v1/chat/completions', { messages: [{ role: 'user', content: 'GREP_NEXT' }] });
    log = fs.readFileSync(path.join(cwd, '.7coder', 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.type === 'tool');
    check('next real search succeeds and health/core activity recover', r.status === 200 && log.length === 2 && log[1].status === 'ok' && JSON.parse((await api(p, '/api/info')).body).runtime.activeTasks === 0);
    console.log('GREP/DEADLINE ' + checks + '/' + checks);
  } finally { clearTimeout(deadline); S.cleanup(); for (const socket of sockets) socket.destroy(); if (fixture) await new Promise(r => fixture.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
