/**
 * ui.js — 页面上的悬浮操作面板
 *
 * 整体挂在 Shadow DOM 里：学习通自己的 CSS 又多又脏，
 * 不隔离的话按钮会被页面样式改得面目全非。
 */

(function (global) {
  'use strict';

  const CSS = `
    :host { all: initial; }
    .cx-root {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483000;
      width: 296px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                   "Microsoft YaHei", "Helvetica Neue", sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #1f2937;
    }
    .cx-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      box-shadow: 0 12px 32px rgba(15, 23, 42, .16), 0 2px 6px rgba(15, 23, 42, .08);
      overflow: hidden;
      transition: max-height .22s ease;
    }
    .cx-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 11px 12px;
      background: linear-gradient(135deg, #2563eb, #3b82f6);
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
      padding: 2px 4px;
      border-radius: 5px;
      opacity: .85;
    }
    .cx-btn-icon:hover { background: rgba(255,255,255,.2); opacity: 1; }
    .cx-body { padding: 12px; background: #fff; }
    .cx-meta {
      font-size: 11.5px;
      color: #6b7280;
      margin-bottom: 10px;
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
    .cx-progress-wrap { margin-top: 11px; display: none; }
    .cx-progress-wrap.show { display: block; }
    .cx-bar {
      height: 6px;
      background: #e5e7eb;
      border-radius: 999px;
      overflow: hidden;
    }
    .cx-bar-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #2563eb, #60a5fa);
      border-radius: 999px;
      transition: width .25s ease;
    }
    .cx-status {
      margin-top: 6px;
      font-size: 11.5px;
      color: #4b5563;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .cx-status.err { color: #dc2626; }
    .cx-status.ok { color: #059669; }
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
        <div class="cx-body">
          <div class="cx-meta"></div>
          <div class="cx-actions"></div>
          <div class="cx-progress-wrap">
            <div class="cx-bar"><div class="cx-bar-fill"></div></div>
            <div class="cx-status"><span class="cx-status-text"></span><span class="cx-status-num"></span></div>
          </div>
          <div class="cx-hint">导出前会把课件滚动加载一遍，页数较多时请耐心等待。</div>
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
        progress: shadow.querySelector('.cx-progress-wrap'),
        fill: shadow.querySelector('.cx-bar-fill'),
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

      // 可拖动
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let baseRight = 18;
      let baseBottom = 18;
      head.addEventListener('mousedown', (e) => {
        if (e.target.dataset.act) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        head.style.cursor = 'grabbing';
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = startX - e.clientX;
        const dy = startY - e.clientY;
        this.host.style.right = `${Math.max(0, baseRight + dx)}px`;
        this.host.style.bottom = `${Math.max(0, baseBottom + dy)}px`;
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        head.style.cursor = 'move';
        baseRight = parseInt(this.host.style.right || '18', 10);
        baseBottom = parseInt(this.host.style.bottom || '18', 10);
      });
    }

    setBusy(busy) {
      this.busy = busy;
      this.shadow.querySelectorAll('.cx-btn').forEach((b) => {
        if (!b.dataset.act) b.disabled = busy;
      });
    }

    showProgress(show) {
      this.el.progress.classList.toggle('show', !!show);
    }

    setProgress(done, total, text, kind) {
      const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
      this.el.fill.style.width = `${pct}%`;
      if (text != null) this.el.statusText.textContent = text;
      this.el.statusNum.textContent = total > 0 ? `${done}/${total}` : '';
      const st = this.el.statusNum.parentElement;
      st.classList.remove('err', 'ok');
      if (kind) st.classList.add(kind);
    }

    toast(message, kind) {
      this.showProgress(true);
      this.el.statusText.textContent = message;
      this.el.statusNum.textContent = '';
      const st = this.el.statusNum.parentElement;
      st.classList.remove('err', 'ok');
      if (kind) st.classList.add(kind);
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

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  global.CXPanel = ExportPanel;
})(window);
