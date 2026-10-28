const http = require('http');
const { requestError } = require('./_protocol');
const model = 'i-cron-exit-main', prompt = 'I9_CRON_TREE_EXIT_CHECK', done = 'CK-DONE';
function create(node, program, infoFile, token) {
  const call = { id: 'ck1', type: 'function', function: { name: 'schedule_cron_tool', arguments: JSON.stringify({
    schedule: '1s', command: '"' + node + '" "' + program + '" root "' + infoFile + '" ' + token
  }) } };
  const script = [
    { expect: { model, tools: true, lastUserIncludes: prompt, toolIds: [] }, reply: { role: 'assistant', content: null, tool_calls: [call] } },
    { expect: { model, tools: true, lastUserIncludes: prompt, toolIds: ['ck1'], toolResults: { ck1: 'scheduled (every 1s)' } }, reply: done }
  ];
  function cronId(log) {
    if (!Array.isArray(log) || log.length !== 2 || log.some((request, i) => requestError(request, script[i].expect) || request.stream !== true)) return null;
    const a = log[0].messages, b = log[1].messages;
    if (a.length !== 2 || a[0].role !== 'system' || a[1].role !== 'user' || a[1].content !== prompt || b.length !== 4 || JSON.stringify(a) !== JSON.stringify(b.slice(0, 2))) return null;
    if (b[2].role !== 'assistant' || JSON.stringify(b[2].tool_calls) !== JSON.stringify([call]) || b[3].role !== 'tool' || b[3].tool_call_id !== 'ck1') return null;
    const match = /^\[OK\] Cron job (cron-\d+-\d+) scheduled \(every 1s\), next run: (.+)$/.exec(b[3].content);
    return match && Number.isFinite(Date.parse(match[2])) ? match[1] : null;
  }
  function creation(log, audit) {
    if (!cronId(log) || !Array.isArray(audit)) return false;
    const rows = audit.filter(row => row && row.type === 'tool');
    return rows.length === 1 && rows[0].callId === 'ck1' && rows[0].tool === 'schedule_cron_tool' && rows[0].status === 'ok';
  }
  function nativeClosed(runtime, id) {
    if (!id || !Array.isArray(runtime)) return false;
    const rows = runtime.filter(row => row && row.scope === 'cron-child' && row.id === id);
    return rows.length === 1 && rows[0].message === 'Owned Windows target group is empty; broker closed.';
  }
  function stopped(beforeBytes, afterBytes, live, elapsedMs) {
    return Number.isSafeInteger(beforeBytes) && beforeBytes > 0 && beforeBytes === afterBytes && live === null && Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < 30000;
  }
  function query(info, action = 'probe') {
    if (!info || info.token !== token || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) return Promise.resolve(null);
    return new Promise(resolve => {
      const request = http.get({ host: '127.0.0.1', port: info.port, path: '/' + action, headers: { 'x-fixture-token': token }, timeout: 300 }, response => {
        let bytes = 0, text = '';
        response.on('data', chunk => { bytes += chunk.length; if (bytes > 1024) response.destroy(); else text += chunk; });
        response.on('end', () => { try { const value = JSON.parse(text); resolve(response.statusCode === 200 && value.token === token ? value : null); } catch (e) { resolve(null); } });
        response.on('error', () => resolve(null));
      });
      request.on('error', () => resolve(null)); request.on('timeout', () => { request.destroy(); resolve(null); });
    });
  }
  const programSource = `const fs=require('fs'),cp=require('child_process'),http=require('http');const mode=process.argv[2],file=process.argv[3],token=process.argv[4],heart=file+'.heart';setTimeout(()=>process.exit(0),45000);
if(mode==='leaf'){let ticks=0;fs.writeFileSync(heart,'');setInterval(()=>{ticks++;fs.appendFileSync(heart,'x');},25);const server=http.createServer((q,r)=>{if(q.headers['x-fixture-token']!==token){r.writeHead(403);r.end();return;}r.end(JSON.stringify({token,ticks,pid:process.pid}));if(q.url==='/stop')setTimeout(()=>process.exit(0),10);});server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port,pid:process.pid,heart,token}));}
else{const leaf=cp.spawn(process.execPath,[__filename,'leaf',file,token],{detached:true,stdio:['ignore','ignore','ignore','ipc']});leaf.on('message',info=>fs.writeFileSync(file,JSON.stringify(Object.assign({rootPid:process.pid},info))));leaf.once('exit',()=>process.exit(0));}`;
  return { model, prompt, done, call, script, cronId, creation, nativeClosed, stopped, query, programSource };
}
module.exports = { create };
