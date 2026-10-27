'use strict';
// Runs in a supervised Node child. Blocking filesystem probes never execute
// on the Agent event loop; no shell/where output or host-codepage decoding.
const fs=require('fs'),path=require('path');
function discover(env,io,paths){
  io=io||fs;paths=paths||path;
  const keys=Object.keys(env).sort(),value=name=>{const key=keys.find(k=>k.toLowerCase()===name.toLowerCase());return key?String(env[key]):'';};
  const issues=new Set(),seen=new Set();let probes=0;
  function stat(file,directory){
    if(++probes>1024)throw Error('Bash discovery probe budget exceeded');
    if(file.length>32767||file.indexOf('\0')>=0)throw Error('Bash discovery path budget exceeded');
    try{const result=io.statSync(file);return directory?result.isDirectory():result.isFile();}
    catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR'&&issues.size<16)issues.add(String(e.code||'IO_ERROR'));return false;}
  }
  function candidate(input){
    const file=paths.resolve(input),key=file.toLowerCase();if(seen.has(key))return null;seen.add(key);
    if(!stat(file,false))return null;
    let bash=file;
    if(/[\\/]bin[\\/]bash\.exe$/i.test(bash)&&!/[\\/]usr[\\/]bin[\\/]bash\.exe$/i.test(bash)){
      const direct=paths.resolve(paths.dirname(bash),'..','usr','bin','bash.exe');if(stat(direct,false))bash=direct;
    }
    const prefix=[];let msystem='';
    if(/[\\/]usr[\\/]bin[\\/]bash\.exe$/i.test(bash)){
      const root=paths.resolve(paths.dirname(bash),'..','..');
      for(const dir of [paths.dirname(bash),paths.join(root,'cmd')])if(stat(dir,true))prefix.push(dir);
      for(const system of ['MINGW64','MINGW32','UCRT64']){const dir=paths.join(root,system.toLowerCase(),'bin');if(stat(dir,true)){prefix.push(dir);msystem=system;break;}}
    }
    return {version:1,bash,prefix,msystem,incomplete:false};
  }
  const known=[];
  for(const base of [value('ProgramFiles'),value('ProgramFiles(x86)'),value('LOCALAPPDATA')&&paths.join(value('LOCALAPPDATA'),'Programs')]){
    if(base)known.push(paths.join(base,'Git','bin','bash.exe'),paths.join(base,'Git','usr','bin','bash.exe'));
  }
  known.push('C:\\Program Files\\Git\\bin\\bash.exe');
  for(const file of known){const result=candidate(file);if(result)return result;}
  // A valid explicit PATH wins before potentially disconnected mapped drives.
  const inherited=value('PATH');if(inherited.length>32768)throw Error('Bash discovery PATH budget exceeded');
  const dirs=inherited.split(';');if(dirs.length>256)throw Error('Bash discovery PATH entry budget exceeded');
  for(const item of dirs){let dir=item.trim().replace(/^"(.*)"$/,'$1');if(!dir)continue;dir=dir.replace(/%([^%]+)%/g,(whole,name)=>value(name)||whole);const result=candidate(paths.join(dir,'bash.exe'));if(result)return result;}
  for(const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ'){
    const drive=letter+':\\';if(!stat(drive,true))continue;
    for(const suffix of ['Program Files\\Git\\bin\\bash.exe','Program Files\\Git\\usr\\bin\\bash.exe','Git\\bin\\bash.exe']){const result=candidate(paths.join(drive,suffix));if(result)return result;}
  }
  return {version:1,bash:null,prefix:[],msystem:'',incomplete:issues.size>0,issues:Array.from(issues)};
}
if(require.main===module){
  try{const result=JSON.stringify(discover(process.env));if(Buffer.byteLength(result,'utf8')>65536)throw Error('Bash discovery result budget exceeded');process.stdout.write(result);}
  catch(error){console.error('Bash discovery failed: '+error.message);process.exitCode=1;}
}
module.exports={discover};
