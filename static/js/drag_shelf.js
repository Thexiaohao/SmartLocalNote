/**
 * SmartLocalNote - Dynamic Island NotchDrop Staging Pocket (V6)
 * NotchDrop / boring.notch style dropdown staging pocket anchored beneath
 * #dynamic-island for cross-file block, capsule, AI snippet, app & sticky transfer.
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

const SHELF_STORAGE_KEY = 'sln_drag_shelf_v1';
const AUTO_COLLAPSE_DELAY_MS = 750;
const HIDE_TRANSITION_MS = 220;

let initialized = false;
let shelfEl = null;
let isOpen = false;
let pinnedOpen = false;
let isDragActive = false;
let isDragInviting = false;
let isPointerInsideShelf = false;
let isPointerInsideIsland = false;
let autoCollapseArmed = false;
let collapseTimer = 0;
let hideTimer = 0;
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

function normalizeShelfPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const rawMd = String(payload.markdown ?? payload.text ?? payload.content ?? '').trim();
  const path = String(payload.path || payload.sourceDocPath || '').trim();
  const url = String(payload.url || '').trim();
  let finalMarkdown = rawMd;
  if (!finalMarkdown && path) {
    finalMarkdown = `[[${path.split(/[\\/]/).pop()}]]`;
  } else if (!finalMarkdown && url) {
    finalMarkdown = `[[url:${url}]]`;
  }
  if (!finalMarkdown) return null;

  const rawLabel = String(payload.label || payload.title || payload.name || '').trim();
  const firstLine = finalMarkdown.split(/\r?\n/)[0]?.replace(/[#>*`\[\]]/g, '').trim() || '';
  const label = rawLabel || firstLine.slice(0, 32) || (path ? path.split(/[\\/]/).pop() : '暂存片段');

  return {
    ...payload,
    type: String(payload.type || 'block'),
    label,
    markdown: finalMarkdown,
    path,
  };
}

function addShelfItem(payload) {
  const normalized = normalizeShelfPayload(payload);
  if (!normalized) return false;
  if (typeof store.addToShelf === 'function') {
    store.addToShelf(normalized);
    return true;
  }
  const entry = {
    id: `shelf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    type: normalized.type,
    label: normalized.label,
    markdown: normalized.markdown,
    path: normalized.path,
    createdAt: Date.now(),
  };
  const next = [entry, ...getShelfItems().filter((it) => it?.markdown !== entry.markdown)].slice(0, 30);
  persistFallbackShelf(next);
  return true;
}

function removeShelfItem(id) {
  if (typeof store.removeFromShelf === 'function') {
    store.removeFromShelf(id);
    return;
  }
  const next = getShelfItems().filter((item) => item.id !== id);
  persistFallbackShelf(next);
}

function consumeShelfItemSafe(id) {
  if (!id) return;
  if (typeof store.consumeShelfItem === 'function') {
    store.consumeShelfItem(id);
    return;
  }
  removeShelfItem(id);
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
  if (
    t.includes('file') ||
    t.includes('capsule') ||
    t.includes('anchor') ||
    t.includes('url') ||
    t.includes('pdf') ||
    t.includes('excel') ||
    t.includes('archive')
  ) {
    return { badge: '文件胶囊', iconName: 'file-text', cls: 'type-capsule' };
  }
  return { badge: '文本块', iconName: 'layers', cls: 'type-block' };
}

function getPreviewText(item) {
  const raw = String(item?.markdown || item?.path || item?.label || '').trim();
  return raw.replace(/\s+/g, ' ').slice(0, 110);
}

function isDisallowedPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return (
    payload.type === 'module-reorder' ||
    payload.type === 'tool-module' ||
    Boolean(payload.sourceShelfId)
  );
}

function isAcceptableDragEvent(e) {
  if (draggingShelfItemId) return false;
  const activePayload = store.state.activeDragPayload;
  if (activePayload) {
    return !isDisallowedPayload(activePayload);
  }
  const types = Array.from(e?.dataTransfer?.types || []);
  if (types.includes('application/x-sln-tool-module')) return false;
  return types.includes(DRAG_MIME) || types.includes('text/plain') || types.includes('text/uri-list');
}

function isPointerHoveringShelfOrIsland() {
  return isPointerInsideShelf || isPointerInsideIsland;
}

function clearCollapseTimer() {
  if (collapseTimer) {
    window.clearTimeout(collapseTimer);
    collapseTimer = 0;
  }
}

function clearHideTimer() {
  if (hideTimer) {
    window.clearTimeout(hideTimer);
    hideTimer = 0;
  }
}

function syncTriggerButtons() {
  document.querySelectorAll('.island-shelf-trigger').forEach((btn) => {
    btn.classList.toggle('is-open', isOpen);
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });
}

function syncShelfStateClasses() {
  if (!shelfEl) return;
  const showBanner = isDragInviting || shelfEl.classList.contains('is-drag-over');
  shelfEl.classList.toggle('is-open', isOpen);
  shelfEl.classList.toggle('is-pinned', pinnedOpen);
  shelfEl.classList.toggle('is-drag-inviting', isDragInviting);
  shelfEl.dataset.state = isOpen ? 'open' : 'collapsed';

  const bannerEl = shelfEl.querySelector('.island-shelf-drop-banner');
  if (bannerEl) {
    bannerEl.hidden = !showBanner;
  }
  syncTriggerButtons();
}

function openShelf({ byDrag = false, inviting = false } = {}) {
  const el = ensureShelfElement();
  if (!el) return;
  clearCollapseTimer();
  clearHideTimer();
  isOpen = true;
  if (byDrag) {
    autoCollapseArmed = true;
  }
  if (inviting) {
    isDragInviting = true;
  }
  el.hidden = false;
  el.removeAttribute('hidden');
  void el.offsetWidth;
  syncShelfStateClasses();
}

function collapseShelf({ force = false } = {}) {
  clearCollapseTimer();
  if (pinnedOpen && !force) return;
  isOpen = false;
  autoCollapseArmed = false;
  isDragInviting = false;
  if (shelfEl) {
    shelfEl.classList.remove('is-drag-over');
  }
  syncShelfStateClasses();
  clearHideTimer();
  hideTimer = window.setTimeout(() => {
    hideTimer = 0;
    if (!isOpen && shelfEl) {
      shelfEl.hidden = true;
    }
  }, HIDE_TRANSITION_MS);
}

function scheduleAutoCollapse() {
  clearCollapseTimer();
  if (pinnedOpen || isDragActive || isPointerHoveringShelfOrIsland() || !isOpen) return;
  collapseTimer = window.setTimeout(() => {
    collapseTimer = 0;
    if (!pinnedOpen && !isDragActive && !isPointerHoveringShelfOrIsland()) {
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

  // Remove any legacy right-edge fixed shelf tab
  const legacyShelf = document.getElementById('drag-shelf');
  if (legacyShelf && legacyShelf.id !== 'island-shelf-drawer') {
    legacyShelf.remove();
  }

  if (!shelfEl || !document.body.contains(shelfEl)) {
    shelfEl = document.getElementById('island-shelf-drawer');
    if (!shelfEl) {
      shelfEl = document.createElement('div');
      shelfEl.id = 'island-shelf-drawer';
      shelfEl.hidden = true;
      document.body.appendChild(shelfEl);
    }
    shelfEl.classList.add('island-shelf-drawer');
    shelfEl.setAttribute('data-drop-zone', 'drag-shelf');
    shelfEl.setAttribute('aria-label', '灵动岛暂存栏');
  }

  if (!shelfEl.querySelector('.island-shelf-header')) {
    shelfEl.innerHTML = `
      <div class="island-shelf-drop-banner" hidden>📥 松手暂存到灵动岛（默认剪切 · 按住 Ctrl 复制）</div>
      <header class="island-shelf-header">
        <div class="island-shelf-title-wrap">
          <span>📥 灵动岛暂存栏</span>
          <span class="island-shelf-count">0</span>
        </div>
        <div class="island-shelf-header-actions">
          <button type="button" class="pill-btn pill-btn-sm island-shelf-pin-btn" data-shelf-action="toggle-pin" title="固定展开（切换文件时不自动收起）" aria-pressed="false">
            ${icon('pin', 12)} 固定
          </button>
          <button type="button" class="pill-btn pill-btn-sm island-shelf-close-btn" data-shelf-action="collapse" title="收起暂存栏" aria-label="收起暂存栏">
            收起 ×
          </button>
        </div>
      </header>
      <div class="island-shelf-list" role="list"></div>
      <footer class="island-shelf-footer">
        <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-shelf-action="insert-all">⬇ 全部拼入当前笔记</button>
        <button type="button" class="pill-btn pill-btn-sm" data-shelf-action="clear-all">清空</button>
      </footer>
    `;
  }

  return shelfEl;
}

function renderShelf() {
  const el = ensureShelfElement();
  if (!el) return;

  const items = getShelfItems();
  const count = items.length;

  const countEl = el.querySelector('.island-shelf-count');
  if (countEl) {
    countEl.textContent = String(count);
  }

  const pinBtn = el.querySelector('.island-shelf-pin-btn');
  if (pinBtn) {
    pinBtn.classList.toggle('is-active', pinnedOpen);
    pinBtn.classList.toggle('pill-btn-primary', pinnedOpen);
    pinBtn.setAttribute('aria-pressed', pinnedOpen ? 'true' : 'false');
    pinBtn.title = pinnedOpen ? '已固定展开（点击取消固定）' : '固定展开（切换文件时不自动收起）';
  }

  const listEl = el.querySelector('.island-shelf-list');
  if (listEl) {
    if (count === 0) {
      listEl.innerHTML = `
        <div class="island-shelf-empty">
          暂无暂存内容，拖拽任意文本块、文件胶囊、AI 片段或闪念卡到此处（或顶部灵动岛）即可暂存
        </div>
      `;
    } else {
      listEl.innerHTML = items
        .map((item) => {
          const meta = getTypeMeta(item.type);
          const preview = getPreviewText(item);
          return `
            <div class="island-shelf-item ${meta.cls}" draggable="true" data-shelf-id="${escapeHtml(item.id)}" role="listitem">
              <div class="island-shelf-item-top">
                <span class="island-shelf-type-badge">${icon(meta.iconName, 11)} ${escapeHtml(meta.badge)}</span>
                <div class="island-shelf-item-actions">
                  <button type="button" class="island-shelf-item-btn" data-shelf-action="insert-item" data-shelf-id="${escapeHtml(item.id)}" title="插入到当前笔记（默认移出暂存栏，按住 Ctrl 复制）">插入</button>
                  <button type="button" class="island-shelf-item-btn is-remove" data-shelf-action="remove-item" data-shelf-id="${escapeHtml(item.id)}" title="移除" aria-label="移除暂存项">×</button>
                </div>
              </div>
              <div class="island-shelf-item-title" title="${escapeHtml(item.label || '')}">${escapeHtml(item.label || '未命名片段')}</div>
              ${preview ? `<div class="island-shelf-item-preview">${escapeHtml(preview)}</div>` : ''}
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

function handleDropIntoShelf(e, targetEl) {
  targetEl?.classList.remove('is-drag-over');
  shelfEl?.classList.remove('is-drag-over', 'is-drag-inviting');
  document.getElementById('dynamic-island')?.classList.remove('is-drag-over');

  if (draggingShelfItemId) return;
  const payload = readPayloadSafe(e);
  if (!payload || isDisallowedPayload(payload)) return;

  e.preventDefault();
  e.stopPropagation();

  const added = addShelfItem(payload);
  if (added) {
    if (
      payload.dragMode !== 'copy' &&
      !e.ctrlKey &&
      payload.sourceDocPath &&
      payload.sourceRawToken
    ) {
      store.emit('center:cut-source-token', {
        sourceDocPath: payload.sourceDocPath,
        sourceBlockStart: payload.sourceBlockStart,
        sourceRawToken: payload.sourceRawToken,
      });
    }

    triggerPulse();
    showToast('已暂存至灵动岛暂存栏', 'success', { duration: 1800 });
    isDragActive = false;
    isDragInviting = false;
    autoCollapseArmed = !pinnedOpen;
    syncShelfStateClasses();
    if (!pinnedOpen && !isPointerHoveringShelfOrIsland()) {
      scheduleAutoCollapse();
    }
  }
}

function bindShelfEvents() {
  const el = ensureShelfElement();
  if (!el) return;
  const islandEl = document.getElementById('dynamic-island');

  el.addEventListener('pointerenter', () => {
    isPointerInsideShelf = true;
    clearCollapseTimer();
  });

  el.addEventListener('pointerleave', () => {
    isPointerInsideShelf = false;
    if (autoCollapseArmed && !pinnedOpen && !isDragActive && !isPointerHoveringShelfOrIsland()) {
      scheduleAutoCollapse();
    }
  });

  if (islandEl) {
    islandEl.addEventListener('pointerenter', () => {
      isPointerInsideIsland = true;
      clearCollapseTimer();
    });

    islandEl.addEventListener('pointerleave', () => {
      isPointerInsideIsland = false;
      if (autoCollapseArmed && !pinnedOpen && !isDragActive && !isPointerHoveringShelfOrIsland()) {
        scheduleAutoCollapse();
      }
    });

    islandEl.addEventListener('dragover', (e) => {
      if (!isAcceptableDragEvent(e)) return;
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
      }
      clearCollapseTimer();
      islandEl.classList.add('is-drag-over');
      if (!isOpen) {
        openShelf({ byDrag: true, inviting: true });
      }
    });

    islandEl.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && islandEl.contains(e.relatedTarget)) return;
      islandEl.classList.remove('is-drag-over');
    });

    islandEl.addEventListener('drop', (e) => handleDropIntoShelf(e, islandEl));
  }

  el.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-shelf-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.shelfAction;

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
        sourceShelfId: item.id,
        dragMode: e.ctrlKey ? 'copy' : 'move',
      });
      if (!e.ctrlKey && getShelfItems().some((it) => it.id === item.id)) {
        consumeShelfItemSafe(item.id);
      }
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
      store.emit('shelf:insert-current', { items: [...items], clearAfter: true });
      return;
    }

    if (action === 'clear-all') {
      clearAllShelfItems();
      showToast('已清空灵动岛暂存栏', 'info', { duration: 1500 });
    }
  });

  // Dragging staged cards OUT to notes or AI panel (default = move)
  el.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.island-shelf-item[data-shelf-id]');
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
      sourceShelfId: item.id,
      dragMode: e.ctrlKey ? 'copy' : 'move',
    });
    card.classList.add('is-dragging');
    store.emit('drag:active', true);
  });

  el.addEventListener('dragend', (e) => {
    const card = e.target.closest('.island-shelf-item[data-shelf-id]');
    card?.classList.remove('is-dragging');
    draggingShelfItemId = null;
    clearPayloadSafe();
    store.emit('drag:active', false);
  });

  // HTML5 drop INTO #island-shelf-drawer
  el.addEventListener('dragover', (e) => {
    if (!isAcceptableDragEvent(e)) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
    }
    clearCollapseTimer();
    el.classList.add('is-drag-over');
    syncShelfStateClasses();
  });

  el.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    el.classList.remove('is-drag-over');
    syncShelfStateClasses();
  });

  el.addEventListener('drop', (e) => handleDropIntoShelf(e, el));

  // Click outside drawer & Dynamic Island closes drawer when not pinned
  document.addEventListener('click', (e) => {
    if (!isOpen || pinnedOpen) return;
    const curIsland = document.getElementById('dynamic-island');
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (
      path.includes(el) ||
      (curIsland && path.includes(curIsland)) ||
      el.contains(e.target) ||
      curIsland?.contains(e.target)
    ) {
      return;
    }
    collapseShelf({ force: false });
  });

  // Auto-reveal on any acceptable HTML5 dragenter across window
  window.addEventListener('dragenter', (e) => {
    if (!isAcceptableDragEvent(e)) return;
    isDragActive = true;
    openShelf({ byDrag: true, inviting: true });
  });

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget !== null) return;
    if (e.clientX > 0 && e.clientY > 0 && e.clientX < window.innerWidth && e.clientY < window.innerHeight) {
      return;
    }
    isDragActive = false;
    isDragInviting = false;
    el.classList.remove('is-drag-over', 'is-drag-inviting');
    document.getElementById('dynamic-island')?.classList.remove('is-drag-over');
    syncShelfStateClasses();
    if (autoCollapseArmed && !pinnedOpen && !isPointerHoveringShelfOrIsland()) {
      scheduleAutoCollapse();
    }
  });

  window.addEventListener('dragend', () => {
    isDragActive = false;
    isDragInviting = false;
    el.classList.remove('is-drag-over', 'is-drag-inviting');
    document.getElementById('dynamic-island')?.classList.remove('is-drag-over');
    syncShelfStateClasses();
    if (autoCollapseArmed && !pinnedOpen && !isPointerHoveringShelfOrIsland()) {
      scheduleAutoCollapse();
    }
  });

  window.addEventListener('drop', () => {
    isDragActive = false;
    isDragInviting = false;
    el.classList.remove('is-drag-over', 'is-drag-inviting');
    document.getElementById('dynamic-island')?.classList.remove('is-drag-over');
    syncShelfStateClasses();
    if (autoCollapseArmed && !pinnedOpen && !isPointerHoveringShelfOrIsland()) {
      scheduleAutoCollapse();
    }
  });
}

/**
 * Initialize the Dynamic Island NotchDrop Staging Pocket.
 */
export function initDragShelf() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;

  ensureShelfElement();
  bindShelfEvents();
  renderShelf();

  store.on('drag:active', (active) => {
    if (active) {
      if (draggingShelfItemId) return;
      if (isDisallowedPayload(store.state.activeDragPayload)) return;
      isDragActive = true;
      openShelf({ byDrag: true, inviting: true });
    } else {
      isDragActive = false;
      isDragInviting = false;
      shelfEl?.classList.remove('is-drag-over', 'is-drag-inviting');
      document.getElementById('dynamic-island')?.classList.remove('is-drag-over');
      syncShelfStateClasses();
      if (!pinnedOpen && !isPointerHoveringShelfOrIsland()) {
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
      isDragInviting = false;
      openShelf({ byDrag: false, inviting: false });
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
