/**
 * 端到端冒烟测试：把 fixtures 里的 JPEG 用 PdfWriter 合成一个 PDF。
 * 运行：node test/build-sample-pdf.cjs
 */

const fs = require('fs');
const path = require('path');

const { PdfWriter } = require('../extension/src/lib/pdfwriter.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'output');

/** 从 JPEG 字节里读出真实的像素尺寸（SOF 段），不依赖任何库 */
function readJpegSize(buf) {
  let i = 2; // 跳过 SOI
  while (i < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  throw new Error('没有找到 SOF 段');
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const files = fs
    .readdirSync(FIXTURES)
    .filter((f) => /\.jpe?g$/i.test(f))
    .sort();

  if (files.length === 0) {
    console.error('fixtures 目录里没有 JPEG');
    process.exit(1);
  }

  const writer = new PdfWriter({ title: '测试课件 · Chaoxing PPT Exporter' });

  for (const name of files) {
    const buf = fs.readFileSync(path.join(FIXTURES, name));
    const { width, height } = readJpegSize(buf);
    writer.addPage(new Uint8Array(buf), width, height);
    console.log(`  + ${name}  ${width}x${height}  ${(buf.length / 1024).toFixed(0)} KB`);
  }

  const bytes = writer.build();
  const outFile = path.join(OUT, 'sample.pdf');
  fs.writeFileSync(outFile, bytes);

  console.log(`\n生成 ${outFile}`);
  console.log(`  页数：${writer.pageCount}`);
  console.log(`  体积：${(bytes.length / 1024).toFixed(0)} KB`);
  console.log(`  原始 JPEG 合计：${files.reduce((s, f) => s + fs.statSync(path.join(FIXTURES, f)).size, 0) / 1024} KB`);
}

main();
