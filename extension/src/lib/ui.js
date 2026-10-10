/**
 * ui.js — 页面顶部的操作条 + 提取进度条
 *
 * 整体挂在 Shadow DOM 里：学习通自己的 CSS 又多又脏，
 * 不隔离的话按钮会被页面样式改得面目全非。
 *
 * 位置：固定在浏览器窗口最顶端、水平居中。课件所在的 iframe 常被撑到几千
 * 像素高，所以面板必须挂在外层窗口（由 content.js 负责），这里只管显示。
 * 顶部有页面自己的导航栏时，可以拖动标题栏把它挪开，也可以折叠成一条细线。
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
      width: 540px;
      max-width: calc(100vw - 24px);
      z-index: 2147483000;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                   "Microsoft YaHei", "Helvetica Neue", sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #1f2937;
    }
    .cx-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      box-shadow: 0 10px 28px rgba(15, 23, 42, .16), 0 2px 6px rgba(15, 23, 42, .08);
      overflow: hidden;
    }
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
    .cx-head-title {
      flex: 1;
      font-weight: 600;
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cx-badge {
      background: rgba(255,255,255,.22);
      border-radius: 999px;
      padding: 1px 8px;
      font-size: 11px;
      flex-shrink: 0;
    }
    .cx-btn-icon {
      background: transparent;
      border: 0;
      color: #fff;
      cursor: pointer;
      font-size: 15px;
      line-height: 1;
      padding: 2px 5px;
      border-radius: 5px;
      opacity: .85;
      flex-shrink: 0;
    }
    .cx-btn-icon:hover { background: rgba(255,255,255,.2); opacity: 1; }

    /* 进度条常驻：平时是一条灰线，导出时变蓝并显示比例 */
    .cx-progress { padding: 0 12px; background: #fff; }
    .cx-bar {
      height: 5px;
      background: #eef0f3;
      border-radius: 999px;
      overflow: hidden;
      margin-top: 9px;
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
      animation: cx-slide 1.1s ease-in-out infinite;
    }
    @keyframes cx-slide {
      0%   { transform: translateX(-110%); }
      100% { transform: translateX(320%); }
    }
    .cx-status {
      font-size: 11.5px;
      color: #4b5563;
      display: none;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 0 2px;
    }
    .cx-status.show { display: flex; }
    .cx-status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cx-status-num { flex-shrink: 0; font-variant-numeric: tabular-nums; }
    .cx-status.err .cx-status-text, .cx-status.err .cx-status-num { color: #dc2626; }
    .cx-status.ok .cx-status-text, .cx-status.ok .cx-status-num { color: #059669; }
    .cx-card.failed .cx-bar-fill { background: #dc2626; }
    .cx-card.finished .cx-bar-fill { background: #059669; }

    .cx-body { padding: 10px 12px 11px; background: #fff; }
    .cx-meta {
      font-size: 11.5px;
      color: #6b7280;
      margin-bottom: 9px;
      word-break: break-all;
    }
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
    .cx-collapsed .cx-body { display: none; }
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
      this.build();
    }

    build() {
      const host = document.createElement('div');
      host.className = 'cx-root';
      const shadow = host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);

      const card = document.createElement('div');
      card.className = 'cx-card';
      card.innerHTML = `
        <div class="cx-head">
          <span class="cx-head-title">学习通课件导出</span>
          <span class="cx-badge"></span>
          <button class="cx-btn-icon" data-act="toggle" title="折叠/展开">–</button>
          <button class="cx-btn-icon" data-act="close" title="关闭">×</button>
        </div>
        <div class="cx-progress">
          <div class="cx-bar"><div class="cx-bar-fill"></div></div>
          <div class="cx-status"><span class="cx-status-text"></span><span class="cx-status-num"></span></div>
        </div>
        <div class="cx-body">
          <div class="cx-meta"></div>
          <div class="cx-actions"></div>
          <div class="cx-hint">导出前会自动把课件滚动一遍触发懒加载，页数多时请耐心等进度条走完。</div>
        </div>
      `;
      shadow.appendChild(card);

      this.host = host;
      this.shadow = shadow;
      this.card = card;
      this.el = {
        badge: shadow.querySelector('.cx-badge'),
        meta: shadow.querySelector('.cx-meta'),
        actions: shadow.querySelector('.cx-actions'),
        bar: shadow.querySelector('.cx-bar'),
        fill: shadow.querySelector('.cx-bar-fill'),
        status: shadow.querySelector('.cx-status'),
        statusText: shadow.querySelector('.cx-status-text'),
        statusNum: shadow.querySelector('.cx-status-num'),
      };

      this.renderMeta();
      this.renderActions();
      this.bindHead();
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
      mk('导出图片 PDF', d.downloadUrl || d.pdfUrl ? 'cx-btn-ghost' : 'cx-btn-primary', () =>
        this.handlers.onExport?.()
      );
      mk('复制直链', 'cx-btn-ghost', () => this.handlers.onCopy?.());
    }

    bindHead() {
      const head = this.shadow.querySelector('.cx-head');
      head.querySelector('[data-act="close"]').addEventListener('click', () => this.destroy());
      head.querySelector('[data-act="toggle"]').addEventListener('click', (e) => {
        this.card.classList.toggle('cx-collapsed');
        e.target.textContent = this.card.classList.contains('cx-collapsed') ? '+' : '–';
      });

      // 拖动用 transform 偏移，水平居中靠 margin-inline:auto，两者不冲突
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let baseDx = 0;
      let baseDy = 0;
      let dx = 0;
      let dy = 0;

      head.addEventListener('mousedown', (e) => {
        if (e.target.dataset.act) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        baseDx = dx;
        baseDy = dy;
        head.style.cursor = 'grabbing';
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        dx = clamp(baseDx + (e.clientX - startX), -window.innerWidth / 2 + 80, window.innerWidth / 2 - 80);
        dy = clamp(baseDy + (e.clientY - startY), -8, window.innerHeight - 140);
        this.host.style.transform = `translate(${dx}px, ${dy}px)`;
      });

      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        head.style.cursor = 'move';
      });
    }

    setBusy(busy) {
      this.busy = busy;
      this.shadow.querySelectorAll('.cx-btn').forEach((b) => {
        if (!b.dataset.act) b.disabled = busy;
      });
      if (busy) this.card.classList.remove('finished', 'failed');
    }

    /** 进度条常驻，这个方法现在只控制文字行 */
    showProgress(show) {
      this.el.status.classList.toggle('show', !!show);
    }

    setProgress(done, total, text, kind) {
      const known = total > 0;
      const pct = known ? Math.min(100, Math.round((done / total) * 100)) : 0;

      // 总数还在涨（懒加载阶段）就先跑不确定动画，别让条子来回跳
      this.el.bar.classList.toggle('indeterminate', !known);
      this.el.fill.style.width = known ? `${pct}%` : '';

      if (text != null) this.el.statusText.textContent = text;
      this.el.statusNum.textContent = known ? `${done}/${total} · ${pct}%` : '';
      this.el.status.classList.add('show');

      this.el.status.classList.remove('err', 'ok');
      this.card.classList.remove('finished', 'failed');
      if (kind === 'err') {
        this.el.status.classList.add('err');
        this.card.classList.add('failed');
      } else if (kind === 'ok') {
        this.el.status.classList.add('ok');
        if (known) this.card.classList.add('finished');
      }
    }

    toast(message, kind) {
      this.el.statusText.textContent = message || '';
      this.el.statusNum.textContent = '';
      this.el.status.classList.add('show');
      this.el.status.classList.remove('err', 'ok');
      this.card.classList.remove('finished', 'failed');
      if (kind === 'err') {
        this.el.status.classList.add('err');
        this.card.classList.add('failed');
      } else if (kind) {
        this.el.status.classList.add('ok');
      }
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
