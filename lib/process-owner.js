'use strict';
// Windows-only adapter. ChildProcess remains the broker handle (including
// .pid); ownedTree.targetPid is diagnostic, never a signal target.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), net = require('net');

function quote(arg) {
  return '"' + String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
function validateInstallation(root) {
  const folder=path.join(root,'native'), helper=path.join(folder,'process-owner.exe');
  const manifestFile=path.join(folder,'process-owner.json');
  if(fs.statSync(manifestFile).size>4096 || fs.statSync(helper).size>128*1024) throw Error('Process owner material exceeds its installation limit.');
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(manifest.protocol!==1 || manifest.file!=='process-owner.exe' ||
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
  let server = null, serverError = null, checked = false;
  function validate() {
    if (checked) return;
    validateInstallation(root);
    checked = true;
  }
  function listen() {
    if (serverError) throw serverError;
    if (server) return;
    server = net.createServer(socket => {
      socket.unref(); socket.setEncoding('ascii'); socket.setTimeout(15000, () => socket.destroy());
      let text = '', entry = null;
      socket.on('error', () => {});
      socket.on('data', fragment => {
        if (text.length + fragment.length > 1024) { socket.destroy(); return; }
        text += fragment;
        let at;
        while ((at = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, at); text = text.slice(at + 1);
          if (!entry) {
            const hello = /^HELLO ([a-f0-9]{48}) (\d+)$/.exec(line);
            entry = hello && pending.get(hello[1]);
            if (!entry || entry.socket || entry.child.pid !== Number(hello[2])) { entry = null; socket.destroy(); return; }
            pending.delete(hello[1]); entry.socket = socket; clearTimeout(entry.timer);
            socket.setTimeout(0);
            socket.write(entry.stop ? 'STOP\n' : 'START\n');
          } else if (/^READY \d+$/.test(line) && !entry.state.bound) {
            entry.state.targetPid = Number(line.slice(6)); entry.state.bound = true;
            socket.write(entry.stop ? 'STOP\n' : 'GO\n');
          } else if (/^(EXIT|STOPPED) \d+$/.test(line) && entry.state.bound) {
            entry.state.closed = true; entry.state.exitCode = Number(line.split(' ')[1]);
            entry.state.stopped = line.indexOf('STOPPED ') === 0;
            clearTimeout(entry.fallback);
            socket.write('ACK\n');
          } else if (/^ERROR \d+$/.test(line)) {
            entry.state.error = 'Native containment failed (Win32 ' + line.slice(6) + ').';
          } else { entry.state.error = 'Invalid process owner protocol.'; socket.destroy(); return; }
        }
      });
      socket.on('close', () => {
        if (entry && !entry.state.closed) entry.state.error = entry.state.error || 'Process owner disconnected; tree cleanup unconfirmed.';
      });
    });
    server.maxConnections = 256;
    server.on('error', error => { serverError = error; for (const entry of owned) entry.child.kill(); });
    server.listen(pipe); server.unref();
  }
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
      [path.join(cwd, target)].concat(String(envValue(env, 'PATH')).split(';').filter(Boolean).map(dir => path.join(dir.replace(/^"|"$/g, ''), target)));
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
    validate(); listen();
    if (owned.size >= 128) throw Error('Owned process limit reached (128).');
    if (opts.detached || (Array.isArray(opts.stdio) && opts.stdio.indexOf('ipc') >= 0)) {
      throw Error('Detached/IPC processes require an explicit external lifecycle; managed launch refused.');
    }
    const encoded = command(file, args, opts), token = crypto.randomBytes(24).toString('hex');
    const argv = [pipe, token].concat(encoded, [opts.windowsHide === false ? 'visible' : 'hidden']);
    const nativeOptions = Object.assign({}, opts, { shell: false, windowsVerbatimArguments: false, windowsHide: true });
    let child;
    const completed = (error, stdout, stderr) => {
      if (!error && child && child.ownedTree && !child.ownedTree.closed) {
        error = Object.assign(Error('Process owner exited without empty-job confirmation; command result unknown.'), { code:'EOWNERUNKNOWN' });
      }
      if (typeof callback === 'function') callback(error, stdout, stderr);
    };
    child = method === 'spawn' ? raw.spawn(helper, argv, nativeOptions) : raw.execFile(helper, argv, nativeOptions, completed);
    const nativeKill = child.kill.bind(child);
    const state = { bound: false, closed: false, stopped: false, targetPid: null, exitCode: null, error: null };
    const entry = { child, state, stop: false, socket: null, timer: null, fallback: null };
    child.ownedTree = state;
    // Sending STOP to this broker is handle-bound ownership. Never enumerate
    // saved PIDs or fall back to taskkill. Last-resort broker kill closes job.
    child.kill = function(signal) {
      if (signal === 0 || signal === '0') return nativeKill(signal);
      if (child.exitCode != null || child.signalCode != null) return false;
      if (entry.stop) return true;
      entry.stop = true; child.killed = true;
      if (entry.socket && !entry.socket.destroyed) entry.socket.write('STOP\n');
      else if (!entry.socket) return nativeKill(signal);
      entry.fallback = setTimeout(() => { if (!state.closed) { state.error = state.error || 'Process owner stop deadline; kernel cleanup requested, result unconfirmed.'; nativeKill(); } }, 6500);
      entry.fallback.unref(); return true;
    };
    pending.set(token, entry); owned.add(entry);
    entry.timer = setTimeout(() => { state.error = 'Process owner handshake deadline; target launch unconfirmed.'; child.kill(); }, 15000);
    entry.timer.unref();
    child.once('close', () => {
      clearTimeout(entry.timer); clearTimeout(entry.fallback); pending.delete(token); owned.delete(entry);
      if (entry.socket) entry.socket.destroy();
    });
    child.on('error', () => {
      if (!child.pid) { clearTimeout(entry.timer); pending.delete(token); owned.delete(entry); }
    });
    return child;
  }
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
    spawnExternal: raw.spawn,
    processOwnerInfo() {
      let materialError=null;try{validate();}catch(error){materialError=error.message;}
      return { mode: 'windows-job-v1', active: owned.size, pending: pending.size, limit:128, materialReady:checked,
        error:materialError || serverError && serverError.message, requires:'CLR 2.0 or CLR 4; no breakaway; target runtime not probed' };
    }
  });
}
module.exports = { create, quote, validateInstallation };
