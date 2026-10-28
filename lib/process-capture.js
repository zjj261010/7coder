'use strict';
const signals=require('os').constants.signals;
const resources={limit:32*1024*1024,allocatedBytes:0,retainedBytes:0,blocks:0,active:0};
function snapshot(){return Object.assign({},resources);}
function outputLimit(beforeSpawn){return Object.assign(new Error('Aggregate managed command output exceeds 32MiB capture budget; '+
  (beforeSpawn?'request not started.':'stop requested; command may have run, check side effects before retrying.')),{code:'ERR_PROCESS_OUTPUT_BUDGET'});}
// Node13 execFile does not forward detached to spawn. This bounded collector
// uses a referenced spawn handle so an internal broker can avoid libuv's
// automatic child Job, while its own control pipe/strict Job own the targets.
function capture(raw,file,args,options,callback) {
  const opts=Object.assign({encoding:'utf8',timeout:0,maxBuffer:1024*1024,killSignal:'SIGTERM'},options||{});
  if(opts.timeout==null)opts.timeout=0;
  if(!Number.isInteger(opts.timeout)||opts.timeout<0||opts.timeout>0xffffffff)throw Object.assign(new RangeError('Invalid process timeout'),{code:'ERR_OUT_OF_RANGE'});
  if(typeof opts.maxBuffer!=='number'||Number.isNaN(opts.maxBuffer)||opts.maxBuffer<0)throw Object.assign(new RangeError('Invalid process maxBuffer'),{code:'ERR_OUT_OF_RANGE'});
  if(opts.killSignal==null)opts.killSignal='SIGTERM';
  if(typeof opts.killSignal==='string')opts.killSignal=opts.killSignal.toUpperCase();
  if(!(typeof opts.killSignal==='string'&&Object.prototype.hasOwnProperty.call(signals,opts.killSignal))&&
      !(Number.isInteger(opts.killSignal)&&Object.keys(signals).some(key=>signals[key]===opts.killSignal)))throw Object.assign(new TypeError('Invalid process killSignal'),{code:'ERR_UNKNOWN_SIGNAL'});
  const encoding=opts.encoding!=='buffer'&&Buffer.isEncoding(opts.encoding)?opts.encoding:null;
  const maxBytes=Math.floor(opts.maxBuffer);
  const spawnOptions=Object.assign({},opts,{detached:true,stdio:'pipe'});
  // Own one timeout on every supported Node version, including newer spawn
  // implementations that would otherwise install a second timeout.
  for(const key of ['timeout','maxBuffer','encoding','killSignal'])delete spawnOptions[key];
  if(resources.allocatedBytes>=resources.limit)throw outputLimit(true);
  const child=raw.spawn(file,args,spawnOptions);
  const store=()=>({chunks:[],bytes:0,allocated:0,tail:null,tailUsed:0});
  const stdout=store(),stderr=store();let error=null,timer=null,settled=false,stopping=false;
  resources.active++;
  function append(target,chunk,count){
    let offset=0;
    while(offset<count){
      if(!target.tail||target.tailUsed===target.tail.length){
        const capacity=Math.min(16384,maxBytes-target.bytes,resources.limit-resources.allocatedBytes);
        if(capacity<=0)break;
        // Unpooled owned blocks: tiny fragments neither retain a large input
        // backing buffer nor allocate one JS/Buffer object for every write.
        const block=Buffer.allocUnsafeSlow(capacity);
        target.chunks.push(block);target.tail=block;target.tailUsed=0;target.allocated+=capacity;
        resources.allocatedBytes+=capacity;resources.blocks++;
      }
      const added=Math.min(count-offset,target.tail.length-target.tailUsed);
      chunk.copy(target.tail,target.tailUsed,offset,offset+added);
      offset+=added;target.tailUsed+=added;target.bytes+=added;resources.retainedBytes+=added;
    }
    return offset;
  }
  function release(){
    resources.active--;
    for(const target of [stdout,stderr]){
      resources.allocatedBytes-=target.allocated;resources.retainedBytes-=target.bytes;resources.blocks-=target.chunks.length;
      target.chunks.length=0;target.tail=null;
    }
  }
  function stop(reason) {
    if(settled)return;
    if(reason&&!error)error=reason;
    if(stopping)return;stopping=true;
    try{child.kill(opts.killSignal);}catch(e){if(!error)error=e;}
  }
  function finish(code,signal) {
    if(settled)return;settled=true;clearTimeout(timer);
    let out,err;
    try{out=Buffer.concat(stdout.chunks,stdout.bytes);err=Buffer.concat(stderr.chunks,stderr.bytes);}
    catch(failure){error=error||failure;out=Buffer.alloc(0);err=Buffer.alloc(0);}
    finally{release();}
    const output=encoding?out.toString(encoding):out,errors=encoding?err.toString(encoding):err;
    if(!error&&(code!==0||signal))error=Object.assign(new Error('Command failed: '+file+(err.length?'\n'+(encoding?errors:err.toString('utf8')).slice(-4000):'')),{code,signal});
    if(error){error.killed=!!(stopping||child.killed);error.signal=signal||null;error.cmd=file;error.stdout=output;error.stderr=errors;}
    if(typeof callback==='function')callback(error,output,errors);
  }
  function collect(stream,target,which) {
    if(!stream)return;
    if(encoding)stream.setEncoding(encoding);
    stream.on('data',data=>{
      if(settled||error)return; // keep draining, but never retain more output
      const chunk=Buffer.isBuffer(data)?data:Buffer.from(data,stream.readableEncoding||'utf8');
      const remaining=Math.max(0,maxBytes-target.bytes),count=Math.min(remaining,chunk.length);
      let stored;try{stored=append(target,chunk,count);}catch(failure){stop(failure);return;}
      if(stored<count)stop(outputLimit(false));
      else if(chunk.length>remaining)stop(Object.assign(new Error(which+' maxBuffer length exceeded'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}));
    });
    stream.on('error',e=>stop(e));
  }
  collect(child.stdout,stdout,'stdout');collect(child.stderr,stderr,'stderr');
  if(child.stdin)child.stdin.on('error',e=>stop(e));
  child.on('error',e=>{if(!error)error=e;if(!child.pid)finish(null,null);else stop(e);});
  child.once('ownerUnknown',e=>{error=e;finish(null,null);});
  child.once('close',finish);
  if(opts.timeout>0)timer=setTimeout(()=>stop(Object.assign(new Error('Command timed out after '+opts.timeout+'ms'),{code:'ETIMEDOUT'})),opts.timeout);
  return child;
}
module.exports={capture,snapshot};
