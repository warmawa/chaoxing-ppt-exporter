/**
 * detector.js 单元测试（无需测试框架，直接 node 跑）
 *
 * 只测纯逻辑部分：URL 解析、序列聚类。DOM 相关的探测没法在这里覆盖，
 * 那部分靠真实页面手工验证。
 *
 * 运行：node test/detector.test.cjs
 */

const path = require('path');
const CX = require(path.join(__dirname, '..', 'extension', 'src', 'lib', 'detector.js'));

let passed = 0;
let failed = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  [OK]   ${label}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${label}\n         期望 ${e}\n         实际 ${a}`);
  }
}

function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  [OK]   ${label}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${label}`);
  }
}

// ------------------------------------------------------------------
console.log('\n1) extractObjectId —— 从 URL 里抠出 objectId');
const SAMPLE = 'https://s3.ananas.chaoxing.com/sv-w9/doc/8f/1b/f7/043a736c48aead214ce0738df8e63513/thumb/1.png';
eq(CX.extractObjectId(SAMPLE), '043a736c48aead214ce0738df8e63513', '标准三段式路径');
eq(
  CX.extractObjectId('https://x.chaoxing.com/doc/ab/043a736c48aead214ce0738df8e63513/1.png'),
  '043a736c48aead214ce0738df8e63513',
  '两段式路径（宽松匹配）'
);
eq(CX.extractObjectId('https://example.com/a/b/c.png'), null, '无关 URL 返回 null');

// ------------------------------------------------------------------
console.log('\n2) extractDocPrefix —— 推导同前缀，用于拼 PDF 直链');
eq(
  CX.extractDocPrefix(SAMPLE),
  'https://s3.ananas.chaoxing.com/sv-w9/doc/8f/1b/f7/043a736c48aead214ce0738df8e63513',
  '取到 doc/<oid> 为止'
);

// ------------------------------------------------------------------
console.log('\n3) derivePdfUrl / deriveDownloadUrl');
eq(
  CX.derivePdfUrl(CX.extractDocPrefix(SAMPLE), '043a736c48aead214ce0738df8e63513'),
  'https://s3.ananas.chaoxing.com/sv-w9/doc/8f/1b/f7/043a736c48aead214ce0738df8e63513/pdf/043a736c48aead214ce0738df8e63513.pdf',
  'PDF 直链拼接正确'
);
eq(
  CX.deriveDownloadUrl('043a736c48aead214ce0738df8e63513'),
  'https://cs.ananas.chaoxing.com/download/043a736c48aead214ce0738df8e63513',
  '下载网关地址正确'
);

// ------------------------------------------------------------------
console.log('\n4) clusterImageSequence —— 图片序列聚类');

const base = 'https://s3.ananas.chaoxing.com/sv-w9/doc/8f/1b/f7/043a736c48aead214ce0738df8e63513/thumb/';
const makeSeq = (n, ext = 'png') =>
  Array.from({ length: n }, (_, i) => `${base}${i + 1}.${ext}`);

// 4.1 正常序列
let seq = CX.clusterImageSequence(makeSeq(30));
ok(seq !== null, '能识别出序列');
eq(seq && seq.maxPage, 30, '最大页码 = 30');
eq(seq && seq.count, 30, '收录页数 = 30');

// 4.2 噪声混入
seq = CX.clusterImageSequence([
  'https://p.ananas.chaoxing.com/avatar/abc.png',
  'https://www.chaoxing.com/static/logo.png',
  'https://x.com/icon-close.png',
  ...makeSeq(12),
]);
eq(seq && seq.maxPage, 12, '噪声图片不影响序列识别');

// 4.3 多序列取最长
const baseB = 'https://s3.ananas.chaoxing.com/sv-a1/doc/11/22/33/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/thumb/';
seq = CX.clusterImageSequence([
  ...makeSeq(4),
  ...Array.from({ length: 25 }, (_, i) => `${baseB}${i + 1}.png`),
]);
eq(seq && seq.maxPage, 25, '两个序列时选页数更多的那个');
ok(seq && seq.base.includes('aaaaaaaa'), '选中的是较长的那组');

// 4.4 乱序输入
seq = CX.clusterImageSequence([`${base}7.png`, `${base}2.png`, `${base}19.png`, `${base}1.png`]);
eq(seq && seq.maxPage, 19, '乱序输入仍取到最大页码');
eq(seq && seq.count, 4, '去重后计数正确');

// 4.5 页码缺口（懒加载只加载了部分页）
seq = CX.clusterImageSequence([`${base}1.png`, `${base}2.png`, `${base}3.png`, `${base}40.png`]);
eq(seq && seq.maxPage, 40, '存在缺口时以最大页码为准');
eq(seq && seq.count, 4, '实际收录 4 页');

// 4.6 单页噪声应被丢弃
seq = CX.clusterImageSequence([`${base}1.png`]);
eq(seq, null, '只有一页时视为噪声，不返回');

// 4.7 空输入
eq(CX.clusterImageSequence([]), null, '空数组返回 null');

// 4.8 jpg 后缀
seq = CX.clusterImageSequence(makeSeq(6, 'jpg'));
eq(seq && seq.ext, 'jpg', '能识别 jpg 后缀');
eq(seq && seq.maxPage, 6, 'jpg 序列页数正确');

// 4.9 带 query 参数
seq = CX.clusterImageSequence([`${base}1.png?v=2`, `${base}2.png?v=2`, `${base}3.png?v=2`]);
eq(seq && seq.maxPage, 3, 'URL 带查询参数也能识别');

// ------------------------------------------------------------------
console.log('\n5) normalizeTitle —— 文件名清洗');
eq(CX.normalizeTitle('第一章 绪论.pptx'), '第一章 绪论', '去掉 .pptx 后缀');
eq(CX.normalizeTitle('a/b:c*d?.pdf'), 'a_b_c_d_', '替换非法字符');
eq(CX.normalizeTitle('  空格  '), '空格', '去掉首尾空格');

// ------------------------------------------------------------------
console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
