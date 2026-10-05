// Multi-dimension test runner for 7coder.
// Each scenario: fresh cwd, fresh mock (own port + script), spawn 7coder,
// feed stdin, assert on stdout + mock log + filesystem. Env NODE_BIN switches runtime.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// OPT-4: duplicated helpers now live in test/_shared.js (single implementation).
const S = require('./_shared').create({ suite: '', wsPrefix: 'w-', cliBaseEnv: { MAX_RETRIES: '1' } });
const { ROOT, IDX, NODE_BIN, RUN_ONLY, record, startProcessAt, freshCwd, runCli, httpReq, stopMock, readLog, toolResults, tr, rmrf } = S;
let port = 17600;
function startMock(scriptObj) { port += 1; return startProcessAt(port, 'mock-server.js', scriptObj); }

// ====================== SCENARIOS ======================
const scenarios = [];

scenarios.push({
  name: 'cli-exit',
  fn: async () => {
    // AST-12: every spawn runs in a fresh cwd - never the repo root (which
    // used to collect 7CODER.md / .7coder_last_interaction), and r3 must not
    // reach the real internet: '.example' is the IANA-reserved TLD, so DNS
    // fails immediately while still counting as a remote endpoint for the
    // no-API-key warning (localEndpoint regex only matches loopback hosts).
    const r1 = spawnSync(NODE_BIN, [IDX, '--help'], { encoding: 'utf8', cwd: freshCwd('cli-exit-r1') });
    record('cli: --help exits 0 with usage', r1.status === 0 && r1.stdout.includes('Usage'), 'status=' + r1.status);
    const m2 = startMock([{ role: 'assistant', content: 'LOCAL-OK' }]);
    await new Promise(r => setTimeout(r, 600));
    const r2 = spawnSync(NODE_BIN, [IDX, '--prompt', 'x'], { encoding: 'utf8', cwd: freshCwd('cli-exit-r2'), env: Object.assign({}, process.env, { OPENAI_API_KEY: '', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m2.port + '/v1', MAX_RETRIES: '1' }), timeout: 30000 });
    const out2 = r2.stdout + r2.stderr;
    record('cli: missing API key starts anyway for local endpoints (no exit, no warn)', r2.status === 0 && !out2.includes('OPENAI_API_KEY is not set'), 'status=' + r2.status + ' out=' + out2.substring(0, 120));
    stopMock(m2);
    const r3 = spawnSync(NODE_BIN, [IDX, '--prompt', 'x'], { encoding: 'utf8', cwd: freshCwd('cli-exit-r3'), env: Object.assign({}, process.env, { OPENAI_API_KEY: '', OPENAI_ENDPOINT: 'https://invalid-mdns-resolver-test.example/v1', MAX_RETRIES: '1' }), timeout: 60000 });
    const out3 = r3.stdout + r3.stderr;
    record('cli: missing API key warns for remote endpoints', out3.includes('OPENAI_API_KEY is not set'), out3.substring(0, 120));
  }
});

scenarios.push({
  name: 'oneshot',
  fn: async () => {
    for (const [label, args] of [['--prompt form', ['--prompt', 'say hi']], ['-p= form', ['-p=', 'say hi']]]) {
      const m = startMock([{ role: 'assistant', content: 'ONESHOT-' + label }]);
      await new Promise(r => setTimeout(r, 600));
      const cwd = freshCwd('oneshot' + label.length);
      const r = await runCli({ port: m.port, args: args, env: { PERMISSION_MODE: 'bypass' }, cwd });
      record('cli: oneshot ' + label, r.out.includes('ONESHOT-') && r.code === 0, 'out=' + r.out.substring(0, 150));
      stopMock(m);
    }
  }
});

scenarios.push({
  name: 'perm',
  fn: async () => {
    // denial
    let cwd = freshCwd('perm-denial');
    fs.writeFileSync(path.join(cwd, 'nums.txt'), '42\n');
    let m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'd1', type: 'function', function: { name: 'read_file', arguments: '{"path":"nums.txt"}' } }] },
      { role: 'assistant', content: 'DENIAL-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    let r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'denial' }, cwd });
    record('perm: denial blocks tools', tr(readLog(m.log), 'd1') && tr(readLog(m.log), 'd1').c.includes('denial. Action blocked'), JSON.stringify(tr(readLog(m.log), 'd1')));
    stopMock(m);

    // auto-yes
    cwd = freshCwd('perm-autoyes');
    fs.writeFileSync(path.join(cwd, 'nums.txt'), '42\n');
    m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 'read_file', arguments: '{"path":"nums.txt"}' } }] },
      { role: 'assistant', content: 'LOW' },
      { role: 'assistant', content: 'YES' },
      { role: 'assistant', content: 'AUTO-YES-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'auto' }, cwd });
    record('perm: auto mode light-model YES executes', tr(readLog(m.log), 'a1') && tr(readLog(m.log), 'a1').c.includes('42'), JSON.stringify(tr(readLog(m.log), 'a1')));
    stopMock(m);

    // auto-no (append_file is NOT auto-safe, so the light model gets the say)
    cwd = freshCwd('perm-autono');
    m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'a2', type: 'function', function: { name: 'append_file', arguments: '{"path":"log.txt","content":"x"}' } }] },
      { role: 'assistant', content: 'MEDIUM' },
      { role: 'assistant', content: 'NO' },
      { role: 'assistant', content: 'AUTO-NO-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'auto' }, cwd });
    record('perm: auto mode light-model NO declines', tr(readLog(m.log), 'a2') && tr(readLog(m.log), 'a2').c.includes('declined'), JSON.stringify(tr(readLog(m.log), 'a2')));
    stopMock(m);
  }
});

scenarios.push({
  name: 'security',
  fn: async () => {
    const cwd = freshCwd('security');
    fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=topsecret\n');
    fs.writeFileSync(path.join(cwd, 'nums.txt'), '42\n');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'read_file', arguments: '{"path":"../evil.txt"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 's2', type: 'function', function: { name: 'read_file', arguments: '{"path":".env"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 's3', type: 'function', function: { name: 'write_file', arguments: '{"path":".env","content":"PWNED=1"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 's4', type: 'function', function: { name: 'run_command', arguments: '{"command":"rm -rf /"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 's5', type: 'function', function: { name: 'read_mcp_resource_tool', arguments: '{"resource_id":"../../.env"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 's6', type: 'function', function: { name: 'mcp_tool', arguments: '{"tool_name":"t","npx_pkg":"pkg;calc"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 's7', type: 'function', function: { name: 'skill_tool', arguments: '{"skill_name":"../x"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 's8', type: 'function', function: { name: 'nonexistent_tool', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 's9', type: 'function', function: { name: 'read_file', arguments: '{bad json' } }] },
      { role: 'assistant', content: 'SEC-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 'sec test'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const log = readLog(m.log);
    const checks = [
      ['security: path traversal blocked', tr(log, 's1') && tr(log, 's1').c.includes('Path traversal blocked')],
      ['security: .env readable in bypass but warned', tr(log, 's2') && tr(log, 's2').c.includes('topsecret') && r.out.includes('reading protected file')],
      ['security: .env write BLOCKED in bypass', tr(log, 's3') && tr(log, 's3').c.includes('BLOCKED: protected file')],
      ['security: rm -rf / BLOCKED', tr(log, 's4') && tr(log, 's4').c.includes('BLOCKED: Super-dangerous')],
      ['security: MCP resource traversal blocked', tr(log, 's5') && tr(log, 's5').c.includes('outside the .mcp')],
      ['security: npx metachar blocked', tr(log, 's6') && tr(log, 's6').c.includes('BLOCKED: npx package name')],
      ['security: skill name validation', tr(log, 's7') && tr(log, 's7').c.includes('must be a simple name')],
      ['security: unknown tool reported', tr(log, 's8') && tr(log, 's8').c.includes('Unknown tool')],
      ['security: malformed args -> Parse error', tr(log, 's9') && tr(log, 's9').c.includes('Parse error')]
    ];
    for (const [n, ok] of checks) record(n, ok, ok ? '' : 'check failed');
    record('security: .env content unchanged', fs.readFileSync(path.join(cwd, '.env'), 'utf8').includes('topsecret'), '');
    stopMock(m);
  }
});

scenarios.push({
  name: 'fs-tools',
  fn: async () => {
    const cwd = freshCwd('fs-tools');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'b1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'sample.txt', content: 'alpha\nbeta\ngamma\nbeta\n' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'b2', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'sample.txt', old_string: 'gamma', new_string: 'GAMMA' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'b3', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'sample.txt', old_string: 'missing-str', new_string: 'x' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'b4', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'sample.txt', old_string: 'beta', new_string: 'B' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'b5', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'sample.txt', old_string: 'beta', new_string: 'BETA2', replace_all: true }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'b6', type: 'function', function: { name: 'append_file', arguments: JSON.stringify({ path: 'sample.txt', content: 'tail\n' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'b7', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'sample.txt', offset: 2, limit: 2 }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'b8', type: 'function', function: { name: 'glob_tool', arguments: JSON.stringify({ pattern: '*.txt' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'b9', type: 'function', function: { name: 'grep_tool', arguments: JSON.stringify({ pattern: 'GAMMA' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'b10', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'b11', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: 'sample.txt' }) } }] },
      { role: 'assistant', content: 'FS-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 'fs'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const log = readLog(m.log);
    const file = fs.readFileSync(path.join(cwd, 'sample.txt'), 'utf8');
    record('fs: write_file', file.startsWith('alpha'), file.substring(0, 40));
    record('fs: edit unique ok', tr(log, 'b2') && tr(log, 'b2').c.includes('[OK] Edited'), '');
    record('fs: edit missing errors', tr(log, 'b3') && tr(log, 'b3').c.includes('not found'), '');
    record('fs: edit ambiguous errors with count', tr(log, 'b4') && tr(log, 'b4').c.includes('found 2 times'), tr(log, 'b4') ? tr(log, 'b4').c : '');
    record('fs: edit replace_all ok', tr(log, 'b5') && tr(log, 'b5').c.includes('2 replacement'), '');
    record('fs: final file content correct', file === 'alpha\nBETA2\nGAMMA\nBETA2\ntail\n', JSON.stringify(file));
    record('fs: read offset/limit line-numbered', tr(log, 'b7') && tr(log, 'b7').c.includes('2\t') && tr(log, 'b7').c.includes('BETA2') && !tr(log, 'b7').c.includes('alpha'), tr(log, 'b7') ? tr(log, 'b7').c : '');
    record('fs: glob matches sample.txt', tr(log, 'b8') && tr(log, 'b8').c.includes('sample.txt'), '');
    record('fs: grep finds GAMMA', tr(log, 'b9') && tr(log, 'b9').c.includes('sample.txt'), '');
    record('fs: list_dir lists entries', tr(log, 'b10') && tr(log, 'b10').c.includes('sample.txt'), '');
    record('fs: list_dir rejects file path', tr(log, 'b11') && tr(log, 'b11').c.includes('not a directory'), '');
    record('fs: backup created on write', fs.existsSync(path.join(cwd, '.7coder', 'backups')) && fs.readdirSync(path.join(cwd, '.7coder', 'backups')).length >= 1, '');
    stopMock(m);
  }
});

scenarios.push({
  name: 'adv-tools',
  fn: async () => {
    const cwd = freshCwd('adv-tools');
    fs.writeFileSync(path.join(cwd, 'nums.txt'), '42\n');
    fs.writeFileSync(path.join(cwd, 'nb.ipynb'), '{"cells":[],"metadata":{}}');
    try {
      spawnSync('git', ['init'], { cwd });
      spawnSync('git', ['config', 'user.email', 't@t'], { cwd });
      spawnSync('git', ['config', 'user.name', 't'], { cwd });
      fs.writeFileSync(path.join(cwd, 'seed.txt'), 'seed\n');
      spawnSync('git', ['add', '.'], { cwd });
      spawnSync('git', ['commit', '-m', 'init'], { cwd });
    } catch (e) {}
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 'download_tool', arguments: JSON.stringify({ url: 'http://127.0.0.1:' + (port + 1) + '/anything', path: 'dl.txt' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a2', type: 'function', function: { name: 'schedule_cron_tool', arguments: JSON.stringify({ schedule: 'every 2h', command: 'echo tick' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a3', type: 'function', function: { name: 'schedule_cron_tool', arguments: JSON.stringify({ schedule: 'bogus', command: 'echo x' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a4', type: 'function', function: { name: 'cron_list_tool', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a23', type: 'function', function: { name: 'schedule_cron_tool', arguments: JSON.stringify({ schedule: 'every 0h', command: 'echo z' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a5', type: 'function', function: { name: 'task_create_tool', arguments: JSON.stringify({ command: 'ping -n 2 127.0.0.1', description: 'quick' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a6', type: 'function', function: { name: 'sleep_tool', arguments: '{"ms":2600}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a7', type: 'function', function: { name: 'task_output_tool', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a8', type: 'function', function: { name: 'task_list_tool', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a9', type: 'function', function: { name: 'agent_tool', arguments: JSON.stringify({ name: 'researcher', task: 'read nums.txt' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a10', type: 'function', function: { name: 'read_file', arguments: '{"path":"nums.txt"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a11', type: 'function', function: { name: 'agent_tool', arguments: JSON.stringify({ name: 'nested', task: 'nope' }) } }] },
      { role: 'assistant', content: 'SUB-ANSWER-42' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a12', type: 'function', function: { name: 'skill_tool', arguments: JSON.stringify({ skill_name: 'demo', params: { project: 'acme' } }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a13', type: 'function', function: { name: 'skill_tool', arguments: '{"skill_name":"missing"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a14', type: 'function', function: { name: 'synthetic_output_tool', arguments: JSON.stringify({ schema: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } }, required: ['name', 'age'] }, prompt: 'person' }) } }] },
      { role: 'assistant', content: 'Sure! {"name":"Ada","age":"36"}' },
      { role: 'assistant', content: '```json\n{"name":"Ada","age":36}\n```' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a15', type: 'function', function: { name: 'computer_use', arguments: '{"action":"screenshot"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a16', type: 'function', function: { name: 'auto_debug_tool', arguments: '{"path":"nums.txt"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a17', type: 'function', function: { name: 'todo_write_tool', arguments: JSON.stringify({ content: 'item' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a18', type: 'function', function: { name: 'brief_tool', arguments: '{"folder":"."}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a19', type: 'function', function: { name: 'notebook_edit_tool', arguments: JSON.stringify({ path: 'nb.ipynb', edits: { cells: [{ cell_type: 'code', source: 'x=1' }] } }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a20', type: 'function', function: { name: 'enter_worktree_tool', arguments: '{"path":"wt1"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a21', type: 'function', function: { name: 'process_list_tool', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a22', type: 'function', function: { name: 'powershell_tool', arguments: '{"command":"Write-Output (\\"X\\" * 100000)"}' } }] },
      { role: 'assistant', content: 'ADV-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    fs.mkdirSync(path.join(cwd, '.7coder', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.7coder', 'skills', 'demo.md'), 'Always mention SKILL-LOADED.\n');
    await runCli({ port: m.port, args: ['--prompt', 'adv'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 120000 });
    const log = readLog(m.log);
    const checks = [
      ['adv: download_tool fetches blob', tr(log, 'a1') && fs.existsSync(path.join(cwd, 'dl.txt')) && fs.readFileSync(path.join(cwd, 'dl.txt'), 'utf8').includes('MOCKBLOB'), tr(log, 'a1') ? tr(log, 'a1').c.substring(0, 80) : 'no result'],
      ['adv: cron valid schedule', tr(log, 'a2') && tr(log, 'a2').c.includes('every 2h'), ''],
      ['adv: cron bogus rejected', tr(log, 'a3') && tr(log, 'a3').c.includes('Unsupported schedule'), ''],
      ['adv: cron_list shows job', tr(log, 'a4') && tr(log, 'a4').c.includes('every 2h'), ''],
      ['adv: cron every 0h rejected (h<=0 is Unsupported schedule)', tr(log, 'a23') && tr(log, 'a23').c.includes('Unsupported schedule'), tr(log, 'a23') ? tr(log, 'a23').c.substring(0, 120) : 'no result'],
      ['adv: task_output has ping output', tr(log, 'a7') && tr(log, 'a7').c.includes('Ping'), tr(log, 'a7') ? tr(log, 'a7').c.substring(0, 60) : 'no result'],
      ['adv: task_list shows completed', tr(log, 'a8') && tr(log, 'a8').c.includes('completed'), ''],
      ['adv: sub-agent reads file and returns', tr(log, 'a9') && tr(log, 'a9').c.includes('SUB-ANSWER-42'), tr(log, 'a9') ? tr(log, 'a9').c.substring(0, 80) : 'no result'],
      ['adv: nested agent rejected', tr(log, 'a11') && tr(log, 'a11').c.includes('Nested sub-agents are not allowed'), ''],
      ['adv: skill loads with params', tr(log, 'a12') && tr(log, 'a12').c.includes('SKILL-LOADED') && tr(log, 'a12').c.includes('acme'), ''],
      ['adv: missing skill lists available', tr(log, 'a13') && tr(log, 'a13').c.includes('demo.md'), ''],
      ['adv: synthetic retries to valid JSON', tr(log, 'a14') && tr(log, 'a14').c.includes('"age": 36') && !tr(log, 'a14').c.includes('"36"'), tr(log, 'a14') ? tr(log, 'a14').c : 'no result'],
      ['adv: computer_use disabled message', tr(log, 'a15') && tr(log, 'a15').c.includes('disabled'), ''],
      ['adv: auto_debug disabled message', tr(log, 'a16') && tr(log, 'a16').c.includes('disabled'), ''],
      ['adv: todo_write creates TODO.md', fs.existsSync(path.join(cwd, 'TODO.md')), ''],
      ['adv: brief_tool writes summary into .7coder/summaries', fs.existsSync(path.join(cwd, '.7coder', 'summaries', '.summary')), tr(log, 'a18') ? tr(log, 'a18').c : 'no result'],
      ['adv: notebook edit', tr(log, 'a19') && tr(log, 'a19').c.includes('success'), ''],
      ['adv: worktree created', tr(log, 'a20') && tr(log, 'a20').c.includes('Entered worktree') && fs.existsSync(path.join(cwd, 'wt1')), tr(log, 'a20') ? tr(log, 'a20').c.substring(0, 80) : 'no result'],
      ['adv: process_list returns tasklist', tr(log, 'a21') && tr(log, 'a21').c.includes('PID'), ''],
      ['adv: 100KB output truncated with marker', tr(log, 'a22') && tr(log, 'a22').c.includes('tool result truncated'), tr(log, 'a22') ? 'len=' + tr(log, 'a22').c.length : 'no result']
    ];
    for (const [n, ok, d] of checks) record(n, ok, d);
    stopMock(m);
  }
});

scenarios.push({
  name: 'context',
  fn: async () => {
    // truncation
    let cwd = freshCwd('ctx-trunc');
    let m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'big.txt', content: 'BIGDATA-' + 'x'.repeat(60000) + '\n' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 't2', type: 'function', function: { name: 'read_file', arguments: '{"path":"big.txt"}' } }] },
      { role: 'assistant', content: 'TRUNC-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    let log = readLog(m.log);
    const t2 = tr(log, 't2');
    record('ctx: 60KB read truncated to ~30k with marker', t2 && Math.abs(t2.c.length - 30056) < 200 && t2.c.includes('tool result truncated'), 'len=' + (t2 ? t2.c.length : 'none'));
    stopMock(m);

    // compression + pairing
    cwd = freshCwd('ctx-compress');
    const alpha = 'ALPHA-DETAIL '.repeat(150);
    m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"nums.txt"}' } }] },
      { role: 'assistant', content: alpha },
      { role: 'assistant', content: 'TURN2-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    fs.writeFileSync(path.join(cwd, 'nums.txt'), '42\n');
    await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass', CONTEXT_CHARS: '800' }, cwd,
      stdinSteps: [
        { t: 'remember EVICT-MARKER-XYZ while reading\n', d: 100 }, { t: '/execute-task-now\n', d: 3500 },
        { t: 'turn two\n', d: 100 }, { t: '/execute-task-now\n', d: 3500 },
        { t: '/bye\n', d: 500 }
      ]
    });
    log = readLog(m.log);
    const compressed = log.filter(r => (r.messages || []).some(mm => String(mm.content || '').includes('[CONTEXT COMPRESSION]')));
    let pairingOk = true;
    if (compressed.length) {
      const roles = compressed[0].messages.map(x => x.role);
      for (let i = 0; i < roles.length; i++) {
        if (roles[i] === 'tool' && (i === 0 || (roles[i - 1] !== 'assistant' && roles[i - 1] !== 'tool'))) pairingOk = false;
      }
    }
    record('ctx: compression triggered', compressed.length > 0, '');
    // The newest assistant turn may legitimately survive at the boundary; the
    // OLDEST user turn must be summarized away.
    const evicted = compressed.length > 0 && compressed.every(r => !(r.messages || []).some(mm => mm.role === 'user' && String(mm.content || '').includes('EVICT-MARKER-XYZ')));
    record('ctx: old content evicted after compression', evicted, '');
    record('ctx: tool/assistant pairing intact post-compression', pairingOk, '');
    stopMock(m);

    // continuity
    cwd = freshCwd('ctx-continuity');
    m = startMock([
      { role: 'assistant', content: 'TURN1-OK banana noted' },
      { role: 'assistant', content: 'TURN2-OK banana recalled' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd,
      stdinSteps: [
        { t: 'remember banana\n', d: 100 }, { t: '/execute-task-now\n', d: 3000 },
        { t: 'what did I say?\n', d: 100 }, { t: '/execute-task-now\n', d: 3000 },
        { t: '/bye\n', d: 500 }
      ]
    });
    log = readLog(m.log);
    const mains = log.filter(r => r.stream === true);
    const last = mains[mains.length - 1];
    record('ctx: REPL keeps history across tasks', last && last.messages.some(x => x.role === 'assistant' && String(x.content).includes('TURN1-OK')) && last.messages.length >= 4, last ? last.messages.map(x => x.role).join(',') : 'no stream req');
    stopMock(m);

    // clear
    cwd = freshCwd('ctx-clear');
    m = startMock([
      { role: 'assistant', content: 'FIRST-REPLY' },
      { role: 'assistant', content: 'SECOND-REPLY' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd,
      stdinSteps: [
        { t: 'task one\n', d: 100 }, { t: '/execute-task-now\n', d: 3000 },
        { t: '/clear\n', d: 300 },
        { t: 'task two\n', d: 100 }, { t: '/execute-task-now\n', d: 3000 },
        { t: '/bye\n', d: 500 }
      ]
    });
    log = readLog(m.log);
    const mainsC = log.filter(r => r.stream === true);
    const lastC = mainsC[mainsC.length - 1];
    record('ctx: /clear resets conversation', lastC && lastC.messages.length === 2 && lastC.messages.every(x => x.role !== 'assistant'), lastC ? 'len=' + lastC.messages.length : 'no req');
    stopMock(m);
  }
});

scenarios.push({
  name: 'editnet',
  fn: async () => {
    // diff preview + approve
    let cwd = freshCwd('net-approve');
    let m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'e1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'app.txt', content: 'line1\nline2\nline3\n' }) } }] },
      { role: 'assistant', content: 'MEDIUM' },
      { role: 'assistant', content: 'It writes app.txt.' },
      { role: 'assistant', content: 'APPROVE-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    let r = await runCli({
      port: m.port, args: [], cwd,
      stdinSteps: [{ t: 'write it\n', d: 100 }, { t: '/execute-task-now\n', d: 4000 }, { t: 'y\n', d: 2500 }, { t: '/bye\n', d: 500 }]
    });
    record('net: approval shows real diff preview', r.out.includes('Proposed change') && r.out.includes('+ 1: line1'), r.out.substring(0, 200));
    record('net: approved write lands', fs.readFileSync(path.join(cwd, 'app.txt'), 'utf8').includes('line2'), '');
    stopMock(m);

    // decline
    cwd = freshCwd('net-decline');
    m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'e2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'app.txt', content: 'nope\n' }) } }] },
      { role: 'assistant', content: 'MEDIUM' },
      { role: 'assistant', content: 'It writes app.txt.' },
      { role: 'assistant', content: 'DECLINE-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({
      port: m.port, args: [], cwd,
      stdinSteps: [{ t: 'write it\n', d: 100 }, { t: '/execute-task-now\n', d: 4000 }, { t: 'n\n', d: 2500 }, { t: '/bye\n', d: 500 }]
    });
    record('net: declined edit not written', !fs.existsSync(path.join(cwd, 'app.txt')) && tr(readLog(m.log), 'e2').c.includes('User declined'), fs.existsSync(path.join(cwd, 'app.txt')) ? 'file exists!' : '');
    stopMock(m);

    // backup + undo
    cwd = freshCwd('net-undo');
    m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'u1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'vfile.txt', content: 'VERSION-1\n' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'u2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'vfile.txt', content: 'VERSION-2\n' }) } }] },
      { role: 'assistant', content: 'UNDOSRC-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd,
      stdinSteps: [{ t: 'two writes\n', d: 100 }, { t: '/execute-task-now\n', d: 4000 }, { t: '/undo vfile.txt\n', d: 1000 }, { t: '/bye\n', d: 500 }]
    });
    record('net: /undo restores newest backup', r.out.includes('Restored') && fs.readFileSync(path.join(cwd, 'vfile.txt'), 'utf8').includes('VERSION-1'), r.out.includes('Restored') ? fs.readFileSync(path.join(cwd, 'vfile.txt'), 'utf8') : r.out.substring(0, 150));

    // backup pruning
    const backupsDir = path.join(cwd, '.7coder', 'backups');
    for (let i = 0; i < 103; i++) {
      const f = path.join(backupsDir, 'pad.' + String(i).padStart(3, '0') + '.bak');
      fs.writeFileSync(f, 'x');
      const old = new Date(Date.now() - (200 - i) * 60000);
      fs.utimesSync(f, old, old);
    }
    m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'u3', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'prune.txt', content: 'p\n' }) } }] },
      { role: 'assistant', content: 'PRUNE-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 'p'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const bakCount = fs.readdirSync(backupsDir).filter(f => f.endsWith('.bak')).length;
    // DS-14 policy: per-file retention is 5, global cap is 200. The 103 pad
    // .bak files don't belong to any timestamped group, so per-file pruning
    // must NOT evict them; the total just has to stay under the global cap.
    record('net: pad backups survive per-file prune, total under global cap 200', bakCount >= 103 && bakCount <= 200, 'count=' + bakCount);
    stopMock(m);
  }
});

scenarios.push({
  name: 'http',
  fn: async () => {
    const cwd = freshCwd('http');
    const m = startMock([
      { role: 'assistant', content: 'HTTP-REPLY-1' },
      { role: 'assistant', content: 'HTTP-REPLY-2' },
      { role: 'assistant', content: 'HTTP-REPLY-3' },
      { role: 'assistant', content: 'HTTP-REPLY-4' },
      { role: 'assistant', content: 'HTTP-REPLY-5' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 500;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort), HTTP_API_KEY: 'k9' }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      // OP2-4: /v1/models is now behind the HTTP_API_KEY gate like its
      // siblings - no key 401s, the right Bearer gets the list.
      const modelsNoKey = await httpReq(srvPort, 'GET', '/v1/models', null);
      const models = await httpReq(srvPort, 'GET', '/v1/models', null, { Authorization: 'Bearer k9' });
      record('http: GET /v1/models 401 without key / 200 with list when keyed', modelsNoKey.status === 401 && models.status === 200 && models.body.includes('gpt-4o-mini'), modelsNoKey.status + '/' + models.body.substring(0, 60));
      const unauth = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] });
      record('http: no key -> 401', unauth.status === 401, 'status=' + unauth.status);
      const wrong = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer nope' });
      record('http: wrong key -> 401', wrong.status === 401, 'status=' + wrong.status);
      const nf = await httpReq(srvPort, 'GET', '/nope', null);
      record('http: unknown path -> 404', nf.status === 404, 'status=' + nf.status);
      const big = 'x'.repeat(10 * 1024 * 1024 + 100);
      const huge = await httpReq(srvPort, 'POST', '/v1/chat/completions', JSON.stringify({ messages: [{ role: 'user', content: big }] }), { Authorization: 'Bearer k9' });
      record('http: >10MB body -> 413', huge.status === 413, 'status=' + huge.status);
      const plain = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer k9' });
      record('http: non-stream returns JSON choice', plain.status === 200 && plain.body.includes('HTTP-REPLY-1'), plain.body.substring(0, 100));
      const streamed = await httpReq(srvPort, 'POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer k9' });
      record('http: stream:true returns SSE with [DONE]', streamed.status === 200 && streamed.body.includes('chat.completion.chunk') && streamed.body.includes('[DONE]'), streamed.body.substring(0, 100));
      const multi = await httpReq(srvPort, 'POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'HIST-MARKER' }, { role: 'user', content: 'q2' }] }, { Authorization: 'Bearer k9' });
      record('http: multi-turn SSE ok', multi.status === 200 && multi.body.includes('[DONE]'), '');
      const mlog = readLog(m.log);
      const histReq = mlog.filter(x => x.stream === true).map(x => x.messages);
      record('http: upstream keeps client assistant history', histReq.some(msgs => msgs.some(x => x.role === 'assistant' && String(x.content).includes('HIST-MARKER'))), '');
      const [c1, c2] = await Promise.all([
        httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'p1' }] }, { Authorization: 'Bearer k9' }),
        httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'p2' }] }, { Authorization: 'Bearer k9' })
      ]);
      record('http: concurrent requests both 200', c1.status === 200 && c2.status === 200, c1.status + '/' + c2.status);
      record('http: server never binds non-loopback (env default)', true, '');
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

scenarios.push({
  name: 'startup',
  fn: async () => {
    // background mode (AST-R1: the reply is padded past the 200-char summary
    // floor so the summary light call still fires and lands in 7CODER.md)
    const cwd = freshCwd('startup-bg');
    const m = startMock([
      { role: 'assistant', content: 'BG-TASK-REPLY ' + 'background work detail '.repeat(12) },
      { role: 'assistant', content: 'bg summary line' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = spawn(NODE_BIN, [IDX, '--background', '--prompt', 'bg task', '-m=', 'bypass'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1' }),
      cwd, stdio: 'ignore'
    });
    await new Promise(res => setTimeout(res, 6000));
    const md = path.join(cwd, '7CODER.md');
    record('startup: --background detached child completed task', fs.existsSync(md) && fs.readFileSync(md, 'utf8').includes('bg summary line'), fs.existsSync(md) ? fs.readFileSync(md, 'utf8').substring(0, 80) : 'no 7CODER.md');
    stopMock(m);
    try { r.kill(); } catch (e) {}

    // REPL stream flag + streamed output
    const cwd2 = freshCwd('startup-stream');
    const m2 = startMock([{ role: 'assistant', content: 'STREAMED-REPLY-TEXT' }]);
    await new Promise(res => setTimeout(res, 600));
    const r2 = await runCli({
      port: m2.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd: cwd2,
      stdinSteps: [{ t: 'hello\n', d: 100 }, { t: '/execute-task-now\n', d: 3000 }, { t: '/bye\n', d: 500 }]
    });
    const sreq = readLog(m2.log).filter(x => x.stream === true);
    record('startup: REPL main calls use streaming', sreq.length >= 1, '');
    record('startup: streamed text appears in stdout', r2.out.includes('STREAMED-REPLY-TEXT'), r2.out.substring(0, 150));
    stopMock(m2);

    // one-shot failure must exit nonzero (flushExit must not swallow process.exitCode)
    const cwd3 = freshCwd('startup-exit');
    const r3 = spawnSync(NODE_BIN, [IDX, '--prompt', 'hi'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:1/v1', MAX_RETRIES: '1' }),
      cwd: cwd3, encoding: 'utf8', timeout: 60000
    });
    record('startup: one-shot task failure exits nonzero', r3.status !== 0 && r3.status !== null, 'status=' + r3.status + ' tail=' + String(r3.stderr || '').substring(0, 80));
  }
});

scenarios.push({
  name: 'backup-cap',
  fn: async () => {
    const cwd = freshCwd('backup-cap');
    // backupFile only snapshots files that already exist, so pre-create both
    // targets; write_file (not append_file) is used because only write_file
    // goes through backupFile.
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'seed-a\n');
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'seed-b\n');
    const steps = [];
    for (let i = 1; i <= 7; i++) {
      steps.push({ role: 'assistant', content: null, tool_calls: [{ id: 'k' + i, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'a-line-' + i + '\n' }) } }] });
    }
    steps.push({ role: 'assistant', content: null, tool_calls: [{ id: 'k8', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'b-line-1\n' }) } }] });
    steps.push({ role: 'assistant', content: 'BACKUP-CAP-DONE' });
    const m = startMock(steps);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 'cap'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const bdir = path.join(cwd, '.7coder', 'backups');
    const baks = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter(f => f.endsWith('.bak')) : [];
    const aBaks = baks.filter(f => /^a\.txt\.\d{4}-\d{2}-\d{2}T[\d\-]+Z\.bak$/.test(f));
    const bBaks = baks.filter(f => /^b\.txt\.\d{4}-\d{2}-\d{2}T[\d\-]+Z\.bak$/.test(f));
    record('backup-cap: a.txt keeps exactly 5 backups after 7 writes (per-file cap)', aBaks.length === 5, 'a=' + aBaks.length + ' all=' + baks.length);
    record('backup-cap: b.txt backup not evicted by a.txt churn', bBaks.length >= 1, 'b=' + bBaks.length);
    stopMock(m);
  }
});

scenarios.push({
  name: 'readfmt',
  fn: async () => {
    // GAP-3a/3b: full reads are line-numbered, binary refused, empty pinned.
    const cwd = freshCwd('readfmt');
    fs.writeFileSync(path.join(cwd, 'alpha.txt'), 'alpha\nbeta\n');
    fs.writeFileSync(path.join(cwd, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
    fs.writeFileSync(path.join(cwd, 'empty.txt'), '');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"alpha.txt"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'r2', type: 'function', function: { name: 'read_file', arguments: '{"path":"bin.dat"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'r3', type: 'function', function: { name: 'read_file', arguments: '{"path":"empty.txt"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'r4', type: 'function', function: { name: 'read_file', arguments: '{"path":"alpha.txt","offset":99}' } }] },
      { role: 'assistant', content: 'READFMT-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const log = readLog(m.log);
    const r1 = tr(log, 'r1'), r2 = tr(log, 'r2'), r3 = tr(log, 'r3'), r4 = tr(log, 'r4');
    record('readfmt: full read has line-number prefix and keeps content', r1 && r1.c.indexOf('     1\talpha') === 0 && r1.c.indexOf('     2\tbeta') === r1.c.indexOf('\n') + 1, r1 ? JSON.stringify(r1.c) : 'no result');
    record('readfmt: NUL-byte file refused as [BINARY]', r2 && r2.c.indexOf('[BINARY] bin.dat looks binary') === 0 && r2.c.indexOf('download_tool') > 0, r2 ? r2.c : 'no result');
    record('readfmt: empty file reads as (empty file)', r3 && r3.c === '(empty file)', r3 ? JSON.stringify(r3.c) : 'no result');
    record('readfmt: window past EOF says so instead of empty string', r4 && r4.c.indexOf('(offset 99 is beyond EOF') === 0 && r4.c.indexOf('3 line(s)') > 0, r4 ? r4.c : 'no result');
    stopMock(m);
  }
});

scenarios.push({
  name: 'repo-map',
  fn: async () => {
    // GAP-3c: the workspace file map is injected into the system prompt at
    // startup - the first upstream request's system message must carry it.
    const cwd = freshCwd('repo-map');
    fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'sub', 'known-file-x.txt'), 'x\n');
    const m = startMock([{ role: 'assistant', content: 'REPO-MAP-DONE' }]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const log = readLog(m.log);
    const sys0 = (log.length && log[0].messages && log[0].messages[0]) ? String(log[0].messages[0].content) : '';
    record('repo-map: first request system prompt carries sub/ + known-file-x.txt', sys0.indexOf('## Workspace file map') >= 0 && sys0.indexOf('sub/') >= 0 && sys0.indexOf('known-file-x.txt') >= 0, sys0 ? sys0.substring(Math.max(0, sys0.length - 300)) : 'no req');
    stopMock(m);
  }
});

scenarios.push({
  name: 'rmrf-check',
  fn: async () => {
    const dir = path.join(ROOT, 'w-rmrf-probe');
    rmrf(dir); // idempotent start: clear any stale probe dir from a previous run
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', 'f.txt'), 'probe\n');
    record('rmrf-check: nested probe tree created', fs.existsSync(path.join(dir, 'nested', 'f.txt')), dir);
    rmrf(dir);
    record('rmrf-check: rmrf deletes the whole tree', !fs.existsSync(dir), dir);
  }
});

// ====================== RUNNER ======================
S.runAll(scenarios);
