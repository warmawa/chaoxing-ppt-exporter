/**
 * popup.js — 扩展弹窗里的设置项
 * 改动即时写入 storage.sync，content script 下次探测时生效。
 */

'use strict';

const DEFAULTS = {
  quality: 0.92,
  concurrency: 6,
  maxWidth: 2600,
  autoScroll: true,
};

const els = {
  quality: document.getElementById('quality'),
  qualityVal: document.getElementById('qualityVal'),
  concurrency: document.getElementById('concurrency'),
  concurrencyVal: document.getElementById('concurrencyVal'),
  maxWidth: document.getElementById('maxWidth'),
  maxWidthVal: document.getElementById('maxWidthVal'),
  autoScroll: document.getElementById('autoScroll'),
  status: document.getElementById('status'),
};

let saveTimer = null;

function readForm() {
  return {
    quality: Number(els.quality.value) / 100,
    concurrency: Number(els.concurrency.value),
    maxWidth: Number(els.maxWidth.value),
    autoScroll: els.autoScroll.checked,
  };
}

function syncLabels(settings) {
  els.qualityVal.textContent = `${Math.round(settings.quality * 100)}%`;
  els.concurrencyVal.textContent = String(settings.concurrency);
  els.maxWidthVal.textContent = `${settings.maxWidth}px`;
}

function applyToForm(settings) {
  els.quality.value = String(Math.round(settings.quality * 100));
  els.concurrency.value = String(settings.concurrency);
  els.maxWidth.value = String(settings.maxWidth);
  els.autoScroll.checked = !!settings.autoScroll;
  syncLabels(settings);
}

function scheduleSave() {
  const settings = readForm();
  syncLabels(settings);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.sync.set({ settings });
    els.status.textContent = '已保存';
    setTimeout(() => {
      els.status.textContent = '';
    }, 1600);
  }, 250);
}

['quality', 'concurrency', 'maxWidth'].forEach((key) => {
  els[key].addEventListener('input', scheduleSave);
});
els.autoScroll.addEventListener('change', scheduleSave);

chrome.storage.sync.get('settings', ({ settings }) => {
  applyToForm({ ...DEFAULTS, ...(settings || {}) });
});
