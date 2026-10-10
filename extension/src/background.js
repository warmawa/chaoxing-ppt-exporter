/**
 * background.js — MV3 service worker
 *
 * 职责：
 *   1. 调度 PDF 合成任务，管理 offscreen document 的生命周期
 *   2. 中转进度消息（offscreen → 对应标签页的 content script）
 *   3. 代 offscreen 抓取需要 Referer 的图片（用 declarativeNetRequest 补请求头）
 *   4. 同一课件在多个 iframe 里被探测到时去重，避免页面上出现一堆重复按钮
 */

'use strict';

const OFFSCREEN_URL = 'src/offscreen.html';
const DEFAULT_SETTINGS = {
  quality: 0.92, // JPEG 质量
  concurrency: 6, // 并发下载数
  maxWidth: 2600, // 单页最大宽度，超出按比例缩放
  autoScroll: true, // 导出前自动滚动，触发懒加载
  preferOriginal: true, // 有原始文件时是否优先提示下载原文件
};

let offscreenCreating = null;
let offscreenReady = false;
let closeTimer = null;

// ------------------------------------------------------------------
// 设置
// ------------------------------------------------------------------

async function getSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

// ------------------------------------------------------------------
// offscreen document 生命周期
// ------------------------------------------------------------------

async function ensureOffscreen() {
  if (offscreenReady) {
    cancelClose();
    return;
  }
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) {
    offscreenReady = true;
    cancelClose();
    return;
  }
  if (offscreenCreating) return offscreenCreating;

  offscreenCreating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.DOM_SCRAPING, chrome.offscreen.Reason.BLOBS],
      justification: '把课件图片转成 JPEG 并合成 PDF，需要 canvas 与 Blob',
    })
    .then(() => {
      offscreenReady = true;
      offscreenCreating = null;
    })
    .catch((err) => {
      offscreenCreating = null;
      throw err;
    });

  return offscreenCreating;
}

function scheduleClose() {
  cancelClose();
  closeTimer = setTimeout(async () => {
    closeTimer = null;
    try {
      await chrome.offscreen.closeDocument();
      offscreenReady = false;
    } catch {
      /* 已经关了 */
    }
  }, 20_000);
}

function cancelClose() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

// ------------------------------------------------------------------
// 消息路由
// ------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    case 'cx:offscreen-ready':
      offscreenReady = true;
      respond({ ok: true });
      return false;

    case 'cx:get-settings':
      getSettings().then((s) => respond({ ok: true, settings: s }));
      return true;

    case 'cx:register-deck':
      // 同一个课件可能在好几个嵌套 iframe 里都被探测到，只让第一个显示按钮
      registerDeck(msg.deckId, sender.tab && sender.tab.id, sender.frameId)
        .then((first) => respond({ ok: true, first }))
        .catch((err) => respond({ ok: false, error: err.message }));
      return true;

    // 下面四个是"面板挂在顶层窗口、动作在课件所在 frame 执行"的中转通道。
    // 课件 iframe 常被撑到几千像素高，面板放里面会跟着沉到底部。
    case 'cx:panel-show':
      handlePanelShow(msg, sender).then(respond).catch((err) => respond({ ok: false, error: err.message }));
      return true;

    case 'cx:panel-update':
      handlePanelUpdate(msg, sender).then(respond).catch((err) => respond({ ok: false, error: err.message }));
      return true;

    case 'cx:panel-action':
      handlePanelAction(msg, sender).then(respond).catch((err) => respond({ ok: false, error: err.message }));
      return true;

    case 'cx:panel-result':
      handlePanelResult(msg, sender);
      respond({ ok: true });
      return false;

    case 'cx:export-pdf':
      handleExport(msg.payload, sender).then(respond).catch((err) => respond({ ok: false, error: err.message }));
      return true;

    case 'cx:fetch-image':
      handleFetchImage(msg.url, msg.referer).then(respond).catch((err) => respond({ ok: false, error: err.message }));
      return true;

    case 'cx:progress':
      forwardProgress(msg);
      respond({ ok: true });
      return false;

    default:
      return false;
  }
});

async function handleExport(payload, sender) {
  const settings = await getSettings();
  await ensureOffscreen();

  const job = {
    // content script 会自带 jobId，这样进度消息才能精确回传到发起导出的那个 frame
    jobId: payload.jobId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tabId: sender.tab ? sender.tab.id : null,
    frameId: sender.frameId ?? null,
    ...payload,
    settings: { ...settings, ...(payload.settings || {}) },
  };

  activeJobs.set(job.jobId, job);

  const result = await chrome.runtime.sendMessage({ type: 'cx:build-pdf', payload: job });

  if (result && result.ok && result.fallbackBase64) {
    // offscreen 里没法直接触发下载（某些环境会拦），改由 downloads API 兜底
    await chrome.downloads.download({
      url: `data:application/pdf;base64,${result.fallbackBase64}`,
      filename: result.filename,
      saveAs: false,
    });
  }

  activeJobs.delete(job.jobId);
  scheduleClose();
  return result;
}

const activeJobs = new Map();

function forwardProgress(msg) {
  const job = activeJobs.get(msg.jobId);
  if (!job || job.tabId == null) return;
  chrome.tabs.sendMessage(job.tabId, msg, { frameId: job.frameId ?? undefined }).catch(() => {
    // frame 已经不在了，退而求其次广播给整个标签页
    chrome.tabs.sendMessage(job.tabId, msg).catch(() => {});
  });
}

// ------------------------------------------------------------------
// 需要 Referer 的图片抓取（declarativeNetRequest 动态补头）
// ------------------------------------------------------------------

const REFERER_RULE_ID = 9001;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function handleFetchImage(url, referer) {
  let added = false;
  if (referer) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [REFERER_RULE_ID],
        addRules: [
          {
            id: REFERER_RULE_ID,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }],
            },
            condition: {
              regexFilter: '^' + escapeRegex(url) + '$',
              resourceTypes: ['xmlhttprequest', 'image', 'other'],
            },
          },
        ],
      });
      added = true;
    } catch (err) {
      console.warn('[CX] 添加 Referer 规则失败', err);
    }
  }

  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return { ok: true, base64: btoa(binary) };
  } finally {
    if (added) {
      chrome.declarativeNetRequest
        .updateSessionRules({ removeRuleIds: [REFERER_RULE_ID] })
        .catch(() => {});
    }
  }
}

// ------------------------------------------------------------------
// 课件去重
// ------------------------------------------------------------------

async function registerDeck(deckId, tabId, frameId) {
  const key = `deck:${tabId}:${deckId}`;
  const store = await chrome.storage.session.get(key);
  if (store[key]) return false; // 已经有人显示了
  await chrome.storage.session.set({ [key]: { frameId, at: Date.now() } });
  if (tabId != null) deckOwners.set(tabId, frameId);
  return true;
}

// ------------------------------------------------------------------
// 面板中转：探测在子 frame，面板在顶层 frame
// ------------------------------------------------------------------

/** tabId -> 课件所在 frameId（动作要发回这里执行） */
const deckOwners = new Map();

async function handlePanelShow(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return { ok: false, error: 'no tab' };
  if (sender.frameId === 0) return { ok: true, installed: false }; // 顶层自己显示就行

  deckOwners.set(tabId, sender.frameId);
  const installed = await sendToFrame(tabId, 0, { type: 'cx:panel-install', deck: msg.deck });
  return { ok: installed, installed };
}

async function handlePanelUpdate(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null || sender.frameId === 0) return { ok: true };
  const ok = await sendToFrame(tabId, 0, { type: 'cx:panel-update', deck: msg.deck });
  return { ok };
}

async function handlePanelAction(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const owner = tabId != null ? deckOwners.get(tabId) : null;
  if (tabId == null || owner == null) return { ok: false, error: '找不到课件所在的 frame' };
  const ok = await sendToFrame(tabId, owner, {
    type: 'cx:panel-action',
    action: msg.action,
    payload: msg.payload,
  });
  return { ok };
}

function handlePanelResult(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null || sender.frameId === 0) return;
  sendToFrame(tabId, 0, { type: 'cx:panel-result', data: msg.data });
}

async function sendToFrame(tabId, frameId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId });
    return true;
  } catch {
    return false; // frame 没了
  }
}

// ------------------------------------------------------------------
// 生命周期
// ------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get('settings');
  if (!current.settings) {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  }
});

// 标签页关闭时清掉去重记录
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(`deck:${tabId}:`));
  if (keys.length) await chrome.storage.session.remove(keys);
});
