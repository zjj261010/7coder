'use strict';
// Read-only delivery evidence. Literal require scanning is deliberately not a
// general JavaScript parser; package resolution is checked independently.
const fs = require('fs'), path = require('path'), Module = require('module');
const stable = value => JSON.stringify(Object.keys(value || {}).sort().map(key => [key, value[key]]));
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
function validate(s) {
  const errors = [], fail = (ok, why) => { if (!ok) errors.push(why); }, p = s.pkg, lock = s.lock, installed = s.installed;
  fail(s.errors.length === 0, 'capture errors: ' + s.errors.join('; '));
  fail(stable(p.dependencies) === stable({ axios: '^1.20.0', dotenv: '^8.2.0' }), 'direct dependency policy changed; review explicitly');
  fail(lock.lockfileVersion === 3 && lock.packages && lock.packages[''], 'missing v3 lock root');
  if (!lock.packages || !lock.packages['']) return errors;
  const root = lock.packages[''];
  fail(p.name === lock.name && p.name === root.name && p.version === lock.version && p.version === root.version, 'manifest and both lock identities differ');
  fail(stable(p.dependencies) === stable(root.dependencies), 'root dependency selectors differ');
  fail(p.bin && root.bin && path.posix.normalize(p.bin['7coder'] || '') === path.posix.normalize(root.bin['7coder'] || '') && s.binExists, 'bin missing or lock bin differs');
  const keys = Object.keys(lock.packages).filter(Boolean).sort();
  fail(stable(Object.fromEntries(keys.map(key => [key, true]))) === stable(Object.fromEntries(Object.keys(installed).map(key => [key, true]))), 'installed package inventory differs from complete lock inventory');
  for (const key of keys) {
    const expected = lock.packages[key], actual = installed[key];
    fail(/^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*node_modules\/(?:@[^/]+\/)?[^/]+$/.test(key) && !key.split('/').some(part => part === '.' || part === '..' || part.includes('\\')), 'unsafe lock package path: ' + key);
    fail(typeof expected.version === 'string' && typeof expected.integrity === 'string' && /^sha(?:1|256|384|512)-\S+$/.test(expected.integrity), 'unpinned package identity: ' + key);
    if (!actual) { fail(false, 'package missing: ' + key); continue; }
    fail(actual.name === key.split('node_modules/').pop() && actual.version === expected.version, 'installed name/version differs: ' + key);
    fail(stable(actual.dependencies) === stable(expected.dependencies), 'installed dependency selectors differ: ' + key);
  }
  const declared = [{ from: '', dependencies: p.dependencies }].concat(keys.map(key => ({ from: key, dependencies: installed[key] && installed[key].dependencies })));
  for (const source of declared) for (const name of Object.keys(source.dependencies || {})) {
    const matches = s.resolutions.filter(row => row.from === source.from && row.name === name), row = matches[0];
    fail(matches.length === 1 && row.inside === true && installed[row.target] && installed[row.target].name === name && keys.includes(row.target) &&
      Number.isSafeInteger(row.entryCount) && row.entryCount > 0 && (row.kind === 'exports' || row.kind === 'entry' && row.entryCount === 1), 'dependency entry does not resolve inside locked install: ' + source.from + ' -> ' + name);
  }
  const builtins = new Set(Module.builtinModules), foreign = new Set();
  for (const source of s.sources) {
    const re = /(?:^|[^.\w])require\(\s*['"]([^'"]+)['"]\s*\)/g; let match;
    while ((match = re.exec(source.text))) {
      const name = match[1];
      if (builtins.has(name) && !name.startsWith('node:')) continue;
      if (name.startsWith('.')) { fail(source.local[name] === true, 'local require missing/outside install: ' + source.file + ' -> ' + name); continue; }
      const top = name[0] === '@' ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]; foreign.add(top);
      fail(Object.prototype.hasOwnProperty.call(p.dependencies, top) && !name.startsWith('node:'), 'undeclared or Node13-unsupported literal import: ' + source.file + ' -> ' + name);
    }
  }
  fail(s.sources.some(source => source.file === 'index.js') && foreign.has('axios') && foreign.has('dotenv'), 'entrypoint/source dependency evidence missing');
  return errors;
}
function capture(root) {
  root = path.resolve(root);
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const pkg = read(path.join(root, 'package.json')), lock = read(path.join(root, 'package-lock.json'));
  const errors = [], installed = Object.create(null), sources = [], resolutions = [];
  function packages(dir, depth) {
    if (depth > 8 || Object.keys(installed).length > 512) throw Error('G5 package inventory budget');
    for (const name of fs.readdirSync(dir).sort()) {
      if (Object.keys(installed).length >= 512) throw Error('G5 package inventory budget');
      if (name.startsWith('.')) continue;
      const folder = path.join(dir, name), stat = fs.lstatSync(folder);
      if (stat.isSymbolicLink()) { errors.push('linked package outside standalone contract: ' + path.relative(root, folder)); continue; }
      if (!stat.isDirectory()) continue;
      if (name.startsWith('@')) { packages(folder, depth + 1); continue; }
      const key = path.relative(root, folder).split(path.sep).join('/');
      try { installed[key] = read(path.join(folder, 'package.json')); } catch (error) { errors.push(key + ': ' + error.code); }
      if (fs.existsSync(path.join(folder, 'node_modules'))) packages(path.join(folder, 'node_modules'), depth + 1);
    }
  }
  packages(path.join(root, 'node_modules'), 0);
  const roots = Object.keys(installed).sort((a, b) => b.length - a.length);
  for (const from of [''].concat(roots)) {
    const requireHere = Module.createRequire(path.join(root, from, 'package.json')), deps = from ? installed[from].dependencies : pkg.dependencies;
    for (const name of Object.keys(deps || {})) {
      try {
        let entries, kind = 'entry';
        try { entries = [requireHere.resolve(name)]; }
        catch (error) {
          if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
          // Some valid packages have main:false and only public subpath
          // exports. Resolve every concrete public export, not an invented
          // bare entry and not merely the existence of package.json.
          const metadata = read(requireHere.resolve(name + '/package.json'));
          const exports = metadata.exports && typeof metadata.exports === 'object' ? Object.keys(metadata.exports).filter(key => key.startsWith('./') && key !== './package.json') : [];
          if (!exports.length || exports.some(key => key.includes('*'))) throw error;
          entries = exports.map(key => requireHere.resolve(name + key.slice(1))); kind = 'exports';
        }
        const target = roots.find(key => inside(path.join(root, key), entries[0]));
        resolutions.push({ from, name, target, kind, entryCount: entries.length, inside: !!target && entries.every(entry => inside(path.join(root, target), entry) && fs.statSync(entry).isFile()) });
      } catch (error) { errors.push(from + ' -> ' + name + ': ' + error.code); }
    }
  }
  function source(file) {
    const text = fs.readFileSync(path.join(root, file), 'utf8'), local = Object.create(null), requireHere = Module.createRequire(path.join(root, file));
    const re = /(?:^|[^.\w])require\(\s*['"](\.[^'"]*)['"]\s*\)/g; let match;
    while ((match = re.exec(text))) { try { const resolved = requireHere.resolve(match[1]); local[match[1]] = inside(root, resolved) && fs.statSync(resolved).isFile(); } catch (error) { local[match[1]] = false; } }
    sources.push({ file, text, local });
  }
  source('index.js');
  for (const file of fs.readdirSync(path.join(root, 'lib')).sort()) {
    const stat = fs.lstatSync(path.join(root, 'lib', file));
    if (stat.isSymbolicLink() || stat.isDirectory()) { errors.push('lib layout changed; extend source audit: ' + file); continue; }
    if (file.endsWith('.js')) source('lib/' + file);
  }
  const bin = pkg.bin && pkg.bin['7coder'];
  return { pkg, lock, installed, resolutions, sources, errors, binExists: typeof bin === 'string' && inside(root, path.resolve(root, bin)) && fs.existsSync(path.resolve(root, bin)) };
}
module.exports = { capture, validate };
