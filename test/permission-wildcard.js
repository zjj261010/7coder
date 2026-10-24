const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http');
const S = require('./_shared').create({ suite: 'permission-wildcard' }), sockets = new Set();
let checks = 0, server, H;
const deadline = setTimeout(() => { console.error('PERMISSION/WILDCARD deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 20000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
(async () => {
  try {
    const cwd = S.freshCwd('owned'), script = path.join(S.runDir, 'wildcard-bounded.js');
    fs.writeFileSync(script, `const fs=require('fs'),vm=require('vm'),assert=require('assert');
const {loadContext}=require(${JSON.stringify(path.join(__dirname, 'download-commit.js'))}),source=fs.readFileSync(${JSON.stringify(S.IDX)},'utf8');
const c=loadContext(source,${JSON.stringify(cwd)},null,{Buffer});const cut=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
vm.runInContext(cut('const PROTECTED_FILES =','function loadPermRules()')+cut('function permRuleArgText(','// Quotes a token')+'this.rules=permRules;',c);console.log('MATCHING_STARTED');
const samples=[['*','',true],['*','first\\nsecond',true],['a*b','a\\nb',true],['a*b','zab',false],['a*b','abz',false],['*a*','bac',true],['***a****b***','zaYbZ',true],['a*a','a',false],['a*a','aa',true],['*ab*bc','abc',false],['*ab*bc','abxbc',true],['a?b[1].(x)+$^','a?b[1].(x)+$^',true],['a?b[1].(x)+$^','axb1xx',false],['你好*😀','你好内容😀',true],['aBc*','ABC123',true],['Ω','ω',true],['K','K',false],['ſ','S',false],['ß','SS',false]];
const result={matrix:samples.every(([p,t,expected])=>c.compilePermissionWildcard(p).test(t)===expected)};
const literal=c.compilePermissionWildcard('exact');result.full=literal.test('exact')&&!literal.test('prefixexact')&&!literal.test('exact suffix');
const reset=c.compilePermissionWildcard('*ab*cd*');result.reset=reset.test('xabxcdx')&&!reset.test('absent')&&reset.test('abYYcd');
const pattern='*a'.repeat(24)+'*b',stress=c.compilePermRule('run_command('+pattern+')','deny');result.bad=!stress.argRe.test('a'.repeat(80)+'!');
const middle=c.compilePermissionWildcard('*a'.repeat(24)+'*c*b');result.middle=true;for(let i=0;i<1000;i++)if(middle.test('a'.repeat(80)+'xb'))result.middle=false;
result.multiline=c.compilePermRule('run_command(*)','deny').argRe.test('echo first\\necho second')&&c.compilePermRule('run_command(echo*\\necho*)','deny').argRe.test('echo1\\necho2');
let overflow=false;try{c.compilePermissionWildcard('*a'.repeat(129));}catch(e){overflow=/128 literal segments/.test(e.message);}result.admission=overflow&&c.compilePermissionWildcard('*a'.repeat(128)).test('a'.repeat(128))&&c.compilePermissionWildcard('*'.repeat(4096)).test('anything\\nelse');
c.rules.deny=Array.from({length:1000},(_,i)=>c.compilePermRule('memory_tool(miss-'+i+')','deny'));let serializations=0;const args={toJSON(){serializations++;return {value:'abc'};}};result.once=c.matchPermRule('deny','memory_tool',args)===null&&serializations===1;
console.log('RESULT '+JSON.stringify(result));
`);
    const child = S.spawn(S.NODE_BIN, [script], { cwd }); let output = '', expired = false, matchTimer;
    const startupTimer = setTimeout(() => { expired = true; child.kill(); }, 5000);
    child.stdout.on('data', d => { output += d; if (output.includes('MATCHING_STARTED') && !matchTimer) { clearTimeout(startupTimer); matchTimer = setTimeout(() => { expired = true; child.kill(); }, 2000); } }); child.stderr.on('data', d => output += d);
    await new Promise(resolve => child.once('close', resolve)); clearTimeout(startupTimer); clearTimeout(matchTimer);
    assert.ok(child.exitCode === 0 && !expired, 'owned wildcard child: ' + output); const found = /^RESULT (.+)$/m.exec(output); assert.ok(found, output); const result = JSON.parse(found[1]);
    check('wildcard matrix preserves escaped literals/Unicode case behavior and crosses newlines', result.matrix);
    check('whole-string matching keeps prefix/suffix boundaries', result.full);
    check('reused compiled literals reset search state between true/false/true calls', result.reset);
    check('former exponential missing-tail case returns under independent deadline', result.bad);
    check('one thousand missing-middle cases do not backtrack over wildcard combinations', result.middle);
    check('all-command and explicit multi-line policies match multi-line input', result.multiline);
    check('128 literal-segment limit bounds compilation while repeated stars retain meaning', result.admission);
    check('one permission bucket serializes tool arguments once across 1000 matching selectors', result.once);
    const file = 'a'.repeat(80) + '!.txt', badPattern = '*a'.repeat(24) + '*b'; fs.mkdirSync(path.join(cwd, '.7coder'));
    fs.writeFileSync(path.join(cwd, '.7coder', 'permissions.json'), JSON.stringify({ deny: ['write_file(' + badPattern + ')', 'run_command(*)'], protected_extra: [badPattern, '*.key'] }));
    const command = '"' + S.NODE_BIN + '" -e "require(\'fs\').writeFileSync(\'must-not-run.txt\',\'bad\')"\necho ending';
    server = http.createServer((req, res) => { let raw = ''; req.setEncoding('utf8'); req.on('data', d => raw += d); req.on('end', () => {
      const body = JSON.parse(raw), message = body.messages.some(m => m.role === 'tool') ? { content: 'WILDCARD_RECOVERED' } : { content: '', tool_calls: [ ['file-fast', 'write_file', { path: file, content: 'fixture' }], ['multiline-block', 'run_command', { command }], ['protected-key', 'write_file', { path: 'secret.key', content: 'private' }] ].map(([id, name, args], index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) };
      res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: message }] }) + '\n\ndata: [DONE]\n\n');
    }); }); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
    H = require('./_endpoint').create({ suite: 'wildcard-agent', endpoint: 'http://127.0.0.1:' + server.address().port, key: 'fixture', model: 'fixture', permissionMode: 'bypass' }); await H.start(cwd);
    const start = Date.now(), response = await H.chat([{ role: 'user', content: 'verify wildcard boundaries' }], 5000), results = response.tools.filter(t => t.type === 'result');
    check('actual Agent completes complex permission and protected-extra matching in bounded time', response.content === 'WILDCARD_RECOVERED' && Date.now() - start < 2000 && results.length === 3 && results.filter(t => t.callId === 'file-fast' && t.status === 'completed').length === 1 && fs.readFileSync(path.join(cwd, file), 'utf8') === 'fixture');
    check('multi-line command is blocked before its private marker can be written', results.filter(t => t.callId === 'multiline-block' && t.status === 'blocked').length === 1 && !fs.existsSync(path.join(cwd, 'must-not-run.txt')));
    check('ordinary protected extension remains blocked in bypass', results.filter(t => t.callId === 'protected-key' && t.status === 'blocked').length === 1 && !fs.existsSync(path.join(cwd, 'secret.key')));
    const rows = S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')).filter(r => r.type === 'tool'), info = JSON.parse((await H.api('/api/info')).body);
    check('all three call identities retain exact audit states and Agent returns idle', rows.length === 3 && ['file-fast', 'multiline-block', 'protected-key'].every(id => rows.filter(r => r.callId === id && r.status === (id === 'file-fast' ? 'ok' : 'blocked')).length === 1) && info.runtime.activeTools === 0 && info.runtime.activeTasks === 0);
    console.log('PERMISSION/WILDCARD ' + checks + '/' + checks + ' passed; SKIP 0');
  } finally { clearTimeout(deadline); if (H) { await H.stop(); H.S.cleanup(); } S.cleanup(); for (const socket of sockets) socket.destroy(); if (server) await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
