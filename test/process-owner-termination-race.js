'use strict';
// Opt-in developer diagnostic: compile ONLY a private native copy. Inject
// failed TerminateProcess + unsignalled handle results deterministically;
// every actual target remains owned by the production strict Job mechanism.
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),http=require('http'),crypto=require('crypto');
if(process.platform!=='win32'||!process.argv.includes('--run')){console.error('Windows diagnostic: add --run; requires .NET 3.5 compiler.');process.exit(2);}
const S=require('./_shared').create({suite:'termination-race'}),root=path.dirname(S.IDX),folder=path.join(root,'native'),api=require('../lib/process-owner');
const before=api.validateInstallation(path.resolve(__dirname,'..'));let checks=0,child,closed;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==11){console.error('TERMINATION/RACE incomplete '+checks+'/11');process.exitCode=1;}});
const deadline=setTimeout(()=>{console.error('TERMINATION/RACE deadline');process.exit(1);},30000),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+10000;while(Date.now()<end){const value=await fn();if(value)return value;await pause(20);}throw Error('native race phase deadline');}
function ping(port){return new Promise(resolve=>{const req=http.get({host:'127.0.0.1',port,timeout:200},res=>{res.resume();res.on('end',()=>resolve(true));});req.on('error',()=>resolve(false));req.on('timeout',()=>req.destroy());});}
(async()=>{try{
  const sourceFile=path.join(folder,'process-owner.cs');let source=fs.readFileSync(sourceFile,'utf8');
  const replacements=[['if(!TerminateProcess(member,1)) {','if(!FixtureTerminate(member,1)) {'],
    ['uint after=WaitForSingleObject(member,0);','uint after=fixturePending ? 258u : WaitForSingleObject(member,0);']];
  for(const [from,to]of replacements){assert.ok(source.indexOf(from)>=0&&source.indexOf(from)===source.lastIndexOf(from),from);source=source.replace(from,to);}
  source=source.replace('    static void EmptyTargets(IntPtr job) {',`    [DllImport("kernel32.dll", EntryPoint="SetLastError", SetLastError=true)] static extern void FixtureError(uint code);
    static bool fixturePending=false,fixtureUsed=false;
    static bool FixtureTerminate(IntPtr member,uint code) {
        fixturePending=false; string mode=Environment.GetEnvironmentVariable("OWNER_RACE_FIXTURE_MODE");
        if(mode=="once" && fixtureUsed) return TerminateProcess(member,code);
        fixtureUsed=true; fixturePending=true;
        if(mode=="once") TerminateProcess(member,code);
        Console.Error.WriteLine("[FIXTURE] unsignalled termination "+mode);
        FixtureError(mode=="other" ? 6u : 5u); return false;
    }
    static void EmptyTargets(IntPtr job) {`);
  fs.writeFileSync(sourceFile,source);const fw=path.join(process.env.SystemRoot,'Microsoft.NET','Framework'),exe=path.join(folder,'process-owner.exe');
  const build=cp.spawnSync(path.join(fw,'v3.5','csc.exe'),['/nologo','/noconfig','/reference:'+path.join(fw,'v2.0.50727','System.dll'),'/target:exe','/platform:anycpu','/win32manifest:'+path.join(folder,'process-owner.manifest'),'/out:'+exe,sourceFile],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:1024*1024});
  assert.ok(!build.error&&build.status===0,'private native compile: '+build.stdout+' '+build.stderr);
  const manifestFile=path.join(folder,'process-owner.json'),manifest=JSON.parse(fs.readFileSync(manifestFile)),hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  manifest.sha256=hash(exe);manifest.sourceSha256=hash(sourceFile);fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  check('private injected material is bound to its source without altering production',api.validateInstallation(root).sha256!==before.sha256);
  for(const mode of ['once','stuck','other']){
    const infoFile=path.join(S.runDir,mode+'.json'),heart=path.join(S.runDir,mode+'.heart'),script=path.join(S.runDir,mode+'.js');fs.writeFileSync(heart,'');
    fs.writeFileSync(script,'const fs=require("fs"),http=require("http");setTimeout(()=>process.exit(0),15000);http.createServer((q,s)=>s.end("owned")).listen(0,"127.0.0.1",function(){fs.writeFileSync('+JSON.stringify(infoFile)+',JSON.stringify({port:this.address().port}));});setInterval(()=>fs.appendFileSync('+JSON.stringify(heart)+',"x"),25);');
    const manager=require(path.join(root,'lib','process-owner')).create(cp,root);let result;
    const done=new Promise(resolve=>{child=manager.execFile(S.NODE_BIN,[script],{timeout:12000,windowsHide:true,maxBuffer:65536,env:Object.assign({},process.env,{OWNER_RACE_FIXTURE_MODE:mode})},(error,stdout,stderr)=>resolve({error,stderr}));child.on('error',()=>{});closed=new Promise(r=>child.once('close',r));if(child.pid)fs.appendFileSync(S.manifest,child.pid+'\t'+S.runDir+'\n');});
    const info=await until(()=>{try{return JSON.parse(fs.readFileSync(infoFile));}catch(e){return null;}});
    check(mode+': target is live and bound before stop',child.ownedTree.bound&&await ping(info.port));
    child.kill();result=await done;await closed;
    check(mode+': termination result requires actual membership/accounting proof',mode==='once'?
      child.ownedTree.closed&&child.ownedTree.stopped&&!manager.processOwnerInfo().recoveryRequired&&result.stderr.includes('unsignalled termination once'):
      result.error&&result.error.code==='EOWNERUNKNOWN'&&!child.ownedTree.closed&&manager.processOwnerInfo().recoveryRequired&&result.stderr.includes(mode==='stuck'?'cleanup-deadline':'terminate-member'));
    await until(async()=>!await ping(info.port));const bytes=fs.statSync(heart).size;await pause(160);
    check(mode+': stable-handle/Job teardown leaves no target heartbeat or listener',fs.statSync(heart).size===bytes&&manager.processOwnerInfo().active===0);
  }
  check('production native source/executable binding remains unchanged by diagnostic',api.validateInstallation(path.resolve(__dirname,'..')).sha256===before.sha256);
  console.log('TERMINATION/RACE 11/11; deterministic private native failures; modern Windows, no Win7 certification');
}finally{clearTimeout(deadline);if(child&&child.exitCode==null&&child.signalCode==null){child.kill();await closed;}S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
