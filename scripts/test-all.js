#!/usr/bin/env node
// Run the complete offline validation set in a deterministic order.
// Set NODE_BIN to exercise the suites against another runtime (for example
// runtime/node.exe); set REAL_TEST=1 to append the opt-in endpoint suites.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const suites = [
  'runner.js', 'runner-b.js', 'runner-c.js', 'runner-d.js', 'runner-e.js',
  'runner-f.js', 'runner-g.js', 'runner-h.js', 'runner-i.js', 'runner-j.js'
];
if (process.env.REAL_TEST === '1') suites.push('runner-k.js', 'runner-r.js');
const targets = suites.map(name => ({ name, args: [path.join(ROOT, 'test', name)] }))
  .concat([
    { name: 'stream-context.js', args: [path.join(ROOT, 'test', 'stream-context.js')] },
    { name: 'repl-approval.js', args: [path.join(ROOT, 'test', 'repl-approval.js')] },
    { name: 'download-commit.js', args: [path.join(ROOT, 'test', 'download-commit.js')] },
    { name: 'text-encoding.js', args: [path.join(ROOT, 'test', 'text-encoding.js')] },
    { name: 'model-routing.js', args: [path.join(ROOT, 'test', 'model-routing.js')] },
    { name: 'pipe-lifecycle.js', args: [path.join(ROOT, 'test', 'pipe-lifecycle.js')] },
    { name: 'webui-ui-sim.js', args: [path.join(ROOT, 'test', 'webui-ui-sim.js')] },
    { name: 'webui-dom-sim.js', args: [path.join(ROOT, 'test', 'webui-dom-sim.js')] }
  ]);
if (process.env.BROWSER_TEST === '1') targets.push({name:'webui-browser.js',args:[path.join(ROOT,'test','webui-browser.js')]});

function loadBaseline() {
  const env = Object.assign({}, process.env);
  const example = path.join(ROOT, '.env.example');
  if (fs.existsSync(example)) {
    for (const line of fs.readFileSync(example, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      // Offline validation must ignore inherited product settings; retain
      // explicit caller settings only for the opt-in real-endpoint run.
      if (m && (process.env.REAL_TEST !== '1' || env[m[1]] === undefined)) env[m[1]] = m[2];
    }
  }
  // Offline suites must not depend on a developer's auto-debug setting.
  env.ENABLE_AUTO_DEBUG = 'false';
  return env;
}

const env = loadBaseline();
const failed = [];
for (const target of targets) {
  console.log('\n=== test-all: ' + target.name + ' ===');
  const result = childProcess.spawnSync(process.execPath, target.args, {
    cwd: ROOT,
    env,
    stdio: 'inherit'
  });
  if (result.error || result.status !== 0) {
    failed.push(target.name);
    console.error('FAILED: ' + target.name + (result.error ? ' (' + result.error.message + ')' : ' (exit ' + result.status + ')'));
  }
}

if (failed.length) {
  console.error('\ntest-all failed: ' + failed.join(', '));
  process.exit(1);
}
console.log('\ntest-all passed: ' + targets.length + ' target(s)');
