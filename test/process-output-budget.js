'use strict';
const assert=require('assert'),{EventEmitter}=require('events'),{PassThrough}=require('stream');
const {capture,snapshot}=require('../lib/process-capture');let checks=0;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==16){console.error('OUTPUT/BUDGET incomplete '+checks+'/16');process.exitCode=1;}});
function fixture(options){
  const child=new EventEmitter();child.pid=123;child.kills=0;child.kill=()=>{child.kills++;child.killed=true;return true;};
  for(const key of ['stdin','stdout','stderr'])child[key]=new PassThrough();let count=0,resolve;
  const result=new Promise(r=>{resolve=r;});capture({spawn:()=>child},'owned-fixture',[],Object.assign({encoding:'buffer',maxBuffer:Infinity},options),
    (error,stdout,stderr)=>{count++;resolve({error,stdout,stderr});});
  return {child,result,get count(){return count;},close(code=0){child.emit('close',code,null);}};
}
(async()=>{
  let f=fixture();const backing=Buffer.alloc(8*1024*1024,97);f.child.stdout.write(backing.slice(0,1));backing.fill(98);
  check('one-byte view retains only one owned block rather than large source backing storage',snapshot().allocatedBytes===16384&&snapshot().retainedBytes===1&&snapshot().blocks===1);
  f.close();let r=await f.result;check('collector owns a stable byte copy independent of subsequent source mutation',r.stdout.toString()==='a'&&!r.error&&snapshot().allocatedBytes===0);

  f=fixture();for(let i=0;i<10000;i++)f.child.stdout.write(Buffer.from('x'));
  check('ten thousand tiny writes coalesce into one bounded Buffer object',snapshot().blocks===1&&snapshot().retainedBytes===10000&&snapshot().allocatedBytes===16384);
  f.child.stderr.write(Buffer.from('中文'));check('stdout and stderr charge separate tails to the same aggregate budget',snapshot().blocks===2&&snapshot().retainedBytes===10006);
  f.close();r=await f.result;check('coalescing preserves exact order and UTF8 bytes on both streams',r.stdout.equals(Buffer.alloc(10000,120))&&r.stderr.toString()==='中文'&&snapshot().blocks===0);

  const first=fixture(),second=fixture();second.child.stdout.write(Buffer.alloc(16384,115));
  const limit=snapshot().limit;first.child.stdout.write(Buffer.alloc(limit-16384,102));
  check('two collectors share exact 32MiB allocation and payload admission',snapshot().allocatedBytes===limit&&snapshot().retainedBytes===limit&&snapshot().blocks===2048&&snapshot().active===2);
  second.child.stdout.write(Buffer.from('overflow'));
  check('aggregate overflow stops only the offending existing command and waits for settlement',second.child.kills===1&&first.child.kills===0&&second.count===0&&snapshot().allocatedBytes===limit);
  for(let i=0;i<10;i++)second.child.stdout.write(Buffer.alloc(64));
  check('late output after overflow neither retains extra bytes nor repeats stop',second.child.kills===1&&snapshot().allocatedBytes===limit&&snapshot().retainedBytes===limit);
  let spawned=0;assert.throws(()=>capture({spawn(){spawned++;}},'never-started',[],{},()=>{}),e=>e.code==='ERR_PROCESS_OUTPUT_BUDGET'&&/not started/.test(e.message));
  check('already exhausted budget refuses a new collector before process creation',spawned===0&&snapshot().active===2);
  first.close();r=await first.result;
  check('normal close releases only its own allocation while stopped peer stays charged',!r.error&&r.stdout.length===limit-16384&&snapshot().allocatedBytes===16384&&snapshot().retainedBytes===16384&&snapshot().active===1);
  second.close(1);r=await second.result;
  check('overflow result retains bounded own prefix and truthful side-effect warning',r.error.code==='ERR_PROCESS_OUTPUT_BUDGET'&&r.error.killed&&/may have run/.test(r.error.message)&&r.stdout.equals(Buffer.alloc(16384,115))&&second.count===1);
  check('all settled collectors restore capacity, block count and active count exactly',snapshot().allocatedBytes===0&&snapshot().retainedBytes===0&&snapshot().blocks===0&&snapshot().active===0);

  f=fixture();f.child.stdout.write('partial');f.child.emit('ownerUnknown',Object.assign(Error('unknown cleanup'),{code:'EOWNERUNKNOWN'}));r=await f.result;f.close();
  check('unknown settlement releases local capture storage once without claiming process close',r.error.code==='EOWNERUNKNOWN'&&r.stdout.toString()==='partial'&&f.count===1&&snapshot().allocatedBytes===0&&snapshot().active===0);
  f=fixture({maxBuffer:3});f.child.stdout.write(Buffer.from('four'));f.close(1);r=await f.result;
  check('per-stream maxBuffer error remains distinct from aggregate output failure',r.error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'&&r.stdout.toString()==='fou'&&snapshot().allocatedBytes===0);
  const info=snapshot();info.limit=0;info.allocatedBytes=999;
  check('diagnostic snapshots cannot modify allocator limits or counters',snapshot().limit===32*1024*1024&&snapshot().allocatedBytes===0);
  let failures=0;try{capture({spawn(){throw Error('spawn refused');}},'fixture',[],{},()=>{});}catch(error){failures++;}
  check('synchronous spawn refusal leaves no active collector or byte reservation',failures===1&&snapshot().active===0&&snapshot().blocks===0);
  console.log('OUTPUT/BUDGET 16/16; fake handles and real byte streams; returned caller results are outside this storage budget');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
