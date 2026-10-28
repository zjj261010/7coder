'use strict';
const fs=require('fs'),path=require('path');
const NAME='.7coder-process-recovery-required.json';
function create(directory) {
  const file=path.join(directory,NAME);let blocked=false,persistenceError=null,pending=false,recorded=false;
  // Presence is sufficient: interrupted writes, links, malformed or oversized
  // files must never silently clear an unknown native process outcome.
  try{fs.lstatSync(file);blocked=true;}catch(error){if(error.code!=='ENOENT'){blocked=true;persistenceError=error.code||'EIO';}}
  function assertReady(){if(blocked)throw Object.assign(new Error('Workspace process recovery required. Inspect '+file+' and actual processes/repository state before manually archiving this marker and restarting. No automatic cleanup or replay is safe.'),{code:'EOWNERUNKNOWN'});}
  return {
    assertReady,
    record(error,notify){
      blocked=true;
      if(recorded)return this.info();recorded=true;pending=true;
      let notified=false;
      const report=()=>{if(!notified){notified=true;if(notify)notify(this.info());}};
      // IO may be stuck in a driver. Never await it on the task/control path.
      // One outstanding write is retained; a timeout is not a cancelled IO or
      // proof that restart protection reached disk. Never retry or unlink it.
      const timer=setTimeout(()=>{persistenceError=persistenceError||'ETIMEDOUT';report();},5000);
      const finish=failure=>{pending=false;clearTimeout(timer);if(failure&&failure.code!=='EEXIST')persistenceError=failure.code||'EIO';report();};
      const text=JSON.stringify({version:1,at:new Date().toISOString(),code:'EOWNERUNKNOWN',message:String(error.message).slice(0,1000),native:error.ownerDiagnostic||null,recovery:'Inspect real processes, filesystem and Git state before manually archiving this marker and restarting. Do not blindly replay commands or remove Git locks.'})+'\n';
      fs.open(file,'wx',(failure,fd)=>{
        if(failure){finish(failure);return;}
        const close=error=>fs.close(fd,closeError=>finish(error||closeError));
        fs.writeFile(fd,text,'utf8',writeError=>{if(writeError){close(writeError);return;}fs.fsync(fd,syncError=>close(syncError));});
      });
      return this.info();
    },
    info(){return {required:blocked,file,pending,persistenceError};}
  };
}
module.exports={create,NAME};
