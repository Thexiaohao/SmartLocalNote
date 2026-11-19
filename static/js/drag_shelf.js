/**
 * SmartLocalNote - Edge-Docked Auto-Reveal Drag Staging Tray (V5)
 * Yoink / Dropover style right-edge frosted glass shelf for cross-file block,
 * capsule, AI snippet, app, and sticky transfer.
 *
 * Exports: initDragShelf.
 */

import {
  store,
  DRAG_MIME,
  escapeHtml,
  showToast,
  setDragPayload,
  readDragPayload,
  clearDragPayload,
} from './store.js';
import { icon } from './icons.js';

const SHELF_STORAGE_KEY = 'sln_drag_shelf';
const AUTO_COLLAPSE_DELAY_MS = 900;

let initialized = false;
let shelfEl = null;
let isOpen = false;
let pinnedOpen = false;
let isDragActive = false;
let isPointerInside = false;
let autoCollapseArmed = false;
let collapseTimer = 0;
let pulseTimer = 0;
let draggingShelfItemId = null;

function readPayloadSafe(event) {
  if (typeof store.readDragPayload === 'function') {
    return store.readDragPayload(event);
  }
  return readDragPayload(event);
}

function writePayloadSafe(event, payload) {
  if (typeof store.setDragPayload === 'function') {
    return store.setDragPayload(event, payload);
  }
  return setDragPayload(event, payload);
}

function clearPayloadSafe() {
  if (typeof store.clearDragPayload === 'function') {
    store.clearDragPayload();
    return;
  }
  clearDragPayload();
}

function getShelfItems() {
  if (Array.isArray(store.state.shelfItems)) {
    return store.state.shelfItems;
  }
  try {
    const raw = localStorage.getItem(SHELF_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    store.state.shelfItems = Array.isArray(parsed) ? parsed : [];
  } catch {
    store.state.shelfItems = [];
  }
  return store.state.shelfItems;
}

function persistFallbackShelf(items) {
  store.state.shelfItems = items;
  try {
    localStorage.setItem(SHELF_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore storage quota errors
  }
  store.emit('shelf:changed', items);
}

function normalizeShelfEntry(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const markdown = String(payload.markdown ?? payload.text ?? payload.content ?? '').trim();
  const path = String(payload.path || '').trim();
  const rawLabel = String(payload.label || payload.title || payload.name || '').trim();
  const firstLine = markdown.split(/\r?\n/)[0]?.replace(/^#+\s*/, '').trim() || '';
  const label = rawLabel || firstLine.slice(0, 32) || (path ? path.split(/[\\/]/).pop() : '暂存片段');
  const finalMarkdown = markdown || (path ? `[[${path.split(/[\\/]/).pop()}]]` : '');
  if (!finalMarkdown && !path) return null;

  return {
    id: `shelf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: String(payload.type || 'block'),
    label,
    markdown: finalMarkdown,
    path,
    createdAt: Date.now(),
  };
}

function addShelfItem(payload) {
  if (typeof store.addToShelf === 'function') {
    return store.addToShelf(payload);
  }
  const entry = normalizeShelfEntry(payload);
  if (!entry) return null;
  const next = [entry, ...getShelfItems()].slice(0, 50);
  persistFallbackShelf(next);
  return entry;
}

function removeShelfItem(id) {
  if (typeof store.removeFromShelf === 'function') {
    store.removeFromShelf(id);
    return;
  }
  const next = getShelfItems().filter((item) => item.id !== id);
  persistFallbackShelf(next);
}

function clearAllShelfItems() {
  if (typeof store.clearShelf === 'function') {
    store.clearShelf();
    return;
  }
  persistFallbackShelf([]);
}

function getTypeMeta(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('sticky') || t.includes('spark')) {
    return { badge: '闪念', iconName: 'sparkles', cls: 'type-sticky' };
  }
  if (t.includes('ai') || t.includes('summary') || t.includes('chat')) {
    return { badge: 'AI 片段', iconName: 'sparkles', cls: 'type-ai' };
  }
  if (t.includes('app')) {
    return { badge: '软件', iconName: 'rocket', cls: 'type-app' };
  }
  if (t.includes('file') || t.includes('capsule') || t.includes('anchor') || t.includes('url') || t.includes('pdf') || t.includes('excel') || t.includes('archive')) {
    return { badge: '文件胶囊', iconName: 'file-text', cls: 'type-capsule' };
  }
  return { badge: '文本块', iconName: 'layers', cls: 'type-block' };
}

function getPreviewText(item) {
  const raw = String(item?.markdown || item?.path || item?.label || '').trim();
  return raw.replace(/\s+/g, ' ').slice(0, 110);
}

function isAcceptableDragEvent(e) {
  if (store.state.activeDragPayload) return true;
  const types = Array.from(e?.dataTransfer?.types || []);
  return types.includes(DRAG_MIME) || types.includes('text/plain') || types.includes('text/uri-list');
}

function clearCollapseTimer() {
  if (collapseTimer) {
    window.clearTimeout(collapseTimer);
    collapseTimer = 0;
  }
}

function syncShelfStateClasses() {
  if (!shelfEl) return;
  shelfEl.classList.toggle('is-open', isOpen);
  shelfEl.classList.toggle('is-pinned', pinnedOpen);
  shelfEl.dataset.state = isOpen ? 'open' : 'collapsed';
}

function openShelf({ byDrag = false } = {}) {
  clearCollapseTimer();
  isOpen = true;
  if (byDrag) {
    autoCollapseArmed = true;
  }
  syncShelfStateClasses();
}

function collapseShelf({ force = false } = {}) {
  clearCollapseTimer();
  if (pinnedOpen && !force) return;
  isOpen = false;
  autoCollapseArmed = false;
  syncShelfStateClasses();
}

function scheduleAutoCollapse() {
  clearCollapseTimer();
  if (pinnedOpen || isDragActive || isPointerInside || !isOpen) return;
  collapseTimer = window.setTimeout(() => {
    collapseTimer = 0;
    if (!pinnedOpen && !isDragActive && !isPointerInside) {
      collapseShelf();
    }
  }, AUTO_COLLAPSE_DELAY_MS);
}

function triggerPulse() {
  if (!shelfEl) return;
  shelfEl.classList.remove('is-pulse');
  void shelfEl.offsetWidth;
  shelfEl.classList.add('is-pulse');
  if (pulseTimer) window.clearTimeout(pulseTimer);
  pulseTimer = window.setTimeout(() => {
    pulseTimer = 0;
    shelfEl?.classList.remove('is-pulse');
  }, 460);
}

function ensureShelfElement() {
  if (typeof document === 'undefined') return null;
  if (!shelfEl || !document.body.contains(shelfEl)) {
    shelfEl = document.getElementById('drag-shelf');
    if (!shelfEl) {
      shelfEl = document.createElement('aside');
      shelfEl.id = 'drag-shelf';
      shelfEl.className = 'drag-shelf';
      shelfEl.setAttribute('data-drop-zone', 'drag-shelf');
      shelfEl.setAttribute('aria-label', '拖拽暂存栏');
      document.body.appendChild(shelfEl);
    } else {
      shelfEl.classList.add('drag-shelf');
      shelfEl.setAttribute('data-drop-zone', 'drag-shelf');
    }
  }

  if (!shelfEl.querySelector('.drag-shelf-panel')) {
    shelfEl.innerHTML = `
      <button type="button" class="drag-shelf-tab" data-shelf-action="toggle-open" title="展开/收起拖拽暂存栏">
        <span class="drag-shelf-tab-icon" aria-hidden="true">📥</span>
        <span class="drag-shelf-tab-text">暂存</span>
        <span class="drag-shelf-tab-badge hidden" hidden>0</span>
      </button>
      <div class="drag-shelf-panel">
        <header class="drag-shelf-header">
          <div class="drag-shelf-title-wrap">
            <span aria-hidden="true">📥</span>
            <span class="drag-shelf-title">暂存栏</span>
            <span class="drag-shelf-count">0</span>
          </div>
          <div class="drag-shelf-header-actions">
            <button type="button" class="drag-shelf-pin-btn" data-shelf-action="toggle-pin" title="固定展开（切换文件时不自动收起）" aria-pressed="false">
              ${icon('pin', 12)} 固定
            </button>
            <button type="button" class="drag-shelf-close-btn" data-shelf-action="collapse" title="收起暂存栏" aria-label="收起暂存栏">
              ${icon('x', 13)}
            </button>
          </div>
        </header>
        <div class="drag-shelf-list" role="list"></div>
        <footer class="drag-shelf-footer">
          <button type="button" class="drag-shelf-footer-btn is-primary" data-shelf-action="insert-all">⬇ 全部拼入当前笔记</button>
          <button type="button" class="drag-shelf-footer-btn" data-shelf-action="clear-all">清空</button>
        </footer>
      </div>
    `;
  }

  return shelfEl;
}

function renderShelf() {
  const el = ensureShelfElement();
  if (!el) return;

  const items = getShelfItems();
  const count = items.length;

  const tabBadge = el.querySelector('.drag-shelf-tab-badge');
  if (tabBadge) {
    tabBadge.textContent = String(count);
    tabBadge.hidden = count === 0;
    tabBadge.classList.toggle('hidden', count === 0);
  }

  const countEl = el.querySelector('.drag-shelf-count');
  if (countEl) {
    countEl.textContent = String(count);
  }

  const pinBtn = el.querySelector('.drag-shelf-pin-btn');
  if (pinBtn) {
    pinBtn.classList.toggle('is-active', pinnedOpen);
    pinBtn.setAttribute('aria-pressed', pinnedOpen ? 'true' : 'false');
    pinBtn.title = pinnedOpen ? '已固定展开（点击取消固定）' : '固定展开（切换文件时不自动收起）';
  }

  const listEl = el.querySelector('.drag-shelf-list');
  if (listEl) {
    if (count === 0) {
      listEl.innerHTML = `
        <div class="drag-shelf-empty">
          <p class="drag-shelf-empty-title">暂无暂存内容</p>
          <p class="drag-shelf-empty-desc">拖入任意文本块、文件胶囊、AI 片段或闪念卡，切换笔记后随时拖出拼入</p>
        </div>
      `;
    } else {
      listEl.innerHTML = items
        .map((item) => {
          const meta = getTypeMeta(item.type);
          const preview = getPreviewText(item);
          return `
            <div class="drag-shelf-item ${meta.cls}" draggable="true" data-shelf-id="${escapeHtml(item.id)}" role="listitem">
              <div class="drag-shelf-item-top">
                <span class="drag-shelf-type-badge">${icon(meta.iconName, 11)} ${escapeHtml(meta.badge)}</span>
                <div class="drag-shelf-item-actions">
                  <button type="button" class="drag-shelf-mini-btn" data-shelf-action="insert-item" data-shelf-id="${escapeHtml(item.id)}" title="插入到当前笔记">插入</button>
                  <button type="button" class="drag-shelf-mini-btn is-danger" data-shelf-action="remove-item" data-shelf-id="${escapeHtml(item.id)}" title="移除" aria-label="移除暂存项">×</button>
                </div>
              </div>
              <div class="drag-shelf-item-label" title="${escapeHtml(item.label || '')}">${escapeHtml(item.label || '未命名片段')}</div>
              ${preview ? `<div class="drag-shelf-item-preview">${escapeHtml(preview)}</div>` : ''}
            </div>
          `;
        })
        .join('');
    }
  }

  const insertAllBtn = el.querySelector('[data-shelf-action="insert-all"]');
  const clearAllBtn = el.querySelector('[data-shelf-action="clear-all"]');
  if (insertAllBtn) insertAllBtn.disabled = count === 0;
  if (clearAllBtn) clearAllBtn.disabled = count === 0;

  syncShelfStateClasses();
}

function bindShelfEvents() {
  const el = ensureShelfElement();
  if (!el) return;

  el.addEventListener('pointerenter', () => {
    isPointerInside = true;
    clearCollapseTimer();
  });

  el.addEventListener('pointerleave', () => {
    isPointerInside = false;
    if (autoCollapseArmed && !pinnedOpen && !isDragActive) {
      scheduleAutoCollapse();
    }
  });

  el.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-shelf-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.shelfAction;

    if (action === 'toggle-open') {
      if (isOpen) {
        pinnedOpen = false;
        collapseShelf({ force: true });
      } else {
        autoCollapseArmed = false;
        openShelf({ byDrag: false });
      }
      renderShelf();
      return;
    }

    if (action === 'collapse') {
      pinnedOpen = false;
      collapseShelf({ force: true });
      renderShelf();
      return;
    }

    if (action === 'toggle-pin') {
      pinnedOpen = !pinnedOpen;
      if (pinnedOpen) {
        clearCollapseTimer();
        autoCollapseArmed = false;
        isOpen = true;
      }
      syncShelfStateClasses();
      renderShelf();
      return;
    }

    if (action === 'insert-item') {
      const id = actionEl.dataset.shelfId;
      const item = getShelfItems().find((it) => it.id === id);
      if (!item) return;
      store.emit('shelf:insert-current', {
        markdown: item.markdown,
        label: item.label,
      });
      return;
    }

    if (action === 'remove-item') {
      const id = actionEl.dataset.shelfId;
      if (id) removeShelfItem(id);
      return;
    }

    if (action === 'insert-all') {
      const items = getShelfItems();
      if (items.length === 0) {
        showToast('暂存栏为空', 'warning');
        return;
      }
      store.emit('shelf:insert-current', { items: [...items] });
      return;
    }

    if (action === 'clear-all') {
      clearAllShelfItems();
      showToast('已清空拖拽暂存栏', 'info', { duration: 1500 });
    }
  });

  // Dragging staged cards OUT to notes or AI panel
  el.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.drag-shelf-item[data-shelf-id]');
    if (!card) return;
    const id = card.dataset.shelfId;
    const item = getShelfItems().find((it) => it.id === id);
    if (!item) {
      e.preventDefault();
      return;
    }
    draggingShelfItemId = item.id;
    writePayloadSafe(e, {
      type: 'shelf-item',
      label: item.label,
      markdown: item.markdown,
      path: item.path || '',
    });
    card.classList.add('is-dragging');
    store.emit('drag:active', true);
  });

  el.addEventListener('dragend', (e) => {
    const card = e.target.closest('.drag-shelf-item[data-shelf-id]');
    card?.classList.remove('is-dragging');
    draggingShelfItemId = null;
    clearPayloadSafe();
    store.emit('drag:active', false);
  });

  // HTML5 drop INTO #drag-shelf
  el.addEventListener('dragover', (e) => {
    if (draggingShelfItemId) return;
    if (!isAcceptableDragEvent(e)) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
    clearCollapseTimer();
    el.classList.add('is-drag-over');
  });

  el.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    el.classList.remove('is-drag-over');
  });

  el.addEventListener('drop', (e) => {
    el.classList.remove('is-drag-over');
    if (draggingShelfItemId) return;
    const payload = readPayloadSafe(e);
    if (!payload) return;
    e.preventDefault();
    e.stopPropagation();

    const added = addShelfItem(payload);
    if (added) {
      triggerPulse();
      showToast('已暂存至拖拽暂存栏', 'success', { duration: 1800 });
      isDragActive = false;
      autoCollapseArmed = !pinnedOpen;
      if (!pinnedOpen && !isPointerInside) {
        scheduleAutoCollapse();
      }
    }
  });

  // Auto-reveal on any acceptable HTML5 dragenter across window
  window.addEventListener('dragenter', (e) => {
    if (draggingShelfItemId) return;
    if (!isAcceptableDragEvent(e)) return;
    isDragActive = true;
    openShelf({ byDrag: true });
  });

  window.addEventListener('dragend', () => {
    isDragActive = false;
    el.classList.remove('is-drag-over');
    if (autoCollapseArmed && !pinnedOpen && !isPointerInside) {
      scheduleAutoCollapse();
    }
  });

  window.addEventListener('drop', () => {
    isDragActive = false;
    el.classList.remove('is-drag-over');
    if (autoCollapseArmed && !pinnedOpen && !isPointerInside) {
      scheduleAutoCollapse();
    }
  });
}

/**
 * Initialize the edge-docked auto-reveal Drag Staging Tray.
 */
export function initDragShelf() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;

  ensureShelfElement();
  bindShelfEvents();
  renderShelf();

  store.on('drag:active', (active) => {
    if (active) {
      isDragActive = true;
      openShelf({ byDrag: true });
    } else {
      isDragActive = false;
      shelfEl?.classList.remove('is-drag-over');
      if (!pinnedOpen) {
        autoCollapseArmed = true;
        scheduleAutoCollapse();
      }
    }
  });

  store.on('shelf:toggle', () => {
    if (isOpen) {
      pinnedOpen = false;
      collapseShelf({ force: true });
    } else {
      autoCollapseArmed = false;
      openShelf({ byDrag: false });
    }
    renderShelf();
  });

  store.on('shelf:changed', () => {
    renderShelf();
    if (isOpen) {
      triggerPulse();
    }
  });
}
