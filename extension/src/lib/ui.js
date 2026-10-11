/**
 * ui.js — 常驻悬浮窗（顶部）+ 可最小化成小球 + 提取进度条
 *
 * 设计要点（改之前先看这段）：
 *   1. 面板**只要有匹配页面就创建**，不等探测成功。之前的版本是"探测到课件
 *      才建面板"，探测条件一不满足页面上就什么都没有，用户完全看不到插件。
 *   2. 探测失败时也要有存在感：显示诊断信息 + 「重新检测」按钮，让人知道
 *      插件在工作、卡在哪一步。
 *   3. 整体挂在 Shadow DOM 里：学习通自己的 CSS 又多又脏，不隔离会被改得面目全非。
 *   4. 位置由 JS 管（left/top），浮窗和小球各记一份位置，都可拖动。
 *      默认浮窗贴窗口顶部居中（学习通章节页顶部本来就空着），小球贴右上角。
 *      浮窗态别改回"跟着课件走"——课件 iframe 会被撑到几千像素高。
 */

(function (global) {
  'use strict';

  const CARD_W = 460;
  const BALL = 46;

  // ⚠️ 定位与层级必须写在 :host 上（或内联 style）。
  // Shadow DOM 的样式表只作用于 shadow tree 内部，选不到 host 元素本身——
  // 之前写成 `.cx-root { position: fixed; ... }`，那条规则一次都没生效过，
  // host 被 `all: initial` 重置成静态内联元素，跟着 body 一起沉到页面底部。
  const CSS = `
    :host {
      all: initial;
      position: fixed !important;
      display: block !important;
      z-index: 2147483647 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      background: transparent !important;
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: auto !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                   "Microsoft YaHei", "Helvetica Neue", sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #1f2937;
    }

    /* ---------- 小球形态 ---------- */
    .cx-ball {
      display: none;
      width: 46px;
      height: 46px;
      border-radius: 50%;
      background: #2563eb;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      user-select: none;
      box-shadow: 0 4px 14px rgba(37, 99, 235, .42);
      letter-spacing: .3px;
    }
    .cx-ball.ok { background: #059669; box-shadow: 0 4px 14px rgba(5, 150, 105, .42); }
    .cx-ball.err { background: #dc2626; box-shadow: 0 4px 14px rgba(220, 38, 38, .42); }
    .cx-ball.pulse { animation: cx-pulse 1.5s ease-in-out 4; }
    @keyframes cx-pulse {
      0%, 100% { transform: scale(1); }
      50%      { transform: scale(1.12); }
    }
    :host(.cx-mini) .cx-ball { display: flex; }

    /* ---------- 浮窗形态 ---------- */
    .cx-card {
      width: ${CARD_W}px;
      max-width: calc(100vw - 24px);
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      box-shadow: 0 10px 28px rgba(15, 23, 42, .16), 0 2px 6px rgba(15, 23, 42, .08);
      overflow: hidden;
    }
    :host(.cx-mini) .cx-card { display: none; }

    .cx-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      background: #2563eb;
      color: #fff;
      cursor: move;
      user-select: none;
    }
    .cx-head-title { flex: 1; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cx-badge { background: rgba(255,255,255,.22); border-radius: 999px; padding: 1px 8px; font-size: 11px; flex-shrink: 0; }
    .cx-btn-icon {
      background: transparent; border: 0; color: #fff; cursor: pointer;
      font-size: 15px; line-height: 1; padding: 2px 6px; border-radius: 5px;
      opacity: .85; flex-shrink: 0; font-family: inherit;
    }
    .cx-btn-icon:hover { background: rgba(255,255,255,.2); opacity: 1; }

    /* ---------- 进度区：默认收起，开始提取后才展开 ---------- */
    .cx-progress { display: none; padding: 10px 12px 0; background: #fff; }
    .cx-progress.show { display: block; }
    .cx-bar { height: 8px; background: #d8dde4; border-radius: 999px; overflow: hidden; }
    .cx-bar-fill {
      height: 100%; width: 0%; background: #2563eb;
      border-radius: 999px; transition: width .25s ease;
    }
    .cx-bar.indeterminate { position: relative; }
    .cx-bar.indeterminate .cx-bar-fill {
      width: 35%; transition: none;
      animation: cx-slide 1.1s ease-in-out infinite;
    }
    @keyframes cx-slide {
      0%   { transform: translateX(-110%); }
      100% { transform: translateX(320%); }
    }
    .cx-status {
      font-size: 12px; color: #374151; display: flex;
      justify-content: space-between; gap: 8px; padding: 7px 0 2px;
    }
    .cx-status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cx-status-num { flex-shrink: 0; font-variant-numeric: tabular-nums; color: #4b5563; }
    .cx-status.err .cx-status-text, .cx-status.err .cx-status-num { color: #dc2626; font-weight: 600; }
    .cx-status.ok .cx-status-text, .cx-status.ok .cx-status-num { color: #059669; font-weight: 600; }
    .cx-bar.failed .cx-bar-fill { background: #dc2626; }
    .cx-bar.finished .cx-bar-fill { background: #059669; }

    /* ---------- 主体 ---------- */
    .cx-body { padding: 10px 12px 11px; background: #fff; }
    .cx-meta { font-size: 11.5px; color: #6b7280; margin-bottom: 9px; word-break: break-all; }
    .cx-meta b { color: #374151; font-weight: 600; }
    .cx-lead { display: block; font-size: 12.5px; color: #374151; margin-bottom: 5px; font-weight: 600; }
    .cx-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .cx-btn {
      flex: 1 1 auto; min-width: 96px; border: 0; border-radius: 8px;
      padding: 8px 10px; font-size: 12.5px; font-weight: 600; cursor: pointer;
      transition: filter .15s ease, transform .08s ease; font-family: inherit;
    }
    .cx-btn:active { transform: translateY(1px); }
    .cx-btn:disabled { opacity: .55; cursor: not-allowed; }
    .cx-btn-primary { background: #2563eb; color: #fff; }
    .cx-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
    .cx-btn-ghost { background: #f3f4f6; color: #374151; border: 1px solid #e5e7eb; }
    .cx-btn-ghost:hover:not(:disabled) { background: #e5e7eb; }
    .cx-diag {
      display: none; margin-top: 8px; font-size: 11px; color: #6b7280;
      background: #f9fafb; border: 1px solid #eef0f3; border-radius: 6px;
      padding: 6px 8px; word-break: break-all; line-height: 1.5;
    }
    .cx-diag.show { display: block; }
    .cx-hint {
      margin-top: 9px; font-size: 11px; color: #9ca3af;
      border-top: 1px dashed #e5e7eb; padding-top: 8px;
    }
  `;

  class ExportPanel {
    constructor(deck, handlers) {
      this.deck = deck || null;
      this.handlers = handlers || {};
      this.busy = false;
      this.minimized = false;
      this.diagText = '';
      this.cardPos = null; // {x,y}，null 表示用默认位置
      this.ballPos = null;
      this.build();
    }

    build() {
      const host = document.createElement('div');
      host.className = 'cx-root';
      // 内联一份定位与层级：即便 :host 规则被页面的 !important 样式压过，
      // 内联的 important 也能兜住。left/top 留给 applyPosition 设置。
      host.style.setProperty('position', 'fixed', 'important');
      host.style.setProperty('display', 'block', 'important');
      host.style.setProperty('z-index', '2147483647', 'important');
      host.style.setProperty('margin', '0', 'important');
      host.style.setProperty('padding', '0', 'important');
      host.style.setProperty('visibility', 'visible', 'important');
      host.style.setProperty('left', '12px');
      host.style.setProperty('top', '12px');
      const shadow = host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);

      const ball = document.createElement('div');
      ball.className = 'cx-ball pulse';
      ball.title = '学习通课件导出 · 点击展开，可拖动';
      ball.textContent = '导出';
      shadow.appendChild(ball);

      const card = document.createElement('div');
      card.className = 'cx-card';
      card.innerHTML = `
        <div class="cx-head">
          <span class="cx-head-title">学习通课件导出</span>
          <span class="cx-badge"></span>
          <button class="cx-btn-icon" data-act="min" title="最小化成小球">–</button>
        </div>
        <div class="cx-progress">
          <div class="cx-bar"><div class="cx-bar-fill"></div></div>
          <div class="cx-status"><span class="cx-status-text"></span><span class="cx-status-num"></span></div>
        </div>
        <div class="cx-body">
          <div class="cx-meta"></div>
          <div class="cx-actions"></div>
          <div class="cx-diag"></div>
          <div class="cx-hint"></div>
        </div>
      `;
      shadow.appendChild(card);

      this.host = host;
      this.shadow = shadow;
      this.ball = ball;
      this.card = card;
      this.el = {
        badge: shadow.querySelector('.cx-badge'),
        meta: shadow.querySelector('.cx-meta'),
        actions: shadow.querySelector('.cx-actions'),
        progress: shadow.querySelector('.cx-progress'),
        bar: shadow.querySelector('.cx-bar'),
        fill: shadow.querySelector('.cx-bar-fill'),
        status: shadow.querySelector('.cx-status'),
        statusText: shadow.querySelector('.cx-status-text'),
        statusNum: shadow.querySelector('.cx-status-num'),
        diag: shadow.querySelector('.cx-diag'),
        hint: shadow.querySelector('.cx-hint'),
        head: shadow.querySelector('.cx-head'),
      };

      this.renderMeta();
      this.renderActions();
      this.el.head.querySelector('[data-act="min"]').addEventListener('click', () => this.minimize());
      this.bindDrag(this.ball, () => this.expand());
      this.bindDrag(this.el.head);

      this.mount();
      this.startGuard();
      this.applyPosition();

      this.onResize = () => this.applyPosition();
      window.addEventListener('resize', this.onResize);

      // 呼吸 4 下提醒存在，之后安静下来
      setTimeout(() => this.ball.classList.remove('pulse'), 6500);
    }

    // ----------------------------------------------------------------
    // 挂载保障：页面脚本清 DOM、整页重渲染都可能把面板摘掉
    // ----------------------------------------------------------------

    /** 挂到 <html> 的最后一个子节点：DOM 顺序最后，同层级下也压在最上面 */
    mount() {
      const root = document.documentElement || document.body;
      if (!root) return false;
      if (this.host.parentNode !== root || this.host.nextElementSibling) {
        root.appendChild(this.host);
      }
      return true;
    }

    /** 看门狗：定时 + DOM 变动时确认面板还在、还在视口内 */
    startGuard() {
      if (this.guardTimer) return;
      const tick = () => {
        if (this.destroyed) return;
        this.mount();
        this.ensureInViewport();
      };
      this.guardTimer = setInterval(tick, 2000);
      if (typeof MutationObserver !== 'undefined') {
        try {
          this.observer = new MutationObserver(tick);
          this.observer.observe(document.documentElement, { childList: true });
        } catch {
          /* 观察不了就算了，定时兜底还在 */
        }
      }
    }

    /**
     * 面板被撑高的 body / iframe 顶出视口时拉回来。
     * 这种情况在课件页很常见：宿主文档高度动辄几千像素，
     * 而 fixed 定位一旦失效（祖先有 transform/filter）就会跟着文档流跑。
     */
    ensureInViewport() {
      const r = this.host.getBoundingClientRect();
      const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
      const vh = window.innerHeight || document.documentElement.clientHeight || 768;
      if (!r.width && !r.height) return; // 还没布局，别乱动
      const outside = r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw;
      if (!outside) return;
      this.cardPos = null;
      this.ballPos = null;
      this.applyPosition();
    }

    // ----------------------------------------------------------------
    // 位置：浮窗和小球各记一份，可拖动；浮窗默认顶部居中、小球默认右上角
    // ----------------------------------------------------------------

    defaultPos(mini) {
      if (mini) return { x: Math.max(8, window.innerWidth - BALL - 16), y: 10 };
      return { x: Math.max(8, Math.round((window.innerWidth - CARD_W) / 2)), y: 12 };
    }

    applyPosition() {
      const mini = this.minimized;
      const w = mini ? BALL : Math.min(CARD_W, window.innerWidth - 24);
      const h = mini ? BALL : (this.card.offsetHeight || 210);
      let p = mini ? this.ballPos : this.cardPos;
      if (!p) p = this.defaultPos(mini);

      const x = clamp(p.x, 8, Math.max(8, window.innerWidth - w - 8));
      const y = clamp(p.y, 8, Math.max(8, window.innerHeight - h - 8));
      this.host.style.left = `${x}px`;
      this.host.style.top = `${y}px`;
      if (mini) this.ballPos = { x, y };
      else this.cardPos = { x, y };
    }

    bindDrag(el, onTap) {
      let dragging = false;
      let moved = false;
      let startX = 0;
      let startY = 0;
      let baseX = 0;
      let baseY = 0;

      el.addEventListener('mousedown', (e) => {
        if (e.target.dataset && e.target.dataset.act) return;
        const p = (this.minimized ? this.ballPos : this.cardPos) || this.defaultPos(this.minimized);
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        baseX = p.x;
        baseY = p.y;
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const mx = e.clientX - startX;
        const my = e.clientY - startY;
        if (Math.abs(mx) > 3 || Math.abs(my) > 3) moved = true;
        const next = { x: baseX + mx, y: baseY + my };
        if (this.minimized) this.ballPos = next;
        else this.cardPos = next;
        this.applyPosition();
      });

      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        if (!moved && onTap) onTap();
      });
    }

    minimize() {
      this.minimized = true;
      this.host.classList.add('cx-mini');
      if (!this.ballPos) {
        // 从浮窗的右上角收成球，视觉上像"缩进去"
        const p = this.cardPos || this.defaultPos(false);
        this.ballPos = { x: p.x + CARD_W - BALL, y: p.y };
      }
      this.applyPosition();
    }

    expand() {
      this.minimized = false;
      this.host.classList.remove('cx-mini');
      if (!this.cardPos) this.cardPos = this.defaultPos(false);
      this.applyPosition();
      // 展开后高度才算得准，下一帧再校一次
      requestAnimationFrame(() => this.applyPosition());
    }

    // ----------------------------------------------------------------
    // 内容
    // ----------------------------------------------------------------

    renderMeta() {
      const d = this.deck;
      if (!d) {
        this.el.badge.textContent = '等待课件';
        this.el.meta.innerHTML =
          '<span class="cx-lead">插件已就绪，正在等课件加载</span>' +
          '打开章节里的 PPT 课件，或往下翻几页触发加载，然后点重新检测。';
        this.el.hint.textContent = '面板会一直悬浮在这里，不会因为课件很长而消失。';
        return;
      }
      this.el.badge.textContent = d.pageCount ? `${d.pageCount} 页` : '未知页数';
      const strategyText = {
        original: '原始文件直链（无损）',
        pdf: 'PDF 直链',
        images: '逐页图片合成',
      }[d.strategy] || '未知';
      const bits = [
        `《<b>${escapeHtml(d.title)}</b>》`,
        `方式：<b>${strategyText}</b>`,
        d.suffix ? `格式：<b>${escapeHtml(String(d.suffix).toUpperCase())}</b>` : null,
        `来源：${escapeHtml(String(d.source || ''))}`,
      ].filter(Boolean);
      this.el.meta.innerHTML = bits.join('<br>');
      this.el.hint.textContent = '最小化成小球后，球面上仍会显示进度百分比。';
    }

    renderActions() {
      const wrap = this.el.actions;
      wrap.innerHTML = '';

      const mk = (label, cls, fn, title) => {
        const b = document.createElement('button');
        b.className = `cx-btn ${cls}`;
        b.textContent = label;
        if (title) b.title = title;
        if (this.busy) b.disabled = true;
        b.addEventListener('click', () => {
          if (this.busy) return;
          fn();
        });
        wrap.appendChild(b);
        return b;
      };

      if (!this.deck) {
        mk('重新检测', 'cx-btn-primary', () => this.handlers.onRedetect?.(), '再扫一遍页面上的课件');
        return;
      }

      const d = this.deck;
      if (d.downloadUrl) {
        mk('下载原文件', 'cx-btn-primary', () => this.handlers.onOriginal?.(), '直接下载服务器上的原始 PPT/PDF');
      } else if (d.pdfUrl) {
        mk('下载 PDF', 'cx-btn-primary', () => this.handlers.onOriginal?.(d.pdfUrl), '下载服务器转译好的 PDF');
      }
      mk('提取并导出 PDF', d.downloadUrl || d.pdfUrl ? 'cx-btn-ghost' : 'cx-btn-primary', () =>
        this.handlers.onExport?.()
      );
      mk('复制直链', 'cx-btn-ghost', () => this.handlers.onCopy?.());
    }

    setBusy(busy) {
      this.busy = busy;
      this.shadow.querySelectorAll('.cx-btn').forEach((b) => {
        b.disabled = busy;
      });
      if (busy) {
        this.el.bar.classList.remove('finished', 'failed');
        this.ball.classList.remove('ok', 'err');
      }
    }

    setDiagnostic(text) {
      if (text === this.diagText) return;
      this.diagText = text || '';
      this.el.diag.textContent = this.diagText;
      this.el.diag.classList.toggle('show', !!this.diagText);
      this.applyPosition();
    }

    /** 展开/收起进度区：开始提取时调用一次，之后一直露着 */
    showProgress(show) {
      this.el.progress.classList.toggle('show', !!show);
      this.applyPosition();
    }

    setProgress(done, total, text, kind) {
      const known = total > 0;
      const pct = known ? Math.min(100, Math.round((done / total) * 100)) : 0;

      // 总数还在涨（懒加载阶段）就先跑不确定动画，别让条子来回跳
      this.el.bar.classList.toggle('indeterminate', !known);
      this.el.fill.style.width = known ? `${pct}%` : '';
      this.el.bar.classList.remove('finished', 'failed');

      if (text != null) this.el.statusText.textContent = text;
      this.el.statusNum.textContent = known ? `${done}/${total} · ${pct}%` : '';
      this.el.progress.classList.add('show');

      this.el.status.classList.remove('err', 'ok');
      this.ball.classList.remove('ok', 'err');
      if (kind === 'err') {
        this.el.status.classList.add('err');
        this.el.bar.classList.add('failed');
        this.ball.classList.add('err');
        this.setBallText('失败');
      } else if (kind === 'ok') {
        this.el.status.classList.add('ok');
        if (known) this.el.bar.classList.add('finished');
        this.ball.classList.add('ok');
        this.setBallText(known ? `${pct}%` : '完成');
      } else {
        this.setBallText(known ? `${pct}%` : '···');
      }
      this.applyPosition();
    }

    toast(message, kind) {
      this.el.statusText.textContent = message || '';
      this.el.statusNum.textContent = '';
      this.el.progress.classList.add('show');
      this.el.bar.classList.remove('indeterminate', 'finished', 'failed');
      this.el.fill.style.width = '100%';
      this.el.status.classList.remove('err', 'ok');
      this.ball.classList.remove('ok', 'err');
      if (kind === 'err') {
        this.el.status.classList.add('err');
        this.el.bar.classList.add('failed');
        this.ball.classList.add('err');
        this.setBallText('失败');
      } else if (kind) {
        this.el.status.classList.add('ok');
        this.el.bar.classList.add('finished');
        this.ball.classList.add('ok');
        this.setBallText('完成');
      } else {
        this.setBallText('导出');
      }
      this.applyPosition();
    }

    setBallText(t) {
      this.ball.textContent = t;
    }

    /** deck 传 null 表示"还没检测到"，面板保留并给出诊断信息 */
    update(deck) {
      this.deck = deck || null;
      this.renderMeta();
      this.renderActions();
      this.applyPosition();
    }

    destroy() {
      this.destroyed = true;
      if (this.guardTimer) clearInterval(this.guardTimer);
      if (this.observer) this.observer.disconnect();
      if (this.onResize) window.removeEventListener('resize', this.onResize);
      this.host.remove();
      this.handlers.onClose?.();
    }
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  global.CXPanel = ExportPanel;
})(window);
