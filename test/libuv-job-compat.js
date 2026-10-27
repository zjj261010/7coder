// Opt-in source/runtime diagnostic: requires the development CLR2 compiler.
// Probe processes only inspect their current Job; no user target is signalled.
'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process');
if(process.platform!=='win32'||!process.argv.includes('--run')){console.error('Windows diagnostic: add --run; requires .NET 3.5 compiler.');process.exit(2);}
const S=require('./_shared').create({suite:'libuv-job-compat'}),root=path.dirname(S.IDX),api=require(path.join(root,'lib','process-owner')),before=api.validateInstallation(path.resolve(__dirname,'..'));
const {capture}=require(path.join(root,'lib','process-capture'));let checks=0;
process.once('exit',()=>{if(checks!==6){console.error('LIBUV/JOB incomplete '+checks+'/6');process.exitCode=1;}});
function check(label,ok){assert.ok(ok,label);checks++;console.log('PASS '+label);}
function parse(text){const m=/^JOB ([01]) (\d+) ([01])\s*$/.exec(String(text));assert.ok(m,'probe: '+text);return {inside:m[1]==='1',flags:Number(m[2]),parent:m[3]==='1'};}
(async()=>{try{
 const source=path.join(S.runDir,'job-probe.cs'),exe=path.join(S.runDir,'job-probe.exe');fs.copyFileSync(path.join(__dirname,'fixtures','creation-guard.cs'),source);
 const fw=path.join(process.env.SystemRoot,'Microsoft.NET','Framework');const build=cp.spawnSync(path.join(fw,'v3.5','csc.exe'),['/nologo','/noconfig','/reference:'+path.join(fw,'v2.0.50727','System.dll'),'/target:exe','/platform:anycpu','/win32manifest:'+path.join(root,'native','process-owner.manifest'),'/out:'+exe,source],{encoding:'utf8',windowsHide:true,timeout:15000});assert.ok(!build.error&&build.status===0,'compile probe: '+build.stdout+' '+build.stderr);fs.copyFileSync(path.join(root,'native','process-owner.exe.config'),exe+'.config');
 const args=['job-probe',String(process.pid)],normal=cp.spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:5000}),detached=cp.spawnSync(exe,args,{encoding:'utf8',windowsHide:true,detached:true,timeout:5000});assert.ok(normal.status===0&&detached.status===0,'probe processes exit normally');const a=parse(normal.stdout),b=parse(detached.stdout);
 check('Node13 normal spawn is placed in its silent-breakaway automatic child Job',a.inside&&!!(a.flags&0x1000)&&!a.parent);
 check('detached spawn skips that child Job while retaining any enclosing host Job',!b.inside||b.parent);
 const collected=await new Promise(resolve=>capture(cp,exe,args,{encoding:'utf8',timeout:5000,maxBuffer:65536,windowsHide:true},(error,stdout,stderr)=>resolve({error,stdout,stderr}))),c=parse(collected.stdout);
 check('spawn-based async collector also avoids libuv automatic child Job',!collected.error&&(!c.inside||c.parent));
 const manager=api.create(cp,root);let child;const asyncResult=await new Promise(resolve=>{child=manager.execFile(exe,args,{encoding:'utf8',windowsHide:true,timeout:5000},(error,stdout,stderr)=>resolve({error,stdout,stderr}));});const d=parse(asyncResult.stdout);
 check('managed callback target inherits strict owned Job with confirmed cleanup',!asyncResult.error&&d.inside&&!(d.flags&0x1000)&&!d.parent&&child.ownedTree.closed);
 const syncResult=manager.spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:5000}),e=parse(syncResult.stdout);
 check('managed synchronous target has same strict Job and completion proof',!syncResult.error&&syncResult.status===0&&e.inside&&!(e.flags&0x1000)&&!e.parent&&syncResult.ownedTree.closed);
 check('production native source/exe/config bindings remain unchanged',api.validateInstallation(path.resolve(__dirname,'..')).sha256===before.sha256);
 console.log('LIBUV/JOB 6/6; '+JSON.stringify({normal:a,detached:b,collector:c,managed:d,sync:e})+'; not Win7 certification');
}finally{S.cleanup();}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
