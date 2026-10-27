// Real private Git fsmonitor/diff drivers deliberately wait. Verify responsive
// HTTP, active cancellation and native Job cleanup, plus deterministic budgets.
'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),http=require('http'),vm=require('vm');
const {create}=require('./_endpoint');let H,model,chat,pendingDriver=null;const sockets=new Set(),saved={};let checks=0;
const scope=process.env.GIT_READ_SCOPE||'all';assert.ok(['all','http'].includes(scope),'known git-read scope');const EXPECTED=scope==='http'?12:17;
process.once('exit',()=>{if(checks!==EXPECTED){console.error('GIT/READ incomplete '+checks+'/'+EXPECTED);process.exitCode=1;}});
function check(label,ok){assert.ok(ok,label);checks++;console.log('PASS '+label);}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+10000;while(Date.now()<end){const value=await fn();if(value)return value;await pause(20);}throw Error(label);}
function cut(source,a,b){const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start,a);return source.slice(start,end);}
function ping(port){return new Promise(resolve=>{const req=http.get({host:'127.0.0.1',port,timeout:200},res=>{res.resume();res.on('end',()=>resolve(true));});req.on('error',()=>resolve(false));req.on('timeout',()=>req.destroy());});}
async function units(S){
 const source=fs.readFileSync(S.IDX,'utf8'),calls=[];
 const c=vm.createContext({process,setTimeout,clearTimeout,setInterval,clearInterval,launchDir:S.runDir});
 vm.runInContext(cut(source,'function executionCancelledError(','function serializeModelRequest(')+cut(source,'function checkExecution(','function cancelActiveExecutions(')+cut(source,'async function awaitCommandCancellable(','// ====================== PERSISTENT SHELL')+cut(source,'// OPT-13: pilot tools carry authoritative status','// Central choke point')+cut(source,'function git(argsArr, opts)',"  if (name === 'git_status_tool') {")+'async function tool(name,args={},cancelled=null){\n'+cut(source,"  if (name === 'git_status_tool') {","  if (name === 'git_commit_tool') {")+'\n}',c);
 c.runCommandAsync=(spec,options)=>{calls.push({spec,options});return {promise:Promise.resolve({error:null,stdout:'COMPLETE',stderr:'',exitCode:0}),kill(){}};};
 const expired=c.createExecutionControl(5000);expired.cancel('already cancelled');await assert.rejects(c.gitRead(['status'],{},expired),e=>e.code==='EXECUTION_CANCELLED');expired.dispose();
 check('pre-cancelled Git read starts no process',calls.length===0);
 const args=['diff','--','literal & name'],text=await c.gitRead(args,{deadlineAt:Date.now()+1234},null),first=calls[0];
 check('read preserves argv/no-shell, one MiB output cap and remaining deadline',text==='COMPLETE'&&first.spec.file==='git'&&first.spec.args===args&&!first.options.shell&&first.options.maxBuffer===1024*1024&&first.options.timeout>0&&first.options.timeout<=1234&&!('deadlineAt'in first.options));
 let settle,kills=0;const token=c.createExecutionControl(5000);c.runCommandAsync=()=>({promise:new Promise(r=>{settle=r;}),kill(){kills++;}});
 const late=c.gitRead(['status'],{},token);token.cancel('late cancellation');settle({error:null,stdout:'LATE',stderr:'',exitCode:0});await assert.rejects(late,e=>e.code==='EXECUTION_CANCELLED');token.dispose();
 check('late successful callback cannot overwrite cancellation and stop is requested once',kills===1);
 c.runCommandAsync=()=>({promise:Promise.resolve({error:Object.assign(Error('fixture timeout'),{code:'ETIMEDOUT'}),stdout:'PARTIAL',stderr:'',exitCode:null}),kill(){}});
 const failed=await c.tool('git_diff_tool');check('partial Git failure cannot become no-changes or a successful diff',failed.status==='error'&&failed.text.includes('fixture timeout')&&!failed.text.includes('PARTIAL')&&!failed.text.includes('[GIT]'));
 let now=1000;const budgets=[];c.Date={now:()=>now};c.runCommandAsync=(spec,options)=>{budgets.push(options.timeout);now+=11000;return {promise:Promise.resolve({error:null,stdout:'fixture',stderr:'',exitCode:0}),kill(){}};};
 const exhausted=await c.tool('git_status_tool');check('four-command status shares one 30s budget and never starts expired final command',exhausted.status==='error'&&exhausted.text.includes('deadline exceeded')&&JSON.stringify(budgets)==='[30000,19000,8000]');
}
function begin(prompt){let response;const data=JSON.stringify({stream:true,messages:[{role:'user',content:prompt}]});const req=http.request({host:'127.0.0.1',port:H.port,path:'/v1/chat/completions',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},res=>{response=res;res.resume();res.on('error',()=>{});});req.on('error',()=>{});req.end(data);return {stop(){if(response)response.destroy();req.destroy();}};}
(async()=>{try{
 if(process.platform!=='win32')throw Error('real native Git cancellation suite requires Windows');
 const seen=[];model=http.createServer((req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{const body=JSON.parse(raw),prompt=body.messages.filter(m=>m.role==='user').pop().content;let message;
  if(!body.tools)message={role:'assistant',content:'fixture summary'};
  else if(body.messages[body.messages.length-1].role==='tool')message={role:'assistant',content:'RECOVERED'};
  else{seen.push(prompt);if(pendingDriver&&pendingDriver.prompt===prompt){pendingDriver.enable();pendingDriver=null;}const name=prompt.includes('diff')?'git_diff_tool':'git_status_tool';message={role:'assistant',content:null,tool_calls:[{id:'gitread_'+prompt,type:'function',function:{name,arguments:JSON.stringify(name==='git_diff_tool'?{path:'tracked.txt'}:{})}}]};}
  res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:message}]})+'\n\ndata: [DONE]\n\n');
 });});model.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>model.listen(0,'127.0.0.1',r));
 H=create({suite:'git-read-cancellation',endpoint:'http://127.0.0.1:'+model.address().port,key:'',model:'fixture',permissionMode:'bypass'});const S=H.S;
 if(scope==='all')await units(S);
 const cwd=S.freshCwd('Git read 中文'),config=path.join(S.runDir,'empty.gitconfig');fs.writeFileSync(config,'');
 for(const key of Object.keys(process.env))if(/^GIT_/i.test(key)){saved[key]=process.env[key];delete process.env[key];}process.env.GIT_CONFIG_NOSYSTEM='1';process.env.GIT_CONFIG_GLOBAL=config;
 const git=args=>cp.execFileSync('git',args,{cwd,env:process.env,windowsHide:true,encoding:'utf8',timeout:10000});
 git(['init','--quiet']);git(['config','user.name','fixture']);git(['config','user.email','fixture@invalid']);const hooks=path.join(S.runDir,'empty-hooks');fs.mkdirSync(hooks);git(['config','core.hooksPath',hooks]);
 fs.writeFileSync(path.join(cwd,'tracked.txt'),'v1\n');git(['add','tracked.txt']);git(['commit','--quiet','-m','base']);fs.writeFileSync(path.join(cwd,'tracked.txt'),'v2\n');
 await H.start(cwd);
 for(const mode of ['status','diff']){
  const infoFile=path.join(S.runDir,mode+'.json'),heart=path.join(S.runDir,mode+'.heart'),driver=path.join(S.runDir,'hold-'+mode+'.js');fs.writeFileSync(heart,'');
  fs.writeFileSync(driver,'const fs=require("fs"),http=require("http");setTimeout(()=>process.exit(0),20000);http.createServer((q,s)=>s.end("held")).listen(0,"127.0.0.1",function(){fs.writeFileSync('+JSON.stringify(infoFile)+',JSON.stringify({port:this.address().port}));});setInterval(()=>fs.appendFileSync('+JSON.stringify(heart)+',"x"),25);');
  const command='"'+S.NODE_BIN.replace(/\\/g,'/')+'" "'+driver.replace(/\\/g,'/')+'"',key=mode==='status'?'core.fsmonitor':'diff.external';
  // The request's pre-model task checkpoint still uses synchronous Git.
  // Activate this driver only when its first model response dispatches the
  // read tool, so this test proves that tool's wait rather than hiding phase.
  const prompt='hold-'+mode;pendingDriver={prompt,enable(){git(['config',key,command]);}};
  chat=begin(prompt);const info=await until(()=>{try{return JSON.parse(fs.readFileSync(infoFile,'utf8'));}catch(e){return null;}},mode+' driver did not start');
  check(mode+': actual private Git driver is alive while tool waits',seen.includes(prompt)&&await ping(info.port));
  const status=JSON.parse((await H.api('/api/info',null,800)).body);check(mode+': Agent HTTP stays responsive during managed Git wait',status.processOwner.active===1&&status.runtime.activeTools>0);
  chat.stop();chat=null;await until(async()=>{const j=JSON.parse((await H.api('/api/info',null,800)).body);return j.runtime.activeTasks===0&&j.runtime.activeTools===0&&j.processOwner.active===0;},mode+' cancellation did not settle');
  check(mode+': disconnect waits for command settlement and releases owner/tool slots',true);
  await until(async()=>!await ping(info.port),mode+' driver retained');const size=fs.statSync(heart).size;await pause(180);check(mode+': cancellation removes driver listener and heartbeat',fs.statSync(heart).size===size);
  const audit=fs.readFileSync(path.join(cwd,'.7coder','audit.jsonl'),'utf8').trim().split(/\r?\n/).map(x=>JSON.parse(x));check(mode+': exact tool audit is cancelled with no automatic model replay',audit.some(e=>e.callId==='gitread_'+prompt&&e.status==='cancelled')&&seen.filter(x=>x===prompt).length===1);
  git(['config','--unset',key]);const recovery=await H.chat([{role:'user',content:'recover-'+mode}],10000);check(mode+': same Agent completes next normal Git read',recovery.content==='RECOVERED'&&recovery.tools.some(t=>t.type==='result'&&t.status==='completed'&&String(t.result).includes(mode==='diff'?'+v2':' M tracked.txt')));
 }
 console.log('GIT/READ '+checks+'/'+EXPECTED+'; scope='+scope+'; native Git/private hooks only; not Win7 certification');
}finally{if(chat)chat.stop();if(H){await H.stop();H.S.cleanup();}for(const key of Object.keys(process.env))if(/^GIT_/i.test(key))delete process.env[key];Object.assign(process.env,saved);for(const socket of sockets)socket.destroy();if(model)await new Promise(r=>model.close(r));}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
