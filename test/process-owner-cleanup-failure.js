// Opt-in native fault injection in an isolated copy. No production test hook.
'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),http=require('http'),crypto=require('crypto');
if(process.platform!=='win32'||!process.argv.includes('--run')){console.error('Windows diagnostic: add --run; requires .NET 3.5 compiler.');process.exit(2);}
const S=require('./_shared').create({suite:'owner-cleanup-failure'}),root=path.dirname(S.IDX),folder=path.join(root,'native');
const api=require(path.join(root,'lib','process-owner')),before=api.validateInstallation(path.resolve(__dirname,'..'));
let checks=0,child,closed;const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==6){console.error('CLEANUP/FAILURE incomplete '+checks+'/6');process.exitCode=1;}});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+10000;while(Date.now()<end){const value=await fn();if(value)return value;await pause(20);}throw Error('cleanup failure phase deadline');}
function ping(port){return new Promise(resolve=>{const req=http.get({host:'127.0.0.1',port,timeout:200},res=>{res.resume();res.once('end',()=>resolve(true));});req.on('error',()=>resolve(false));req.on('timeout',()=>req.destroy());});}
(async()=>{try{
 const source=path.join(folder,'process-owner.cs'),original=fs.readFileSync(source,'utf8'),anchor='EmptyTargets(job);';
 assert.ok(original.indexOf(anchor)>=0&&original.indexOf(anchor)===original.lastIndexOf(anchor),'one cleanup fault anchor');
 fs.writeFileSync(source,original.replace(anchor,'throw new InvalidOperationException("fixture-cleanup-query-failure");'));
 const fw=path.join(process.env.SystemRoot,'Microsoft.NET','Framework'),exe=path.join(folder,'process-owner.exe');
 const build=cp.spawnSync(path.join(fw,'v3.5','csc.exe'),['/nologo','/noconfig','/reference:'+path.join(fw,'v2.0.50727','System.dll'),'/target:exe','/platform:anycpu','/win32manifest:'+path.join(folder,'process-owner.manifest'),'/out:'+exe,source],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:1024*1024});
 assert.ok(!build.error&&build.status===0,'compile private native fault: '+build.stdout+' '+build.stderr);
 const manifestFile=path.join(folder,'process-owner.json'),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
 const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 manifest.sha256=hash(exe);manifest.sourceSha256=hash(source);fs.writeFileSync(manifestFile,JSON.stringify(manifest));
 check('private injected native material validates and differs from production',api.validateInstallation(root).sha256!==before.sha256);
 const infoFile=path.join(S.runDir,'leaf.json'),gate=path.join(S.runDir,'finish-root.gate'),heart=path.join(S.runDir,'leaf-heart.txt');fs.writeFileSync(heart,'');
 const fixture=path.join(S.runDir,'fault-tree.js');
 fs.writeFileSync(fixture,`const fs=require('fs'),http=require('http'),cp=require('child_process');setTimeout(()=>process.exit(0),20000);if(process.argv[2]==='leaf'){http.createServer((q,s)=>s.end('owned')).listen(0,'127.0.0.1',function(){process.send({port:this.address().port});});setInterval(()=>fs.appendFileSync(${JSON.stringify(heart)},'x'),25);}else{const c=cp.spawn(process.execPath,[__filename,'leaf'],{detached:true,stdio:['ignore','ignore','ignore','ipc']});c.on('message',j=>fs.writeFileSync(${JSON.stringify(infoFile)},JSON.stringify(j)));setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))process.exit(7);},20);}`);
 const manager=api.create(cp,root);
 const result=new Promise(resolve=>{child=manager.execFile(S.NODE_BIN,[fixture],{windowsHide:true,timeout:15000,maxBuffer:65536},(error,stdout,stderr)=>resolve({error,stdout,stderr}));child.on('error',()=>{});closed=new Promise(r=>child.once('close',r));if(child.pid)fs.appendFileSync(S.manifest,child.pid+'\t'+S.runDir+'\n');});
 const info=await until(()=>{try{return JSON.parse(fs.readFileSync(infoFile,'utf8'));}catch(e){return null;}});
 check('owned detached descendant is alive before native cleanup failure',await ping(info.port));
 fs.writeFileSync(gate,'FINISH');const outcome=await result;await closed;
 check('native cleanup exception preserves unknown outcome with original failure exit',outcome.error&&outcome.error.code==='EOWNERUNKNOWN'&&outcome.error.cause&&outcome.error.cause.code===125&&outcome.stderr.includes('fixture-cleanup-query-failure'));
 check('cleanup exception never publishes a target-group completion proof',child.ownedTree.bound&&!child.ownedTree.closed&&!!child.ownedTree.error);
 await until(async()=>!await ping(info.port));const size=fs.statSync(heart).size;await pause(180);
 check('OS broker teardown still removes descendant listener and heartbeat',fs.statSync(heart).size===size&&manager.processOwnerInfo().active===0);
 check('production native material stays untouched',api.validateInstallation(path.resolve(__dirname,'..')).sha256===before.sha256);
 console.log('CLEANUP/FAILURE 6/6; private native exception, honest unknown proof, no Win7 certification');
}finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await closed;}S.cleanup();}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
