// Actual Agent status/diff/commit/snapshot path with managed asynchronous Git.
// Private local repository/config/hooks only. No fixed-delay approval input.
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),http=require('http');
const {create}=require('./_endpoint');let H,model,checks=0,calls=0;const sockets=new Set(),saved={};
const scope=process.env.PROCESS_OWNER_GIT_SCOPE||'all';
function check(label,ok,detail){assert.ok(ok,label+(detail?' '+detail:''));checks++;console.log('PASS '+label);}
(async()=>{try{
 if(!['all','tail'].includes(scope))throw Error('Unknown process-owner Git test scope: '+scope);
 if(process.platform!=='win32')throw Error('process-owner-git requires Windows');
 model=http.createServer((req,res)=>{let b='';req.on('data',s=>b+=s);req.on('end',()=>{const body=JSON.parse(b);let message;
   if(!body.tools)message={role:'assistant',content:'private fixture summary'};
   else{const n=calls++,name=['git_status_tool','git_diff_tool','git_commit_tool'][n];message=name?{role:'assistant',content:null,tool_calls:[{id:'syncgit_'+n,type:'function',function:{name,arguments:JSON.stringify(n===2?{message:'fixture: managed async commit'}:{})}}]}:{role:'assistant',content:'MANAGED_GIT_DONE'};}
   if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:message}]})+'\n\ndata: [DONE]\n\n');}else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message}]}));}
 });});model.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(r=>model.listen(0,'127.0.0.1',r));
 H=create({suite:'process-owner-git',endpoint:'http://127.0.0.1:'+model.address().port,key:'',model:'fixture',permissionMode:'bypass'});const S=H.S,cwd=S.freshCwd('managed Git 中文'),config=path.join(S.runDir,'empty.gitconfig');fs.writeFileSync(config,'');
 for(const key of Object.keys(process.env))if(/^GIT_/i.test(key)){saved[key]=process.env[key];delete process.env[key];}
 process.env.GIT_CONFIG_NOSYSTEM='1';process.env.GIT_CONFIG_GLOBAL=config;
 const git=args=>cp.execFileSync('git',args,{cwd,env:process.env,encoding:'utf8',windowsHide:true,timeout:10000});
 git(['init','--quiet']);git(['config','user.name','fixture']);git(['config','user.email','fixture@invalid']);const hooks=path.join(S.runDir,'empty-hooks');fs.mkdirSync(hooks);git(['config','core.hooksPath',hooks]);
 fs.writeFileSync(path.join(cwd,'tracked.txt'),'v1\n');git(['add','tracked.txt']);git(['commit','--quiet','-m','base']);fs.writeFileSync(path.join(cwd,'tracked.txt'),'v2\n');fs.writeFileSync(path.join(cwd,'new.txt'),'new\n');
 await H.start(cwd);const r=await H.chat([{role:'user',content:'perform private Git fixture'}],60000),results=r.tools.filter(t=>t.type==='result');
 if(scope!=='tail'){
 check('strict model transcript has exactly three expected Git results and one final reply',calls===4&&r.content==='MANAGED_GIT_DONE'&&results.length===3&&results.every(t=>t.status==='completed'),JSON.stringify(results));
 check('managed status preserves tracked modification and branch information',results[0].name==='git_status_tool'&&String(results[0].result).includes('[GIT] branch')&&String(results[0].result).includes(' M tracked.txt'));
 check('managed diff preserves the actual before/after file lines',results[1].name==='git_diff_tool'&&String(results[1].result).includes('-v1')&&String(results[1].result).includes('+v2'));
 check('managed commit reports success only after actual local commit exists',results[2].name==='git_commit_tool'&&String(results[2].result).includes('[OK] committed')&&git(['log','-1','--format=%s']).trim()==='fixture: managed async commit');
 }
 const refs=git(['for-each-ref','--format=%(refname)','refs/7coder/snapshots']).trim().split(/\r?\n/).filter(Boolean);
 check('precommit recovery snapshot survives owned asynchronous Git with exact owned namespace/content',refs.length===1&&/^refs\/7coder\/snapshots\/v1\/[a-f0-9]{16}\/\d{16}-[a-f0-9]{16}-[a-f0-9]{12}$/.test(refs[0])&&git(['show',refs[0]+':tracked.txt'])==='v2\n'&&String(results[2].result).includes('snapshot'),JSON.stringify(refs));
 check('committed blobs contain the intended text and preserve private Git identity',git(['show','HEAD:tracked.txt'])==='v2\n'&&git(['show','HEAD:new.txt'])==='new\n'&&git(['config','--local','user.email']).trim()==='fixture@invalid');
 const audit=fs.readFileSync(path.join(cwd,'.7coder','audit.jsonl'),'utf8').trim().split(/\r?\n/).map(s=>JSON.parse(s));
 check('all three actual tool audit records preserve explicit callId and ok status',[0,1,2].every(n=>audit.some(e=>e.type==='tool'&&e.callId==='syncgit_'+n&&e.status==='ok')));
 const info=JSON.parse((await H.api('/api/info')).body);check('Agent remains responsive with no retained owners or active operations',info.processOwner.controlReady&&info.processOwner.active===0&&info.processOwner.pending===0&&info.runtime.activeTasks===0&&info.runtime.activeTools===0);
 console.log('PROCESS/GIT '+checks+'/'+checks+'; scope='+scope+'; SKIP 0; real local Git, private model fixture/config/hooks');
}finally{if(H){await H.stop();H.S.cleanup();}for(const key of Object.keys(process.env))if(/^GIT_/i.test(key))delete process.env[key];Object.assign(process.env,saved);for(const socket of sockets)socket.destroy();if(model)await new Promise(r=>model.close(r));}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
