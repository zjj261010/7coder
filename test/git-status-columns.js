const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const S = require('./_shared').create({ suite: 'git-status-columns' });
const source = fs.readFileSync(S.IDX, 'utf8');
let checks = 0; const children = [];
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from); return source.slice(start, end);
}
(async () => {
  try {
    const cwd = S.freshCwd('git 中文 空格'), config = path.join(path.dirname(path.dirname(S.IDX)), 'empty.gitconfig');
    fs.writeFileSync(config, '');
    const env = Object.assign({}, process.env);
    for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
    env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = config;
    const execFileSync = (file, args, options) => cp.execFileSync(file, args, Object.assign({}, options, { cwd, env }));
    const execFile = (file,args,options,callback) => { const child=cp.execFile(file,args,Object.assign({},options,{cwd,env}),callback);children.push(child);return child; };
    const ctx = vm.createContext({ process, launchDir: cwd, checkExecution() {}, child_process: { execFileSync, execFile } });
    vm.runInContext(cut('function runCommandAsync(', '// ====================== PERSISTENT SHELL') + cut('// OPT-13: pilot tools carry authoritative status', '// Central choke point') +
      cut('function git(argsArr, opts)', "  if (name === 'git_status_tool') {") +
      'async function status(){const name="git_status_tool",cancelled=null;\n' + cut("  if (name === 'git_status_tool') {", "  if (name === 'git_diff_tool') {") + '\n}', ctx);
    const git = args => execFileSync('git', args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init']); git(['config', 'core.autocrlf', 'false']); git(['config', 'core.quotepath', 'false']);
    const file = path.join(cwd, 'app.txt'); fs.writeFileSync(file, 'v1\n'); git(['add', '--', 'app.txt']);
    const commit = () => git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    commit();
    check('clean real repository reports zero counts', (await ctx.status()).text.includes('staged:0 modified:0 untracked:0'));
    fs.writeFileSync(file, 'v2\n');
    let result = await ctx.status();
    check('first unstaged entry keeps its leading XY space and counts as modified', result.status === 'ok' && result.text.includes('staged:0 modified:1 untracked:0') && result.text.includes('\n M app.txt'));
    git(['add', '--', 'app.txt']); result = await ctx.status();
    check('first staged-only entry counts only the index column', result.text.includes('staged:1 modified:0 untracked:0') && result.text.includes('\nM  app.txt'));
    fs.writeFileSync(file, 'v3\n'); result = await ctx.status();
    check('MM entry counts both staged and unstaged changes', result.text.includes('staged:1 modified:1 untracked:0') && result.text.includes('\nMM app.txt'));
    const extra = path.join(cwd, '新 文件.txt'); fs.writeFileSync(extra, 'new\n'); result = await ctx.status();
    check('untracked entry does not increment either XY modification count', result.text.includes('staged:1 modified:1 untracked:1') && result.text.includes('??'));
    git(['add', '--', 'app.txt']); commit(); result = await ctx.status();
    check('untracked-only first entry remains distinct from tracked changes', result.text.includes('staged:0 modified:0 untracked:1'));
    fs.unlinkSync(extra); result = await ctx.status();
    check('returning to clean repository adds no phantom empty status line', result.text.includes('staged:0 modified:0 untracked:0') && !result.text.includes('\n'));
    ctx.gitRead = args => args[0] === 'status' ? ' M first.txt\r\nM  second.txt\r\n' : 'fixture';
    result = await ctx.status();
    check('CRLF status output preserves column positions without a trailing empty record', result.text.includes('staged:1 modified:1 untracked:0') && result.text.includes('\n M first.txt') && !result.text.endsWith('\r\n'));
    ctx.gitRead = args => { if (args[0] === 'status') throw Error('Git fixture failure'); return 'fixture'; };
    result = await ctx.status();
    check('status failure inside a known repository remains an explicit error', result.status === 'error' && result.text.includes('Git fixture failure'));
    console.log('GIT/STATUS-COLUMNS ' + checks + '/' + checks);
  } finally { for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();S.cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
