// Invalid selectors must fail before executing any existing positive cases.
const assert=require('assert'),path=require('path');
const S=require('./_shared').create({suite:'selection-guards'});let checks=0;
try{
 for(const [file,key] of [['process-owner.js','PROCESS_OWNER_SCOPE'],['process-owner-integration.js','PROCESS_OWNER_INTEGRATION_SCOPE'],['process-owner-faults.js','PROCESS_OWNER_FAULT_SCOPE'],['desktop-lifecycle.js','DESKTOP_LIFECYCLE_SCOPE'],['process-owner-git.js','PROCESS_OWNER_GIT_SCOPE']]){
   const env=Object.assign({},process.env);env[key]='definitely-invalid-selection';
   const r=S.spawnSync(S.NODE_BIN,[path.join(__dirname,file)],{encoding:'utf8',env,timeout:10000,windowsHide:true});
   assert.ok(r.status===1&&/Unknown .*test scope:/.test(r.stderr)&&!/^PASS /m.test(r.stdout),file+' invalid selection: '+r.stdout+' '+r.stderr);
   checks++;console.log('PASS '+file+' rejects invalid scope before any positive test');
 }
 console.log('SELECTION/GUARDS '+checks+'/'+checks+'; no positive product suite executed');
}finally{S.cleanup();}
