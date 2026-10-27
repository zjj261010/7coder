// Native synchronous runner + independent control worker. No real project
// Git, desktop, external model, or unverified process PID signals.
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),http=require('http');
const S=require('./_shared').create({suite:'process-owner-sync'}),root=path.dirname(S.IDX),api=require(path.join(root,'lib','process-owner'));
const manager=api.create(cp,root),children=[],leaves=[];let checks=0;
function check(label,ok,detail){assert.ok(ok,label+(detail?' '+detail:''));checks++;console.log('PASS '+label);}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=8000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await pause(20);}throw Error(label);}
function ping(port,route='/'){return new Promise(r=>{const q=http.get({host:'127.0.0.1',port,path:route,timeout:200},s=>{s.resume();s.on('end',()=>r(true));});q.on('error',()=>r(false));q.on('timeout',()=>q.destroy());});}
const timeout=setTimeout(()=>{console.error('PROCESS/SYNC deadline');for(const c of children)try{c.kill();}catch(e){}S.cleanup();process.exit(1);},65000);
(async()=>{try{
 if(process.platform!=='win32')throw Error('process-owner-sync requires Windows');
 const cwd=S.freshCwd('sync 中文 空格'),script=path.join(cwd,'argv.js');
 fs.writeFileSync(script,'const fs=require("fs");console.log(JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,"utf8"),cwd:process.cwd(),env:process.env.OWNED_SYNC}));');
 const result=JSON.parse(manager.execFileSync(S.NODE_BIN,[script,'','中文😀','a"b','trail\\','a & b'],{cwd,input:'输入😀',encoding:'utf8',timeout:5000,env:Object.assign({},process.env,{PATH:'',OWNED_SYNC:'值'})}));
 check('synchronous argv/stdin/Unicode/cwd/environment survive native ownership',JSON.stringify(result.args)===JSON.stringify(['','中文😀','a"b','trail\\','a & b'])&&result.input==='输入😀'&&result.cwd===cwd&&result.env==='值');
 const buffered=manager.spawnSync(S.NODE_BIN,['-e','process.stdout.write("OUT");process.stderr.write("ERR中文");process.exit(7)'],{cwd,timeout:5000});
 check('spawnSync returns original buffers/status/output and empty-target-group proof',buffered.status===7&&!buffered.error&&Buffer.isBuffer(buffered.stdout)&&buffered.stdout.toString()==='OUT'&&buffered.stderr.toString()==='ERR中文'&&buffered.output[1].equals(buffered.stdout)&&buffered.ownedTree.closed&&buffered.ownedTree.exitCode===7);
 let nonzero;try{manager.execFileSync(S.NODE_BIN,['-e','process.stderr.write("EXIT_SEVEN");process.exit(7)'],{cwd,encoding:'utf8',timeout:5000});}catch(error){nonzero=error;}
 check('execFileSync throws original numeric status and stderr on target failure',nonzero&&nonzero.status===7&&nonzero.stderr==='EXIT_SEVEN'&&nonzero.ownedTree.closed);
 check('execSync preserves cmd behavior through a confirmed owned root',manager.execSync('echo SYNC_CMD_OWNED',{cwd,encoding:'utf8',timeout:5000}).includes('SYNC_CMD_OWNED'));
 const child=manager.spawn(S.NODE_BIN,['-e','setTimeout(()=>console.log("ASYNC_FINISHED"),100)'],{cwd,windowsHide:true});children.push(child);let output='';child.stdout.on('data',s=>output+=s);child.stderr.resume();const done=new Promise(r=>child.once('close',r));
 const held=manager.execFileSync(S.NODE_BIN,['-e','setTimeout(()=>console.log("SYNC_FINISHED"),3300)'],{cwd,encoding:'utf8',timeout:6000});
 check('control worker admits/ACKs asynchronous root while main thread is blocked beyond ACK deadline',held.includes('SYNC_FINISHED')&&child.ownedTree.closed&&!child.ownedTree.error);
 await done;check('asynchronous stdio closes normally after blocked main thread resumes',output.includes('ASYNC_FINISHED')&&child.exitCode===0);
 const fixture=path.join(cwd,'tree.js');fs.writeFileSync(fixture,`
const fs=require('fs'),cp=require('child_process'),http=require('http');const mode=process.argv[2],file=process.argv[3];setTimeout(()=>process.exit(0),20000);
if(mode==='leaf'){http.createServer((q,s)=>{s.end('owned');if(q.url==='/stop')setTimeout(()=>process.exit(0),10);}).listen(0,'127.0.0.1',function(){process.send({port:this.address().port});});}
else{const c=cp.spawn(process.execPath,[__filename,'leaf',file],{detached:true,stdio:['ignore','ignore','ignore','ipc']});c.on('message',j=>{fs.writeFileSync(file,JSON.stringify(j));if(mode==='natural')process.exit(7);if(mode==='output')process.stdout.write('x'.repeat(200000));});setInterval(()=>{},1000);}`);
 for(const mode of ['natural','timeout','output']){
   const file=path.join(cwd,mode+'.json'),r=manager.spawnSync(S.NODE_BIN,[fixture,mode,file],{cwd,timeout:mode==='timeout'?2000:5000,maxBuffer:mode==='output'?128:1024});
   const info=JSON.parse(fs.readFileSync(file,'utf8'));leaves.push(info);await until(async()=>!(await ping(info.port)),'sync descendant retained');
   check(mode+' synchronous exit removes detached leaf listener',!(await ping(info.port)));
   if(mode==='natural')check('natural sync root preserves exit seven with confirmed empty group',r.status===7&&!r.error&&r.ownedTree.closed);
   else check(mode+' sync failure preserves original error and does not invent cleanup proof',r.error&&r.error.code===(mode==='timeout'?'ETIMEDOUT':'ENOBUFS')&&!r.ownedTree.closed,JSON.stringify({status:r.status,error:r.error&&r.error.code,tree:r.ownedTree}));
 }
 const gitEnv=Object.assign({},process.env),gitConfig=path.join(S.runDir,'empty.gitconfig');fs.writeFileSync(gitConfig,'');for(const key of Object.keys(gitEnv))if(/^GIT_/i.test(key))delete gitEnv[key];gitEnv.GIT_CONFIG_NOSYSTEM='1';gitEnv.GIT_CONFIG_GLOBAL=gitConfig;
 const repo=S.freshCwd('owned git');manager.execFileSync('git',['init','--quiet'],{cwd:repo,timeout:5000,env:gitEnv});fs.writeFileSync(path.join(repo,'untracked.txt'),'私有fixture');
 check('real Git inside private repository returns unchanged porcelain text',manager.execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8',timeout:5000,env:gitEnv}).trim()==='?? untracked.txt');
 let notRepo;try{manager.execFileSync('git',['status','--porcelain'],{cwd,encoding:'utf8',timeout:5000,env:gitEnv});}catch(error){notRepo=error;}
 check('Git non-repository remains detectable by numeric status and actual stderr',notRepo&&notRepo.status===128&&/not a git repository/i.test(notRepo.stderr));
 const parent=path.join(cwd,'sync-parent.js'),infoFile=path.join(cwd,'parent.json');fs.writeFileSync(parent,'const owner=require('+JSON.stringify(path.join(root,'lib','process-owner'))+').create(require("child_process"),'+JSON.stringify(root)+');owner.execFileSync(process.execPath,['+JSON.stringify(fixture)+',"hold",'+JSON.stringify(infoFile)+'],{timeout:15000,windowsHide:true});');
 const agent=S.spawn(S.NODE_BIN,[parent],{cwd,stdio:'ignore',windowsHide:true});children.push(agent);const info=await until(()=>{try{return JSON.parse(fs.readFileSync(infoFile,'utf8'));}catch(e){}},'sync parent ready');leaves.push(info);
 const closed=new Promise(r=>agent.once('close',r));agent.kill('SIGKILL');await closed;await until(async()=>!(await ping(info.port)),'forced sync owner descendant retained');
 check('forced owner exit during native spawnSync cleans the real detached descendant',!(await ping(info.port)));
 check('same manager can launch again after sync timeout/overflow and external owner death',manager.execFileSync(S.NODE_BIN,['-e','process.stdout.write("RECOVERED")'],{encoding:'utf8',timeout:5000})==='RECOVERED'&&manager.processOwnerInfo().controlReady&&manager.processOwnerInfo().active===0);
 const controlFile=path.join(root,'lib','process-owner-control.js'),original=fs.readFileSync(controlFile);let calls=0,startError;
 try{fs.writeFileSync(controlFile,'this is intentionally invalid JavaScript !');const bad=api.create(Object.assign({},cp,{spawnSync(){calls++;throw Error('unexpected target');}}),root);
   try{bad.execFileSync(S.NODE_BIN,[],{timeout:1000});}catch(error){startError=error;}
   check('broken control worker fails before synchronous process creation and exposes unavailable state',startError&&calls===0&&!bad.processOwnerInfo().controlReady&&bad.processOwnerInfo().error);
 }finally{fs.writeFileSync(controlFile,original);}
 console.log('PROCESS/SYNC '+checks+'/'+checks+'; SKIP 0; Node13 modern Windows; sync calls still block Agent JS');
}finally{clearTimeout(timeout);for(const child of children)if(child.exitCode==null&&child.signalCode==null)try{child.kill();}catch(e){}for(const leaf of leaves)await ping(leaf.port,'/stop');S.cleanup();}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
