/**
 * content.js — 注入到学习通页面（含所有 iframe）的主控脚本
 *
 * 每个 frame 都会跑一份：谁先探测到课件，谁就负责显示面板，
 * 由 background 统一去重，避免多层 iframe 里冒出一堆重复按钮。
 */

(function () {
  'use strict';

  if (window.__cxContentLoaded) return; // 防止重复注入
  window.__cxContentLoaded = true;

  // 脚本在 document_start 就注入，趁页面自己的脚本还没跑，先把图片监听装上，
  // 这样后面加载的每一张课件图片都会被记下来。
  try {
    window.CXDetector.installImageSpy();
  } catch (err) {
    console.debug('[CX] 图片监听安装失败', err);
  }

  let panel = null;
  let currentDeck = null;
  let settings = null;
  let activeJobId = null;
  let pollTimer = null;

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------

  async function boot() {
    settings = await fetchSettings();

    // 课件是异步加载的，分几个时间点反复探测
    [0, 1000, 2500, 5000, 9000].forEach((delay) => setTimeout(tryDetect, delay));

    // 章节切换后 iframe 内容会换，持续巡检
    pollTimer = setInterval(tryDetect, 6000);
  }

  function fetchSettings() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'cx:get-settings' }, (resp) => {
        resolve((resp && resp.settings) || { autoScroll: true, quality: 0.92 });
      });
    });
  }

  async function tryDetect() {
    if (panel && panel.busy) return; // 正在导出时不要打扰

    let deck = null;
    try {
      deck = window.CXDetector.detect();
    } catch (err) {
      console.debug('[CX] 探测异常', err);
      return;
    }
    if (!deck) return;

    // 至少要有可落地的产出：原文件直链、PDF 直链或图片序列
    if (!deck.downloadUrl && !deck.pdfUrl && (!deck.images || deck.images.length < 2)) return;

    if (panel) {
      // 页数变多了（懒加载推进）就刷新一下显示
      if (deck.pageCount > currentDeck.pageCount || deck.images.length > currentDeck.images.length) {
        currentDeck = deck;
        panel.update(deck);
      }
      return;
    }

    let first = { first: true };
    try {
      first = await chrome.runtime.sendMessage({ type: 'cx:register-deck', deckId: deck.id });
    } catch {
      /* service worker 没起来，退化成本地显示 */
    }
    if (!first || !first.first) return; // 别的 frame 已经显示了

    currentDeck = deck;
    panel = new window.CXPanel(deck, {
      onExport: exportAsPdf,
      onOriginal: downloadOriginal,
      onCopy: copyLinks,
      onClose: () => {
        panel = null;
      },
    });
  }

  // ------------------------------------------------------------------
  // 动作：下载原始文件
  // ------------------------------------------------------------------

  function downloadOriginal(explicitUrl) {
    const url = explicitUrl || (currentDeck && (currentDeck.downloadUrl || currentDeck.pdfUrl));
    if (!url) {
      panel.toast('没有可用的直链', 'err');
      return;
    }
    // 让浏览器自己发请求，这样会带上当前站点的 Cookie 和 Referer，
    // 比在扩展里伪造请求头可靠得多。
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    try {
      a.download = '';
    } catch {
      /* ignore */
    }
    document.body.appendChild(a);
    a.click();
    a.remove();
    panel.toast('已发起下载，若浏览器只是打开预览请右键另存', 'ok');
  }

  // ------------------------------------------------------------------
  // 动作：导出图片 PDF
  // ------------------------------------------------------------------

  async function exportAsPdf() {
    panel.setBusy(true);
    panel.showProgress(true);

    try {
      let deck = window.CXDetector.detect() || currentDeck;

      if (settings.autoScroll && deck && deck.images && deck.images.length) {
        panel.setProgress(0, deck.pageCount || 0, '正在滚动加载全部页面…');
        await window.CXDetector.autoScroll({
          maxRounds: 80,
          delay: 200,
          onProgress: (n) => {
            const total = Math.max(n, deck.pageCount || 0);
            panel.setProgress(n, total, `正在加载页面…（已发现 ${n} 页）`);
          },
        });
        deck = window.CXDetector.detect() || deck;
        currentDeck = deck;
        panel.update(deck);
      }

      if (!deck.images || deck.images.length === 0) {
        panel.setBusy(false);
        panel.toast('没有检测到课件图片，试试先手动翻一遍课件', 'err');
        return;
      }

      activeJobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      panel.setProgress(0, deck.images.length, '准备下载…');

      const resp = await chrome.runtime.sendMessage({
        type: 'cx:export-pdf',
        payload: {
          jobId: activeJobId,
          images: deck.images,
          title: deck.title,
          referer: location.href,
          settings: {},
        },
      });

      panel.setBusy(false);

      if (!resp || !resp.ok) {
        panel.toast(`导出失败：${(resp && resp.error) || '未知错误'}`, 'err');
        return;
      }

      const failed = (resp.failures || []).length;
      const msg = failed
        ? `完成 ${resp.pageCount}/${resp.requested} 页，${failed} 页失败`
        : `《${resp.filename}》已保存（${(resp.bytes / 1048576).toFixed(1)} MB）`;
      panel.setProgress(resp.pageCount, resp.requested, msg, failed ? 'err' : 'ok');
    } catch (err) {
      panel.setBusy(false);
      panel.toast(`导出异常：${err && err.message}`, 'err');
    }
  }

  // ------------------------------------------------------------------
  // 动作：复制链接
  // ------------------------------------------------------------------

  function copyLinks() {
    const d = currentDeck;
    if (!d) return;
    const lines = [];
    if (d.downloadUrl) lines.push(`原始文件：${d.downloadUrl}`);
    if (d.pdfUrl) lines.push(`PDF：${d.pdfUrl}`);
    if (d.readUrl) lines.push(`备用下载：${d.readUrl}`);
    if (d.images && d.images.length) {
      lines.push(`图片前缀：${d.images[0].replace(/\d+\.(png|jpe?g|webp)$/i, '')}`);
    }
    const text = lines.join('\n');

    const done = () => panel.toast('链接已复制到剪贴板', 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
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
      panel.toast('复制失败，请手动查看控制台', 'err');
      console.log('[CX] 课件直链：\n' + text);
    }
    ta.remove();
  }

  // ------------------------------------------------------------------
  // 进度回传
  // ------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'cx:progress' || !panel) return false;
    if (activeJobId && msg.jobId && msg.jobId !== activeJobId) return false;

    const phaseText = {
      download: '正在下载图片…',
      compose: '正在合成 PDF…',
      done: '完成',
    };
    const label = phaseText[msg.phase] || '处理中…';
    panel.setProgress(msg.done || 0, msg.total || 0, label, msg.phase === 'done' ? 'ok' : null);
    return false;
  });

  // ------------------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
