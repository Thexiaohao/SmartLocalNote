/**
 * SmartLocalNote - Lightweight Reactive Store, EventBus, Island State Machine & Safe Helpers
 * Zero external dependencies. Panels communicate strictly via store EventBus.
 */

import { icon } from './icons.js';

const THEME_STORAGE_KEY = 'sln_theme';
const MAX_CONTEXT_FILES = 5;
const MAX_TOASTS = 3;

const listeners = new Map();

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

export const store = {
  state: {
    theme: loadInitialTheme(),
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
