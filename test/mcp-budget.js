const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm'),{EventEmitter}=require('events'),{PassThrough,Writable}=require('stream');
const S=require('./_shared').create({suite:'mcp-budget'}),source=fs.readFileSync(S.IDX,'utf8');
let checks=0;const clients=[];
const deadline=setTimeout(()=>{console.error('MCP/BUDGET deadline');S.cleanup();process.exit(1);},15000);
function check(label,ok){assert.ok(ok,label);checks++;console.log('PASS '+label);}
const tick=()=>new Promise(r=>setImmediate(r));
function context(spawn){const a=source.indexOf('function createMcpStdioClient('),b=source.indexOf('function getMcpClient(',a);assert.ok(a>=0&&b>a);
  const c=vm.createContext({child_process:{spawn},launchDir:S.runDir,process,Buffer,MCP_MAX_FRAME_BYTES:4*1024*1024,mcpClients:{},APP_VERSION:'fixture',MCP_CALL_TIMEOUT:5000,
    resolveCommandOnWindows:()=>false,console:{warn(){}},setTimeout,clearTimeout,checkExecution:()=>{},watchExecution:()=>()=>{},executionCancelledError:()=>Error('cancelled'),mcpContentToText:()=>''});vm.runInContext(source.slice(source.indexOf('function serializeModelRequest('),source.indexOf('function checkExecution('))+source.slice(a,b),c);return c;}
function fake(stalled){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=0;child.kill=()=>{child.killed++;return true;};
  const writes=[],callbacks=[];child.stdin=new Writable({write(chunk,encoding,cb){writes.push(chunk.toString());if(stalled)callbacks.push(cb);else cb();}});
  return {child,writes,callbacks};}
async function bounded(promise,ms=3000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('owned child deadline')),ms))]);}finally{clearTimeout(timer);}}
(async()=>{
  try{
    let f=fake(false),c=context(()=>f.child),client=c.createMcpStdioClient('pending',{});clients.push(client);
    const waiters=Array.from({length:32},()=>client.request('wait',{},10000).catch(e=>e));
    await tick();const before=f.writes.length;
    await assert.rejects(client.request('overflow',{},10000),/pending request limit.*request not sent/);
    check('33rd request is rejected before a write or retirement',client.pending.size===32&&f.writes.length===before&&!client.dead&&f.child.killed===0);
    f.child.stdout.write(JSON.stringify({id:1,result:'first-completed'})+'\n');
    check('one response releases exactly one pending slot',(await waiters[0])==='first-completed'&&client.pending.size===31);
    const admitted=client.request('new',{},10000).catch(e=>e);check('released slot accepts a new request',client.pending.size===32&&f.writes.length===33);
    client.dispose();const stopped=await Promise.all(waiters.slice(1).concat(admitted));
    check('retirement settles all remaining waiters and clears counters',stopped.every(e=>e instanceof Error||e&&typeof e.message==='string')&&client.pending.size===0&&client.queuedBytes===0);

    f=fake(true);c=context(()=>f.child);client=c.createMcpStdioClient('queue',{});clients.push(client);
    const held=client.request('held',{text:'中'.repeat(900000)},10000).catch(e=>e),queued=client.queuedBytes;
    check('queue tracks UTF8 bytes rather than character count',queued>2700000&&queued<4*1024*1024&&f.writes.length===1);
    await assert.rejects(client.request('overflow',{text:'x'.repeat(2*1024*1024)},10000),/outgoing queue exceeds.*request not sent/);
    check('queue overflow leaves prior request live and unsent request absent',client.pending.size===1&&client.queuedBytes===queued&&f.writes.length===1&&!client.dead);
    f.callbacks.shift()();await tick();check('write callback releases encoded bytes',client.queuedBytes===0);
    const next=client.request('small',{},10000).catch(e=>e);check('drained queue can admit another request',client.pending.size===2&&f.writes.length===2);
    client.dispose();if(f.callbacks.length){f.callbacks.shift()();await tick();}
    await Promise.all([held,next]);check('late write completion after disposal cannot underflow bytes or revive client',client.dead&&client.queuedBytes===0&&client.pending.size===0);

    c=context((cmd,args,opts)=>S.spawn(cmd,args,opts));client=c.createMcpStdioClient('real-blocked',{command:S.NODE_BIN,args:['-e','process.stdin.pause();console.log("OWNED_READY");setInterval(()=>{},1000)']});clients.push(client);
    await bounded(new Promise(resolve=>{let out='';client.child.stdout.on('data',d=>{out+=d;if(out.includes('OWNED_READY'))resolve();});}));
    const real=client.request('held',{text:'x'.repeat(3*1024*1024)},5000).catch(e=>e);
    await assert.rejects(client.request('overflow',{text:'y'.repeat(2*1024*1024)},5000),/outgoing queue exceeds.*request not sent/);
    check('real Node13 pipe backpressure has bounded queued data and one pending request',client.queuedBytes>3*1024*1024&&client.queuedBytes<=4*1024*1024&&client.pending.size===1&&!client.dead);
    const close=new Promise(resolve=>client.child.once('close',resolve));client.dispose();await bounded(close);const error=await real;
    check('owned unread-pipe child closes and sent request remains explicitly unknown',error.message.includes('result unknown')&&client.queuedBytes===0&&client.pending.size===0);
    console.log('MCP/BUDGET '+checks+'/'+checks);
  }finally{clearTimeout(deadline);for(const client of clients)client.dispose();S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
