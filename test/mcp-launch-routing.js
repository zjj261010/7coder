'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm'),{EventEmitter}=require('events'),{PassThrough}=require('stream');
const source=fs.readFileSync(path.resolve(__dirname,'../index.js'),'utf8');let checks=0;
const scope=process.env.MCP_LAUNCH_ROUTING_SCOPE||'all';assert.ok(['all','path-order'].includes(scope),'known MCP launch routing scope');const expected=scope==='all'?15:1;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==expected){console.error('MCP/LAUNCH incomplete '+checks+'/'+expected);process.exitCode=1;}});
function cut(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start,a);return source.slice(start,end);}
function fixture(files,env={PATH:'R:\\bin'}){
  const table=new Map(files.map(file=>[file.toLowerCase(),'file'])),probes=[],ctx=vm.createContext({path:path.win32,process:{platform:'win32',execPath:'S:\\app\\node.exe',env,cwd:()=> 'D:\\work root'},
    fs:{statSync(file){probes.push(file);const type=table.get(file.toLowerCase());if(!type)throw Error('not found');return {isFile:()=>type==='file'};}}});
  vm.runInContext(cut('function resolveCommandOnWindows(','function createMcpStdioClient('),ctx);return {ctx,table,probes,resolve:cmd=>ctx.resolveCommandOnWindows(cmd,env,'D:\\work root')};
}
let f;
if(scope==='all'){
f=fixture(['R:\\bin\\python.exe']);check('bare ordinary executable preserves no-shell argv',f.resolve('python')===false);
f=fixture(['R:\\bin\\shim.cmd']);check('bare batch-only command retains shell fallback',f.resolve('shim')===true);
f=fixture(['R:\\bin\\shim.cmd']);check('explicit batch extension is detected without appending another suffix',f.resolve('shim.cmd')===true);
f=fixture(['R:\\bin\\worker.com']);check('COM executable is not mistaken for a batch shim',f.resolve('worker')===false);
f=fixture(['D:\\work root\\shim.bat'],{});check('effective cwd is searched for a batch shim even with empty PATH',f.resolve('shim')===true);
f=fixture(['R:\\bin space\\shim.cmd'],{Path:'"R:\\bin space"'});check('quoted mixed-case PATH is honored for shim discovery',f.resolve('shim')===true);
f=fixture(['R:\\relative root\\bin\\shim.cmd'],{PATH:'bin'});check('relative PATH entries resolve under effective child cwd',f.ctx.resolveCommandOnWindows('shim',{PATH:'bin'},'R:\\relative root')===true);
}
f=fixture(['R:\\first\\same.cmd','R:\\later\\same.exe'],{PATH:'R:\\first;R:\\later'});check('first usable shim preserves PATH precedence without probing a later network/executable location',f.resolve('same')===true&&!f.probes.some(file=>file.startsWith('R:\\later')));
if(scope==='all'){
f=fixture(['R:\\bin\\shim.cmd']);f.table.set('r:\\bin\\shim.exe','directory');check('directory named exe cannot hide a usable shim',f.resolve('shim')===true);
f=fixture(['R:\\bin\\node.cmd']);check('bundled Node special case retains its existing no-shell selection',f.resolve('node')===false);
f=fixture(['R:\\bin\\shim.cmd']);check('explicit Windows paths retain direct-launch compatibility',f.resolve('R:\\bin\\shim.cmd')===false);
f=fixture([]);f.ctx.process.platform='linux';check('non-Windows never enters cmd fallback',f.resolve('shim')===false);
f=fixture(['R:\\bin\\shim.cmd']);check('missing command is left to normal executable error diagnostics',f.resolve('missing')===false);

function environment(platform){let seen;const child=new EventEmitter();for(const key of ['stdin','stdout','stderr'])child[key]=new PassThrough();child.kill=()=>true;
  const ctx=vm.createContext({Buffer,process:{platform,env:{Path:'PARENT',OtherCase:'old'}},launchDir:'workspace',MCP_MAX_FRAME_BYTES:4*1024*1024,mcpClients:{},console:{warn(){}},setTimeout,clearTimeout,
    child_process:{spawn(file,args,options){seen=options;return child;}},resolveCommandOnWindows(file,env,cwd){assert.ok(env&&cwd==='child cwd');return false;}});
  vm.runInContext(cut('function createMcpStdioClient(','function getMcpClient('),ctx);
  const cfg={command:'fixture',cwd:'child cwd',env:{PATH:'CHILD',othercase:'new'}},client=ctx.createMcpStdioClient('fixture',cfg);client.dispose();return {seen,cfg};
}
let e=environment('win32');check('Windows config overrides replace case-insensitive parent keys before both lookup and spawn',e.seen.env.PATH==='CHILD'&&e.seen.env.othercase==='new'&&!('Path'in e.seen.env)&&!('OtherCase'in e.seen.env)&&e.cfg.env.PATH==='CHILD');
e=environment('linux');check('POSIX environment preserves distinct case-sensitive keys',e.seen.env.Path==='PARENT'&&e.seen.env.PATH==='CHILD'&&e.seen.env.OtherCase==='old'&&e.seen.env.othercase==='new');
}
console.log('MCP/LAUNCH '+checks+'/'+expected+'; scope='+scope+'; actual lookup/environment code, virtual files and handles; no OS process or write');
