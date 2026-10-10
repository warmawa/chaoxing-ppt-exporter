/**
 * offscreen.js — 图片下载 + 转码 + PDF 合成
 *
 * 运行在 offscreen document 中。之所以不放在 background service worker 里，
 * 是因为 MV3 的 service worker 没有 DOM，拿不到 canvas，无法把 PNG/WebP 转成 JPEG。
 *
 * 流程：并发拉图 → 解码 → 画到白色画布上（PNG 常有透明通道，直接嵌会发黑）→
 *       转 JPEG → 交给零依赖的 PdfWriter 拼成 PDF → 触发下载。
 */

'use strict';

const DEFAULTS = {
  quality: 0.92,
  concurrency: 6,
  maxWidth: 2600,
  retries: 3,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reportProgress(jobId, done, total, phase) {
  chrome.runtime.sendMessage({ type: 'cx:progress', jobId, done, total, phase }).catch(() => {});
}

/** 带重试地抓取一张图片，返回 ArrayBuffer */
async function fetchImage(url, retries) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        mode: 'cors',
        cache: 'force-cache',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (!buf || buf.byteLength === 0) throw new Error('空响应');
      return buf;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(300 * attempt);
    }
  }
  throw lastErr || new Error('下载失败');
}

/**
 * 把任意浏览器能解码的图片字节转成 JPEG 字节
 * @returns {Promise<{jpeg: Uint8Array, width: number, height: number}>}
 */
async function toJpeg(buffer, quality, maxWidth) {
  const blob = new Blob([buffer]);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    throw new Error('图片解码失败：' + (err && err.message));
  }

  let { width, height } = bitmap;
  // 超宽图按比例缩一缩，否则几十页下来 PDF 能到几百 MB
  if (maxWidth > 0 && width > maxWidth) {
    const ratio = maxWidth / width;
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());
  return { jpeg, width, height };
}

/** 简易并发池 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (err) {
        results[index] = { ok: false, error: err };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** 触发文件下载。优先用带文件名的原生下载，失败再退回 data URL 交给 background */
function saveBlob(blob, filename) {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      resolve({ ok: true, via: 'anchor' });
    } catch (err) {
      resolve({ ok: false, error: err && err.message });
    }
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * 主任务：把图片列表合成 PDF 并保存
 */
async function buildPdf(payload) {
  const {
    jobId,
    images = [],
    title = '课件',
    settings = {},
    tabId = null,
    referer = null,
  } = payload;

  const opts = { ...DEFAULTS, ...settings };
  const total = images.length;
  if (total === 0) throw new Error('没有可处理的图片');

  reportProgress(jobId, 0, total, 'download');

  let done = 0;
  const failures = [];

  const results = await mapWithConcurrency(images, opts.concurrency, async (url, index) => {
    let buffer;
    try {
      buffer = await fetchImage(url, opts.retries);
    } catch (err) {
      // 少数课程在下载时需要带上预览页 Referer，这里退让一次：交给 background 走原生下载
      if (referer) {
        try {
          buffer = await fetchViaBackground(url, referer);
        } catch {
          /* 下面统一记录失败 */
        }
      }
    }
    if (!buffer) {
      failures.push({ index: index + 1, url });
      return null;
    }

    let converted;
    try {
      converted = await toJpeg(buffer, opts.quality, opts.maxWidth);
    } catch (err) {
      failures.push({ index: index + 1, url, reason: err && err.message });
      return null;
    }

    done++;
    if (done % 3 === 0 || done === total) reportProgress(jobId, done, total, 'download');
    return converted;
  });

  const pages = results.filter((r) => r && r.ok && r.value).map((r) => r.value);
  if (pages.length === 0) {
    throw new Error(`全部 ${total} 页下载失败（可能是登录态失效或需要 Referer）`);
  }

  reportProgress(jobId, pages.length, pages.length, 'compose');

  const writer = new PdfWriter({ title });
  for (const page of pages) {
    writer.addPage(page.jpeg, page.width, page.height);
  }
  const pdfBytes = writer.build();

  const filename = `${title}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });

  const saved = await saveBlob(blob, filename);
  if (saved.ok) {
    reportProgress(jobId, pages.length, pages.length, 'done');
    return {
      ok: true,
      pageCount: pages.length,
      requested: total,
      failures,
      bytes: blob.size,
      filename,
    };
  }

  // 兜底：把 PDF 交给 background 用 downloads API 保存
  const base64 = await blobToBase64(blob);
  return {
    ok: true,
    pageCount: pages.length,
    requested: total,
    failures,
    bytes: blob.size,
    filename,
    fallbackBase64: base64,
  };
}

/** 转由 background 代为请求（background 可用 declarativeNetRequest 补 Referer） */
function fetchViaBackground(url, referer) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'cx:fetch-image', url, referer }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || 'background 取图失败'));
      // base64 → ArrayBuffer
      const bin = atob(resp.base64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      resolve(buf.buffer);
    });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg && msg.type === 'cx:build-pdf') {
    buildPdf(msg.payload)
      .then((result) => respond(result))
      .catch((err) => respond({ ok: false, error: (err && err.message) || String(err) }));
    return true; // 保持消息通道，异步响应
  }
  return false;
});

// 告诉 background 我已经活了
chrome.runtime.sendMessage({ type: 'cx:offscreen-ready' }).catch(() => {});
