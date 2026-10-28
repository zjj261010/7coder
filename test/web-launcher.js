'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),vm=require('vm'),http=require('http');
const S=require('./_shared').create({suite:'web-launcher'}),root=path.dirname(S.IDX),children=[];let checks=0;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==14){console.error('WEB/LAUNCHER incomplete '+checks+'/14');process.exitCode=1;}});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+8000;while(Date.now()<end){const value=await fn();if(value)return value;await pause(20);}throw Error('launcher phase deadline');}
function request(port){return new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port,path:'/api/info',timeout:400},res=>{let body='';res.on('data',part=>body+=part);res.on('end',()=>resolve(JSON.parse(body)));});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('health deadline')));});}
const deadline=setTimeout(()=>{console.error('WEB/LAUNCHER deadline');for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill();process.exit(1);},30000);
(async()=>{try{
  const source=fs.readFileSync(S.IDX,'utf8'),start=source.indexOf('function httpListeningUrls('),end=source.indexOf('function startHttpServer(',start);assert.ok(start>=0&&end>start);
  const c=vm.createContext({});vm.runInContext(source.slice(start,end),c);
  for(const [host,port,browser]of [['127.0.0.1',7103,'127.0.0.1'],['::1',8101,'[::1]'],['0.0.0.0',8102,'127.0.0.1'],['::',8103,'[::1]'],['192.0.2.20',8104,'192.0.2.20']]){
    const urls=c.httpListeningUrls(host,port),expectedHost=host.includes(':')?'['+host+']':host;
    check('actual bind '+host+' formats distinct endpoint/browser addresses',urls.endpoint==='http://'+expectedHost+':'+port&&urls.ui==='http://'+browser+':'+port+'/');
  }
  if(process.platform!=='win32')throw Error('launcher execution fixture requires Windows PowerShell');
  const actualScript=path.resolve(__dirname,'../scripts/start-web.ps1'),scriptBytes=fs.readFileSync(actualScript),script=path.join(root,'scripts','start-web.ps1');
  fs.mkdirSync(path.dirname(script));fs.writeFileSync(script,scriptBytes);
  const text=scriptBytes.toString('utf8');check('launcher no longer reads unbounded env text or predicts an unbound URL',!text.includes('Get-Content')&&!text.includes('$HttpPort')&&!text.includes('7coder web UI: http'));
  const marker=path.join(S.runDir,'entry-started.txt');fs.writeFileSync(S.IDX,source.replace(/^(#![^\r\n]*\r?\n)/,line=>line+'require("fs").appendFileSync('+JSON.stringify(marker)+',"x");\n'));
  const environment=Object.assign({},process.env,{DREAM_ALLOW:'false',ENABLE_RALPH_MODE:'false',OPENAI_ENDPOINT:'http://127.0.0.1:1',OPENAI_API_KEY:'',HTTP_API_KEY:'',PERMISSION_MODE:'denial'});
  const inheritedPath=process.env.PATH;for(const key of Object.keys(environment))if(key.toLowerCase()==='path')delete environment[key];environment.Path=path.dirname(S.NODE_BIN)+';'+inheritedPath;
  const owner=require(path.join(root,'lib','process-owner')).create(cp,root),powerShell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  function launch(workspace){let child,output='';const done=new Promise(resolve=>{
    child=owner.execFile(powerShell,['-NoProfile','-ExecutionPolicy','Bypass','-File',script,workspace],{cwd:S.runDir,env:environment,encoding:'utf8',timeout:12000,maxBuffer:256*1024,windowsHide:true},(error,stdout,stderr)=>resolve({error,stdout,stderr}));children.push(child);child.on('error',()=>{});
    for(const stream of [child.stdout,child.stderr])if(stream)stream.on('data',part=>output=(output+part).slice(-16000));if(child.pid)fs.appendFileSync(S.manifest,child.pid+'\t'+S.runDir+'\n');
  });return {child,done,get output(){return output;}};}
  let f=launch(path.join(S.runDir,'missing-workspace')),outcome=await f.done;
  check('missing workspace returns nonzero before executing private Agent entry',outcome.error&&outcome.error.code!==0&&!fs.existsSync(marker)&&/Workspace directory not found/.test(outcome.stderr));
  f=launch('HKCU:\\Software');outcome=await f.done;
  check('registry provider directory is refused before executing a filesystem Agent',outcome.error&&/FileSystem directory/.test(outcome.stderr)&&!fs.existsSync(marker));
  const cwd=S.freshCwd('web workspace 中文'),probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  fs.writeFileSync(path.join(cwd,'.env'),"HTTP_PORT='"+port+"'\nHTTP_BIND=127.0.0.1\nDREAM_ALLOW=false\nENABLE_RALPH_MODE=false\nPERMISSION_MODE=denial\n");
  f=launch(cwd);await until(()=>{if(f.child.exitCode!=null)throw Error('launcher exited before ready: '+f.output);return f.output.includes('endpoint ready at http://127.0.0.1:'+port);});
  check('quoted workspace port is advertised only by the actual listening Agent',f.output.includes('Built-in web UI: open http://127.0.0.1:'+port+'/')&&!f.output.includes('7coder web UI: http'));
  const info=await request(port);check('PowerShell-selected Unicode/space workspace is the actual backend workspace',info.workspace===cwd&&info.ui.available&&fs.readFileSync(marker,'utf8')==='x');
  check('PATH fallback selects the explicit bundled test runtime rather than development Node',f.output.toLowerCase().includes(S.NODE_BIN.toLowerCase()));
  f.child.kill();await f.done;await until(async()=>{try{await request(port);return false;}catch(error){return true;}});
  check('owned launcher stop closes its Agent server and confirms the Job target group',f.child.ownedTree.closed&&owner.processOwnerInfo().active===0);
  fs.writeFileSync(S.IDX,'process.exit(23);\n');f=launch(cwd);outcome=await f.done;
  check('PowerShell launcher preserves the actual Node nonzero exit code',outcome.error&&outcome.error.code===23&&f.child.ownedTree.closed);
  const api=require('../lib/process-owner');check('production launcher/native files remain unchanged during private executions',fs.readFileSync(actualScript).equals(scriptBytes)&&api.validateInstallation(root).sha256===api.validateInstallation(path.resolve(__dirname,'..')).sha256);
  console.log('WEB/LAUNCHER 14/14; actual text-only PowerShell/private Agent; IPv6 formatting is unit-only, not Win7/PS2 certification');
}finally{clearTimeout(deadline);for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill();for(const child of children)if(child.exitCode==null&&child.signalCode==null)await new Promise(r=>child.once('close',r));S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
