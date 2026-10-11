/**
 * content.js — 注入到学习通页面（含所有 iframe）的主控脚本
 *
 * 每个 frame 都会跑一份：谁先探测到课件，谁就负责执行导出动作，
 * 由 background 统一去重，避免多层 iframe 里冒出一堆重复按钮。
 *
 * ⚠️ 两条不能改回去的设计：
 *
 * 1. **面板常驻**。只要页面匹配就建面板，不等探测成功。之前的版本是"探测到
 *    课件才建面板"，探测条件一不满足（图片不足 2 张、懒加载还没触发、课件在
 *    没注入脚本的域里）页面上就什么都没有，用户根本不知道插件装了没装。
 *    现在探测失败也会显示诊断信息和「重新检测」按钮。
 *
 * 2. **面板挂在顶层窗口**。课件所在的 iframe 常被撑得跟整份 PPT 一样高，
 *    position:fixed 的 bottom 锚的是"iframe 的底部"而不是"浏览器窗口的底部"，
 *    按钮会跑到几千像素以下。所以探测归探测，面板一律挂顶层（frameId 0），
 *    两者靠 background 中转。
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

  const isTopFrame = (() => {
    try {
      return window === window.top;
    } catch {
      return true; // 拿不到就当顶层，至少还能显示
    }
  })();

  let panel = null; // 面板实例，只有挂面板的那个 frame 有
  let currentDeck = null;
  let settings = null;
  let activeJobId = null;
  let pollTimer = null;

  let isOwner = false; // 本 frame 探测到课件，下载/导出/复制都由本 frame 执行
  let remotePanel = false; // 面板挂在顶层窗口，本 frame 的运行结果要回传过去显示

  // 探测诊断：各 frame 的探测摘要，顶层汇总后显示给用户看
  const probeFrames = new Map(); // frameId -> { images, hasFileinfo, ready }
  let lastReport = '';

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------

  async function boot() {
    settings = await fetchSettings();

    // 顶层先把面板立起来：常驻，不依赖探测结果
    if (isTopFrame) {
      installPanel(null);
      askProbeStatus();
    }

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
    }

    reportProbe(deck);

    if (!deck) return;

    // 至少要有可落地的产出：原文件直链、PDF 直链或图片序列
    if (!deck.downloadUrl && !deck.pdfUrl && (!deck.images || deck.images.length < 2)) return;

    // 已经接管了，只在懒加载推进、页数变多时刷新显示
    if (currentDeck) {
      if (deck.pageCount > currentDeck.pageCount || deck.images.length > currentDeck.images.length) {
        currentDeck = deck;
        publishDeck(deck);
      }
      return;
    }

    let first = { first: true };
    try {
      first = await chrome.runtime.sendMessage({ type: 'cx:register-deck', deckId: deck.id });
    } catch {
      /* service worker 没起来，退化成本地显示 */
    }
    if (!first || !first.first) return; // 别的 frame 已经接管了这个课件

    currentDeck = deck;
    isOwner = true;
    await placePanel(deck);
  }

  /** 把本 frame 的探测情况报出去，顶层汇总成一行诊断文字 */
  function reportProbe(deck) {
    let images = 0;
    try {
      images = window.CXDetector.collectImageUrls().length;
    } catch {
      /* 拿不到就算了，诊断信息而已 */
    }
    const data = { images, hasFileinfo: !!window.fileinfo, ready: !!deck };
    const key = JSON.stringify(data);
    if (key === lastReport) return; // 没变化就不发，避免每 6 秒刷一条消息
    lastReport = key;

    if (isTopFrame) {
      probeFrames.set(0, data);
      renderDiagnostic();
      return;
    }
    chrome.runtime.sendMessage({ type: 'cx:probe-report', data }).catch(() => {});
  }

  function askProbeStatus() {
    chrome.runtime.sendMessage({ type: 'cx:probe-status' }, (resp) => {
      if (!resp || !resp.frames) return;
      resp.frames.forEach((f) => probeFrames.set(f.frameId, f));
      renderDiagnostic();
    });
  }

  function renderDiagnostic() {
    if (!panel) return;
    if (currentDeck) {
      panel.setDiagnostic('');
      return;
    }
    let images = 0;
    let withFileinfo = 0;
    let ready = 0;
    for (const r of probeFrames.values()) {
      images = Math.max(images, r.images || 0);
      if (r.hasFileinfo) withFileinfo++;
      if (r.ready) ready++;
    }
    const bits = [
      `已监听 ${probeFrames.size} 个框架`,
      `捕获图片 ${images} 张`,
      withFileinfo ? `${withFileinfo} 个框架有 fileinfo` : '未见到 fileinfo',
    ];
    if (ready) bits.push(`${ready} 个已识别`);
    panel.setDiagnostic(`[诊断] ${bits.join(' · ')}`);
  }

  /**
   * 决定面板挂在哪：能挂顶层就挂顶层，挂不上（顶层没有 content script）才就地显示。
   */
  async function placePanel(deck) {
    renderDiagnostic();
    if (isTopFrame) {
      installPanel(deck);
      return;
    }
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'cx:panel-show', deck });
      if (resp && resp.ok) {
        remotePanel = true;
        return;
      }
    } catch (err) {
      console.debug('[CX] 面板上移失败，改为就地显示', err);
    }
    installPanel(deck);
  }

  function installPanel(deck) {
    if (panel) {
      panel.update(deck);
      return panel;
    }
    panel = new window.CXPanel(deck, {
      onExport: () => runAction('export'),
      onOriginal: (url) => runAction('original', { url }),
      onCopy: () => runAction('copy'),
      onRedetect: () => runAction('redetect'),
      onClose: () => {
        panel = null;
      },
    });
    renderDiagnostic();
    return panel;
  }

  function publishDeck(deck) {
    renderDiagnostic();
    if (panel) {
      panel.update(deck);
    } else if (remotePanel) {
      chrome.runtime.sendMessage({ type: 'cx:panel-update', deck }).catch(() => {});
    }
  }

  // ------------------------------------------------------------------
  // 动作的分发：面板可能在别的 frame，动作必须回到课件所在的 frame 执行
  // ------------------------------------------------------------------

  function runAction(action, payload) {
    // 重新检测要广播给所有 frame（课件可能在任何一层），所以一律走 background
    if (isOwner && action !== 'redetect') {
      executeAction(action, payload || {});
      return;
    }
    chrome.runtime.sendMessage({ type: 'cx:panel-action', action, payload: payload || {} }, (resp) => {
      if (!resp || !resp.ok) {
        feedback({
          kind: 'toast',
          text: (resp && resp.error) || '操作没能下发到课件所在页面，刷新页面重试',
          tone: 'err',
        });
      }
    });
  }

  function executeAction(action, payload) {
    if (action === 'original') downloadOriginal(payload.url);
    else if (action === 'export') exportAsPdf();
    else if (action === 'copy') copyLinks();
    else if (action === 'redetect') tryDetect();
  }

  /**
   * 把运行状态送到面板：面板在本 frame 就直接改，在顶层就经 background 中转。
   */
  function feedback(f) {
    if (panel) {
      applyFeedback(f);
      return;
    }
    if (remotePanel || isOwner) {
      chrome.runtime.sendMessage({ type: 'cx:panel-result', data: f }).catch(() => {});
    }
  }

  function applyFeedback(f) {
    if (!panel || !f) return;
    switch (f.kind) {
      case 'progress':
        panel.showProgress(true);
        panel.setProgress(f.done || 0, f.total || 0, f.text || '', f.tone || null);
        break;
      case 'toast':
        panel.toast(f.text || '', f.tone || null);
        break;
      case 'busy':
        panel.setBusy(!!f.busy);
        break;
      case 'update':
        panel.update(f.deck);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------
  // 动作：下载原始文件
  // ------------------------------------------------------------------

  function downloadOriginal(explicitUrl) {
    const url = explicitUrl || (currentDeck && (currentDeck.downloadUrl || currentDeck.pdfUrl));
    if (!url) {
      feedback({ kind: 'toast', text: '没有可用的直链', tone: 'err' });
      return;
    }
    // 让浏览器自己发请求，这样会带上当前站点的 Cookie 和 Referer，
    // 比在扩展里伪造请求头可靠得多。这也是必须在课件所在 frame 执行的原因。
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
    feedback({ kind: 'toast', text: '已发起下载，若浏览器只是打开预览请右键另存', tone: 'ok' });
  }

  // ------------------------------------------------------------------
  // 动作：导出图片 PDF
  // ------------------------------------------------------------------

  async function exportAsPdf() {
    feedback({ kind: 'busy', busy: true });

    try {
      let deck = window.CXDetector.detect() || currentDeck;

      if (!deck) {
        feedback({ kind: 'busy', busy: false });
        feedback({ kind: 'toast', text: '还没检测到课件，先翻几页再点重新检测', tone: 'err' });
        return;
      }

      if (settings.autoScroll && deck.images && deck.images.length) {
        // 页数未知时 total 传 0，进度条走不确定动画；
        // 不能用"已发现页数"当总数，那样条子会一直满格或倒退
        feedback({ kind: 'progress', done: 0, total: deck.pageCount || 0, text: '正在滚动加载全部页面…' });
        await window.CXDetector.autoScroll({
          maxRounds: 80,
          delay: 200,
          onProgress: (n) => {
            feedback({
              kind: 'progress',
              done: n,
              total: deck.pageCount || 0,
              text: `正在加载页面…（已发现 ${n} 页）`,
            });
          },
        });
        deck = window.CXDetector.detect() || deck;
        currentDeck = deck;
        feedback({ kind: 'update', deck });
      }

      if (!deck.images || deck.images.length === 0) {
        feedback({ kind: 'busy', busy: false });
        feedback({ kind: 'toast', text: '没有检测到课件图片，试试先手动翻一遍课件', tone: 'err' });
        return;
      }

      activeJobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      feedback({ kind: 'progress', done: 0, total: deck.images.length, text: '准备下载…' });

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

      feedback({ kind: 'busy', busy: false });

      if (!resp || !resp.ok) {
        feedback({ kind: 'toast', text: `导出失败：${(resp && resp.error) || '未知错误'}`, tone: 'err' });
        return;
      }

      const failed = (resp.failures || []).length;
      const msg = failed
        ? `完成 ${resp.pageCount}/${resp.requested} 页，${failed} 页失败`
        : `《${resp.filename}》已保存（${(resp.bytes / 1048576).toFixed(1)} MB）`;
      feedback({
        kind: 'progress',
        done: resp.pageCount,
        total: resp.requested,
        text: msg,
        tone: failed ? 'err' : 'ok',
      });
    } catch (err) {
      feedback({ kind: 'busy', busy: false });
      feedback({ kind: 'toast', text: `导出异常：${err && err.message}`, tone: 'err' });
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

    const done = () => feedback({ kind: 'toast', text: '链接已复制到剪贴板', tone: 'ok' });
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
      feedback({ kind: 'toast', text: '复制失败，请手动查看控制台', tone: 'err' });
      console.log('[CX] 课件直链：\n' + text);
    }
    ta.remove();
  }

  // ------------------------------------------------------------------
  // 消息：面板挂载、动作下发、状态回传、诊断汇总
  // ------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return false;

    switch (msg.type) {
      // 顶层窗口收到：把面板建在这里（已有就地更新）
      case 'cx:panel-install':
        if (!isTopFrame) return false;
        currentDeck = msg.deck;
        installPanel(msg.deck);
        return false;

      case 'cx:panel-update':
        if (!isTopFrame || !panel) return false;
        currentDeck = msg.deck;
        panel.update(msg.deck);
        renderDiagnostic();
        return false;

      // 课件所在 frame 收到：面板在顶层，代为执行动作
      case 'cx:panel-action':
        if (isOwner) executeAction(msg.action, msg.payload || {});
        return false;

      // 所有 frame 收到：重新探测一遍
      case 'cx:redetect':
        tryDetect();
        return false;

      // 顶层窗口收到：某个子 frame 的探测摘要
      case 'cx:probe-report':
        if (!isTopFrame) return false;
        probeFrames.set(msg.frameId == null ? -1 : msg.frameId, msg.data || {});
        renderDiagnostic();
        return false;

      // 顶层窗口收到：课件所在 frame 的运行状态
      case 'cx:panel-result':
        if (!panel) return false;
        applyFeedback(msg.data);
        return false;

      // 课件所在 frame 收到：合成进度（面板在顶层，经 feedback 转过去）
      case 'cx:progress': {
        if (activeJobId && msg.jobId && msg.jobId !== activeJobId) return false;
        const phaseText = {
          download: '正在下载图片…',
          compose: '正在合成 PDF…',
          done: '完成',
        };
        // 合成阶段 offscreen 直接报 done=total，会瞬间跳到 100%，
        // 改成不确定动画更贴合实际（这一步确实没法精确算进度）
        const composing = msg.phase === 'compose';
        feedback({
          kind: 'progress',
          done: composing ? 0 : msg.done || 0,
          total: composing ? 0 : msg.total || 0,
          text: phaseText[msg.phase] || '处理中…',
          tone: msg.phase === 'done' ? 'ok' : null,
        });
        return false;
      }

      default:
        return false;
    }
  });

  // ------------------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
