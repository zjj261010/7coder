'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),{EventEmitter}=require('events');
const {assertWindowsCommandCwd}=require('../lib/process-owner'),S=require('./_shared').create({suite:'cmd-unc-cwd'});let checks=0;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==13){console.error('CMD/UNC incomplete '+checks+'/13');process.exitCode=1;}});
const unc='\\\\7coder-never-contact.invalid\\fixture share\\work';
const originalStat=fs.statSync;let uncProbes=0;
(async()=>{try{
  for(const file of ['cmd','cmd.exe','C:\\Windows\\System32\\CMD.EXE','C:\\owned\\start.cmd','folder/script.BAT']){
    assert.throws(()=>assertWindowsCommandCwd(file,unc),e=>e.code==='EUNC_CWD'&&/No process was started/.test(e.message));check(file+' refuses UNC cwd without interpreting command data',true);
  }
  assert.throws(()=>assertWindowsCommandCwd('cmd.exe','//7coder-never-contact.invalid/share/work'),e=>e.code==='EUNC_CWD');
  check('forward-slash UNC spelling receives the same deployment guard',true);
  assert.throws(()=>assertWindowsCommandCwd('cmd.exe','\\\\?\\UNC\\7coder-never-contact.invalid\\share'),e=>e.code==='EUNC_CWD');
  check('extended UNC namespace cannot bypass the cwd guard',true);
  for(const cwd of ['C:\\work space','Z:\\mapped-looking-drive','\\\\?\\C:\\local'])assertWindowsCommandCwd('cmd.exe',cwd);
  check('drive-letter and local namespace paths are not misclassified as UNC',true);
  for(const file of ['C:\\app\\node.exe','C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'])assertWindowsCommandCwd(file,unc);
  check('native non-cmd executables retain their independent UNC compatibility boundary',true);
  if(process.platform!=='win32')throw Error('adapter admission fixture requires Windows');
  fs.statSync=function(file,...args){if(/^(?:\\\\|\/\/)/.test(String(file))){uncProbes++;throw Error('fixture forbids any UNC filesystem probe');}return originalStat.call(fs,file,...args);};
  let spawned=0;const root=path.dirname(S.IDX),forbidden=()=>{spawned++;throw Error('UNC must never reach native spawn');};
  const owner=require(path.join(root,'lib','process-owner')).create(Object.assign({},cp,{spawn:forbidden,spawnSync:forbidden}),root);
  const specs=[()=>owner.spawn('cmd.exe',['/d','/c','echo NEVER'],{cwd:unc}),()=>owner.exec('echo NEVER',{cwd:unc},()=>{}),
    ()=>owner.execFile(path.join(process.env.SystemRoot,'System32','cmd.exe'),['/c','echo NEVER'],{cwd:unc},()=>{}),
    ()=>owner.spawn(unc+'\\shim.cmd',[],{cwd:unc}),()=>owner.spawnSync('cmd.exe',[],{cwd:unc}),()=>owner.execSync('echo NEVER',{cwd:unc})];
  for(const spec of specs)assert.throws(spec,e=>e.code==='EUNC_CWD');
  check('async/sync shell/direct/batch paths refuse before any broker, process or UNC filesystem access',spawned===0&&uncProbes===0&&owner.processOwnerInfo().active===0&&owner.processOwnerInfo().pending===0&&!owner.processOwnerInfo().controlReady);
  check('unsupported cwd is a recoverable admission error rather than unknown execution',!owner.processOwnerInfo().recoveryRequired&&owner.processOwnerInfo().readyForWork);
  let fake;
  const native=require(path.join(root,'lib','process-owner')).create(Object.assign({},cp,{spawn(file,args,opts){
    spawned++;assert.strictEqual(opts.cwd,unc);fake=new EventEmitter();fake.kill=()=>true;
    process.nextTick(()=>fake.emit('error',Object.assign(Error('fixture does not actually access UNC'),{code:'ENOENT'})));return fake;
  }}),root);
  const child=native.spawn(S.NODE_BIN,[],{cwd:unc}),error=await new Promise(resolve=>child.once('error',resolve));
  check('non-cmd reaches a fake launcher without contacting the invented UNC share',spawned===1&&error.code==='ENOENT'&&!child.ownedTree.bound&&native.processOwnerInfo().active===0);
  const material=require('../lib/process-owner');check('production native material unchanged and no UNC lookup reached the OS',uncProbes===0&&material.validateInstallation(root).sha256===material.validateInstallation(path.resolve(__dirname,'..')).sha256);
  console.log('CMD/UNC 13/13; lexical/admission checks and fake launch only; no SMB request or real UNC/Win7 certification');
}finally{fs.statSync=originalStat;S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
