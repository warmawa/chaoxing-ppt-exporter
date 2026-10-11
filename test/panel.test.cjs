/**
 * panel.test.cjs — 面板（ui.js）与调用方（content.js）的静态契约测试
 *
 * 这类跨文件约定最阴险：漏一个方法、拼错一个 class，运行时是
 * "点了没反应且不报错"，没人会去查。用静态扫描把它们兜住。
 *
 * 运行：node test/panel.test.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'extension', 'src');
const ui = fs.readFileSync(path.join(ROOT, 'lib', 'ui.js'), 'utf8');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const css = extractCss(ui);

const errors = [];
let passed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    errors.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function extractCss(src) {
  const start = src.indexOf('const CSS = `');
  if (start < 0) return '';
  const from = start + 'const CSS = `'.length;
  return src.slice(from, src.indexOf('`;', from));
}

// ---------------------------------------------------------------- 1
console.log('面板 API 契约（content.js 调用的方法 ui.js 必须实现）');

const used = [...new Set([...content.matchAll(/\bpanel\.([a-zA-Z]+)/g)].map((m) => m[1]))];
const methods = new Set([...ui.matchAll(/^    ([a-zA-Z]+)\s*\(/gm)].map((m) => m[1]));
const props = new Set([...ui.matchAll(/this\.([a-zA-Z]+)\s*=/g)].map((m) => m[1]));

check('content.js 用到至少一个面板方法', used.length > 0);
for (const m of used.sort()) {
  check(`panel.${m}`, methods.has(m) || props.has(m));
}

// ---------------------------------------------------------------- 2
console.log('\nCSS 覆盖（面板里出现的 class 都要有样式）');

const classes = new Set();
for (const m of ui.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => c && classes.add(c));
for (const m of ui.matchAll(/classList\.(?:add|remove|toggle|contains)\(([^)]*)\)/g)) {
  for (const q of m[1].matchAll(/'([^']+)'/g)) classes.add(q[1]);
}
for (const m of ui.matchAll(/querySelector\('\.([a-z0-9-]+)'/g)) classes.add(m[1]);

const clsList = [...classes].filter((c) => c.startsWith('cx-')).sort();
check('提取到面板 class', clsList.length >= 10, `实际 ${clsList.length} 个`);
for (const c of clsList) {
  check(`.${c} 有样式`, css.includes(`.${c}`));
}

// ---------------------------------------------------------------- 3
console.log('\n常驻设计要求（这几条是踩过坑的，别改回去）');

// 面板必须能在没有 deck 时创建：installPanel(null) 在 boot 里被调用
check('顶层启动时就建面板（不等探测结果）', /if \(isTopFrame\)[\s\S]{0,120}installPanel\(null\)/.test(content));

// 定位必须是 fixed，否则会跟着长课件沉到底部。
// 且必须写在 :host 上——shadow 内的样式表选不到 host 元素本身。
check('容器用 position: fixed', /:host\s*\{[^}]*position:\s*fixed/.test(css));

// 位置由 JS 管：left/top 都要被设置
check('位置由 JS 控制 left/top', /host\.style\.left/.test(ui) && /host\.style\.top/.test(ui));

// 进度条默认收起、常驻小球显示百分比
check('进度区默认收起（display: none）', /\.cx-progress\s*\{[^}]*display:\s*none/.test(css));
check('小球形态有独立样式', /:host\(\.cx-mini\)\s+\.cx-ball/.test(css));
check('小球文字可被更新', /setBallText\s*\(/.test(ui));

// 探测失败也要有出口
check('面板有"重新检测"入口', /onRedetect/.test(ui) && /onRedetect/.test(content));
check('面板能显示诊断信息', /setDiagnostic\s*\(/.test(ui) && /setDiagnostic/.test(content));

// ---------------------------------------------------------------- 4
console.log('\n诊断链路（frame → background → 顶层面板）');

check('content 上报探测摘要', /type: 'cx:probe-report'/.test(content));
check(
  'background 转发给顶层',
  /sendToFrame\(tabId, 0, \{ type: 'cx:probe-report'/.test(
    fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8')
  )
);
check('顶层汇总成诊断文字', /renderDiagnostic/.test(content));
check('重新检测走广播（课件可能在任何一层）', /chrome\.tabs\.sendMessage\(tabId, \{ type: 'cx:redetect' \}\)/.test(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8')));

// ---------------------------------------------------------------- 5
console.log('\n油猴脚本（同样要求常驻 + 跨 frame）');

const user = fs.readFileSync(path.join(__dirname, '..', 'userscript', 'chaoxing-ppt-exporter.user.js'), 'utf8');
const userHeader = user.slice(0, user.indexOf('==/UserScript=='));

// 课件 iframe 与章节页跨域，@noframes 会让脚本完全看不到课件
check('不能带 @noframes', !/^\s*\/\/\s*@noframes\s*$/m.test(userHeader));
check('启动时就建面板（不等探测结果）', /if \(isTopFrame\) ensurePanel\(\)/.test(user));
check('有跨 frame 上报（postMessage 到 top）', /sendToTop\(\{ cx: 'deck'/.test(user) && /window\.top\.postMessage\(msg/.test(user));
check('顶层能回发动作给课件所在 frame', /cx: 'action'/.test(user));
check('子 frame 只认顶层的动作', /e\.source !== window\.top \|\| !currentDeck/.test(user));
check('子 frame 没有面板也能导出（状态走 ui* 系列）', /function uiProgress/.test(user) && !/const p = panelRef;\s*\n\s*if \(!p\) return;/.test(user));
check('panelRef 声明与面板常驻一致', /let panelRef = null;/.test(user));
check('油猴版有诊断信息', /renderDiagnostic/.test(user));
check('位置由 JS 控制 left/top', /host\.style\.left/.test(user) && /host\.style\.top/.test(user));
check('有最小化成小球', /host\.classList\.add\('mini'\)/.test(user));

// ---------------------------------------------------------------- 6
console.log('\n层级与定位（Shadow DOM 作用域）');

// Shadow DOM 的样式表只能作用于 shadow tree 内部，选不到 host 元素本身。
// 定位一旦写进 `.cx-root {}` / `#cx-panel {}`，那条规则永远不会生效，
// host 会退化成静态内联元素，跟着被撑高的 body 沉到几千像素以下——
// 表现就是"页面上看不见，关页面时闪一下"。
check('host 定位写在 :host 上', /:host\s*\{[^}]*position:\s*fixed\s*!important/.test(css));
check('不用 .cx-root 给 host 定位（选不到）', !/^\s*\.cx-root\s*\{/m.test(css));
check('z-index 取到最大值 2147483647', /z-index:\s*2147483647/.test(css));
check('内联兜底一份 position / z-index',
  /setProperty\('position', 'fixed', 'important'\)/.test(ui) &&
  /setProperty\('z-index', '2147483647', 'important'\)/.test(ui));
check('挂在 <html> 末尾（DOM 顺序最后）',
  /nextElementSibling/.test(ui) && /document\.documentElement \|\| document\.body/.test(ui));
check('有看门狗：定时 + DOM 变动', /setInterval\(tick, 2000\)/.test(ui) && /new MutationObserver/.test(ui));
check('被顶出视口时能拉回来', /ensureInViewport/.test(ui));

const userCssStart = user.indexOf('const CSS = `') + 'const CSS = `'.length;
const userCss = user.slice(userCssStart, user.indexOf('`;', userCssStart));
check('油猴：host 定位写在 :host 上', /:host\s*\{[^}]*position:\s*fixed\s*!important/.test(userCss));
check('油猴：不用 #cx-panel 给 host 定位', !/^\s*#cx-panel\s*\{/m.test(userCss));
check('油猴：z-index 取到最大值', /z-index:\s*2147483647/.test(userCss));
check('油猴：内联兜底一份', /setProperty\('position', 'fixed', 'important'\)/.test(user));
check('油猴：挂在 <html> 末尾', /function mountPanelHost/.test(user) && /nextElementSibling/.test(user));
check('油猴：有看门狗', /function startPanelGuard/.test(user) && /setInterval\(tick, 2000\)/.test(user));

// ----------------------------------------------------------------

console.log('\n' + '='.repeat(46));
if (errors.length) {
  console.log(`通过 ${passed} 项，失败 ${errors.length} 项`);
  errors.forEach((e) => console.log('  ! ' + e));
  process.exit(1);
}
console.log(`全部通过（${passed} 项）`);
