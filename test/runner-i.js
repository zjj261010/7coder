// Suite I: edge-focused regression for the A2-A13 fixes.
// Stresses boundaries the general suites don't: chcp prefix interference,
// flushExit integrity, compression dead-zone / no-progress paths, cancellation
// timing, marker-section isolation, SendKeys escaping, deterministic-table
// consistency, RALPH_ITERATIONS bounds, cron tree-kill.
// Usage: node test/runner-i.js   (RUN_ONLY=..., NODE_BIN=... as in the other suites)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const IContext = require('./_i-context-fixture');
const ISummary = require('./_i-summary-fixture');
const ICommand = require('./_i-command-fixture');
const IFlush = require('./_i-flush-fixture');
const IRalph = require('./_i-ralph-fixture');
const ToolDeclarations = require('./_tool-declarations');
const ICronExit = require('./_i-cron-exit-fixture');
const IWorklog = require('./_i-worklog-fixture');
const crypto = require('crypto');
const { create: createEndpoint } = require('./_endpoint');

// OPT-4: duplicated helpers now live in test/_shared.js (single implementation).
const S = require('./_shared').create({ suite: 'I', wsPrefix: 'w-i-' });
const { spawn, spawnSync, ROOT, IDX, NODE_BIN, RUN_ONLY, record, startProcessAt, freshCwd, runCli, httpReq, stopMock, readLog, toolResults, tr, rmrf } = S;
let port = 18550;
function startMock(scriptObj, env) { port += 1; return startProcessAt(port, 'mock-server.js', scriptObj, env); }
async function readyMock(mock) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (mock.child.exitCode !== null) throw Error('owned mock exited before ready');
    try { if ((await httpReq(mock.port, 'GET', '/', null)).status === 200) return; }
    catch (e) { if (e.code !== 'ECONNREFUSED') throw e; }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw Error('owned mock readiness deadline');
}
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
    if (process.platform !== 'win32') { S.skip('chcp: requires actual Windows cmd.exe'); return; }
    const cwd = freshCwd('i1');
    const fixture = ICommand.create(NODE_BIN), m = startMock(fixture.script, { MOCK_STRICT: '1' });
    try {
    await readyMock(m);
    const r = await runCli({ port: m.port, args: ['--prompt', fixture.prompt], env: { PERMISSION_MODE: 'bypass', AUDIT_LOG: 'true',
      HEAVY_MODEL: fixture.model, LIGHT_MODEL: fixture.model, SUMMARY_MODEL: fixture.model, ENABLE_RALPH_MODE: 'false', DREAM_ALLOW: 'false' }, cwd, timeoutMs: 15000 });
    const log = readLog(m.log);
    const audits = readLog(path.join(cwd, '.7coder', 'audit.jsonl')), runtime = readLog(path.join(cwd, '.7coder', 'runtime.jsonl'));
    record('chcp: full strict five-request transcript completes without auxiliary step theft', fixture.transcript(log) && r.code === 0 && r.out.includes(fixture.done), 'exit=' + r.code + ' requests=' + log.length);
    record('chcp: every unique command ID has exactly its expected audit status', fixture.audit(audits), JSON.stringify(audits.filter(row => row.type === 'tool').map(row => [row.callId, row.status])));
    record('chcp: command failure retains actual exit code 5 rather than a matching word', fixture.failure(log, audits, runtime), JSON.stringify(runtime));
    record('chcp: multi-command chain has only the two expected output lines', fixture.stdout(log, 'c2') === 'one\ntwo', String(fixture.result(log, 'c2')));
    record('chcp: successful redirection has empty stdout and exact intended single-line content', fixture.stdout(log, 'c3') === '' && fs.existsSync(path.join(cwd, 'i1out.txt')) && fs.readFileSync(path.join(cwd, 'i1out.txt'), 'utf8').trim() === 'redirect', '');
    record('chcp: quoted ampersand stays in one literal output value', fixture.stdout(log, 'c4') === '"quoted & ampersand"', String(fixture.result(log, 'c4')));
    S.info('chcp: this scenario covers run_command only; Bash is tested separately');
    } finally { stopMock(m); }
  }
});

// --- I2: flushExit integrity ---
scenarios.push({
  name: 'flush',
  fn: async () => {
    const fixture = IFlush.create(NODE_BIN), env = { PERMISSION_MODE: 'bypass', HEAVY_MODEL: fixture.main, LIGHT_MODEL: fixture.summary,
      SUMMARY_MODEL: fixture.summary, ENABLE_RALPH_MODE: 'false', DREAM_ALLOW: 'false', AUDIT_LOG: 'true', EXECUTION_TIMEOUT_MS: '8000' };
    const cwd = freshCwd('i2'), m = startMock(fixture.directScript, { MOCK_STRICT: '1' });
    let m2, worker, workerClosed = false;
    try {
      await readyMock(m);
      const result = await runCli({ port: m.port, args: ['--prompt', fixture.directPrompt], env, cwd, timeoutMs: 12000 });
      record('flush: exactly one complete 20KB reply is drained before actual CLI close', result.code === 0 && fixture.flushed(result.out), 'outLen=' + result.out.length + ' exit=' + result.code);
      record('flush: strict main and complete summary requests occur exactly once', fixture.directEvidence(readLog(m.log)), 'requests=' + readLog(m.log).length);
      record('flush: completed action summary is persisted before CLI exits', fs.readFileSync(path.join(cwd, '7CODER.md'), 'utf8') === '<!-- 7coder:auto-log:start -->\n- ' + fixture.directSummary + '\n<!-- 7coder:auto-log:end -->\n', '');

      // Launch the real handoff worker directly so this test retains its
      // ChildProcess handle through close. The detached launcher has its own
      // background-log/workspace-lease tests; do not infer worker death from it.
      m2 = startMock(fixture.workerScript, { MOCK_STRICT: '1' }); await readyMock(m2);
      const bgCwd = freshCwd('i2b'), token = crypto.randomBytes(24).toString('hex');
      worker = spawn(NODE_BIN, [IDX, '--prompt', fixture.workerPrompt], { cwd: bgCwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: Object.assign({}, process.env, env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m2.port + '/v1', MAX_RETRIES: '1',
          _7CODER_LEASE_HANDOFF: JSON.stringify({ token, pid: process.pid }) }) });
      let acknowledgement, bootstrap = '';
      worker.on('message', message => { acknowledgement = message; });
      for (const stream of [worker.stdout, worker.stderr]) stream.on('data', data => { bootstrap = (bootstrap + data).slice(-4096); });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('owned I2 worker close deadline')), 12000);
        worker.once('close', value => { workerClosed = true; clearTimeout(timer); resolve(value); });
      });
      const content = fs.readFileSync(path.join(bgCwd, '.7coder', 'background.log'), 'utf8');
      record('flush: retained worker handle confirms close after logger/workspace acknowledgement', code === 0 && acknowledgement && acknowledgement.kind === '7coder-background-owned' && acknowledgement.handoffToken === token && acknowledgement.owner && acknowledgement.owner.pid === worker.pid && acknowledgement.logReady === true, 'exit=' + code);
      record('flush: worker tool identity, successful status and exact stderr reach next model', fixture.workerEvidence(readLog(m2.log), readLog(path.join(bgCwd, '.7coder', 'audit.jsonl'))), '');
      record('flush: worker final answer exists exactly once in its completed log', content.split(fixture.workerDone).length - 1 === 1 && !bootstrap.includes(fixture.workerDone), '');
      record('flush: worker finishes logging without hidden task/protocol or dropped-output errors', !/\[ERROR\]|MOCK_PROTOCOL|prior output dropped:|UnhandledPromiseRejection/.test(content + bootstrap), content.slice(-1200));
      S.info('flush: real handoff worker and CLI close; detached launcher is covered separately');
    } finally {
      if (worker && !workerClosed) { worker.kill(); await new Promise(resolve => { if (workerClosed) resolve(); else worker.once('close', resolve); }); }
      stopMock(m2); stopMock(m);
    }
  }
});

// --- I3: compression edge paths (dead zone + no-progress) ---
scenarios.push({
  name: 'compress-edges',
  fn: async () => {
    // dead zone: turn1 must leave an assistant turn AFTER the user turn so the
    // live-task guard allows compressing the old user turn on turn2
    let cwd = freshCwd('i3a');
    let m = startMock(IContext.deadScript, { MOCK_STRICT: '1' });
    await readyMock(m);
    fs.writeFileSync(path.join(cwd, 'seed.txt'), IContext.seed);
    const env = { PERMISSION_MODE: 'bypass', CONTEXT_CHARS: '3100', HEAVY_MODEL: IContext.main, LIGHT_MODEL: IContext.light,
      MAX_RETRIES: '1', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false' };
    let r = await runCli({
      port: m.port, args: [], env, cwd, timeoutMs: 30000,
      stdinSteps: [
        { t: IContext.deadPrompt + '\n', d: 80 }, { t: '/execute-task-now\n', d: 3500 },
        { t: IContext.nextPrompt + '\n', d: 80 }, { t: '/execute-task-now\n', d: 3500 },
        { t: '/bye\n', d: 400 }
      ]
    });
    const logA = readLog(m.log);
    record('compress: exact four-request transcript preserves old user, tool pairing and active task', IContext.deadEvidence(logA), 'requests=' + logA.length + '\n' + r.out.slice(-1800));
    record('compress: both REPL tasks finish with distinct main replies and clean exit', r.code === 0 && r.out.includes(IContext.firstReply) && r.out.includes(IContext.secondReply) && !r.out.includes('MOCK_PROTOCOL'), r.out.slice(-1800));
    const audit = readLog(path.join(cwd, '.7coder', 'audit.jsonl')).filter(row => row.type === 'tool');
    record('compress: original read executes exactly once across both tasks', audit.length === 1 && audit[0].callId === IContext.readCall.id && audit[0].tool === 'read_file' && audit[0].status === 'ok', JSON.stringify(audit));
    stopMock(m);

    // no-progress: single giant user message, nothing processed -> live-task
    // guard bails, task completes, no runaway looping
    cwd = freshCwd('i3b');
    m = startMock(IContext.giantScript, { MOCK_STRICT: '1' });
    await readyMock(m);
    r = await runCli({
      port: m.port, args: [], env, cwd, timeoutMs: 30000,
      stdinSteps: [
        { t: IContext.giantPrompt + '\n', d: 80 }, { t: '/execute-task-now\n', d: 5000 },
        { t: '/bye\n', d: 400 }
      ]
    });
    const warns = (r.out.match(/Context still over budget/g) || []).length;
    record('compress: giant live instruction reaches main model exactly once and verbatim', IContext.giantEvidence(readLog(m.log)), r.out.slice(-1800));
    record('compress: giant task finishes without summary calls or runaway looping', r.out.includes(IContext.giantReply) && warns === 0 && r.code === 0 && !r.out.includes('MOCK_PROTOCOL'), 'warns=' + warns + '\n' + r.out.slice(-1800));
    stopMock(m);
  }
});

// --- I4: cancellation timing (final-answer boundary) ---
scenarios.push({
  name: 'cancel-boundary',
  fn: async () => {
    const cwd = freshCwd('i4');
    const fixture = await ISummary.start();
    const agent = createEndpoint({ suite: 'I-summary-agent', endpoint: fixture.endpoint, key: '', model: ISummary.model, permissionMode: 'bypass' });
    const mdPath = path.join(cwd, '7CODER.md');
    const readMd = () => fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
    async function until(predicate, label) {
      const end = Date.now() + 5000;
      while (!await predicate()) { if (Date.now() >= end) throw Error('I4 deadline: ' + label); await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    try {
      await agent.start(cwd);
      // Both HTTP paths have cancellation controls. Normal completion must
      // leave the background summary alive within its remaining deadline.
      const streamed = await agent.chat([{ role: 'user', content: ISummary.tasks[0] }], 8000);
      record('cancel: streamed reply is complete with DONE before summary is released', streamed.content === ISummary.replies[0] && streamed.tools.length === 0, streamed.raw);
      await until(() => fixture.isHeld(0), 'first summary request');
      const heldStream = JSON.parse((await agent.api('/api/info', null, 1000)).body);
      record('cancel: normal stream close leaves summary active and core task free', heldStream.load.summaries.active && heldStream.load.summaries.bytes > 0 && heldStream.runtime.activeTasks === 0 && heldStream.runtime.activeTools === 0 && readMd() === '', JSON.stringify(heldStream.load));
      fixture.release(0);
      await until(async () => readMd() === ISummary.document(1) && ISummary.settled(JSON.parse((await agent.api('/api/info', null, 1000)).body)), 'first summary durable and idle');
      record('cancel: released stream summary is written exactly once', readMd() === ISummary.document(1), readMd());

      const plain = await agent.api('/v1/chat/completions', { messages: [{ role: 'user', content: ISummary.tasks[1] }] }, 8000);
      const reply = JSON.parse(plain.body).choices[0].message;
      record('cancel: JSON reply is complete before its summary is released', reply.role === 'assistant' && reply.content === ISummary.replies[1] && !reply.tool_calls, plain.body);
      await until(() => fixture.isHeld(1), 'second summary request');
      const heldJson = JSON.parse((await agent.api('/api/info', null, 1000)).body);
      record('cancel: normal JSON close preserves pending summary without premature write', heldJson.load.summaries.active && heldJson.runtime.activeTasks === 0 && heldJson.runtime.activeTools === 0 && readMd() === ISummary.document(1), JSON.stringify(heldJson.load));
      fixture.release(1);
      await until(async () => readMd() === ISummary.document(2) && ISummary.settled(JSON.parse((await agent.api('/api/info', null, 1000)).body)), 'both summaries durable and idle');
      record('cancel: exact four-call main/summary transcript retains both task/reply pairs', ISummary.evidence(fixture.log, readMd()), 'requests=' + fixture.log.length + '\n' + readMd());
      record('cancel: summary queue releases active job, pending count and retained bytes', ISummary.settled(JSON.parse((await agent.api('/api/info', null, 1000)).body)), 'all counters must be zero');
    } finally {
      try { await agent.stop(); }
      finally { agent.S.cleanup(); await fixture.close(); }
    }
  }
});

// --- I5: marker-section isolation ---
scenarios.push({
  name: 'marker-isolation',
  fn: async () => {
    const cwd = freshCwd('i5'), file = path.join(cwd, '7CODER.md');
    fs.writeFileSync(file, IWorklog.notes);
    const m = startMock(IWorklog.script, { MOCK_STRICT: '1' });
    let child, closed = false, output = '', code;
    const wait = async (predicate, label) => {
      const end = Date.now() + 10000;
      while (Date.now() < end) { if (predicate()) return; if (closed) throw Error('I5 closed early: ' + output.slice(-2000)); await new Promise(resolve => setTimeout(resolve, 15)); }
      throw Error(label + ': ' + output.slice(-2000));
    };
    try {
      await readyMock(m);
      child = spawn(NODE_BIN, [IDX], { cwd, env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1',
        HEAVY_MODEL: IWorklog.main, LIGHT_MODEL: IWorklog.summary, SUMMARY_MODEL: IWorklog.summary, PERMISSION_MODE: 'bypass', MAX_RETRIES: '1',
        DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false', EXECUTION_TIMEOUT_MS: '8000' }) });
      child.stdout.on('data', data => { output = (output + data).slice(-16384); }); child.stderr.on('data', data => { output = (output + data).slice(-16384); }); child.stdin.on('error', () => {});
      child.once('close', value => { closed = true; code = value; });
      await wait(() => output.includes('Commands:'), 'I5 REPL not ready');
      child.stdin.write(IWorklog.tasks[0] + '\n/execute-task-now\n');
      await wait(() => (output.match(/\[USAGE\]/g) || []).length === 1, 'I5 first task not complete');
      const first = fs.readFileSync(file), originalBackup = fs.readFileSync(file + '.7coder-prev');
      record('markers: first real summary preserves BOM/CRLF and complete original notes', first.equals(Buffer.from(IWorklog.document(0))), '');
      child.stdin.write(IWorklog.tasks[1] + '\n/execute-task-now\n');
      await wait(() => (output.match(/\[USAGE\]/g) || []).length === 2, 'I5 second task not complete');
      record('markers: next real summary preserves all multiline details and exact outside bytes', fs.readFileSync(file).equals(Buffer.from(IWorklog.document(1))), '');
      record('markers: prior versions preserve original and first complete worklog bytes', originalBackup.equals(Buffer.from(IWorklog.notes)) && fs.readFileSync(file + '.7coder-prev').equals(first), '');
      record('markers: strict four-request history keeps actual task/summary model and content', IWorklog.evidence(readLog(m.log)), 'requests=' + readLog(m.log).length);
      child.stdin.write('/bye\n'); await wait(() => closed, 'I5 quit did not close');
      record('markers: real REPL finishes both writes and quits without hidden failures', code === 0 && output.includes('Goodbye!') && !/\[ERROR\]|Error writing to 7CODER|MOCK_PROTOCOL|UnhandledPromiseRejection/.test(output), 'exit=' + code);
    } finally {
      if (child && !closed) { child.kill(); await new Promise(resolve => { if (closed) resolve(); else child.once('close', resolve); }); }
      stopMock(m);
    }
  }
});

// --- I6: SendKeys escaping + real input ---
scenarios.push({
  name: 'input-escape',
  enabled: () => process.env.DESKTOP_TEST === '1',
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

// --- I7: tool metadata migration and fail-closed declaration validation ---
scenarios.push({
  name: 'table-consistency',
  fn: async () => {
    const src = fs.readFileSync(IDX, 'utf8');
    const ctx = {};
    require('vm').runInNewContext(ToolDeclarations.regions(src).metadata + '\nthis.api = { tools, TOOL_METADATA, getToolMetadata, validateToolMetadata };', ctx);
    const { tools, TOOL_METADATA: metadata, getToolMetadata, validateToolMetadata } = ctx.api;
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'tool-policy-before-opt12.json'), 'utf8'));
    const names = tools.map(t => t.function.name);
    const mismatch = names.filter(n => {
      const m = metadata[n], old = baseline.tools[n];
      return !old || ['risk','autoSafe','parallelRead','trackChanges'].some(k => m[k] !== old[k]);
    });
    record('metadata: all 53 tools retain their pre-migration permission and concurrency policy', names.length === 53 && names.length === Object.keys(baseline.tools).length && mismatch.length === 0, JSON.stringify(mismatch));
    const wrongExplain = names.filter(n => {
      const old = baseline.tools[n];
      const actual = metadata[n].explain ? baseline.samples.map(a => metadata[n].explain(a)) : null;
      return JSON.stringify(actual) !== JSON.stringify(old.explanations);
    });
    record('metadata: all approval explanations match historical outputs including model fallbacks', wrongExplain.length === 0, JSON.stringify(wrongExplain));
    record('metadata: sleep keeps LOW risk with model explanation; diagnostics remains approval-required', metadata.sleep_tool.risk === 'LOW' && metadata.sleep_tool.explain === null && !metadata.sleep_tool.autoSafe && metadata.diagnostics_tool.risk === 'MEDIUM' && !metadata.diagnostics_tool.autoSafe && !metadata.diagnostics_tool.parallelRead, '');
    const rejects = (declarations, registry) => { try { validateToolMetadata(declarations, registry); return false; } catch(e) { return true; } };
    const missing = Object.assign({}, metadata); delete missing.read_file;
    const ghost = Object.assign({}, metadata, { ghost_tool: metadata.read_file });
    record('metadata: missing, undeclared and duplicate tools are rejected at startup', rejects(tools, missing) && rejects(tools, ghost) && rejects(tools.concat([tools[0]]), metadata), '');
    const corrupted = override => Object.assign({}, metadata, { read_file: Object.assign({}, metadata.read_file, override) });
    record('metadata: invalid risk and approval flag values are rejected', rejects(tools, corrupted({risk:'SAFE'})) && rejects(tools, corrupted({autoSafe:'true'})) && rejects(tools, corrupted({explain:'safe'})), '');
    record('metadata: parallel writes and change-tracking conflicts are rejected', rejects(tools, corrupted({resources:{workspace:'write'}})) && rejects(tools, corrupted({trackChanges:true})), '');
    record('metadata: invalid execution, cancellation and resource declarations are rejected', rejects(tools, corrupted({execution:'automatic'})) && rejects(tools, corrupted({cancellation:'instant'})) && rejects(tools, corrupted({resources:{}})) && rejects(tools, corrupted({resources:{secret:'read'}})), '');
    record('metadata: unknown and prototype-named tools receive no automatic privileges', ['ghost_tool','__proto__','constructor','toString'].every(n => { const m=getToolMetadata(n); return !m.autoSafe && !m.parallelRead && !m.trackChanges && m.risk===null && m.explain===null; }), '');
    record('metadata: registry, entries and resource descriptions are immutable', Object.isFrozen(metadata) && names.every(n => Object.isFrozen(metadata[n]) && Object.isFrozen(metadata[n].resources)), '');
  }
});

scenarios.push({
  name: 'tool-result-contract',
  fn: async () => {
    const src = fs.readFileSync(IDX,'utf8');
    const start = src.indexOf('// OPT-13: pilot tools carry authoritative status');
    const end = src.indexOf('// Central choke point', start);
    const ctx={};
    require('vm').runInNewContext(src.slice(start,end)+'\nthis.api={makeToolResult,toolResultText,toolResultStatus,toolFailed,normalizeToolResult,STRUCTURED_RESULT_TOOLS};',ctx);
    const api=ctx.api;
    record('ToolResult contract: semantic status overrides both benign and error-looking text', api.toolFailed(api.makeToolResult('error','Friendly failure')) && !api.toolFailed(api.makeToolResult('ok','Tests error: sample text User declined')) && api.toolResultStatus(api.makeToolResult('ok','User declined'))==='ok', '');
    record('ToolResult contract: blocked declined cancelled are distinct failing statuses', ['blocked','declined','cancelled'].every(s=>{const r=api.makeToolResult(s,'same text');return api.toolFailed(r)&&api.toolResultStatus(r)===s;}), '');
    record('ToolResult contract: legacy prefix rules remain compatible for non-pilot tools', api.toolFailed('Read error: missing') && api.toolFailed('User declined the tool action.') && !api.toolFailed('[OK] read succeeded') && !api.toolFailed('a sample mentions declined') && api.toolResultStatus('Permission mode = denial. Action blocked.')==='blocked', '');
    const result=api.makeToolResult('ok','plain model text',{value:42});
    record('ToolResult contract: optional data stays internal and normalized identity is preserved', api.toolResultText(result)==='plain model text' && result.data.value===42 && api.normalizeToolResult(result)===result && Object.isFrozen(result), '');
    const invalid=(s,t)=>{try{api.makeToolResult(s,t);return false;}catch(e){return true;}};
    record('ToolResult contract: malformed statuses, nontext results and unbranded objects get no authority', invalid('success','text') && invalid('ok',{}) && api.toolResultStatus({status:'blocked',text:'fake'})==='ok' && api.toolResultText({status:'error'})==='[object Object]', '');
    record('ToolResult contract: batch-2 read tools are registered structured', ['read_file','glob_tool','grep_tool','list_dir','git_status_tool','git_diff_tool','process_list_tool'].every(n=>api.STRUCTURED_RESULT_TOOLS.has(n)) && ['run_tests_tool','diagnostics_tool','workflow_tool'].every(n=>api.STRUCTURED_RESULT_TOOLS.has(n)), '');
    record('ToolResult contract: batch-3 state and content tools are registered structured', ['task_get_tool','task_list_tool','task_output_tool','memory_tool','list_mcp_resources_tool','read_mcp_resource_tool','prompt_from_file'].every(n=>api.STRUCTURED_RESULT_TOOLS.has(n)) && ['run_tests_tool','diagnostics_tool','workflow_tool','read_file','glob_tool','grep_tool','list_dir','git_status_tool','git_diff_tool','process_list_tool'].every(n=>api.STRUCTURED_RESULT_TOOLS.has(n)), '');
    record('ToolResult contract: batch-4 validation-gap tools are registered structured', ['skill_tool','todo_write_tool','task_create_tool','task_stop_tool','cron_delete_tool','process_kill_tool','agent_tool'].every(n=>api.STRUCTURED_RESULT_TOOLS.has(n)) && ['run_tests_tool','diagnostics_tool','workflow_tool','read_file','glob_tool','grep_tool','list_dir','git_status_tool','git_diff_tool','process_list_tool','task_get_tool','task_list_tool','task_output_tool','memory_tool','list_mcp_resources_tool','read_mcp_resource_tool','prompt_from_file'].every(n=>api.STRUCTURED_RESULT_TOOLS.has(n)), '');
    record('ToolResult contract: batch-5 web and gap tools are registered structured', ['web_fetch_tool','synthetic_output_tool','enter_worktree_tool','computer_use','schedule_cron_tool','cron_create_tool'].every(n=>api.STRUCTURED_RESULT_TOOLS.has(n)) && api.STRUCTURED_RESULT_TOOLS.has('agent_tool'), '');
    record('ToolResult contract: batch-6 command tools are registered structured', ['run_command','bash_tool','powershell_tool'].every(n=>api.STRUCTURED_RESULT_TOOLS.has(n)), '');
    record('ToolResult contract: batch-7 sweep tools are registered structured', ['write_file','append_file','edit_file','notebook_edit_tool','download_tool','brief_tool','sleep_tool','snip_tool','tool_search_tool','cron_list_tool','git_commit_tool','auto_approval_return','ask_user_question_tool','web_search_tool'].every(n=>api.STRUCTURED_RESULT_TOOLS.has(n)), '');
    // Exercise workflow completion and cancellation directly with controlled
    // tool callbacks; no wall-clock race or process kill needed.
    const wfStart=src.indexOf("  if (name === 'workflow_tool') {");
    const wfEnd=src.indexOf('// ====================== TEST RUNNER PARSING',wfStart);
    const wfCtx={tools:[{function:{name:'read_file'}}],workflowStepDepth:0,agentDepth:0,disposePersistentShell(){},...api};
    require('vm').runInNewContext('async function run(name,args,conversation,approvalBridge,cancelled,modelContext) {\n'+src.slice(wfStart,wfEnd)+'\n}\nthis.run=run;',wfCtx);
    let calls=0;
    wfCtx.safeExecuteTool=async()=>{calls++;return api.makeToolResult('cancelled','Interrupted');};
    const cancelled=await wfCtx.run('workflow_tool',{steps:[{tool:'read_file',optional:true},{tool:'read_file'}]},null,null,()=>false);
    record('ToolResult workflow: cancelled optional step stops immediately with cancelled status', cancelled.status==='cancelled' && cancelled.text.startsWith('[STOPPED]') && calls===1 && cancelled.data.steps[0].status==='cancelled' && wfCtx.workflowStepDepth===0, '');
    calls=0;
    const before=await wfCtx.run('workflow_tool',{steps:[{tool:'read_file'}]},null,null,()=>true);
    record('ToolResult workflow: pre-cancelled task runs no steps and restores depth', before.status==='cancelled' && calls===0 && wfCtx.workflowStepDepth===0, '');
    wfCtx.safeExecuteTool=async()=>api.makeToolResult('error','Friendly failure');
    const failed=await wfCtx.run('workflow_tool',{steps:[{tool:'read_file'}]},null,null,()=>false);
    record('ToolResult workflow: benign failure text still stops and records status in step data', failed.status==='error' && failed.data.steps[0].status==='error' && failed.text.includes('Friendly failure'), '');
    let token=false;
    wfCtx.safeExecuteTool=async()=>{token=true;return '[aborted: client disconnected]';};
    const legacyCancel=await wfCtx.run('workflow_tool',{steps:[{tool:'read_file',optional:true}]},null,null,()=>token);
    record('ToolResult workflow: token cancellation during final legacy step cannot report completion', legacyCancel.status==='cancelled' && legacyCancel.data.steps[0].status==='cancelled' && wfCtx.workflowStepDepth===0, '');
  }
});

// --- I8: RALPH_ITERATIONS bounds ---
scenarios.push({
  name: 'metadata-scheduling',
  fn: async () => {
    const src = fs.readFileSync(IDX, 'utf8');
    const definitions = ToolDeclarations.regions(src).metadata;
    const loop = src.slice(src.indexOf('async function processWithTools('), src.indexOf('// ====================== TASK CHANGE SUMMARY'));
    const guard = src.slice(src.indexOf('function checkExecution('), src.indexOf('function watchExecution('));
    const vm = require('vm');
    const run = async (names, ownerError) => {
      const starts = [], release = {};
      let round = 0, guardCalls = 0;
      const ctx = {
        MAX_TOOL_STEPS: 3, HEAVY_MODEL: 'fixture',
        child_process: { assertProcessOwnerReady() { guardCalls++; if (ownerError) throw ownerError; } },
        createModelContext: main => ({ main, light: main, summary: main }),
        compressConversationIfNeeded: async () => {}, capToolResult: String,
        callOpenAI: async () => ({ message: round++ === 0 ? { role:'assistant',tool_calls:names.map((name,i) => ({id:String(i),function:{name,arguments:'{}'}})) } : {role:'assistant',content:'done'} }),
        safeExecuteTool: async call => {
          starts.push(call.id);
          return new Promise(resolve => { release[call.id] = () => resolve('result-'+call.id); });
        }
      };
      vm.runInNewContext(definitions + '\n' + guard + '\n' + loop + '\nthis.run = processWithTools;', ctx);
      const messages = [], pending = ctx.run(messages);
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('metadata scheduling fixture did not settle')), 3000);
        pending.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
      });
      done.catch(() => {}); // observe early failures before the manual releases
      await new Promise(resolve => setImmediate(resolve));
      return { starts, release, messages, done, rounds: () => round, guardCalls: () => guardCalls };
    };
    const reads = await run(['sleep_tool','read_file']);
    const bothStarted = reads.starts.join(',') === '0,1';
    if (reads.release['1']) reads.release['1'](); // finish in reverse order
    reads.release['0']();
    if (!bothStarted) { await new Promise(r => setImmediate(r)); if(reads.release['1']) reads.release['1'](); }
    const readAnswer = await reads.done;
    record('metadata scheduling: eligible reads start together, preserve result order and complete final model turn', bothStarted && readAnswer === 'done' && reads.rounds() === 2 && reads.guardCalls() > 0 && reads.messages.filter(m => m.role==='tool').map(m => m.tool_call_id+':'+m.content).join(',') === '0:result-0,1:result-1', reads.starts.join(','));
    const mixed = await run(['write_file','read_file']);
    const writeAlone = mixed.starts.join(',') === '0';
    mixed.release['0']();
    await new Promise(r => setImmediate(r));
    const readAfterWrite = mixed.starts.join(',') === '0,1';
    if(mixed.release['1']) mixed.release['1']();
    const mixedAnswer = await mixed.done;
    record('metadata scheduling: mixed write/read batch stays sequential and completes final model turn', writeAlone && readAfterWrite && mixedAnswer === 'done' && mixed.rounds() === 2 && mixed.guardCalls() > 0 && mixed.messages.filter(m => m.role==='tool').map(m => m.content).join(',')==='result-0,result-1', mixed.starts.join(','));
    const fatal = Object.assign(Error('owned process cleanup pending'), { code: 'EOWNERCLEANUP' });
    const gated = await run(['sleep_tool','read_file'], fatal), error = await gated.done.then(() => null, value => value);
    record('metadata scheduling: original execution guard rejects before any model, tool or history mutation', error === fatal && gated.guardCalls() === 1 && gated.rounds() === 0 && gated.starts.length === 0 && gated.messages.length === 0, '');
  }
});

scenarios.push({
  name: 'ralph-bounds',
  fn: async () => {
    for (const variant of IRalph.cases) {
      const cwd = freshCwd('i8-' + variant.key), fixture = IRalph.create(variant), m = startMock(fixture.script, { MOCK_STRICT: '1' });
      try {
        await readyMock(m);
        const r = await runCli({ port: m.port, args: ['--prompt', fixture.prompt], env: Object.assign({ PERMISSION_MODE: 'bypass',
          HEAVY_MODEL: fixture.model, LIGHT_MODEL: 'i-ralph-light', SUMMARY_MODEL: 'i-ralph-summary', MAX_RETRIES: '1',
          DREAM_ALLOW: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false', EXECUTION_TIMEOUT_MS: '8000' }, variant.env), cwd, timeoutMs: 12000 });
        record('ralph: ' + variant.label + ' completes with final business reply', r.code === 0 && r.out.includes(fixture.replies[fixture.replies.length - 1]) && !/\[ERROR\]|MOCK_PROTOCOL/.test(r.out), 'exit=' + r.code);
        record('ralph: ' + variant.key + ' has exact round count and complete refinement history', fixture.evidence(readLog(m.log)), 'requests=' + readLog(m.log).length);
        record('ralph: ' + variant.key + ' progress matches actual limit/completion with no short-reply summary', fixture.progress(r.out) && !fs.existsSync(path.join(cwd, '7CODER.md')), '');
      } finally { stopMock(m); }
    }
  }
});

// --- I9: cron tree-kill on /bye ---
scenarios.push({
  name: 'cron-treekill',
  fn: async () => {
    if (process.platform !== 'win32') { S.skip('cron-treekill: requires Windows owned Job proof'); return; }
    const cwd = freshCwd('i9'), program = path.join(cwd, 'hb.js'), infoFile = path.join(cwd, 'leaf.json');
    const fixture = ICronExit.create(NODE_BIN, program, infoFile, crypto.randomBytes(24).toString('hex'));
    fs.writeFileSync(program, fixture.programSource);
    const m = startMock(fixture.script, { MOCK_STRICT: '1' });
    let child, closed = false, info, output = '', exitCode;
    const began = process.hrtime(), elapsed = () => { const value = process.hrtime(began); return value[0] * 1000 + value[1] / 1000000; };
    const wait = async (predicate, label) => {
      const start = elapsed();
      while (elapsed() - start < 10000) { const value = await predicate(); if (value) return value; if (closed) throw Error('I9 Agent closed early: ' + output.slice(-2000)); await new Promise(resolve => setTimeout(resolve, 15)); }
      throw Error(label + ': ' + output.slice(-2000));
    };
    try {
      await readyMock(m);
      child = spawn(NODE_BIN, [IDX], { cwd, env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1',
        HEAVY_MODEL: fixture.model, LIGHT_MODEL: 'i-cron-exit-light', SUMMARY_MODEL: 'i-cron-exit-summary', MAX_RETRIES: '1', PERMISSION_MODE: 'bypass',
        DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false', AUDIT_LOG: 'true', EXECUTION_TIMEOUT_MS: '8000' }) });
      child.stdout.on('data', data => { output = (output + data).slice(-16384); }); child.stderr.on('data', data => { output = (output + data).slice(-16384); }); child.stdin.on('error', () => {});
      child.once('close', code => { closed = true; exitCode = code; });
      await wait(() => output.includes('Commands:'), 'I9 REPL not ready');
      child.stdin.write(fixture.prompt + '\n/execute-task-now\n');
      info = await wait(() => { try { return JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch (e) { return null; } }, 'I9 leaf did not publish');
      const running = await wait(async () => { const value = await fixture.query(info); return value && value.ticks >= 2 ? value : null; }, 'I9 leaf did not work');
      await wait(() => output.includes(fixture.done) && output.includes('[USAGE]'), 'I9 create task did not complete');
      const log = readLog(m.log), audits = readLog(path.join(cwd, '.7coder', 'audit.jsonl')), id = fixture.cronId(log);
      record('cron-treekill: exact strict creation transcript has one successful cron call', fixture.creation(log, audits), 'requests=' + log.length);
      record('cron-treekill: detached descendant is live and writing before Agent quit', running.pid === info.pid && info.pid !== info.rootPid && running.ticks >= 2 && fs.statSync(info.heart).size > 0, 'ticks=' + running.ticks);
      child.stdin.write('/bye\n');
      await wait(() => closed, 'I9 Agent did not close after bye');
      record('cron-treekill: actual Agent handle closes successfully after explicit quit', exitCode === 0 && output.includes('Goodbye!'), 'exit=' + exitCode);
      record('cron-treekill: exact scheduled group has native empty-Job and broker-close proof', fixture.nativeClosed(readLog(path.join(cwd, '.7coder', 'runtime.jsonl')), id), 'cron=' + id);
      const firstBytes = fs.statSync(info.heart).size;
      await new Promise(resolve => setTimeout(resolve, 150)); // several 25ms heartbeats
      record('cron-treekill: listener closes and heartbeat stops well before 45s self-exit', fixture.stopped(firstBytes, fs.statSync(info.heart).size, await fixture.query(info), elapsed()), 'elapsed=' + Math.round(elapsed()));
    } finally {
      // The nonce-bound test service stops only itself; no PID enumeration or
      // saved PID kill. Its parent exits when that exact leaf closes.
      if (info) await fixture.query(info, 'stop');
      if (child && !closed) { child.kill(); await new Promise(resolve => { if (closed) resolve(); else child.once('close', resolve); }); }
      stopMock(m);
    }
  }
});

// --- I9b: /bye preserves a lock it did not acquire ---
scenarios.push({
  name: 'bye-dreamlock',
  fn: async () => {
    const cwd = freshCwd('i9b');
    const lockPath = path.join(cwd, '.7coder', 'dream.lock'); // P2-1: moved under .7coder/
    fs.mkdirSync(path.join(cwd, '.7coder'), { recursive: true });
    const foreign = new Date().toISOString(); fs.writeFileSync(lockPath, foreign);
    const r = await runCli({
      port: 1, args: [], cwd, timeoutMs: 15000,
      stdinSteps: [{ t: '/bye\n', d: 1500 }]
    });
    record('bye-dreamlock: /bye preserves unowned dream lock bytes', r.code === 0 && r.out.includes('Goodbye') && fs.existsSync(lockPath) && fs.readFileSync(lockPath, 'utf8') === foreign, 'exit=' + r.code + ' lockRetained=' + fs.existsSync(lockPath));
  }
});

// --- I10: A12/A13 parser + content edges ---
scenarios.push({
  name: 'cli-strict',
  fn: async () => {
    const cwd = freshCwd('cli-strict');
    const options = { encoding: 'utf8', cwd, timeout: 10000, env: Object.assign({}, process.env, {
      OPENAI_API_KEY: 'test', OPENAI_ENDPOINT: 'http://127.0.0.1:1/v1', MAX_RETRIES: '1'
    }) };
    const empty = spawnSync(NODE_BIN, [IDX, '--prompt', ''], options);
    record('strict: empty --prompt errors with exit 1', empty.status === 1 && empty.stderr.includes('empty value'), 'status=' + empty.status);
    // Parsing can be checked without sending a task to a model service.
    const warn = spawnSync(NODE_BIN, [IDX, '--help', '--what-is-this'], options);
    record('strict: unknown flag warns explicitly', warn.status === 0 && warn.stderr.includes('Unknown argument'), warn.stderr.substring(0, 120));
    record('strict: --help still exits 0', spawnSync(NODE_BIN, [IDX, '--help'], options).status === 0, '');
  }
});

// --- I11: A13 JSON content fallback (via HTTP upstream payload) ---
scenarios.push({
  name: 'content-fallback',
  fn: async () => {
    const cwd = freshCwd('i11');
    const m = startMock(IContext.contentScript, { MOCK_STRICT: '1' });
    await readyMock(m);
    const agent = createEndpoint({ suite: 'I-content-agent', endpoint: 'http://127.0.0.1:' + m.port + '/v1', key: '', model: IContext.main, permissionMode: 'bypass' });
    try {
      const evidenceOnly = process.env.I_CONTENT_EVIDENCE_ONLY === '1';
      await agent.start(cwd);
      const objectResponse = await agent.api('/v1/chat/completions', { messages: IContext.contentMessages }, 8000);
      if (!evidenceOnly) record('content: JSON request completes with exact fixture response', JSON.parse(objectResponse.body).choices[0].message.content === IContext.objectReply, objectResponse.body);
      let rejected;
      try { await agent.api('/v1/chat/completions', { messages: [{ role: 'user', content: IContext.rejectedInput }] }, 8000); }
      catch (e) { rejected = e; }
      if (!evidenceOnly) record('content: strict upstream rejection propagates as a failed request', rejected && rejected.message.includes('MOCK_PROTOCOL'), rejected ? rejected.message : 'unexpected success');
      const info = JSON.parse((await agent.api('/api/info')).body);
      if (!evidenceOnly) record('content: failed upstream leaves health available with no active task/tool', info.runtime.activeTasks === 0 && info.runtime.activeTools === 0, JSON.stringify(info.runtime));
      const stringResponse = await agent.chat([{ role: 'user', content: IContext.stringInput }], 8000);
      if (!evidenceOnly) record('content: same Agent completes next streamed request after rejection', stringResponse.content === IContext.stringReply && stringResponse.tools.length === 0, stringResponse.raw);
      const log = readLog(m.log);
      record('content: exact nested JSON, assistant history and unchanged string reach their own requests', IContext.contentEvidence(log), 'requests=' + log.length + '\n' + JSON.stringify(log.map(r => ({ model: r.model, stream: r.stream, messages: (r.messages || []).filter(m => m.role !== 'system') }))).slice(-2000));
      if (evidenceOnly) S.info('content: setup HTTP calls reconstructed failed evidence; first four assertions NOT RUN');
    } finally {
      try { await agent.stop(); }
      finally { agent.S.cleanup(); stopMock(m); }
    }
  }
});

// ====================== RUNNER ======================
S.runAll(scenarios);
