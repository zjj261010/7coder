// Real control-worker crash, fake ChildProcess handles. No target launch or
// PID signalling. Verify that failure keeps its useful diagnostic and closes.
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),{EventEmitter}=require('events');
const S=require('./_shared').create({suite:'process-owner-control-errors'}),root=path.dirname(S.IDX),file=path.join(root,'lib','process-owner-control.js');
const original=fs.readFileSync(file);let calls=0,kills=0,checks=0;
process.once('exit',()=>{if(checks!==4){console.error('CONTROL/ERRORS incomplete: '+checks+'/4');process.exitCode=1;}});
function check(label,ok){assert.ok(ok,label);checks++;console.log('PASS '+label);}
(async()=>{try{
 if(process.platform!=='win32')throw Error('control-worker fault fixture requires Windows');
 fs.appendFileSync(file,"\nsetTimeout(()=>{throw Error('OWNED_CONTROL_DIAGNOSTIC');},100);\n");
 const owner=require(path.join(root,'lib','process-owner')).create(Object.assign({},cp,{spawn(){calls++;const child=new EventEmitter();child.pid=900001;child.exitCode=null;child.signalCode=null;child.kill=()=>{kills++;child.exitCode=1;process.nextTick(()=>child.emit('close',1));return true;};return child;},execFile(){calls++;throw Error('unexpected target');}}),root);
 const child=owner.spawn(S.NODE_BIN,[]),closed=new Promise(r=>child.once('close',r));let deadline;
 try{await Promise.race([closed,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('control failure deadline')),5000);})]);}finally{clearTimeout(deadline);}
 check('control worker failure stops the registered fake handle exactly once with no target process',calls===1&&kills===1&&!child.ownedTree.closed);
 await new Promise(r=>setTimeout(r,100));const info=owner.processOwnerInfo();
 check('default Worker error preserves message/stack through subsequent exit event',!info.controlReady&&info.error.includes('OWNED_CONTROL_DIAGNOSTIC')&&info.controlErrorStack.includes('process-owner-control.js')&&info.controlErrorStack.length<=1000);
 check('failure releases all parent admission records',info.active===0&&info.pending===0);
 let error;try{owner.execFile(S.NODE_BIN,[],{},()=>{});}catch(e){error=e;}
 check('subsequent operation fails before any replacement process is created',error&&calls===1&&error.message.includes('OWNED_CONTROL_DIAGNOSTIC'));
 console.log('PROCESS/CONTROL-ERRORS '+checks+'/'+checks+'; real worker, fake process handle, SKIP 0');
}finally{fs.writeFileSync(file,original);S.cleanup();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
