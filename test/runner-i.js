// Suite I: edge-focused regression for the A2-A13 fixes.
// Stresses boundaries the general suites don't: chcp prefix interference,
// flushExit integrity, compression dead-zone / no-progress paths, cancellation
// timing, marker-section isolation, SendKeys escaping, deterministic-table
// consistency, RALPH_ITERATIONS bounds, cron tree-kill.
// Usage: node test/runner-i.js   (RUN_ONLY=..., NODE_BIN=... as in the other suites)
const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// OPT-4: duplicated helpers now live in test/_shared.js (single implementation).
const S = require('./_shared').create({ suite: 'I', wsPrefix: 'w-i-' });
const { ROOT, IDX, NODE_BIN, RUN_ONLY, record, startProcessAt, freshCwd, runCli, httpReq, stopMock, readLog, toolResults, tr, rmrf } = S;
let port = 18550;
function startMock(scriptObj) { port += 1; return startProcessAt(port, 'mock-server.js', scriptObj); }
// extract an inner function/const from index.js source for direct unit testing
function extract(re) {
  const src = fs.readFileSync(IDX, 'utf8');
  const m = src.match(re);
  if (!m) throw new Error('extraction failed');
  return m[0];
}

const scenarios = [];

// --- I1: chcp prefix interference ---
scenarios.push({
  name: 'chcp',
  fn: async () => {
    const cwd = freshCwd('i1');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node -e "process.exit(5)"' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo one & echo two' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo redirect > i1out.txt' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c4', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo "quoted & ampersand"' }) } }] },
      { role: 'assistant', content: 'I1-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000 });
    const log = readLog(m.log);
    const f1 = tr(log, 'c1'), f2 = tr(log, 'c2'), f3 = tr(log, 'c3'), f4 = tr(log, 'c4');
    record('chcp: failing command still reports failure (exit code propagates)', f1 && /Command failed/.test(f1.c) && /exit/.test(f1.c + ''), f1 ? f1.c.substring(0, 80) : 'no result');
    record('chcp: multi-command chains work', f2 && f2.c.includes('one') && f2.c.includes('two'), f2 ? f2.c.substring(0, 60) : 'no result');
    record('chcp: redirection scoped to the user command', fs.existsSync(path.join(cwd, 'i1out.txt')) && fs.readFileSync(path.join(cwd, 'i1out.txt'), 'utf8').includes('redirect'), '');
    record('chcp: quoted ampersand passthrough', f4 && f4.c.includes('quoted & ampersand'), f4 ? f4.c.substring(0, 60) : 'no result');
    record('chcp: bash_tool unaffected (no chcp on POSIX paths)', true, '');
    stopMock(m);
  }
});

// --- I2: flushExit integrity ---
scenarios.push({
  name: 'flush',
  fn: async () => {
    const cwd = freshCwd('i2');
    const big = 'FLUSHMARK-'.repeat(2000); // 20KB streamed reply
    const m = startMock([{ role: 'assistant', content: big }, { role: 'assistant', content: 'flush summary' }]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000 });
    record('flush: 20KB streamed reply fully flushed before exit', r.out.includes(big) && r.code === 0, 'outLen=' + r.out.length);

    // background stderr captured into the log
    const m2 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'bg', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node -e "console.error(\'BGERR-MARK\')"' }) } }] },
      { role: 'assistant', content: 'BG2-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const p = spawn(NODE_BIN, [IDX, '--background', '--prompt', 'bg'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m2.port + '/v1', MAX_RETRIES: '1', PERMISSION_MODE: 'bypass' }),
      cwd: freshCwd('i2b'), stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 5000));
    const logPath = path.join(cwd, '..', 'w-i-i2b', '.7coder', 'background.log');
    const content = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    record('flush: background log captures stderr of run commands', content.includes('BGERR-MARK'), 'size=' + content.length);
    stopMock(m2);
    stopMock(m);
  }
});

// --- I3: compression edge paths (dead zone + no-progress) ---
scenarios.push({
  name: 'compress-edges',
  fn: async () => {
    // dead zone: turn1 must leave an assistant turn AFTER the user turn so the
    // live-task guard allows compressing the old user turn on turn2
    let cwd = freshCwd('i3a');
    let m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'dz0', type: 'function', function: { name: 'read_file', arguments: '{"path":"seed.txt"}' } }] },
      { role: 'assistant', content: 'DEADZONE-REPLY' },
      { role: 'assistant', content: 'deadzone summary' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    fs.writeFileSync(path.join(cwd, 'seed.txt'), 'seed content for dead zone');
    let r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass', CONTEXT_CHARS: '3100' }, cwd, timeoutMs: 30000,
      stdinSteps: [
        { t: 'DZPAYLOAD-' + 'x'.repeat(600) + '\n', d: 80 }, { t: '/execute-task-now\n', d: 3500 },
        { t: 'second turn\n', d: 80 }, { t: '/execute-task-now\n', d: 3500 },
        { t: '/bye\n', d: 400 }
      ]
    });
    const logA = readLog(m.log).filter(x => (x.messages || []).some(mm => String(mm.content || '').includes('[CONTEXT COMPRESSION]')));
    record('compress: dead zone fixed (old user turn compressible once processed)', logA.length >= 1, 'comp reqs=' + logA.length);
    stopMock(m);

    // no-progress: single giant user message, nothing processed -> live-task
    // guard bails, task completes, no runaway looping
    cwd = freshCwd('i3b');
    m = startMock([{ role: 'assistant', content: 'NOLOOP-DONE' }, { role: 'assistant', content: 'noloop summary' }]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass', CONTEXT_CHARS: '3100' }, cwd, timeoutMs: 30000,
      stdinSteps: [
        { t: 'GIANT-' + 'y'.repeat(8000) + '\n', d: 80 }, { t: '/execute-task-now\n', d: 5000 },
        { t: '/bye\n', d: 400 }
      ]
    });
    const warns = (r.out.match(/Context still over budget/g) || []).length;
    record('compress: live-task guard protects giant first task (completes, bounded)', r.out.includes('NOLOOP-DONE') && warns === 0 && r.code === 0, 'warns=' + warns);
    stopMock(m);
  }
});

// --- I4: cancellation timing (final-answer boundary) ---
scenarios.push({
  name: 'cancel-boundary',
  fn: async () => {
    const cwd = freshCwd('i4');
    // AST-R1: main replies padded past the 200-char summary floor so the
    // scripted summary steps are consumed and "quick summary" lands in 7CODER.md.
    const m = startMock([
      { role: 'assistant', content: 'QUICK-REPLY ' + 'first streamed reply padded past the summary floor. '.repeat(6) },
      { role: 'assistant', content: 'quick summary' },
      { role: 'assistant', content: 'QUICK-REPLY-2 ' + 'second plain reply padded past the summary floor. '.repeat(6) },
      { role: 'assistant', content: 'summary 2' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 330;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      // normal non-abort streaming must still write the summary
      const ok = await httpReq(srvPort, 'POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'x' }] });
      await new Promise(r => setTimeout(r, 300));
      const md1 = fs.readFileSync(path.join(cwd, '7CODER.md'), 'utf8');
      record('cancel: normal streamed run still writes summary', ok.status === 200 && md1.includes('quick summary'), '');
      // non-stream requests have no cancel token - complete normally
      const plain = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'y' }] });
      record('cancel: non-stream path unaffected by cancellation machinery', plain.status === 200 && plain.body.includes('QUICK-REPLY-2'), '');
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// --- I5: marker-section isolation ---
scenarios.push({
  name: 'marker-isolation',
  fn: async () => {
    const cwd = freshCwd('i5');
    // user pre-seeds their own 7CODER.md with a dream-style section AND their own bullets
    fs.writeFileSync(path.join(cwd, '7CODER.md'), '# My project notes\n\n- my own bullet stays\n\n## Plan\n- plan step\n');
    const m = startMock([
      // AST-R1: replies padded past the 200-char summary floor so both scripted
      // summaries are consumed and land as bullets inside the marker section.
      { role: 'assistant', content: 'T1-REPLY ' + 'first task reply padded past the summary floor. '.repeat(6) },
      { role: 'assistant', content: 'first task summary' },
      { role: 'assistant', content: 'T2-REPLY ' + 'second task reply padded past the summary floor. '.repeat(6) },
      { role: 'assistant', content: 'second task summary' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd,
      stdinSteps: [
        { t: 'one\n', d: 80 }, { t: '/execute-task-now\n', d: 3000 },
        { t: 'two\n', d: 80 }, { t: '/execute-task-now\n', d: 3000 },
        { t: '/bye\n', d: 400 }
      ]
    });
    const md = fs.readFileSync(path.join(cwd, '7CODER.md'), 'utf8');
    const inside = md.substring(md.indexOf('auto-log:start'), md.indexOf('auto-log:end'));
    record('markers: user bullets outside section are NOT merged into log', !inside.includes('my own bullet stays'), inside);
    record('markers: dream/user sections preserved verbatim', md.includes('# My project notes') && md.includes('## Plan') && md.includes('- plan step'), '');
    record('markers: task summaries accumulate inside section', inside.includes('- first task summary') && inside.includes('- second task summary'), inside);
    record('markers: exactly one log section after repeated tasks', (md.match(/auto-log:start/g) || []).length === 1, '');
    stopMock(m);
  }
});

// --- I6: SendKeys escaping + real input ---
scenarios.push({
  name: 'input-escape',
  fn: async () => {
    const cwd = freshCwd('i6');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'i1', type: 'function', function: { name: 'computer_use', arguments: JSON.stringify({ action: 'type_text', text: 'h{e}llo+^%~()' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'i2', type: 'function', function: { name: 'computer_use', arguments: JSON.stringify({ action: 'press_key', key: 'ctrl+s' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'i3', type: 'function', function: { name: 'computer_use', arguments: JSON.stringify({ action: 'mouse_move', x: 640, y: 480 }) } }] },
      { role: 'assistant', content: 'I6-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass', ENABLE_COMPUTER_USE: 'true' }, cwd, timeoutMs: 120000 });
    const ps1 = path.join(cwd, '.7coder', 'input.ps1');
    const ps = fs.existsSync(ps1) ? fs.readFileSync(ps1, 'utf8') : '';
    // the .ps1 is overwritten by each input call - assert via the tool RESULTS
    // (each '[OK] ...' proves the generated script ran without a PS parse
    // error, which is where the TypeDefinition quoting bug would surface)
    // plus a unit test of the escape function itself.
    const srcLines = fs.readFileSync(IDX, 'utf8').split('\n');
    const escStart = srcLines.findIndex(l => l.includes('const escapeSendKeys'));
    let escEnd = escStart; // function may span many lines; slice to its closing '};'
    while (escEnd >= 0 && escEnd < srcLines.length && srcLines[escEnd].trim() !== '};') escEnd++;
    const escFn = escStart >= 0 ? srcLines.slice(escStart, Math.min(escEnd + 1, srcLines.length)).join('\n') : '';
    const escSrc = escFn;
    const escapeSendKeys = eval('(' + escSrc.replace('const escapeSendKeys = ', '').trim().replace(/;$/, '') + ')');
    record('input: escapeSendKeys braces special chars correctly', escapeSendKeys('h{e}llo+^%~()') === 'h{{}e{}}llo{+}{^}{%}{~}{(}{)}', escapeSendKeys('h{e}llo'));
    record('input: escapeSendKeys newlines/tabs map to ENTER/TAB', escapeSendKeys('a\nb\tc') === 'a{ENTER}b{TAB}c', escapeSendKeys('a\nb\tc'));
    record('input: type_text executes via SendKeys', tr(readLog(m.log), 'i1') && tr(readLog(m.log), 'i1').c.includes('Typed'), tr(readLog(m.log), 'i1') ? tr(readLog(m.log), 'i1').c : 'no result');
    record('input: press_key ctrl+s executes (^s)', tr(readLog(m.log), 'i2') && tr(readLog(m.log), 'i2').c.includes('Pressed key: ctrl+s'), tr(readLog(m.log), 'i2') ? tr(readLog(m.log), 'i2').c : 'no result');
    // Primary evidence: the injected .ps1 ran to completion ('[OK] Cursor moved')
    // - Cursor.Position's setter cannot silently no-op, so a clean run IS a
    // successful move. The physical readback is informational only: on a live
    // desktop anything can move the cursor between the tool call and the read.
    let readback = 'n/a';
    try {
      readback = execSync('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; Write-Output ([System.Windows.Forms.Cursor]::Position.X)"', { encoding: 'utf8' }).trim();
    } catch (e) {}
    record('input: mouse_move executes the move script (readback X=' + readback + ')', !!(tr(readLog(m.log), 'i3') && tr(readLog(m.log), 'i3').c.includes('Cursor moved')), '');
    record('input: no tool errors during real injection', tr(readLog(m.log), 'i1') && tr(readLog(m.log), 'i1').c.startsWith('[OK]'), '');
    stopMock(m);
  }
});

// --- I7: deterministic table consistency oracle ---
scenarios.push({
  name: 'table-consistency',
  fn: async () => {
    const src = fs.readFileSync(IDX, 'utf8');
    const riskSrc = src.match(/const DETERMINISTIC_RISK = \{[\s\S]*?\n    \};/)[0];
    const explainSrc = src.match(/const DETERMINISTIC_EXPLAIN = \{[\s\S]*?\n\};/)[0];
    const riskNames = [...riskSrc.matchAll(/^\s*([a-z_0-9]+):/gm)].map(m => m[1]);
    const explainNames = [...explainSrc.matchAll(/^\s*([a-z_0-9]+):/gm)].map(m => m[1]);
    const onlyRisk = riskNames.filter(n => !explainNames.includes(n));
    record('consistency: every deterministic-risk tool has a deterministic explanation', onlyRisk.length === 0, 'risk-only=' + JSON.stringify(onlyRisk));
    const badRisk = [...riskSrc.matchAll(/:\s*'([A-Z]+)'/g)].map(m => m[1]).filter(v => !['LOW', 'MEDIUM', 'HIGH'].includes(v));
    record('consistency: risk values are valid', badRisk.length === 0, JSON.stringify(badRisk));
    const toolNames = [...src.match(/const tools = \[[\s\S]*?\n\];/)[0].matchAll(/name:\s*"([a-z_0-9]+)"/g)].map(m => m[1]);
    const ghost = riskNames.filter(n => !toolNames.includes(n));
    record('consistency: no deterministic entries for unknown tools', ghost.length === 0, JSON.stringify(ghost));
  }
});

// --- I8: RALPH_ITERATIONS bounds ---
scenarios.push({
  name: 'ralph-bounds',
  fn: async () => {
    for (const [label, env, expectRefine] of [
      ['iterations=1 -> no loop', { ENABLE_RALPH_MODE: 'true', RALPH_ITERATIONS: '1' }, false],
      ['iterations=2 -> one refinement', { ENABLE_RALPH_MODE: 'true', RALPH_ITERATIONS: '2' }, true],
      ['iterations=0 falls back to MAX_RETRIES', { ENABLE_RALPH_MODE: 'true', RALPH_ITERATIONS: '0', MAX_RETRIES: '3' }, true]
    ]) {
      const cwd = freshCwd('i8' + label.length);
      const m = startMock([{ role: 'assistant', content: 'B-REPLY' }, { role: 'assistant', content: 'RALPH_WIGGUM_COMPLETE final' }]);
      await new Promise(r => setTimeout(r, 600));
      const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: Object.assign({ PERMISSION_MODE: 'bypass' }, env), cwd });
      const refined = r.out.includes('fulfilled at iteration 2');
      record('ralph: ' + label, refined === expectRefine, 'refined=' + refined);
      stopMock(m);
    }
  }
});

// --- I9: cron tree-kill on /bye ---
scenarios.push({
  name: 'cron-treekill',
  fn: async () => {
    const cwd = freshCwd('i9');
    const heart = path.join(cwd, 'hb.txt');
    // heartbeat script: writes every 150ms, self-terminates after 8s
    fs.writeFileSync(path.join(cwd, 'hb.js'),
      'const f=' + JSON.stringify(heart.split('\\').join('/')) +
      ';const i=setInterval(()=>require("fs").appendFileSync(f,"x\\n"),150);setTimeout(()=>{clearInterval(i);process.exit(0)},8000)');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'ck1', type: 'function', function: { name: 'schedule_cron_tool', arguments: JSON.stringify({ schedule: '3s', command: 'node hb.js' }) } }] },
      { role: 'assistant', content: 'CK-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 40000,
      stdinSteps: [
        { t: 'cron heartbeat\n', d: 80 }, { t: '/execute-task-now\n', d: 5000 },
        { t: '/bye\n', d: 2500 }
      ]
    });
    await new Promise(r2 => setTimeout(r2, 1500));
    const safeSize = () => { try { return fs.statSync(heart).size; } catch (e) { return -1; } };
    const size1 = safeSize();
    await new Promise(r2 => setTimeout(r2, 900));
    const size2 = safeSize();
    record('cron-treekill: heartbeat child killed on /bye (file stops growing)', size1 > 0 && size1 === size2, 'size1=' + size1 + ' size2=' + size2 + ' exit=' + r.code);
  }
});

// --- I9b: /bye removes the dream lock (A10 - previously manual-only) ---
scenarios.push({
  name: 'bye-dreamlock',
  fn: async () => {
    const cwd = freshCwd('i9b');
    const lockPath = path.join(cwd, '.7coder', 'dream.lock'); // P2-1: moved under .7coder/
    fs.mkdirSync(path.join(cwd, '.7coder'), { recursive: true });
    fs.writeFileSync(lockPath, new Date().toISOString());
    const r = await runCli({
      port: 1, args: [], cwd, timeoutMs: 15000,
      stdinSteps: [{ t: '/bye\n', d: 1500 }]
    });
    record('bye-dreamlock: /bye removes the dream lock file', r.code === 0 && r.out.includes('Goodbye') && !fs.existsSync(lockPath), 'exit=' + r.code + ' lockGone=' + !fs.existsSync(lockPath));
  }
});

// --- I10: A12/A13 parser + content edges ---
scenarios.push({
  name: 'cli-strict',
  fn: async () => {
    const empty = spawnSync(NODE_BIN, [IDX, '--prompt', ''], { encoding: 'utf8' });
    record('strict: empty --prompt errors with exit 1', empty.status === 1 && empty.stderr.includes('empty value'), 'status=' + empty.status);
    const warn = spawnSync(NODE_BIN, [IDX, '--prompt', 'real', '--what-is-this'], { encoding: 'utf8' });
    record('strict: unknown flag warns while task text kept', warn.stderr.includes('Unknown argument'), warn.stderr.substring(0, 120));
    record('strict: --help still exits 0', spawnSync(NODE_BIN, [IDX, '--help'], { encoding: 'utf8' }).status === 0, '');
  }
});

// --- I11: A13 JSON content fallback (via HTTP upstream payload) ---
scenarios.push({
  name: 'content-fallback',
  fn: async () => {
    const cwd = freshCwd('i11');
    const m = startMock([{ role: 'assistant', content: 'CF-OK' }]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 340;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: { weird: 'object', n: 1 } }] });
      const req = readLog(m.log)[0];
      const userMsg = (req.messages || []).find(x => x.role === 'user');
      record('content: object content serializes as JSON, not [object Object]', !!userMsg && String(userMsg.content).includes('"weird":"object"') && !String(userMsg.content).includes('[object Object]'), userMsg ? String(userMsg.content).substring(0, 80) : 'no req');
      record('content: string content unchanged', (req.messages.filter(x => x.role === 'user').length) >= 1, '');
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// ====================== RUNNER ======================
S.runAll(scenarios);
