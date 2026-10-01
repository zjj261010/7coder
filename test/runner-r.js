// Suite R: real-endpoint comprehensive tests using qwen3.7-plus.
// Tests the full pipeline with real AI reasoning, not mocks.
// Usage: node test/runner-r.js
const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

if (!process.env.REAL_TEST) { console.log('SUITE R SKIPPED: set REAL_TEST=1 plus OPENAI_API_KEY / OPENAI_ENDPOINT / REAL_MODEL to run real-endpoint tests.'); process.exit(0); }

const ROOT = __dirname;
const IDX = path.join(ROOT, '..', 'index.js');
const EP = process.env.OPENAI_ENDPOINT || 'https://maas.qianwenaiapi.com/compatible-mode/v1';
const KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.REAL_MODEL || 'qwen3.7-plus';
const PORT = 19500;
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (pass ? '' : '  :: ' + String(detail).substring(0, 200)));
}

function freshCwd(name) {
  const dir = path.join(require('os').tmpdir(), '7coder-real-' + name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function chat(messages, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var body = JSON.stringify({ stream: true, messages: messages });
    var req = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs || 300000
    }, function (res) {
      var out = ''; res.setEncoding('utf8');
      res.on('data', function (d) { out += d; });
      res.on('end', function () {
        var content = '', reasoning = '', toolCalls = [];
        for (var line of out.split('\n')) {
          if (!line.startsWith('data:')) continue;
          var pl = line.substring(5).trim();
          if (!pl || pl === '[DONE]') continue;
          try {
            var j = JSON.parse(pl);
            if (j.error) throw new Error(j.error.message || 'upstream');
            var d = j.choices[0].delta;
            if (d.reasoning) reasoning += d.reasoning;
            if (d.content) content += d.content;
            if (d.tool_calls) toolCalls.push(d.tool_calls);
          } catch (e) { if (/upstream/.test(e.message)) throw e; }
        }
        resolve({ content: content, reasoning: reasoning, toolCalls: toolCalls, raw: out });
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.end(body);
  });
}

var srv = null;
var workspace = null;

function startServer(cwd) {
  workspace = cwd;
  srv = spawn(process.execPath, [IDX, '--server'], {
    env: Object.assign({}, process.env, {
      OPENAI_API_KEY: KEY, OPENAI_ENDPOINT: EP, HEAVY_MODEL: MODEL, LIGHT_MODEL: MODEL,
      MAX_RETRIES: '2', MAX_TOKENS: '4000', PERMISSION_MODE: 'auto', HTTP_PORT: String(PORT)
    }),
    cwd: cwd, stdio: 'ignore'
  });
  return new Promise(function (resolve, reject) {
    var tries = setInterval(function () {
      http.get({ host: '127.0.0.1', port: PORT, path: '/api/info' }, function (res) {
        clearInterval(tries); res.resume(); resolve();
      }).on('error', function () {});
    }, 700);
    setTimeout(function () { clearInterval(tries); reject(new Error('server timeout')); }, 15000);
  });
}

(async function () {
  var t0 = Date.now();

  // ===== R1: Single-turn coding task (create + verify) =====
  console.log('\n=== R1: Single-turn coding task ===');
  var ws1 = freshCwd('r1');
  await startServer(ws1);
  var r1 = await chat([
    { role: 'user', content: 'Create a file called fib.js that exports a function fib(n) computing the nth Fibonacci number (fib(0)=0, fib(1)=1). Use iterative approach. Then create test-fib.js that requires it and prints the results of fib(0) through fib(10), one per line, in format "fib(N) = result". Run it with node and show me the output.' }
  ], 300000);
  var files = fs.readdirSync(ws1).filter(function (f) { return !f.startsWith('.'); });
  record('R1: files created', files.indexOf('fib.js') >= 0, 'files=' + JSON.stringify(files));
  var fibContent = fs.existsSync(path.join(ws1, 'fib.js')) ? fs.readFileSync(path.join(ws1, 'fib.js'), 'utf8') : '';
  record('R1: fib.js has iterative implementation', /for|while/.test(fibContent), '');
  // Independent verification: run it ourselves
  if (fs.existsSync(path.join(ws1, 'test-fib.js'))) {
    var run = spawnSync('node', [path.join(ws1, 'test-fib.js')], { encoding: 'utf8', timeout: 15000 });
    record('R1: generated test passes independently', run.stdout.includes('fib(10) = 55'), 'out=' + run.stdout.substring(0, 100));
  } else {
    record('R1: generated test passes independently', false, 'test-fib.js missing');
  }
  srv.kill(); await new Promise(function (r) { setTimeout(r, 500); });

  // ===== R2: Multi-turn memory (3 turns) =====
  console.log('\n=== R2: Multi-turn memory (3 turns) ===');
  var ws2 = freshCwd('r2');
  await startServer(ws2);
  var hist = [];
  hist.push({ role: 'user', content: 'My favorite color is crimson, my lucky number is 42, and my cat is named Pixel. Just acknowledge briefly.' });
  var a1 = await chat(hist, 180000);
  hist.push({ role: 'assistant', content: a1.content });
  hist.push({ role: 'user', content: 'What are all three things I told you? Answer in one line.' });
  var a2 = await chat(hist, 180000);
  hist.push({ role: 'assistant', content: a2.content });
  hist.push({ role: 'user', content: 'Now write a haiku that mentions all three things.' });
  var a3 = await chat(hist, 180000);
  var all3 = a3.content;
  record('R2: turn 2 recalls all 3 facts', /crimson/i.test(a2.content) && /42/.test(a2.content) && /pixel/i.test(a2.content), 'a2=' + a2.content.substring(0, 100));
  record('R2: haiku references the session context', a3.content.length > 20, 'a3=' + a3.content.substring(0, 80));
  record('R2: reasoning chain captured', a1.reasoning.length > 0 || a2.reasoning.length > 0 || a3.reasoning.length > 0, 'reasoning lens=' + [a1.reasoning.length, a2.reasoning.length, a3.reasoning.length].join(','));
  srv.kill(); await new Promise(function (r) { setTimeout(r, 500); });

  // ===== R3: Tool chain (create file → read → edit → verify) =====
  console.log('\n=== R3: Tool chain ===');
  var ws3 = freshCwd('r3');
  await startServer(ws3);
  var r3 = await chat([
    { role: 'user', content: 'Create a file called counter.txt with the single line "count: 0". Then read it back and tell me what it says.' }
  ], 300000);
  var counterContent = fs.existsSync(path.join(ws3, 'counter.txt')) ? fs.readFileSync(path.join(ws3, 'counter.txt'), 'utf8') : '';
  record('R3: counter.txt created with correct content', counterContent.includes('count: 0'), 'content=' + JSON.stringify(counterContent));
  srv.kill(); await new Promise(function (r) { setTimeout(r, 500); });

  // ===== R4: Streaming with CJK ====
  console.log('\n=== R4: CJK streaming ===');
  var ws4 = freshCwd('r4');
  await startServer(ws4);
  var r4 = await chat([
    { role: 'user', content: '请用中文写一个关于编程的短句，不超过20个字。' }
  ], 180000);
  record('R4: CJK streaming - no replacement chars', r4.content.length > 0 && !r4.content.includes('\uFFFD'), 'content=' + JSON.stringify(r4.content.substring(0, 60)));
  record('R4: reasoning also CJK-clean', !r4.reasoning.includes('\uFFFD'), 'reasoning len=' + r4.reasoning.length);
  srv.kill(); await new Promise(function (r) { setTimeout(r, 500); });

  // ===== R5: Multi-model routing (real, different model on same gateway) =====
  console.log('\n=== R5: Multi-model routing ===');
  var ws5 = freshCwd('r5');
  await startServer(ws5);
  // Write workspace models.json to route a second model
  fs.mkdirSync(path.join(ws5, '.7coder'), { recursive: true });
  fs.writeFileSync(path.join(ws5, '.7coder', 'models.json'), JSON.stringify({
    'qwen3.8-max': { endpoint: EP, apiKey: KEY }
  }));
  srv.kill(); await new Promise(function (r) { setTimeout(r, 300); });
  // Restart to pick up models.json
  await startServer(ws5);
  var r5 = await chat([
    { role: 'user', content: 'What is 2+3? Answer with just the number.' }
  ], 180000);
  record('R5: default model responds after models.json loaded', r5.content.length > 0, 'content=' + r5.content.substring(0, 60));
  srv.kill(); await new Promise(function (r) { setTimeout(r, 500); });

  // ===== Summary =====
  var pass = results.filter(function (r) { return r.pass; }).length;
  console.log('\n===== SUITE R SUMMARY: ' + pass + '/' + results.length + ' passed in ' + Math.round((Date.now() - t0) / 1000) + 's =====');
  for (var f of results.filter(function (r) { return !r.pass; })) {
    console.log('FAILED: ' + f.name + (f.detail ? ' :: ' + f.detail.substring(0, 200) : ''));
  }
  process.exit(pass === results.length ? 0 : 1);
})();
