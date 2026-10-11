// ==UserScript==
// @name         学习通课件导出器 (Chaoxing PPT Exporter)
// @namespace    https://github.com/warmawa/chaoxing-ppt-exporter
// @version      1.1.0
// @description  把超星学习通章节里只能在线翻看的 PPT 课件导出为 PDF，或直接下载原始文件。
// @author       Chaoxing PPT Exporter contributors
// @match        *://*.chaoxing.com/*
// @match        *://*.xueyinonline.com/*
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%232563eb'/%3E%3Cpath d='M5 4h4l2 2v4H5z' fill='%23fff'/%3E%3Cpath d='M8 10l2-2H6z' fill='%23fff'/%3E%3C/svg%3E
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      chaoxing.com
// @connect      ananas.chaoxing.com
// @connect      *
// @run-at       document-start
// @license      MIT
// ==/UserScript==

/**
 * 说明：这是浏览器扩展版的"单文件替代品"，适合不想装扩展、或者只想快速试一下的场景。
 *
 * ⚠️ 必须跑在所有 frame 里（早先的版本带 @noframes 是错的）：
 *   课件 iframe（ananas.chaoxing.com / pan-yz.chaoxing.com）与章节页跨域，
 *   只在顶层跑的话根本看不见课件内部，等于探测不到任何东西。
 *   现在每个 frame 都跑一份，谁探测到课件谁负责执行动作；
 *   它把结果用 postMessage 报给顶层，由顶层显示面板——
 *   因为课程 iframe 会被撑到几千像素高，面板放在里面会沉到底部。
 *
 * 与扩展版的差距：没有 host 权限，跨域取图靠 GM_xmlhttpRequest。
 * 优点：装完即用，改一行就能调，方便在控制台调试。
 */

(function () {
  'use strict';

  const TAG = '[CX-PPT]';
  const log = (...args) => console.log(TAG, ...args);

  // ==================================================================
  // 1. 图片间谍 —— 记录页面上加载过的所有课件图片
  // ==================================================================

  const SPY_KEY = '__cxImageUrls';
  const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)(\?.*)?$/i;
  const NOISE_RE = /(avatar|logo|icon|emoji|banner|headImg|userImg|cover_)/i;
  const THUMB_RE = /^(.*\/doc\/[0-9a-f]{8,40}\/)thumb\/(\d+)\.(png|jpe?g|webp|gif)(\?.*)?$/i;
  const THUMB_LOOSE_RE = /^(.*\/)thumb\/(\d+)\.(png|jpe?g|webp|gif)(\?.*)?$/i;

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  function installImageSpy() {
    if (pageWindow[SPY_KEY]) return pageWindow[SPY_KEY];
    const seen = new Set();
    pageWindow[SPY_KEY] = seen;

    const record = (url) => {
      if (typeof url !== 'string' || !url) return;
      if (!IMAGE_EXT_RE.test(url) || NOISE_RE.test(url)) return;
      try {
        seen.add(new URL(url, location.href).href);
      } catch {
        /* ignore */
      }
    };

    try {
      const proto = pageWindow.HTMLImageElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'src');
      if (desc && desc.set) {
        Object.defineProperty(proto, 'src', {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set(v) {
            record(v);
            return desc.set.call(this, v);
          },
        });
      }
    } catch (e) {
      log('hook img.src 失败', e);
    }

    try {
      const origFetch = pageWindow.fetch;
      if (origFetch) {
        pageWindow.fetch = function (input) {
          try {
            record(typeof input === 'string' ? input : input && input.url);
          } catch {
            /* ignore */
          }
          return origFetch.apply(this, arguments);
        };
      }
    } catch (e) {
      log('hook fetch 失败', e);
    }

    try {
      const origOpen = pageWindow.XMLHttpRequest.prototype.open;
      pageWindow.XMLHttpRequest.prototype.open = function (m, url) {
        record(url);
        return origOpen.apply(this, arguments);
      };
    } catch (e) {
      log('hook XHR 失败', e);
    }

    return seen;
  }

  // ==================================================================
  // 2. 探测
  // ==================================================================

  const GLOBAL_KEYS = ['fileinfo', 'fileInfo', 'FILEINFO', 'file_info', 'docInfo', 'panViewData', 'mArg', 'attachment'];

  function pickField(obj, names) {
    const keys = Object.keys(obj);
    for (const n of names) {
      const k = keys.find((key) => key.toLowerCase() === n);
      if (k !== undefined && obj[k] != null && obj[k] !== '') return obj[k];
    }
    return null;
  }

  /** 切掉 /thumb/<页码>.<后缀>，剩下的就是文档前缀（超星的目录深度是多变的，不能靠猜） */
  function extractDocPrefix(url) {
    const m = /^(.*)\/thumb\/\d+\.(?:png|jpe?g|webp|gif)(?:\?.*)?$/i.exec(url);
    return m ? m[1] : null;
  }

  function extractObjectId(url) {
    const prefix = extractDocPrefix(url);
    if (prefix) {
      const m = /\/([0-9a-f]{8,40})$/i.exec(prefix);
      if (m) return m[1];
    }
    const m2 = /\/([0-9a-f]{16,40})(?:\/|\.|$)/i.exec(url);
    return m2 ? m2[1] : null;
  }

  /** 递归收集文档（含同源 iframe）里的图片 */
  function collectImages(doc, out) {
    out = out || new Set();
    try {
      doc.querySelectorAll('img').forEach((img) => {
        ['src', 'data-src', 'data-original', 'data-echo', 'data-loadsrc', 'data-url'].forEach((a) => {
          const v = img.getAttribute && img.getAttribute(a);
          if (v && IMAGE_EXT_RE.test(v) && !NOISE_RE.test(v)) {
            try {
              out.add(new URL(v, location.href).href);
            } catch {
              /* ignore */
            }
          }
        });
        if (img.currentSrc && IMAGE_EXT_RE.test(img.currentSrc)) out.add(img.currentSrc);
      });
      // 递归同源 iframe
      doc.querySelectorAll('iframe').forEach((f) => {
        try {
          if (f.contentDocument) collectImages(f.contentDocument, out);
        } catch {
          /* 跨域 iframe，跳过 */
        }
      });
    } catch {
      /* ignore */
    }
    return out;
  }

  function clusterSequence(urls) {
    const groups = new Map();
    for (const url of urls) {
      const m = THUMB_RE.exec(url) || THUMB_LOOSE_RE.exec(url);
      if (!m) continue;
      const [, base, pageStr, ext] = m;
      const page = parseInt(pageStr, 10);
      if (!Number.isFinite(page) || page < 0 || page > 5000) continue;
      if (!groups.has(base)) groups.set(base, { base, ext: ext.toLowerCase(), pages: new Map() });
      groups.get(base).pages.set(page, url);
    }
    const list = [...groups.values()].map((g) => {
      const nums = [...g.pages.keys()].sort((a, b) => a - b);
      return { ...g, maxPage: nums[nums.length - 1] || 0, count: nums.length };
    });
    list.sort((a, b) => b.maxPage - a.maxPage || b.count - a.count);
    return list[0] || null;
  }

  function detect() {
    installImageSpy();

    let title = document.title || '课件';
    let objectId = null;
    let pageCount = 0;
    let suffix = '';
    let downloadUrl = null;
    let source = '图片序列';

    // 页面全局变量
    for (const key of GLOBAL_KEYS) {
      let obj;
      try {
        obj = pageWindow[key];
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;
      const oid = pickField(obj, ['objectid', 'object_id']);
      const dl = pickField(obj, ['download', 'downloadurl', 'download_url', 'fileurl']);
      const pg = pickField(obj, ['pagenum', 'pagecount', 'totalpage']);
      const nm = pickField(obj, ['name', 'filename', 'title']);
      const sf = pickField(obj, ['suffix', 'filetype']);
      if (oid) objectId = String(oid);
      if (dl && /^https?:/i.test(dl)) downloadUrl = dl;
      if (pg) pageCount = parseInt(pg, 10) || 0;
      if (nm) title = nm;
      if (sf) suffix = String(sf).replace(/^\./, '').toLowerCase();
      if (objectId || downloadUrl) {
        source = `全局变量(${key})`;
        break;
      }
    }

    // 图片序列
    const urls = new Set();
    try {
      pageWindow[SPY_KEY]?.forEach((u) => urls.add(u));
    } catch {
      /* ignore */
    }
    collectImages(document).forEach((u) => urls.add(u));

    const seq = clusterSequence(urls);
    let images = [];
    let pdfUrl = null;

    if (seq) {
      if (!objectId) objectId = extractObjectId([...seq.pages.values()][0]);
      const prefix = extractDocPrefix([...seq.pages.values()][0]);
      if (prefix && objectId) pdfUrl = `${prefix}/pdf/${objectId}.pdf`;
      if (!pageCount) pageCount = seq.maxPage;
      const ext = seq.ext || 'png';
      for (let p = 1; p <= seq.maxPage; p++) {
        images.push(seq.pages.get(p) || `${seq.base}${p}.${ext}`);
      }
      if (!downloadUrl && !objectId) source = '图片序列';
    }

    if (!downloadUrl && !pdfUrl && images.length < 2) return null;

    const strategy = downloadUrl ? 'original' : pdfUrl ? 'pdf' : 'images';
    if (downloadUrl || pdfUrl) source = source.startsWith('全局') ? source : '直链推导';

    return {
      id: objectId || downloadUrl || images[0] || location.href,
      title: String(title).replace(/\.(pptx?|pdf|docx?)$/i, '').replace(/[\\/:*?"<>|]/g, '_').trim(),
      strategy,
      pageCount,
      suffix,
      objectId,
      downloadUrl,
      pdfUrl,
      images,
      source,
    };
  }

  async function autoScroll(onProgress) {
    const findScroller = () => {
      for (const sel of ['.panView', '.pdf-viewer', '#pageContainer', '.reader-container']) {
        const el = document.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight + 20) return el;
      }
      return document.scrollingElement || document.documentElement;
    };
    const scroller = findScroller();
    let last = -1;
    let stable = 0;

    for (let i = 0; i < 80; i++) {
      scroller.scrollBy(0, scroller.clientHeight || 800);
      await new Promise((r) => setTimeout(r, 200));
      const n = countPages();
      onProgress?.(n);
      if (n === last) {
        if (++stable >= 3) break;
      } else {
        stable = 0;
        last = n;
      }
    }
    scroller.scrollTo(0, 0);
  }

  function countPages() {
    const urls = new Set();
    try {
      pageWindow[SPY_KEY]?.forEach((u) => urls.add(u));
    } catch {
      /* ignore */
    }
    collectImages(document).forEach((u) => urls.add(u));
    const seq = clusterSequence(urls);
    return seq ? Math.max(seq.count, seq.maxPage) : 0;
  }

  // ==================================================================
  // 3. 零依赖 PDF 生成器（JPEG 直接以 DCTDecode 嵌入）
  // ==================================================================

  const enc = new TextEncoder();
  const byteLength = (d) => (typeof d === 'string' ? enc.encode(d).length : d.length);

  /** PDF 文本对象：ASCII 用字面量，含中文时改用 UTF-16BE 十六进制串 */
  function pdfText(text) {
    const str = String(text);
    if (/^[\x20-\x7e]*$/.test(str)) {
      return `(${str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
    }
    let hex = 'FEFF';
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0').toUpperCase();
        hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0').toUpperCase();
      } else {
        hex += cp.toString(16).padStart(4, '0').toUpperCase();
      }
    }
    return `<${hex}>`;
  }

  function buildPdf(pages, title) {
    const chunks = [];
    let offset = 0;
    const push = (data) => {
      const b = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(b);
      offset += b.length;
    };

    const total = 3 + pages.length * 3;
    const offsets = new Array(total + 1).fill(0);
    const begin = (id) => {
      offsets[id] = offset;
    };
    const pageId = (i) => 4 + i * 3;
    const imgId = (i) => 5 + i * 3;
    const contId = (i) => 6 + i * 3;

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // 二进制标记，必须是原始字节

    begin(1);
    push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    begin(2);
    push(
      `2 0 obj\n<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`
    );

    begin(3);
    push(`3 0 obj\n<< /Title ${pdfText(title)} /Producer (Chaoxing PPT Exporter) >>\nendobj\n`);

    pages.forEach((p, i) => {
      begin(pageId(i));
      push(
        `${pageId(i)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] ` +
          `/Resources << /XObject << /Im0 ${imgId(i)} 0 R >> >> /Contents ${contId(i)} 0 R >>\nendobj\n`
      );

      begin(imgId(i));
      push(
        `${imgId(i)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`
      );
      push(p.jpeg);
      push('\nendstream\nendobj\n');

      const content = `q\n${p.w} 0 0 ${p.h} 0 0 cm\n/Im0 Do\nQ\n`;
      begin(contId(i));
      push(`${contId(i)} 0 obj\n<< /Length ${byteLength(content)} >>\nstream\n${content}endstream\nendobj\n`);
    });

    const xrefOffset = offset;
    let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= total; id++) {
      xref += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
    }
    push(xref);
    push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    const size = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(size);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  // ==================================================================
  // 4. 取图 / 转码
  // ==================================================================

  function fetchBinary(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        headers: { Referer: location.href },
        timeout: 30000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300 && res.response && res.response.byteLength) {
            resolve(res.response);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('超时')),
      });
    });
  }

  async function toJpeg(buffer, quality, maxWidth) {
    const blob = new Blob([buffer]);
    const bitmap = await createImageBitmap(blob);
    let { width, height } = bitmap;
    if (maxWidth > 0 && width > maxWidth) {
      const r = maxWidth / width;
      width = Math.round(width * r);
      height = Math.round(height * r);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const url = canvas.toDataURL('image/jpeg', quality);
    const bin = atob(url.slice(url.indexOf(',') + 1));
    const jpeg = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) jpeg[i] = bin.charCodeAt(i);
    return { jpeg, w: width, h: height };
  }

  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    await Promise.all(
      new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        while (cursor < items.length) {
          const i = cursor++;
          try {
            results[i] = { ok: true, value: await worker(items[i], i) };
          } catch (e) {
            results[i] = { ok: false, error: e };
          }
        }
      })
    );
    return results;
  }

  // ==================================================================
  // 5. UI
  // ==================================================================

  const CARD_W = 460;
  const BALL = 46;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const CSS = `
    #cx-panel { position: fixed; left: 0; top: 12px; z-index: 2147483000;
      font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 13px; color: #1f2937; }
    #cx-panel .ball { display: none; width: 46px; height: 46px; border-radius: 50%;
      background: #2563eb; color: #fff; font-size: 11px; font-weight: 600;
      align-items: center; justify-content: center; cursor: pointer; user-select: none;
      box-shadow: 0 4px 14px rgba(37,99,235,.42); }
    #cx-panel .ball.ok { background: #059669; }
    #cx-panel .ball.err { background: #dc2626; }
    #cx-panel.mini .ball { display: flex; }
    #cx-panel.mini .card { display: none; }
    #cx-panel .card { width: ${CARD_W}px; max-width: calc(100vw - 24px); background: #fff;
      border: 1px solid #e5e7eb; border-radius: 12px;
      box-shadow: 0 10px 28px rgba(15,23,42,.16); overflow: hidden; }
    #cx-panel .head { display: flex; align-items: center; gap: 8px; padding: 9px 12px;
      background: #2563eb; color: #fff; cursor: move; user-select: none; }
    #cx-panel .head b { flex: 1; font-size: 13px; font-weight: 600; }
    #cx-panel .head span { background: rgba(255,255,255,.22); border-radius: 999px; padding: 1px 8px; font-size: 11px; }
    #cx-panel .head button { background: transparent; border: 0; color: #fff; font-size: 15px;
      cursor: pointer; padding: 2px 6px; border-radius: 5px; font-family: inherit; }
    #cx-panel .head button:hover { background: rgba(255,255,255,.2); }
    #cx-panel .body { padding: 10px 12px 11px; }
    #cx-panel .meta { font-size: 11.5px; color: #6b7280; margin-bottom: 9px; word-break: break-all; }
    #cx-panel .meta b { color: #374151; }
    #cx-panel .lead { display: block; font-size: 12.5px; color: #374151; font-weight: 600; margin-bottom: 5px; }
    #cx-panel .btns { display: flex; gap: 8px; flex-wrap: wrap; }
    #cx-panel button.act { flex: 1 1 100px; border: 0; border-radius: 8px; padding: 8px 10px;
      font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: inherit; }
    #cx-panel button.act:disabled { opacity: .55; cursor: not-allowed; }
    #cx-panel .primary { background: #2563eb; color: #fff; }
    #cx-panel .ghost { background: #f3f4f6; color: #374151; border: 1px solid #e5e7eb; }
    #cx-panel .prog { display: none; }
    #cx-panel .prog.show { display: block; }
    #cx-panel .bar { height: 8px; background: #d8dde4; border-radius: 999px; overflow: hidden; margin-top: 11px; }
    #cx-panel .fill { height: 100%; width: 0%; background: #2563eb; border-radius: 999px; transition: width .25s; }
    #cx-panel .fill.ok { background: #059669; }
    #cx-panel .fill.err { background: #dc2626; }
    #cx-panel .status { margin-top: 6px; font-size: 11.5px; color: #4b5563; display: flex; justify-content: space-between; gap: 8px; }
    #cx-panel .status .stext { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #cx-panel .status.err { color: #dc2626; font-weight: 600; }
    #cx-panel .status.ok { color: #059669; font-weight: 600; }
    #cx-panel .diag { display: none; margin-top: 8px; font-size: 11px; color: #6b7280;
      background: #f9fafb; border: 1px solid #eef0f3; border-radius: 6px; padding: 6px 8px; word-break: break-all; }
    #cx-panel .diag.show { display: block; }
    #cx-panel .hint { margin-top: 9px; font-size: 11px; color: #9ca3af;
      border-top: 1px dashed #e5e7eb; padding-top: 8px; }
  `;

  let panelRef = null;
  let busy = false;
  let currentDeck = null; // 本 frame 探测到的课件
  let childDeck = null; // 顶层：子 frame 报上来的课件
  let deckSource = null; // 顶层：报上来的那个 window，动作用它转发
  let cardPos = null; // {x,y}，null 表示用默认位置
  let ballPos = null;
  let minimized = false;
  let lastProbe = '';

  const isTopFrame = (() => {
    try {
      return window === window.top;
    } catch {
      return true;
    }
  })();

  /** 各 frame 的探测摘要，顶层汇总成一行诊断文字 */
  const probeFrames = new Map();
  const SELF_KEY = 'self';

  const settings = {
    quality: Number(GM_getValue('quality', 92)) / 100,
    concurrency: Number(GM_getValue('concurrency', 6)),
    maxWidth: Number(GM_getValue('maxWidth', 2600)),
    autoScroll: GM_getValue('autoScroll', true),
  };

  /** 面板常驻：没有课件时也要能看到插件在工作 */
  function ensurePanel() {
    if (!panelRef) buildPanel(null);
    return panelRef;
  }

  function buildPanel(initialDeck) {
    const host = document.createElement('div');
    host.id = 'cx-panel';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const ball = document.createElement('div');
    ball.className = 'ball';
    ball.title = '学习通课件导出 · 点击展开，可拖动';
    ball.textContent = '导出';
    shadow.appendChild(ball);

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="head"><b>学习通课件导出</b><span class="badge"></span>
        <button data-act="min" title="最小化成小球">–</button></div>
      <div class="body">
        <div class="meta"></div>
        <div class="btns"></div>
        <div class="prog">
          <div class="bar"><div class="fill"></div></div>
          <div class="status"><span class="stext"></span><span class="snum"></span></div>
        </div>
        <div class="diag"></div>
        <div class="hint">面板会一直悬浮在这里；缩成小球后球面上仍显示进度百分比。</div>
      </div>`;
    shadow.appendChild(card);
    document.documentElement.appendChild(host);

    const el = {
      badge: shadow.querySelector('.badge'),
      meta: shadow.querySelector('.meta'),
      btns: shadow.querySelector('.btns'),
      prog: shadow.querySelector('.prog'),
      fill: shadow.querySelector('.fill'),
      status: shadow.querySelector('.status'),
      stext: shadow.querySelector('.stext'),
      snum: shadow.querySelector('.snum'),
      diag: shadow.querySelector('.diag'),
    };

    // ---- 位置：浮窗默认顶部居中，小球默认右上角，各自记一份 ----
    function defaultPos(mini) {
      if (mini) return { x: Math.max(8, window.innerWidth - BALL - 16), y: 10 };
      return { x: Math.max(8, Math.round((window.innerWidth - CARD_W) / 2)), y: 12 };
    }

    function applyPos() {
      const w = minimized ? BALL : Math.min(CARD_W, window.innerWidth - 24);
      const h = minimized ? BALL : card.offsetHeight || 210;
      let p = minimized ? ballPos : cardPos;
      if (!p) p = defaultPos(minimized);
      const x = clamp(p.x, 8, Math.max(8, window.innerWidth - w - 8));
      const y = clamp(p.y, 8, Math.max(8, window.innerHeight - h - 8));
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
      if (minimized) ballPos = { x, y };
      else cardPos = { x, y };
    }

    function bindDrag(target, onTap) {
      let dragging = false;
      let moved = false;
      let sx = 0;
      let sy = 0;
      let bx = 0;
      let by = 0;

      target.addEventListener('mousedown', (e) => {
        if (e.target.dataset && e.target.dataset.act) return;
        const p = (minimized ? ballPos : cardPos) || defaultPos(minimized);
        dragging = true;
        moved = false;
        sx = e.clientX;
        sy = e.clientY;
        bx = p.x;
        by = p.y;
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const mx = e.clientX - sx;
        const my = e.clientY - sy;
        if (Math.abs(mx) > 3 || Math.abs(my) > 3) moved = true;
        const next = { x: bx + mx, y: by + my };
        if (minimized) ballPos = next;
        else cardPos = next;
        applyPos();
      });

      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        if (!moved && onTap) onTap();
      });
    }

    function minimize() {
      minimized = true;
      host.classList.add('mini');
      if (!ballPos) {
        const p = cardPos || defaultPos(false);
        ballPos = { x: p.x + CARD_W - BALL, y: p.y };
      }
      applyPos();
    }

    function expand() {
      minimized = false;
      host.classList.remove('mini');
      if (!cardPos) cardPos = defaultPos(false);
      applyPos();
      requestAnimationFrame(applyPos);
    }

    bindDrag(ball, expand);
    bindDrag(shadow.querySelector('.head'));
    shadow.querySelector('[data-act="min"]').onclick = minimize;
    applyPos();
    window.addEventListener('resize', applyPos);

    function render(d) {
      const deck = d || null;
      el.btns.innerHTML = '';

      const mk = (label, cls, fn) => {
        const b = document.createElement('button');
        b.className = `act ${cls}`;
        b.textContent = label;
        b.disabled = busy;
        b.onclick = () => !busy && fn();
        el.btns.appendChild(b);
        return b;
      };

      if (!deck) {
        el.badge.textContent = '等待课件';
        el.meta.innerHTML =
          '<span class="lead">插件已就绪，正在等课件加载</span>' +
          '打开章节里的 PPT 课件，或往下翻几页触发加载，然后点重新检测。';
        mk('重新检测', 'primary', redetect);
        applyPos();
        return;
      }

      el.badge.textContent = deck.pageCount ? `${deck.pageCount} 页` : '未知页数';
      const strat = { original: '原始文件直链（无损）', pdf: 'PDF 直链', images: '逐页图片合成' }[deck.strategy] || '未知';
      el.meta.innerHTML = `《<b>${deck.title}</b>》<br>方式：<b>${strat}</b>　来源：${deck.source || ''}`;

      if (deck.downloadUrl) mk('下载原文件', 'primary', () => runAction('original'));
      else if (deck.pdfUrl) mk('下载 PDF', 'primary', () => runAction('original'));
      mk('提取并导出 PDF', deck.downloadUrl || deck.pdfUrl ? 'ghost' : 'primary', () => runAction('export'));
      mk('复制直链', 'ghost', () => runAction('copy'));
      applyPos();
    }

    function setBusy(v) {
      busy = v;
      shadow.querySelectorAll('button.act').forEach((b) => (b.disabled = v));
      if (v) {
        el.fill.classList.remove('ok', 'err');
        ball.classList.remove('ok', 'err');
      }
    }

    function progress(done, total, text, kind) {
      const known = total > 0;
      const pct = known ? Math.min(100, Math.round((done / total) * 100)) : 0;
      el.prog.classList.add('show');
      el.fill.style.width = known ? `${pct}%` : '0%';
      if (text != null) el.stext.textContent = text;
      el.snum.textContent = known ? `${done}/${total} · ${pct}%` : '';
      el.status.classList.remove('err', 'ok');
      el.fill.classList.remove('err', 'ok');
      ball.classList.remove('ok', 'err');
      if (kind === 'err') {
        el.status.classList.add('err');
        el.fill.classList.add('err');
        ball.classList.add('err');
        ball.textContent = '失败';
      } else if (kind === 'ok') {
        el.status.classList.add('ok');
        el.fill.classList.add('ok');
        ball.classList.add('ok');
        ball.textContent = known ? `${pct}%` : '完成';
      } else {
        ball.textContent = known ? `${pct}%` : '···';
      }
      applyPos();
    }

    function toast(text, kind) {
      progress(0, 0, text, kind);
      el.fill.style.width = '100%';
    }

    function setDiag(text) {
      el.diag.textContent = text || '';
      el.diag.classList.toggle('show', !!text);
      applyPos();
    }

    render(initialDeck);
    panelRef = { host, render, setBusy, progress, toast, setDiag, el };
    return panelRef;
  }

  // ==================================================================
  // 5b. 跨 frame 通信
  //
  // 课件 iframe 与章节页跨域，但 postMessage 不受同源限制，所以：
  //   子 frame 探测到课件 → 报给顶层 → 顶层显示面板
  //   顶层点按钮 → 把动作回发给课件所在的 frame 执行（Cookie/Referer 都依赖那个文档）
  // ==================================================================

  function sendToTop(msg) {
    try {
      window.top.postMessage(msg, '*');
    } catch {
      /* 拿不到 top 就算了 */
    }
  }

  function broadcast(msg) {
    try {
      for (let i = 0; i < window.frames.length; i++) window.frames[i].postMessage(msg, '*');
    } catch {
      /* ignore */
    }
  }

  function originOk(origin) {
    try {
      const hostname = new URL(origin).hostname;
      return /(^|\.)chaoxing\.com$/.test(hostname) || /(^|\.)xueyinonline\.com$/.test(hostname);
    } catch {
      return false;
    }
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || !d.cx || !originOk(e.origin)) return;

    // 顶层：子 frame 报上来的课件 / 探测摘要 / 运行状态
    if (isTopFrame) {
      if (d.cx === 'deck') {
        childDeck = d.deck;
        deckSource = e.source;
        ensurePanel().render(childDeck);
        renderDiagnostic();
      } else if (d.cx === 'probe') {
        probeFrames.set(e.source, d.data || {});
        renderDiagnostic();
      } else if (d.cx === 'feedback' && panelRef) {
        const f = d.data || {};
        if (f.kind === 'progress') panelRef.progress(f.done || 0, f.total || 0, f.text || '', f.tone || null);
        else if (f.kind === 'toast') panelRef.toast(f.text || '', f.tone || null);
        else if (f.kind === 'busy') panelRef.setBusy(!!f.busy);
      }
      return;
    }

    // 子 frame：只接受顶层下发的动作，且任务必须在本 frame 执行
    if (d.cx === 'action') {
      if (e.source !== window.top || !currentDeck) return;
      executeLocal(d.action, d.payload);
      return;
    }

    // 所有 frame：重新探测（并继续往下传，覆盖嵌套 iframe）
    if (d.cx === 'redetect') {
      broadcast(d);
      tick();
    }
  });

  function renderDiagnostic() {
    if (!panelRef) return;
    if (currentDeck || childDeck) {
      panelRef.setDiag('');
      return;
    }
    let images = 0;
    let withFileinfo = 0;
    for (const r of probeFrames.values()) {
      images = Math.max(images, r.images || 0);
      if (r.hasFileinfo) withFileinfo++;
    }
    panelRef.setDiag(
      `[诊断] 已监听 ${probeFrames.size} 个框架 · 捕获图片 ${images} 张 · ` +
        (withFileinfo ? `${withFileinfo} 个框架有 fileinfo` : '未见到 fileinfo')
    );
  }

  function reportProbe(deck) {
    let images = 0;
    try {
      images = (pageWindow[SPY_KEY] && pageWindow[SPY_KEY].size) || 0;
    } catch {
      /* 诊断信息而已，拿不到就算了 */
    }
    const data = { images, hasFileinfo: !!pageWindow.fileinfo, ready: !!deck };
    const key = JSON.stringify(data);
    if (key === lastProbe) return;
    lastProbe = key;

    if (isTopFrame) {
      probeFrames.set(SELF_KEY, data);
      renderDiagnostic();
    } else {
      sendToTop({ cx: 'probe', data });
    }
  }

  function redetect() {
    broadcast({ cx: 'redetect' });
    tick();
  }

  function runAction(action, payload) {
    if (currentDeck) {
      executeLocal(action, payload);
      return;
    }
    if (deckSource) {
      try {
        deckSource.postMessage({ cx: 'action', action, payload: payload || {} }, '*');
        return;
      } catch {
        /* 落到下面提示 */
      }
    }
    uiToast('还没检测到课件，先翻几页再点重新检测', 'err');
  }

  function executeLocal(action, payload) {
    const deck = currentDeck;
    if (action === 'original') {
      const url = (payload && payload.url) || (deck && (deck.downloadUrl || deck.pdfUrl));
      if (!url) {
        uiToast('没有可用的直链', 'err');
        return;
      }
      window.open(url, '_blank', 'noopener');
      uiToast('已发起下载，若浏览器只是打开预览请右键另存', 'ok');
      return;
    }
    if (action === 'export') {
      exportPdf();
      return;
    }
    if (action === 'copy') {
      const lines = [];
      if (deck) {
        if (deck.downloadUrl) lines.push(`原始文件：${deck.downloadUrl}`);
        if (deck.pdfUrl) lines.push(`PDF：${deck.pdfUrl}`);
        if (deck.images && deck.images.length) {
          lines.push(`图片前缀：${deck.images[0].replace(/\d+\.(png|jpe?g|webp)$/i, '')}`);
        }
      }
      const text = lines.join('\n') || '（没有可导出的直链）';
      const done = () => uiToast('链接已复制', 'ok');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
      } else {
        fallbackCopy(text, done);
      }
      return;
    }
    if (action === 'redetect') redetect();
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch {
      uiToast('复制失败，请手动查看控制台', 'err');
      log('课件直链：\n' + text);
    }
    ta.remove();
  }

  // ---- 运行状态：本 frame 有面板就画在本地，没有就报给顶层 ----
  function uiProgress(done, total, text, kind) {
    if (panelRef) panelRef.progress(done, total, text, kind);
    else sendToTop({ cx: 'feedback', data: { kind: 'progress', done, total, text, tone: kind } });
  }

  function uiToast(text, kind) {
    if (panelRef) panelRef.toast(text, kind);
    else sendToTop({ cx: 'feedback', data: { kind: 'toast', text, tone: kind } });
  }

  function uiSetBusy(v) {
    busy = v;
    if (panelRef) panelRef.setBusy(v);
    else sendToTop({ cx: 'feedback', data: { kind: 'busy', busy: v } });
  }

  async function exportPdf() {
    // 注意：本函数可能在"没有面板"的 frame 里执行（面板在顶层，课件在子 frame），
    // 所以状态一律走 ui* 系列，它们会自动决定画在本地面板还是报给顶层。
    uiSetBusy(true);
    uiProgress(0, 0, '准备中…');

    try {
      let deck = detect() || currentDeck;

      if (!deck) {
        uiToast('还没检测到课件，先翻几页再点重新检测', 'err');
        return;
      }

      if (settings.autoScroll && deck.images && deck.images.length) {
        // 页数未知时 total 传 0，进度条不硬凑比例
        uiProgress(0, deck.pageCount || 0, '正在滚动加载全部页面…');
        await autoScroll((n) => uiProgress(n, deck.pageCount || 0, `正在加载页面…（已发现 ${n} 页）`));
        deck = detect() || deck;
      }
      currentDeck = deck;

      if (!deck || !deck.images || !deck.images.length) {
        uiToast('没有检测到课件图片', 'err');
        return;
      }

      const total = deck.images.length;
      let done = 0;
      const failures = [];

      const results = await mapLimit(deck.images, settings.concurrency, async (url, i) => {
        try {
          const buf = await fetchBinary(url);
          const page = await toJpeg(buf, settings.quality, settings.maxWidth);
          done++;
          uiProgress(done, total, '正在下载图片…');
          return page;
        } catch (e) {
          failures.push(i + 1);
          log(`第 ${i + 1} 页失败: ${url}`, e);
          return null;
        }
      });

      const pages = results.filter((r) => r.ok && r.value).map((r) => r.value);
      if (!pages.length) throw new Error('所有页面都下载失败了');

      uiProgress(0, 0, '正在合成 PDF…');
      const pdf = buildPdf(pages, deck.title);
      const blob = new Blob([pdf], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${deck.title}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);

      const msg = failures.length
        ? `完成 ${pages.length}/${total} 页，${failures.length} 页失败`
        : `${deck.title}.pdf 已保存（${(blob.size / 1048576).toFixed(1)} MB）`;
      uiProgress(pages.length, total, msg, failures.length ? 'err' : 'ok');
    } catch (e) {
      uiToast(`导出失败：${e.message}`, 'err');
      log('导出失败', e);
    } finally {
      uiSetBusy(false);
    }
  }

  // ==================================================================
  // 6. 启动
  // ==================================================================

  installImageSpy();

  function tick() {
    if (busy) return;
    let deck;
    try {
      deck = detect();
    } catch (e) {
      log('探测异常', e);
      return;
    }

    reportProbe(deck);

    if (!deck) return;
    // 至少要有可落地的产出
    if (!deck.downloadUrl && !deck.pdfUrl && (!deck.images || deck.images.length < 2)) return;

    currentDeck = deck;

    if (isTopFrame) {
      // 顶层自己就是课件页（比如直接打开课件），本地显示即可
      childDeck = null;
      deckSource = null;
      ensurePanel().render(deck);
      renderDiagnostic();
      log('已检测到课件', deck);
    } else {
      // 课件在子 frame：报给顶层显示，动作再由顶层回发到本 frame 执行
      sendToTop({ cx: 'deck', deck });
      log('已检测到课件，上交给顶层面板', deck);
    }
  }

  function start() {
    // 顶层先把面板立起来：常驻，不依赖探测结果
    if (isTopFrame) ensurePanel();
    [0, 1000, 2500, 5000, 9000].forEach((d) => setTimeout(tick, d));
    setInterval(tick, 6000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  GM_registerMenuCommand?.('立即扫描课件', redetect);
})();
