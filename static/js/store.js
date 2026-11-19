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
const MAX_CONTEXT_FILES = 5;
const MAX_TOASTS = 3;
const MAX_RECENT_FILES = 8;

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
};

const listeners = new Map();

function cloneDefaultUiLayout() {
  return {
    leftModules: DEFAULT_UI_LAYOUT.leftModules.map((m) => ({ ...m })),
    rightTabsOrder: [...DEFAULT_UI_LAYOUT.rightTabsOrder],
    rightSummaryModules: DEFAULT_UI_LAYOUT.rightSummaryModules.map((m) => ({ ...m })),
    rightToolModules: DEFAULT_UI_LAYOUT.rightToolModules.map((m) => ({ ...m })),
    scratchpadText: DEFAULT_UI_LAYOUT.scratchpadText,
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
    docFontSize: loadInitialDocFontSize(),
    docFontFamily: loadInitialDocFontFamily(),
    paneWidths: loadInitialPaneWidths(),
    recentFiles: loadInitialRecentFiles(),
    uiLayout: loadInitialUiLayout(),
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

const TOAST_ICON_MAP = {
  info: 'sparkles',
  success: 'check',
  warning: 'bell',
  error: 'x',
};

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
 * Toggle a file path in selectedContextPaths (max 5).
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
 * Reset UI layout to defaults, persist to localStorage, and emit 'ui:layout-changed'.
 */
export function resetUiLayout() {
  const next = cloneDefaultUiLayout();
  store.state.uiLayout = next;
  try {
    localStorage.setItem(UI_LAYOUT_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
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

const DANGEROUS_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction']);

function sanitizeDomTree(root) {
  const nodes = Array.from(root.querySelectorAll('*'));
  for (const el of nodes) {
    if (DANGEROUS_TAGS.has(el.tagName)) {
      el.remove();
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
        if (lowerVal.startsWith('javascript:') || lowerVal.startsWith('vbscript:') || lowerVal.startsWith('data:text/html')) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }
}

function buildAnchorPillNode(rawToken) {
  const hashIdx = rawToken.indexOf('#');
  if (hashIdx <= 0) return null;
  const file = rawToken.slice(0, hashIdx).trim();
  const fragment = rawToken.slice(hashIdx + 1).trim();
  if (!file || !fragment) return null;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'anchor-pill';
  btn.dataset.anchorFile = file;

  const pageMatch = fragment.match(/^page=(\d+)$/i);
  if (pageMatch) {
    const page = pageMatch[1];
    btn.dataset.anchorPage = page;
    btn.dataset.anchorSheet = '';
    btn.dataset.anchorCell = '';
    btn.innerHTML = `${icon('file-pdf', 13)}<span>${escapeHtml(file)} · P.${escapeHtml(page)}</span>`;
    return btn;
  }

  const sheetCellMatch = fragment.match(/^([^!]+)!([A-Za-z]+\d+)$/);
  if (sheetCellMatch) {
    const sheet = sheetCellMatch[1].trim();
    const cell = sheetCellMatch[2].toUpperCase();
    btn.dataset.anchorPage = '';
    btn.dataset.anchorSheet = sheet;
    btn.dataset.anchorCell = cell;
    btn.innerHTML = `${icon('file-spreadsheet', 13)}<span>${escapeHtml(file)} · ${escapeHtml(sheet)}!${escapeHtml(cell)}</span>`;
    return btn;
  }

  const cellOnlyMatch = fragment.match(/^([A-Za-z]+\d+)$/);
  if (cellOnlyMatch) {
    const cell = cellOnlyMatch[1].toUpperCase();
    btn.dataset.anchorPage = '';
    btn.dataset.anchorSheet = '';
    btn.dataset.anchorCell = cell;
    btn.innerHTML = `${icon('file-spreadsheet', 13)}<span>${escapeHtml(file)} · ${escapeHtml(cell)}</span>`;
    return btn;
  }

  return null;
}

function transformAnchorsInDom(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.nodeValue.includes('[[')) continue;
    const parentTag = node.parentElement?.tagName;
    if (parentTag === 'SCRIPT' || parentTag === 'STYLE') continue;
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
      const pill = buildAnchorPillNode(match[1]);
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

/**
 * Safely render Markdown to sanitized HTML and transform [[file.pdf#page=N]] & [[file.xlsx#Sheet!Cell]]
 * into clickable .anchor-pill buttons.
 * @param {string} mdText
 * @returns {string}
 */
export function renderMarkdownSafe(mdText) {
  const raw = String(mdText ?? '');
  let parsedHtml = '';

  if (typeof window !== 'undefined' && window.marked && typeof window.marked.parse === 'function') {
    try {
      parsedHtml = window.marked.parse(raw, { breaks: true, gfm: true });
    } catch {
      parsedHtml = simpleMarkdownFallback(raw);
    }
  } else {
    parsedHtml = simpleMarkdownFallback(raw);
  }

  if (typeof document === 'undefined') {
    return parsedHtml.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
  }

  const tpl = document.createElement('template');
  tpl.innerHTML = parsedHtml;
  sanitizeDomTree(tpl.content);
  transformAnchorsInDom(tpl.content);
  return tpl.innerHTML;
}
