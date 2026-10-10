/**
 * messaging.test.cjs — 跨 frame 消息通道的静态一致性检查
 *
 * 面板挂在顶层窗口、动作在课件所在的 iframe 里执行，两边全靠消息往来。
 * 这种"发送方和接收方在两个文件里"的约定最容易出问题：改了名字、少写一个
 * case、拼错一个字母，运行时只会静默失效（点按钮没反应，且不报错）。
 * 所以这里不跑浏览器，直接扫源码，确保每个消息类型都有收发两端。
 *
 * 运行：node test/messaging.test.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'extension', 'src');
// 三方都要扫：content（探测 + 面板）、background（中转）、offscreen（图片转码）
const FILES = [
  { name: 'background', file: path.join(ROOT, 'background.js') },
  { name: 'content', file: path.join(ROOT, 'content.js') },
  { name: 'offscreen', file: path.join(ROOT, 'offscreen.js') },
];

function scan(file) {
  const src = fs.readFileSync(file, 'utf8');

  // 发送：sendMessage({ type: 'cx:xxx' ... }) 或 sendMessage(tab, { type: 'cx:xxx' }, opts)
  const sent = new Set(
    [...src.matchAll(/type:\s*'(cx:[a-z0-9-]+)'/g)].map((m) => m[1])
  );

  // 接收：switch 里的 case 'cx:xxx'（background / content 用这种）
  const handled = new Set(
    [...src.matchAll(/case\s*'(cx:[a-z0-9-]+)'/g)].map((m) => m[1])
  );

  // 接收：if (msg.type === 'cx:xxx')（offscreen 用这种）
  for (const m of src.matchAll(/msg\.type\s*===?\s*'(cx:[a-z0-9-]+)'/g)) {
    handled.add(m[1]);
  }
  // 提前返回式的过滤：if (msg.type !== 'cx:xxx') return false
  for (const m of src.matchAll(/msg\.type\s*!==?\s*'(cx:[a-z0-9-]+)'/g)) {
    handled.add(m[1]);
  }

  return { sent, handled };
}

const scanned = FILES.map((f) => ({ ...f, ...scan(f.file) }));

const allTypes = new Set();
for (const s of scanned) {
  for (const t of s.sent) allTypes.add(t);
  for (const t of s.handled) allTypes.add(t);
}

let pass = 0;
const errors = [];

function check(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    errors.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

console.log('跨 frame 消息通道检查\n');

// 1. 每个被发送的消息，都必须有人接收
for (const t of [...allTypes].sort()) {
  const senders = scanned.filter((s) => s.sent.has(t)).map((s) => s.name);
  const handlers = scanned.filter((s) => s.handled.has(t)).map((s) => s.name);
  check(senders.length === 0 || handlers.length > 0, `${t}  发送[${senders}] → 接收[${handlers}]`);
}

// 2. 面板中转这条链路必须完整，缺一个面板就沉到底部去了
const REQUIRED = [
  'cx:panel-show', // iframe → bg：请把面板挂到顶层
  'cx:panel-install', // bg → 顶层：建面板
  'cx:panel-update', // iframe → 顶层：页数更新
  'cx:panel-action', // 顶层 → bg → iframe：执行动作
  'cx:panel-result', // iframe → bg → 顶层：回传状态
];
console.log('');
for (const t of REQUIRED) {
  check(allTypes.has(t), `必备消息存在：${t}`);
}

// 3. 面板中转的四个消息，发送方和接收方必须在不同的文件里
//    （同一文件里自收自发说明中转根本没发生，等于没修）
console.log('');
const bg = scanned.find((s) => s.name === 'background');
const ct = scanned.find((s) => s.name === 'content');
check(!(ct.sent.has('cx:panel-install') && ct.handled.has('cx:panel-install')), 'cx:panel-install 是跨文件的（bg 发 / content 收）');
check(ct.sent.has('cx:panel-show') && bg.handled.has('cx:panel-show'), 'cx:panel-show：content 发 → background 收');
check(bg.sent.has('cx:panel-install') && ct.handled.has('cx:panel-install'), 'cx:panel-install：background 发 → content 收');

// 4. 顶层窗口不能自己给自己转发，否则会转圈
const bgSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
check(
  /sender\.frameId === 0\)\s*return \{ ok: true, installed: false \}/.test(bgSrc),
  '顶层 frame 请求安装面板时直接返回，不自转发'
);

console.log(`\n${errors.length ? `${errors.length} 项失败` : `全部通过`}（${pass} 项）`);
process.exit(errors.length ? 1 : 0);
