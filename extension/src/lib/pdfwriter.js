/**
 * pdfwriter.js — 零依赖 PDF 生成器
 *
 * 只支持一件事：把一组 JPEG 图片按顺序拼成一个 PDF 文件。
 * JPEG 在 PDF 里可以用 /Filter /DCTDecode 原样嵌入，不需要重新编码，
 * 因此体积基本等于图片体积之和，且画质无损。
 *
 * 之所以自己写而不是引入 jsPDF：扩展体积更小、无供应链风险、
 * 且我们只需要 image-xobject 这一个能力，jsPDF 属于杀鸡用牛刀。
 */

const enc = new TextEncoder();

/** 计算字符串 / 字节数组的字节长度（PDF 的 xref 偏移按字节算，不能用 char 数） */
function byteLength(data) {
  return typeof data === 'string' ? enc.encode(data).length : data.length;
}

/**
 * 把 JavaScript 字符串转成合法的 PDF 文本对象。
 *
 * PDF 的字面量字符串 (...) 只认单字节编码，中文直接塞进去必然乱码；
 * 规范给的解法是改用 UTF-16BE + BOM 的十六进制形式 <FEFF...>，
 * 所以这里按内容自动挑一种写法。
 */
function pdfText(text) {
  const str = String(text);
  if (/^[\x20-\x7e]*$/.test(str)) {
    const escaped = str
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
    return `(${escaped})`;
  }

  let hex = 'FEFF'; // UTF-16BE BOM
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      // 需要拆成代理对
      const v = cp - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      hex += hi.toString(16).padStart(4, '0').toUpperCase();
      hex += lo.toString(16).padStart(4, '0').toUpperCase();
    } else {
      hex += cp.toString(16).padStart(4, '0').toUpperCase();
    }
  }
  return `<${hex}>`;
}

class PdfWriter {
  constructor(options = {}) {
    this.pages = [];
    this.title = options.title || '';
    this.subject = options.subject || 'Exported with Chaoxing PPT Exporter';
  }

  /**
   * 添加一页
   * @param {Uint8Array} jpeg  JPEG 原始字节
   * @param {number} width     像素宽（会成为 PDF 页面宽，单位 pt）
   * @param {number} height    像素高
   */
  addPage(jpeg, width, height) {
    if (!(jpeg instanceof Uint8Array)) {
      throw new TypeError('addPage: jpeg 必须是 Uint8Array');
    }
    this.pages.push({ jpeg, width: Math.round(width), height: Math.round(height) });
    return this;
  }

  get pageCount() {
    return this.pages.length;
  }

  /**
   * 生成 PDF 字节流
   * @returns {Uint8Array}
   */
  build() {
    if (this.pages.length === 0) {
      throw new Error('PdfWriter.build: 至少需要一页');
    }

    const chunks = [];
    let offset = 0;

    const push = (data) => {
      const bytes = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(bytes);
      offset += bytes.length;
    };

    // ---- 对象编号规划 ----
    // 1: Catalog  2: Pages  3: Info
    // 每页占 3 个对象：Page / Image XObject / Content stream
    const INFO_OBJ = 3;
    const pageObjId = (i) => 4 + i * 3;
    const imageObjId = (i) => 5 + i * 3;
    const contentObjId = (i) => 6 + i * 3;

    const totalObjects = 3 + this.pages.length * 3;
    const offsets = new Array(totalObjects + 1).fill(0); // 1-based

    const beginObj = (id) => {
      offsets[id] = offset;
    };

    push('%PDF-1.4\n');
    // 二进制标记，告诉编辑器这不是纯文本 PDF。
    // 必须按原始字节写，不能用字符串 —— 那几个字节会被 TextEncoder 编成 UTF-8 而不再是原值。
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    // ---- obj 1: Catalog ----
    beginObj(1);
    push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    // ---- obj 2: Pages ----
    beginObj(2);
    const kids = this.pages.map((_, i) => `${pageObjId(i)} 0 R`).join(' ');
    push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>\nendobj\n`);

    // ---- obj 3: Info ----
    beginObj(INFO_OBJ);
    const now = new Date();
    const pdfDate =
      `D:${now.getFullYear()}` +
      `${String(now.getMonth() + 1).padStart(2, '0')}` +
      `${String(now.getDate()).padStart(2, '0')}` +
      `${String(now.getHours()).padStart(2, '0')}` +
      `${String(now.getMinutes()).padStart(2, '0')}` +
      `${String(now.getSeconds()).padStart(2, '0')}Z`;
    push(
      `3 0 obj\n<< /Title ${pdfText(this.title)} ` +
        `/Subject ${pdfText(this.subject)} ` +
        `/Producer (Chaoxing PPT Exporter) ` +
        `/CreationDate (${pdfDate}) /ModDate (${pdfDate}) >>\nendobj\n`
    );

    // ---- 每页 ----
    this.pages.forEach((page, i) => {
      const { jpeg, width, height } = page;

      // Page 对象
      beginObj(pageObjId(i));
      push(
        `${pageObjId(i)} 0 obj\n<< /Type /Page /Parent 2 0 R ` +
          `/MediaBox [0 0 ${width} ${height}] ` +
          `/Resources << /XObject << /Im0 ${imageObjId(i)} 0 R >> >> ` +
          `/Contents ${contentObjId(i)} 0 R >>\nendobj\n`
      );

      // Image XObject（JPEG 原样嵌入）
      beginObj(imageObjId(i));
      push(
        `${imageObjId(i)} 0 obj\n<< /Type /XObject /Subtype /Image ` +
          `/Width ${width} /Height ${height} /ColorSpace /DeviceRGB ` +
          `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
      );
      push(jpeg);
      push('\nendstream\nendobj\n');

      // Content stream：把图片铺满整页
      const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
      beginObj(contentObjId(i));
      push(`${contentObjId(i)} 0 obj\n<< /Length ${byteLength(content)} >>\nstream\n`);
      push(content);
      push('endstream\nendobj\n');
    });

    // ---- xref 表 ----
    const xrefOffset = offset;
    let xref = `xref\n0 ${totalObjects + 1}\n`;
    xref += '0000000000 65535 f \n'; // 空闲对象，固定 20 字节
    for (let id = 1; id <= totalObjects; id++) {
      // 每条 xref 记录必须恰好 20 字节：10 位偏移 + 空格 + 5 位版本号 + 空格 + 类型 + EOL
      xref += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
    }
    push(xref);

    // ---- trailer ----
    push(
      `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R /Info ${INFO_OBJ} 0 R >>\n` +
        `startxref\n${xrefOffset}\n%%EOF\n`
    );

    // ---- 合并 ----
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }
}

// 同时支持 ES module 导入和 Chrome 扩展的全局脚本两种加载方式
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PdfWriter };
}
if (typeof globalThis !== 'undefined') {
  globalThis.PdfWriter = PdfWriter;
}
