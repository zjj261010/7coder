'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),net=require('net'),vm=require('vm');
const {EventEmitter}=require('events'),{PassThrough}=require('stream');
const {supervise}=require('../lib/process-supervision'),recoveryAPI=require('../lib/process-recovery');
const S=require('./_shared').create({suite:'process-recovery'}),root=path.dirname(S.IDX),children=[],sockets=[];
let checks=0;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
const deadline=setTimeout(()=>{console.error('RECOVERY deadline');process.exit(1);},20000);
process.once('exit',()=>{if(checks!==23){console.error('RECOVERY incomplete '+checks+'/23');process.exitCode=1;}});
function clock(){const timers=[];return {timers,setTimeout(fn,ms){const t={fn,ms,cleared:false};timers.push(t);return t;},clearTimeout(t){if(t)t.cleared=true;},fire(){const t=timers.filter(t=>!t.cleared).pop();assert.ok(t,'pending deadline');t.cleared=true;t.fn();}};}
async function until(fn){const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw Error('fixture control handshake deadline');await new Promise(r=>setTimeout(r,5));}}
function fixture(protocol){
  const time=clock();let child,calls=0,socket;
  const manager=require(path.join(root,'lib','process-owner')).create(Object.assign({},cp,{spawn(file,args){
    calls++;child=new EventEmitter();children.push(child);child.pid=987654;child.exitCode=null;child.signalCode=null;child.kills=0;
    for(const key of ['stdin','stdout','stderr'])child[key]=new PassThrough();
    child.kill=()=>{child.kills++;return true;};
    if(protocol){socket=net.createConnection(args[0]);sockets.push(socket);socket.on('error',()=>{});socket.on('connect',()=>socket.write('HELLO2 '+args[1]+' '+child.pid+'\n'));
      let buffer='';socket.on('data',bytes=>{buffer+=bytes;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(line==='START')socket.write('READY 876543\n');}});}
    return child;
  }}),root,{supervision:time});
  let count=0;const result=new Promise(resolve=>{manager.execFile(S.NODE_BIN,[],{timeout:0},(error,stdout)=>{count++;resolve({error,stdout});});});
  return {manager,time,result,get child(){return child;},get calls(){return calls;},get count(){return count;},send(line){socket.write(line+'\n');},close(){child.exitCode=0;child.emit('close',0,null);}};
}
(async()=>{try{
  let time=clock(),child=new EventEmitter(),state={closed:false},unknown=0;
  let guard=supervise(child,state,()=>unknown++,time);guard.stop();guard.stop();
  check('repeated stop cannot reset or multiply the 8-second terminal deadline',time.timers.length===1&&time.timers[0].ms===8000);
  child.emit('exit',0);check('observed exit shortens remaining held-stdio wait to 2 seconds',time.timers.length===2&&time.timers[0].cleared&&time.timers[1].ms===2000);
  time.fire();guard.close();check('deadline reports unknown once without synthesizing close or cleanup proof',unknown===1&&!state.closed&&guard.uncertain&&child.listenerCount('exit')===0);
  time=clock();child=new EventEmitter();guard=supervise(child,{closed:true},()=>unknown++,time);guard.stop();guard.close();
  check('normal close clears its sole deadline and removes exit listener',time.timers[0].cleared&&child.listenerCount('exit')===0&&unknown===1);

  const cwd=S.freshCwd('marker 中文'),store=recoveryAPI.create(cwd);store.assertReady();
  check('normal admission does not create a marker or state directory',fs.readdirSync(cwd).length===0&&!store.info().required);
  const record=store.record(Error('fixture unknown'));await until(()=>!store.info().pending);const bytes=fs.readFileSync(record.file);
  check('unknown outcome writes a bounded UTF8 durable recovery record',record.persistenceError===null&&bytes.length<2048&&JSON.parse(bytes.toString()).code==='EOWNERUNKNOWN');
  store.record(Error('late failure'));assert.throws(()=>recoveryAPI.create(cwd).assertReady(),e=>e.code==='EOWNERUNKNOWN');
  check('record is exclusive and restart remains blocked without rewriting evidence',fs.readFileSync(record.file).equals(bytes));
  fs.writeFileSync(record.file,'{partial');assert.throws(()=>recoveryAPI.create(cwd).assertReady(),e=>e.code==='EOWNERUNKNOWN');
  check('interrupted malformed marker still blocks admission and is not repaired',fs.readFileSync(record.file,'utf8')==='{partial');
  const denied=S.freshCwd('marker-directory');fs.mkdirSync(path.join(denied,recoveryAPI.NAME));const blocked=recoveryAPI.create(denied);assert.throws(()=>blocked.assertReady(),e=>e.code==='EOWNERUNKNOWN');
  check('unexpected marker type is fail-closed without deletion',fs.statSync(path.join(denied,recoveryAPI.NAME)).isDirectory());
  const ioClock=clock();let pendingOpen,reported=0;
  const sandbox=vm.createContext({module:{exports:{}},require:name=>name==='path'?path:{lstatSync(){throw Object.assign(Error('not found'),{code:'ENOENT'});},open(file,mode,callback){pendingOpen=callback;}},
    setTimeout:ioClock.setTimeout,clearTimeout:ioClock.clearTimeout});
  vm.runInContext(fs.readFileSync(path.join(root,'lib','process-recovery.js'),'utf8'),sandbox);
  const slow=sandbox.module.exports.create(cwd);slow.record(Error('stuck driver'),()=>reported++);assert.throws(()=>slow.assertReady(),e=>e.code==='EOWNERUNKNOWN');
  check('stuck journal IO returns immediately while keeping in-memory isolation',slow.info().pending&&reported===0&&!!pendingOpen);
  ioClock.fire();check('journal deadline reports incomplete persistence without pretending IO cancelled',slow.info().pending&&slow.info().persistenceError==='ETIMEDOUT'&&reported===1);
  pendingOpen(Object.assign(Error('denied'),{code:'EACCES'}));check('late journal failure closes pending bookkeeping without retry or duplicate notification',!slow.info().pending&&slow.info().persistenceError==='EACCES'&&reported===1);

  if(process.platform!=='win32')throw Error('manager supervision fixtures require the actual Windows control worker');
  let f=fixture(false);f.child.stdout.write('partial 中文');f.child.kill();
  assert.throws(()=>f.manager.assertProcessOwnerReady(),e=>e.code==='EOWNERCLEANUP');
  check('stop blocks new work before terminal timeout, using only fake owned handle',f.child.kills===1&&f.count===0);
  f.time.fire();let result=await f.result;
  check('stop with no close settles collector once as unknown with partial output',result.error.code==='EOWNERUNKNOWN'&&result.stdout==='partial 中文'&&f.count===1&&!f.child.ownedTree.closed);
  let info=f.manager.processOwnerInfo();check('unclosed handle remains visible instead of claiming admission/resources are zero',info.active===1&&info.unresolved===1&&info.recoveryRequired);
  f.close();info=f.manager.processOwnerInfo();assert.throws(()=>f.manager.spawn(S.NODE_BIN,[]),e=>e.code==='EOWNERUNKNOWN');
  check('late close retires bookkeeping without clearing quarantine or replaying spawn',info.active===0&&info.recoveryRequired&&f.calls===1&&f.count===1);

  f=fixture(true);await until(()=>f.child.ownedTree.bound);f.send('TARGETS_EMPTY 0');await until(()=>f.child.ownedTree.closed);
  f.child.exitCode=0;f.child.emit('exit',0,null);f.time.fire();result=await f.result;
  check('held stdio after proven target cleanup is still an incomplete command result',result.error.code==='EOWNERUNKNOWN'&&f.child.ownedTree.closed&&f.child.kills===0&&f.time.timers[0].ms===2000);
  check('local stream destruction never clears the sticky recovery requirement',f.child.stdout.destroyed&&f.manager.processOwnerInfo().recoveryRequired&&f.count===1);f.close();

  f=fixture(true);await until(()=>f.child.ownedTree.bound);f.send('ERROR 1234');await until(()=>f.time.timers.length>0);
  check('native protocol failure requests stop and starts a bounded terminal wait',f.time.timers[0].ms===8000&&f.child.ownedTree.error.includes('1234'));
  f.time.fire();result=await f.result;check('native error with permanently missing callback terminates as unknown',result.error.code==='EOWNERUNKNOWN'&&!f.child.ownedTree.closed&&f.count===1);f.close();

  f=fixture(true);await until(()=>f.child.ownedTree.bound);const evidence=recoveryAPI.create(S.freshCwd('callback-order'));let persisted=false;
  f.manager.onProcessOwnerUnknown(error=>{evidence.record(error);persisted=true;});f.close();result=await f.result;
  check('bound close without proof isolates before callback while persistence runs independently',persisted&&evidence.info().required&&result.error.code==='EOWNERUNKNOWN'&&f.manager.processOwnerInfo().active===0);
  const cause=result.error.cause;check('unknown completion does not invent an observed target exit status',!f.child.ownedTree.closed&&f.child.ownedTree.exitCode===null&&!cause);
  const snapshot=f.manager.processOwnerInfo();snapshot.quarantine.message='MUTATED';
  check('diagnostic snapshots cannot mutate the quarantine reason',f.manager.processOwnerInfo().quarantine.message!=='MUTATED');
  await until(()=>!evidence.info().pending);
  console.log('RECOVERY 23/23; real control workers, fake handles/streams, no native target or PID signals');
}finally{
  clearTimeout(deadline);for(const socket of sockets)socket.destroy();for(const child of children){child.exitCode=0;child.emit('close',0,null);}S.cleanup();
}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
