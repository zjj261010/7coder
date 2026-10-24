// Native Windows tree-stop attempt + close observation. Does not prove PID
// reuse safety, forced-Agent exit cleanup, or Job Object containment.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const cp = require('child_process'), http = require('http');
const { EventEmitter } = require('events');
const S = require('./_shared').create({ suite: 'task-windows' });
const source = fs.readFileSync(S.IDX, 'utf8');
const start = source.indexOf('const ownedChildStates ='), end = source.indexOf('async function stopBackgroundTask(', start);
assert.ok(start >= 0 && end > start);
const ctx = vm.createContext({ process, child_process: cp, setTimeout, clearTimeout });
vm.runInContext(source.slice(start, end), ctx);
let checks = 0, root = null, port = null;
const nonce = require('crypto').randomBytes(16).toString('hex');
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function request(urlPath) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: urlPath, timeout: 500 }, res => { res.resume(); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false)); req.on('timeout', () => req.destroy());
  });
}
(async () => {
  try {
    if (process.platform !== 'win32') throw Error('task-windows requires Windows; run task-lifecycle on other hosts.');
    const calls = [], stub = vm.createContext({ process, setTimeout, clearTimeout,
      child_process: { execFile(file, args, options, done) { calls.push({ file, args, options }); done(Error('EPERM fixture')); } } });
    vm.runInContext(source.slice(start, end), stub);
    const refused = new EventEmitter(); refused.pid = 123456; refused.exitCode = null; refused.signalCode = null;
    const result = await stub.stopOwnedChild(refused, 30);
    check('tree helper uses argv, hidden window, finite timeout and bounded output',
      calls.length === 1 && calls[0].file === 'taskkill.exe' && calls[0].args.join(' ') === '/PID 123456 /T /F' &&
      calls[0].options.windowsHide && calls[0].options.timeout > 0 && calls[0].options.maxBuffer === 65536);
    check('failed Windows stop remains unknown with diagnostic', !result.closed && result.message.includes('EPERM fixture'));
    const exited = new EventEmitter(); exited.pid = 123457; exited.exitCode = 0;
    await stub.stopOwnedChild(exited, 10);
    check('known natural exit prevents stale taskkill even while pipes remain open', calls.length === 1);

    const cwd = S.freshCwd('树 空格'), fixture = path.join(cwd, 'owned-tree.js');
    fs.writeFileSync(fixture, `
const cp=require('child_process'),http=require('http');
const owner=process.argv[process.argv.length-1];
if(process.argv[2]==='leaf') {
  const nonce=process.argv[3];
  const server=http.createServer((req,res)=>{res.end('owned');if(req.url==='/stop/'+nonce)setTimeout(()=>process.exit(0),10);});
  server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port,pid:process.pid}));
  setTimeout(()=>process.exit(0),12000);
} else {
  const child=cp.spawn(process.execPath,[__filename,'leaf',process.argv[3],owner],{stdio:['ignore','inherit','inherit','ipc']});
  child.on('message',info=>process.send(info));
  child.on('error',()=>process.exit(2));
  setInterval(()=>{},1000);
}
`);
    root = S.spawn(S.NODE_BIN, [fixture, 'root', nonce], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd });
    ctx.observeOwnedChild(root);
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('tree ready timeout')), 5000);
      root.once('message', value => { clearTimeout(timer); resolve(value); });
      root.once('error', error => { clearTimeout(timer); reject(error); });
    });
    port = info.port;
    fs.appendFileSync(path.join(path.dirname(S.IDX), '..', 'owned-processes.tsv'), info.pid + '\t' + '--7coder-test-owner=' + path.dirname(path.dirname(S.IDX)) + '\n');
    check('real owned grandchild holds a live loopback listener before stop', await request('/health'));
    const stopped = await ctx.stopOwnedChild(root);
    check('Windows tree attempt observes root close', stopped.closed && (root.exitCode !== null || root.signalCode !== null));
    check('owned grandchild listener is released after tree attempt', !(await request('/health')));
    console.log('TASK/WINDOWS ' + checks + '/' + checks);
  } finally {
    if (port) await request('/stop/' + nonce);
    if (root && root.exitCode === null && root.signalCode === null) { try { root.kill(); } catch (e) {} }
    S.cleanup();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
