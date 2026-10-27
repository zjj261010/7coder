// Owned Agent + native process fixtures. The private Agent's desktop launch
// is redirected to Node; no SendKeys, user32, GDI or real desktop is invoked.
const assert=require('assert'),fs=require('fs'),path=require('path'),http=require('http'),cp=require('child_process'),vm=require('vm');
const {create}=require('./_endpoint'),{loadContext}=require('./download-commit');
let H,model,checks=0;const sockets=new Set(),leaves=[];
function check(label,ok,detail){assert.ok(ok,label+(detail?' '+detail:''));checks++;console.log('PASS '+label);}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=10000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await pause(30);}throw Error(label);}
function ping(port,route='/'){return new Promise(r=>{const q=http.get({host:'127.0.0.1',port,path:route,timeout:300},s=>{s.resume();s.on('end',()=>r(true));});q.on('error',()=>r(false));q.on('timeout',()=>q.destroy());});}
const timeout=setTimeout(()=>{console.error('DESKTOP/INTEGRATION deadline');if(H){H.stop().catch(()=>{});H.S.cleanup();}process.exit(1);},65000);
(async()=>{try{
 if(process.platform!=='win32')throw Error('native desktop lifecycle fixture requires Windows');
 model=http.createServer((req,res)=>{let data='';req.on('data',s=>data+=s);req.on('end',()=>{const body=JSON.parse(data),messages=body.messages||[],last=messages[messages.length-1]||{},user=messages.filter(m=>m.role==='user').slice(-1)[0],prompt=String(user&&user.content||'').split(/\r?\n/)[0];
   const tool=!!body.tools&&last.role!=='tool'&&/^(HOLD_INPUT|INPUT_OK|SCREEN_HOLD|SCREEN_OK)$/.test(prompt);
   const message=tool?{role:'assistant',content:null,tool_calls:[{id:'desktop_'+prompt,type:'function',function:{name:'computer_use',arguments:JSON.stringify(prompt.startsWith('SCREEN')?{action:'screenshot'}:{action:'type_text',text:'fixture only, never sent'})}}]}:{role:'assistant',content:last.role==='tool'?String(last.content):'fixture summary'};
   if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:message}]})+'\n\ndata: [DONE]\n\n');}else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message}]}));}
 });});model.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(r=>model.listen(0,'127.0.0.1',r));
 H=create({suite:'desktop-integration',endpoint:'http://127.0.0.1:'+model.address().port,key:'',model:'fixture',permissionMode:'bypass'});
 const S=H.S,cwd=S.freshCwd('desktop actual HTTP'),fixture=path.join(cwd,'desktop-fixture.js'),modeFile=path.join(cwd,'fixture-mode.json');
 const original=fs.readFileSync(S.IDX,'utf8');
 fs.writeFileSync(fixture,`
const fs=require('fs'),cp=require('child_process'),http=require('http');
if(process.argv[2]==='leaf'){setTimeout(()=>process.exit(0),25000);http.createServer((q,s)=>{s.end('fixture');if(q.url==='/stop')setTimeout(()=>process.exit(0),10);}).listen(0,'127.0.0.1',function(){process.send({port:this.address().port});});}
else{const spec=JSON.parse(process.argv[2]),mode=JSON.parse(fs.readFileSync(${JSON.stringify(modeFile)},'utf8'));let script=null,image=null,bom=false;
 if(spec.args.includes('-File')){script=spec.args[spec.args.indexOf('-File')+1];const b=fs.readFileSync(script);bom=b[0]===239&&b[1]===187&&b[2]===191;}
 else{const arg=spec.args[spec.args.indexOf('-Command')+1],m=/FromBase64String\\('([A-Za-z0-9+/=]+)'\\)/.exec(arg),code=Buffer.from(m[1],'base64').toString('utf16le'),p=/\\$bmp\\.Save\\('((?:[^']|'')*)'/.exec(code);image=p[1].replace(/''/g,"'");fs.writeFileSync(image,Buffer.from([137,80,78,71,13,10,26,10]));}
 if(mode.hold){const child=cp.spawn(process.execPath,[__filename,'leaf'],{detached:true,stdio:['ignore','ignore','ignore','ipc']});child.on('message',j=>fs.writeFileSync(mode.info,JSON.stringify({port:j.port,script,image,bom})));setTimeout(()=>process.exit(0),25000);setInterval(()=>{},1000);}else{console.log('DESKTOP_SIM_DONE');}}
`);
 const needle='const { r, aborted } = await awaitCommandCancellable(runCommandAsync(spec,\n        { timeout: 30000';
 const normalized=original.replace(/\r\n/g,'\n');assert.ok(normalized.indexOf(needle)>=0&&normalized.indexOf(needle)===normalized.lastIndexOf(needle),'one private desktop dispatch hook');
 fs.writeFileSync(S.IDX,normalized.replace(needle,'const { r, aborted } = await awaitCommandCancellable(runCommandAsync({file:process.execPath,args:['+JSON.stringify(fixture)+',JSON.stringify(spec)]},\n        { timeout: 30000'));
 fs.writeFileSync(path.join(cwd,'.env'),'ENABLE_COMPUTER_USE=true\nVISION_MODEL=\n');await H.start(cwd);
 for(const prompt of ['HOLD_INPUT','SCREEN_HOLD']){
   const file=path.join(cwd,prompt+'.json');fs.writeFileSync(modeFile,JSON.stringify({hold:true,info:file}));
   const pending=H.chat([{role:'user',content:prompt}],5000).then(value=>({value}),error=>({error}));
   const info=await until(()=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){}},'desktop fixture ready');leaves.push(info);
   check(prompt+' private native target sees only prepared script/captured image',info.script?info.bom&&fs.existsSync(info.script):fs.existsSync(info.image));
   const active=JSON.parse((await H.api('/api/info',null,1000)).body);
   check(prompt+' leaves HTTP health responsive while desktop command is pending',active.runtime.activeTools===1&&active.processOwner.active===1);
   const ended=await pending;check(prompt+' client deadline closes request instead of inventing completion',ended.error&&ended.error.message.includes('deadline'));
   await until(async()=>{const state=JSON.parse((await H.api('/api/info')).body);return state.runtime.activeTools===0&&state.runtime.activeTasks===0&&state.processOwner.active===0;},'desktop cancellation drain');
   await until(async()=>!(await ping(info.port)),'desktop descendant remained');
   check(prompt+' cancellation removes descendant port and cleans only temporary input',!(await ping(info.port))&&(info.script?!fs.existsSync(info.script):fs.existsSync(info.image)));
   const events=fs.readFileSync(path.join(cwd,'.7coder','audit.jsonl'),'utf8').trim().split(/\r?\n/).map(s=>JSON.parse(s));
   check(prompt+' actual audit records cancelled terminal tool identity',events.some(e=>e.type==='tool'&&e.callId==='desktop_'+prompt&&e.status==='cancelled'));
   fs.writeFileSync(modeFile,JSON.stringify({hold:false}));const next=await H.chat([{role:'user',content:prompt==='HOLD_INPUT'?'INPUT_OK':'SCREEN_OK'}],10000);
   check(prompt+' same Agent completes next controlled desktop request',next.tools.some(t=>t.type==='result'&&t.name==='computer_use'&&t.status==='completed')&&(next.content.includes('[OK]')||prompt==='SCREEN_HOLD'&&next.content.includes('Screenshot saved')));
 }
 await H.stop();
 // Original branch, actual safe PowerShell: replace the prepared script body
 // with Write-Error before dispatch. Unconditional replacement is the safety
 // gate; a failed hook cannot fall through to real desktop operations.
 const owner=require(path.join(path.dirname(S.IDX),'lib','process-owner')).create(cp,path.dirname(S.IDX));
 const c=loadContext(original,S.freshCwd('text only PS'),{},{process,child_process:owner,console:{log(){},warn(){}},VISION_MODEL:'',recordRuntimeEvent(){},makeToolResult:(status,text,data)=>({status,text,data})});
 function cut(a,b){const p=original.indexOf(a),q=original.indexOf(b,p);assert.ok(p>=0&&q>p,a);return original.slice(p,q);}
 vm.runInContext(cut('function powerShellExecutable()','// AST-09: async child-process runner')+cut('function runCommandAsync(','// ====================== PERSISTENT SHELL')+'async function tool(args){const name="computer_use",cancelled=null;\n'+cut("  if (name === 'computer_use') {","  if (name === 'workflow_tool') {")+'\n}',c);
 const realRunner=c.runCommandAsync;let prepared,script;
 c.runCommandAsync=(spec,opts)=>{assert.ok(spec.args.includes('-File'),'only owned script route');script=spec.args[spec.args.indexOf('-File')+1];prepared=fs.readFileSync(script,'utf8');assert.ok(prepared.startsWith("\ufeff$ErrorActionPreference = 'Stop';"),'strict script prefix');fs.writeFileSync(script,prepared.slice(0,prepared.indexOf('\n')+1)+"Write-Error 'EXPECTED_TEXT_ONLY_FAILURE'\nWrite-Output MUST_NOT_RUN\n",'utf8');return realRunner(spec,opts);};
 const result=await c.tool({action:'type_text',text:'NEVER_SENT'});
 check('actual text-only PowerShell failure cannot be masked by later done output',result.status==='error'&&result.text.includes('EXPECTED_TEXT_ONLY_FAILURE')&&prepared.includes('SendWait')&&!result.text.includes('[OK]'));
 check('actual failed PowerShell Job closes before owned script removal',!fs.existsSync(script)&&owner.processOwnerInfo().active===0);
 console.log('DESKTOP/INTEGRATION '+checks+'/'+checks+'; Node stand-ins + text-only PS; no real desktop actions');
}finally{clearTimeout(timeout);for(const leaf of leaves)await ping(leaf.port,'/stop');if(H){await H.stop();H.S.cleanup();}for(const socket of sockets)socket.destroy();if(model)await new Promise(r=>model.close(r));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
