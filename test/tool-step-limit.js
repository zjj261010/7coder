const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const S = require('./_shared').create({ suite: 'tool-step-limit' });
const source = fs.readFileSync(S.IDX, 'utf8'), sockets = new Set();
let checks = 0, fixture;
const deadline = setTimeout(() => { console.error('TOOL/STEPS suite deadline'); S.cleanup(); process.exit(1); }, 15000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); }
(async () => {
  try {
    const config = cut('const rawMaxToolSteps =', '// Guard against nonsense values:');
    for (const [input, expected, warns] of [[undefined,30,0],['',30,0],['  ',30,0],['0',0,0],[' 0 ',0,0],['1',1,0],['30',30,0],['000',0,0],['-1',30,1],['1.5',30,1],['2garbage',30,1],['Infinity',30,1],['9007199254740992',30,1]]) {
      const warnings = [], c = vm.createContext({ process: { env: input === undefined ? {} : { MAX_TOOL_STEPS: input } }, console: { warn: text => warnings.push(text) } });
      const n = vm.runInContext(config + '\nMAX_TOOL_STEPS;', c);
      check('config ' + JSON.stringify(input) + ' resolves to ' + expected + ' with correct warning', n === expected && warnings.length === warns);
    }
    let calls = 0;
    const c = vm.createContext({ MAX_TOOL_STEPS: 0, HEAVY_MODEL: 'fixture', createModelContext: main => ({ main }), callOpenAI: () => { calls++; throw Error('must not run'); } });
    vm.runInContext(cut('function checkExecution(', 'function watchExecution(')+cut('async function processWithTools(', '// ====================== TASK CHANGE SUMMARY'), c);
    check('zero-step final-answer path still honours cancellation', (await c.processWithTools([{ role: 'user', content: 'stop' }], { cancel: () => true })).includes('aborted') && calls === 0);

    const requests = [];
    fixture = http.createServer((req, res) => {
      let raw = ''; req.setEncoding('utf8'); req.on('data', d => raw += d); req.on('end', () => {
        const body = JSON.parse(raw); requests.push(body);
        const message = body.tools ? { role: 'assistant', content: null, tool_calls: ['a','b'].map(id => ({ id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: id + '.txt', content: id }) } })) } : { role: 'assistant', content: 'STEPS_FINAL' };
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const delta = Object.assign({}, message);
          if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((tc, index) => Object.assign({ index }, tc));
          res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
        } else res.end(JSON.stringify({ choices: [{ message }] }));
      });
    });
    fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(r => fixture.listen(0, '127.0.0.1', r));
    for (const limit of ['0','1']) {
      requests.length = 0;
      const cwd = S.freshCwd('limit-' + limit), r = await S.runCli({ port: fixture.address().port, cwd, args: ['--prompt', 'run step limit ' + limit], timeoutMs: 5000,
        env: { MAX_TOOL_STEPS: limit, PERMISSION_MODE: 'bypass', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', AUDIT_LOG: 'true' } });
      check('real CLI cap ' + limit + ' completes normally (exit=' + r.code + ', tail=' + r.out.slice(-220) + ')', r.code === 0 && r.out.includes('STEPS_FINAL'));
      if (limit === '0') {
        check('zero sends exactly one model request without tool schemas', requests.length === 1 && !requests[0].tools && requests[0].messages.some(m => String(m.content).includes('Tool step limit (0)')));
        check('zero executes no files or audit tool calls', !fs.existsSync(path.join(cwd, 'a.txt')) && !fs.existsSync(path.join(cwd, 'b.txt')) && S.readLog(path.join(cwd,'.7coder','audit.jsonl')).every(row => row.type !== 'tool'));
      } else {
        check('one permits one tool round then a forced final request', requests.length === 2 && Array.isArray(requests[0].tools) && !requests[1].tools && requests[1].messages.some(m => String(m.content).includes('Tool step limit (1)')));
        check('one round keeps both call IDs and actual effects', ['a','b'].every(id => fs.readFileSync(path.join(cwd,id+'.txt'),'utf8') === id) && requests[1].messages.filter(m => m.role === 'tool').map(m => m.tool_call_id).join(',') === 'a,b');
      }
    }
    console.log('TOOL/STEPS ' + checks + '/' + checks);
  } finally { clearTimeout(deadline); S.cleanup(); for (const socket of sockets) socket.destroy(); if (fixture) await new Promise(r => fixture.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
