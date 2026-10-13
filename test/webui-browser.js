#!/usr/bin/env node
// Real Chromium regression against the actual webui.html and a local fixture.
// Playwright is a development-only external runtime, never a product dependency.
// npm run test:browser (PLAYWRIGHT_MODULE_PATH / BROWSER_BIN optional overrides).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const html = fs.readFileSync(path.join(__dirname, '..', 'webui.html'));
let total = 0, slow = false, saved = null, requests = 0, loads = 0, aborted = false;
const server = http.createServer((req, res) => {
  const json = value => { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(value)); };
  if (req.url === '/') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); return res.end(html); }
  if (req.url === '/api/info') return json({workspace:'browser fixture',model:'fixture',models:['fixture'],mode:'default',usage:{prompt:total,completion:0,total}});
  if (req.url === '/api/todos') return json({todos:[]});
  if (req.url === '/api/sessions') return json({sessions:saved?[{file:'saved.json',preview:'Saved browser session',turns:2,savedAt:'2026-10-13'}]:[]});
  if (req.url === '/api/sessions/load') { loads++; return json({messages:[{role:'user',content:'Saved user'},{role:'assistant',content:'Saved answer'}]}); }
  let body=''; req.on('data', d => {body+=d;}); req.on('end', () => {
    if (req.url === '/api/sessions/save') { saved=JSON.parse(body); return json({file:'saved.json'}); }
    if (req.url === '/v1/chat/completions') {
      requests++;
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      if (!slow) {
        for (const result of [
          {name:'diagnostics_tool',status:'error',result:'Friendly failure details'},
          {name:'run_tests_tool',status:'completed',result:'Tests error: is sample text'}
        ]) res.write('data: '+JSON.stringify({choices:[{delta:{tool_result:result}}]})+'\n\n');
      }
      res.write('data: '+JSON.stringify({choices:[{delta:{content:slow?'Still generating':'Browser answer'}}]})+'\n\n');
      if(slow) { res.on('close',()=>{aborted=true;}); return; }
      total+=150;
      res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
      return;
    }
    json({});
  });
});
let count=0;
function check(name, condition) { assert.ok(condition,name); count++; console.log('PASS browser: '+name); }
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try {
    browser=await chromium.launch({headless:true, ...(process.env.BROWSER_BIN ? {executablePath:process.env.BROWSER_BIN} : {channel:'chrome'})});
    const page=await browser.newPage();
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>document.querySelector('#statusChip').textContent==='服务已连接');
    await page.locator('#ta').fill('First browser question'); await page.locator('#send').click();
    await page.waitForFunction(()=>document.querySelector('#usageChip').textContent==='用量 150');
    check('usage refreshes after completed streaming reply',await page.locator('#usageChip').textContent()==='用量 150');
    check('tool cards use explicit server status rather than infer it from text',await page.locator('.tool-result.error').filter({hasText:'Friendly failure details'}).count()===1 && await page.locator('.tool-result.completed').filter({hasText:'Tests error: is sample text'}).count()===1);
    await page.waitForFunction(()=>!document.querySelector('#btnNew').disabled);
    await page.locator('.edit-msg').first().click();
    check('edit restores draft and removes the edited turn',await page.locator('#ta').inputValue()==='First browser question' && await page.locator('.msg-row.user').count()===0);
    await page.locator('#ta').fill('Edited browser question'); await page.locator('#send').click();
    await page.waitForFunction(()=>document.querySelector('#usageChip').textContent==='用量 300');
    check('editing resends only the revised user turn',requests===2 && saved && saved.messages.filter(m=>m.role==='user').length===1 && saved.messages[0].content==='Edited browser question');
    await page.locator('#btnNew').click(); slow=true;
    await page.locator('#ta').fill('Slow browser question'); await page.locator('#send').click();
    await page.locator('.stream-content').filter({hasText:'Still generating'}).waitFor();
    // Use the rendered session item, including its busy-state semantics.
    const sessionButton=page.locator('#histList .session-open').first();
    const loadsBefore=loads;
    check('busy session switch button is disabled',await sessionButton.isDisabled());
    await sessionButton.evaluate(button=>button.click());
    check('disabled session click sends no load request and keeps active conversation',loads===loadsBefore && await page.locator('.msg-row.user').filter({hasText:'Slow browser question'}).count()===1);
    await page.locator('#stop').click();
    await page.locator('.stream-stopped').waitFor();
    await page.waitForFunction(()=>!document.querySelector('#btnNew').disabled);
    check('stop aborts the live stream and unlocks composer',aborted && await page.locator('.stream-error').count()===0);
    slow=false;
    await page.locator('#histList .session-open').first().click();
    await page.locator('.msg-row.user').filter({hasText:'Saved user'}).waitFor();
    check('saved session switches after generation stops',await page.locator('.msg-row.bot').filter({hasText:'Saved answer'}).count()===1);
    check('no uncaught browser errors',errors.length===0);
    console.log('Browser regression: '+count+' checks passed');
  } finally {
    if(browser) await browser.close();
    server.close();
    if(server.closeAllConnections) server.closeAllConnections();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
