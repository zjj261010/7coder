'use strict';
const assert = require('assert'), { validate } = require('./_g-supply-audit'); let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const clone = value => JSON.parse(JSON.stringify(value));
const pkg = { name: 'g5-fixture', version: '1.0.0', dependencies: { axios: '^1.20.0', dotenv: '^8.2.0' }, bin: { '7coder': './index.js' } };
const installed = { 'node_modules/axios': { name: 'axios', version: '1.20.0', dependencies: { 'follow-redirects': '^1.16.0' } }, 'node_modules/dotenv': { name: 'dotenv', version: '8.6.0' }, 'node_modules/follow-redirects': { name: 'follow-redirects', version: '1.16.0' } };
const packages = { '': { ...clone(pkg), bin: { '7coder': 'index.js' } } }; for (const key of Object.keys(installed)) packages[key] = { ...clone(installed[key]), integrity: 'sha512-fixture' };
const snapshot = { pkg, lock: { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages }, installed,
  sources: [{ file: 'index.js', text: 'require("axios"); require("dotenv"); require("./lib/helper");', local: { './lib/helper': true } }, { file: 'lib/helper.js', text: 'require("fs");require("worker_threads");', local: {} }],
  resolutions: [{ from: '', name: 'axios', target: 'node_modules/axios', inside: true, kind: 'entry', entryCount: 1 }, { from: '', name: 'dotenv', target: 'node_modules/dotenv', inside: true, kind: 'entry', entryCount: 1 }, { from: 'node_modules/axios', name: 'follow-redirects', target: 'node_modules/follow-redirects', inside: true, kind: 'entry', entryCount: 1 }], errors: [], binExists: true };
function rejects(label, mutate) { const s = clone(snapshot); mutate(s); check(label, validate(s).length > 0); }
function exportChecks() {
  check('ordinary locked entrypoints still accepted', validate(snapshot).length === 0);
  const exported = clone(snapshot); exported.resolutions[2].kind = 'exports'; exported.resolutions[2].entryCount = 2;
  check('concrete nonempty public subpath-only exports accepted', validate(exported).length === 0);
  rejects('metadata alone without an actual exported entry is rejected', s => { s.resolutions[2].kind = 'exports'; s.resolutions[2].entryCount = 0; });
  rejects('invented unrecognized resolution mode is rejected', s => s.resolutions[2].kind = 'package-json-only');
  rejects('multiple entries cannot masquerade as single bare entry', s => s.resolutions[2].entryCount = 2);
  rejects('exported entry outside its locked package is rejected', s => { s.resolutions[2].kind = 'exports'; s.resolutions[2].inside = false; });
}
if (process.env.G_SUPPLY_ORACLES_ONLY === 'exports') exportChecks();
else {
check('complete literal sources lock metadata and installed graph accepted', validate(snapshot).length === 0);
rejects('root lock version drift is rejected', s => s.lock.packages[''].version = '2');
rejects('top-level lock version drift is rejected', s => s.lock.version = '2');
rejects('dependency selectors drift is rejected', s => s.lock.packages[''].dependencies.axios = '^2');
rejects('undeclared new direct dependency requires review', s => s.pkg.dependencies.extra = '1');
rejects('missing lock root is rejected', s => delete s.lock.packages['']);
rejects('missing installed transitive package is rejected', s => delete s.installed['node_modules/follow-redirects']);
rejects('unlocked extra installed package is rejected', s => s.installed['node_modules/extra'] = { name: 'extra', version: '1' });
rejects('correct package version under wrong name is rejected', s => s.installed['node_modules/axios'].name = 'other');
rejects('installed version mismatch is rejected', s => s.installed['node_modules/axios'].version = '1.20.1');
rejects('changed installed transitive selector is rejected', s => s.installed['node_modules/axios'].dependencies['follow-redirects'] = '^99');
rejects('missing pin integrity metadata is rejected', s => delete s.lock.packages['node_modules/axios'].integrity);
rejects('unsafe lock package path is rejected', s => s.lock.packages['node_modules/../outside'] = { version: '1', integrity: 'sha512-fixture' });
rejects('missing real resolved dependency edge is rejected', s => s.resolutions.pop());
rejects('global or ancestor fallback outside delivery is rejected', s => s.resolutions[2].inside = false);
rejects('resolution to different locked package cannot pass', s => s.resolutions[2].target = 'node_modules/dotenv');
rejects('duplicate resolution evidence cannot pass', s => s.resolutions.push(s.resolutions[0]));
rejects('new literal third-party import in helper cannot pass entry-only audit', s => s.sources[1].text += 'require("extra");');
rejects('Node13-unsupported node-prefix builtin cannot pass generic builtin exemption', s => s.sources[1].text += 'require("node:fs");');
rejects('missing or escaped local helper cannot pass', s => s.sources[0].local['./lib/helper'] = false);
rejects('missing entrypoint source evidence is rejected', s => s.sources.shift());
rejects('missing CLI bin cannot pass manifest identity alone', s => s.binExists = false);
rejects('lock CLI bin target drift is rejected', s => s.lock.packages[''].bin['7coder'] = 'other.js');
rejects('linked unreadable or oversized capture cannot pass empty inventory errors', s => s.errors.push('linked package'));
exportChecks();
}
console.log('G/SUPPLY/ORACLES ' + checks + '/' + checks);
