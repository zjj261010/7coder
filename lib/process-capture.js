'use strict';
const signals=require('os').constants.signals;
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
  const child=raw.spawn(file,args,spawnOptions);
  const stdout=[],stderr=[];let outBytes=0,errBytes=0,error=null,timer=null,settled=false,stopping=false;
  function stop(reason) {
    if(settled)return;
    if(reason&&!error)error=reason;
    if(stopping)return;stopping=true;
    try{child.kill(opts.killSignal);}catch(e){if(!error)error=e;}
  }
  function finish(code,signal) {
    if(settled)return;settled=true;clearTimeout(timer);
    const out=Buffer.concat(stdout,outBytes),err=Buffer.concat(stderr,errBytes);
    const output=encoding?out.toString(encoding):out,errors=encoding?err.toString(encoding):err;
    if(!error&&(code!==0||signal))error=Object.assign(new Error('Command failed: '+file+(err.length?'\n'+(encoding?errors:err.toString('utf8')).slice(-4000):'')),{code,signal});
    if(error){error.killed=!!(stopping||child.killed);error.signal=signal||null;error.cmd=file;error.stdout=output;error.stderr=errors;}
    if(typeof callback==='function')callback(error,output,errors);
  }
  function collect(stream,chunks,which) {
    if(!stream)return;
    if(encoding)stream.setEncoding(encoding);
    stream.on('data',data=>{
      if(settled||error)return; // keep draining, but never retain more output
      const chunk=Buffer.isBuffer(data)?data:Buffer.from(data,stream.readableEncoding||'utf8');
      const used=which==='stdout'?outBytes:errBytes,remaining=Math.max(0,maxBytes-used),count=Math.min(remaining,chunk.length);
      if(count){chunks.push(chunk.slice(0,count));if(which==='stdout')outBytes+=count;else errBytes+=count;}
      if(chunk.length>remaining)stop(Object.assign(new Error(which+' maxBuffer length exceeded'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}));
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
module.exports={capture};
