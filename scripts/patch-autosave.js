const fs = require('fs');
const p = 'D:/ai-workspaces/7coder/webui.html';
let s = fs.readFileSync(p, 'utf8');
// 防重复: 补丁脚本被应用过了就不重复插入
if (s.includes('autoSaveSession')) { console.log('already: autoSaveSession present'); }
else { console.error('NOT applied'); process.exit(1); }
// 在页面卸载时兜底保存（用户中途关闭页面）
if (!s.includes("window.addEventListener('beforeunload'")) {
  const anchor = "  function loadSessionFile(file) {";
  const guard = [
    '  // 页面关闭前兜底保存',
    "  window.addEventListener('beforeunload', function () {",
    '    if (history.length) autoSaveSession();',
    '  });',
    '',
    anchor
  ].join('\n');
  s = s.replace(anchor, guard);
  fs.writeFileSync(p, s);
  console.log('beforeunload guard added');
}
