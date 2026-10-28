'use strict';
// Windows-only adapter. ChildProcess remains the broker handle (including
// .pid); ownedTree.targetPid is diagnostic, never a signal target.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Worker } = require('worker_threads');
const { capture, snapshot:captureSnapshot } = require('./process-capture');
const { supervise } = require('./process-supervision');

function quote(arg) {
  return '"' + String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
function validateInstallation(root) {
  const folder=path.join(root,'native'), helper=path.join(folder,'process-owner.exe');
  const manifestFile=path.join(folder,'process-owner.json');
  if(fs.statSync(manifestFile).size>4096 || fs.statSync(helper).size>128*1024) throw Error('Process owner material exceeds its installation limit.');
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(manifest.protocol!==2 || manifest.file!=='process-owner.exe' ||
      crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex')!==manifest.sha256) {
    throw Error('Process owner missing or invalid; restore the complete offline installation. No target was started.');
  }
  for(const material of [['process-owner.cs','sourceSha256'],['process-owner.exe.config','configSha256'],['process-owner.manifest','manifestSha256']]) {
    const file=path.join(folder,material[0]);
    if(fs.statSync(file).size>64*1024 || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==manifest[material[1]]) {
      throw Error('Process owner source/runtime material mismatch; rebuild or restore the complete installation.');
    }
  }
  return manifest;
}
function create(raw, root, options) {
  options = options || {};
  if (process.platform !== 'win32' && !options.forceWindows) return raw;
  const helper = path.join(root, 'native', 'process-owner.exe');
  const pending = new Map(), owned = new Set();
  const pipe = '\\\\.\\pipe\\7coder-process-' + process.pid + '-' + crypto.randomBytes(24).toString('hex');
  let worker = null, serverError = null, checked = false, workerReady=null;
  let quarantine=null,unknownHandler=null;
  function assertReady(){
    if(quarantine)throw Object.assign(Error(quarantine.message),{code:'EOWNERUNKNOWN'});
    if(Array.from(owned).some(entry=>entry.stop))throw Object.assign(Error('Owned process cleanup is still pending. Wait for its result before starting more work.'),{code:'EOWNERCLEANUP'});
    if(serverError)throw Object.assign(Error('Process control unavailable; restart after inspecting outstanding processes. '+serverError.message),{code:'EOWNERUNAVAILABLE'});
  }
  function quarantineEntry(entry,error) {
    if(entry.unknown)return;entry.unknown=true;
    if(!quarantine){
      quarantine={code:'EOWNERUNKNOWN',message:String(error.message).slice(0,1000),at:new Date().toISOString(),persistenceError:null,
        treeError:String(entry.state.error||'').slice(0,400),causeCode:error.cause&&error.cause.code};
      error.ownerDiagnostic={treeError:quarantine.treeError,causeCode:quarantine.causeCode};
      if(unknownHandler)try{unknownHandler(error);}catch(failure){quarantine.persistenceError=String(failure.message).slice(0,400);}
      for(const other of owned)if(other!==entry)try{other.child.kill();}catch(failure){other.state.error=other.state.error||'Owned stop request failed; awaiting terminal deadline.';}
    }
    // Notify command collectors and spawn consumers without inventing close.
    // Destroying our pipe handles limits local retention; it proves nothing
    // about native IO, target membership or side effects still in progress.
    entry.child.emit('ownerUnknown',error);
    if(entry.child.listenerCount('error'))entry.child.emit('error',error);
    for(const stream of [entry.child.stdin,entry.child.stdout,entry.child.stderr])if(stream)stream.destroy();
  }
  function validate() {
    if (checked) return;
    validateInstallation(root);
    checked = true;
  }
  function listen() {
    if (serverError) throw serverError;
    if (worker) {if(Atomics.load(workerReady,0)!==1){serverError=Error('Process control worker unavailable; no target was started.');throw serverError;}return;}
    workerReady=new Int32Array(new SharedArrayBuffer(4));
    worker=new Worker(path.join(__dirname,'process-owner-control.js'),{workerData:{pipe,ready:workerReady.buffer}});
    const failed=error=>{
      serverError=error;Atomics.store(workerReady,0,-1);Atomics.notify(workerReady,0);
      for(const entry of owned)if(!entry.state.closed){entry.state.error='Process control worker unavailable; cleanup unconfirmed.';entry.child.kill();}
    };
    worker.on('error',failed);
    worker.on('exit',code=>{if(!serverError)failed(Error('Process control worker exited ('+code+'). Restart the Agent.'));});
    worker.on('message',message=>{
      if(message&&message.kind==='control-error'){const error=Error('Process control pipe failed: '+message.message);if(message.stack)error.stack=message.stack;failed(error);return;}
      const entry=message&&pending.get(message.token);if(entry&&message.kind==='expire')entry.child.kill();
    });
    worker.unref();
    Atomics.wait(workerReady,0,0,5000);
    if(Atomics.load(workerReady,0)!==1){serverError=Error('Process control worker startup failed; no target was started.');worker.terminate();throw serverError;}
  }
  function post(message){try{worker.postMessage(message);return true;}catch(error){serverError=error;return false;}}
  function register(sync) {
    listen();
    const token=crypto.randomBytes(24).toString('hex'),shared=new Int32Array(new SharedArrayBuffer(40));
    if(!post({kind:'register',token,state:shared.buffer,sync:!!sync}))throw Error('Process control registration failed; no target was started.');
    Atomics.wait(shared,0,0,5000);
    if(Atomics.load(shared,0)!==1){
      Atomics.store(shared,9,1);post({kind:'retire',token});
      serverError=Error('Process control admission failed; no target was started. Restart the Agent.');
      Atomics.store(workerReady,0,-1);worker.terminate();throw serverError;
    }
    let localError=null;
    const flags=()=>Atomics.load(shared,1);
    const state={};
    Object.defineProperties(state,{
      bound:{enumerable:true,get:()=>!!(flags()&1)},closed:{enumerable:true,get:()=>!!(flags()&2)&&!(flags()&8)},
      stopped:{enumerable:true,get:()=>!!(flags()&4)},targetPid:{enumerable:true,get:()=>Atomics.load(shared,4)>>>0||null},
      exitCode:{enumerable:true,get:()=>flags()&2?Atomics.load(shared,5)>>>0:null},
      error:{enumerable:true,get:()=>localError||((flags()&8)?(['','Invalid process owner protocol.','Native containment failed (Win32 '+Atomics.load(shared,7)+').',
        'Process owner disconnected; tree cleanup unconfirmed.','Process owner handshake deadline; target launch unconfirmed.','Process control unavailable.'][Atomics.load(shared,6)]||'Process owner failure.'):null),set:value=>{localError=value;}}
    });
    return {token,shared,state};
  }
  function retire(control) {Atomics.store(control.shared,9,1);post({kind:'retire',token:control.token});}
  function envValue(env, name) {
    const key = Object.keys(env).sort().find(k => k.toLowerCase() === name.toLowerCase()); return key ? env[key] : '';
  }
  function command(file, args, opts) {
    let target = String(file), argv = args.map(String), verbatim = !!opts.windowsVerbatimArguments;
    // Bound expansion before quoting/Base64 allocation, including config args.
    let inputChars=target.length;
    for(const arg of argv)inputChars+=arg.length+1;
    if(inputChars>=32767)throw Error('Process command exceeds the owned Windows launch limit; use a script file. No target was started.');
    if (opts.shell) {
      const text = [target].concat(argv).join(' ');
      target = typeof opts.shell === 'string' ? opts.shell : envValue(opts.env || process.env, 'ComSpec') || 'cmd.exe';
      if (/\bcmd(?:\.exe)?$/i.test(target)) { argv = ['/d', '/s', '/c', '"' + text + '"']; verbatim = true; }
      else argv = ['-c', text];
    }
    if (target.indexOf('\0') >= 0 || argv.some(v => v.indexOf('\0') >= 0)) throw Error('Process argument contains NUL.');
    // Resolve only executables. Batch shims must pass through explicit shell,
    // matching existing MCP shim selection and Node's exec/execFile contract.
    const env = opts.env || process.env, cwd = opts.cwd || process.cwd();
    const paths = /[\\/]/.test(target) ? [path.resolve(cwd, target)] :
      [path.join(cwd, target)].concat(String(envValue(env, 'PATH')).split(';').filter(Boolean).map(dir => path.resolve(cwd, dir.replace(/^"|"$/g, ''), target)));
    let resolved = null;
    for (const candidate of paths) {
      for (const suffix of path.extname(candidate) ? [''] : ['.exe', '.com', '']) {
        try { if (fs.statSync(candidate + suffix).isFile()) { resolved = candidate + suffix; break; } } catch (e) {}
      }
      if (resolved) break;
    }
    if (!resolved) throw Object.assign(Error('Process executable not found: ' + target), { code: 'ENOENT', path: target });
    const line = [quote(resolved)].concat(argv.map(v => verbatim ? v : quote(v))).join(' ');
    // Base64 UTF16 transport expands the command on the wrapper's own argv.
    // Refuse before spawn rather than let Windows truncate either command.
    if(line.length>=32767)throw Error('Process command exceeds the owned Windows launch limit; use a script file. No target was started.');
    const encodedFile = Buffer.from(resolved, 'utf16le').toString('base64');
    const encodedLine = Buffer.from(line, 'utf16le').toString('base64');
    if (line.length >= 32767 || encodedFile.length + encodedLine.length + helper.length + pipe.length + 128 >= 32767) {
      throw Error('Process command exceeds the owned Windows launch limit; use a script file. No target was started.');
    }
    return [encodedFile, encodedLine];
  }
  function launch(method, file, args, opts, callback) {
    assertReady();
    validate();
    if (owned.size >= 128) throw Error('Owned process limit reached (128).');
    if (opts.detached || (Array.isArray(opts.stdio) && opts.stdio.indexOf('ipc') >= 0)) {
      throw Error('Detached/IPC processes require an explicit external lifecycle; managed launch refused.');
    }
    const encoded = command(file, args, opts),control=register(false),token=control.token;
    const argv = [pipe, token].concat(encoded, [opts.windowsHide === false ? 'visible' : 'hidden']);
    // Internal broker only: skip libuv's own automatic child Job. On Win7
    // that Job would prevent the broker joining its strict self-owned Job.
    // Keep the process/stdio referenced and control pipe active; never unref.
    const nativeOptions = Object.assign({}, opts, { shell: false, windowsVerbatimArguments: false, windowsHide: true, detached:true });
    let child;
    const completed = (error, stdout, stderr) => {
      if (child && child.ownedTree && !child.ownedTree.closed && (!error || child.ownedTree.bound)) {
        const cause=error;
        error = Object.assign(Error('Process owner exited without target-group completion confirmation; command result unknown.'), { code:'EOWNERUNKNOWN',cause });
        quarantineEntry(entry,error);
      }
      if (typeof callback === 'function') callback(error, stdout, stderr);
    };
    try{child = method === 'spawn' ? raw.spawn(helper, argv, nativeOptions) : capture(raw, helper, argv, nativeOptions, completed);}
    catch(error){retire(control);throw error;}
    const nativeKill = child.kill.bind(child);
    if(child.pid)Atomics.store(control.shared,2,child.pid);
    const state = control.state;
    const entry = { child, state, control, stop: false, fallback: null };
    child.ownedTree = state;
    child.markOwnerUnknown=reason=>quarantineEntry(entry,Object.assign(Error(reason+'; Agent recovery required.'),{code:'EOWNERUNKNOWN'}));
    entry.supervision=supervise(child,state,error=>quarantineEntry(entry,error),options.supervision);
    // Sending STOP to this broker is handle-bound ownership. Never enumerate
    // saved PIDs or fall back to taskkill. Last-resort broker kill closes job.
    child.kill = function(signal) {
      if (signal === 0 || signal === '0') return nativeKill(signal);
      entry.supervision.stop();
      const exited=child.exitCode != null || child.signalCode != null;
      if (entry.stop) return !exited;
      entry.stop = true;
      if(exited)return false;
      child.killed = true;
      Atomics.store(control.shared,8,1);
      if(!(Atomics.load(control.shared,1)&16))return nativeKill(signal);
      if(!post({kind:'stop',token}))return nativeKill(signal);
      entry.fallback = setTimeout(() => { if (!state.closed) { state.error = state.error || 'Process owner stop deadline; kernel cleanup requested, result unconfirmed.'; nativeKill(); } }, 6500);
      entry.fallback.unref(); return true;
    };
    pending.set(token, entry); owned.add(entry);
    child.once('close', () => {
      entry.supervision.close();
      if(state.bound&&!state.closed)quarantineEntry(entry,Object.assign(Error('Owned target cleanup unconfirmed after broker close; Agent recovery required.'),{code:'EOWNERUNKNOWN'}));
      clearTimeout(entry.fallback); pending.delete(token); owned.delete(entry);retire(control);
    });
    child.on('error', () => {
      if (!child.pid) { entry.supervision.close();pending.delete(token); owned.delete(entry);retire(control); }
    });
    return child;
  }
  function syncResult(file,args,opts) {
    assertReady();
    validate();
    if(owned.size>=128)throw Error('Owned process limit reached (128).');
    if(opts.detached||(Array.isArray(opts.stdio)&&opts.stdio.indexOf('ipc')>=0))throw Error('Managed synchronous detached/IPC launch refused.');
    const encoded=command(file,args,opts),control=register(true);
    try {
      const argv=[pipe,control.token].concat(encoded,[opts.windowsHide===false?'visible':'hidden']);
      const result=raw.spawnSync(helper,argv,Object.assign({},opts,{shell:false,windowsVerbatimArguments:false,windowsHide:true,detached:true}));
      const observed=Atomics.load(control.shared,3)>>>0;
      result.ownedTree=Object.assign({},control.state);
      if(!result.error&&(!result.ownedTree.closed||!observed||observed!==(result.pid>>>0))){
        result.error=Object.assign(Error(result.ownedTree.error||'Synchronous process owner exited without confirmed identity/empty target group; result unknown.'),{code:'EOWNERUNKNOWN'});
      }
      return result;
    } finally { retire(control); }
  }
  function checkedSync(file,args,opts) {
    const result=syncResult(file,args,opts);
    if(result.error||result.status!==0){
      const error=result.error||Error('Command failed (exit '+result.status+'): '+file+(result.stderr?'\n'+String(result.stderr).slice(-4000):''));
      for(const key of ['pid','status','signal','output','stdout','stderr','ownedTree'])error[key]=result[key];
      throw error;
    }
    return result.stdout;
  }
  function syncOptions(opts){return typeof opts==='string'?{encoding:opts}:Object.assign({},opts||{});}
  return Object.assign({}, raw, {
    spawn(file, args, opts) { if (!Array.isArray(args)) { opts=args; args=[]; } return launch('spawn', file, args || [], opts || {}); },
    execFile(file, args, opts, callback) {
      if (!Array.isArray(args)) { callback=opts; opts=args; args=[]; }
      if (typeof opts === 'function') { callback=opts; opts={}; }
      return launch('execFile', file, args || [], opts || {}, callback);
    },
    exec(text, opts, callback) {
      if (typeof opts === 'function') { callback=opts; opts={}; }
      opts=Object.assign({}, opts || {}); opts.shell=opts.shell || true;
      return launch('execFile', text, [], opts, callback);
    },
    spawnSync(file,args,opts){if(!Array.isArray(args)){opts=args;args=[];}return syncResult(file,args||[],syncOptions(opts));},
    execFileSync(file,args,opts){if(!Array.isArray(args)){opts=args;args=[];}return checkedSync(file,args||[],syncOptions(opts));},
    execSync(text,opts){opts=syncOptions(opts);opts.shell=opts.shell||true;return checkedSync(text,[],opts);},
    spawnExternal: raw.spawn,
    assertProcessOwnerReady:assertReady,
    onProcessOwnerUnknown(handler){unknownHandler=handler;},
    processOwnerInfo() {
      let materialError=null;try{validate();}catch(error){materialError=error.message;}
      return { mode: 'windows-job-v2', proofScope:'targets-empty-before-broker-close', active: owned.size, pending: Array.from(owned).filter(e=>!(Atomics.load(e.control.shared,1)&16)).length, limit:128, materialReady:checked,
        controlReady:!!workerReady&&Atomics.load(workerReady,0)===1,
        controlErrorStack:serverError&&String(serverError.stack||'').slice(0,1000),
        recoveryRequired:!!quarantine,quarantine:quarantine&&Object.assign({},quarantine),
        readyForWork:checked&&!serverError&&!quarantine&&!Array.from(owned).some(e=>e.stop),
        stopping:Array.from(owned).filter(e=>e.stop).length,
        outputCapture:captureSnapshot(),
        unresolved:Array.from(owned).filter(e=>e.unknown).length,
        error:quarantine&&quarantine.message || materialError || serverError && serverError.message, requires:'CLR 2.0 or CLR 4; no breakaway; target runtime not probed' };
    }
  });
}
module.exports = { create, quote, validateInstallation };
