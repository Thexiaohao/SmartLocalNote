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
  openSheet,
  closeSheet,
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
let lastPointerDownInsideDrawer = false;

function ensureV72DrawerStyles() {
  if (typeof document === 'undefined' || document.getElementById('sln-v72-drawer-styles')) return;
  const style = document.createElement('style');
  style.id = 'sln-v72-drawer-styles';
  style.textContent = `
    .island-shelf-drawer {
      width: min(360px, 92vw);
      max-height: 320px;
    }
    .island-shelf-list {
      grid-template-columns: 1fr;
      padding: 8px;
      gap: 6px;
    }
    .island-standalone-float {
      z-index: 1125;
    }
    .island-standalone-float[hidden] {
      display: none !important;
    }
    .island-float-body {
      padding: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .floating-win-close-btn {
      width: 24px;
      height: 24px;
      font-size: 12px;
      flex-shrink: 0;
    }
    .island-trash-panel, .island-stickies-panel {
      display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden;
      max-height: none !important; padding: 0 !important; gap: 0 !important;
    }
    .island-trash-top {
      padding: 10px 12px; border-bottom: 1px solid var(--border-hairline);
      display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; flex-shrink: 0;
    }
    .island-trash-purge-wrap { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-secondary); }
    .island-trash-purge-select { height: 24px; padding: 0 6px; font-size: 11px; width: auto; min-width: 92px; }
    .island-trash-list, .island-stickies-list {
      flex: 1 1 auto; min-height: 80px; overflow-y: auto; padding: 8px 10px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .island-trash-empty, .island-stickies-empty {
      padding: 24px 12px; text-align: center; font-size: 12px; color: var(--text-tertiary); line-height: 1.55;
    }
    .island-trash-row, .island-sticky-row {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 7px 10px; border-radius: 11px; background: var(--bg-subtle); border: 1px solid var(--border-hairline);
    }
    .island-trash-row:hover, .island-sticky-row:hover { background: var(--bg-hover); }
    .island-trash-row-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
    .island-trash-row-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .island-trash-kind-badge {
      padding: 1px 6px; border-radius: 9999px; font-size: 10px; font-weight: 600;
      background: var(--accent-soft); color: var(--accent); flex-shrink: 0;
    }
    .island-trash-kind-badge.kind-sticky { background: rgba(245,158,11,0.16); color: #D97706; }
    .island-trash-kind-badge.kind-mindmap { background: rgba(139,92,246,0.16); color: #7C3AED; }
    .island-trash-row-title {
      font-size: 12px; font-weight: 600; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .island-trash-row-meta { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-tertiary); }
    .island-trash-row-actions { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .island-trash-footer {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 7px 12px; border-top: 1px solid var(--border-hairline); background: var(--bg-subtle); flex-shrink: 0;
    }
    .island-trash-stats { font-size: 11px; color: var(--text-secondary); }
    .pill-btn.is-danger { color: var(--danger, #FF3B30); }
    .pill-btn.is-danger:hover:not(:disabled) { background: var(--danger-soft, rgba(255,59,48,0.12)); }
    /* Portable Trash Dock dual drop zones (#4) */
    #portable-trash-dock { max-width: min(560px, calc(100vw - 24px)); border-radius: 20px; }
    .portable-trash-split {
      display: flex; align-items: center; gap: 8px; padding: 7px 10px;
    }
    .portable-trash-zone {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
      padding: 6px 12px; border-radius: 13px; border: 1.5px dashed var(--border-hairline);
      background: var(--bg-subtle); cursor: copy; min-width: 144px; text-align: center;
      transition: transform 0.16s ease, background-color 0.16s ease, border-color 0.16s ease;
    }
    .portable-trash-zone.is-app-trash { border-color: rgba(245,158,11,0.45); background: rgba(245,158,11,0.08); }
    .portable-trash-zone.is-app-trash.is-drag-over {
      transform: scale(1.04); border-style: solid; border-color: #F59E0B; background: rgba(245,158,11,0.22);
    }
    .portable-trash-zone.is-system-trash { border-color: rgba(255,59,48,0.45); background: rgba(255,59,48,0.08); }
    .portable-trash-zone.is-system-trash.is-drag-over {
      transform: scale(1.04); border-style: solid; border-color: var(--danger, #FF3B30); background: rgba(255,59,48,0.22);
    }
    .portable-trash-zone-title { font-size: 12px; font-weight: 600; color: var(--text-primary); white-space: nowrap; }
    .portable-trash-zone-sub { font-size: 10px; color: var(--text-tertiary); white-space: nowrap; }
    .portable-trash-view-btn { height: 28px; padding: 0 10px; font-size: 11px; flex-shrink: 0; }
  `;
  if (document.head.firstChild) {
    document.head.insertBefore(style, document.head.firstChild);
  } else {
    document.head.appendChild(style);
  }
}

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

function isDisallowedGlobalDrag(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return payload.type === 'module-reorder' || payload.type === 'tool-module';
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

function renderDropBanner() {
  // Dragging no longer expands the shelf drawer; #dynamic-island morphs into .island-compact-drop-pill.
}

function clearDropZoneHighlights() {
  shelfEl?.classList.remove('is-drag-over', 'is-drag-inviting');
  shelfEl?.querySelectorAll('[data-drop-zone].is-drag-over').forEach((z) => {
    z.classList.remove('is-drag-over');
  });
  const islandEl = document.getElementById('dynamic-island');
  if (islandEl) {
    islandEl.classList.remove('is-drag-over');
    islandEl.querySelectorAll('.is-drag-over').forEach((z) => z.classList.remove('is-drag-over'));
  }
}

function syncShelfStateClasses() {
  if (!shelfEl) return;
  shelfEl.classList.toggle('is-open', isOpen);
  shelfEl.classList.toggle('is-pinned', pinnedOpen);
  shelfEl.classList.remove('is-drag-inviting');
  shelfEl.dataset.state = isOpen ? 'open' : 'collapsed';
  syncTriggerButtons();
}

function openShelf({ byDrag = false } = {}) {
  const el = ensureShelfElement();
  if (!el) return;
  const wasOpen = isOpen;
  clearCollapseTimer();
  clearHideTimer();
  isOpen = true;
  if (byDrag && !wasOpen) {
    autoCollapseArmed = true;
  }
  isDragInviting = false;
  el.hidden = false;
  el.removeAttribute('hidden');
  void el.offsetWidth;
  syncShelfStateClasses();
  store.emit('island:drawer-state', { open: true, tab: 'shelf' });
}

function collapseShelf({ force = false } = {}) {
  clearCollapseTimer();
  if (pinnedOpen && !force) return;
  isOpen = false;
  autoCollapseArmed = false;
  isDragInviting = false;
  clearDropZoneHighlights();
  syncShelfStateClasses();
  store.emit('island:drawer-state', { open: false, tab: 'shelf' });
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
    shelfEl.setAttribute('aria-label', '灵动岛暂存舱');
  }

  if (!shelfEl.querySelector('.island-shelf-header')) {
    shelfEl.innerHTML = `
      <header class="island-shelf-header">
        <div class="island-shelf-title-wrap">
          <span>📥 暂存舱</span>
          <span class="island-shelf-count">0</span>
        </div>
        <div class="island-shelf-header-actions">
          <button type="button" class="pill-btn pill-btn-sm island-shelf-pin-btn" data-shelf-action="toggle-pin" title="固定展开（切换文件时不自动收起）" aria-pressed="false">
            ${icon('pin', 12)} 固定
          </button>
          <button type="button" class="pill-btn pill-btn-sm island-shelf-close-btn" data-shelf-action="collapse" title="收起暂存舱" aria-label="收起暂存舱">
            ✕
          </button>
        </div>
      </header>
      <div class="island-shelf-list" role="list"></div>
      <footer class="island-shelf-footer">
        <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-shelf-action="insert-all">⬇ 全部拼入笔记</button>
        <button type="button" class="pill-btn pill-btn-sm" data-shelf-action="clear-all">清空</button>
      </footer>
    `;
  }

  return shelfEl;
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return '刚刚';
  const ts = new Date(isoStr).getTime();
  if (!Number.isFinite(ts)) return '刚刚';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  const days = Math.floor(diffSec / 86400);
  if (days < 30) return `${days} 天前`;
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function getTrashKindMeta(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'file') return { label: '文件', cls: 'kind-file' };
  if (k === 'folder') return { label: '文件夹', cls: 'kind-folder' };
  if (k === 'sticky') return { label: '闪念', cls: 'kind-sticky' };
  if (k === 'mindmap-card') return { label: '脑图卡片', cls: 'kind-mindmap' };
  if (k === 'block' || k === 'lp-block' || k === 'snippet') return { label: '段落', cls: 'kind-snippet' };
  if (k === 'workspace') return { label: '场景', cls: 'kind-workspace' };
  if (k === 'staging') return { label: '暂存', cls: 'kind-staging' };
  if (k === 'app' || k === 'app-portal') return { label: '软件', cls: 'kind-app' };
  if (k === 'ai' || k === 'summary' || k === 'chat') return { label: 'AI 片段', cls: 'kind-ai' };
  return { label: k || '条目', cls: 'kind-other' };
}

function renderTrashPanel() {
  const panel = document.getElementById('island-trash-panel');
  if (!panel) return;

  const trashState = store.state.trash || {
    items: [],
    settings: { mode: 'system', auto_purge_days: 15 },
    stats: { count: 0, total_bytes: 0 },
  };
  const items = Array.isArray(trashState.items) ? trashState.items : [];
  const purgeDays = Number.isFinite(Number(trashState.settings?.auto_purge_days))
    ? Number(trashState.settings.auto_purge_days)
    : 15;
  const totalBytes = Number(trashState.stats?.total_bytes) || items.reduce((sum, it) => sum + (Number(it?.size_bytes) || 0), 0);

  const listHtml = items.length === 0
    ? `<div class="island-trash-empty">软件内置回收站暂无记录，拖拽文件、闪念、脑图卡片或段落到内置回收站即可安全暂存并随时还原</div>`
    : items
        .map((it) => {
          const meta = getTrashKindMeta(it.kind);
          const id = String(it.id || '');
          const title = String(it.title || '未命名条目');
          return `
            <div class="island-trash-row" data-trash-id="${escapeHtml(id)}" role="listitem">
              <div class="island-trash-row-main">
                <div class="island-trash-row-head">
                  <span class="island-trash-kind-badge ${meta.cls}">${escapeHtml(meta.label)}</span>
                  <span class="island-trash-row-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
                </div>
                <div class="island-trash-row-meta">
                  <span>${escapeHtml(formatRelativeTime(it.deleted_at))}</span>
                  <span>·</span>
                  <span>${escapeHtml(formatBytes(it.size_bytes))}</span>
                </div>
              </div>
              <div class="island-trash-row-actions">
                <button type="button" class="pill-btn pill-btn-sm" data-trash-item-action="restore" data-trash-id="${escapeHtml(id)}" title="还原此条目">↩ 还原</button>
                <button type="button" class="pill-btn pill-btn-sm is-danger" data-trash-item-action="delete" data-trash-id="${escapeHtml(id)}" title="永久清除">✕ 清除</button>
              </div>
            </div>
          `;
        })
        .join('');

  panel.innerHTML = `
    <div class="island-trash-top">
      <label class="island-trash-purge-wrap">
        <span>内置回收站自动清理周期</span>
        <select class="apple-select island-trash-purge-select" data-trash-action="purge-days" aria-label="内置回收站自动清理周期">
          <option value="3" ${purgeDays === 3 ? 'selected' : ''}>3天</option>
          <option value="7" ${purgeDays === 7 ? 'selected' : ''}>7天</option>
          <option value="15" ${purgeDays === 15 ? 'selected' : ''}>15天</option>
          <option value="30" ${purgeDays === 30 ? 'selected' : ''}>30天</option>
          <option value="0" ${purgeDays === 0 ? 'selected' : ''}>从不</option>
        </select>
      </label>
      <button type="button" class="pill-btn pill-btn-sm is-danger" data-trash-action="empty-all" ${items.length === 0 ? 'disabled' : ''}>🧹 手动清空</button>
    </div>
    <div class="island-trash-list" role="list">${listHtml}</div>
    <footer class="island-trash-footer">
      <span class="island-trash-stats">软件托管共 ${items.length} 条${totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : ''}</span>
      <span class="island-trash-stats">Windows 系统回收站请前往桌面查看</span>
    </footer>
  `;
}

function bindTrashPanelEvents() {
  const panel = document.getElementById('island-trash-panel');
  if (!panel || panel.dataset.trashBound === '1') return;
  panel.dataset.trashBound = '1';

  panel.addEventListener('click', async (e) => {
    const itemBtn = e.target.closest('[data-trash-item-action]');
    if (itemBtn) {
      e.stopPropagation();
      const action = itemBtn.dataset.trashItemAction;
      const id = itemBtn.dataset.trashId;
      if (!id) return;
      const item = (store.state.trash?.items || []).find((it) => it.id === id);
      const title = item?.title || '条目';
      itemBtn.disabled = true;
      try {
        if (action === 'restore') {
          await store.restoreTrashItem?.(id);
          showToast(`已还原「${title}」`, 'success');
        } else if (action === 'delete') {
          await store.emptyTrash?.(id);
          showToast(`已永久清除「${title}」`, 'info');
        }
      } catch (err) {
        showToast(`操作失败：${err?.message || '未知错误'}`, 'error');
      } finally {
        if (itemBtn.isConnected) itemBtn.disabled = false;
      }
      return;
    }

    const emptyBtn = e.target.closest('[data-trash-action="empty-all"]');
    if (emptyBtn) {
      e.stopPropagation();
      const count = (store.state.trash?.items || []).length;
      if (count === 0) return;
      openSheet({
        title: '清空软件内置回收站',
        bodyHtml: `<p style="font-size:13px;color:var(--text-primary);line-height:1.55;">确定要永久清除内置回收站中的全部 <strong>${count}</strong> 条记录（含暂存文件与闪念/卡片片段）吗？此操作不可撤销。</p>`,
        footerHtml: `
          <button type="button" class="pill-btn" id="trash-empty-cancel">取消</button>
          <button type="button" class="pill-btn pill-btn-primary is-danger" id="trash-empty-confirm">确认永久清空</button>
        `,
        onMount(card) {
          card.querySelector('#trash-empty-cancel')?.addEventListener('click', closeSheet);
          const confirmBtn = card.querySelector('#trash-empty-confirm');
          confirmBtn?.addEventListener('click', async () => {
            confirmBtn.disabled = true;
            try {
              await store.emptyTrash?.('');
              closeSheet();
              showToast('已清空内置回收站', 'info');
            } catch (err) {
              showToast(`清空失败：${err?.message || '未知错误'}`, 'error');
            } finally {
              if (confirmBtn.isConnected) confirmBtn.disabled = false;
            }
          });
        },
      });
    }
  });

  panel.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-trash-action="purge-days"]');
    if (!sel) return;
    e.stopPropagation();
    const days = Number(sel.value);
    try {
      await store.updateTrashSettings?.({ auto_purge_days: Number.isFinite(days) ? days : 15 });
      showToast(days === 0 ? '已设为从不自动清理' : `已设为 ${days} 天自动清理`, 'success');
    } catch (err) {
      showToast(`更新自动清理周期失败：${err?.message || '未知错误'}`, 'error');
    }
  });
}

async function handleTrashDropPayload(payload, mode = 'app') {
  if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) return;
  clearPayloadSafe();
  store.endGlobalDrag?.();
  isDragActive = false;
  isDragInviting = false;
  clearDropZoneHighlights();
  syncShelfStateClasses();

  const targetMode = mode === 'system' ? 'system' : 'app';
  const kind = String(payload.kind || payload.type || '').trim();
  const virtualKinds = new Set([
    'snippet', 'block', 'lp-block', 'sticky', 'ai', 'summary', 'chat',
    'mindmap-card', 'workspace', 'app', 'app-portal', 'capsule', 'staging',
  ]);

  try {
    if (payload.sourceShelfId) {
      removeShelfItem(payload.sourceShelfId);
      await store.trashVirtualItem?.({
        kind: 'staging',
        title: payload.label || payload.title || '暂存片段',
        payload,
        source_path: payload.path || payload.sourceDocPath || '',
      });
      store.emit('trash:consumed-drag', payload);
      showToast('已将暂存片段移入内置回收站', 'info');
    } else if (payload.path && !virtualKinds.has(kind)) {
      await store.trashFile?.(payload.path, targetMode);
      store.emit('trash:consumed-drag', payload);
    } else {
      const title = payload.title || payload.label || payload.name || (kind === 'sticky' ? '闪念卡' : '内容片段');
      await store.trashVirtualItem?.({
        kind: kind || 'snippet',
        title,
        payload,
        source_path: payload.sourceDocPath || payload.path || '',
      });
      store.emit('trash:consumed-drag', payload);
      showToast(
        targetMode === 'system'
          ? '虚拟片段已自动移入内置回收站（可在内置回收站还原）'
          : '已移入内置回收站（可在内置回收站还原）',
        'info'
      );
    }
  } catch (err) {
    showToast(`移入回收站失败：${err?.message || '未知错误'}`, 'error');
  } finally {
    if (!pinnedOpen && !isPointerHoveringShelfOrIsland()) {
      autoCollapseArmed = true;
      scheduleAutoCollapse();
    }
  }
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
  clearDropZoneHighlights();

  if (draggingShelfItemId) return;
  const payload = readPayloadSafe(e);
  if (!payload || isDisallowedPayload(payload)) return;

  e.preventDefault();
  e.stopPropagation();

  const added = addShelfItem(payload);
  store.endGlobalDrag?.();
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
    if (autoCollapseArmed && !pinnedOpen && !isPointerHoveringShelfOrIsland()) {
      scheduleAutoCollapse();
    }
    syncShelfStateClasses();
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
      const trashZone = e.target.closest?.('[data-drop-zone="app-trash"]');
      const shelfZone = e.target.closest?.('[data-drop-zone="drag-shelf"]');
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = trashZone ? 'move' : (e.ctrlKey ? 'copy' : 'move');
      }
      clearCollapseTimer();
      islandEl.classList.add('is-drag-over');
      islandEl.querySelectorAll('.island-compact-drop-half').forEach((half) => half.classList.remove('is-drag-over'));
      if (trashZone) {
        trashZone.classList.add('is-drag-over');
      } else if (shelfZone) {
        shelfZone.classList.add('is-drag-over');
      } else {
        islandEl.querySelector('[data-drop-zone="drag-shelf"]')?.classList.add('is-drag-over');
      }
    });

    islandEl.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && islandEl.contains(e.relatedTarget)) return;
      islandEl.classList.remove('is-drag-over');
      islandEl.querySelectorAll('.is-drag-over').forEach((z) => z.classList.remove('is-drag-over'));
    });

    islandEl.addEventListener('drop', (e) => {
      const trashZone = e.target.closest?.('[data-drop-zone="app-trash"]');
      if (trashZone) {
        e.preventDefault();
        e.stopPropagation();
        const payload = readPayloadSafe(e) || store.getGlobalDrag?.();
        draggingShelfItemId = null;
        handleTrashDropPayload(payload, 'app');
        return;
      }
      handleDropIntoShelf(e, islandEl);
    });
  }

  el.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-shelf-action]');
    if (!actionEl) return;
    e.stopPropagation();
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
      let isCopyDefault = false;
      try {
        isCopyDefault = localStorage.getItem('sln_drag_default_mode') === 'copy';
      } catch {
        // ignore
      }
      const isCopyMode = isCopyDefault ? !e.shiftKey : Boolean(e.ctrlKey || e.metaKey);
      store.emit('shelf:insert-current', {
        markdown: item.markdown,
        label: item.label,
        sourceShelfId: item.id,
        dragMode: isCopyMode ? 'copy' : 'move',
      });
      if (!isCopyMode && getShelfItems().some((it) => it.id === item.id)) {
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

  // Dragging staged cards OUT to notes, AI panel, or trash (default = move)
  el.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.island-shelf-item[data-shelf-id]');
    if (!card) return;
    const id = card.dataset.shelfId;
    const item = getShelfItems().find((it) => it.id === id);
    if (!item) {
      e.preventDefault();
      return;
    }
    let isCopyDefault = false;
    try {
      isCopyDefault = localStorage.getItem('sln_drag_default_mode') === 'copy';
    } catch {
      // ignore
    }
    const isCopyMode = isCopyDefault ? !e.shiftKey : Boolean(e.ctrlKey || e.metaKey);
    draggingShelfItemId = item.id;
    const dragPayload = {
      type: 'shelf-item',
      kind: 'staging',
      label: item.label,
      title: item.label,
      markdown: item.markdown,
      path: item.path || '',
      sourceShelfId: item.id,
      dragMode: isCopyMode ? 'copy' : 'move',
    };
    writePayloadSafe(e, dragPayload);
    store.beginGlobalDrag?.(dragPayload);
    card.classList.add('is-dragging');
    store.emit('drag:active', true);
  });

  el.addEventListener('dragend', (e) => {
    const card = e.target.closest('.island-shelf-item[data-shelf-id]');
    card?.classList.remove('is-dragging');
    draggingShelfItemId = null;
    clearPayloadSafe();
    store.endGlobalDrag?.();
    store.emit('drag:active', false);
  });

  // HTML5 drop INTO #island-shelf-drawer (supports dual drop bar: drag-shelf vs trash)
  el.addEventListener('dragover', (e) => {
    const trashHalf = e.target.closest?.('[data-drop-zone="trash"]');
    if (trashHalf) {
      const globalDrag = store.getGlobalDrag?.();
      if (isDisallowedGlobalDrag(globalDrag)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
      clearCollapseTimer();
      trashHalf.classList.add('is-drag-over');
      el.querySelector('.island-drop-shelf')?.classList.remove('is-drag-over');
      el.classList.add('is-drag-over');
      syncShelfStateClasses();
      return;
    }

    if (!isAcceptableDragEvent(e)) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
    }
    clearCollapseTimer();
    el.querySelector('[data-drop-zone="trash"]')?.classList.remove('is-drag-over');
    el.querySelector('.island-drop-shelf')?.classList.add('is-drag-over');
    el.classList.add('is-drag-over');
    syncShelfStateClasses();
  });

  el.addEventListener('dragleave', (e) => {
    const trashHalf = e.target.closest?.('[data-drop-zone="trash"]');
    if (trashHalf && (!e.relatedTarget || !trashHalf.contains(e.relatedTarget))) {
      trashHalf.classList.remove('is-drag-over');
    }
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    clearDropZoneHighlights();
    syncShelfStateClasses();
  });

  el.addEventListener('drop', (e) => {
    const trashHalf = e.target.closest?.('[data-drop-zone="trash"]');
    if (trashHalf) {
      e.preventDefault();
      e.stopPropagation();
      const shelfItemBackup = draggingShelfItemId
        ? getShelfItems().find((it) => it.id === draggingShelfItemId)
        : null;
      const payload =
        readPayloadSafe(e) ||
        store.getGlobalDrag?.() ||
        (shelfItemBackup
          ? { ...shelfItemBackup, type: 'shelf-item', kind: 'staging', sourceShelfId: shelfItemBackup.id }
          : null);
      draggingShelfItemId = null;
      handleTrashDropPayload(payload);
      return;
    }
    handleDropIntoShelf(e, el);
  });

  // Track pointerdown inside drawer/island so synchronous re-renders on click don't trigger outside-close
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target;
      lastPointerDownInsideDrawer = Boolean(
        t instanceof Element &&
          t.closest('#island-shelf-drawer, #dynamic-island, .island-hub-btn, .island-hub-quick-btn')
      );
    },
    { capture: true }
  );

  // Click outside drawer & Dynamic Island closes drawer when not pinned
  document.addEventListener('click', (e) => {
    if (!isOpen || pinnedOpen) return;
    if (lastPointerDownInsideDrawer) {
      lastPointerDownInsideDrawer = false;
      return;
    }
    const target = e.target;
    if (target instanceof Element) {
      if (
        target.closest(
          '#island-shelf-drawer, #dynamic-island, #sheet-overlay, #context-menu, #capsule-context-menu, #module-context-menu, #portable-trash-dock, .sticky-card'
        ) ||
        target.tagName === 'SELECT' ||
        target.tagName === 'OPTION'
      ) {
        return;
      }
    }
    const curIsland = document.getElementById('dynamic-island');
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (
      path.includes(el) ||
      (curIsland && path.includes(curIsland)) ||
      el.contains(target) ||
      curIsland?.contains(target)
    ) {
      return;
    }
    collapseShelf({ force: false });
  });

  // Track drag active state WITHOUT ever auto-opening #island-shelf-drawer (#3)
  window.addEventListener('dragenter', (e) => {
    if (!isAcceptableDragEvent(e)) return;
    isDragActive = true;
  });

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget !== null) return;
    if (e.clientX > 0 && e.clientY > 0 && e.clientX < window.innerWidth && e.clientY < window.innerHeight) {
      return;
    }
    isDragActive = false;
    isDragInviting = false;
    clearDropZoneHighlights();
    syncShelfStateClasses();
  });

  window.addEventListener('dragend', () => {
    isDragActive = false;
    isDragInviting = false;
    clearDropZoneHighlights();
    syncShelfStateClasses();
  });

  window.addEventListener('drop', () => {
    isDragActive = false;
    isDragInviting = false;
    clearDropZoneHighlights();
    syncShelfStateClasses();
  });
}

/**
 * Initialize the Dynamic Island NotchDrop Staging Pocket & Built-in Trash Panel.
 */
export function initDragShelf() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;

  ensureV72DrawerStyles();
  ensureShelfElement();
  bindShelfEvents();
  bindTrashPanelEvents();
  renderShelf();
  renderTrashPanel();

  // #3: During drag, #dynamic-island morphs in-place into .island-compact-drop-pill; NEVER open drawer!
  store.on('drag:global-start', (payload) => {
    if (isDisallowedGlobalDrag(payload)) return;
    isDragActive = true;
  });

  store.on('drag:global-end', () => {
    isDragActive = false;
    isDragInviting = false;
    clearDropZoneHighlights();
    syncShelfStateClasses();
  });

  store.on('drag:active', (active) => {
    if (active) {
      if (draggingShelfItemId) return;
      if (isDisallowedPayload(store.state.activeDragPayload)) return;
      isDragActive = true;
    } else {
      isDragActive = false;
      isDragInviting = false;
      clearDropZoneHighlights();
      syncShelfStateClasses();
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

  store.on('island:switch-tab', (tabName) => {
    if (tabName === 'stickies' || tabName === 'trash') {
      if (isOpen && !pinnedOpen) {
        collapseShelf({ force: false });
      }
      if (tabName === 'trash') {
        store.refreshTrash?.().catch(() => {});
        renderTrashPanel();
      }
      return;
    }
    ensureShelfElement();
    clearCollapseTimer();
    clearHideTimer();
    isOpen = true;
    autoCollapseArmed = false;
    isDragInviting = false;
    syncShelfStateClasses();
    store.emit('island:drawer-state', { open: true, tab: 'shelf' });
  });

  store.on('island:close-drawer', () => {
    pinnedOpen = false;
    collapseShelf({ force: true });
    renderShelf();
  });

  store.on('island:tab-change', (tab) => {
    if (tab === 'trash') {
      store.refreshTrash?.().catch(() => {});
      renderTrashPanel();
    }
  });

  store.on('shelf:add-item', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const normalized = {
      ...payload,
      type: String(payload.type || payload.kind || 'snippet'),
      label: String(payload.label || payload.title || payload.name || '').trim(),
      markdown: String(payload.markdown ?? payload.content ?? payload.text ?? '').trim(),
      path: String(payload.path || payload.sourceDocPath || '').trim(),
    };
    if (!normalized.markdown && !normalized.path && !normalized.url) return;
    const added = addShelfItem(normalized);
    if (added) {
      triggerPulse();
      if (!payload.silentToast) {
        showToast(`已将「${normalized.label || '片段'}」暂存到灵动岛`, 'success', { duration: 1800 });
      }
    }
  });

  store.on('shelf:changed', () => {
    renderShelf();
    if (isOpen) {
      triggerPulse();
    }
  });

  store.on('trash:updated', () => {
    renderTrashPanel();
  });
}
