/**
 * SmartLocalNote - Lightweight Reactive Store, EventBus, Island State Machine & Safe Helpers
 * Zero external dependencies. Panels communicate strictly via store EventBus.
 */

import { icon } from './icons.js';

const THEME_STORAGE_KEY = 'sln_theme';
const DOC_FONT_SIZE_KEY = 'sln_doc_font_size';
const DOC_FONT_FAMILY_KEY = 'sln_doc_font_family';
const PANE_WIDTHS_KEY = 'sln_pane_widths';
const UI_LAYOUT_KEY = 'sln_ui_layout';
const RECENT_FILES_KEY = 'sln_recent_files';
const AUTO_SAVE_KEY = 'sln_auto_save';
const LEFT_SORT_KEY = 'sln_left_file_sort';
const LEGACY_LEFT_SORT_KEY = 'sln_left_sort';
const DRAG_SHELF_KEY = 'sln_drag_shelf_v1';
const MAX_CONTEXT_FILES = 20;
const MAX_TOASTS = 3;
const MAX_RECENT_FILES = 8;
const MAX_SHELF_ITEMS = 30;

export const DRAG_MIME = 'application/x-smartlocalnote-block';

const DEFAULT_UI_LAYOUT = {
  leftModules: [
    { id: 'files', title: '本地文件', visible: true, collapsed: false },
    { id: 'workspaces', title: '场景工作区', visible: true, collapsed: false },
    { id: 'apps', title: '办公软件直达', visible: true, collapsed: false },
    { id: 'tree', title: '虚拟知识树', visible: true, collapsed: false },
    { id: 'quick_scratch', title: '灵感便签（可拖入笔记）', visible: false, collapsed: false },
    { id: 'recent_files', title: '最近打开', visible: false, collapsed: false },
    { id: 'pomodoro_mini', title: '快捷专注', visible: false, collapsed: false },
  ],
  rightTabsOrder: ['summary', 'chat', 'tools'],
  rightSummaryModules: [
    { id: 'input', title: '随手速记区', visible: true },
    { id: 'summary_card', title: 'AI 摘要与待办', visible: true },
    { id: 'reminders', title: '定时提醒', visible: true },
    { id: 'ai_templates', title: 'AI 常用指令模板', visible: false },
  ],
  rightToolModules: [
    { id: 'quick_excel', title: '快捷表单填表与表格操作', visible: true },
    { id: 'knowledge_tree', title: '虚拟知识树分类管理', visible: true },
    { id: 'apps_workspaces', title: '本地软件库与工作区联启', visible: true },
    { id: 'ai_templates', title: 'AI 常用指令模板', visible: false },
  ],
  scratchpadText: '',
  moduleHeights: {},
};

const listeners = new Map();

function cloneDefaultUiLayout() {
  return {
    leftModules: DEFAULT_UI_LAYOUT.leftModules.map((m) => ({ ...m })),
    rightTabsOrder: [...DEFAULT_UI_LAYOUT.rightTabsOrder],
    rightSummaryModules: DEFAULT_UI_LAYOUT.rightSummaryModules.map((m) => ({ ...m })),
    rightToolModules: DEFAULT_UI_LAYOUT.rightToolModules.map((m) => ({ ...m })),
    scratchpadText: DEFAULT_UI_LAYOUT.scratchpadText,
    moduleHeights: {},
  };
}

function mergeModuleList(savedList, defaultList) {
  const defaultMap = new Map(defaultList.map((m) => [m.id, m]));
  const result = [];
  const seen = new Set();

  if (Array.isArray(savedList)) {
    for (const item of savedList) {
      if (!item || typeof item !== 'object' || !defaultMap.has(item.id) || seen.has(item.id)) continue;
      const base = defaultMap.get(item.id);
      result.push({
        ...base,
        ...item,
        id: base.id,
        title: typeof item.title === 'string' && item.title ? item.title : base.title,
        visible: typeof item.visible === 'boolean' ? item.visible : base.visible,
        ...(typeof base.collapsed === 'boolean'
          ? { collapsed: typeof item.collapsed === 'boolean' ? item.collapsed : base.collapsed }
          : {}),
      });
      seen.add(base.id);
    }
  }

  for (const def of defaultList) {
    if (!seen.has(def.id)) {
      result.push({ ...def });
    }
  }
  return result;
}

function normalizeModuleHeights(rawHeights) {
  const result = {};
  if (!rawHeights || typeof rawHeights !== 'object') return result;
  for (const [key, val] of Object.entries(rawHeights)) {
    if (!key) continue;
    const num = Number(val);
    if (Number.isFinite(num)) {
      result[key] = clampNumber(num, 100, 640, 240);
    }
  }
  return result;
}

function normalizeUiLayout(raw) {
  const def = cloneDefaultUiLayout();
  if (!raw || typeof raw !== 'object') return def;

  const validTabs = new Set(def.rightTabsOrder);
  const savedOrder = Array.isArray(raw.rightTabsOrder)
    ? raw.rightTabsOrder.filter((t, i, arr) => validTabs.has(t) && arr.indexOf(t) === i)
    : [];
  for (const t of def.rightTabsOrder) {
    if (!savedOrder.includes(t)) savedOrder.push(t);
  }

  return {
    leftModules: mergeModuleList(raw.leftModules, def.leftModules),
    rightTabsOrder: savedOrder,
    rightSummaryModules: mergeModuleList(raw.rightSummaryModules, def.rightSummaryModules),
    rightToolModules: mergeModuleList(raw.rightToolModules, def.rightToolModules),
    scratchpadText: typeof raw.scratchpadText === 'string' ? raw.scratchpadText : def.scratchpadText,
    moduleHeights: normalizeModuleHeights(raw.moduleHeights),
  };
}

function loadInitialTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // ignore storage errors
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function loadInitialAutoSaveOnSwitch() {
  try {
    const saved = localStorage.getItem(AUTO_SAVE_KEY);
    if (saved === 'true' || saved === '1') return true;
    if (saved === 'false' || saved === '0') return false;
  } catch {
    // ignore storage errors
  }
  return false;
}

function normalizeLeftSortBy(rawBy) {
  const val = String(rawBy || '').trim().toLowerCase();
  if (val === 'time') return 'mtime';
  if (val === 'type') return 'ext';
  return ['name', 'mtime', 'ext', 'size'].includes(val) ? val : 'name';
}

function loadInitialLeftSort() {
  try {
    const raw = localStorage.getItem(LEFT_SORT_KEY) || localStorage.getItem(LEGACY_LEFT_SORT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const by = normalizeLeftSortBy(parsed?.by);
      const dir = parsed?.dir === 'desc' ? 'desc' : 'asc';
      return { by, dir };
    }
  } catch {
    // ignore storage errors
  }
  return { by: 'name', dir: 'asc' };
}

function loadInitialShelfItems() {
  try {
    const raw = localStorage.getItem(DRAG_SHELF_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item) => item && typeof item === 'object' && typeof item.markdown === 'string' && item.markdown.trim())
          .slice(0, MAX_SHELF_ITEMS);
      }
    }
  } catch {
    // ignore storage errors
  }
  return [];
}

function clampNumber(val, min, max, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function loadInitialDocFontSize() {
  try {
    const saved = localStorage.getItem(DOC_FONT_SIZE_KEY);
    if (saved !== null) return clampNumber(saved, 12, 24, 15);
  } catch {
    // ignore storage errors
  }
  return 15;
}

function loadInitialDocFontFamily() {
  try {
    const saved = localStorage.getItem(DOC_FONT_FAMILY_KEY);
    if (saved === 'sans' || saved === 'serif' || saved === 'mono') return saved;
  } catch {
    // ignore storage errors
  }
  return 'sans';
}

function loadInitialPaneWidths() {
  try {
    const raw = localStorage.getItem(PANE_WIDTHS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        left: clampNumber(parsed?.left, 200, 480, 260),
        right: clampNumber(parsed?.right, 280, 560, 360),
      };
    }
  } catch {
    // ignore storage errors
  }
  return { left: 260, right: 360 };
}

function loadInitialUiLayout() {
  try {
    const raw = localStorage.getItem(UI_LAYOUT_KEY);
    if (raw) return normalizeUiLayout(JSON.parse(raw));
  } catch {
    // ignore storage errors
  }
  return cloneDefaultUiLayout();
}

function loadInitialRecentFiles() {
  try {
    const raw = localStorage.getItem(RECENT_FILES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.slice(0, MAX_RECENT_FILES);
    }
  } catch {
    // ignore storage errors
  }
  return [];
}

export const store = {
  state: {
    theme: loadInitialTheme(),
    autoSaveOnSwitch: loadInitialAutoSaveOnSwitch(),
    docFontSize: loadInitialDocFontSize(),
    docFontFamily: loadInitialDocFontFamily(),
    paneWidths: loadInitialPaneWidths(),
    recentFiles: loadInitialRecentFiles(),
    uiLayout: loadInitialUiLayout(),
    leftFileSort: loadInitialLeftSort(),
    leftFileFilter: '',
    shelfItems: loadInitialShelfItems(),
    activeDragPayload: null,
    systemInfo: null,
    config: {},
    files: { items: [], dirs: [], private_files: [] },
    activeFile: null,
    activeDocumentText: '',
    selectedContextPaths: [],
    apps: [],
    workspaces: [],
    tree: { nodes: [] },
    reminders: [],
    leftCollapsed: false,
    rightCollapsed: false,
    mobileTab: 'doc',
    rightMode: 'summary',
    island: { mode: 'idle', data: {} },
    focus: {
      active: false,
      paused: false,
      taskTitle: '',
      totalSec: 1500,
      remainingSec: 1500,
      targetExcel: '',
    },
    internalCopyText: '',
  },

  /**
   * Subscribe to an EventBus channel.
   * @param {string} event
   * @param {(payload: any) => void} handler
   * @returns {() => void} unsubscribe function
   */
  on(event, handler) {
    if (typeof handler !== 'function') return () => {};
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    const set = listeners.get(event);
    set.add(handler);
    return () => store.off(event, handler);
  },

  /**
   * Unsubscribe from an EventBus channel.
   * @param {string} event
   * @param {(payload: any) => void} handler
   */
  off(event, handler) {
    const set = listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      listeners.delete(event);
    }
  },

  /**
   * Emit an EventBus event.
   * @param {string} event
   * @param {any} [payload]
   */
  emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[store.emit:${event}] handler error:`, err);
      }
    }
  },

  /**
   * Patch reactive state and notify subscribers.
   * Accepts a partial object or an updater function `(prevState) => partial`.
   * @param {object | ((state: any) => object)} patch
   * @param {string} [eventName]
   */
  setState(patch, eventName) {
    const nextPatch = typeof patch === 'function' ? patch(store.state) : patch;
    if (!nextPatch || typeof nextPatch !== 'object') return store.state;
    Object.assign(store.state, nextPatch);
    store.emit('state:changed', { keys: Object.keys(nextPatch), state: store.state });
    if (eventName) {
      store.emit(eventName, store.state);
    }
    return store.state;
  },

  addToShelf(payload) {
    return addToShelf(payload);
  },

  removeFromShelf(id) {
    return removeFromShelf(id);
  },

  clearShelf() {
    return clearShelf();
  },
};

/**
 * Escape HTML special characters safely.
 * @param {any} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Persist autoSaveOnSwitch setting to store & localStorage.
 * @param {boolean} enabled
 * @returns {boolean}
 */
export function setAutoSaveOnSwitch(enabled) {
  const next = Boolean(enabled);
  store.state.autoSaveOnSwitch = next;
  try {
    localStorage.setItem(AUTO_SAVE_KEY, next ? 'true' : 'false');
  } catch {
    // ignore storage errors
  }
  store.emit('autosave:changed', next);
  return next;
}

/**
 * Splice a Markdown block cleanly at a 0-based line index with precision 1-blank-line padding.
 * Guarantees no leading blank lines at start of file and collapses 3+ consecutive newlines around insertion to \n\n.
 * @param {string} source
 * @param {number | null | undefined} insertLineIdx
 * @param {string} blockText
 * @returns {string}
 */
export function insertMarkdownWithPadding(source, insertLineIdx, blockText) {
  const normalizedSource = String(source ?? '').replace(/\r\n/g, '\n');
  const trimmedBlock = String(blockText ?? '').replace(/\r\n/g, '\n').trim();
  if (!trimmedBlock) return normalizedSource;

  if (!normalizedSource.trim()) {
    return `${trimmedBlock}\n`;
  }

  const lines = normalizedSource.split('\n');
  const rawIdx = insertLineIdx === null || insertLineIdx === undefined || Number.isNaN(Number(insertLineIdx))
    ? lines.length
    : Number(insertLineIdx);
  const clampedIdx = Math.max(0, Math.min(lines.length, Math.trunc(rawIdx)));

  const before = lines.slice(0, clampedIdx).join('\n').replace(/\n+$/g, '');
  const after = lines.slice(clampedIdx).join('\n').replace(/^\n+/g, '');

  const parts = [];
  if (before.trim()) {
    parts.push(before);
  }
  parts.push(trimmedBlock);
  if (after.trim()) {
    parts.push(after);
  }

  let result = parts.join('\n\n').replace(/^\n+/, '');
  if (!result.endsWith('\n')) {
    result += '\n';
  }
  return result;
}

/**
 * Splice a Markdown block cleanly at a character index (e.g. textarea cursor position)
 * with precision 1-blank-line padding above and below.
 * @param {string} source
 * @param {number} charIdx
 * @param {string} blockText
 * @returns {{ text: string, cursor: number }}
 */
export function insertMarkdownAtCharIndex(source, charIdx, blockText) {
  const normalizedSource = String(source ?? '').replace(/\r\n/g, '\n');
  const trimmedBlock = String(blockText ?? '').replace(/\r\n/g, '\n').trim();
  if (!trimmedBlock) {
    const pos = Math.max(0, Math.min(normalizedSource.length, Number(charIdx) || 0));
    return { text: normalizedSource, cursor: pos };
  }

  if (!normalizedSource.trim()) {
    const text = `${trimmedBlock}\n`;
    return { text, cursor: trimmedBlock.length };
  }

  const rawPos = Number.isFinite(Number(charIdx)) ? Number(charIdx) : normalizedSource.length;
  const clampedPos = Math.max(0, Math.min(normalizedSource.length, Math.trunc(rawPos)));

  const before = normalizedSource.slice(0, clampedPos).replace(/\n+$/g, '');
  const after = normalizedSource.slice(clampedPos).replace(/^\n+/g, '');

  let prefix = '';
  if (before.trim()) {
    prefix = `${before}\n\n`;
  }
  const suffix = after.trim() ? `\n\n${after}` : '\n';
  const text = `${prefix}${trimmedBlock}${suffix}`.replace(/^\n+/, '');
  const cursor = Math.min(text.length, prefix.length + trimmedBlock.length);

  return { text, cursor };
}

function getOrCreateToastStack() {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.className = 'toast-stack';
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  return stack;
}

/**
 * Render Sonner-like stacked pill toast (max 3 visible).
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type='info']
 * @param {{ duration?: number, actionLabel?: string, onAction?: () => void }} [opts={}]
 */
export function showToast(message, type = 'info', opts = {}) {
  if (typeof document === 'undefined') return null;
  const stack = getOrCreateToastStack();
  const duration = Number.isFinite(opts.duration) ? opts.duration : 3200;

  const dismissToast = (el) => {
    if (!el || el.dataset.closing === '1') return;
    el.dataset.closing = '1';
    el.classList.remove('is-visible');
    el.classList.add('is-leaving');
    window.setTimeout(() => {
      el.remove();
    }, 240);
  };

  // Enforce max 3 stacked toasts
  const activeToasts = Array.from(stack.children).filter((c) => c.dataset.closing !== '1');
  while (activeToasts.length >= MAX_TOASTS) {
    const oldest = activeToasts.shift();
    dismissToast(oldest);
  }

  const toast = document.createElement('div');
  const safeType = ['info', 'success', 'warning', 'error'].includes(type) ? type : 'info';
  toast.className = `toast-item toast-pill toast-${safeType}`;
  toast.dataset.type = safeType;
  toast.setAttribute('role', 'status');

  const actionHtml = opts.actionLabel
    ? `<button type="button" class="toast-action pill-btn pill-btn-sm">${escapeHtml(opts.actionLabel)}</button>`
    : '';

  toast.innerHTML = `
    <span class="toast-dot" aria-hidden="true"></span>
    <span class="toast-text">${escapeHtml(message)}</span>
    ${actionHtml}
  `;

  if (opts.actionLabel && typeof opts.onAction === 'function') {
    const btn = toast.querySelector('.toast-action');
    btn?.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onAction();
      dismissToast(toast);
    });
  }

  toast.addEventListener('click', () => dismissToast(toast));
  stack.appendChild(toast);

  window.requestAnimationFrame(() => {
    toast.classList.add('is-visible');
  });

  if (duration > 0) {
    window.setTimeout(() => dismissToast(toast), duration);
  }

  return toast;
}

/**
 * Update Dynamic Island state machine and emit 'island:update'.
 * @param {'idle'|'sniff'|'focus'|'focus-done'|'alert'} mode
 * @param {object} [data={}]
 */
export function setIsland(mode, data = {}) {
  const validModes = ['idle', 'sniff', 'focus', 'focus-done', 'alert'];
  const nextMode = validModes.includes(mode) ? mode : 'idle';
  const nextIsland = { mode: nextMode, data: { ...(data || {}) } };
  store.state.island = nextIsland;
  store.emit('island:update', nextIsland);
  return nextIsland;
}

/**
 * Copy text to clipboard while recording internalCopyText so clipboard sniffing ignores self-copies.
 * @param {string} text
 * @param {boolean | string | { toast?: boolean, message?: string }} [toastOpt=false]
 * @returns {Promise<boolean>}
 */
export async function copyInternal(text, toastOpt = false) {
  const value = String(text ?? '');
  store.state.internalCopyText = value;

  let ok = false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      ok = true;
    }
  } catch {
    ok = false;
  }

  if (!ok && typeof document !== 'undefined') {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch {
      ok = false;
    }
  }

  const shouldToast =
    toastOpt === true ||
    typeof toastOpt === 'string' ||
    (toastOpt && typeof toastOpt === 'object' && toastOpt.toast !== false);

  if (shouldToast) {
    const msg =
      typeof toastOpt === 'string'
        ? toastOpt
        : toastOpt?.message || (ok ? '已复制到剪贴板' : '复制失败，请手动复制');
    showToast(msg, ok ? 'success' : 'warning', { duration: 2200 });
  }

  return ok;
}

let activeSheetEscHandler = null;

function getOrCreateSheetOverlay() {
  let overlay = document.getElementById('sheet-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'sheet-overlay';
    overlay.className = 'sheet-overlay hidden';
    document.body.appendChild(overlay);
  }
  return overlay;
}

/**
 * Close the modal / mobile bottom sheet.
 */
export function closeSheet() {
  const overlay = document.getElementById('sheet-overlay');
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.classList.add('hidden');
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = '';
  if (activeSheetEscHandler) {
    document.removeEventListener('keydown', activeSheetEscHandler);
    activeSheetEscHandler = null;
  }
  store.emit('sheet:closed');
}

/**
 * Open a responsive Apple modal (Desktop) / Bottom Sheet (Mobile).
 * @param {{ title?: string, bodyHtml?: string, footerHtml?: string, onMount?: (root: HTMLElement) => void }} opts
 */
export function openSheet({ title = '', bodyHtml = '', footerHtml = '', onMount } = {}) {
  const overlay = getOrCreateSheetOverlay();

  overlay.innerHTML = `
    <div class="sheet-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="sheet-grabber" aria-hidden="true"></div>
      <div class="sheet-header">
        <h3 class="sheet-title">${escapeHtml(title)}</h3>
        <button type="button" class="icon-pill sheet-close-btn" aria-label="关闭">
          ${icon('x', 16)}
        </button>
      </div>
      <div class="sheet-body">${bodyHtml}</div>
      ${footerHtml ? `<div class="sheet-footer">${footerHtml}</div>` : ''}
    </div>
  `;

  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  overlay.classList.remove('hidden');
  window.requestAnimationFrame(() => {
    overlay.classList.add('is-open');
  });

  const card = overlay.querySelector('.sheet-card');
  const closeBtn = overlay.querySelector('.sheet-close-btn');
  closeBtn?.addEventListener('click', () => closeSheet());

  overlay.onclick = (e) => {
    if (e.target === overlay) {
      closeSheet();
    }
  };

  if (activeSheetEscHandler) {
    document.removeEventListener('keydown', activeSheetEscHandler);
  }
  activeSheetEscHandler = (e) => {
    if (e.key === 'Escape') {
      closeSheet();
    }
  };
  document.addEventListener('keydown', activeSheetEscHandler);

  if (typeof onMount === 'function' && card) {
    try {
      onMount(card);
    } catch (err) {
      console.error('[openSheet] onMount error:', err);
    }
  }

  return card;
}

/**
 * Toggle a file path in selectedContextPaths (max 20).
 * @param {string} path
 * @returns {boolean} whether path is now selected
 */
export function toggleContextPath(path) {
  const target = String(path || '').trim();
  if (!target) return false;

  const list = [...store.state.selectedContextPaths];
  const idx = list.indexOf(target);
  let selected = false;

  if (idx >= 0) {
    list.splice(idx, 1);
    selected = false;
  } else {
    if (list.length >= MAX_CONTEXT_FILES) {
      showToast(`最多同时勾选 ${MAX_CONTEXT_FILES} 份文件参与联合问答`, 'warning');
      return false;
    }
    list.push(target);
    selected = true;
  }

  store.state.selectedContextPaths = list;
  store.emit('context:changed', list);
  return selected;
}

/**
 * Update and persist left file sort preferences, then emit 'files:sort-changed'.
 * @param {{ by?: 'name'|'mtime'|'ext'|'size'|'time'|'type', dir?: 'asc'|'desc' }} [patch={}]
 */
export function setLeftFileSort(patch = {}) {
  const cur = store.state.leftFileSort || { by: 'name', dir: 'asc' };
  const rawBy = patch?.by ?? cur.by;
  const by = normalizeLeftSortBy(rawBy);
  const rawDir = patch?.dir ?? cur.dir;
  const dir = rawDir === 'desc' ? 'desc' : 'asc';
  const next = { by, dir };

  store.state.leftFileSort = next;
  try {
    localStorage.setItem(LEFT_SORT_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
  store.emit('files:sort-changed', next);
  return next;
}

function persistShelfItems(items) {
  const safeList = Array.isArray(items) ? items.slice(0, MAX_SHELF_ITEMS) : [];
  store.state.shelfItems = safeList;
  try {
    localStorage.setItem(DRAG_SHELF_KEY, JSON.stringify(safeList));
  } catch {
    // ignore storage errors
  }
  store.emit('shelf:changed', safeList);
  return safeList;
}

/**
 * Add a dragged snippet / capsule / file item to the Drag Staging Shelf (max 30).
 * @param {object | string} payload
 */
export function addToShelf(payload) {
  const rawObj = typeof payload === 'string' ? { markdown: payload } : (payload || {});
  const markdown = String(rawObj.markdown ?? rawObj.text ?? rawObj.content ?? '').trim();
  if (!markdown) return store.state.shelfItems;

  const path = String(rawObj.path || rawObj.sourceDocPath || '').trim();
  const baseName = path ? path.split(/[\\/]/).pop() : '';
  const ext = String(
    rawObj.ext || (baseName.includes('.') ? `.${baseName.split('.').pop().toLowerCase()}` : '')
  ).trim();
  const firstLine = markdown.split('\n')[0].replace(/[#>*`\[\]]/g, '').trim().slice(0, 32);
  const label = String(rawObj.label ?? rawObj.title ?? '').trim() || firstLine || baseName || '内容片段';
  const type = String(rawObj.type || 'snippet').trim() || 'snippet';
  const id = String(rawObj.id || '').trim() || `shelf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = Number(rawObj.createdAt) || Date.now();

  const entry = { id, type, label, markdown, path, ext, createdAt };
  const prev = Array.isArray(store.state.shelfItems) ? store.state.shelfItems : [];
  const deduped = prev.filter((item) => item && item.markdown !== markdown);
  return persistShelfItems([entry, ...deduped].slice(0, MAX_SHELF_ITEMS));
}

/**
 * Remove an item by id from the Drag Staging Shelf.
 * @param {string} id
 */
export function removeFromShelf(id) {
  const targetId = String(id || '').trim();
  if (!targetId) return store.state.shelfItems;
  const prev = Array.isArray(store.state.shelfItems) ? store.state.shelfItems : [];
  return persistShelfItems(prev.filter((item) => item?.id !== targetId));
}

/**
 * Clear all items from the Drag Staging Shelf.
 */
export function clearShelf() {
  return persistShelfItems([]);
}

/**
 * Apply light/dark theme to document root, persist to localStorage, and emit 'theme:changed'.
 * @param {'light'|'dark'} theme
 */
export function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  store.state.theme = next;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = next;
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // ignore storage errors
  }
  store.emit('theme:changed', next);
  return next;
}

const DOC_FONT_FAMILY_VAR = {
  sans: 'var(--font-sans)',
  serif: 'var(--font-serif)',
  mono: 'var(--font-mono)',
};

/**
 * Apply document font size (12..24) and family ('sans'|'serif'|'mono'), persist to localStorage,
 * and emit 'typography:changed'.
 * @param {number} size
 * @param {'sans'|'serif'|'mono'} family
 */
export function applyDocTypography(size, family) {
  const nextSize = clampNumber(size, 12, 24, store.state.docFontSize || 15);
  const nextFamily = ['sans', 'serif', 'mono'].includes(family)
    ? family
    : (['sans', 'serif', 'mono'].includes(store.state.docFontFamily) ? store.state.docFontFamily : 'sans');

  store.state.docFontSize = nextSize;
  store.state.docFontFamily = nextFamily;

  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--doc-font-size', `${nextSize}px`);
    document.documentElement.style.setProperty('--doc-font-family', DOC_FONT_FAMILY_VAR[nextFamily]);
  }

  try {
    localStorage.setItem(DOC_FONT_SIZE_KEY, String(nextSize));
    localStorage.setItem(DOC_FONT_FAMILY_KEY, nextFamily);
  } catch {
    // ignore storage errors
  }

  const detail = { docFontSize: nextSize, docFontFamily: nextFamily };
  store.emit('typography:changed', detail);
  return detail;
}

/**
 * Clamp and apply left/right desktop pane widths, set CSS vars, and persist to localStorage.
 * @param {number} leftW
 * @param {number} rightW
 */
export function applyPaneWidths(leftW, rightW) {
  const cur = store.state.paneWidths || { left: 260, right: 360 };
  const nextLeft = clampNumber(leftW, 200, 480, cur.left ?? 260);
  const nextRight = clampNumber(rightW, 280, 560, cur.right ?? 360);
  const nextWidths = { left: nextLeft, right: nextRight };

  store.state.paneWidths = nextWidths;
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--left-w', `${nextLeft}px`);
    document.documentElement.style.setProperty('--right-w', `${nextRight}px`);
  }

  try {
    localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify(nextWidths));
  } catch {
    // ignore storage errors
  }

  return nextWidths;
}

/**
 * Set and persist a per-module scroll body height (clamped 100..640px) and emit 'ui:layout-changed'.
 * @param {string} moduleId
 * @param {number} px
 */
export function setModuleHeight(moduleId, px) {
  const id = String(moduleId || '').trim();
  if (!id) return store.state.uiLayout;
  const clamped = clampNumber(px, 100, 640, 240);
  const current = store.state.uiLayout || cloneDefaultUiLayout();
  const nextHeights = {
    ...(current.moduleHeights || {}),
    [id]: clamped,
  };
  return updateUiLayout({ moduleHeights: nextHeights });
}

/**
 * Merge partial UI layout changes, persist to localStorage, and emit 'ui:layout-changed'.
 * @param {object} partial
 */
export function updateUiLayout(partial) {
  const current = store.state.uiLayout || cloneDefaultUiLayout();
  const merged = normalizeUiLayout({ ...current, ...(partial || {}) });
  store.state.uiLayout = merged;
  try {
    localStorage.setItem(UI_LAYOUT_KEY, JSON.stringify(merged));
  } catch {
    // ignore storage errors
  }
  store.emit('ui:layout-changed', merged);
  return merged;
}

/**
 * Reset UI layout, module heights, pane widths, and left file sort to defaults,
 * persist to localStorage, and emit 'ui:layout-changed'.
 */
export function resetUiLayout() {
  const next = cloneDefaultUiLayout();
  next.moduleHeights = {};
  store.state.uiLayout = next;
  try {
    localStorage.setItem(UI_LAYOUT_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
  applyPaneWidths(260, 360);
  setLeftFileSort({ by: 'name', dir: 'asc' });
  store.emit('ui:layout-changed', next);
  return next;
}

/**
 * Record an opened file in store.state.recentFiles (max 8) and persist to localStorage.
 * @param {{ path?: string, name?: string, ext?: string } | string} fileInfo
 */
export function recordRecentFile(fileInfo) {
  const path = typeof fileInfo === 'string' ? fileInfo : fileInfo?.path;
  if (!path) return store.state.recentFiles;
  const normalizedPath = String(path).trim();
  if (!normalizedPath) return store.state.recentFiles;

  const baseName = normalizedPath.split(/[\\/]/).pop() || normalizedPath;
  const entry = {
    path: normalizedPath,
    name: (typeof fileInfo === 'object' && fileInfo?.name) ? fileInfo.name : baseName,
    ext: (typeof fileInfo === 'object' && fileInfo?.ext) ? fileInfo.ext : (baseName.includes('.') ? baseName.split('.').pop().toLowerCase() : ''),
    openedAt: Date.now(),
  };

  const prev = Array.isArray(store.state.recentFiles) ? store.state.recentFiles : [];
  const next = [entry, ...prev.filter((item) => item?.path !== normalizedPath)].slice(0, MAX_RECENT_FILES);
  store.state.recentFiles = next;
  try {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
  store.emit('recent:changed', next);
  return next;
}

/**
 * Set drag payload in DataTransfer (DRAG_MIME + text/plain) and fallback state
 * so WebView2 never loses cross-panel drag data.
 * @param {DragEvent} event
 * @param {object | string} payload
 */
export function setDragPayload(event, payload) {
  const normalized = typeof payload === 'string'
    ? { type: 'text', markdown: payload, text: payload }
    : { ...(payload || {}) };
  store.state.activeDragPayload = normalized;

  const plainText = String(
    normalized.markdown ?? normalized.text ?? normalized.content ?? normalized.title ?? ''
  );

  const dt = event?.dataTransfer;
  if (dt) {
    try {
      dt.setData(DRAG_MIME, JSON.stringify(normalized));
    } catch {
      // ignore DataTransfer restrictions
    }
    try {
      dt.setData('text/plain', plainText);
    } catch {
      // ignore DataTransfer restrictions
    }
    try {
      if (!dt.effectAllowed || dt.effectAllowed === 'uninitialized') {
        dt.effectAllowed = 'copyMove';
      }
    } catch {
      // ignore
    }
  }
  return normalized;
}

/**
 * Read drag payload from DataTransfer DRAG_MIME, falling back to activeDragPayload, then text/plain.
 * @param {DragEvent} event
 */
export function readDragPayload(event) {
  const dt = event?.dataTransfer;
  if (dt) {
    try {
      const raw = dt.getData(DRAG_MIME);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch {
      // ignore parse/access error
    }
  }

  if (store.state.activeDragPayload) {
    return store.state.activeDragPayload;
  }

  if (dt) {
    try {
      const text = dt.getData('text/plain');
      if (text) {
        return { type: 'text', markdown: text, text };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Clear active drag payload fallback.
 */
export function clearDragPayload() {
  store.state.activeDragPayload = null;
}

function simpleMarkdownFallback(mdText) {
  const lines = String(mdText ?? '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let inCode = false;
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  const formatInline = (text) => {
    let safe = escapeHtml(text);
    safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return safe;
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      closeList();
      if (!inCode) {
        inCode = true;
        html.push('<pre><code>');
      } else {
        inCode = false;
        html.push('</code></pre>');
      }
      continue;
    }

    if (inCode) {
      html.push(`${escapeHtml(line)}\n`);
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      html.push(`<h${level}>${formatInline(headingMatch[2])}</h${level}>`);
      continue;
    }

    const listMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (listMatch) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${formatInline(listMatch[1])}</li>`);
      continue;
    }

    if (line.trim().startsWith('>')) {
      closeList();
      html.push(`<blockquote>${formatInline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }

    if (line.trim() === '') {
      closeList();
      continue;
    }

    closeList();
    html.push(`<p>${formatInline(line)}</p>`);
  }

  closeList();
  if (inCode) html.push('</code></pre>');
  return html.join('\n');
}

const DANGEROUS_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'LINK',
  'META',
  'BASE',
  'FORM',
  'NOSCRIPT',
  'TEMPLATE',
]);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction']);

function sanitizeDomTree(root) {
  const nodes = Array.from(root.querySelectorAll('*'));
  for (const el of nodes) {
    if (DANGEROUS_TAGS.has(el.tagName)) {
      el.remove();
      continue;
    }
    // Strip unknown style/event attributes while explicitly allowing safe <mark> tags
    if (el.tagName === 'MARK') {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name !== 'class') {
          el.removeAttribute(attr.name);
        }
      }
      continue;
    }
    if (el.tagName === 'VIDEO' || el.tagName === 'SOURCE') {
      const allowedMediaAttrs = new Set([
        'src',
        'type',
        'preload',
        'controls',
        'muted',
        'playsinline',
        'poster',
        'class',
      ]);
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim();
        if (name.startsWith('on') || !allowedMediaAttrs.has(name)) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (URL_ATTRS.has(name)) {
          const lowerVal = val.replace(/\s+/g, '').toLowerCase();
          if (
            lowerVal.startsWith('javascript:') ||
            lowerVal.startsWith('vbscript:') ||
            lowerVal.startsWith('data:text/html')
          ) {
            el.removeAttribute(attr.name);
          }
        }
      }
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.has(name)) {
        const lowerVal = val.replace(/\s+/g, '').toLowerCase();
        if (
          lowerVal.startsWith('javascript:') ||
          lowerVal.startsWith('vbscript:') ||
          lowerVal.startsWith('data:text/html')
        ) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }
}

function getFileBaseNameLower(pathOrName) {
  return String(pathOrName || '').split(/[\\/]/).pop().trim().toLowerCase();
}

export function findWorkspaceFileItem(fileRef) {
  const items = store.state.files?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const target = String(fileRef || '').trim();
  if (!target) return null;
  const targetLower = target.toLowerCase();
  const targetNorm = target.replace(/\\/g, '/').toLowerCase();
  const hasSlash = targetNorm.includes('/');
  const targetBase = getFileBaseNameLower(target);

  // 1. Exact full path match
  const exactPathMatch = items.find((item) => {
    const itemPath = String(item?.path || '').replace(/\\/g, '/').toLowerCase();
    return itemPath === targetNorm;
  });
  if (exactPathMatch) return exactPathMatch;

  // 2. Normalized path suffix match when query contains / or \ (disambiguates duplicate basenames)
  if (hasSlash) {
    const suffixTarget = targetNorm.replace(/^\.\//, '');
    const suffixMatch = items.find((item) => {
      const itemPath = String(item?.path || '').replace(/\\/g, '/').toLowerCase();
      return itemPath.endsWith(`/${suffixTarget}`) || itemPath === suffixTarget;
    });
    if (suffixMatch) return suffixMatch;
  }

  // 3. Exact basename match
  const exactBaseMatch = items.find((item) => {
    const itemName = String(item?.name || '').toLowerCase();
    const itemBase = getFileBaseNameLower(item?.path || item?.name || '');
    return itemName === targetLower || itemBase === targetBase;
  });
  if (exactBaseMatch) return exactBaseMatch;

  // 4. Extensionless match (prefer .md over .txt)
  const stripNoteExt = (name) => String(name || '').replace(/\.(md|txt)$/i, '').toLowerCase();
  const targetStem = stripNoteExt(targetBase);
  if (targetStem) {
    const mdMatch = items.find((item) => {
      const itemBase = getFileBaseNameLower(item?.path || item?.name || '');
      return /\.md$/i.test(itemBase) && stripNoteExt(itemBase) === targetStem;
    });
    if (mdMatch) return mdMatch;

    const txtMatch = items.find((item) => {
      const itemBase = getFileBaseNameLower(item?.path || item?.name || '');
      return /\.txt$/i.test(itemBase) && stripNoteExt(itemBase) === targetStem;
    });
    if (txtMatch) return txtMatch;
  }

  return null;
}

function isFileMountedInStore(fileRef) {
  const items = store.state.files?.items;
  if (!Array.isArray(items) || items.length === 0) return true;
  const target = String(fileRef || '').trim();
  if (!target) return true;
  return Boolean(findWorkspaceFileItem(target));
}

function markBrokenIfMissing(btn, fileRef) {
  if (!fileRef) return;
  if (!isFileMountedInStore(fileRef)) {
    btn.classList.add('is-broken');
    btn.title = '文件未找到或已移动，点击尝试自动寻回';
  }
}

function parseMediaTimeToSeconds(timeStr) {
  const raw = String(timeStr || '').trim();
  if (!raw) return 0;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    return Math.max(0, Number(raw));
  }
  const parts = raw.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

function buildImageEmbedCard(file, pathStr, widthPx, fullMatch) {
  const card = document.createElement('div');
  card.className = 'media-embed-card';
  card.draggable = true;
  card.setAttribute('draggable', 'true');
  card.dataset.mediaKind = 'image';
  card.dataset.mediaFile = file;
  card.dataset.mediaPath = pathStr;
  card.dataset.mediaRaw = fullMatch;
  card.dataset.anchorRaw = fullMatch;
  card.style.width = widthPx ? `${widthPx}px` : '100%';
  card.style.maxWidth = '100%';

  const streamUrl = `/api/files/raw-stream?path=${encodeURIComponent(pathStr)}`;
  card.innerHTML = `
    <img class="media-embed-img" src="${escapeHtml(streamUrl)}" alt="${escapeHtml(file)}" loading="lazy" />
    <div class="media-embed-toolbar">
      <span class="media-embed-label" title="${escapeHtml(file)}">${escapeHtml(file)}</span>
      <div class="media-embed-actions">
        <button type="button" class="media-size-pill" data-media-action="resize" data-media-pct="50">50%</button>
        <button type="button" class="media-size-pill" data-media-action="resize" data-media-pct="75">75%</button>
        <button type="button" class="media-size-pill" data-media-action="resize" data-media-pct="100">100%</button>
        <button type="button" class="media-size-pill" data-media-action="open-external" title="独立打开查看">${icon('external-link', 11)} 独立打开</button>
      </div>
      <span class="media-resize-handle" title="按住拖动调节大小"></span>
    </div>
  `;
  return card;
}

function buildVideoEmbedCard(file, pathStr, timeStr, widthPx, fullMatch) {
  const card = document.createElement('div');
  card.className = 'media-embed-card is-video';
  card.draggable = true;
  card.setAttribute('draggable', 'true');
  card.dataset.mediaKind = 'video';
  card.dataset.mediaFile = file;
  card.dataset.mediaPath = pathStr;
  card.dataset.mediaTime = timeStr || '';
  card.dataset.mediaRaw = fullMatch;
  card.dataset.anchorRaw = fullMatch;
  card.style.width = widthPx ? `${widthPx}px` : '460px';
  card.style.maxWidth = '100%';

  const hasExplicitTime = Boolean(String(timeStr || '').trim());
  const seekSec = hasExplicitTime ? parseMediaTimeToSeconds(timeStr) : 0;
  const streamUrl = `/api/files/raw-stream?path=${encodeURIComponent(pathStr)}${hasExplicitTime ? `#t=${seekSec}` : ''}`;
  const timeBadge = timeStr ? `<span class="media-time-pill">${escapeHtml(timeStr)}</span>` : '';

  card.innerHTML = `
    <div class="video-poster-box">
      <video class="media-embed-video" preload="metadata" muted playsinline src="${escapeHtml(streamUrl)}"></video>
      <button type="button" class="video-play-badge" data-media-action="play-inline" title="点击播放视频">▶</button>
    </div>
    <div class="media-embed-toolbar">
      <span class="media-embed-label" title="${escapeHtml(file)}">${escapeHtml(file)}${timeBadge}</span>
      <div class="media-embed-actions">
        <button type="button" class="media-size-pill" data-media-action="resize" data-media-pct="50">50%</button>
        <button type="button" class="media-size-pill" data-media-action="resize" data-media-pct="75">75%</button>
        <button type="button" class="media-size-pill" data-media-action="resize" data-media-pct="100">100%</button>
        <button type="button" class="media-size-pill" data-media-action="open-external" title="在播放器中打开">${icon('external-link', 11)} 播放器</button>
      </div>
      <span class="media-resize-handle" title="按住拖动调节大小"></span>
    </div>
  `;
  return card;
}

function createUrlPillNode(urlStr, labelStr = '', rawFull = '') {
  const rawUrl = String(urlStr || '').trim();
  if (!/^https?:\/\//i.test(rawUrl)) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'anchor-pill anchor-url';
  btn.draggable = true;
  btn.setAttribute('draggable', 'true');
  btn.dataset.anchorType = 'url';
  btn.dataset.anchorUrl = rawUrl;
  let displayLabel = String(labelStr || '').trim();
  if (!displayLabel) {
    try {
      const parsed = new URL(rawUrl);
      displayLabel = parsed.hostname.replace(/^www\./i, '') + (parsed.pathname !== '/' ? parsed.pathname.slice(0, 20) : '');
    } catch {
      displayLabel = rawUrl.slice(0, 36);
    }
  }
  btn.dataset.anchorRaw = rawFull || (labelStr ? `[[url:${labelStr}|${rawUrl}]]` : `[[url:${rawUrl}]]`);
  btn.title = rawUrl;
  btn.innerHTML = `${icon('globe', 13)}<span>${escapeHtml(displayLabel)}</span>`;
  return btn;
}

function buildAnchorPillNode(rawToken, fullMatch = '', opts = {}) {
  const token = String(rawToken || '').trim();
  if (!token) return null;
  const rawFull = fullMatch || `[[${rawToken}]]`;
  const compactMedia = Boolean(opts?.compactMedia);

  // 1. [[url:Title|https://...]] or [[url:https://...]] (FIRST)
  if (/^url:/i.test(token)) {
    const rest = token.slice(4).trim();
    if (!rest) return null;
    let label = '';
    let url = rest;
    const pipeIdx = rest.indexOf('|');
    if (pipeIdx > 0) {
      label = rest.slice(0, pipeIdx).trim();
      url = rest.slice(pipeIdx + 1).trim();
    }
    return createUrlPillNode(url, label, rawFull);
  }

  // 2. [[app:AppName]] (SECOND)
  if (/^app:/i.test(token)) {
    const appName = token.slice(4).trim();
    if (!appName) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'anchor-pill anchor-app';
    btn.draggable = true;
    btn.setAttribute('draggable', 'true');
    btn.dataset.anchorType = 'app';
    btn.dataset.anchorApp = appName;
    btn.dataset.anchorRaw = rawFull;
    btn.title = `启动应用：${appName}`;
    btn.innerHTML = `${icon('rocket', 13)}<span>${escapeHtml(appName)}</span>`;
    return btn;
  }

  // 3. Optional width suffix |w=NNN and optional display alias [[target|别名]]
  let baseToken = token;
  let widthPx = 0;
  const widthSuffixMatch = token.match(/\|\s*w=(\d+)(?:px)?\s*$/i);
  if (widthSuffixMatch) {
    widthPx = clampNumber(widthSuffixMatch[1], 120, 1200, 0);
    baseToken = token.slice(0, widthSuffixMatch.index).trim();
  }

  let targetToken = baseToken;
  let aliasLabel = '';
  const aliasPipeIdx = baseToken.indexOf('|');
  if (aliasPipeIdx > 0) {
    targetToken = baseToken.slice(0, aliasPipeIdx).trim();
    aliasLabel = baseToken.slice(aliasPipeIdx + 1).trim();
  }
  if (!targetToken) return null;

  // 4. Same-file heading anchor [[#章节名]]
  const hashIdx = targetToken.indexOf('#');
  if (hashIdx === 0) {
    const heading = targetToken.slice(1).trim();
    if (!heading) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'anchor-pill anchor-doc';
    btn.draggable = true;
    btn.setAttribute('draggable', 'true');
    btn.dataset.anchorType = 'heading';
    btn.dataset.anchorFile = '';
    btn.dataset.anchorHeading = heading;
    btn.dataset.anchorRaw = rawFull;
    btn.innerHTML = `${icon('file-text', 13)}<span>${escapeHtml(aliasLabel || `#${heading}`)}</span>`;
    return btn;
  }

  // 5. Archive member syntax [[file.zip!member]] or [[file.zip]]
  const archiveOnlyOrBangMatch = targetToken.match(/^([^#!]+?\.(?:zip|tar|tgz|gz))(?:!(.+))?$/i);
  if (archiveOnlyOrBangMatch) {
    const file = archiveOnlyOrBangMatch[1].trim();
    const member = (archiveOnlyOrBangMatch[2] || '').trim();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'anchor-pill anchor-archive';
    btn.draggable = true;
    btn.setAttribute('draggable', 'true');
    btn.dataset.anchorType = 'archive';
    btn.dataset.anchorFile = file;
    btn.dataset.anchorMember = member;
    btn.dataset.anchorRaw = rawFull;
    const defaultLabel = `${file}${member ? ` · ${member}` : ''}`;
    btn.innerHTML = `${icon('layers', 13)}<span>${escapeHtml(aliasLabel || defaultLabel)}</span>`;
    markBrokenIfMissing(btn, file);
    return btn;
  }

  const file = (hashIdx > 0 ? targetToken.slice(0, hashIdx) : targetToken).trim();
  const fragment = (hashIdx > 0 ? targetToken.slice(hashIdx + 1) : '').trim();
  if (!file) return null;

  const extMatch = file.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : '';

  // 6. Extension-First Routing (do NOT let fragment regex hijack .md/.txt/code/office files)
  // 6a. PDF: .pdf
  if (ext === '.pdf') {
    let page = '';
    if (fragment) {
      const pageEq = fragment.match(/^page=(\d+)$/i);
      const pageP = fragment.match(/^p\.?(\d+)$/i);
      const bareNum = fragment.match(/^(\d+)$/);
      page = pageEq ? pageEq[1] : pageP ? pageP[1] : bareNum ? bareNum[1] : '';
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'anchor-pill anchor-pdf';
    btn.draggable = true;
    btn.setAttribute('draggable', 'true');
    btn.dataset.anchorType = 'pdf';
    btn.dataset.anchorFile = file;
    btn.dataset.anchorPage = page;
    btn.dataset.anchorSheet = '';
    btn.dataset.anchorCell = '';
    btn.dataset.anchorRaw = rawFull;
    const defaultLabel = `${file}${page ? ` · P.${page}` : ''}`;
    btn.innerHTML = `${icon('file-pdf', 13)}<span>${escapeHtml(aliasLabel || defaultLabel)}</span>`;
    markBrokenIfMissing(btn, file);
    return btn;
  }

  // 6b. Excel: .xlsx, .xlsm, .xls (NOT .csv!)
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xls') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'anchor-pill anchor-excel';
    btn.draggable = true;
    btn.setAttribute('draggable', 'true');
    btn.dataset.anchorType = 'excel';
    btn.dataset.anchorFile = file;
    btn.dataset.anchorPage = '';
    btn.dataset.anchorRaw = rawFull;

    let sheet = '';
    let cell = '';
    if (fragment) {
      const sheetCellMatch = fragment.match(/^([^!]+)!([A-Za-z]+\d+)$/);
      const cellOnlyMatch = fragment.match(/^([A-Za-z]+\d+)$/);
      if (sheetCellMatch) {
        sheet = sheetCellMatch[1].trim();
        cell = sheetCellMatch[2].toUpperCase();
      } else if (cellOnlyMatch) {
        cell = cellOnlyMatch[1].toUpperCase();
      } else {
        sheet = fragment.replace(/!+$/, '').trim();
      }
    }

    btn.dataset.anchorSheet = sheet;
    btn.dataset.anchorCell = cell;
    const fragLabel = sheet && cell ? `${sheet}!${cell}` : cell ? cell : sheet ? sheet : '';
    const defaultLabel = fragLabel ? `${file} · ${fragLabel}` : file;
    btn.innerHTML = `${icon('file-spreadsheet', 13)}<span>${escapeHtml(aliasLabel || defaultLabel)}</span>`;
    markBrokenIfMissing(btn, file);
    return btn;
  }

  // 6c. Image: .png, .jpg, .jpeg, .webp, .gif, .bmp, .svg
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'].includes(ext)) {
    const found = findWorkspaceFileItem(file);
    if (found?.path && !compactMedia) {
      return buildImageEmbedCard(file, found.path, widthPx, rawFull);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'anchor-pill anchor-media';
    btn.draggable = true;
    btn.setAttribute('draggable', 'true');
    btn.dataset.anchorType = 'media';
    btn.dataset.anchorFile = file;
    btn.dataset.anchorTime = '';
    btn.dataset.anchorRaw = rawFull;
    btn.innerHTML = `${icon('image', 13)}<span>${escapeHtml(aliasLabel || file)}</span>`;
    if (!found?.path) {
      markBrokenIfMissing(btn, file);
    }
    return btn;
  }

  // 6d. Video & Audio: .mp4, .webm, .mov, .mkv, .m4v, .avi, .mp3, .wav, .m4a, .ogg, .flac, .aac
  const VIDEO_INLINE_EXTS = ['.mp4', '.webm', '.mov'];
  const MEDIA_ALL_EXTS = ['.mp4', '.webm', '.mov', '.mkv', '.m4v', '.avi', '.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac'];
  if (MEDIA_ALL_EXTS.includes(ext)) {
    let timeStr = '';
    if (fragment) {
      const timeMatch = fragment.match(/^t=([\d:]+(?:\.\d+)?)$/i);
      const bareTimeMatch = fragment.match(/^(\d+(?::\d+)*(?:\.\d+)?)$/);
      if (timeMatch) timeStr = timeMatch[1];
      else if (bareTimeMatch) timeStr = bareTimeMatch[1];
    }
    if (VIDEO_INLINE_EXTS.includes(ext)) {
      const found = findWorkspaceFileItem(file);
      if (found?.path && !compactMedia) {
        return buildVideoEmbedCard(file, found.path, timeStr, widthPx, rawFull);
      }
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'anchor-pill anchor-media';
    btn.draggable = true;
    btn.setAttribute('draggable', 'true');
    btn.dataset.anchorType = 'media';
    btn.dataset.anchorFile = file;
    btn.dataset.anchorTime = timeStr;
    btn.dataset.anchorRaw = rawFull;
    const defaultLabel = `${file}${timeStr ? ` · ${timeStr}` : ''}`;
    btn.innerHTML = `${icon('play', 12)}<span>${escapeHtml(aliasLabel || defaultLabel)}</span>`;
    markBrokenIfMissing(btn, file);
    return btn;
  }

  // 6e. Documents, code files (.md, .txt, .csv, .docx, .pptx, etc.), or extensionless note names
  const isKnownOrValidNoteName =
    file.includes('.') ||
    Boolean(findWorkspaceFileItem(file)) ||
    (/^[^/\\:*?"<>|]+$/.test(file) && !file.startsWith('!'));

  if (isKnownOrValidNoteName) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'anchor-pill anchor-doc';
    btn.draggable = true;
    btn.setAttribute('draggable', 'true');
    btn.dataset.anchorType = 'file';
    btn.dataset.anchorFile = file;
    btn.dataset.anchorHeading = fragment;
    btn.dataset.anchorRaw = rawFull;
    const defaultLabel = `${file}${fragment ? ` · #${fragment}` : ''}`;
    btn.innerHTML = `${icon('file-text', 13)}<span>${escapeHtml(aliasLabel || defaultLabel)}</span>`;
    markBrokenIfMissing(btn, file);
    return btn;
  }

  return null;
}

function transformMarkdownImagesInDom(root) {
  const imgs = Array.from(root.querySelectorAll('img[src]'));
  for (const img of imgs) {
    if (img.closest('.media-embed-card, pre, code')) continue;
    const rawSrc = (img.getAttribute('src') || '').trim();
    if (!rawSrc || /^(https?:|data:|\/api\/)/i.test(rawSrc)) continue;
    const decodedRef = (() => {
      try {
        return decodeURIComponent(rawSrc.split(/[?#]/)[0]);
      } catch {
        return rawSrc.split(/[?#]/)[0];
      }
    })();
    const found = findWorkspaceFileItem(decodedRef);
    if (found?.path) {
      img.setAttribute('src', `/api/files/raw-stream?path=${encodeURIComponent(found.path)}`);
      img.setAttribute('loading', 'lazy');
      img.classList.add('md-inline-img');
    }
  }
}

function transformBareUrlsInDom(root) {
  const anchors = Array.from(root.querySelectorAll('a[href]'));
  for (const a of anchors) {
    if (a.closest('pre, code')) continue;
    const href = (a.getAttribute('href') || '').trim();
    if (!/^https?:\/\//i.test(href)) continue;
    const text = (a.textContent || '').trim();
    const isBareOrUrlLike =
      text === href ||
      text.replace(/\/$/, '') === href.replace(/\/$/, '') ||
      /^https?:\/\//i.test(text);
    const pill = createUrlPillNode(href, isBareOrUrlLike ? '' : text);
    if (pill) {
      a.replaceWith(pill);
    }
  }
}

function transformAnchorsInDom(root, opts = {}) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.nodeValue.includes('[[')) continue;
    const parentEl = node.parentElement;
    const parentTag = parentEl?.tagName;
    if (parentTag === 'SCRIPT' || parentTag === 'STYLE' || parentEl?.closest('pre, code')) continue;
    textNodes.push(node);
  }

  const anchorRegex = /\[\[([^[\]]+?)\]\]/g;
  for (const textNode of textNodes) {
    const text = textNode.nodeValue;
    anchorRegex.lastIndex = 0;
    let match;
    let lastIdx = 0;
    let replaced = false;
    const frag = document.createDocumentFragment();

    while ((match = anchorRegex.exec(text)) !== null) {
      const pill = buildAnchorPillNode(match[1], match[0], opts);
      if (!pill) continue;
      replaced = true;
      if (match.index > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
      }
      frag.appendChild(pill);
      lastIdx = match.index + match[0].length;
    }

    if (replaced) {
      if (lastIdx < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      }
      textNode.replaceWith(frag);
    }
  }
}

function findExactBacktickClose(str, fromIdx, count) {
  let i = fromIdx;
  while (i < str.length) {
    if (str[i] === '`') {
      let end = i;
      while (end < str.length && str[end] === '`') end += 1;
      if (end - i === count) return i;
      i = end;
    } else {
      i += 1;
    }
  }
  return -1;
}

function shieldAnchorsOutsideCode(raw) {
  const tokens = [];
  const src = String(raw ?? '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const outLines = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (!inFence && fenceMatch) {
      const marker = fenceMatch[1];
      const info = fenceMatch[2] || '';
      if (!(marker[0] === '`' && info.includes('`'))) {
        inFence = true;
        fenceChar = marker[0];
        fenceLen = marker.length;
        outLines.push(line);
        continue;
      }
    } else if (inFence) {
      const closeMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
      outLines.push(line);
      continue;
    }

    let res = '';
    let i = 0;
    while (i < line.length) {
      if (line[i] === '`') {
        let tickEnd = i;
        while (tickEnd < line.length && line[tickEnd] === '`') tickEnd += 1;
        const tickCount = tickEnd - i;
        const closeIdx = findExactBacktickClose(line, tickEnd, tickCount);
        if (closeIdx >= 0) {
          res += line.slice(i, closeIdx + tickCount);
          i = closeIdx + tickCount;
          continue;
        }
        res += line.slice(i, tickEnd);
        i = tickEnd;
        continue;
      }
      if (line[i] === '[' && line[i + 1] === '[') {
        const m = line.slice(i).match(/^\[\[([^[\]]+?)\]\]/);
        if (m) {
          const idx = tokens.length;
          tokens.push({ inner: m[1], raw: m[0] });
          res += `SLNANCHORTOKEN${idx}END`;
          i += m[0].length;
          continue;
        }
      }
      res += line[i];
      i += 1;
    }
    outLines.push(res);
  }

  return { shielded: outLines.join('\n'), tokens };
}

function restoreShieldedAnchorsInDom(root, tokens, opts = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.nodeValue.includes('SLNANCHORTOKEN')) continue;
    const parentTag = node.parentElement?.tagName;
    if (parentTag === 'SCRIPT' || parentTag === 'STYLE') continue;
    textNodes.push(node);
  }

  const tokenRegex = /SLNANCHORTOKEN(\d+)END/g;
  for (const textNode of textNodes) {
    const text = textNode.nodeValue;
    const inCodeBlock = Boolean(textNode.parentElement?.closest('pre, code'));
    tokenRegex.lastIndex = 0;
    let match;
    let lastIdx = 0;
    let replaced = false;
    const frag = document.createDocumentFragment();

    while ((match = tokenRegex.exec(text)) !== null) {
      const idx = Number.parseInt(match[1], 10);
      const tok = tokens[idx];
      if (!tok) continue;
      replaced = true;
      if (match.index > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
      }
      if (inCodeBlock) {
        frag.appendChild(document.createTextNode(tok.raw));
      } else {
        const pill = buildAnchorPillNode(tok.inner, tok.raw, opts);
        frag.appendChild(pill || document.createTextNode(tok.raw));
      }
      lastIdx = match.index + match[0].length;
    }

    if (replaced) {
      if (lastIdx < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      }
      textNode.replaceWith(frag);
    }
  }
}

const CALLOUT_META = {
  TIP: { cls: 'callout-tip', label: '技巧 TIP', iconName: 'sparkles' },
  WARNING: { cls: 'callout-warning', label: '注意 WARNING', iconName: 'bell' },
  IMPORTANT: { cls: 'callout-important', label: '重要 IMPORTANT', iconName: 'zap' },
  NOTE: { cls: 'callout-note', label: '说明 NOTE', iconName: 'book-open' },
};

function transformCalloutsInDom(root) {
  const quotes = Array.from(root.querySelectorAll('blockquote'));
  for (const bq of quotes) {
    const firstP = bq.querySelector('p') || bq;
    const rawFirstText = firstP.textContent || '';
    const match = rawFirstText.match(/^\s*\[!(TIP|WARNING|IMPORTANT|NOTE)\]\s*/i);
    if (!match) continue;

    const kind = match[1].toUpperCase();
    const meta = CALLOUT_META[kind] || CALLOUT_META.NOTE;

    // Strip [!TYPE] marker cleanly from first text node inside firstP
    const walker = document.createTreeWalker(firstP, NodeFilter.SHOW_TEXT);
    const firstTextNode = walker.nextNode();
    if (firstTextNode) {
      firstTextNode.nodeValue = firstTextNode.nodeValue.replace(/^\s*\[!(TIP|WARNING|IMPORTANT|NOTE)\]\s*/i, '');
      // Remove leading <br> if marked breaks:true added one right after [!TIP]
      const nextSib = firstTextNode.nextSibling;
      if (!firstTextNode.nodeValue.trim() && nextSib && nextSib.nodeName === 'BR') {
        nextSib.remove();
      }
    }

    const card = document.createElement('div');
    card.className = `md-callout ${meta.cls}`;
    const head = document.createElement('div');
    head.className = 'md-callout-title';
    head.innerHTML = `${icon(meta.iconName, 14)}<span>${escapeHtml(meta.label)}</span>`;

    const body = document.createElement('div');
    body.className = 'md-callout-body';
    while (bq.firstChild) {
      const child = bq.firstChild;
      if (child.nodeType === 1 && child.tagName === 'P' && !child.textContent.trim() && !child.querySelector('button, img, video, mark, code')) {
        child.remove();
      } else {
        body.appendChild(child);
      }
    }

    card.appendChild(head);
    card.appendChild(body);
    bq.replaceWith(card);
  }
}

function computeTopLevelBlockLineRanges(mdText) {
  const normalized = String(mdText ?? '').replace(/\r\n/g, '\n');
  if (typeof window !== 'undefined' && window.marked && typeof window.marked.lexer === 'function') {
    try {
      const tokens = window.marked.lexer(normalized, { breaks: true, gfm: true });
      const ranges = [];
      let curLine = 0;
      for (const tok of tokens) {
        const raw = String(tok.raw || '');
        const newlines = (raw.match(/\n/g) || []).length;
        if (tok.type === 'space') {
          curLine += newlines;
          continue;
        }
        const trimmedRaw = raw.replace(/\n+$/g, '');
        const contentLines = trimmedRaw ? trimmedRaw.split('\n').length : 1;
        const startLine = curLine;
        const endLine = Math.max(startLine, startLine + contentLines - 1);
        ranges.push({ start: startLine, end: endLine });
        curLine += newlines;
        // If token raw didn't end with newline and isn't followed by space, stay on line or advance
        if (!raw.endsWith('\n')) {
          curLine += 1;
        }
      }
      return ranges;
    } catch {
      // fall through to heuristic parser
    }
  }

  // Fallback block line range estimator
  const lines = normalized.split('\n');
  const ranges = [];
  let i = 0;
  let inCode = false;
  let codeStart = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeStart = i;
      } else {
        inCode = false;
        ranges.push({ start: codeStart, end: i });
      }
      i += 1;
      continue;
    }
    if (inCode) {
      i += 1;
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      ranges.push({ start: i, end: i });
      i += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const start = i;
      while (i + 1 < lines.length && (/^\s*[-*+]\s+/.test(lines[i + 1]) || /^\s*\d+\.\s+/.test(lines[i + 1]))) {
        i += 1;
      }
      ranges.push({ start, end: i });
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const start = i;
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) {
        i += 1;
      }
      ranges.push({ start, end: i });
      i += 1;
      continue;
    }
    ranges.push({ start: i, end: i });
    i += 1;
  }
  if (inCode) {
    ranges.push({ start: codeStart, end: Math.max(codeStart, lines.length - 1) });
  }
  return ranges;
}

function annotateTopLevelBlockLines(root, mdText) {
  const ranges = computeTopLevelBlockLineRanges(mdText);
  const children = Array.from(root.children);
  const totalLines = String(mdText ?? '').replace(/\r\n/g, '\n').split('\n').length;

  for (let i = 0; i < children.length; i += 1) {
    const el = children[i];
    const range = ranges[i];
    if (range) {
      el.dataset.mdStart = String(range.start);
      el.dataset.mdEnd = String(range.end);
    } else {
      const fallbackLine = Math.max(0, Math.min(totalLines - 1, i));
      el.dataset.mdStart = String(fallbackLine);
      el.dataset.mdEnd = String(fallbackLine);
    }
  }
}

/**
 * Safely render Markdown to sanitized HTML and transform Universal Portal Capsules ([[...]]),
 * inline image & video poster embeds, bare URLs, GitHub Alert callouts, safe <mark> highlights,
 * and optional source line mappings.
 * @param {string} mdText
 * @param {{ withLineMap?: boolean }} [opts={}]
 * @returns {string}
 */
export function renderMarkdownSafe(mdText, opts = {}) {
  const raw = String(mdText ?? '');
  const { shielded, tokens } = shieldAnchorsOutsideCode(raw);
  let parsedHtml = '';

  if (typeof window !== 'undefined' && window.marked && typeof window.marked.parse === 'function') {
    try {
      parsedHtml = window.marked.parse(shielded, { breaks: true, gfm: true });
    } catch {
      parsedHtml = simpleMarkdownFallback(shielded);
    }
  } else {
    parsedHtml = simpleMarkdownFallback(shielded);
  }

  if (typeof document === 'undefined') {
    const restored = parsedHtml.replace(/SLNANCHORTOKEN(\d+)END/g, (m, i) => escapeHtml(tokens[Number(i)]?.raw || m));
    return restored.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
  }

  const tpl = document.createElement('template');
  tpl.innerHTML = parsedHtml;
  sanitizeDomTree(tpl.content);
  transformMarkdownImagesInDom(tpl.content);
  transformCalloutsInDom(tpl.content);
  transformBareUrlsInDom(tpl.content);
  restoreShieldedAnchorsInDom(tpl.content, tokens, { compactMedia: !!opts?.compactMedia });
  transformAnchorsInDom(tpl.content, { compactMedia: !!opts?.compactMedia });
  if (opts && opts.withLineMap === true) {
    annotateTopLevelBlockLines(tpl.content, raw);
  }
  return tpl.innerHTML;
}
