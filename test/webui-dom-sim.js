#!/usr/bin/env node
// webui-dom-sim.js - node-side behavioral check of webui.html's inline script.
// No jsdom needed: we extract the single <script> body, evaluate it in a vm
// sandbox with hand-rolled DOM/fetch stubs, and reach into the IIFE through a
// hook line inserted into the EXTRACTED COPY ONLY (webui.html is untouched).
// Covers:
//   AST-06  autoSaveSession first-save: no `file` in the request body, server-
//           returned file remembered via localStorage; reentry guard holds.
//   AST-07  SSE parsing: junk lines are skipped, valid deltas still render,
//           and a business error (j.error, WITHOUT 'upstream' in the message)
//           propagates to the outer .catch and is shown to the user.
// Usage: node test/webui-dom-sim.js   (exit 0 = all pass)
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const util = require('util');

const html = fs.readFileSync(path.join(__dirname, '..', 'webui.html'), 'utf8');
const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html);
if (!m) { console.error('no <script> block found'); process.exit(1); }
let src = m[1];
if (!/\}\)\(\);\s*$/.test(src.trimEnd())) { console.error('unexpected script tail'); process.exit(1); }
// hook INSIDE the IIFE so we can drive closure-private functions/state
src = src.trimEnd().replace(/\}\)\(\);$/, `
  ;__HOOK({
    setHistory: function (h) { history = h; },
    getHistory: function () { return history; },
    getSessFile: function () { return sessFile; },
    autoSaveSession: autoSaveSession,
    forgetSessFile: forgetSessFile,
    send: send
  });
})();`);

/* ---------- tiny DOM ---------- */
function escLite(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function makeEl(tag) {
  const e = {
    tagName: tag, children: [], handlers: {}, parentNode: null, style: {}, dataset: {},
    value: '', className: '', title: '', scrollTop: 0, scrollHeight: 10, _text: '', _html: ''
  };
  Object.defineProperty(e, 'textContent', { get() { return e._text; }, set(v) { e._text = String(v); e._html = escLite(v); e.children.length = 0; } });
  Object.defineProperty(e, 'innerHTML', { get() { return e._html; }, set(v) { e._html = String(v); e._text = String(v).replace(/<[^>]*>/g, ''); } });
  e.addEventListener = function (t, fn) { (e.handlers[t] = e.handlers[t] || []).push(fn); };
  e.appendChild = function (c) { e.children.push(c); c.parentNode = e; return c; };
  e.insertBefore = function (c) { e.children.unshift(c); c.parentNode = e; return c; };
  e.removeChild = function (c) { const i = e.children.indexOf(c); if (i >= 0) e.children.splice(i, 1); };
  e.remove = function () { if (e.parentNode) e.parentNode.removeChild(e); };
  e.querySelector = function () { return makeEl('div'); };
  e.querySelectorAll = function () { return []; };
  e.focus = function () {};
  e.classList = { toggle() {}, add() {}, remove() {} };
  return e;
}
const byId = {};
const documentStub = {
  getElementById: id => (byId[id] = byId[id] || makeEl('div')),
  createElement: tag => makeEl(tag),
  addEventListener() {}
};
const localStorageStub = { _m: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };

/* ---------- controllable fetch ---------- */
const routes = []; // [matchString, responder(url, opts)]
let fetchCalls = [];
function jsonResponse(obj) { return { ok: true, status: 200, json() { return Promise.resolve(JSON.parse(JSON.stringify(obj))); } }; }
function sseResponse(lines) {
  let i = 0;
  return { ok: true, status: 200, body: { getReader() { return { read() { if (i < lines.length) { const v = Buffer.from(lines[i++] + '\n\n', 'utf8'); return Promise.resolve({ done: false, value: v }); } return Promise.resolve({ done: true }); } }; } } };
}
function route(match, responder) { routes.unshift([match, responder]); } // later routes win
function fetchStub(url, opts) {
  fetchCalls.push({ url: url, opts: opts });
  for (let i = 0; i < routes.length; i++) if (url.indexOf(routes[i][0]) >= 0) return Promise.resolve(routes[i][1](url, opts));
  return Promise.resolve(jsonResponse({})); // load-time /api/info, /api/sessions ...
}

/* ---------- sandbox ---------- */
let hook = null;
const sandbox = {
  document: documentStub,
  window: { addEventListener() {} },
  localStorage: localStorageStub,
  navigator: { clipboard: { writeText() {} } },
  fetch: fetchStub,
  AbortController: function () { this.signal = {}; this.abort = function () {}; },
  TextDecoder: util.TextDecoder,
  confirm: function () { return true; },
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  console: console,
  __HOOK: h => { hook = h; }
};
vm.createContext(sandbox);
new vm.Script(src, { filename: 'webui-inline.js' }).runInContext(sandbox);
if (!hook) { console.error('hook not installed'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  :: ' + String(detail))); if (!ok) failures++; }

(async () => {
  await sleep(30); // let the load-time fetches settle

  // --- AST-06: first save has no `file`, response file is remembered ---
  hook.setHistory([{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
  hook.forgetSessFile();
  let saveBody = null;
  route('/api/sessions/save', () => { return jsonResponse({ ok: true, file: 'web-minted-1.json', turns: 2 }); });
  route('/api/sessions/save', (url, opts) => { saveBody = JSON.parse(opts.body); return jsonResponse({ ok: true, file: 'web-minted-1.json', turns: 2 }); });
  hook.autoSaveSession();
  await sleep(30);
  check('ast06: first-save request body carries messages but NO file', saveBody && Array.isArray(saveBody.messages) && saveBody.messages.length === 2 && !('file' in saveBody), JSON.stringify(saveBody));
  check('ast06: server-returned file remembered (closure + localStorage)', hook.getSessFile() === 'web-minted-1.json' && localStorageStub.getItem('7coder-sess-file') === 'web-minted-1.json', 'sessFile=' + hook.getSessFile() + ' ls=' + localStorageStub.getItem('7coder-sess-file'));

  // --- AST-06: reentry guard - a second call while a save is in flight is dropped ---
  saveBody = null; fetchCalls = [];
  let releaseSave;
  route('/api/sessions/save', () => new Promise(r => { releaseSave = r; }));
  hook.autoSaveSession();
  hook.autoSaveSession();
  await sleep(30);
  check('ast06: autoSaving guard drops concurrent re-save', fetchCalls.length === 1, 'fetch calls=' + fetchCalls.length);
  if (releaseSave) releaseSave(jsonResponse({ ok: true, file: 'web-minted-1.json' }));
  await sleep(30);

  // --- AST-07: junk line skipped, valid delta still rendered ---
  hook.forgetSessFile();
  route('/api/sessions/save', (url, opts) => { saveBody = JSON.parse(opts.body); return jsonResponse({ ok: true, file: 'web-minted-2.json' }); });
  route('/v1/chat/completions', () => sseResponse([
    'data: not-json-at-all {{{',
    'data: {"choices":[{"delta":{"content":"PART-OK"}}]}'
  ]));
  documentStub.getElementById('ta').value = 'hello';
  hook.send();
  await sleep(120);
  const hist = hook.getHistory();
  const contentEl = byId['log'] && byId['log'].children.length ? findDeep(byId['log'], e => String(e._html).indexOf('PART-OK') >= 0) : null;
  check('ast07: junk SSE line skipped, valid delta rendered', !!contentEl, 'log html=' + logHtml());
  const last = hist[hist.length - 1];
  check('ast07: assistant turn still pushed to history', last && last.role === 'assistant' && last.content === 'PART-OK', JSON.stringify(hist));
  check('ast07: follow-up autosave after reply works (first-save body again has no file)', saveBody && !('file' in saveBody), JSON.stringify(saveBody));

  // --- AST-07: business error WITHOUT 'upstream' substring reaches the user ---
  fetchCalls = [];
  route('/v1/chat/completions', () => sseResponse([
    'data: {"choices":[{"delta":{"content":"partial"}}]}',
    'data: {"error":{"message":"Max retries reached."}}'
  ]));
  documentStub.getElementById('ta').value = 'again';
  hook.send();
  await sleep(120);
  const errRow = findDeep(byId['log'], e => String(e._html).indexOf('Max retries reached') >= 0 && String(e.className).indexOf('err-msg') >= 0);
  const hist2 = hook.getHistory();
  check('ast07: non-upstream business error displayed to user (err bubble)', !!errRow, 'log html=' + logHtml());
  // rollback pops only the failed user turn ('again'); earlier turns survive
  check('ast07: failed user turn rolled back, earlier turns intact', hist2.length === 4 && !hist2.some(x => x.content === 'again') && hist2[3].content === 'PART-OK', JSON.stringify(hist2));

  // --- A2-04: an error message carrying HTML must render as TEXT (no XSS) ---
  // The err bubble used to go through innerHTML verbatim; a hostile upstream
  // (or tool error) message like an <img onerror=...> would execute. After the
  // fix err/sys bubbles are set via textContent, so the markup is escaped.
  route('/v1/chat/completions', () => sseResponse([
    'data: ' + JSON.stringify({ error: { message: '<img src=x onerror=window.__xss=1>' } })
  ]));
  documentStub.getElementById('ta').value = 'xss probe';
  hook.send();
  await sleep(120);
  const xssRow = findDeep(byId['log'], e => String(e._html).indexOf('&lt;img') >= 0 && String(e.className).indexOf('err-msg') >= 0);
  check('a204: error bubble renders the payload escaped (&lt;img, no raw <img tag)', !!xssRow && String(byId['log']._html).indexOf('<img') < 0, 'log html=' + logHtml());
  check('a204: payload never executes (window.__xss stays unset)', sandbox.window.__xss === undefined, 'window.__xss=' + sandbox.window.__xss);

  console.log('\nwebui-dom-sim: ' + (failures ? failures + ' FAILED' : 'ALL PASSED'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('harness crashed:', e); process.exit(1); });

function findDeep(el, pred) {
  if (pred(el)) return el;
  for (const c of el.children || []) { const r = findDeep(c, pred); if (r) return r; }
  return null;
}
function logHtml() { return JSON.stringify(String(byId['log']._html)).substring(0, 200); }
