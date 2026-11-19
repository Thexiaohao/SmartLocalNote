/**
 * SmartLocalNote - Polymorphic Dynamic Island (5 States), Focus-Only Clipboard Sniffing,
 * Focus Countdown -> Progress Excel Writeback, Ctrl+K Dual-Mode Spotlight Search,
 * Web Speech Voice Dictation & Settings/LAN Access + Free AI Presets Modal (V2).
 */

import * as storeMod from './store.js';
import { api } from './api_client.js';
import { icon } from './icons.js';

const {
  store,
  escapeHtml,
  setIsland,
  showToast,
  openSheet,
  closeSheet,
  applyTheme,
  copyInternal,
} = storeMod;

let initialized = false;

// Sniff auto-hide state
let sniffTimer = null;
let sniffHovered = false;
let sniffDeadline = 0;
let sniffRemainingMs = 4000;
let lastSniffedText = '';

// Focus countdown state
let focusTimerId = null;
let focusSubmittingDone = false;

// Alert chime dedupe
let lastAlertKey = '';

// AudioContext singleton (lazy)
let audioCtx = null;

// Spotlight state (V2 Dual-Mode Search)
let spotlightMode = 'quick'; // 'quick' | 'keyword' | 'semantic'
let spotlightItems = [];
let spotlightActiveIndex = 0;
let spotlightSearchTimer = null;
let spotlightLoading = false;
let spotlightMeta = null;
let spotlightSeq = 0;

const SPOTLIGHT_MODES = [
  { id: 'quick', label: '⚡ 快捷跳转' },
  { id: 'keyword', label: '🔍 关键词全文检索' },
  { id: 'semantic', label: '✨ AI 语义描述检索' },
];

const SPOTLIGHT_PLACEHOLDERS = {
  quick: '搜索文件名、应用、工作区或快捷命令…',
  keyword: '输入关键词，全文检索所有 MD / TXT / PDF / Excel 内容…',
  semantic: '用自然语言描述你想找的内容，例如：泰勒展开容易做错的地方在哪？',
};

const DEFAULT_AI_PRESETS = [
  {
    id: 'free_auto',
    label: '免 Key 免费基础 AI（自动探测本机 Ollama / 免费公共通道 / 本地引擎）',
    name: '免 Key 免费基础 AI（自动探测本机 Ollama / 免费公共通道 / 本地引擎）',
    base_url: '',
    model: 'openai',
    web_search_param: '',
    needs_key: false,
    doc_url: '',
    hint: '无需注册开箱即用；自动尝试免费基础通道，断网自动回退本地规则引擎',
  },
  {
    id: 'zhipu_free',
    label: '智谱 GLM-4-Flash（永久免费 · 国内直连）',
    name: '智谱 GLM-4-Flash（永久免费 · 国内直连）',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    web_search_param: '',
    needs_key: true,
    doc_url: 'https://open.bigmodel.cn/usercenter/apikeys',
    hint: '国内直连速度快，glm-4-flash 免费开放',
  },
  {
    id: 'siliconflow_free',
    label: '硅基流动 Qwen2.5-7B（免费额度 · 国内直连）',
    name: '硅基流动 Qwen2.5-7B（免费额度 · 国内直连）',
    base_url: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    web_search_param: '',
    needs_key: true,
    doc_url: 'https://cloud.siliconflow.cn/account/ak',
    hint: '国内直连，多款 7B/9B 开源模型免费',
  },
  {
    id: 'gemini_free',
    label: 'Google Gemini 2.5 Flash（免卡每日免费）',
    name: 'Google Gemini 2.5 Flash（免卡每日免费）',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    web_search_param: '',
    needs_key: true,
    doc_url: 'https://aistudio.google.com/apikey',
    hint: '免信用卡，官方每日免费 500 次',
  },
];

function applyDocTypographySafe(fontSize) {
  const clamped = Math.min(24, Math.max(12, Number(fontSize) || 15));
  if (typeof storeMod.applyDocTypography === 'function') {
    storeMod.applyDocTypography(clamped);
    return clamped;
  }
  store.state.docFontSize = clamped;
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--doc-font-size', `${clamped}px`);
  }
  return clamped;
}

/* --------------------------------------------------------------------------
 * Utilities: Audio Chime, Date Formatting, File & Panel Helpers
 * -------------------------------------------------------------------------- */

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) {
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playTone(kind = 'chime') {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const scheduleNote = (freq, startOffset, duration, peakGain = 0.08) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(0.0001, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(peakGain, now + startOffset + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + duration + 0.02);
    };

    if (kind === 'alert') {
      scheduleNote(880, 0, 0.16, 0.07);
      scheduleNote(987.77, 0.18, 0.22, 0.07);
    } else {
      scheduleNote(523.25, 0, 0.26, 0.07);
      scheduleNote(659.25, 0.14, 0.3, 0.07);
      scheduleNote(783.99, 0.28, 0.45, 0.08);
    }
  } catch {
    // Ignore audio context restrictions
  }
}

function formatCountdown(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function todayYYYYMMDD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isXlsxFile(file) {
  if (!file) return false;
  const ext = String(file.ext || '').toLowerCase();
  const name = String(file.name || file.path || '').toLowerCase();
  return ext === '.xlsx' || ext === 'xlsx' || name.endsWith('.xlsx');
}

function getXlsxFiles() {
  const items = store.state.files?.items || [];
  return items.filter(isXlsxFile);
}

function openFileObject(file) {
  if (!file || !file.path) return;
  const name = file.name || file.path.split(/[\\/]/).pop() || file.path;
  const payload = { ...file, name };
  store.setState({ activeFile: payload }, 'file:opened');
  store.emit('file:open', payload);
}

function openFileByPath(pathStr) {
  const target = String(pathStr || '').trim();
  if (!target) return;
  const existing = (store.state.files?.items || []).find((f) => f.path === target);
  if (existing) {
    openFileObject(existing);
  } else {
    openFileObject({
      path: target,
      name: target.split(/[\\/]/).pop() || target,
    });
  }
}

function switchToSummaryPanel() {
  const patch = { rightMode: 'summary', rightCollapsed: false };
  if (typeof window !== 'undefined' && window.innerWidth <= 767) {
    patch.mobileTab = 'ai';
  }
  store.setState(patch, 'rightMode:changed');
  store.emit('layout:changed');
}

function sendBrowserNotification(title, body) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch {
    // Ignore Notification API errors
  }
}

/* --------------------------------------------------------------------------
 * 1. Sniff Auto-Hide Timer & Focus-Only Clipboard Sniffing (Innovation 3)
 * -------------------------------------------------------------------------- */

function clearSniffTimer() {
  if (sniffTimer) {
    window.clearTimeout(sniffTimer);
    sniffTimer = null;
  }
}

function scheduleSniffAutoHide(durationMs = 4000) {
  clearSniffTimer();
  const waitMs = Math.max(0, Number(durationMs) || 4000);
  sniffRemainingMs = waitMs;
  if (sniffHovered) return;
  sniffDeadline = Date.now() + waitMs;
  sniffTimer = window.setTimeout(() => {
    sniffTimer = null;
    if (store.state.island?.mode === 'sniff') {
      setIsland('idle');
    }
  }, waitMs);
}

async function handleWindowFocus() {
  const curMode = store.state.island?.mode;
  if (curMode === 'focus' || curMode === 'focus-done' || curMode === 'alert') {
    return;
  }
  if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
    return;
  }
  try {
    const raw = await navigator.clipboard.readText();
    const text = String(raw || '').trim();
    if (!text || text.length < 4) return;
    if (text === lastSniffedText) return;
    if (text === String(store.state.internalCopyText || '').trim()) return;
    lastSniffedText = text;
    sniffRemainingMs = 4000;
    setIsland('sniff', { text });
  } catch {
    // Silently ignore clipboard permission or document focus restrictions
  }
}

/* --------------------------------------------------------------------------
 * 2. Focus Countdown & Excel Writeback (Innovation 5)
 * -------------------------------------------------------------------------- */

function stopFocusTimer() {
  if (focusTimerId) {
    window.clearInterval(focusTimerId);
    focusTimerId = null;
  }
}

function completeFocusSession(naturalFinish = true) {
  stopFocusTimer();
  const focusState = store.state.focus || {};
  const taskTitle = focusState.taskTitle || store.state.island?.data?.taskTitle || '专注任务';
  const totalSec = Math.max(1, Number(focusState.totalSec) || 1500);
  const remaining = Math.max(0, Number(focusState.remainingSec) || 0);
  const durationSec = naturalFinish ? totalSec : Math.max(1, totalSec - remaining);

  store.state.focus = {
    ...focusState,
    active: false,
    paused: false,
    remainingSec: 0,
  };

  if (naturalFinish) {
    playTone('chime');
    sendBrowserNotification('专注倒计时完成', `「${taskTitle}」已完成，快来记入进度表！`);
  }

  store.emit('focus:done', { title: taskTitle, durationSec });
  setIsland('focus-done', { title: taskTitle, taskTitle, durationSec });
}

function tickFocus() {
  const focusState = store.state.focus;
  if (!focusState?.active) {
    stopFocusTimer();
    return;
  }
  if (focusState.paused) return;

  const nextRemaining = Math.max(0, (Number(focusState.remainingSec) || 0) - 1);
  focusState.remainingSec = nextRemaining;

  const islandEl = document.getElementById('dynamic-island');
  if (islandEl && store.state.island?.mode === 'focus') {
    store.state.island.data.remainingSec = nextRemaining;
    const timerEl = islandEl.querySelector('.island-timer');
    if (timerEl) {
      timerEl.textContent = formatCountdown(nextRemaining);
    }
  }

  if (nextRemaining <= 0) {
    completeFocusSession(true);
  }
}

function ensureFocusTimerRunning() {
  if (!focusTimerId) {
    focusTimerId = window.setInterval(tickFocus, 1000);
  }
}

async function startFocusSession({
  title,
  taskTitle,
  seconds = 1500,
  workspace_id = null,
  app_ids = [],
  file_paths = [],
} = {}) {
  stopFocusTimer();

  const cleanTitle = String(title || taskTitle || '专注任务').trim() || '专注任务';
  const totalSec = Math.max(1, Number(seconds) || 1500);

  let filesToOpen = Array.isArray(file_paths) ? file_paths.filter(Boolean) : [];

  if (workspace_id) {
    api.post('/api/apps/launch', { workspace_id }).catch(() => {});
    if (filesToOpen.length === 0) {
      const ws = (store.state.workspaces || []).find((w) => w.id === workspace_id);
      if (Array.isArray(ws?.file_paths) && ws.file_paths.length > 0) {
        filesToOpen = ws.file_paths.filter(Boolean);
      }
    }
  } else if (Array.isArray(app_ids) && app_ids.length > 0) {
    for (const appId of app_ids) {
      if (appId) {
        api.post('/api/apps/launch', { app_id: appId }).catch(() => {});
      }
    }
  }

  if (filesToOpen.length > 0) {
    openFileByPath(filesToOpen[0]);
  }

  store.state.focus = {
    active: true,
    paused: false,
    taskTitle: cleanTitle,
    totalSec,
    remainingSec: totalSec,
    targetExcel: store.state.config?.default_progress_excel || store.state.focus?.targetExcel || '',
  };

  ensureFocusTimerRunning();
  setIsland('focus', {
    taskTitle: cleanTitle,
    title: cleanTitle,
    totalSec,
    remainingSec: totalSec,
    paused: false,
  });
}

async function submitFocusDoneToExcel(islandEl) {
  if (focusSubmittingDone) return;
  const input = islandEl?.querySelector('#island-done-input');
  const select = islandEl?.querySelector('#island-done-excel');
  const submitBtn = islandEl?.querySelector('[data-island-action="focus-done-submit"]');

  const taskTitle =
    store.state.island?.data?.title ||
    store.state.island?.data?.taskTitle ||
    store.state.focus?.taskTitle ||
    '专注任务';
  const userInput = input?.value?.trim() || taskTitle;
  const targetPath = select?.value?.trim() || '';

  if (!targetPath) {
    showToast('当前工作区暂无 .xlsx 进度表，请先导入或创建表格', 'warning');
    return;
  }

  focusSubmittingDone = true;
  if (submitBtn) submitBtn.disabled = true;

  try {
    api
      .put('/api/system/config', { default_progress_excel: targetPath })
      .then((updated) => {
        if (updated && typeof updated === 'object') {
          store.setState({ config: updated }, 'config:changed');
        }
      })
      .catch(() => {});

    const sheetsRes = await api.get(`/api/excel/sheets?path=${encodeURIComponent(targetPath)}`);
    const firstSheet = Array.isArray(sheetsRes?.sheets) ? sheetsRes.sheets[0] : null;
    const sheetName = firstSheet?.name || '';
    const headers =
      Array.isArray(firstSheet?.headers) && firstSheet.headers.length > 0
        ? firstSheet.headers
        : ['日期', '任务', '完成内容', '状态'];

    let rows = [];
    try {
      const extracted = await api.post('/api/ai/extract-table', {
        text: `${taskTitle}：${userInput}`,
        headers,
      });
      if (Array.isArray(extracted?.rows) && extracted.rows.length > 0) {
        rows = extracted.rows;
      }
    } catch {
      // Fallback below
    }

    if (!rows.length) {
      const baseRow = [todayYYYYMMDD(), taskTitle, userInput, '已完成'];
      const normalized = [];
      for (let i = 0; i < headers.length; i += 1) {
        normalized.push(i < baseRow.length ? baseRow[i] : '');
      }
      rows = [normalized];
    }

    await api.post('/api/excel/append-rows', {
      path: targetPath,
      sheet: sheetName || null,
      rows,
    });

    store.emit('file:refresh-excel', { path: targetPath, sheet: sheetName });

    const matched = getXlsxFiles().find((f) => f.path === targetPath);
    const excelName = matched?.name || targetPath.split(/[\\/]/).pop() || targetPath;
    showToast(`已自动写入进度表 ${excelName}（已生成写前快照）`, 'success');
    setIsland('idle');
  } catch (err) {
    showToast(`写入进度表失败：${err?.message || '未知错误'}`, 'error');
  } finally {
    focusSubmittingDone = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}

/* --------------------------------------------------------------------------
 * 3. Dynamic Island 5-Mode Renderer
 * -------------------------------------------------------------------------- */

function renderDynamicIsland(islandEl, islandState) {
  if (!islandEl) return;
  const mode = islandState?.mode || 'idle';
  const data = islandState?.data || {};

  islandEl.className = 'dynamic-island';
  islandEl.dataset.mode = mode;

  if (mode === 'sniff') {
    const rawText = String(data.text || '').trim();
    const preview = rawText.slice(0, 32) + (rawText.length > 32 ? '…' : '');
    islandEl.innerHTML = `
      <div class="island-sniff-view">
        <span class="island-sniff-text" title="${escapeHtml(rawText)}">${icon('clipboard', 12)} ${escapeHtml(preview)}</span>
        <button type="button" class="island-pill-btn is-primary" data-island-action="sniff-ai">✨ AI 提取待办</button>
        <button type="button" class="island-pill-btn" data-island-action="sniff-note">📝 存为笔记</button>
        <button type="button" class="island-pill-btn" data-island-action="dismiss" aria-label="关闭">✕</button>
      </div>
    `;
    scheduleSniffAutoHide(sniffRemainingMs || 4000);
    return;
  }

  clearSniffTimer();

  if (mode === 'focus') {
    const taskTitle = data.title || data.taskTitle || store.state.focus?.taskTitle || '专注进行中';
    const totalSec = Math.max(1, Number(data.totalSec ?? store.state.focus?.totalSec) || 1500);
    const remainingSec = Math.max(0, Number(data.remainingSec ?? store.state.focus?.remainingSec ?? totalSec));
    const paused = Boolean(data.paused ?? store.state.focus?.paused);

    if (!store.state.focus?.active && remainingSec > 0) {
      store.state.focus = {
        active: true,
        paused,
        taskTitle,
        totalSec,
        remainingSec,
        targetExcel: store.state.config?.default_progress_excel || '',
      };
      ensureFocusTimerRunning();
    }

    islandEl.innerHTML = `
      <div class="island-focus-view">
        <span class="breath-dot" aria-hidden="true" ${paused ? 'style="animation-play-state: paused; opacity: 0.45;"' : ''}></span>
        <span class="island-timer">${formatCountdown(remainingSec)}</span>
        <span class="island-label" title="${escapeHtml(taskTitle)}">· ${escapeHtml(taskTitle)}</span>
        <div class="island-focus-actions">
          <button type="button" class="island-pill-btn" data-island-action="focus-toggle-pause" aria-label="${paused ? '继续' : '暂停'}">${paused ? '▶' : '⏸'}</button>
          <button type="button" class="island-pill-btn is-primary" data-island-action="focus-finish">✓ 结束</button>
        </div>
      </div>
    `;
    return;
  }

  if (mode === 'focus-done') {
    stopFocusTimer();
    const xlsxFiles = getXlsxFiles();
    const cfgExcel = store.state.config?.default_progress_excel || '';
    const defaultMatch = xlsxFiles.find((f) => f.path === cfgExcel || f.name === cfgExcel);
    const selectedPath = defaultMatch?.path || xlsxFiles[0]?.path || '';

    const optionsHtml =
      xlsxFiles.length > 0
        ? xlsxFiles
            .map((f) => {
              const label = f.name || f.path.split(/[\\/]/).pop() || f.path;
              const isSelected = f.path === selectedPath;
              return `<option value="${escapeHtml(f.path)}" ${isSelected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
            })
            .join('')
        : '<option value="" disabled selected>暂无表格</option>';

    islandEl.innerHTML = `
      <div class="island-focus-done-view">
        <input id="island-done-input" class="island-mini-input" type="text" placeholder="刚完成了什么？回车记入进度表" autocomplete="off" />
        <select id="island-done-excel" class="island-mini-select" aria-label="目标进度表">${optionsHtml}</select>
        <button type="button" class="island-pill-btn is-primary" data-island-action="focus-done-submit">✓ 写入</button>
        <button type="button" class="island-pill-btn" data-island-action="dismiss">跳过</button>
      </div>
    `;

    window.requestAnimationFrame(() => {
      islandEl.querySelector('#island-done-input')?.focus();
    });
    return;
  }

  if (mode === 'alert') {
    const title = data.title || '定时提醒时间到';
    const alertKey = `${data.id || ''}:${title}:${data.fired_at || ''}`;
    if (alertKey !== lastAlertKey) {
      lastAlertKey = alertKey;
      playTone('alert');
    }

    islandEl.innerHTML = `
      <div class="island-alert-view">
        <span aria-hidden="true">${icon('bell', 14)}</span>
        <span class="island-label" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
        <button type="button" class="island-pill-btn is-warning" data-island-action="alert-exec">🚀 一键执行</button>
        <button type="button" class="island-pill-btn is-primary" data-island-action="alert-focus">▶ 专注</button>
        <button type="button" class="island-pill-btn" data-island-action="dismiss" aria-label="关闭">✕</button>
      </div>
    `;
    return;
  }

  const activeName = store.state.activeFile?.name || '本地工作台就绪';
  islandEl.innerHTML = `
    <div class="island-idle-view">
      <span class="island-status-dot" aria-hidden="true"></span>
      <span class="island-label">${escapeHtml(activeName)}</span>
    </div>
  `;
}

async function handleIslandAction(islandEl, action) {
  if (action === 'dismiss') {
    clearSniffTimer();
    stopFocusTimer();
    if (store.state.focus) {
      store.state.focus.active = false;
      store.state.focus.paused = false;
    }
    setIsland('idle');
    return;
  }

  if (action === 'sniff-ai') {
    const text = store.state.island?.data?.text || '';
    clearSniffTimer();
    switchToSummaryPanel();
    store.emit('ai:summarize-request', { text, autoRun: true });
    setIsland('idle');
    return;
  }

  if (action === 'sniff-note') {
    const text = store.state.island?.data?.text || '';
    clearSniffTimer();
    const title = `剪贴板速记_${text.slice(0, 12) || '速记'}`;
    try {
      const created = await api.post('/api/files/create-note', { title, content: text });
      store.emit('files:updated');
      if (created?.path) {
        openFileObject(created);
      }
      showToast(`已存为本地笔记：${created?.name || title}`, 'success');
    } catch (err) {
      showToast(`保存笔记失败：${err?.message || '未知错误'}`, 'error');
    } finally {
      setIsland('idle');
    }
    return;
  }

  if (action === 'focus-toggle-pause') {
    const nextPaused = !Boolean(store.state.focus?.paused ?? store.state.island?.data?.paused);
    if (store.state.focus) {
      store.state.focus.paused = nextPaused;
    }
    setIsland('focus', {
      ...(store.state.island?.data || {}),
      remainingSec: store.state.focus?.remainingSec ?? store.state.island?.data?.remainingSec ?? 1500,
      paused: nextPaused,
    });
    return;
  }

  if (action === 'focus-finish') {
    completeFocusSession(false);
    return;
  }

  if (action === 'focus-done-submit') {
    await submitFocusDoneToExcel(islandEl);
    return;
  }

  if (action === 'alert-exec') {
    const data = store.state.island?.data || {};
    const appIds = Array.isArray(data.app_ids) ? data.app_ids : [];
    const filePaths = Array.isArray(data.file_paths) ? data.file_paths : [];
    const title = data.title || '提醒任务';

    setIsland('idle');

    if (data.workspace_id) {
      api.post('/api/apps/launch', { workspace_id: data.workspace_id }).catch(() => {});
    }
    for (const appId of appIds) {
      if (appId) {
        api.post('/api/apps/launch', { app_id: appId }).catch(() => {});
      }
    }
    if (filePaths.length > 0) {
      openFileByPath(filePaths[0]);
    }
    showToast(`已执行提醒关联任务：${title}`, 'success');
    return;
  }

  if (action === 'alert-focus') {
    const data = store.state.island?.data || {};
    startFocusSession({
      title: data.title || '提醒专注任务',
      seconds: 1500,
      workspace_id: data.workspace_id || null,
      app_ids: Array.isArray(data.app_ids) ? data.app_ids : [],
      file_paths: Array.isArray(data.file_paths) ? data.file_paths : [],
    });
  }
}

/* --------------------------------------------------------------------------
 * 4. Desktop Scene Capture Helper (for Spotlight Command)
 * -------------------------------------------------------------------------- */

async function openSceneCaptureSheet() {
  let windowsList = [];
  try {
    const res = await api.get('/api/apps/running-windows');
    if (Array.isArray(res)) windowsList = res;
    else if (Array.isArray(res?.windows)) windowsList = res.windows;
  } catch {
    windowsList = [];
  }

  const rowsHtml =
    windowsList.length > 0
      ? windowsList
          .map(
            (w, idx) => `
            <label class="glass-card" style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;">
              <input type="checkbox" class="scene-win-check" data-idx="${idx}" checked />
              <div style="min-width:0;flex:1;">
                <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(w.name || w.process || '窗口')}</div>
                <div style="font-size:11.5px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(w.title || w.path || '')}</div>
              </div>
            </label>
          `
          )
          .join('')
      : `<div class="glass-card" style="color:var(--text-secondary);font-size:12.5px;">未检测到外部桌面窗口，仍可直接保存当前打开文档为场景工作区。</div>`;

  const currentFile = store.state.activeFile;

  openSheet({
    title: '捕获当前桌面现场',
    bodyHtml: `
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:5px;">场景名称</label>
          <input id="scene-capture-name" class="apple-input" type="text" value="${escapeHtml(currentFile ? `${currentFile.name} 现场` : '我的学习现场')}" />
        </div>
        <div style="font-size:12px;font-weight:600;color:var(--text-secondary);">桌面运行窗口 (${windowsList.length})</div>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;">
          ${rowsHtml}
        </div>
        ${
          currentFile?.path
            ? `<label class="glass-card" style="display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12.5px;">
                 <input type="checkbox" id="scene-bind-active-file" checked />
                 <span>绑定当前文档：${escapeHtml(currentFile.name)}</span>
               </label>`
            : ''
        }
      </div>
    `,
    footerHtml: `
      <button type="button" class="pill-btn" id="scene-cancel-btn">取消</button>
      <button type="button" class="pill-btn pill-btn-primary" id="scene-save-btn">固化工作区</button>
    `,
    onMount(card) {
      card.querySelector('#scene-cancel-btn')?.addEventListener('click', closeSheet);
      card.querySelector('#scene-save-btn')?.addEventListener('click', async () => {
        const name = card.querySelector('#scene-capture-name')?.value?.trim() || '桌面工作区';
        const capturedApps = [];
        card.querySelectorAll('.scene-win-check:checked').forEach((chk) => {
          const item = windowsList[Number(chk.dataset.idx)];
          if (item) capturedApps.push(item);
        });
        const bindFile = card.querySelector('#scene-bind-active-file')?.checked && currentFile?.path;
        const filePaths = bindFile ? [currentFile.path] : [];

        try {
          await api.post('/api/workspaces', {
            name,
            app_ids: [],
            file_paths: filePaths,
            captured_apps: capturedApps,
          });
          store.emit('workspaces:updated');
          closeSheet();
          showToast(`已捕获并保存场景「${name}」`, 'success');
        } catch (err) {
          showToast(`保存现场失败：${err?.message || '未知错误'}`, 'error');
        }
      });
    },
  });
}

/* --------------------------------------------------------------------------
 * 5. Ctrl+K / Cmd+K Dual-Mode Spotlight Search (#spotlight-overlay) — Pain Point #6A
 * -------------------------------------------------------------------------- */

function getSpotlightElements() {
  let overlay = document.getElementById('spotlight-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'spotlight-overlay';
    overlay.className = 'overlay-backdrop spotlight-overlay';
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="spotlight-card">
        <div class="spotlight-input-row">
          ${icon('search', 18)}
          <input id="spotlight-input" class="spotlight-input" type="search" placeholder="${SPOTLIGHT_PLACEHOLDERS.quick}" autocomplete="off" spellcheck="false">
          <kbd class="kbd-hint">ESC</kbd>
        </div>
        <div id="spotlight-results" class="spotlight-results"></div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  const card = overlay.querySelector('.spotlight-card');
  const inputRow = overlay.querySelector('.spotlight-input-row');
  let modeBar = overlay.querySelector('.spotlight-mode-bar');
  if (!modeBar && card && inputRow) {
    modeBar = document.createElement('div');
    modeBar.className = 'spotlight-mode-bar';
    modeBar.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 14px;border-bottom:1px solid var(--border-hairline);background:var(--bg-subtle);flex-wrap:wrap;';
    inputRow.insertAdjacentElement('afterend', modeBar);
  }

  return {
    overlay,
    card,
    input: document.getElementById('spotlight-input') || overlay.querySelector('.spotlight-input'),
    modeBar,
    resultsEl: document.getElementById('spotlight-results') || overlay.querySelector('.spotlight-results'),
  };
}

function renderSpotlightModeBar() {
  const { input, modeBar } = getSpotlightElements();
  if (input) {
    input.placeholder = SPOTLIGHT_PLACEHOLDERS[spotlightMode] || SPOTLIGHT_PLACEHOLDERS.quick;
  }
  if (!modeBar) return;

  modeBar.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
      ${SPOTLIGHT_MODES.map((m) => {
        const active = spotlightMode === m.id;
        return `
          <button
            type="button"
            class="pill-btn pill-btn-sm ${active ? 'pill-btn-primary is-active' : ''}"
            data-spotlight-mode="${m.id}"
            style="height:26px;padding:0 10px;font-size:11.5px;"
          >${escapeHtml(m.label)}</button>
        `;
      }).join('')}
    </div>
    ${
      spotlightMode === 'semantic'
        ? `<button type="button" class="pill-btn pill-btn-sm pill-btn-primary" id="spotlight-semantic-go" style="height:26px;padding:0 10px;font-size:11.5px;">
            ${icon('sparkles', 12)} 开始语义检索
          </button>`
        : ''
    }
  `;
}

function highlightKeywordSnippet(snippetText, query) {
  const raw = String(snippetText || '');
  const q = String(query || '').trim();
  if (!q || !raw) return escapeHtml(raw);

  const tokens = q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1)
    .slice(0, 6);
  if (!tokens.length) return escapeHtml(raw);

  const escapedRegex = tokens
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(`(${escapedRegex})`, 'gi');

  let out = '';
  let lastIndex = 0;
  let match;
  while ((match = re.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      out += escapeHtml(raw.slice(lastIndex, match.index));
    }
    out += `<mark style="background:var(--accent-soft);color:var(--accent);padding:0 2px;border-radius:3px;font-weight:600;">${escapeHtml(match[0])}</mark>`;
    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) break;
  }
  if (lastIndex < raw.length) {
    out += escapeHtml(raw.slice(lastIndex));
  }
  return out;
}

function buildQuickCommands() {
  return [
    {
      type: 'cmd',
      id: 'cmd-semantic-search',
      icon: 'sparkles',
      label: 'AI 语义描述检索笔记内容',
      sub: '命令 · 用自然语言找笔记段落与错题位置',
      keywords: 'ai yuyi semantic search 语义 检索 描述',
    },
    {
      type: 'cmd',
      id: 'cmd-new-note',
      icon: 'plus',
      label: '新建空白笔记',
      sub: '命令 · 创建 Markdown 笔记',
      keywords: 'xinjian biji note create',
    },
    {
      type: 'cmd',
      id: 'cmd-capture-scene',
      icon: 'camera',
      label: '捕获当前桌面现场',
      sub: '命令 · 固化桌面窗口与文档',
      keywords: 'buhuo xianchang scene workspace capture',
    },
    {
      type: 'cmd',
      id: 'cmd-ai-summarize',
      icon: 'sparkles',
      label: 'AI 总结当前文档',
      sub: '命令 · 提炼核心摘要与待办',
      keywords: 'ai zongjie summarize',
    },
    {
      type: 'cmd',
      id: 'cmd-focus-15s',
      icon: 'clock',
      label: '开始专注倒计时（15秒演示）',
      sub: '命令 · 灵动岛专注胶囊演示',
      keywords: 'zhuanzhu focus 15s demo',
    },
    {
      type: 'cmd',
      id: 'cmd-focus-25m',
      icon: 'clock',
      label: '开始专注倒计时（25分钟）',
      sub: '命令 · 标准番茄专注',
      keywords: 'zhuanzhu focus 25m pomodoro',
    },
    {
      type: 'cmd',
      id: 'cmd-toggle-theme',
      icon: store.state.theme === 'dark' ? 'sun' : 'moon',
      label: '切换浅色/深色主题',
      sub: '命令 · Sonoma 浅色 / Sequoia 深色',
      keywords: 'zhuti theme dark light',
    },
    {
      type: 'cmd',
      id: 'cmd-open-settings',
      icon: 'settings',
      label: '打开系统与局域网设置',
      sub: '命令 · AI 预设 / 免费 AI / 手机端入口',
      keywords: 'shezhi settings lan url',
    },
  ];
}

function getFileIconByExt(extOrPath) {
  const s = String(extOrPath || '').toLowerCase();
  if (s.endsWith('.pdf') || s === 'pdf') return 'file-pdf';
  if (s.endsWith('.xlsx') || s.endsWith('.xlsm') || s.endsWith('.csv') || s === 'xlsx') {
    return 'file-spreadsheet';
  }
  return 'file-text';
}

function buildQuickSpotlightResults(query) {
  const q = String(query || '').trim().toLowerCase();

  const fileItems = (store.state.files?.items || []).map((f) => ({
    type: 'file',
    icon: getFileIconByExt(f.ext || f.path),
    label: f.name || f.path.split(/[\\/]/).pop() || f.path,
    sub: f.path,
    searchText: `${f.name || ''} ${f.path || ''}`.toLowerCase(),
    payload: f,
  }));

  const appItems = (store.state.apps || []).map((a) => ({
    type: 'app',
    icon: 'rocket',
    label: a.name || '本地应用',
    sub: `直达应用 · ${a.path || ''}`,
    searchText: `${a.name || ''} ${a.path || ''} ${(a.aliases || []).join(' ')}`.toLowerCase(),
    payload: a,
  }));

  const wsItems = (store.state.workspaces || []).map((w) => ({
    type: 'workspace',
    icon: 'layers',
    label: w.name || '场景工作区',
    sub: `工作区 · ${(w.app_ids?.length || 0) + (w.captured_apps?.length || 0)} 软件 · ${w.file_paths?.length || 0} 文档`,
    searchText: `${w.name || ''} workspace`.toLowerCase(),
    payload: w,
  }));

  const cmdItems = buildQuickCommands().map((c) => ({
    ...c,
    searchText: `${c.label} ${c.sub} ${c.keywords}`.toLowerCase(),
  }));

  const all = [...fileItems, ...appItems, ...wsItems, ...cmdItems];
  if (!q) {
    return [...fileItems.slice(0, 4), ...wsItems.slice(0, 2), ...appItems.slice(0, 2), ...cmdItems].slice(0, 11);
  }
  return all.filter((item) => item.searchText.includes(q)).slice(0, 12);
}

function formatSearchAnchorBadge(r) {
  if (r.page) return `第 ${r.page} 页`;
  if (r.sheet && r.cell) return `${r.sheet}!${r.cell}`;
  if (r.cell) return `${r.cell}`;
  if (r.anchor) return String(r.anchor);
  if (r.ext) return String(r.ext).replace(/^\./, '').toUpperCase();
  return '';
}

function renderSpotlightSearchResults() {
  const { input, resultsEl } = getSpotlightElements();
  if (!resultsEl) return;

  const query = String(input?.value || '').trim();

  if (spotlightMode === 'quick') {
    spotlightItems = buildQuickSpotlightResults(query);
    if (spotlightActiveIndex >= spotlightItems.length) spotlightActiveIndex = 0;
    if (spotlightActiveIndex < 0) spotlightActiveIndex = 0;

    if (spotlightItems.length === 0) {
      resultsEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-tertiary);font-size:13px;">未找到匹配的文档、应用或命令</div>`;
      return;
    }

    resultsEl.innerHTML = spotlightItems
      .map(
        (item, idx) => `
        <button type="button" class="spotlight-item ${idx === spotlightActiveIndex ? 'is-active' : ''}" data-spotlight-idx="${idx}">
          <span style="display:inline-flex;align-items:center;gap:9px;min-width:0;flex:1;">
            <span style="color:var(--accent);display:inline-flex;flex-shrink:0;">${icon(item.icon || 'file-text', 15)}</span>
            <span style="font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.label)}</span>
          </span>
          <span style="font-size:11.5px;color:var(--text-tertiary);max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.sub || '')}</span>
        </button>
      `
      )
      .join('');
    return;
  }

  // Keyword or Semantic mode
  if (spotlightLoading) {
    resultsEl.innerHTML = `
      <div style="padding:26px 16px;text-align:center;color:var(--text-secondary);font-size:13px;display:flex;flex-direction:column;align-items:center;gap:8px;">
        <span style="color:var(--accent);">${icon('sparkles', 20)}</span>
        <span>${spotlightMode === 'semantic' ? 'AI 语义检索引擎正在分析笔记与文档内容…' : '正在全文检索本地文档…'}</span>
      </div>
    `;
    return;
  }

  if (!query) {
    const tip =
      spotlightMode === 'semantic'
        ? '输入自然语言问题或描述，点击「开始语义检索」或按 Enter 检索笔记内容（自动跳过隐私锁定文件）。'
        : '输入关键词实时全文检索所有已导入的 MD / TXT / PDF / Excel 内容。';
    resultsEl.innerHTML = `<div style="padding:24px 16px;text-align:center;color:var(--text-tertiary);font-size:12.5px;">${escapeHtml(tip)}</div>`;
    return;
  }

  if (spotlightItems.length === 0) {
    const skippedNote =
      spotlightMeta?.skipped_private > 0
        ? `（已安全跳过 ${spotlightMeta.skipped_private} 份隐私锁定文件）`
        : '';
    resultsEl.innerHTML = `<div style="padding:22px 16px;text-align:center;color:var(--text-tertiary);font-size:13px;">未检索到匹配内容 ${escapeHtml(skippedNote)}</div>`;
    return;
  }

  const metaParts = [];
  if (spotlightMeta?.provider_label) metaParts.push(spotlightMeta.provider_label);
  else if (spotlightMeta?.engine) metaParts.push(spotlightMeta.engine);
  if (Number.isFinite(spotlightMeta?.total)) metaParts.push(`共 ${spotlightMeta.total} 条匹配`);
  if (spotlightMeta?.skipped_private > 0) {
    metaParts.push(`已跳过 ${spotlightMeta.skipped_private} 份隐私锁文件`);
  }

  const metaBarHtml = metaParts.length
    ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 10px 8px;font-size:11px;color:var(--text-tertiary);">${escapeHtml(metaParts.join(' · '))}</div>`
    : '';

  resultsEl.innerHTML =
    metaBarHtml +
    spotlightItems
      .map((item, idx) => {
        const r = item.payload || {};
        const anchorBadge = formatSearchAnchorBadge(r);
        const snippetHtml =
          spotlightMode === 'keyword'
            ? highlightKeywordSnippet(r.snippet || '', query)
            : escapeHtml(r.snippet || '');
        const scoreNum = Number(r.score);
        const scoreText = Number.isFinite(scoreNum) && scoreNum > 0 ? `${Math.round(scoreNum <= 1 ? scoreNum * 100 : scoreNum)}%` : '';
        const reasonText = r.reason ? String(r.reason) : '';

        return `
          <button
            type="button"
            class="spotlight-item ${idx === spotlightActiveIndex ? 'is-active' : ''}"
            data-spotlight-idx="${idx}"
            style="flex-direction:column;align-items:stretch;gap:5px;padding:10px 12px;"
          >
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;">
              <span style="display:inline-flex;align-items:center;gap:8px;min-width:0;flex:1;">
                <span style="color:var(--accent);display:inline-flex;flex-shrink:0;">${icon(item.icon || 'file-text', 15)}</span>
                <span style="font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.name || item.label)}</span>
              </span>
              <span style="display:inline-flex;align-items:center;gap:5px;flex-shrink:0;">
                ${
                  anchorBadge
                    ? `<span style="padding:2px 8px;border-radius:9999px;background:var(--accent-soft);color:var(--accent);font-size:11px;font-weight:600;">${escapeHtml(anchorBadge)}</span>`
                    : ''
                }
                ${
                  spotlightMode === 'semantic' && (reasonText || scoreText)
                    ? `<span class="search-reason-pill" style="padding:2px 8px;border-radius:9999px;background:var(--success-soft);color:var(--success);font-size:11px;font-weight:500;">${escapeHtml([scoreText, reasonText].filter(Boolean).join(' · '))}</span>`
                    : ''
                }
              </span>
            </div>
            ${
              r.snippet
                ? `<div class="search-snippet" style="font-size:12px;color:var(--text-secondary);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${snippetHtml}</div>`
                : ''
            }
          </button>
        `;
      })
      .join('');
}

async function runBackendSearch(mode, query) {
  const q = String(query || '').trim();
  const reqId = ++spotlightSeq;

  if (!q) {
    spotlightLoading = false;
    spotlightItems = [];
    spotlightMeta = null;
    renderSpotlightSearchResults();
    return;
  }

  spotlightLoading = true;
  spotlightActiveIndex = 0;
  renderSpotlightSearchResults();

  try {
    const limit = mode === 'semantic' ? 12 : 15;
    const data = await api.post('/api/search', { query: q, mode, limit });
    if (reqId !== spotlightSeq) return;
    const rawResults = Array.isArray(data?.results) ? data.results : [];
    spotlightMeta = {
      mode: data?.mode || mode,
      engine: data?.engine || '',
      provider_label: data?.provider_label || '',
      total: data?.total ?? rawResults.length,
      skipped_private: data?.skipped_private || 0,
    };
    spotlightItems = rawResults.map((r) => ({
      type: 'search-result',
      icon: getFileIconByExt(r.ext || r.path || r.name),
      label: r.name || r.path,
      sub: r.snippet || '',
      payload: r,
    }));
  } catch (err) {
    if (reqId !== spotlightSeq) return;
    spotlightItems = [];
    spotlightMeta = null;
    showToast(err?.message || '全文检索失败', 'error');
  } finally {
    if (reqId === spotlightSeq) {
      spotlightLoading = false;
      spotlightActiveIndex = 0;
      renderSpotlightSearchResults();
    }
  }
}

function renderSpotlightList() {
  if (spotlightMode === 'quick') {
    spotlightLoading = false;
    spotlightMeta = null;
    renderSpotlightSearchResults();
  }
}

function updateSpotlightActiveClass(resultsEl) {
  if (!resultsEl) return;
  const rows = resultsEl.querySelectorAll('.spotlight-item');
  rows.forEach((el, idx) => {
    const active = idx === spotlightActiveIndex;
    el.classList.toggle('is-active', active);
    if (active) {
      el.scrollIntoView({ block: 'nearest' });
    }
  });
}

function switchSpotlightMode(nextMode, { triggerSearch = true } = {}) {
  const valid = SPOTLIGHT_MODES.some((m) => m.id === nextMode) ? nextMode : 'quick';
  spotlightMode = valid;
  spotlightActiveIndex = 0;
  spotlightSeq += 1;
  if (spotlightSearchTimer) {
    window.clearTimeout(spotlightSearchTimer);
    spotlightSearchTimer = null;
  }
  renderSpotlightModeBar();

  const { input } = getSpotlightElements();
  const q = String(input?.value || '').trim();

  if (valid === 'quick') {
    spotlightLoading = false;
    spotlightMeta = null;
    renderSpotlightSearchResults();
  } else if (valid === 'keyword') {
    if (triggerSearch && q) {
      runBackendSearch('keyword', q);
    } else {
      spotlightLoading = false;
      spotlightItems = [];
      spotlightMeta = null;
      renderSpotlightSearchResults();
    }
  } else if (valid === 'semantic') {
    if (triggerSearch && q) {
      runBackendSearch('semantic', q);
    } else {
      spotlightLoading = false;
      spotlightItems = [];
      spotlightMeta = null;
      renderSpotlightSearchResults();
    }
  }
  input?.focus();
}

async function executeSpotlightItem(item) {
  if (!item) return;

  if (item.type === 'cmd' && item.id === 'cmd-semantic-search') {
    switchSpotlightMode('semantic', { triggerSearch: false });
    return;
  }

  closeSpotlight();

  if (item.type === 'search-result') {
    const r = item.payload || {};
    if (r.page) {
      store.emit('anchor:jump', { file: r.name, page: r.page });
      showToast(`已定位至 ${r.name} 第 ${r.page} 页`, 'success', { duration: 2000 });
      return;
    }
    if (r.sheet || r.cell) {
      store.emit('anchor:jump', { file: r.name, sheet: r.sheet || '', cell: r.cell || '' });
      showToast(`已定位至 ${r.name} ${r.sheet ? `${r.sheet}!` : ''}${r.cell || ''}`, 'success', { duration: 2000 });
      return;
    }
    store.emit('file:open', { path: r.path, name: r.name, ext: r.ext });
    showToast(`已打开：${r.name}`, 'info', { duration: 1800 });
    return;
  }

  if (item.type === 'file') {
    openFileObject(item.payload);
    showToast(`已打开：${item.label}`, 'info', { duration: 1800 });
    return;
  }

  if (item.type === 'app') {
    try {
      await api.post('/api/apps/launch', { app_id: item.payload.id });
      showToast(`已启动应用：${item.label}`, 'success');
    } catch (err) {
      showToast(`启动应用失败：${err?.message || '未知错误'}`, 'error');
    }
    return;
  }

  if (item.type === 'workspace') {
    try {
      await api.post('/api/apps/launch', { workspace_id: item.payload.id });
      const files = item.payload?.file_paths || [];
      if (files.length > 0) {
        openFileByPath(files[0]);
      }
      showToast(`已联启工作区：${item.label}`, 'success');
    } catch (err) {
      showToast(`联启工作区失败：${err?.message || '未知错误'}`, 'error');
    }
    return;
  }

  if (item.type === 'cmd') {
    switch (item.id) {
      case 'cmd-new-note': {
        try {
          const created = await api.post('/api/files/create-note', {
            title: '新建笔记',
            content: '# 新建笔记\n\n',
          });
          store.emit('files:updated');
          if (created?.path) openFileObject(created);
          showToast(`已新建笔记：${created?.name || '新建笔记.md'}`, 'success');
        } catch (err) {
          showToast(`新建笔记失败：${err?.message || '未知错误'}`, 'error');
        }
        break;
      }
      case 'cmd-capture-scene':
        openSceneCaptureSheet();
        break;
      case 'cmd-ai-summarize':
        switchToSummaryPanel();
        store.emit('ai:summarize-request', {
          file_path: store.state.activeFile?.path || null,
          text: store.state.activeDocumentText || '',
          autoRun: true,
        });
        break;
      case 'cmd-focus-15s':
        startFocusSession({
          title: store.state.activeFile?.name || '专注演示',
          seconds: 15,
        });
        break;
      case 'cmd-focus-25m':
        startFocusSession({
          title: store.state.activeFile?.name || '深度专注',
          seconds: 1500,
        });
        break;
      case 'cmd-toggle-theme': {
        const next = store.state.theme === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        api.put('/api/system/config', { theme: next }).catch(() => {});
        break;
      }
      case 'cmd-open-settings':
        openSettingsSheet();
        break;
      default:
        break;
    }
  }
}

function openSpotlight(opts = {}) {
  const { overlay, input } = getSpotlightElements();
  if (!overlay) return;
  const requestedMode = typeof opts === 'string' ? opts : opts?.mode;
  spotlightMode = SPOTLIGHT_MODES.some((m) => m.id === requestedMode) ? requestedMode : 'quick';
  spotlightActiveIndex = 0;
  spotlightLoading = false;
  spotlightMeta = null;
  if (input) input.value = typeof opts?.query === 'string' ? opts.query : '';

  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  renderSpotlightModeBar();
  if (spotlightMode === 'quick') {
    renderSpotlightList();
  } else if (input?.value?.trim()) {
    runBackendSearch(spotlightMode, input.value.trim());
  } else {
    spotlightItems = [];
    renderSpotlightSearchResults();
  }
  window.requestAnimationFrame(() => {
    input?.focus();
  });
}

function closeSpotlight() {
  const overlay = document.getElementById('spotlight-overlay');
  if (!overlay) return;
  if (spotlightSearchTimer) {
    window.clearTimeout(spotlightSearchTimer);
    spotlightSearchTimer = null;
  }
  spotlightSeq += 1;
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
}

function bindSpotlightEvents() {
  const { overlay, card, input, resultsEl } = getSpotlightElements();
  if (!overlay || overlay.dataset.bound === '1') return;
  overlay.dataset.bound = '1';

  card?.addEventListener('click', (e) => {
    const modeBtn = e.target.closest('[data-spotlight-mode]');
    if (modeBtn) {
      switchSpotlightMode(modeBtn.dataset.spotlightMode, { triggerSearch: true });
      return;
    }
    if (e.target.closest('#spotlight-semantic-go')) {
      const q = input?.value?.trim() || '';
      if (!q) {
        showToast('请输入自然语言描述后再检索', 'warning');
        input?.focus();
        return;
      }
      runBackendSearch('semantic', q);
    }
  });

  input?.addEventListener('input', () => {
    spotlightActiveIndex = 0;
    const q = String(input.value || '');
    if (spotlightMode === 'quick') {
      renderSpotlightList();
      return;
    }
    if (spotlightMode === 'keyword') {
      if (spotlightSearchTimer) window.clearTimeout(spotlightSearchTimer);
      if (!q.trim()) {
        spotlightSeq += 1;
        spotlightLoading = false;
        spotlightItems = [];
        spotlightMeta = null;
        renderSpotlightSearchResults();
        return;
      }
      spotlightSearchTimer = window.setTimeout(() => {
        runBackendSearch('keyword', q.trim());
      }, 260);
      return;
    }
    if (spotlightMode === 'semantic' && !q.trim()) {
      spotlightSeq += 1;
      spotlightLoading = false;
      spotlightItems = [];
      spotlightMeta = null;
      renderSpotlightSearchResults();
    }
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSpotlight();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (spotlightItems.length > 0) {
        spotlightActiveIndex = (spotlightActiveIndex + 1) % spotlightItems.length;
        updateSpotlightActiveClass(resultsEl);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (spotlightItems.length > 0) {
        spotlightActiveIndex = (spotlightActiveIndex - 1 + spotlightItems.length) % spotlightItems.length;
        updateSpotlightActiveClass(resultsEl);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value?.trim() || '';
      if (spotlightMode === 'keyword' && q && (spotlightLoading || spotlightItems.length === 0)) {
        if (spotlightSearchTimer) window.clearTimeout(spotlightSearchTimer);
        runBackendSearch('keyword', q);
        return;
      }
      if (spotlightMode === 'semantic') {
        if (!spotlightLoading && spotlightItems.length > 0 && spotlightItems[spotlightActiveIndex]) {
          executeSpotlightItem(spotlightItems[spotlightActiveIndex]);
        } else if (q) {
          runBackendSearch('semantic', q);
        }
        return;
      }
      executeSpotlightItem(spotlightItems[spotlightActiveIndex]);
    }
  });

  resultsEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-spotlight-idx]');
    if (!btn) return;
    const idx = Number(btn.dataset.spotlightIdx);
    executeSpotlightItem(spotlightItems[idx]);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeSpotlight();
    }
  });
}

/* --------------------------------------------------------------------------
 * 6. Web Speech API Voice Dictation Sheet
 * -------------------------------------------------------------------------- */

function openVoiceSheet() {
  const SpeechRec =
    typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

  let recognition = null;
  let recording = false;
  let finalBuffer = '';
  let unsubscribeClose = null;

  openSheet({
    title: '语音速记',
    bodyHtml: `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div class="glass-card" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <span style="color:var(--accent);display:inline-flex;">${icon('mic', 16)}</span>
            <span id="voice-status-text" style="font-size:12.5px;color:var(--text-secondary);">
              ${
                SpeechRec
                  ? '点击右侧按钮开始普通话实时语音识别'
                  : '当前浏览器不支持原生语音接口，可直接输入或粘贴文字'
              }
            </span>
          </div>
          ${
            SpeechRec
              ? `<button type="button" id="voice-toggle-btn" class="pill-btn pill-btn-sm pill-btn-primary">🎙 开始录音</button>`
              : ''
          }
        </div>
        <textarea id="voice-transcript" class="apple-textarea" rows="6" placeholder="语音转写文本将实时显示在这里，也可直接手动输入或粘贴内容…"></textarea>
      </div>
    `,
    footerHtml: `
      <button type="button" class="pill-btn" id="voice-ai-btn">✨ AI 提炼待办</button>
      <button type="button" class="pill-btn pill-btn-primary" id="voice-save-btn">📝 存为笔记</button>
    `,
    onMount(card) {
      const textarea = card.querySelector('#voice-transcript');
      const toggleBtn = card.querySelector('#voice-toggle-btn');
      const statusEl = card.querySelector('#voice-status-text');

      const stopRecording = () => {
        recording = false;
        if (recognition) {
          try {
            recognition.stop();
          } catch {
            // ignore
          }
          recognition = null;
        }
        if (toggleBtn) {
          toggleBtn.textContent = '🎙 开始录音';
          toggleBtn.classList.remove('pill-btn-danger');
          toggleBtn.classList.add('pill-btn-primary');
        }
        if (statusEl && SpeechRec) {
          statusEl.textContent = '录音已停止，可继续编辑或直接存入工作台';
        }
      };

      const startRecording = () => {
        if (!SpeechRec) return;
        try {
          recognition = new SpeechRec();
          recognition.lang = 'zh-CN';
          recognition.interimResults = true;
          recognition.continuous = true;
          finalBuffer = textarea?.value ? `${textarea.value.trimEnd()}\n`.trimStart() : '';

          recognition.onresult = (event) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i += 1) {
              const res = event.results[i];
              const transcript = res[0]?.transcript || '';
              if (res.isFinal) {
                finalBuffer += transcript;
              } else {
                interim += transcript;
              }
            }
            if (textarea) {
              textarea.value = finalBuffer + interim;
            }
          };

          recognition.onerror = (evt) => {
            if (evt?.error !== 'aborted') {
              showToast(`语音识别中断：${evt?.error || '请检查麦克风权限'}`, 'warning');
            }
            stopRecording();
          };

          recognition.onend = () => {
            if (recording) {
              stopRecording();
            }
          };

          recognition.start();
          recording = true;
          if (toggleBtn) {
            toggleBtn.textContent = '⏹ 停止录音';
            toggleBtn.classList.remove('pill-btn-primary');
            toggleBtn.classList.add('pill-btn-danger');
          }
          if (statusEl) {
            statusEl.textContent = '正在聆听普通话语音…';
          }
        } catch (err) {
          showToast(`无法启动语音识别：${err?.message || '权限受限'}`, 'warning');
          stopRecording();
        }
      };

      toggleBtn?.addEventListener('click', () => {
        if (recording) stopRecording();
        else startRecording();
      });

      unsubscribeClose = store.on('sheet:closed', () => {
        stopRecording();
        unsubscribeClose?.();
      });

      card.querySelector('#voice-ai-btn')?.addEventListener('click', () => {
        const text = textarea?.value?.trim() || '';
        if (!text) {
          showToast('请先录制或输入文本内容', 'warning');
          return;
        }
        stopRecording();
        closeSheet();
        switchToSummaryPanel();
        store.emit('ai:summarize-request', { text, autoRun: true });
      });

      card.querySelector('#voice-save-btn')?.addEventListener('click', async () => {
        const text = textarea?.value?.trim() || '';
        if (!text) {
          showToast('请先录制或输入文本内容', 'warning');
          return;
        }
        stopRecording();
        const title = `语音速记_${text.slice(0, 12)}`;
        try {
          const created = await api.post('/api/files/create-note', { title, content: text });
          store.emit('files:updated');
          closeSheet();
          if (created?.path) openFileObject(created);
          showToast(`已存为本地笔记：${created?.name || title}`, 'success');
        } catch (err) {
          showToast(`保存笔记失败：${err?.message || '未知错误'}`, 'error');
        }
      });
    },
  });
}

/* --------------------------------------------------------------------------
 * 7. Settings & LAN Access Sheet (V2: Free Basic AI Presets + Zero-Key Toggle + Font Size)
 * -------------------------------------------------------------------------- */

async function openSettingsSheet() {
  const [cfgResult, infoResult] = await Promise.allSettled([
    api.get('/api/system/config'),
    api.get('/api/system/info'),
  ]);

  const cfg = cfgResult.status === 'fulfilled' && cfgResult.value ? cfgResult.value : store.state.config || {};
  const info = infoResult.status === 'fulfilled' && infoResult.value ? infoResult.value : store.state.systemInfo || {};

  if (cfg && typeof cfg === 'object') store.setState({ config: cfg });
  if (info && typeof info === 'object') store.setState({ systemInfo: info }, 'system:info');

  const lanUrl = info?.ip && info?.port ? `http://${info.ip}:${info.port}` : window.location.origin;
  const aiCfg = cfg.ai || {};
  const aiPresets = Array.isArray(info?.ai_presets) && info.ai_presets.length > 0 ? info.ai_presets : DEFAULT_AI_PRESETS;
  const freeAiEnabled =
    aiCfg.enable_free_ai !== undefined ? Boolean(aiCfg.enable_free_ai) : info?.free_ai_enabled !== false;
  const currentTheme = store.state.theme || cfg.theme || 'light';
  const initialFontSize = Math.min(24, Math.max(12, Number(cfg.doc_font_size || store.state.docFontSize || 15)));
  const xlsxFiles = getXlsxFiles();
  const currentDefaultExcel = cfg.default_progress_excel || '';
  const hasCurrentInList = xlsxFiles.some((f) => f.path === currentDefaultExcel);
  const whitelistText = Array.isArray(cfg.whitelist_dirs) ? cfg.whitelist_dirs.join('\n') : '';

  const excelOptions = [
    `<option value="">不指定（自动选择首个表格）</option>`,
    ...xlsxFiles.map((f) => {
      const label = f.name || f.path.split(/[\\/]/).pop() || f.path;
      return `<option value="${escapeHtml(f.path)}" ${f.path === currentDefaultExcel ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }),
  ];
  if (currentDefaultExcel && !hasCurrentInList) {
    excelOptions.push(
      `<option value="${escapeHtml(currentDefaultExcel)}" selected>${escapeHtml(currentDefaultExcel)}</option>`
    );
  }

  openSheet({
    title: '系统与 AI 设置',
    bodyHtml: `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div class="glass-card" style="display:flex;flex-direction:column;gap:8px;border-color:var(--accent);background:var(--accent-soft);">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <span style="font-size:12.5px;font-weight:600;color:var(--accent);">${icon('sparkles', 14)} 一键切换免费 / 常用 AI 预设</span>
            <span style="font-size:11px;color:var(--text-secondary);">点击即自动填充接入参数</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;" id="cfg-preset-grid">
            ${aiPresets
              .map(
                (p) => `
                <button
                  type="button"
                  class="pill-btn pill-btn-sm"
                  data-preset-id="${escapeHtml(p.id)}"
                  style="height:28px;font-size:12px;background:var(--bg-island);"
                >${escapeHtml(p.name || p.label || p.id)}</button>
              `
              )
              .join('')}
          </div>
          <div id="cfg-preset-hint" style="display:none;font-size:11.5px;color:var(--text-primary);padding:7px 9px;border-radius:10px;background:var(--bg-island);border:1px solid var(--border-hairline);"></div>
        </div>

        <label class="glass-card" style="display:flex;align-items:flex-start;gap:9px;padding:10px 12px;cursor:pointer;">
          <input type="checkbox" id="cfg-enable-free-ai" class="file-check" style="margin-top:2px;" ${freeAiEnabled ? 'checked' : ''} />
          <span style="font-size:12.5px;line-height:1.45;color:var(--text-primary);">
            <strong>开启免 Key 免费基础 AI</strong>（未填 API Key 时自动提供基础 AI 总结、问答与语义检索）
          </span>
        </label>

        <div class="glass-card" style="display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <span style="font-size:12.5px;font-weight:600;color:var(--text-primary);">${icon('globe', 14)} 手机端局域网直连</span>
            <span style="font-size:11.5px;color:var(--text-secondary);">添加到手机主屏幕可当原生 App 使用</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <code style="padding:5px 10px;border-radius:9999px;background:var(--accent-soft);color:var(--accent);font-family:var(--font-mono);font-size:12.5px;font-weight:600;">${escapeHtml(lanUrl)}</code>
            <button type="button" class="pill-btn pill-btn-sm" id="cfg-copy-lan">${icon('copy', 13)} 复制局域网地址</button>
          </div>
          <div style="display:flex;gap:12px;font-size:11.5px;color:var(--text-tertiary);flex-wrap:wrap;">
            <span>平台：${escapeHtml(info.platform || navigator.platform || 'Local')}</span>
            <span>AI 状态：${info.ai_configured ? '已配置 API Key' : freeAiEnabled ? '免 Key 免费基础 AI 已就绪' : '本地规则引擎'}</span>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">外观主题</label>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button type="button" class="pill-btn pill-btn-sm ${currentTheme === 'light' ? 'pill-btn-primary' : ''}" data-set-theme="light">
                ${icon('sun', 13)} 浅色
              </button>
              <button type="button" class="pill-btn pill-btn-sm ${currentTheme === 'dark' ? 'pill-btn-primary' : ''}" data-set-theme="dark">
                ${icon('moon', 13)} 深色
              </button>
            </div>
          </div>

          <div>
            <label for="cfg-doc-font-size" style="display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">
              <span>默认文档字号</span>
              <span id="cfg-doc-font-val" style="color:var(--accent);font-family:var(--font-mono);">${initialFontSize}px</span>
            </label>
            <div style="display:flex;align-items:center;gap:6px;">
              <button type="button" class="icon-pill" id="cfg-font-dec" style="width:28px;height:28px;font-size:13px;" title="减小字号">A-</button>
              <input id="cfg-doc-font-size" type="range" min="12" max="24" step="1" value="${initialFontSize}" style="flex:1;min-width:60px;" />
              <button type="button" class="icon-pill" id="cfg-font-inc" style="width:28px;height:28px;font-size:13px;" title="增大字号">A+</button>
            </div>
          </div>
        </div>

        <div>
          <label for="cfg-base-url" style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">AI Base URL</label>
          <input id="cfg-base-url" class="apple-input" type="text" value="${escapeHtml(aiCfg.base_url || 'https://dashscope.aliyuncs.com/compatible-mode/v1')}" />
        </div>

        <div>
          <label for="cfg-api-key" style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">AI API Key</label>
          <input id="cfg-api-key" class="apple-input" type="password" placeholder="留空则使用免 Key 免费基础 AI 或本地规则提取" value="${escapeHtml(aiCfg.api_key || '')}" />
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <label for="cfg-model" style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Model Name</label>
            <input id="cfg-model" class="apple-input" type="text" value="${escapeHtml(aiCfg.model || 'qwen-plus')}" />
          </div>
          <div>
            <label for="cfg-web-search-param" style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Web Search Param</label>
            <input id="cfg-web-search-param" class="apple-input" type="text" value="${escapeHtml(aiCfg.web_search_param ?? 'enable_search')}" />
          </div>
        </div>

        <div>
          <label for="cfg-notes-dir" style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Default Notes Dir</label>
          <input id="cfg-notes-dir" class="apple-input" type="text" value="${escapeHtml(cfg.default_notes_dir || './data/notes')}" />
        </div>

        <div>
          <label for="cfg-default-excel" style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Default Progress Excel</label>
          <select id="cfg-default-excel" class="apple-select">${excelOptions.join('')}</select>
        </div>

        <div>
          <label for="cfg-whitelist-dirs" style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Whitelist Dirs（每行一个路径）</label>
          <textarea id="cfg-whitelist-dirs" class="apple-textarea" rows="3" placeholder="/path/to/study-docs">${escapeHtml(whitelistText)}</textarea>
        </div>
      </div>
    `,
    footerHtml: `
      <button type="button" class="pill-btn" id="cfg-cancel">取消</button>
      <button type="button" class="pill-btn pill-btn-primary" id="cfg-save">保存配置</button>
    `,
    onMount(card) {
      const baseUrlInput = card.querySelector('#cfg-base-url');
      const apiKeyInput = card.querySelector('#cfg-api-key');
      const modelInput = card.querySelector('#cfg-model');
      const searchParamInput = card.querySelector('#cfg-web-search-param');
      const freeAiChk = card.querySelector('#cfg-enable-free-ai');
      const presetHintEl = card.querySelector('#cfg-preset-hint');
      const fontSlider = card.querySelector('#cfg-doc-font-size');
      const fontValLabel = card.querySelector('#cfg-doc-font-val');

      const updateFontPreview = (val) => {
        const clamped = applyDocTypographySafe(val);
        if (fontSlider) fontSlider.value = String(clamped);
        if (fontValLabel) fontValLabel.textContent = `${clamped}px`;
      };

      fontSlider?.addEventListener('input', () => updateFontPreview(fontSlider.value));
      card.querySelector('#cfg-font-dec')?.addEventListener('click', () => {
        updateFontPreview((Number(fontSlider?.value) || 15) - 1);
      });
      card.querySelector('#cfg-font-inc')?.addEventListener('click', () => {
        updateFontPreview((Number(fontSlider?.value) || 15) + 1);
      });

      card.querySelector('#cfg-preset-grid')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-preset-id]');
        if (!btn) return;
        const preset = aiPresets.find((p) => p.id === btn.dataset.presetId);
        if (!preset) return;

        card.querySelectorAll('[data-preset-id]').forEach((b) => {
          b.classList.toggle('pill-btn-primary', b === btn);
          b.style.background = b === btn ? '' : 'var(--bg-island)';
        });

        if (baseUrlInput && preset.base_url !== undefined) baseUrlInput.value = preset.base_url;
        if (modelInput && preset.model !== undefined) modelInput.value = preset.model;
        if (searchParamInput && preset.web_search_param !== undefined) {
          searchParamInput.value = preset.web_search_param;
        }
        if (freeAiChk) {
          if (preset.needs_key === false) {
            freeAiChk.checked = true;
            if (apiKeyInput) apiKeyInput.value = '';
          } else if (!apiKeyInput?.value?.trim()) {
            apiKeyInput?.focus();
          }
        }

        if (presetHintEl) {
          const docLinkHtml = preset.doc_url
            ? ` <a href="${escapeHtml(preset.doc_url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-weight:600;text-decoration:underline;margin-left:4px;">获取免费 Key ↗</a>`
            : '';
          presetHintEl.innerHTML = `${escapeHtml(preset.hint || `已填入 ${preset.name} 参数`)}${docLinkHtml}`;
          presetHintEl.style.display = 'block';
        }
      });

      card.querySelector('#cfg-copy-lan')?.addEventListener('click', () => {
        copyInternal(lanUrl, `已复制局域网地址：${lanUrl}`);
      });

      card.querySelectorAll('[data-set-theme]').forEach((btn) => {
        btn.addEventListener('click', () => {
          applyTheme(btn.dataset.setTheme);
          card.querySelectorAll('[data-set-theme]').forEach((b) => {
            b.classList.toggle('pill-btn-primary', b.dataset.setTheme === store.state.theme);
          });
        });
      });

      card.querySelector('#cfg-cancel')?.addEventListener('click', closeSheet);

      card.querySelector('#cfg-save')?.addEventListener('click', async () => {
        const saveBtn = card.querySelector('#cfg-save');
        if (saveBtn) saveBtn.disabled = true;

        const rawDirs = card.querySelector('#cfg-whitelist-dirs')?.value || '';
        const whitelistDirs = rawDirs
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);

        const docFontSize = Math.min(24, Math.max(12, Number(fontSlider?.value) || 15));
        const rawBaseUrl = baseUrlInput?.value?.trim() ?? '';
        const payload = {
          theme: store.state.theme,
          doc_font_size: docFontSize,
          ai: {
            base_url: rawBaseUrl,
            api_key: apiKeyInput?.value?.trim() || '',
            model: modelInput?.value?.trim() || 'qwen-plus',
            web_search_param: searchParamInput?.value?.trim() || '',
            enable_free_ai: Boolean(freeAiChk?.checked),
          },
          default_notes_dir: card.querySelector('#cfg-notes-dir')?.value?.trim() || './data/notes',
          default_progress_excel: card.querySelector('#cfg-default-excel')?.value?.trim() || '',
          whitelist_dirs: whitelistDirs,
        };

        try {
          const updated = await api.put('/api/system/config', payload);
          applyDocTypographySafe(updated?.doc_font_size ?? docFontSize);
          store.setState({ config: updated }, 'config:changed');
          store.emit('config:changed', updated);
          store.emit('files:updated');
          closeSheet();
          showToast('系统与 AI 配置已保存', 'success');
        } catch (err) {
          showToast(`保存配置失败：${err?.message || '未知错误'}`, 'error');
        } finally {
          if (saveBtn) saveBtn.disabled = false;
        }
      });
    },
  });
}

/* --------------------------------------------------------------------------
 * 8. Public Init
 * -------------------------------------------------------------------------- */

export function initSpotlight() {
  if (initialized) return;
  initialized = true;

  const islandEl = document.getElementById('dynamic-island');
  if (islandEl) {
    renderDynamicIsland(islandEl, store.state.island);

    store.on('island:update', (nextState) => {
      renderDynamicIsland(islandEl, nextState);
    });

    store.on('file:opened', () => {
      if (store.state.island?.mode === 'idle') {
        renderDynamicIsland(islandEl, store.state.island);
      }
    });

    islandEl.addEventListener('mouseenter', () => {
      sniffHovered = true;
      if (store.state.island?.mode === 'sniff') {
        if (sniffDeadline > Date.now()) {
          sniffRemainingMs = Math.max(0, sniffDeadline - Date.now());
        }
        clearSniffTimer();
      }
    });

    islandEl.addEventListener('mouseleave', () => {
      sniffHovered = false;
      if (store.state.island?.mode === 'sniff') {
        const resumeMs = Math.max(2000, sniffRemainingMs || 2000);
        scheduleSniffAutoHide(resumeMs);
      }
    });

    islandEl.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-island-action]');
      if (!actionBtn) {
        if (store.state.island?.mode === 'idle') {
          openSpotlight();
        }
        return;
      }
      handleIslandAction(islandEl, actionBtn.dataset.islandAction);
    });

    islandEl.addEventListener('keydown', (e) => {
      if (e.target?.id === 'island-done-input' && e.key === 'Enter') {
        e.preventDefault();
        submitFocusDoneToExcel(islandEl);
      }
    });
  }

  // Focus countdown EventBus channel
  store.on('focus:start', (payload) => {
    startFocusSession(payload || {});
  });

  // Spotlight binding & global Ctrl+K / Cmd+K shortcut
  bindSpotlightEvents();
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const overlay = document.getElementById('spotlight-overlay');
      if (overlay && !overlay.hidden) {
        closeSpotlight();
      } else {
        openSpotlight();
      }
    }
  });

  document.getElementById('btn-spotlight')?.addEventListener('click', () => openSpotlight());
  document.getElementById('btn-voice-quick')?.addEventListener('click', openVoiceSheet);
  document.getElementById('btn-settings')?.addEventListener('click', openSettingsSheet);

  store.on('spotlight:open', openSpotlight);
  store.on('voice:open', openVoiceSheet);
  store.on('settings:open', openSettingsSheet);

  // Innovation 3: Focus-only clipboard sniffing (zero polling)
  window.addEventListener('focus', handleWindowFocus);
}
