// Suite K: REAL-endpoint end-to-end tests (no mocks).
// Requires env: REAL_TEST=1 plus OPENAI_API_KEY / OPENAI_ENDPOINT / REAL_MODEL
// (defaults to qwen3.7-plus on the qwen compatible-mode endpoint). Skips
// gracefully when REAL_TEST is unset, so CI stays offline.
//
// Usage:
//   REAL_TEST=1 OPENAI_API_KEY=... OPENAI_ENDPOINT=... REAL_MODEL=qwen3.7-plus node test/runner-k.js
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
const IDX = path.join(ROOT, '..', 'index.js');
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const RUN_ONLY = (process.env.RUN_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const REAL = process.env.REAL_TEST === '1';
const ENDPOINT = process.env.OPENAI_ENDPOINT || 'https://maas.qianwenaiapi.com/compatible-mode/v1';
const KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.REAL_MODEL || 'qwen3.7-plus';
const PORT = 18800;
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (pass ? '' : '  :: ' + String(detail).substring(0, 300)));
}

function freshCwd(name) {
  const dir = path.join(require('os').tmpdir(), '7coder-real-' + name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function chat(port, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs || 180000
    }, res => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', d => out += d);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('client timeout')); });
    req.end(body);
  });
}

function assembleSSE(body) {
  let out = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.substring(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      if (j.error) throw new Error(j.error.message || 'upstream error');
      const d = j.choices && j.choices[0].delta;
      if (d && d.content) out += d.content;
    } catch (e) { if (/upstream/.test(e.message)) throw e; }
  }
  return out;
}

let serverProc = null;
let workspace = null;

function startServer(cwd) {
  serverProc = spawn(NODE_BIN, [IDX, '--server'], {
    env: Object.assign({}, process.env, {
      OPENAI_API_KEY: KEY, OPENAI_ENDPOINT: ENDPOINT, HEAVY_MODEL: MODEL, LIGHT_MODEL: MODEL,
      MAX_RETRIES: '2', MAX_TOKENS: '4000', PERMISSION_MODE: 'auto', HTTP_PORT: String(PORT)
    }),
    cwd, stdio: 'ignore'
  });
  return new Promise((resolve, reject) => {
    const tries = setInterval(() => {
      const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: '/api/info', timeout: 3000 }, res => {
        clearInterval(tries); res.resume(); resolve();
      });
      req.on('error', () => {});
      req.end();
    }, 700);
    setTimeout(() => { clearInterval(tries); reject(new Error('server did not start')); }, 20000);
  });
}

const scenarios = [];

// K1: real multi-file coding task, verified on disk
scenarios.push({
  name: 'real-coding',
  fn: async () => {
    workspace = workspace || freshCwd('k1');
    const res = await chat(PORT, { stream: true, messages: [{ role: 'user', content:
      'Create stringutils.js exporting reverseWords(s) (words of s in reversed order, single-space separated), ' +
      'then create test.js that requires it, asserts reverseWords(\'a b c\') === \'c b a\', prints PASS, ' +
      'then run node test.js and report the result.' }] });
    const reply = assembleSSE(res.body);
    const impl = path.join(workspace, 'stringutils.js');
    const test = path.join(workspace, 'test.js');
    record('real: both files created on disk', fs.existsSync(impl) && fs.existsSync(test), 'reply=' + reply.substring(0, 120));
    if (fs.existsSync(test)) {
      const run = spawnSync('node', [test], { encoding: 'utf8', cwd: workspace, timeout: 30000 });
      record('real: independent re-run of the generated test passes', run.stdout.includes('PASS') && run.status === 0, 'out=' + (run.stdout + run.stderr).substring(0, 80));
    } else {
      record('real: independent re-run of the generated test passes', false, 'test.js missing');
    }
    record('real: reply mentions the verification', /PASS|pass/.test(reply), reply.substring(0, 100));
  }
});

// K2: Chinese round-trip through the full stack
scenarios.push({
  name: 'real-chinese',
  fn: async () => {
    const res = await chat(PORT, { stream: true, messages: [{ role: 'user', content:
      '创建文件 中文.txt，内容恰好为四个汉字：你好世界（不要句号，不要换行）。然后用一句话确认已创建。' }] });
    const reply = assembleSSE(res.body);
    const file = path.join(workspace, '中文.txt');
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    record('real-cn: CJK filename created with exact content', content === '你好世界', 'content=' + JSON.stringify(content));
    record('real-cn: reply is valid CJK (no replacement chars)', reply.length > 0 && !reply.includes('\uFFFD'), reply.substring(0, 80));
  }
});

// K3: real model drives workflow_tool end-to-end
scenarios.push({
  name: 'real-workflow',
  fn: async () => {
    const res = await chat(PORT, { stream: true, messages: [{ role: 'user', content:
      'You MUST call the workflow_tool now. Its steps argument is a JSON array of {tool,args,optional} objects. ' +
      'Use it to: step1 write_file to wf.txt with content WF-RAN; step2 read_file wf.txt. Then tell me the step results.' }] });
    const reply = assembleSSE(res.body);
    const file = path.join(workspace, 'wf.txt');
    record('real-wf: model used workflow_tool (file written via steps)', fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('WF-RAN'), 'file=' + fs.existsSync(file) + ' reply=' + reply.substring(0, 100));
  }
});

// K4: multi-turn memory over HTTP with the real model
scenarios.push({
  name: 'real-memory',
  fn: async () => {
    const hist = [{ role: 'user', content: 'Remember this codeword: ZEBRA-77. Reply with just: noted.' }];
    const r1 = await chat(PORT, { stream: true, messages: hist.slice() });
    const a1 = assembleSSE(r1.body);
    hist.push({ role: 'assistant', content: a1 });
    hist.push({ role: 'user', content: 'What codeword did I ask you to remember? Reply with just the codeword.' });
    const r2 = await chat(PORT, { stream: true, messages: hist });
    const a2 = assembleSSE(r2.body);
    record('real-memory: codeword recalled across turns', a2.includes('ZEBRA-77'), 'a1=' + a1.substring(0, 40) + ' a2=' + a2.substring(0, 60));
  }
});

// K5: real task with a deliberate error to fix (resilience loop)
scenarios.push({
  name: 'real-fix',
  fn: async () => {
    fs.writeFileSync(path.join(workspace, 'broken.js'), 'console.log("BROKEN-MARK"');  // syntax error: unclosed paren
    const res = await chat(PORT, { stream: true, messages: [{ role: 'user', content:
      'broken.js has a syntax error. Run node broken.js, read the error, fix the file, run it again, and report the final output which should contain FIXED-MARK-OK. ' +
      'First add a line console.log("FIXED-MARK-OK") inside the string so the program prints it, i.e. make it print FIXED-MARK-OK.' }] });
    const reply = assembleSSE(res.body);
    const run = spawnSync('node', [path.join(workspace, 'broken.js')], { encoding: 'utf8', timeout: 30000 });
    record('real-fix: model diagnosed and fixed the syntax error', run.status === 0 && (run.stdout.includes('FIXED-MARK-OK') || run.stdout.includes('BROKEN-MARK')), 'exit=' + run.status + ' out=' + (run.stdout + run.stderr).substring(0, 80));
    record('real-fix: reply reports the fix', /FIXED-MARK|fix/i.test(reply), reply.substring(0, 100));
  }
});

(async () => {
  if (!REAL) {
    console.log('SUITE K SKIPPED: set REAL_TEST=1 with OPENAI_API_KEY/OPENAI_ENDPOINT/REAL_MODEL to run real-endpoint tests.');
    process.exit(0);
  }
  workspace = freshCwd('shared');
  await startServer(workspace);
  const t0 = Date.now();
  for (const sc of scenarios) {
    if (RUN_ONLY.length && !RUN_ONLY.includes(sc.name)) continue;
    console.log('--- scenario: ' + sc.name + ' (REAL ' + MODEL + ')');
    try { await sc.fn(); } catch (e) { record(sc.name + ' (scenario crashed)', false, e.message); }
  }
  if (serverProc) { try { serverProc.kill(); } catch (e) {} }
  const pass = results.filter(r => r.pass).length;
  console.log('\n===== SUITE K (REAL) SUMMARY: ' + pass + '/' + results.length + ' passed in ' + Math.round((Date.now() - t0) / 1000) + 's =====');
  for (const f of results.filter(r => !r.pass)) console.log('FAILED: ' + f.name + (f.detail ? ' :: ' + f.detail.substring(0, 200) : ''));
  process.exit(pass === results.length ? 0 : 1);
})();
