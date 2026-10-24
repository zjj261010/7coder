// Real text-only PowerShell plus captured desktop dispatch: never SendKeys,
// move the cursor, or capture the user's screen during this suite.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const S = require('./_shared').create({ suite: 'powershell-encoding' });
const source = fs.readFileSync(S.IDX, 'utf8'), children = [], calls = [];
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
const cwd = S.freshCwd('中文 空格 % ! & 单\'引号');
const ctx = vm.createContext({ Buffer, fs, path, process, console: { log() {} }, DANGER_MODE: false,
  effectivePermissionMode: () => 'default', checkExecution() {}, VISION_MODEL: '', launchDir: cwd,
  internalStatePath: (...p) => path.join(cwd, ...p), makeToolResult: (status, text, data) => ({ status, text, data }),
  child_process: { execSync() { throw Error('shell dispatch is forbidden in fixture'); }, execFileSync(file, args, opts) { calls.push({ file, args, opts }); } },
  runCommandAsync: spec => { calls.push(spec); return spec; }, awaitCommandCancellable: async () => ctx.outcome });
vm.runInContext(cut('function powerShellExecutable()', '// AST-09: async child-process runner') +
  'async function tool(name,args,cancelled=null,modelContext={}) {\n' + cut("  if (name === 'powershell_tool') {", "  if (name === 'glob_tool') {") +
  cut("  if (name === 'computer_use') {", "  if (name === 'workflow_tool') {") + '\n}', ctx);
function decoded(spec) {
  const bootstrap = spec.args[spec.args.indexOf('-Command') + 1];
  const payload = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(bootstrap);
  assert.ok(payload, 'fixed Base64 bootstrap'); return Buffer.from(payload[1], 'base64').toString('utf16le');
}
function native(spec) {
  return new Promise(resolve => {
    const child = cp.execFile(spec.file, spec.args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      fs.writeFileSync(path.join(S.runDir, 'ps-result-' + child.pid + '.json'), JSON.stringify({ code: error && error.code, stdout, stderr }), 'utf8');
      resolve({ error, stdout, stderr });
    });
    children.push(child);
    if (child.pid) fs.appendFileSync(S.manifest, child.pid + '\t' + spec.args[spec.args.length - 1] + '\n');
  });
}
(async () => {
  try {
    const input = 'Write-Output \'中文 "空格" % ! &\'; Write-Output "第二行"';
    const spec = ctx.powerShellSpec(input), text = decoded(spec);
    check('Base64 bootstrap preserves all input characters without raw command text in argv', text.startsWith(input + '\r\n') && !/[^\x00-\x7f]/.test(spec.args[spec.args.length - 1]) && !spec.args.includes('-EncodedCommand'));
    check('PS2-compatible prefix sets encoding before parsing user code', spec.args[spec.args.length - 1].startsWith('$OutputEncoding = New-Object System.Text.UTF8Encoding; [Console]::OutputEncoding = $OutputEncoding;\r\n') && spec.args.includes('-NonInteractive') && spec.args.includes('Text'));
    if (process.platform !== 'win32') { console.log('POWERSHELL/ENCODING ' + checks + ' passed; 1 SKIP (Windows/desktop dispatch unavailable)'); return; }
    check('Windows system PowerShell is selected independently of PATH', spec.file.toLowerCase() === path.join(process.env.SystemRoot || process.env.windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').toLowerCase());
    ctx.outcome = { r: { stdout: '中文输出', stderr: '', error: null, exitCode: 0 }, aborted: false };
    const result = await ctx.tool('powershell_tool', { command: input });
    check('tool uses original argv helper and retains explicit success/exit status', result.status === 'ok' && result.data.exitCode === 0 && decoded(calls.pop()).startsWith(input + '\r\n'));
    await ctx.tool('computer_use', { action: 'type_text', text: "中文'a{b}\r\n" });
    let called = calls.pop(), bytes = fs.readFileSync(path.join(cwd, '.7coder', 'input.ps1'));
    check('captured SendKeys script is UTF-8 BOM and preserves escaped Unicode text', bytes.slice(0, 3).equals(Buffer.from([239, 187, 191])) && bytes.toString('utf8').includes("中文''a{{}b{}}{ENTER}"));
    check('input helper passes Chinese/space/shell-metachar path as one argv item', called.file === spec.file && called.args[called.args.indexOf('-File') + 1] === path.join(cwd, '.7coder', 'input.ps1') && called.opts.windowsHide && called.opts.timeout === 30000);
    await ctx.tool('computer_use', { action: 'screenshot' }); called = calls.pop();
    check('captured screenshot uses Base64 bootstrap and literal single-quoted path', called.file === spec.file && decoded(called).includes(cwd.replace(/'/g, "''")) && called.opts.windowsHide);
    check('desktop branches were captured, never sent to native PowerShell', children.length === 0 && calls.length === 0);
    if (!fs.existsSync(spec.file)) { console.log('POWERSHELL/ENCODING ' + checks + ' passed; 1 SKIP (system PowerShell unavailable; real text output unvalidated)'); return; }
    let real = await native(ctx.powerShellSpec(input + '\n# ' + S.runDir));
    check('real text-only PowerShell returns exact Unicode stdout without replacement characters', !real.error && real.stdout.includes('中文 "空格" % ! &') && real.stdout.includes('第二行') && !real.stdout.includes('\ufffd'));
    const file = path.join(cwd, '文字 数据.txt'), literal = file.replace(/'/g, "''");
    real = await native(ctx.powerShellSpec("[System.IO.File]::WriteAllText('" + literal + "', '写入内容'); Write-Output ([System.IO.File]::ReadAllText('" + literal + "')); Write-Error '中文错误'; exit 7\n# " + S.runDir));
    check('real quoted Unicode file path works and numeric exit is preserved', real.error && real.error.code === 7 && fs.readFileSync(file, 'utf8') === '写入内容' && real.stdout.includes('写入内容'));
    check('real stderr retains Chinese error text under UTF-8 capture', real.stderr.includes('中文错误') && !real.stderr.includes('\ufffd'));
    real = await native(ctx.powerShellSpec("Write-Error '非终止错误'\n# " + S.runDir));
    check('nonterminating final Write-Error keeps failed command exit semantics', real.error && real.error.code === 1 && real.stderr.includes('非终止错误'));
    real = await native(ctx.powerShellSpec("throw '终止错误'\n# " + S.runDir));
    check('terminating error keeps failed command exit semantics', real.error && real.error.code === 1 && real.stderr.includes('终止错误'));
    real = await native(ctx.powerShellSpec('Write-Output "未结束'));
    check('syntax errors before user script execution also preserve Unicode and nonzero exit', real.error && real.error.code === 1 && real.stderr.includes('未结束') && !real.stderr.includes('\ufffd'));
    console.log('POWERSHELL/ENCODING ' + checks + '/' + checks + '; 0 SKIP; host PowerShell, not a PS2/Win7 claim');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch (e) {} }
    S.cleanup();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
