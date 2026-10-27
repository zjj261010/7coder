'use strict';
// Runs outside the Agent JS event loop. No process spawning or PID signals.
const { parentPort, workerData } = require('worker_threads'), net=require('net');
const ready=new Int32Array(workerData.ready), entries=new Map();
// Node13.14's monitor updates shared state without swallowing the exception:
// the normal Worker error event still carries its stack to the Agent.
process.on('uncaughtExceptionMonitor',()=>{Atomics.store(ready,0,-1);Atomics.notify(ready,0);});
// Shared layout: registered, flags, expected PID, observed broker PID,
// target PID, target exit, reason, native errno, stop requested, retired.
const BOUND=1,CLOSED=2,STOPPED=4,ERROR=8,HELLO=16;
function fail(entry,reason,code) {
  if(!(Atomics.load(entry.state,1)&ERROR)){Atomics.store(entry.state,6,reason);Atomics.store(entry.state,7,code||0);}
  Atomics.or(entry.state,1,ERROR);
}
function retire(entry) {
  clearTimeout(entry.timer);clearTimeout(entry.identityTimer);
  if(entry.socket)entry.socket.destroy();entries.delete(entry.token);
}
const server=net.createServer(socket=>{
  socket.setEncoding('ascii');socket.unref();socket.setTimeout(15000,()=>socket.destroy());socket.on('error',()=>{});
  let text='',entry=null;
  socket.on('data',fragment=>{
    if(text.length+fragment.length>1024){socket.destroy();return;}text+=fragment;
    let at;
    while((at=text.indexOf('\n'))>=0){
      const line=text.slice(0,at);text=text.slice(at+1);
      if(!entry){
        const m=/^HELLO ([a-f0-9]{48}) (\d+)$/.exec(line);entry=m&&entries.get(m[1]);
        const pid=m&&Number(m[2]);
        if(!entry||entry.socket||!Number.isInteger(pid)||pid<=0||pid>0xffffffff){entry=null;socket.destroy();return;}
        entry.socket=socket;Atomics.store(entry.state,3,pid);socket.setTimeout(0);
        const start=()=>{
          if(Atomics.load(entry.state,9)){socket.destroy();return;}
          const expected=Atomics.load(entry.state,2)>>>0;
          if(Atomics.load(entry.state,8)&&!expected&&!entry.sync){socket.end('STOP\n');return;}
          // Async spawn publishes its returned ChildProcess PID before START.
          // Sync spawn cannot return PID yet: registered nonce authorizes it,
          // then the parent compares the observed PID with spawnSync's result.
          if(!entry.sync&&!expected){entry.identityTimer=setTimeout(start,2);return;}
          if(!entry.sync&&expected!==pid){fail(entry,1);socket.destroy();return;}
          Atomics.or(entry.state,1,HELLO);clearTimeout(entry.timer);
          socket.write(Atomics.load(entry.state,8)?'STOP\n':'START\n');
        };start();
      }else if(/^READY \d+$/.test(line)&&(Atomics.load(entry.state,1)&HELLO)&&!(Atomics.load(entry.state,1)&BOUND)){
        Atomics.store(entry.state,4,Number(line.slice(6)));Atomics.or(entry.state,1,BOUND);
        socket.write(Atomics.load(entry.state,8)?'STOP\n':'GO\n');
      }else if(/^(EXIT|STOPPED) \d+$/.test(line)&&(Atomics.load(entry.state,1)&BOUND)){
        Atomics.store(entry.state,5,Number(line.split(' ')[1]));
        Atomics.or(entry.state,1,CLOSED|(line.indexOf('STOPPED ')===0?STOPPED:0));
        socket.write('ACK\n'); // Proof is visible even while parent is blocked.
      }else if(/^ERROR \d+$/.test(line)){fail(entry,2,Number(line.slice(6)));}
      else{fail(entry,1);socket.destroy();return;}
    }
  });
  socket.on('close',()=>{if(entry&&!(Atomics.load(entry.state,1)&CLOSED))fail(entry,3);});
});
server.maxConnections=256;
server.on('error',error=>{Atomics.store(ready,0,-1);Atomics.notify(ready,0);parentPort.postMessage({kind:'control-error',message:String(error.message).slice(0,400),stack:String(error.stack||'').slice(0,1000)});for(const entry of entries.values()){fail(entry,5);parentPort.postMessage({kind:'expire',token:entry.token});}});
server.listen(workerData.pipe,()=>{Atomics.store(ready,0,1);Atomics.notify(ready,0);});server.unref();
parentPort.on('message',message=>{
  if(message.kind==='register'){
    const state=new Int32Array(message.state);
    if(entries.size>=128||entries.has(message.token)){Atomics.store(state,0,-1);Atomics.notify(state,0);return;}
    const entry={token:message.token,state,sync:message.sync,socket:null,timer:null,identityTimer:null};entries.set(message.token,entry);
    entry.timer=setTimeout(()=>{fail(entry,4);Atomics.store(state,8,1);if(entry.socket)entry.socket.end('STOP\n');parentPort.postMessage({kind:'expire',token:entry.token});},15000);entry.timer.unref();
    Atomics.store(state,0,1);Atomics.notify(state,0);
  }else{
    const entry=entries.get(message.token);if(!entry)return;
    if(message.kind==='stop'){Atomics.store(entry.state,8,1);if(entry.socket)entry.socket.write('STOP\n');}
    else if(message.kind==='retire')retire(entry);
  }
});
