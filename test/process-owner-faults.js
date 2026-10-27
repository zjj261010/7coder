const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),net=require('net'),vm=require('vm'),http=require('http');
const {EventEmitter}=require('events'),S=require('./_shared').create({suite:'process-owner-faults'}),root=path.dirname(S.IDX);
const faultScope=process.env.PROCESS_OWNER_FAULT_SCOPE||'all';
const api=require(path.join(root,'lib','process-owner')),children=[],servers=[];let checks=0;
function check(label,ok,detail){assert.ok(ok,label+(detail?' '+detail:''));checks++;console.log('PASS '+label);}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+8000;while(Date.now()<end){const v=await fn();if(v)return v;await pause(20);}throw Error(label);}
function remember(c){children.push(c);c.text='';c.err='';c.on('error',e=>c.failure=e);for(const k of ['stdout','stderr'])if(c[k])c[k].on('data',b=>{const p=k==='stdout'?'text':'err';c[p]=(c[p]+b).slice(-4000);});c.done=new Promise(r=>c.once('close',(code,signal)=>r({code,signal})));return c;}
function ping(port){return new Promise(r=>{const q=http.get({host:'127.0.0.1',port,timeout:200},s=>{s.resume();s.on('end',()=>r(true));});q.on('error',()=>r(false));q.on('timeout',()=>q.destroy());});}
const timeout=setTimeout(()=>{console.error('PROCESS/FAULTS deadline');for(const c of children)try{c.kill();}catch(e){}S.cleanup();process.exit(1);},60000);
(async()=>{try{
 if(!['all','states','cron'].includes(faultScope))throw Error('Unknown process-owner fault test scope: '+faultScope);
 if(process.platform!=='win32')throw Error('native fault suite requires Windows');
 if(faultScope!=='states'&&faultScope!=='cron'){
 const manifest=api.validateInstallation(root),exe=path.join(root,'native','process-owner.exe'),image=fs.readFileSync(exe);
 const pe=image.readUInt32LE(0x3c),optional=pe+24;
 const osMajor=image.readUInt16LE(optional+48),osMinor=image.readUInt16LE(optional+50);
 check('delivery helper is pinned PE32 AnyCPU with Windows subsystem baseline at most 6.1',manifest.protocol===2&&image.toString('ascii',pe,pe+4)==='PE\0\0'&&image.readUInt16LE(optional)===0x10b&&(osMajor<6||osMajor===6&&osMinor<=1));
 const config=fs.readFileSync(exe+'.config','utf8');
 check('shipped runtime config prefers CLR2 and permits already installed CLR4 without download',config.indexOf('v2.0.50727')>=0&&config.indexOf('v2.0.50727')<config.indexOf('v4.0'));
 let nativeCalls=0;
 const blockedRaw=Object.assign({},cp,{spawn(){nativeCalls++;throw Error('unexpected native spawn');}});
 for(const name of ['process-owner.exe','process-owner.cs','process-owner.exe.config','process-owner.manifest','process-owner.json']){
   const file=path.join(root,'native',name),original=fs.readFileSync(file);
   try{fs.appendFileSync(file,'MISMATCH');const owner=api.create(blockedRaw,root);let error;try{owner.spawn(S.NODE_BIN,[]);}catch(e){error=e;}
     check('corrupt '+name+' refuses before spawn and exposes unavailable diagnostic',!!error&&!owner.processOwnerInfo().materialReady&&nativeCalls===0);
   }finally{fs.writeFileSync(file,original);}
 }
 const manager=api.create(cp,root),marker=path.join(S.runDir,'must-not-run.txt');
 const immediate=remember(manager.spawn(S.NODE_BIN,['-e','require("fs").writeFileSync('+JSON.stringify(marker)+',"WRONG")'],{windowsHide:true}));immediate.kill();await immediate.done;
 check('stop before handshake never starts target or creates side effects',!fs.existsSync(marker)&&!immediate.ownedTree.bound);
 // A private native control owner deliberately rejects before START, then
 // disconnects after READY. Both must preserve the unresumed target boundary.
 for(const stage of ['hello','ready']){
   const pipe='\\\\.\\pipe\\7coder-fault-'+require('crypto').randomBytes(16).toString('hex'),token=require('crypto').randomBytes(24).toString('hex');
   let ready=false;
   const server=net.createServer(socket=>{let b='';socket.on('error',()=>{});socket.on('data',s=>{b+=s;let p;while((p=b.indexOf('\n'))>=0){const line=b.slice(0,p);b=b.slice(p+1);if(line.startsWith('HELLO2 ')){if(stage==='hello')socket.end('STOP\n');else socket.write('START\n');}else if(line.startsWith('READY ')){ready=true;socket.destroy();}}});});servers.push(server);await new Promise(r=>server.listen(pipe,r));
   const file=Buffer.from(S.NODE_BIN,'utf16le').toString('base64'),line=Buffer.from(api.quote(S.NODE_BIN)+' -e '+api.quote('require("fs").writeFileSync('+JSON.stringify(marker)+',"WRONG")'),'utf16le').toString('base64');
   const broker=remember(cp.spawn(exe,[pipe,token,file,line,'hidden'],{windowsHide:true}));const result=await broker.done;
   check('owner disconnect at '+stage+' cannot resume target',result.code!==0&&!fs.existsSync(marker)&&(stage!=='ready'||ready),broker.err);
   await new Promise(r=>server.close(r));servers.splice(servers.indexOf(server),1);
 }
 const fixture=path.join(S.runDir,'output-timeout-tree.js');
 fs.writeFileSync(fixture,`const cp=require('child_process'),fs=require('fs'),http=require('http');const file=process.argv[3];setTimeout(()=>process.exit(0),20000);if(process.argv[2]==='leaf'){http.createServer((q,s)=>s.end('owned')).listen(0,'127.0.0.1',function(){process.send({port:this.address().port});});}else{const c=cp.spawn(process.execPath,[__filename,'leaf',file],{detached:true,stdio:['ignore','ignore','ignore','ipc']});c.on('message',j=>{fs.writeFileSync(file,JSON.stringify(j));if(process.argv[2]==='output')process.stdout.write('x'.repeat(100000));});setInterval(()=>{},1000);}`);
 for(const mode of ['output','timeout']){
   const file=path.join(S.runDir,mode+'.json');let child;
   const result=await new Promise(resolve=>{child=manager.execFile(S.NODE_BIN,[fixture,mode,file],{windowsHide:true,timeout:mode==='timeout'?1800:10000,maxBuffer:mode==='output'?128:1024},(error,stdout,stderr)=>resolve({error,stdout,stderr}));remember(child);});
   const info=JSON.parse(fs.readFileSync(file,'utf8'));
   await until(async()=>!(await ping(info.port)),'fault path descendant retained');
   check(mode+' callback waits for entire owned tree and preserves explicit error',!!result.error&&child.ownedTree.closed&&child.ownedTree.stopped&&!await ping(info.port),result.stderr);
 }
 const missing=remember(manager.spawn(S.NODE_BIN,['-e','process.exit(0)'],{cwd:path.join(S.runDir,'absent-cwd'),windowsHide:true}));await missing.done;
 check('native spawn ENOENT releases owner admission without waiting for impossible close',!!missing.failure&&!missing.ownedTree.bound&&manager.processOwnerInfo().active===0&&manager.processOwnerInfo().pending===0);
 const source=fs.readFileSync(S.IDX,'utf8'),a=source.indexOf('const ownedChildStates ='),b=source.indexOf('async function stopBackgroundTask(',a);
 const ctx=vm.createContext({process,setTimeout,clearTimeout,recordRuntimeEvent(){},child_process:{execFile(){throw Error('PID tree kill forbidden for managed child');}}});vm.runInContext(source.slice(a,b),ctx);
 const unknown=new EventEmitter();unknown.pid=123;unknown.exitCode=1;unknown.ownedTree={closed:false};ctx.observeOwnedChild(unknown);unknown.emit('close',1);const result=await ctx.stopOwnedChild(unknown);
 check('already closed broker with unconfirmed job remains unknown rather than stopped',!result.closed&&!result.treeClosed);
 const confirmed=new EventEmitter();confirmed.pid=124;confirmed.exitCode=1;confirmed.ownedTree={closed:true};ctx.observeOwnedChild(confirmed);confirmed.emit('close',1);const known=await ctx.stopOwnedChild(confirmed);
 check('empty-job proof survives repeated stop without signalling any PID',known.closed&&known.treeClosed&&known.message.includes('empty'));
 // Admission can be proved with non-native owned fixtures; no 128-process
 // stress run is needed to verify a map-size guard.
 const fakeChildren=[],fake=api.create(Object.assign({},cp,{spawn(){const child=new EventEmitter();child.pid=50000+fakeChildren.length;child.exitCode=null;child.signalCode=null;child.kill=()=>true;fakeChildren.push(child);return child;}}),root);
 for(let i=0;i<128;i++)fake.spawn(S.NODE_BIN,[]);
 let refused=false;try{fake.spawn(S.NODE_BIN,[]);}catch(e){refused=/limit/.test(e.message);}
 check('shared 128-owner admission refuses before creating a 129th broker',refused&&fakeChildren.length===128&&fake.processOwnerInfo().active===128);
 for(const child of fakeChildren)child.emit('close',1);
 check('failed fake brokers release both pending and active slots exactly once',fake.processOwnerInfo().active===0&&fake.processOwnerInfo().pending===0);
 }
 // New state-combination cases only: a broker exit is not by itself a tool
 // success, nor permission to restart a repair/cron with unknown descendants.
 if(faultScope!=='cron'){
 for(const bound of [false,true]){
   const source=fs.readFileSync(S.IDX,'utf8'),a=source.indexOf('async function runDebugCycle('),b=source.indexOf('// AST-R2:',a);
   const context=vm.createContext({process,setTimeout,clearTimeout,launchDir:S.runDir,checkExecution(){},watchExecution(){return()=>{};},
     child_process:{spawn(){const child=new EventEmitter();child.pid=52001;child.exitCode=null;child.signalCode=null;child.ownedTree={bound,closed:false,error:'fixture failure'};
       process.nextTick(()=>{child.exitCode=0;child.emit('exit',0,null);child.emit('close',0,null);});return child;}}});
   vm.runInContext(source.slice(a,b),context);const result=await context.runDebugCycle('fixture.js','fixture.js','cli',1);
   check('debug '+(bound?'unconfirmed bound tree':'unstarted target')+' cannot enter automatic repair after broker close',bound?result.cleanupFailed:result.spawnFailed);
 }
 const callbackOwner=api.create(Object.assign({},cp,{execFile(file,args,opts,callback){const child=new EventEmitter();child.pid=52002;child.exitCode=null;child.signalCode=null;child.kill=()=>true;process.nextTick(()=>{child.exitCode=0;callback(null,'fake success','');child.emit('close',0,null);});return child;}}),root);
 const unconfirmed=await new Promise(resolve=>callbackOwner.execFile(S.NODE_BIN,[],{},error=>resolve(error)));
 check('unconfirmed zero broker exit cannot become successful command callback',unconfirmed&&unconfirmed.code==='EOWNERUNKNOWN'&&callbackOwner.processOwnerInfo().active===0);
 }
 const source=fs.readFileSync(S.IDX,'utf8'),from=source.indexOf('const ownedChildStates ='),to=source.indexOf('// ====================== DREAM HELPERS',from);
 const timers=[],context=vm.createContext({process,Buffer,Date,console,launchDir:S.runDir,shuttingDown:false,CRON_MAX_JOBS:32,cronJobs:new Map(),recordRuntimeEvent(){},withUtf8Codepage:s=>s,isSuperDangerous:()=>false,
   setTimeout(fn,ms){const timer={fn,ms,unref(){},cleared:false};timers.push(timer);return timer;},clearTimeout(timer){timer.cleared=true;},
   child_process:{exec(command,opts,callback){const child=new EventEmitter();child.pid=52003;child.exitCode=null;child.signalCode=null;child.ownedTree={bound:true,closed:false,error:'fixture failure'};context.child=child;return child;}}});
 vm.runInContext(source.slice(from,to),context);context.scheduleCronJob('unknown','1s','echo fixture');const job=context.cronJobs.get('unknown');job.nextRun=Date.now();timers[0].fn();context.child.emit('close',0);
 check('cron broker close without empty-job proof disables future automatic firing and preserves reason',job.stopped&&job.timer===null&&!job.running&&job.lastError.includes('unconfirmed')&&timers[timers.length-1].cleared);
 console.log('PROCESS/FAULTS '+checks+'/'+checks+'; scope='+faultScope+'; SKIP 0; ownership failure paths, not Win7/CLR installation acceptance');
}finally{clearTimeout(timeout);for(const c of children)if(c.exitCode==null&&c.signalCode==null)try{c.kill();}catch(e){}for(const server of servers)try{server.close();}catch(e){}S.cleanup();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
