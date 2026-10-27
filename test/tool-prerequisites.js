const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const S = require('./_shared').create({ suite: 'tool-prerequisites' }), source = fs.readFileSync(S.IDX, 'utf8'), owned = [];
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
(async () => {
  try {
    const cwd = S.freshCwd('tools 中文 空格'); let failure, lastOptions;
    const c = vm.createContext({ process, launchDir: cwd, checkExecution() {}, child_process: { execFileSync(file, args, options) { lastOptions = options; throw failure; } } });
    vm.runInContext(cut('// OPT-13: pilot tools carry authoritative status', '// Central choke point') +
      cut('function git(argsArr, opts)', "  if (name === 'git_status_tool') {") +
      'async function tool(name,args={},cancelled=null) {\n' + cut("  if (name === 'git_status_tool') {", "  if (name === 'synthetic_output_tool') {") + '\n}', c);
    c.gitRead=async (args,options)=>c.git(args,options);
    failure = Object.assign(Error('spawn git ENOENT'), { code: 'ENOENT' });
    for (const name of ['git_status_tool', 'git_diff_tool', 'git_commit_tool']) {
      const r = await c.tool(name); check(name + ' reports missing Git rather than a normal non-repository', r.status === 'error' && r.text.includes('Git executable not found') && r.text.includes('ENOENT'));
    }
    failure = Object.assign(Error('fatal: cannot read config'), { status: 128, stderr: Buffer.from('fatal: cannot read config: Permission denied') });
    check('Git ACL/config failure is not silently classified as non-repository', (await c.tool('git_status_tool')).status === 'error');
    failure = Object.assign(Error('fatal: unsafe ownership'), { status: 128, stderr: Buffer.from('fatal: detected dubious ownership in repository') });
    check('Git unsafe-ownership failure is visible', (await c.tool('git_diff_tool')).status === 'error');
    failure = Object.assign(Error('fatal: not a git repository'), { status: 128, stderr: Buffer.from('fatal: not a git repository (or any of the parent directories): .git') });
    check('actual non-repository retains read-info and commit-error contracts', (await c.tool('git_status_tool')).status === 'ok' && (await c.tool('git_diff_tool')).status === 'ok' && (await c.tool('git_commit_tool')).status === 'error');
    check('only the repo probe pins its own diagnostic locale', lastOptions.env.LC_ALL === 'C' && lastOptions.env.LANG === 'C' && lastOptions.env !== process.env);
    const env = Object.assign({}, process.env); for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key]; env.PATH = '';
    c.child_process.execFileSync = (file, args, options) => cp.execFileSync(file, args, Object.assign({}, options, { env }));
    check('real stripped-PATH Git lookup fails explicitly without spawning another tool', (await c.tool('git_status_tool')).status === 'error');

    let runtimeEnv = env;
    const raw = vm.createContext({ fs, path, Buffer, process: { platform: process.platform, env: runtimeEnv, versions: process.versions, execPath: process.execPath }, launchDir: cwd, setTimeout, clearTimeout, setInterval, clearInterval, console: { log() {} },
      child_process: { exec(command, options, callback) {
        const child = cp.exec(command, Object.assign({}, options, { cwd, env: runtimeEnv, windowsHide: true }), callback); owned.push(child);
        if (child.pid) fs.appendFileSync(S.manifest, child.pid + '\t--7coder-test-owner=' + S.runDir + '\n'); return child;
      } } });
    vm.runInContext(cut('function fileByteLimitError(', 'function guardStateFile(') + cut('function parseStateJson(', 'function parseModelState(') +
      cut('function decodeUtf8Text(', '// Bounded line view.') + cut('function readDirectoryEntriesBounded(', '// Resolves symlinks/junctions') +
      cut('function executionCancelledError(', 'function parseSSEStream(') + cut('function quoteForShell(', '// Locate a real bash binary') +
      cut('function withUtf8Codepage(', '// ====================== PERSISTENT SHELL') +
      cut('// OPT-13: pilot tools carry authoritative status', '// Central choke point') +
      'async function tests(args,cancelled=null) { const name="run_tests_tool";\n' + cut('function parseTestOutput(', '// ====================== DIAGNOSTICS FORMATTING') + '\n}', raw);
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'fixture' } }));
    const r = await raw.tests({});
    check('missing automatic npm gives a readable prerequisite failure before any shell process', r.status === 'error' && r.text.includes('npm was not found on PATH') && !r.text.includes('\ufffd') && r.data.exitCode === null && owned.length === 0);
    const shimDir = path.join(cwd, 'npm 中文 shim'); fs.mkdirSync(shimDir);
    const program = path.join(cwd, 'npm-fixture.js'); fs.writeFileSync(program, 'console.log("1 passing"); console.log("fixture only, no registry");');
    const shim = path.join(shimDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    fs.writeFileSync(shim, process.platform === 'win32' ? '@echo off\r\n"' + S.NODE_BIN + '" "' + program + '"\r\n' : '#!/bin/sh\n"' + S.NODE_BIN + '" "' + program + '"\n');
    if (process.platform !== 'win32') fs.chmodSync(shim, 0o755);
    runtimeEnv = Object.assign({}, env, { PATH: shimDir }); raw.process.env = runtimeEnv;
    check('executable lookup resolves the actual private npm shim', raw.findOptionalExecutable('npm') === shim);
    const ran = await raw.tests({});
    check('automatic npm invokes the exact checked Unicode/space path with no system Node/npm', ran.status === 'ok' && ran.data.passed === 1 && ran.text.includes('fixture only, no registry') && owned.length === 1);
    check('fixed system-directory codepage prefix is applied only on Windows', raw.withUtf8Codepage('echo test') === (process.platform === 'win32' ? '"%SystemRoot%\\System32\\chcp.com" 65001>nul & echo test' : 'echo test'));
    console.log('TOOL/PREREQUISITES ' + checks + '/' + checks + '; no optional tools installed or downloaded');
  } finally { for (const child of owned) if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch (e) {} } S.cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
