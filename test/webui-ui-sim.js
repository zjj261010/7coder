#!/usr/bin/env node
// Dependency-free behavior tests for the UI. DOM stubs do not validate browser layout.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const util = require('util');
const html = fs.readFileSync(require('path').join(__dirname, '..', 'webui.html'), 'utf8');
const source = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1].replace(/\}\)\(\);\s*$/, `
  __HOOK({ send: send, setBusy: setBusy, load: loadSessionFile, refreshInfo: refreshInfo,
    refreshSessions: refreshSessions, autoSave: autoSaveSession, renderSessions: renderSessions,
    setHistory: function (h) { history = h; }, history: function () { return history; },
    setSessions: function (s) { sessions = s; }, session: function () { return sessFile; },
    readJSON: readJSON, restore: restoreSession });
})();`);
function harness(options) {
  options = options || {};
  const ids = {}, docHandlers = {}, calls = [], routes = [], storage = Object.assign({}, options.storage);
  let hook;
  const document = { activeElement: null, getElementById: id => ids[id] || null, addEventListener: (k, f) => { docHandlers[k] = f; } };
  function el(tag) {
    const e = { tagName: tag.toUpperCase(), children: [], parentNode: null, style: {}, dataset: {}, attrs: {}, handlers: {}, value: '', className: '', disabled: false, scrollHeight: 50, offsetParent: {}, _html: '', _text: '' };
    e.setAttribute = (k,v) => { e.attrs[k] = String(v); if (k === 'class') e.className = String(v); if (k === 'id') ids[v] = e; };
    e.getAttribute = k => e.attrs[k] || null;
    e.appendChild = c => { if (c.parentNode) c.remove(); c.parentNode = e; e.children.push(c); return c; };
    e.remove = () => { if (e.parentNode) { e.parentNode.children = e.parentNode.children.filter(c => c !== e); e.parentNode = null; } };
    e.insertBefore = (c, before) => { const i = e.children.indexOf(before); if (c.parentNode) c.remove(); c.parentNode = e; e.children.splice(i < 0 ? 0 : i, 0, c); };
    e.addEventListener = (k,f) => { (e.handlers[k] = e.handlers[k] || []).push(f); };
    e.fire = (k, event) => { const data = Object.assign({ preventDefault() {}, stopPropagation() {} }, event); (e.handlers[k] || []).forEach(f => f(data)); };
    e.focus = () => { document.activeElement = e; };
    e.contains = child => child === e || e.children.some(c => c.contains(child));
    e.classList = { toggle(c, enabled) { const items = e.className.split(/\s+/).filter(Boolean); const on = enabled === undefined ? !items.includes(c) : enabled; e.className = items.filter(x => x !== c).concat(on ? [c] : []).join(' '); }, contains(c) { return e.className.split(/\s+/).includes(c); } };
    function matches(node, selector) { return selector[0] === '.' ? node.classList.contains(selector.slice(1)) : selector === '[tabindex="0"]' ? node.tabIndex === 0 : node.tagName.toLowerCase() === selector; }
    e.querySelectorAll = s => { const result = []; function walk(n) { n.children.forEach(c => { if (s.split(',').some(t => matches(c, t.trim()))) result.push(c); walk(c); }); } walk(e); return result; };
    e.querySelector = s => e.querySelectorAll(s)[0] || null;
    function clear() { e.children.forEach(c => { c.parentNode = null; }); e.children = []; }
    Object.defineProperty(e, 'textContent', { get: () => e._text + e.children.map(c => c.textContent).join(''), set(v) { clear(); e._text = String(v); e._html = String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); } });
    Object.defineProperty(e, 'innerHTML', { get: () => e._html, set(v) { clear(); e._text = ''; e._html = String(v); parse(String(v),e); } });
    Object.defineProperty(e, 'lastChild', { get: () => e.children[e.children.length - 1] });
    return e;
  }
  function parse(markup, root) {
    const stack = [root];
    (markup.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []).forEach(token => {
      if (/^<!/.test(token)) return;
      if (/^<\//.test(token)) { if (stack.length > 1) stack.pop(); return; }
      if (token[0] !== '<') { stack[stack.length - 1]._text += token; return; }
      const tag = /^<([\w-]+)/.exec(token); if (!tag) return;
      const node = el(tag[1]);
      const attrs = token.slice(tag[0].length).matchAll(/([\w-]+)(?:="([^"]*)")?/g);
      for (const a of attrs) node.setAttribute(a[1], a[2] === undefined ? '' : a[2]);
      if ('disabled' in node.attrs) node.disabled = true;
      stack[stack.length - 1].appendChild(node);
      if (!/\/$/.test(token.slice(0,-1)) && !/^(input|meta|link|br|hr)$/.test(tag[1])) stack.push(node);
    });
  }
  document.body = el('body'); document.createElement = el;
  parse(html.split('<body>')[1].split('<script>')[0], document.body);
  const media = { matches: !!options.mobile, addEventListener(k,f) { this.change = f; }, addListener(f) { this.change = f; } };
  const response = (body, status) => ({ ok: !status || status < 400, status: status || 200, json: () => Promise.resolve(body) });
  const defaults = { '/api/info': { workspace: 'D:\\workspace\\7coder', models: ['test-model'], model: 'test-model', mode: 'default', version: 'test' }, '/api/sessions': { sessions: [] }, '/api/todos': { todos: [] }, '/api/settings': { model: 'test-model', profiles: {} } };
  function fetch(url, opts) {
    calls.push({ url, opts: opts || {} });
    const route = routes.find(r => r[0] === url); if (route) return Promise.resolve(route[1](opts || {}));
    if (url === '/v1/chat/completions') return Promise.resolve({ ok: true, body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) } });
    return Promise.resolve(response(defaults[url] || {}));
  }
  const sandbox = { document, window: { matchMedia: () => media }, fetch, navigator: { clipboard: { writeText: () => Promise.resolve() } },
    localStorage: { getItem: k => { if (options.blockStorage) throw Error('blocked'); return storage[k] || null; }, setItem: (k,v) => { if (options.blockStorage) throw Error('blocked'); storage[k] = String(v); }, removeItem: k => { delete storage[k]; } },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, AbortController, TextDecoder: util.TextDecoder, confirm: () => options.confirm !== false, console, __HOOK: h => { hook = h; } };
  vm.runInNewContext(source, sandbox, { filename: 'webui.html' });
  return { ids, document, docHandlers, media, calls, storage, hook, response, route: (url, fn) => routes.unshift([url,fn]) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
let count = 0;
function check(name, condition) { assert.ok(condition, name); console.log('PASS ' + name); count++; }
(async () => {
  const h = harness(); await settle();
  check('connected state comes from successful info response', h.ids.statusChip.textContent === '服务已连接');
  check('workspace label is short but full path remains in title', h.ids.wsChip.textContent === '7coder' && h.ids.wsChip.title === 'D:\\workspace\\7coder');
  check('empty send is disabled', h.ids.send.disabled);
  h.ids.welcome.querySelector('.suggestion').fire('click');
  check('suggestion fills editable draft without sending', h.ids.ta.value.includes('目录结构') && !h.ids.send.disabled && !h.calls.some(c => c.url === '/v1/chat/completions'));
  h.ids.ta.fire('compositionstart'); h.ids.ta.fire('keydown', { key: 'Enter' });
  check('Chinese composition Enter never sends', !h.calls.some(c => c.url === '/v1/chat/completions'));
  h.ids.ta.fire('compositionend'); h.ids.ta.fire('keydown', { key: 'Enter', shiftKey: true });
  check('Shift+Enter preserves the draft', !h.calls.some(c => c.url === '/v1/chat/completions'));
  h.ids.ta.fire('keydown', { key: 'Enter' }); await settle();
  check('Enter sends and removes the welcome state', h.calls.some(c => c.url === '/v1/chat/completions') && !h.ids.welcome.parentNode);
  h.ids.btnNew.fire('click');
  check('new conversation restores welcome and clears draft/history', h.ids.welcome.parentNode === h.ids.log && !h.hook.history().length && !h.ids.ta.value);
  h.ids.themeToggle.fire('click');
  check('theme toggle updates palette, label and stored preference', h.document.body.classList.contains('dark') && h.storage['7coder-theme'] === 'dark' && h.ids.themeToggle.getAttribute('aria-label') === '切换到浅色主题');
  const dark = harness({ storage: { '7coder-theme': 'dark' } }); await settle();
  check('theme preference survives reload', dark.document.body.classList.contains('dark'));
  const blocked = harness({ blockStorage: true }); await settle(); blocked.ids.themeToggle.fire('click');
  check('blocked storage does not break UI', blocked.document.body.classList.contains('dark'));
  h.ids.settingsBtn.fire('click'); await settle();
  check('settings drawer opens, masks background and receives focus', h.ids.setPanel.style.display === 'block' && !h.ids.settingsBackdrop.hidden && h.ids.main.inert && h.document.activeElement === h.ids.closeSet);
  h.docHandlers.keydown({ key: 'Escape', preventDefault() {} });
  check('Escape closes settings and restores trigger focus', h.ids.setPanel.style.display === 'none' && h.ids.settingsBackdrop.hidden && h.document.activeElement === h.ids.settingsBtn);
  h.ids.settingsBtn.fire('click'); await settle(); h.ids.addProf.fire('click');
  check('new profile fields are labeled and focusable', h.ids.profRows.children.length === 1 && h.ids.profRows.querySelector('input').getAttribute('aria-label') === '模型名' && h.document.activeElement === h.ids.profRows.querySelector('input'));
  h.ids.closeSet.fire('click');
  h.hook.setSessions([{ file: 'a.json', preview: '修复 BUG' }, { file: 'b.json', preview: '<img src=x onerror=alert(1)>' }]); h.hook.renderSessions();
  h.ids.sessionSearch.value = 'bug'; h.ids.sessionSearch.fire('input');
  check('history search is case-insensitive', h.ids.histList.children.length === 1 && h.ids.histList.textContent.includes('修复 BUG'));
  h.ids.sessionSearch.value = 'unmatched'; h.ids.sessionSearch.fire('input');
  check('search has a useful empty state', h.ids.histList.textContent.includes('没有找到匹配'));
  h.ids.sessionSearch.value = ''; h.ids.sessionSearch.fire('input');
  check('session previews remain text, not executable HTML', h.ids.histList.querySelectorAll('img').length === 0 && h.ids.histList.textContent.includes('<img'));
  h.hook.setBusy(true); const beforeLoad = h.calls.length; h.hook.load('a.json');
  check('busy conversation cannot switch sessions', h.calls.length === beforeLoad && h.ids.btnNew.disabled && h.ids.histList.querySelector('button').disabled);
  h.hook.setBusy(false);
  h.route('/api/sessions/load', () => h.response({ messages: [{ role: 'assistant', content: '**restored**' }] }));
  h.hook.load('a.json'); await settle();
  check('session loading restores context and active history item', h.hook.session() === 'a.json' && h.hook.history().length === 1 && h.ids.histList.children[0].classList.contains('active'));
  h.ids.btnNew.fire('click'); h.hook.setHistory([{ role: 'user', content: 'old chat' }]);
  let release; h.route('/api/sessions/save', () => new Promise(resolve => { release = resolve; })); h.hook.autoSave(); h.ids.btnNew.fire('click'); release(h.response({ file: 'old.json' })); await settle();
  check('late save response cannot rename a new conversation', h.hook.session() === null);
  h.route('/api/info', () => h.response({ error: { message: 'Unauthorized' } },401)); await h.hook.refreshInfo();
  check('authorization errors show failure rather than connected state', h.ids.statusChip.textContent === '连接失败' && h.ids.connectionDetails.open);
  const phone = harness({ mobile: true }); await settle();
  check('mobile navigation starts offscreen and outside tab order', phone.ids.sidebar.getAttribute('aria-hidden') === 'true' && phone.ids.btnNew.tabIndex === -1);
  phone.ids.burger.fire('click');
  check('mobile menu opens with backdrop and focuses close control', !phone.ids.sidebarBackdrop.hidden && phone.document.activeElement === phone.ids.closeSidebar && phone.ids.main.inert);
  phone.ids.settingsBtn.fire('click'); await settle(); phone.ids.closeSet.fire('click');
  check('closing settings on mobile returns to the open navigation', phone.ids.sidebar.classList.contains('mobile-open') && phone.document.activeElement === phone.ids.settingsBtn);
  phone.ids.sidebarBackdrop.fire('click');
  check('backdrop closes navigation and restores menu focus', phone.ids.sidebarBackdrop.hidden && phone.document.activeElement === phone.ids.burger && !phone.ids.main.inert);
  phone.media.matches = false; phone.media.change();
  check('resizing to desktop restores navigation and tab stops', phone.ids.sidebar.getAttribute('aria-hidden') === 'false' && phone.ids.btnNew.tabIndex === 0);
  const settings = harness(); await settle(); settings.ids.settingsBtn.fire('click'); await settle();
  settings.ids.closeSet.focus(); settings.docHandlers.keydown({ key: 'Tab', shiftKey: true, preventDefault() {} });
  check('Shift+Tab wraps to the last settings control', settings.document.activeElement === settings.ids.saveProfiles);
  settings.docHandlers.keydown({ key: 'Tab', preventDefault() {} });
  check('Tab wraps back to the settings close control', settings.document.activeElement === settings.ids.closeSet);
  settings.ids.setEndpoint.value = ' http://localhost:1234/v1 '; settings.ids.setKey.value = 'fixture-only'; settings.ids.setModel.value = ' preview-model ';
  settings.ids.saveSettings.fire('click'); await settle();
  const savedSettings = settings.calls.find(c => c.url === '/api/settings' && c.opts.method === 'POST');
  check('global settings preserve the API contract and trim fields', JSON.stringify(JSON.parse(savedSettings.opts.body)) === JSON.stringify({ endpoint: 'http://localhost:1234/v1', apiKey: 'fixture-only', model: 'preview-model' }));
  settings.ids.addProf.fire('click');
  const inputs = settings.ids.profRows.children[0].querySelectorAll('input');
  inputs[0].value = ' profile-model '; inputs[1].value = ' http://localhost:1234/v1 '; inputs[2].value = 'fixture-profile-key';
  settings.ids.saveProfiles.fire('click'); await settle();
  const savedProfiles = JSON.parse(settings.calls.find(c => c.url === '/api/models-config').opts.body);
  check('profile settings retain model names, endpoints and keys', savedProfiles.profiles['profile-model'].endpoint === 'http://localhost:1234/v1' && savedProfiles.profiles['profile-model'].apiKey === 'fixture-profile-key');
  const permissions = harness({ confirm: false }); await settle();
  permissions.ids.modeSel.value = 'bypass'; permissions.ids.modeSel.fire('change');
  check('cancelled bypass confirmation never changes server permissions', permissions.ids.modeSel.value === 'default' && !permissions.calls.some(c => c.url === '/api/mode'));
  permissions.route('/api/mode', () => permissions.response({ error: { message: 'Unavailable' } }, 503));
  permissions.ids.modeSel.value = 'auto'; permissions.ids.modeSel.fire('change'); await settle();
  check('failed permission change restores the confirmed mode', permissions.ids.modeSel.value === 'default' && permissions.ids.modeChip.textContent === '操作前询问');
  const loading = harness(); await settle(); loading.hook.setHistory([{ role: 'user', content: 'keep context' }]);
  let releaseLoad; loading.route('/api/sessions/load', () => new Promise(resolve => { releaseLoad = resolve; }));
  loading.hook.load('unavailable.json'); loading.ids.ta.value = 'draft'; loading.ids.ta.fire('input'); loading.hook.send();
  check('pending history load disables sending and preserves the draft', loading.ids.send.disabled && loading.ids.ta.value === 'draft' && !loading.calls.some(c => c.url === '/v1/chat/completions'));
  releaseLoad(loading.response({ error: { message: 'Session unavailable' } }, 500)); await settle();
  check('failed history load preserves current context and unlocks sending', loading.hook.history()[0].content === 'keep context' && !loading.ids.send.disabled && loading.hook.session() === null);
  const stopping = harness(); await settle(); let streamSignal;
  stopping.route('/v1/chat/completions', opts => new Promise((resolve, reject) => {
    streamSignal = opts.signal;
    streamSignal.addEventListener('abort', () => { const error = new Error('Stopped'); error.name = 'AbortError'; reject(error); });
  }));
  stopping.ids.ta.value = 'stop test'; stopping.hook.send(); stopping.ids.stop.fire('click');
  check('stop button aborts the active request', streamSignal.aborted);
  await settle(); stopping.ids.ta.value = 'next draft'; stopping.ids.ta.fire('input');
  check('stopping unlocks the composer without showing a failure', !stopping.ids.send.disabled && !stopping.ids.btnNew.disabled && stopping.ids.stop.style.display === 'none' && !stopping.ids.log.querySelector('.err-msg'));
  const mobileKeys = harness({ mobile: true }); await settle(); mobileKeys.ids.burger.fire('click');
  mobileKeys.docHandlers.keydown({ key: 'Tab', shiftKey: true, preventDefault() {} });
  check('mobile navigation traps reverse Tab inside the drawer', mobileKeys.document.activeElement === mobileKeys.ids.settingsBtn);
  mobileKeys.docHandlers.keydown({ key: 'Escape', preventDefault() {} });
  check('Escape closes mobile navigation and restores the menu trigger', mobileKeys.ids.sidebarBackdrop.hidden && mobileKeys.document.activeElement === mobileKeys.ids.burger && !mobileKeys.ids.main.inert);
  const markupIds = Array.from(html.split('<script>')[0].matchAll(/\bid="([^"]+)"/g), m => m[1]);
  check('all static IDs are unique', new Set(markupIds).size === markupIds.length);
  check('no external scripts, fonts or styles are required', !/<(?:script|link)[^>]+(?:src|href)="https?:/i.test(html));
  console.log('\nUI regression: ' + count + ' checks passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
