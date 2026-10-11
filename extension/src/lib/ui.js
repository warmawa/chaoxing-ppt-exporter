/**
 * ui.js — 顶部浮窗 + 可最小化成小球的导出面板
 *
 * 整体挂在 Shadow DOM 里：学习通自己的 CSS 又多又脏，
 * 不隔离的话按钮会被页面样式改得面目全非。
 *
 * 位置：固定在浏览器窗口最顶端、水平居中。课件所在的 iframe 常被撑到几千
 * 像素高，所以面板必须挂在外层窗口（由 content.js 负责），这里只管显示。
 *
 * 形态：
 *   浮窗（默认）—— 显示课件信息和操作按钮
 *   小球（点 –）—— 缩成 46px 圆球，挡视线时用；球面上仍显示进度百分比
 *   提取中    —— 点按钮开始后浮窗内展开进度条，蓝=进行中、绿=完成、红=有失败页
 * 浮窗和小球都能拖动，拖过的位置在两种形态间共用。
 */

(function (global) {
  'use strict';

  const CSS = `
    :host { all: initial; }
    .cx-root {
      position: fixed;
      top: 10px;
      left: 0;
      right: 0;
      margin-inline: auto;
      width: 460px;
      max-width: calc(100vw - 24px);
      z-index: 2147483000;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                   "Microsoft YaHei", "Helvetica Neue", sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #1f2937;
    }
    .cx-root.cx-mini { width: 46px; }

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
      box-shadow: 0 4px 14px rgba(37, 99, 235, .38);
      letter-spacing: .3px;
    }
    .cx-ball.busy { background: #1d4ed8; }
    .cx-ball.ok { background: #059669; box-shadow: 0 4px 14px rgba(5, 150, 105, .38); }
    .cx-ball.err { background: #dc2626; box-shadow: 0 4px 14px rgba(220, 38, 38, .38); }
    .cx-root.cx-mini .cx-ball { display: flex; }

    /* ---------- 浮窗形态 ---------- */
    .cx-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      box-shadow: 0 10px 28px rgba(15, 23, 42, .16), 0 2px 6px rgba(15, 23, 42, .08);
      overflow: hidden;
    }
    .cx-root.cx-mini .cx-card { display: none; }

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
      font-size: 15px; line-height: 1; padding: 2px 5px; border-radius: 5px;
      opacity: .85; flex-shrink: 0; font-family: inherit;
    }
    .cx-btn-icon:hover { background: rgba(255,255,255,.2); opacity: 1; }

    /* ---------- 进度区：默认收起，开始提取后才展开 ---------- */
    .cx-progress { display: none; padding: 10px 12px 0; background: #fff; }
    .cx-progress.show { display: block; }
    .cx-bar {
      height: 8px;
      background: #d8dde4;
      border-radius: 999px;
      overflow: hidden;
    }
    .cx-bar-fill {
      height: 100%;
      width: 0%;
      background: #2563eb;
      border-radius: 999px;
      transition: width .25s ease;
    }
    .cx-bar.indeterminate { position: relative; }
    .cx-bar.indeterminate .cx-bar-fill {
      width: 35%;
      transition: none;
      animation: cx-slide 1.1s ease-in-out infinite;
    }
    @keyframes cx-slide {
      0%   { transform: translateX(-110%); }
      100% { transform: translateX(320%); }
    }
    .cx-status {
      font-size: 12px;
      color: #374151;
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 0 2px;
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
    .cx-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .cx-btn {
      flex: 1 1 auto;
      min-width: 96px;
      border: 0;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      transition: filter .15s ease, transform .08s ease;
      font-family: inherit;
    }
    .cx-btn:active { transform: translateY(1px); }
    .cx-btn:disabled { opacity: .55; cursor: not-allowed; }
    .cx-btn-primary { background: #2563eb; color: #fff; }
    .cx-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
    .cx-btn-ghost { background: #f3f4f6; color: #374151; border: 1px solid #e5e7eb; }
    .cx-btn-ghost:hover:not(:disabled) { background: #e5e7eb; }
    .cx-hint {
      margin-top: 9px;
      font-size: 11px;
      color: #9ca3af;
      border-top: 1px dashed #e5e7eb;
      padding-top: 8px;
    }
  `;

  class ExportPanel {
    constructor(deck, handlers) {
      this.deck = deck;
      this.handlers = handlers;
      this.busy = false;
      this.minimized = false;
      this.dx = 0;
      this.dy = 0;
      this.build();
    }

    build() {
      const host = document.createElement('div');
      host.className = 'cx-root';
      const shadow = host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);

      const ball = document.createElement('div');
      ball.className = 'cx-ball';
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
          <button class="cx-btn-icon" data-act="close" title="关闭">×</button>
        </div>
        <div class="cx-progress">
          <div class="cx-bar"><div class="cx-bar-fill"></div></div>
          <div class="cx-status"><span class="cx-status-text"></span><span class="cx-status-num"></span></div>
        </div>
        <div class="cx-body">
          <div class="cx-meta"></div>
          <div class="cx-actions"></div>
          <div class="cx-hint">最小化成小球后，球面上仍会显示进度百分比。</div>
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
      };

      this.renderMeta();
      this.renderActions();
      this.bindHead();
      this.bindBall();
      document.documentElement.appendChild(host);
    }

    renderMeta() {
      const d = this.deck;
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
        `来源：${escapeHtml(d.source)}`,
      ].filter(Boolean);
      this.el.meta.innerHTML = bits.join('<br>');
    }

    renderActions() {
      const d = this.deck;
      const wrap = this.el.actions;
      wrap.innerHTML = '';

      const mk = (label, cls, fn, title) => {
        const b = document.createElement('button');
        b.className = `cx-btn ${cls}`;
        b.textContent = label;
        if (title) b.title = title;
        if (this.busy) b.disabled = true; // 导出中途刷新了课件信息，新按钮也要保持禁用
        b.addEventListener('click', () => {
          if (this.busy) return;
          fn();
        });
        wrap.appendChild(b);
        return b;
      };

      if (d.downloadUrl) {
        mk('下载原文件', 'cx-btn-primary', () => this.handlers.onOriginal?.(), '直接下载服务器上的原始 PPT/PDF');
      } else if (d.pdfUrl) {
        mk('下载 PDF', 'cx-btn-primary', () => this.handlers.onOriginal?.(d.pdfUrl), '下载服务器转码好的 PDF');
      }
      mk('提取并导出 PDF', d.downloadUrl || d.pdfUrl ? 'cx-btn-ghost' : 'cx-btn-primary', () =>
        this.handlers.onExport?.()
      );
      mk('复制直链', 'cx-btn-ghost', () => this.handlers.onCopy?.());
    }

    bindHead() {
      const head = this.shadow.querySelector('.cx-head');
      head.querySelector('[data-act="close"]').addEventListener('click', () => this.destroy());
      head.querySelector('[data-act="min"]').addEventListener('click', () => this.minimize());
      this.bindDrag(head);
    }

    bindBall() {
      this.bindDrag(this.ball, () => this.expand());
    }

    /**
     * 拖动：用 transform 偏移，水平居中靠 margin-inline:auto，两者不冲突。
     * 位移超过 3px 算拖动、不算点击，否则小球一拖就展开。
     */
    bindDrag(el, onTap) {
      let dragging = false;
      let moved = false;
      let startX = 0;
      let startY = 0;
      let baseDx = 0;
      let baseDy = 0;

      el.addEventListener('mousedown', (e) => {
        if (e.target.dataset && e.target.dataset.act) return;
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        baseDx = this.dx;
        baseDy = this.dy;
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const mx = e.clientX - startX;
        const my = e.clientY - startY;
        if (Math.abs(mx) > 3 || Math.abs(my) > 3) moved = true;
        this.dx = clamp(baseDx + mx, -window.innerWidth / 2 + 60, window.innerWidth / 2 - 60);
        this.dy = clamp(baseDy + my, -8, window.innerHeight - 120);
        this.host.style.transform = `translate(${this.dx}px, ${this.dy}px)`;
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
    }

    expand() {
      this.minimized = false;
      this.host.classList.remove('cx-mini');
    }

    setBusy(busy) {
      this.busy = busy;
      this.shadow.querySelectorAll('.cx-btn').forEach((b) => {
        if (!b.dataset.act) b.disabled = busy;
      });
      this.ball.classList.toggle('busy', !!busy);
      if (busy) {
        this.el.bar.classList.remove('finished', 'failed');
        this.ball.classList.remove('ok', 'err');
      }
    }

    /** 展开/收起进度区：开始提取时调用一次，之后一直露着 */
    showProgress(show) {
      this.el.progress.classList.toggle('show', !!show);
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
    }

    setBallText(t) {
      this.ball.textContent = t;
    }

    update(deck) {
      this.deck = deck;
      this.renderMeta();
      this.renderActions();
    }

    destroy() {
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
