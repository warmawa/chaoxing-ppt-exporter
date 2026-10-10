/**
 * detector.js — 学习通课件探测引擎
 *
 * 学习通的课件呈现方式历史上变过好几轮，且同一门课里可能混用多种方式，
 * 所以这里不押注单一方案，而是同时跑多条策略，取信息最完整的那一条：
 *
 *   策略 A（最优）云盘预览页的 window.fileinfo → 拿到原始文件直链，无损下载
 *   策略 B            PDF 直链                    → 拿到转码后的 PDF
 *   策略 C（兜底）页面图片序列 thumb/N.png        → 逐页下载后合成 PDF
 *
 * 另外装了一个"图片间谍"：在页面脚本运行前劫持 img.src / fetch / XHR，
 * 把加载过的所有课件图片 URL 记下来。这样即使图片是懒加载、
 * 或者 DOM 里的 data-src 属性名又换了，只要图片加载过就能抓到。
 */

(function (global) {
  'use strict';

  /** 课件图片 URL 的形态：.../doc/xx/yy/zz/<32位objectId>/thumb/<页码>.png */
  const THUMB_RE = /^(.*\/doc\/[0-9a-f]{8,40}\/)thumb\/(\d+)\.(png|jpe?g|webp|gif)(\?.*)?$/i;
  /** 更宽松的形态：任意 .../thumb/<数字>.<图片后缀> */
  const THUMB_LOOSE_RE = /^(.*\/)thumb\/(\d+)\.(png|jpe?g|webp|gif)(\?.*)?$/i;

  /** 课程页里那些乱七八糟的小图标，不能当成课件页 */
  const NOISE_RE = /(avatar|logo|icon|emoji|banner|ad[sx]?\/|headImg|userImg|cover_)/i;

  const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)(\?.*)?$/i;

  // ------------------------------------------------------------------
  // 图片间谍
  // ------------------------------------------------------------------

  const SPY_KEY = '__cxImageUrls';

  function installImageSpy() {
    if (global[SPY_KEY]) return global[SPY_KEY];

    const seen = new Set();
    global[SPY_KEY] = seen;

    const record = (url) => {
      if (typeof url !== 'string' || !url) return;
      if (!IMAGE_EXT_RE.test(url)) return;
      if (NOISE_RE.test(url)) return;
      try {
        seen.add(new URL(url, location.href).href);
      } catch {
        /* 相对路径或畸形 URL，忽略 */
      }
    };

    // 1) 劫持 <img>.src 的 setter
    try {
      const proto = HTMLImageElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'src');
      if (desc && desc.set) {
        Object.defineProperty(proto, 'src', {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set(value) {
            record(value);
            return desc.set.call(this, value);
          },
        });
      }
      // srcset 也顺手记一下
      const srcsetDesc = Object.getOwnPropertyDescriptor(proto, 'srcset');
      if (srcsetDesc && srcsetDesc.set) {
        Object.defineProperty(proto, 'srcset', {
          configurable: true,
          enumerable: srcsetDesc.enumerable,
          get: srcsetDesc.get,
          set(value) {
            String(value || '')
              .split(',')
              .forEach((part) => record(part.trim().split(/\s+/)[0]));
            return srcsetDesc.set.call(this, value);
          },
        });
      }
    } catch (e) {
      console.debug('[CX] 劫持 img.src 失败', e);
    }

    // 2) 劫持 fetch
    try {
      const origFetch = global.fetch;
      if (origFetch) {
        global.fetch = function (input, init) {
          try {
            const url = typeof input === 'string' ? input : input && input.url;
            record(url);
          } catch {
            /* ignore */
          }
          return origFetch.apply(this, arguments);
        };
      }
    } catch (e) {
      console.debug('[CX] 劫持 fetch 失败', e);
    }

    // 3) 劫持 XHR
    try {
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        record(url);
        return origOpen.apply(this, arguments);
      };
    } catch (e) {
      console.debug('[CX] 劫持 XHR 失败', e);
    }

    // 4) 兜底：MutationObserver 扫描后插入的图片
    try {
      const mo = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === 'attributes' && r.target instanceof HTMLImageElement) {
            record(r.target.currentSrc || r.target.src);
          } else if (r.addedNodes && r.addedNodes.length) {
            for (const node of r.addedNodes) {
              if (!(node instanceof Element)) continue;
              if (node instanceof HTMLImageElement) {
                record(node.currentSrc || node.src);
              }
              node.querySelectorAll?.('img').forEach((img) => record(img.currentSrc || img.src));
            }
          }
        }
      });
      mo.observe(document.documentElement || document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src', 'srcset'],
      });
    } catch (e) {
      console.debug('[CX] MutationObserver 失败', e);
    }

    return seen;
  }

  // ------------------------------------------------------------------
  // 工具函数
  // ------------------------------------------------------------------

  /**
   * 去掉末尾的 /thumb/<页码>.<后缀>，剩下的就是文档前缀。
   *
   * 这里不能靠 "doc/ 后面跟几段十六进制目录" 去猜：超星的路径深度是变的
   * （doc/8f/1b/f7/<oid>/ 或 doc/ab/<oid>/ 都出现过），而且 objectId 本身就是
   * 十六进制串，可以继续被切成两两一段，正则会自吞。直接从 /thumb/ 切最稳。
   */
  function extractDocPrefix(url) {
    const m = /^(.*)\/thumb\/\d+\.(?:png|jpe?g|webp|gif)(?:\?.*)?$/i.exec(url);
    return m ? m[1] : null;
  }

  /** objectId 总是前缀的最后一段 */
  function extractObjectId(url) {
    const prefix = extractDocPrefix(url);
    if (prefix) {
      const m = /\/([0-9a-f]{8,40})$/i.exec(prefix);
      if (m) return m[1];
    }
    // 没有 /thumb/ 的 URL：退回到"任意 16~40 位十六进制路径段"
    const m2 = /\/([0-9a-f]{16,40})(?:\/|\.|$)/i.exec(url);
    return m2 ? m2[1] : null;
  }

  /** 由前缀推导 PDF 直链：超星把转码后的 PDF 放在同前缀的 pdf/<oid>.pdf */
  function derivePdfUrl(prefix, objectId) {
    if (!prefix || !objectId) return null;
    return `${prefix}/pdf/${objectId}.pdf`;
  }

  /** 原始文件下载直链（云盘下载网关） */
  function deriveDownloadUrl(objectId) {
    if (!objectId) return null;
    return `https://cs.ananas.chaoxing.com/download/${objectId}`;
  }

  /** ue­ditorupload 备用下载口 */
  function deriveReadUrl(objectId) {
    if (!objectId) return null;
    return `https://mooc1.chaoxing.com/ueditorupload/read?objectId=${objectId}`;
  }

  function toAbs(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return null;
    }
  }

  function normalizeTitle(name) {
    return String(name || '')
      .replace(/\.(pptx?|pdf|doc|docx|pps|ppsx|key|dps)$/i, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim();
  }

  // ------------------------------------------------------------------
  // 策略 A：页面全局变量（window.fileinfo / mArg 等）
  // ------------------------------------------------------------------

  const GLOBAL_KEYS = [
    'fileinfo',
    'fileInfo',
    'FILEINFO',
    'file_info',
    'docInfo',
    'documentInfo',
    'panViewData',
    'attachment',
    'mArg',
    'args',
    'docData',
    'pptInfo',
    'courseware',
  ];

  /** 判断一个对象是不是"文件信息"，用鸭子类型：含 objectId / download / pagenum 之一 */
  function looksLikeFileInfo(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const keys = Object.keys(obj);
    if (keys.length === 0 || keys.length > 200) return false;
    const lower = new Set(keys.map((k) => k.toLowerCase()));
    return (
      (lower.has('objectid') && (lower.has('download') || lower.has('pagenum') || lower.has('suffix'))) ||
      (lower.has('download') && lower.has('suffix')) ||
      (lower.has('pagenum') && lower.has('thumb'))
    );
  }

  function pickField(obj, names) {
    for (const n of names) {
      const key = Object.keys(obj).find((k) => k.toLowerCase() === n);
      if (key !== undefined && obj[key] != null && obj[key] !== '') return obj[key];
    }
    return null;
  }

  /** 在 window 上有限度地扫描，避免深遍历卡死 */
  function scanGlobals() {
    const found = [];
    const visited = new Set();

    const consider = (obj, where) => {
      if (!obj || visited.has(obj)) return;
      visited.add(obj);
      if (looksLikeFileInfo(obj)) found.push({ obj, where });
    };

    for (const key of GLOBAL_KEYS) {
      try {
        consider(global[key], key);
      } catch {
        /* 跨域访问会抛异常 */
      }
    }

    // 兜底：扫 window 自有属性的一层，找含 objectId 的对象
    try {
      for (const key of Object.getOwnPropertyNames(global)) {
        if (visited.size > 40) break;
        try {
          const val = global[key];
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            const lower = new Set(Object.keys(val).map((k) => k.toLowerCase()));
            if (lower.has('objectid') || lower.has('pagenum')) consider(val, key);
          }
          // mArg 这类容器会把信息挂在子字段上
          if (val && typeof val === 'object') {
            for (const sub of ['fileinfo', 'fileInfo', 'attachments', 'doc', 'data']) {
              let child = null;
              try {
                child = val[sub];
              } catch {
                child = null;
              }
              if (Array.isArray(child)) {
                child.forEach((c) => {
                  if (c && typeof c === 'object') consider(c.property || c.fileinfo || c, `${key}.${sub}`);
                });
              } else {
                consider(child, `${key}.${sub}`);
              }
            }
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }

    return found;
  }

  // ------------------------------------------------------------------
  // 策略 C：从 DOM / 间谍记录里还原图片序列
  // ------------------------------------------------------------------

  function collectImageUrls() {
    const urls = new Set();

    // 间谍记录
    try {
      const spy = global[SPY_KEY];
      if (spy && spy.forEach) spy.forEach((u) => urls.add(u));
    } catch {
      /* ignore */
    }

    // DOM：src 以及各种懒加载属性
    const attrs = ['src', 'data-src', 'data-original', 'data-echo', 'data-loadsrc', 'data-url', 'currentSrc'];
    document.querySelectorAll('img').forEach((img) => {
      for (const a of attrs) {
        const v = img.getAttribute ? img.getAttribute(a) : null;
        if (v) {
          const abs = toAbs(v);
          if (abs) urls.add(abs);
        }
      }
      if (img.currentSrc) urls.add(img.currentSrc);
      if (img.src) urls.add(img.src);
    });

    // 背景图
    document.querySelectorAll('[style*="url("]').forEach((el) => {
      const m = /url\(['"]?([^'")]+)['"]?\)/.exec(el.getAttribute('style') || '');
      if (m) {
        const abs = toAbs(m[1]);
        if (abs) urls.add(abs);
      }
    });

    return [...urls].filter((u) => IMAGE_EXT_RE.test(u) && !NOISE_RE.test(u));
  }

  /**
   * 把一堆图片 URL 按 "前缀 + 页码" 聚类，挑出最像课件的那一组
   */
  function clusterImageSequence(urls) {
    const groups = new Map();

    for (const url of urls) {
      const m = THUMB_RE.exec(url) || THUMB_LOOSE_RE.exec(url);
      if (!m) continue;
      const [, base, pageStr, ext] = m;
      const page = parseInt(pageStr, 10);
      if (!Number.isFinite(page) || page < 0 || page > 5000) continue;
      if (!groups.has(base)) groups.set(base, { base, pages: new Map(), ext: ext.toLowerCase() });
      groups.get(base).pages.set(page, url);
    }

    const candidates = [...groups.values()]
      .map((g) => {
        const pageNums = [...g.pages.keys()].sort((a, b) => a - b);
        return {
          base: g.base,
          ext: g.ext,
          maxPage: pageNums.length ? pageNums[pageNums.length - 1] : 0,
          count: pageNums.length,
          urls: g.pages,
        };
      })
      // 只有一两页的通常是误判（比如封面图）
      .filter((c) => c.count >= 2 || c.maxPage >= 3)
      .sort((a, b) => b.maxPage - a.maxPage || b.count - a.count);

    return candidates[0] || null;
  }

  // ------------------------------------------------------------------
  // 主入口
  // ------------------------------------------------------------------

  /**
   * 探测当前 frame 里的课件
   * @returns {null | {
   *   id, title, strategy, pageCount, suffix, objectId, docPrefix,
   *   downloadUrl, pdfUrl, readUrl, images: string[], source: string
   * }}
   */
  function detect() {
    installImageSpy();

    let title = '';
    let objectId = null;
    let pageCount = 0;
    let suffix = null;
    let downloadUrl = null;
    let pdfUrl = null;
    let docPrefix = null;
    let source = '';

    // --- 策略 A：页面全局变量 ---
    const globalHits = scanGlobals();
    for (const hit of globalHits) {
      const o = hit.obj;
      const oid = pickField(o, ['objectid', 'object_id', 'id']);
      const dl = pickField(o, ['download', 'downloadurl', 'download_url', 'url', 'fileurl', 'file_url']);
      const pg = pickField(o, ['pagenum', 'page_num', 'pagecount', 'pages', 'totalpage', 'total_page']);
      const nm = pickField(o, ['name', 'filename', 'file_name', 'title', 'displayname']);
      const sf = pickField(o, ['suffix', 'ext', 'type', 'filetype']);

      if (!objectId && oid) objectId = String(oid);
      if (!downloadUrl && dl && typeof dl === 'string' && /^https?:/i.test(dl)) downloadUrl = toAbs(dl);
      if (!pageCount && pg) pageCount = parseInt(pg, 10) || 0;
      if (!title && nm && typeof nm === 'string') title = nm;
      if (!suffix && sf && typeof sf === 'string') suffix = sf.replace(/^\./, '').toLowerCase();
      if (objectId && (downloadUrl || pageCount)) {
        source = `全局变量(${hit.where})`;
        break;
      }
    }

    // --- 策略 B/C：图片序列 ---
    const rawUrls = collectImageUrls();
    const seq = clusterImageSequence(rawUrls);

    if (seq) {
      docPrefix = extractDocPrefix([...seq.urls.values()][0]) || null;
      const seqOid = extractObjectId([...seq.urls.values()][0]);
      if (!objectId) objectId = seqOid;
      if (!pageCount || seq.maxPage > pageCount) pageCount = seq.maxPage;
      if (!docPrefix && seqOid) docPrefix = null;

      if (!source) source = '图片序列';
      if (!pdfUrl) pdfUrl = derivePdfUrl(docPrefix, objectId);

      // 生成完整图片列表（页码 1..maxPage，缺失的按规律补）
      const sampleUrl = [...seq.urls.values()][0];
      const ext = seq.ext || 'png';
      const images = [];
      for (let p = 1; p <= seq.maxPage; p++) {
        const known = seq.urls.get(p);
        images.push(known || `${seq.base}${p}.${ext}`);
      }

      if (!objectId && !downloadUrl) {
        return {
          id: sampleUrl,
          title: normalizeTitle(title || document.title || '未命名课件'),
          strategy: 'images',
          pageCount: images.length,
          suffix: suffix || ext,
          objectId,
          docPrefix,
          downloadUrl: null,
          pdfUrl,
          readUrl: objectId ? deriveReadUrl(objectId) : null,
          images,
          source,
        };
      }
    }

    // --- 汇总 ---
    if (!objectId && !downloadUrl && !seq) return null;

    if (!pdfUrl) pdfUrl = derivePdfUrl(docPrefix, objectId);
    const readUrl = objectId ? deriveReadUrl(objectId) : null;
    if (!downloadUrl && objectId && (!suffix || suffix === 'pdf')) {
      // 没有明确直链时，至少保留网关地址供用户手动尝试
      downloadUrl = null;
    }

    // 有原始文件直链 → 走无损策略；否则退到 PDF 直链；再不行就合成图片
    let strategy = 'images';
    if (downloadUrl) strategy = 'original';
    else if (pdfUrl) strategy = 'pdf';

    const images =
      seq && strategy === 'images'
        ? (() => {
            const ext = seq.ext || 'png';
            const out = [];
            for (let p = 1; p <= seq.maxPage; p++) {
              out.push(seq.urls.get(p) || `${seq.base}${p}.${ext}`);
            }
            return out;
          })()
        : [];

    if (!title) {
      const heads = document.querySelectorAll('h1, h2, .title, .file-name, .filename');
      title = (heads[0] && heads[0].textContent) || document.title || '未命名课件';
    }

    return {
      id: objectId || downloadUrl || docPrefix || location.href,
      title: normalizeTitle(title),
      strategy,
      pageCount: pageCount || images.length || 0,
      suffix: suffix || '',
      objectId,
      docPrefix,
      downloadUrl,
      pdfUrl,
      readUrl,
      images,
      source: source || '未知',
    };
  }

  /**
   * 自动滚动页面，触发懒加载，把剩余页的图片都骗出来
   * @param {Object} opts
   * @param {number} opts.maxRounds 最大滚动轮数
   * @param {number} opts.delay     每轮间隔 ms
   * @param {(loaded:number)=>void} opts.onProgress
   */
  async function autoScroll({ maxRounds = 60, delay = 220, onProgress = () => {} } = {}) {
    const scroller = findScrollContainer();
    let lastCount = -1;
    let stable = 0;

    for (let i = 0; i < maxRounds; i++) {
      scroller.scrollBy(0, scroller.clientHeight || 800);
      await sleep(delay);
      const count = countLoadedPages();
      onProgress(count);
      if (count === lastCount) {
        if (++stable >= 3) break; // 连续 3 轮没新图，认为到底了
      } else {
        stable = 0;
        lastCount = count;
      }
    }
    scroller.scrollTo(0, 0);
    return countLoadedPages();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function findScrollContainer() {
    const sel = ['.panView', '.pdf-viewer', '#pageContainer', '.reader-container', '.doc-page-wrap'];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el && el.scrollHeight > el.clientHeight + 20) return el;
    }
    const sc = document.scrollingElement || document.documentElement;
    return sc.scrollHeight > sc.clientHeight + 20 ? sc : sc;
  }

  function countLoadedPages() {
    const urls = collectImageUrls();
    const seq = clusterImageSequence(urls);
    return seq ? Math.max(seq.count, seq.maxPage) : 0;
  }

  const CXDetector = {
    detect,
    autoScroll,
    installImageSpy,
    collectImageUrls,
    clusterImageSequence,
    extractObjectId,
    extractDocPrefix,
    derivePdfUrl,
    deriveDownloadUrl,
    deriveReadUrl,
    normalizeTitle,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CXDetector;
  }
  global.CXDetector = CXDetector;
})(typeof window !== 'undefined' ? window : globalThis);
