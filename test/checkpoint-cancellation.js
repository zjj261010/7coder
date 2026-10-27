// Request-start Git checkpoints: real fsmonitor waits before the first model
// call, HTTP/CLI cancellation, and shared snapshot command-plan boundaries.
'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process'),http=require('http'),vm=require('vm');
const {create}=require('./_endpoint');let H,model,chat,app;const sockets=new Set(),saved={};let checks=0;
const scope=process.env.CHECKPOINT_SCOPE||'all';assert.ok(['all','http','cli'].includes(scope),'known checkpoint scope');const EXPECTED={all:19,http:10,cli:3}[scope];
process.once('exit',()=>{if(checks!==EXPECTED){console.error('CHECKPOINT incomplete '+checks+'/'+EXPECTED);process.exitCode=1;}});
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);},pause=ms=>new Promise(r=>setTimeout(r,ms));
async function within(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),10000);})]);}finally{clearTimeout(timer);}}
async function until(fn,label){const end=Date.now()+10000;while(Date.now()<end){const result=await fn();if(result)return result;await pause(20);}throw Error(label);}
function cut(source,a,b){const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start,a);return source.slice(start,end);}
function ping(port){return new Promise(resolve=>{const req=http.get({host:'127.0.0.1',port,timeout:200},res=>{res.resume();res.on('end',()=>resolve(true));});req.on('error',()=>resolve(false));req.on('timeout',()=>req.destroy());});}
async function units(S){
 const source=fs.readFileSync(S.IDX,'utf8'),warnings=[],cwd=S.freshCwd('unit');
 const c=vm.createContext({fs,path,crypto,process,setTimeout,clearTimeout,setInterval,clearInterval,launchDir:cwd,console:{log(){},warn:t=>warnings.push(t)}});
 vm.runInContext(cut(source,'function executionCancelledError(','function serializeModelRequest(')+cut(source,'function checkExecution(','function cancelActiveExecutions(')+cut(source,'async function awaitCommandCancellable(','// ====================== PERSISTENT SHELL')+cut(source,'function ownedGitSnapshotPolicy(','// GAP-8: end-of-session token usage'),c);
 const sha='1'.repeat(40),policy=c.ownedGitSnapshotPolicy('task'),rows=Array.from({length:50},(_,i)=>[policy.prefix+String(i).padStart(16,'0')+'-'+i.toString(16).padStart(16,'0')+'-'+sha.slice(0,12),sha,'commit','','On main: '+policy.marker].join('\0')).join('\n');
 function driver(log,hook){return async(args,opts)=>{log.push({args:Array.from(args),opts});if(hook)await hook(args);return args[0]==='stash'?sha:args[0]==='for-each-ref'?rows:'';};}
 const calls=[];const result=await c.recordOwnedGitSnapshotAsync(driver(calls),'task',null);
 check('async snapshot uses the shared ownership/CAS plan and prunes only old owned ref',result===sha&&calls.length===4&&calls[2].args.includes('--no-deref')&&calls[2].args[calls[2].args.length-1]==='0'.repeat(40)&&calls[3].args.includes('-d')&&calls[3].args[calls[3].args.length-1]===sha);
 const token=c.createExecutionControl(5000),late=[];await assert.rejects(c.recordOwnedGitSnapshotAsync(driver(late,args=>{if(args[0]==='update-ref'&&!args.includes('-d'))token.cancel('after publication');}),'task',token),e=>e.code==='EXECUTION_CANCELLED');token.dispose();
 check('cancellation after publication keeps the created ref and starts no pruning',late.length===3&&!late.some(v=>v.args.includes('-d')));
 const unknown=[];await assert.rejects(c.recordOwnedGitSnapshotAsync(driver(unknown,args=>{if(args.includes('-d'))throw Object.assign(Error('unknown cleanup'),{code:'EOWNERUNKNOWN'});}),'task',null),e=>e.code==='EOWNERUNKNOWN');
 check('unknown cleanup during retention propagates instead of becoming best-effort success',unknown.length===4&&!warnings.length);
 let nativeCalls=0;c.runCommandAsync=()=>{nativeCalls++;return {ownedTree:{bound:true,closed:false},promise:Promise.resolve({error:Object.assign(Error('native failure'),{code:125}),stdout:'',stderr:'',exitCode:125}),kill(){}};};
 await assert.rejects(c.createTaskGitCheckpoint(),e=>e.code==='EOWNERUNKNOWN');check('checkpoint refuses the model-start boundary after unconfirmed bound tree cleanup',nativeCalls===1&&!warnings.length);
 c.runCommandAsync=()=>({ownedTree:{bound:true,closed:true},promise:Promise.resolve({error:Object.assign(Error('not repo'),{code:128}),stdout:'',stderr:'fatal: not a git repository',exitCode:128}),kill(){}});
 check('ordinary non-repository remains silent and returns no snapshot',await c.createTaskGitCheckpoint()===''&&!warnings.length);
 const expired=c.createExecutionControl(5000);expired.cancel('before checkpoint');nativeCalls=0;c.runCommandAsync=()=>{nativeCalls++;throw Error('unexpected process');};await assert.rejects(c.createTaskGitCheckpoint(expired),e=>e.code==='EXECUTION_CANCELLED');expired.dispose();check('already cancelled checkpoint starts no Git process',nativeCalls===0);
}
function begin(stream,prompt){let response;const data=JSON.stringify({stream,messages:[{role:'user',content:prompt}]});const req=http.request({host:'127.0.0.1',port:H.port,path:'/v1/chat/completions',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},res=>{response=res;res.resume();res.on('error',()=>{});});req.on('error',()=>{});req.end(data);return {stop(){if(response)response.destroy();req.destroy();}};}
(async()=>{try{
 if(process.platform!=='win32')throw Error('native checkpoint cancellation requires Windows');
 let modelCalls=0;model=http.createServer((req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{const body=JSON.parse(raw);if(body.tools)modelCalls++;const message={role:'assistant',content:'RECOVERED'};if(body.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:message}]})+'\n\ndata: [DONE]\n\n');}else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}]}));}});});model.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>model.listen(0,'127.0.0.1',r));
 const endpoint='http://127.0.0.1:'+model.address().port;H=create({suite:'checkpoint-cancellation',endpoint,key:'',model:'fixture',permissionMode:'bypass'});const S=H.S;
 if(scope==='all')await units(S);
 const cwd=S.freshCwd('checkpoint 中文'),config=path.join(S.runDir,'empty.gitconfig');fs.writeFileSync(config,'');
 for(const key of Object.keys(process.env))if(/^GIT_/i.test(key)){saved[key]=process.env[key];delete process.env[key];}process.env.GIT_CONFIG_NOSYSTEM='1';process.env.GIT_CONFIG_GLOBAL=config;
 const git=args=>cp.execFileSync('git',args,{cwd,env:process.env,windowsHide:true,encoding:'utf8',timeout:10000});git(['init','--quiet']);git(['config','user.name','fixture']);git(['config','user.email','fixture@invalid']);git(['config','core.autocrlf','false']);const hooks=path.join(S.runDir,'hooks');fs.mkdirSync(hooks);git(['config','core.hooksPath',hooks]);
 fs.writeFileSync(path.join(cwd,'tracked.txt'),'base\n');git(['add','tracked.txt']);git(['commit','--quiet','-m','base']);fs.writeFileSync(path.join(cwd,'tracked.txt'),'staged\n');git(['add','tracked.txt']);fs.writeFileSync(path.join(cwd,'tracked.txt'),'working\n');const head=git(['rev-parse','HEAD']).trim();
 function hold(name){const info=path.join(S.runDir,name+'.json'),heart=path.join(S.runDir,name+'.heart'),driver=path.join(S.runDir,name+'.js');fs.writeFileSync(heart,'');fs.writeFileSync(driver,'const fs=require("fs"),http=require("http");setTimeout(()=>process.exit(0),20000);http.createServer((q,s)=>s.end("checkpoint-held")).listen(0,"127.0.0.1",function(){fs.writeFileSync('+JSON.stringify(info)+',JSON.stringify({port:this.address().port}));});setInterval(()=>fs.appendFileSync('+JSON.stringify(heart)+',"x"),25);');git(['config','core.fsmonitor','"'+S.NODE_BIN.replace(/\\/g,'/')+'" "'+driver.replace(/\\/g,'/')+'"']);return {info,heart};}
 const refs=()=>git(['for-each-ref','--format=%(refname)%00%(objectname)','refs/7coder/task-snapshots']);
 if(scope!=='cli'){
  await H.start(cwd);
  for(const stream of [true,false]){
   const label=stream?'stream':'json',f=hold('hold-'+label),before=refs(),started=modelCalls;chat=begin(stream,'checkpoint-'+label);const info=await until(()=>{try{return JSON.parse(fs.readFileSync(f.info,'utf8'));}catch(e){return null;}},'checkpoint driver not started');
   check(label+': actual checkpoint driver waits before any model request',modelCalls===started&&await ping(info.port));
   const status=JSON.parse((await H.api('/api/info',null,800)).body);check(label+': HTTP remains responsive during pre-model Git wait',status.processOwner.active===1&&status.runtime.activeTasks>0&&status.runtime.activeTools===0);
   chat.stop();chat=null;await until(async()=>{const j=JSON.parse((await H.api('/api/info',null,800)).body);return j.runtime.activeTasks===0&&j.processOwner.active===0;},'checkpoint cancellation did not settle');await until(async()=>!await ping(info.port),'checkpoint driver retained');const size=fs.statSync(f.heart).size;await pause(180);
   check(label+': disconnect retires checkpoint process and driver resources',fs.statSync(f.heart).size===size);
   check(label+': cancelled checkpoint starts no model and publishes no new ref',modelCalls===started&&refs()===before);
   git(['config','--unset','core.fsmonitor']);const r=await H.chat([{role:'user',content:'recover-'+label}],10000),ref=refs().trim().split(/\r?\n/).pop().split('\0')[0];
   check(label+': next request preserves real working/index snapshot and repository state',r.content==='RECOVERED'&&git(['show',ref+':tracked.txt'])==='working\n'&&git(['show',ref+'^2:tracked.txt'])==='staged\n'&&git(['show',':tracked.txt'])==='staged\n'&&git(['rev-parse','HEAD']).trim()===head&&fs.readFileSync(path.join(cwd,'tracked.txt'),'utf8')==='working\n');
  }
  await H.stop();
 }
 if(scope!=='http'){
  const f=hold('hold-cli'),started=modelCalls;let output='';app=S.spawn(S.NODE_BIN,[S.IDX,'--prompt','cli-checkpoint'],{cwd,env:Object.assign({},process.env,{OPENAI_ENDPOINT:endpoint,OPENAI_API_KEY:'fixture',HEAVY_MODEL:'fixture',LIGHT_MODEL:'fixture',SUMMARY_MODEL:'fixture',DREAM_ALLOW:'false',ENABLE_HTTP_SERVER:'false',PERMISSION_MODE:'bypass',EXECUTION_TIMEOUT_MS:'1500'})});const current=app,closed=new Promise(r=>current.once('close',r));for(const stream of [current.stdout,current.stderr])stream.on('data',b=>output+=b);
  const info=await until(()=>{try{return JSON.parse(fs.readFileSync(f.info,'utf8'));}catch(e){return null;}},'CLI checkpoint driver not started');check('CLI: prompt checkpoint waits before first model request',modelCalls===started&&await ping(info.port));
  await within(closed,'CLI deadline did not settle');app=null;await until(async()=>!await ping(info.port),'CLI driver retained');
  check('CLI: deadline cancels checkpoint and never enters the model loop',modelCalls===started&&output.includes('Execution deadline exceeded'));
  git(['config','--unset','core.fsmonitor']);let recovered='';app=S.spawn(S.NODE_BIN,[S.IDX,'--prompt','cli-recover'],{cwd,env:Object.assign({},process.env,{OPENAI_ENDPOINT:endpoint,OPENAI_API_KEY:'fixture',HEAVY_MODEL:'fixture',LIGHT_MODEL:'fixture',SUMMARY_MODEL:'fixture',DREAM_ALLOW:'false',ENABLE_HTTP_SERVER:'false',PERMISSION_MODE:'bypass'})});for(const stream of [app.stdout,app.stderr])stream.on('data',b=>recovered+=b);const fresh=app;await within(new Promise(r=>fresh.once('close',r)),'CLI recovery did not settle');app=null;
  check('CLI: fresh start creates a checkpoint and reaches the model normally',modelCalls===started+1&&recovered.includes('[CHECKPOINT]')&&recovered.includes('RECOVERED'));
 }
 console.log('CHECKPOINT '+checks+'/'+EXPECTED+'; scope='+scope+'; real Git/private hooks and model fixture; not Win7 certification');
}finally{if(chat)chat.stop();if(app&&app.exitCode===null&&app.signalCode===null){const closed=new Promise(r=>app.once('close',r));app.kill();await closed;}if(H){await H.stop();H.S.cleanup();}for(const key of Object.keys(process.env))if(/^GIT_/i.test(key))delete process.env[key];Object.assign(process.env,saved);for(const socket of sockets)socket.destroy();if(model)await new Promise(r=>model.close(r));}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
