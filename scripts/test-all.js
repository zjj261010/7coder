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
    { name: 'text-budget.js', args: [path.join(ROOT, 'test', 'text-budget.js')] },
    { name: 'model-routing.js', args: [path.join(ROOT, 'test', 'model-routing.js')] },
    { name: 'pipe-lifecycle.js', args: [path.join(ROOT, 'test', 'pipe-lifecycle.js')] },
    { name: 'state-store.js', args: [path.join(ROOT, 'test', 'state-store.js')] },
    { name: 'state-budget.js', args: [path.join(ROOT, 'test', 'state-budget.js')] },
    { name: 'workspace-lease.js', args: [path.join(ROOT, 'test', 'workspace-lease.js')] },
    { name: 'execution-cancel.js', args: [path.join(ROOT, 'test', 'execution-cancel.js')] },
    { name: 'tool-cancellation.js', args: [path.join(ROOT, 'test', 'tool-cancellation.js')] },
    { name: 'auxiliary-lifecycle.js', args: [path.join(ROOT, 'test', 'auxiliary-lifecycle.js')] },
    { name: 'debug-lifecycle.js', args: [path.join(ROOT, 'test', 'debug-lifecycle.js')] },
    { name: 'task-lifecycle.js', args: [path.join(ROOT, 'test', 'task-lifecycle.js')] },
    { name: 'task-budget.js', args: [path.join(ROOT, 'test', 'task-budget.js')] },
    { name: 'queue-admission.js', args: [path.join(ROOT, 'test', 'queue-admission.js')] },
    { name: 'startup-readiness.js', args: [path.join(ROOT, 'test', 'startup-readiness.js')] },
    { name: 'shell-scope.js', args: [path.join(ROOT, 'test', 'shell-scope.js')] },
    { name: 'shell-deadline.js', args: [path.join(ROOT, 'test', 'shell-deadline.js')] },
    { name: 'test-runtime.js', args: [path.join(ROOT, 'test', 'test-runtime.js')] },
    { name: 'git-status-columns.js', args: [path.join(ROOT, 'test', 'git-status-columns.js')] },
    { name: 'path-boundaries.js', args: [path.join(ROOT, 'test', 'path-boundaries.js')] },
    { name: 'scan-budget.js', args: [path.join(ROOT, 'test', 'scan-budget.js')] },
    { name: 'cron-identity.js', args: [path.join(ROOT, 'test', 'cron-identity.js')] },
    { name: 'runtime-diagnostics.js', args: [path.join(ROOT, 'test', 'runtime-diagnostics.js')] },
    { name: 'powershell-encoding.js', args: [path.join(ROOT, 'test', 'powershell-encoding.js')] },
    { name: 'session-continuity.js', args: [path.join(ROOT, 'test', 'session-continuity.js')] },
    { name: 'approval-lifecycle.js', args: [path.join(ROOT, 'test', 'approval-lifecycle.js')] },
    { name: 'permission-restart.js', args: [path.join(ROOT, 'test', 'permission-restart.js')] },
    { name: 'browser-baseline.js', args: [path.join(ROOT, 'test', 'browser-baseline.js')] },
    { name: 'tool-results-complete.js', args: [path.join(ROOT, 'test', 'tool-results-complete.js')] },
    { name: 'tool-prerequisites.js', args: [path.join(ROOT, 'test', 'tool-prerequisites.js')] },
    { name: 'session-ownership.js', args: [path.join(ROOT, 'test', 'session-ownership.js')] },
    { name: 'grep-deadline.js', args: [path.join(ROOT, 'test', 'grep-deadline.js')] },
    { name: 'tool-step-limit.js', args: [path.join(ROOT, 'test', 'tool-step-limit.js')] },
    { name: 'review-oracles.js', args: [path.join(ROOT, 'test', 'review-oracles.js')] },
    { name: 'mock-protocol.js', args: [path.join(ROOT, 'test', 'mock-protocol.js')] },
    { name: 'endpoint-oracles.js', args: [path.join(ROOT, 'test', 'endpoint-oracles.js')] },
    { name: 'tool-correlation.js', args: [path.join(ROOT, 'test', 'tool-correlation.js')] },
    { name: 'tool-batch.js', args: [path.join(ROOT, 'test', 'tool-batch.js')] },
    { name: 'read-window.js', args: [path.join(ROOT, 'test', 'read-window.js')] },
    { name: 'mcp-budget.js', args: [path.join(ROOT, 'test', 'mcp-budget.js')] },
    { name: 'model-response-budget.js', args: [path.join(ROOT, 'test', 'model-response-budget.js')] },
    { name: 'vision-budget.js', args: [path.join(ROOT, 'test', 'vision-budget.js')] },
    { name: 'tool-http-budget.js', args: [path.join(ROOT, 'test', 'tool-http-budget.js')] },
    { name: 'html-deadline.js', args: [path.join(ROOT, 'test', 'html-deadline.js')] },
    { name: 'config-admission.js', args: [path.join(ROOT, 'test', 'config-admission.js')] },
    { name: 'permission-wildcard.js', args: [path.join(ROOT, 'test', 'permission-wildcard.js')] },
    { name: 'glob-deadline.js', args: [path.join(ROOT, 'test', 'glob-deadline.js')] },
    { name: 'debug-prerequisites.js', args: [path.join(ROOT, 'test', 'debug-prerequisites.js')] },
    { name: 'tool-result-evidence.js', args: [path.join(ROOT, 'test', 'tool-result-evidence.js')] },
    { name: 'git-snapshot-retention.js', args: [path.join(ROOT, 'test', 'git-snapshot-retention.js')] },
    { name: 'webui-ui-sim.js', args: [path.join(ROOT, 'test', 'webui-ui-sim.js')] },
    { name: 'webui-dom-sim.js', args: [path.join(ROOT, 'test', 'webui-dom-sim.js')] }
  ]);
if (process.platform === 'win32') targets.push({ name: 'task-windows.js', args: [path.join(ROOT, 'test', 'task-windows.js')] });
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
