/**
 * SmartLocalNote - Floating Tinted-Paper Stickies (V6) & Scoped Center Context Menu
 *  - V6 crisp card aesthetic with --sticky-accent top bar + 6 preset swatches + custom hex color picker
 *  - Incremental DOM reconciliation preserving textarea focus, selection, and scrollTop
 *  - 60fps dragging & viewport-clamped resizing with setPointerCapture + body.is-dragging-sticky (PDF iframe safe)
 *  - Pin lock (sticky.pinned), region-aware magnetic edge auto-arrange, and lockstep stack move/resize
 *  - Adaptive unified stack sizing (origW/origH preserved & restored) + multi-step merge undo
 *  - Dock toolbar (#sticky-dock-pill) for restoring, undoing merge, tiling, stacking, and spawning
 *  - Drag-to-note (<span draggable="true">) integrated with store DragPayload & Dynamic Island Shelf
 *
 * Exports: initStickies, spawnStickyNote, undoLastStackMerge.
 */

import {
  store,
  escapeHtml,
  showToast,
  openSheet,
  closeSheet,
  copyInternal,
  setDragPayload,
  clearDragPayload,
} from './store.js';
import { api } from './api_client.js';
import { icon } from './icons.js';

const STICKIES_STORAGE_KEY = 'sln_stickies';
const STICKY_COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'slate'];
const STICKY_COLOR_LABELS = {
  yellow: '琥珀黄',
  blue: '苹果蓝',
  green: '翡翠绿',
  pink: '珊瑚粉',
  purple: '薰衣草紫',
  slate: '极简灰',
};
const STICKY_COLOR_SWATCHES = {
  yellow: '#F59E0B',
  blue: '#0A84FF',
  green: '#10B981',
  pink: '#F43F5E',
  purple: '#8B5CF6',
  slate: '#64748B',
};
const VALID_ZONES = new Set(['free', 'left', 'right', 'top', 'bottom']);

const DEFAULT_W = 280;
const DEFAULT_H = 210;
const MIN_W = 220;
const MAX_W = 520;
const MIN_H = 160;
const MAX_H = 460;

const TOP_BAR_SAFE_Y = 60;
const VIEWPORT_PAD = 12;
const EDGE_SNAP_DIST = 56;
const STACK_CASCADE_STEP = 28;
const STACK_EXPAND_GAP = 10;

const MERGE_UNDO_MAX = 5;
const MERGE_UNDO_DOCK_MS = 8000;
const MERGE_UNDO_KEY_MS = 12000;

let initialized = false;
let stickies = [];
let layerEl = null;
let menuEl = null;
let snapPreviewEl = null;
let zCounter = 1;
let lastPinToastAt = 0;
let lastMergeUndo = [];
let mergeUndoDockTimer = 0;
const trashingStickyIds = new Set();

function ensureV72StickiesStyles() {
  if (typeof document === 'undefined' || document.getElementById('sln-v72-stickies-styles')) return;
  const style = document.createElement('style');
  style.id = 'sln-v72-stickies-styles';
  style.textContent = `
    .island-stickies-toolbar {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      padding: 10px 12px 8px; border-bottom: 1px solid var(--border-hairline); flex-shrink: 0;
    }
    .island-stickies-toolbar .pill-btn.is-undo-active {
      background: var(--accent-soft); color: var(--accent); border-color: rgba(0,122,255,0.3);
    }
    .island-stickies-list {
      flex: 1 1 auto; min-height: 80px; overflow-y: auto; padding: 8px 10px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .island-sticky-row {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 7px 10px; border-radius: 11px; background: var(--bg-subtle);
      border: 1px solid var(--border-hairline); cursor: pointer;
      transition: background-color 0.16s ease, border-color 0.16s ease;
    }
    .island-sticky-row:hover { background: var(--bg-hover); border-color: rgba(0,122,255,0.28); }
    .island-sticky-row-main { min-width: 0; flex: 1; display: flex; align-items: center; gap: 8px; }
    .island-sticky-dot { width: 9px; height: 9px; border-radius: 9999px; flex-shrink: 0; }
    .island-sticky-text-wrap { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .island-sticky-title {
      font-size: 12px; font-weight: 600; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .island-sticky-sub {
      font-size: 10.5px; color: var(--text-tertiary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .island-sticky-badges { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .island-sticky-badge {
      padding: 1px 6px; border-radius: 9999px; font-size: 10px; font-weight: 600;
      background: var(--bg-island); border: 1px solid var(--border-hairline); color: var(--text-secondary);
    }
    .sticky-ctx-color-row {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 6px 10px; font-size: 12.5px; color: var(--text-primary);
    }
    .sticky-ctx-color-dots { display: inline-flex; align-items: center; gap: 5px; }
    .sticky-ctx-dot {
      width: 15px; height: 15px; border-radius: 9999px; border: 1.5px solid rgba(255,255,255,0.6);
      cursor: pointer; transition: transform 0.14s ease;
    }
    .sticky-ctx-dot:hover { transform: scale(1.18); }
    .sticky-ctx-dot.is-active { box-shadow: 0 0 0 2px var(--accent); }
  `;
  if (document.head.firstChild) {
    document.head.insertBefore(style, document.head.firstChild);
  } else {
    document.head.appendChild(style);
  }
}

function getStickyTitle(sticky) {
  if (!sticky) return '闪念卡';
  const raw = String(sticky.content || '').trim();
  if (raw) {
    const first = raw.split(/\r?\n/).map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || raw;
    return first.slice(0, 26);
  }
  return String(sticky.title || '').trim() || '空白闪念';
}

function syncStickiesCount() {
  store.state.stickiesCount = stickies.length;
  store.emit('stickies:count-change', stickies.length);
}

function writeDragPayload(event, payload) {
  if (typeof store.setDragPayload === 'function') {
    return store.setDragPayload(event, payload);
  }
  return setDragPayload(event, payload);
}

function resetDragPayload() {
  if (typeof store.clearDragPayload === 'function') {
    store.clearDragPayload();
    return;
  }
  clearDragPayload();
}

function getViewportSize() {
  return {
    vw: typeof window !== 'undefined' ? window.innerWidth : 1280,
    vh: typeof window !== 'undefined' ? window.innerHeight : 800,
  };
}

function isMobileStickyViewport() {
  if (typeof window === 'undefined') return false;
  return window.innerWidth <= 768 || Boolean(document.body?.classList?.contains('is-android-app'));
}

function getMobileStickyRect(visibleIdx = 0) {
  const { vw, vh } = getViewportSize();
  const w = Math.max(240, Math.min(380, Math.round(vw * 0.92)));
  const h = Math.max(200, Math.min(320, Math.round(vh * 0.36)));
  const x = Math.max(8, Math.round((vw - w) / 2));
  const topSafe = 58;
  const bottomSafe = 86;
  const maxY = Math.max(topSafe, vh - h - bottomSafe);
  const rawY = topSafe + (visibleIdx % 4) * 34;
  const y = Math.max(topSafe, Math.min(maxY, rawY));
  return { x, y, w, h };
}

function migrateColor(raw) {
  if (STICKY_COLORS.includes(raw)) return raw;
  if (raw === 'amber') return 'yellow';
  return 'yellow';
}

function normalizeCustomColor(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toUpperCase() : '';
}

function clampWidth(w, x = VIEWPORT_PAD) {
  const { vw } = getViewportSize();
  const num = Number(w);
  const base = Number.isFinite(num) ? num : DEFAULT_W;
  const maxAllowed = Math.max(MIN_W, Math.min(MAX_W, vw - Math.max(VIEWPORT_PAD, x) - VIEWPORT_PAD));
  return Math.max(MIN_W, Math.min(maxAllowed, Math.round(base)));
}

function clampHeight(h, y = TOP_BAR_SAFE_Y) {
  const { vh } = getViewportSize();
  const num = Number(h);
  const base = Number.isFinite(num) ? num : DEFAULT_H;
  const maxAllowed = Math.max(MIN_H, Math.min(MAX_H, vh - Math.max(TOP_BAR_SAFE_Y, y) - VIEWPORT_PAD));
  return Math.max(MIN_H, Math.min(maxAllowed, Math.round(base)));
}

function clampPosX(x, w = DEFAULT_W) {
  const { vw } = getViewportSize();
  const num = Number(x);
  const base = Number.isFinite(num) ? num : VIEWPORT_PAD;
  const maxLeft = Math.max(VIEWPORT_PAD, vw - Math.min(w, vw - VIEWPORT_PAD * 2) - VIEWPORT_PAD);
  return Math.max(VIEWPORT_PAD, Math.min(maxLeft, Math.round(base)));
}

function clampPosY(y, h = DEFAULT_H) {
  const { vh } = getViewportSize();
  const num = Number(y);
  const base = Number.isFinite(num) ? num : TOP_BAR_SAFE_Y;
  const maxTop = Math.max(TOP_BAR_SAFE_Y, vh - Math.min(h, vh - TOP_BAR_SAFE_Y - VIEWPORT_PAD) - VIEWPORT_PAD);
  return Math.max(TOP_BAR_SAFE_Y, Math.min(maxTop, Math.round(base)));
}

function computeZIndex(sticky) {
  const baseZ = Number.isFinite(Number(sticky.z)) ? Number(sticky.z) : 1;
  return sticky.pinned ? 1000 + baseZ : 55 + baseZ;
}

function setElementVisibility(el, visible) {
  if (!el) return;
  el.hidden = !visible;
  el.classList.toggle('hidden', !visible);
  el.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function loadStickies() {
  try {
    const raw = localStorage.getItem(STICKIES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    let maxZ = 1;
    const loaded = parsed
      .filter((item) => item && typeof item === 'object')
      .map((item, idx) => {
        const rawX = Number(item.x);
        const rawY = Number(item.y);
        const x = clampPosX(Number.isFinite(rawX) ? rawX : 80 + (idx % 4) * 28, Number(item.w) || DEFAULT_W);
        const y = clampPosY(Number.isFinite(rawY) ? rawY : 90 + (idx % 4) * 24, Number(item.h) || DEFAULT_H);
        const w = clampWidth(item.w, x);
        const h = clampHeight(item.h, y);
        const color = migrateColor(item.color || item.accent);
        const customColor = normalizeCustomColor(item.customColor);
        const rawOrigW = Number(item.origW);
        const rawOrigH = Number(item.origH);
        const origW = Number.isFinite(rawOrigW) && rawOrigW >= MIN_W ? clampWidth(rawOrigW) : null;
        const origH = Number.isFinite(rawOrigH) && rawOrigH >= MIN_H ? clampHeight(rawOrigH) : null;
        const z = Number.isFinite(Number(item.z)) && Number(item.z) > 0 ? Math.round(Number(item.z)) : idx + 1;
        if (z > maxZ) maxZ = z;
        const zone = VALID_ZONES.has(item.zone) ? item.zone : 'free';
        return {
          id: String(item.id || `sticky_${Date.now()}_${idx}`),
          content: typeof item.content === 'string'
            ? item.content
            : (typeof item.text === 'string' ? item.text : ''),
          x,
          y,
          w,
          h,
          origW,
          origH,
          color,
          customColor,
          minimized: Boolean(item.minimized),
          pinned: Boolean(item.pinned),
          z,
          zone,
          stackId: typeof item.stackId === 'string' && item.stackId ? item.stackId : null,
          stackExpanded: Boolean(item.stackExpanded),
        };
      });
    zCounter = Math.max(zCounter, maxZ);
    return loaded;
  } catch {
    return [];
  }
}

function saveStickies() {
  try {
    localStorage.setItem(STICKIES_STORAGE_KEY, JSON.stringify(stickies));
  } catch {
    // ignore storage quota errors
  }
  syncStickiesCount();
}

function ensureLayer() {
  if (typeof document === 'undefined') return null;
  if (!layerEl || !document.body.contains(layerEl)) {
    layerEl = document.getElementById('sticky-layer');
    if (!layerEl) {
      layerEl = document.createElement('div');
      layerEl.id = 'sticky-layer';
      layerEl.className = 'sticky-layer';
      document.body.appendChild(layerEl);
    }
  }
  return layerEl;
}

function ensureSnapPreview() {
  if (typeof document === 'undefined') return null;
  if (!snapPreviewEl || !document.body.contains(snapPreviewEl)) {
    snapPreviewEl = document.getElementById('sticky-snap-preview');
    if (!snapPreviewEl) {
      snapPreviewEl = document.createElement('div');
      snapPreviewEl.id = 'sticky-snap-preview';
      snapPreviewEl.className = 'sticky-snap-preview hidden';
      setElementVisibility(snapPreviewEl, false);
      document.body.appendChild(snapPreviewEl);
    }
  }
  return snapPreviewEl;
}

function showSnapPreview(rect, label) {
  const el = ensureSnapPreview();
  if (!el || !rect) return;
  el.style.left = `${Math.round(rect.x)}px`;
  el.style.top = `${Math.round(rect.y)}px`;
  el.style.width = `${Math.round(rect.w)}px`;
  el.style.height = `${Math.round(rect.h)}px`;
  el.textContent = label || '';
  setElementVisibility(el, true);
}

function hideSnapPreview() {
  if (!snapPreviewEl) return;
  setElementVisibility(snapPreviewEl, false);
}

function clearStackTargetHighlights() {
  if (!layerEl) return;
  layerEl.querySelectorAll('.sticky-card.is-stack-target').forEach((el) => {
    el.classList.remove('is-stack-target');
  });
}

function notifyPinnedBlocked(card) {
  if (card) {
    // NEVER add .is-pin-shake to .sticky-card (which uses transform: translate3d for positioning).
    const pinBtn = card.querySelector('.sticky-pin-btn');
    if (pinBtn) {
      pinBtn.classList.remove('is-pin-shake');
      void pinBtn.offsetWidth;
      pinBtn.classList.add('is-pin-shake');
      window.setTimeout(() => pinBtn.classList.remove('is-pin-shake'), 320);
    }
    card.classList.remove('is-pin-pulse');
    void card.offsetWidth;
    card.classList.add('is-pin-pulse');
    window.setTimeout(() => card.classList.remove('is-pin-pulse'), 420);
  }
  const now = Date.now();
  if (now - lastPinToastAt > 1800) {
    lastPinToastAt = now;
    showToast('已固定位置（点击钉子取消固定后可移动或调大小）', 'info', { duration: 1800 });
  }
}

function restoreStickyOrigSize(sticky) {
  if (!sticky) return;
  if (Number.isFinite(Number(sticky.origW)) && Number(sticky.origW) >= MIN_W) {
    sticky.w = clampWidth(sticky.origW, sticky.x);
  }
  if (Number.isFinite(Number(sticky.origH)) && Number(sticky.origH) >= MIN_H) {
    sticky.h = clampHeight(sticky.origH, sticky.y);
  }
  sticky.origW = null;
  sticky.origH = null;
}

function applyUnifiedStackSize(stackId) {
  if (!stackId) return;
  const members = stickies.filter((s) => !s.minimized && !s.pinned && s.stackId === stackId);
  if (members.length < 2) return;
  for (const m of members) {
    if (!Number.isFinite(Number(m.origW)) || Number(m.origW) <= 0) m.origW = m.w;
    if (!Number.isFinite(Number(m.origH)) || Number(m.origH) <= 0) m.origH = m.h;
  }
  const stackW = clampWidth(Math.max(...members.map((m) => m.w)));
  const stackH = clampHeight(Math.max(...members.map((m) => m.h)));
  for (const m of members) {
    m.w = stackW;
    m.h = stackH;
  }
}

function getCardElementById(id) {
  if (!layerEl || !id) return null;
  return layerEl.querySelector(`.sticky-card[data-sticky-id="${CSS.escape(id)}"]`);
}

function syncStackCardsDom(stackId) {
  if (!stackId || !layerEl) return;
  const members = stickies.filter((s) => !s.minimized && !s.pinned && s.stackId === stackId);
  for (const m of members) {
    const el = getCardElementById(m.id);
    if (!el) continue;
    el.style.width = `${m.w}px`;
    el.style.height = `${m.h}px`;
    el.style.transform = `translate3d(${m.x}px, ${m.y}px, 0)`;
    el.style.zIndex = String(computeZIndex(m));
  }
}

function snapshotStickyState(s, overrides = null) {
  return {
    id: s.id,
    x: overrides?.x ?? s.x,
    y: overrides?.y ?? s.y,
    w: overrides?.w ?? s.w,
    h: overrides?.h ?? s.h,
    origW: overrides && 'origW' in overrides ? overrides.origW : (s.origW ?? null),
    origH: overrides && 'origH' in overrides ? overrides.origH : (s.origH ?? null),
    stackId: overrides && 'stackId' in overrides ? overrides.stackId : (s.stackId ?? null),
    stackExpanded: overrides && 'stackExpanded' in overrides ? Boolean(overrides.stackExpanded) : Boolean(s.stackExpanded),
    zone: overrides?.zone ?? s.zone ?? 'free',
    z: overrides?.z ?? s.z,
  };
}

function hasActiveMergeUndo() {
  if (lastMergeUndo.length === 0) return false;
  const latest = lastMergeUndo[lastMergeUndo.length - 1];
  return Boolean(latest && Date.now() - latest.timestamp <= MERGE_UNDO_DOCK_MS);
}

function renderDockOnly() {
  renderStickiesControlPanel();
}

function pushMergeUndoSnapshot(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return;
  const deduped = [];
  const seen = new Set();
  for (const item of snapshots) {
    if (!item || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push({ ...item });
  }
  if (deduped.length === 0) return;

  lastMergeUndo.push({
    timestamp: Date.now(),
    prevStickies: deduped,
  });
  if (lastMergeUndo.length > MERGE_UNDO_MAX) {
    lastMergeUndo.shift();
  }

  if (mergeUndoDockTimer) {
    window.clearTimeout(mergeUndoDockTimer);
  }
  mergeUndoDockTimer = window.setTimeout(() => {
    mergeUndoDockTimer = 0;
    renderStickiesControlPanel();
  }, MERGE_UNDO_DOCK_MS);
}

/**
 * Restore the most recent stack-merge operation from lastMergeUndo.
 * @returns {boolean} true if a merge snapshot was restored
 */
export function undoLastStackMerge() {
  const snap = lastMergeUndo.pop();
  if (!snap || !Array.isArray(snap.prevStickies)) {
    return false;
  }
  if (mergeUndoDockTimer && lastMergeUndo.length === 0) {
    window.clearTimeout(mergeUndoDockTimer);
    mergeUndoDockTimer = 0;
  }

  const prevMap = new Map(snap.prevStickies.map((item) => [item.id, item]));
  let restored = 0;
  for (const s of stickies) {
    const prev = prevMap.get(s.id);
    if (!prev) continue;
    s.x = clampPosX(prev.x, prev.w);
    s.y = clampPosY(prev.y, prev.h);
    s.w = clampWidth(prev.w, s.x);
    s.h = clampHeight(prev.h, s.y);
    s.origW = prev.origW ?? null;
    s.origH = prev.origH ?? null;
    s.stackId = prev.stackId ?? null;
    s.stackExpanded = Boolean(prev.stackExpanded);
    s.zone = VALID_ZONES.has(prev.zone) ? prev.zone : 'free';
    if (Number.isFinite(Number(prev.z))) {
      s.z = prev.z;
    }
    restored += 1;
  }

  if (restored === 0) return false;
  cleanupOrphanStacks();
  saveStickies();
  renderStickies();
  showToast('已撤销闪念卡合并', 'success', { duration: 1800 });
  return true;
}

function getStackGroups() {
  const groups = new Map();
  for (const s of stickies) {
    if (s.minimized || s.pinned || !s.stackId) continue;
    if (!groups.has(s.stackId)) groups.set(s.stackId, []);
    groups.get(s.stackId).push(s);
  }
  for (const [sid, list] of groups.entries()) {
    if (list.length < 2) {
      for (const s of list) {
        s.stackId = null;
        s.stackExpanded = false;
        restoreStickyOrigSize(s);
      }
      groups.delete(sid);
    } else {
      list.sort((a, b) => a.z - b.z);
    }
  }
  return groups;
}

function cleanupOrphanStacks() {
  getStackGroups();
}

function detachStickyFromStack(stickyId, { offsetStep = true } = {}) {
  const sticky = getCardById(stickyId);
  if (!sticky || !sticky.stackId) return false;
  const oldSid = sticky.stackId;
  sticky.stackId = null;
  sticky.stackExpanded = false;
  sticky.zone = 'free';
  restoreStickyOrigSize(sticky);
  if (offsetStep) {
    sticky.x = clampPosX(sticky.x + 28, sticky.w);
    sticky.y = clampPosY(sticky.y + 18, sticky.h);
  }
  bringStickyForward(sticky);
  cleanupOrphanStacks();
  if (getStackGroups().has(oldSid)) {
    layoutStack(oldSid);
  }
  saveStickies();
  renderStickies();
  return true;
}

function layoutStack(stackId, anchorX = null, anchorY = null) {
  if (!stackId) return;
  const groups = getStackGroups();
  const list = groups.get(stackId);
  if (!list || list.length < 2) return;

  const { vw, vh } = getViewportSize();
  const expanded = list.some((s) => s.stackExpanded);
  const maxCardW = Math.max(...list.map((s) => s.w));
  const maxCardH = Math.max(...list.map((s) => s.h));

  let baseX = Number.isFinite(anchorX) ? anchorX : Math.min(...list.map((s) => s.x));
  let baseY = Number.isFinite(anchorY) ? anchorY : Math.min(...list.map((s) => s.y));
  baseX = clampPosX(baseX, maxCardW);

  if (!expanded) {
    const totalCascadeH = maxCardH + (list.length - 1) * STACK_CASCADE_STEP;
    const maxBaseY = Math.max(TOP_BAR_SAFE_Y, vh - totalCascadeH - VIEWPORT_PAD);
    baseY = Math.max(TOP_BAR_SAFE_Y, Math.min(maxBaseY, Math.round(baseY)));
    list.forEach((s, idx) => {
      s.stackExpanded = false;
      s.zone = 'free';
      s.x = clampPosX(baseX, s.w);
      s.y = clampPosY(baseY + idx * STACK_CASCADE_STEP, s.h);
    });
    return;
  }

  // Expanded: ALWAYS fan out VERTICALLY top-to-bottom (column-major).
  // If cards fit in a single vertical column, keep them neatly stacked down from baseY (or TOP_BAR_SAFE_Y).
  // If more cards exceed viewport height, fill downward vertically first and wrap to an adjacent vertical column.
  const availH = Math.max(220, vh - TOP_BAR_SAFE_Y - VIEWPORT_PAD);
  const totalVertH = list.reduce((sum, s) => sum + s.h, 0) + (list.length - 1) * STACK_EXPAND_GAP;
  if (totalVertH <= availH) {
    let curY = Math.max(TOP_BAR_SAFE_Y, Math.min(vh - totalVertH - VIEWPORT_PAD, Math.round(baseY)));
    for (const s of list) {
      s.stackExpanded = true;
      s.zone = 'free';
      s.x = clampPosX(baseX, s.w);
      s.y = clampPosY(curY, s.h);
      curY += s.h + STACK_EXPAND_GAP;
    }
    return;
  }

  // Column-major vertical expansion: fill top-to-bottom first, then move to adjacent column (left or right)
  const dirX = baseX + maxCardW * 2 + STACK_EXPAND_GAP <= vw - VIEWPORT_PAD ? 1 : -1;
  let curX = clampPosX(baseX, maxCardW);
  let curY = TOP_BAR_SAFE_Y;
  let colMaxW = 0;
  for (const s of list) {
    if (curY + s.h > vh - VIEWPORT_PAD && curY > TOP_BAR_SAFE_Y) {
      curY = TOP_BAR_SAFE_Y;
      curX = clampPosX(curX + dirX * (colMaxW + STACK_EXPAND_GAP), s.w);
      colMaxW = 0;
    }
    s.stackExpanded = true;
    s.zone = 'free';
    s.x = clampPosX(curX, s.w);
    s.y = clampPosY(curY, s.h);
    curY += s.h + STACK_EXPAND_GAP;
    colMaxW = Math.max(colMaxW, s.w);
  }
}

function arrangeZone(zone) {
  if (!zone || zone === 'free') return;
  const members = stickies
    .filter((s) => !s.minimized && !s.pinned && !s.stackId && s.zone === zone)
    .sort((a, b) => (zone === 'top' || zone === 'bottom' ? a.x - b.x : a.y - b.y) || a.z - b.z);
  if (members.length === 0) return;

  const { vw, vh } = getViewportSize();
  const gap = 10;

  if (zone === 'left' || zone === 'right') {
    let colOffset = 0;
    let curY = TOP_BAR_SAFE_Y + 4;
    let colMaxW = 0;
    for (const s of members) {
      if (curY + s.h > vh - VIEWPORT_PAD && curY > TOP_BAR_SAFE_Y + 4) {
        curY = TOP_BAR_SAFE_Y + 4;
        colOffset += colMaxW + gap;
        colMaxW = 0;
      }
      const targetX = zone === 'left' ? VIEWPORT_PAD + colOffset : vw - s.w - VIEWPORT_PAD - colOffset;
      s.x = clampPosX(targetX, s.w);
      s.y = clampPosY(curY, s.h);
      curY += s.h + gap;
      colMaxW = Math.max(colMaxW, s.w);
    }
    return;
  }

  if (zone === 'top' || zone === 'bottom') {
    let rowOffset = 0;
    let curX = VIEWPORT_PAD;
    let rowMaxH = 0;
    for (const s of members) {
      if (curX + s.w > vw - VIEWPORT_PAD && curX > VIEWPORT_PAD) {
        curX = VIEWPORT_PAD;
        rowOffset += rowMaxH + gap;
        rowMaxH = 0;
      }
      const targetY = zone === 'top' ? TOP_BAR_SAFE_Y + 4 + rowOffset : vh - s.h - VIEWPORT_PAD - rowOffset;
      s.x = clampPosX(curX, s.w);
      s.y = clampPosY(targetY, s.h);
      curX += s.w + gap;
      rowMaxH = Math.max(rowMaxH, s.h);
    }
  }
}

function tileAllUnpinned() {
  const unpinned = stickies.filter((s) => !s.minimized && !s.pinned);
  if (unpinned.length === 0) {
    showToast('没有可整理的未固定便签', 'info', { duration: 1600 });
    return;
  }
  const { vw, vh } = getViewportSize();
  const gap = 12;
  const startY = TOP_BAR_SAFE_Y + 6;
  const maxColH = Math.max(220, vh - startY - 56);

  // Tile neatly on the right side in columns moving leftward, avoiding pinned cards
  const pinnedRects = stickies
    .filter((p) => !p.minimized && p.pinned)
    .map((p) => ({ x: p.x - gap, y: p.y - gap, r: p.x + p.w + gap, b: p.y + p.h + gap }));

  const collidesPinned = (x, y, w, h) =>
    pinnedRects.some((pr) => x < pr.r && x + w > pr.x && y < pr.b && y + h > pr.y);

  let colRight = vw - VIEWPORT_PAD - 34; // clear right-edge drag shelf tab
  let curY = startY;
  let colMaxW = 0;

  for (const s of unpinned) {
    s.stackId = null;
    s.stackExpanded = false;
    s.zone = 'free';
    restoreStickyOrigSize(s);

    let placed = false;
    for (let guard = 0; guard < 18; guard += 1) {
      if (curY + s.h > startY + maxColH && curY > startY) {
        colRight -= (colMaxW || s.w) + gap;
        curY = startY;
        colMaxW = 0;
      }
      const candX = clampPosX(colRight - s.w, s.w);
      const candY = clampPosY(curY, s.h);
      const blocker = pinnedRects.find(
        (pr) => candX < pr.r && candX + s.w > pr.x && candY < pr.b && candY + s.h > pr.y
      );
      if (!blocker) {
        s.x = candX;
        s.y = candY;
        curY = candY + s.h + gap;
        colMaxW = Math.max(colMaxW, s.w);
        placed = true;
        break;
      }
      curY = blocker.b + 2;
      if (curY + s.h > startY + maxColH) {
        colRight -= Math.max(colMaxW, s.w) + gap;
        curY = startY;
        colMaxW = 0;
      }
    }
    if (!placed) {
      s.x = clampPosX(colRight - s.w, s.w);
      s.y = clampPosY(curY, s.h);
      curY += s.h + gap;
      colMaxW = Math.max(colMaxW, s.w);
    }
  }

  saveStickies();
  renderStickies();
  showToast(`已整齐排布 ${unpinned.length} 张便签`, 'success', { duration: 1600 });
}

function stackAllUnpinned() {
  const unpinned = stickies.filter((s) => !s.minimized && !s.pinned);
  if (unpinned.length < 2) {
    showToast('至少需要 2 张未固定便签才能堆叠', 'info', { duration: 1600 });
    return;
  }

  const existingIds = new Set(unpinned.map((s) => s.stackId).filter(Boolean));
  const alreadySingleStack = existingIds.size === 1 && unpinned.every((s) => s.stackId);

  if (alreadySingleStack) {
    const nextExpanded = !unpinned.some((s) => s.stackExpanded);
    const sid = unpinned[0].stackId;
    unpinned.forEach((s) => {
      s.stackExpanded = nextExpanded;
    });
    layoutStack(sid);
    saveStickies();
    renderStickies();
    return;
  }

  pushMergeUndoSnapshot(unpinned.map((s) => snapshotStickyState(s)));

  const { vw, vh } = getViewportSize();
  const sid = `stack_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;

  unpinned.sort((a, b) => a.z - b.z).forEach((s) => {
    if (!Number.isFinite(Number(s.origW)) || Number(s.origW) <= 0) s.origW = s.w;
    if (!Number.isFinite(Number(s.origH)) || Number(s.origH) <= 0) s.origH = s.h;
    s.stackId = sid;
    s.stackExpanded = false;
    s.zone = 'free';
  });

  applyUnifiedStackSize(sid);
  const stackW = unpinned[0].w;
  const stackH = unpinned[0].h;
  const deckX = clampPosX(vw - stackW - 22, stackW);
  const deckY = clampPosY(vh - stackH - (unpinned.length - 1) * STACK_CASCADE_STEP - 64, stackH);

  layoutStack(sid, deckX, deckY);
  saveStickies();
  renderStickies();
  showToast('已合并堆叠（按 Ctrl+Z 或在灵动岛闪念控制点「撤销合并」可还原）', 'success', { duration: 3200 });
}

async function trashStickyById(stickyId) {
  const sticky = getCardById(stickyId);
  if (!sticky || trashingStickyIds.has(stickyId)) return false;
  trashingStickyIds.add(stickyId);
  const stickyCopy = { ...sticky };
  const title = getStickyTitle(sticky);
  try {
    if (typeof store.trashVirtualItem === 'function') {
      await store.trashVirtualItem({
        kind: 'sticky',
        title,
        payload: stickyCopy,
      });
    }
    stickies = stickies.filter((item) => item.id !== stickyId);
    cleanupOrphanStacks();
    saveStickies();
    renderStickies();
    showToast('已移入内置回收站，可在灵动岛回收站还原', 'info', { duration: 2400 });
    return true;
  } catch (err) {
    showToast(`移入回收站失败：${err?.message || '未知错误'}`, 'error');
    return false;
  } finally {
    trashingStickyIds.delete(stickyId);
  }
}

function focusOrRestoreSticky(stickyId) {
  const sticky = getCardById(stickyId);
  if (!sticky) return;
  if (sticky.minimized) {
    sticky.minimized = false;
  }
  if (isMobileStickyViewport()) {
    const visibleIdx = stickies.filter((s) => !s.minimized && s.id !== sticky.id).length;
    const rect = getMobileStickyRect(visibleIdx);
    sticky.w = rect.w;
    sticky.h = rect.h;
    sticky.x = rect.x;
    sticky.y = rect.y;
    sticky.stackId = null;
    sticky.stackExpanded = false;
  }
  bringStickyForward(sticky);
  saveStickies();
  renderStickies();
  window.requestAnimationFrame(() => {
    const cardEl = getCardElementById(sticky.id);
    if (cardEl) {
      cardEl.classList.remove('is-pin-pulse');
      void cardEl.offsetWidth;
      cardEl.classList.add('is-pin-pulse');
      window.setTimeout(() => cardEl.classList.remove('is-pin-pulse'), 550);
      cardEl.querySelector('.sticky-textarea')?.focus();
    }
  });
}

function renderStickiesControlPanel() {
  const panel = document.getElementById('island-stickies-panel');
  if (!panel) return;

  const visibleCount = stickies.filter((s) => !s.minimized).length;
  const minimizedCount = stickies.length - visibleCount;
  const undoAvailable = hasActiveMergeUndo();

  const toggleAllBtnHtml = minimizedCount > 0
    ? `<button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-stickies-action="restore-all" title="恢复全部已收起闪念">👁 恢复全部 (${minimizedCount})</button>`
    : `<button type="button" class="pill-btn pill-btn-sm" data-stickies-action="minimize-all" title="全部收起到灵动岛" ${visibleCount === 0 ? 'disabled' : ''}>📦 全部收起</button>`;

  const listHtml = stickies.length === 0
    ? `<div class="island-stickies-empty">暂无闪念卡，点击上方「+ 新建闪念」或按 Alt+N / 文档空白处右键召唤</div>`
    : stickies
        .map((s) => {
          const accentHex = normalizeCustomColor(s.customColor) || STICKY_COLOR_SWATCHES[migrateColor(s.color)];
          const title = getStickyTitle(s);
          const rawBody = String(s.content || '').trim().replace(/\s+/g, ' ');
          const subText = rawBody && rawBody !== title ? rawBody.slice(0, 48) : (s.minimized ? '已收起到灵动岛' : '桌面悬浮中');
          return `
            <div class="island-sticky-row" data-stickies-action="focus-one" data-sticky-id="${escapeHtml(s.id)}" role="listitem" title="点击定位并展开">
              <div class="island-sticky-row-main">
                <span class="island-sticky-dot" style="background:${escapeHtml(accentHex)};" aria-hidden="true"></span>
                <div class="island-sticky-text-wrap">
                  <span class="island-sticky-title">${escapeHtml(title)}</span>
                  <span class="island-sticky-sub">${escapeHtml(subText)}</span>
                </div>
              </div>
              <div class="island-sticky-badges">
                ${s.pinned ? '<span class="island-sticky-badge">📌 置顶</span>' : ''}
                ${s.minimized ? '<span class="island-sticky-badge">📦 收起</span>' : ''}
                <button type="button" class="pill-btn pill-btn-sm is-danger" data-stickies-action="trash-one" data-sticky-id="${escapeHtml(s.id)}" title="移入内置回收站" aria-label="移入回收站">🗑</button>
              </div>
            </div>
          `;
        })
        .join('');

  panel.innerHTML = `
    <div class="island-stickies-toolbar" role="toolbar" aria-label="闪念便签控制">
      <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-stickies-action="new" title="新建闪念卡 (Alt+N)">+ 新建闪念 (Alt+N)</button>
      ${toggleAllBtnHtml}
      <button type="button" class="pill-btn pill-btn-sm" data-stickies-action="tile" title="将未固定便签整齐平铺" ${visibleCount === 0 ? 'disabled' : ''}>⊞ 平铺整理</button>
      <button type="button" class="pill-btn pill-btn-sm" data-stickies-action="stack-all" title="将未固定便签合并堆叠或展开" ${visibleCount < 2 ? 'disabled' : ''}>📚 一键堆叠</button>
      <button type="button" class="pill-btn pill-btn-sm ${undoAvailable ? 'is-undo-active' : ''}" data-stickies-action="undo-merge" title="撤销最近一次合并 (Ctrl+Z)" ${undoAvailable ? '' : 'disabled'}>↩ 撤销合并</button>
    </div>
    <div class="island-stickies-list" role="list">${listHtml}</div>
  `;
}

function bindStickiesPanelEvents() {
  const panel = document.getElementById('island-stickies-panel');
  if (!panel || panel.dataset.stickiesBound === '1') return;
  panel.dataset.stickiesBound = '1';

  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-stickies-action]');
    if (!btn) return;
    e.stopPropagation();
    const action = btn.dataset.stickiesAction;
    const sid = btn.dataset.stickyId;

    if (action === 'new') {
      spawnStickyNote();
      return;
    }
    if (action === 'restore-all') {
      let changed = false;
      stickies = stickies.map((s) => {
        if (s.minimized) {
          changed = true;
          return { ...s, minimized: false };
        }
        return s;
      });
      if (changed) {
        saveStickies();
        renderStickies();
      }
      return;
    }
    if (action === 'minimize-all') {
      let changed = false;
      stickies = stickies.map((s) => {
        if (!s.minimized) {
          changed = true;
          restoreStickyOrigSize(s);
          return { ...s, minimized: true, stackId: null, stackExpanded: false };
        }
        return s;
      });
      if (changed) {
        cleanupOrphanStacks();
        saveStickies();
        renderStickies();
      }
      return;
    }
    if (action === 'tile') {
      tileAllUnpinned();
      return;
    }
    if (action === 'stack-all') {
      stackAllUnpinned();
      return;
    }
    if (action === 'undo-merge') {
      undoLastStackMerge();
      return;
    }
    if (action === 'trash-one' && sid) {
      trashStickyById(sid);
      return;
    }
    if (action === 'focus-one' && sid) {
      focusOrRestoreSticky(sid);
    }
  });
}

function ensureContextMenu() {
  if (typeof document === 'undefined') return null;
  if (!menuEl || !document.body.contains(menuEl)) {
    menuEl = document.getElementById('context-menu');
    if (!menuEl) {
      menuEl = document.createElement('div');
      menuEl.id = 'context-menu';
      menuEl.className = 'context-menu hidden';
      menuEl.setAttribute('role', 'menu');
      setElementVisibility(menuEl, false);
      document.body.appendChild(menuEl);
    }
  }
  return menuEl;
}

function hideContextMenu() {
  if (!menuEl) return;
  menuEl.classList.remove('is-open');
  setElementVisibility(menuEl, false);
}

function closeAllColorPopovers(exceptCard = null) {
  if (!layerEl) return;
  layerEl.querySelectorAll('.sticky-color-popover').forEach((pop) => {
    if (exceptCard && exceptCard.contains(pop)) return;
    setElementVisibility(pop, false);
  });
}

function openUrlCapsuleSheet() {
  openSheet({
    title: '插入网址直达胶囊',
    bodyHtml: `
      <div style="display:flex;flex-direction:column;gap:10px;">
        <label style="font-size:12.5px;color:var(--text-secondary);">输入网页地址（自动探测页面标题并生成 [[url:标题|链接]] 胶囊）</label>
        <input id="ctx-url-input" class="apple-input" type="url" placeholder="https://example.com/article" autocomplete="off" />
        <label style="font-size:12.5px;color:var(--text-secondary);">自定义显示标题（可选，留空自动获取）</label>
        <input id="ctx-url-title" class="apple-input" type="text" placeholder="留空则自动抓取网页标题…" autocomplete="off" />
      </div>
    `,
    footerHtml: `
      <button type="button" class="pill-btn" id="ctx-url-cancel">取消</button>
      <button type="button" class="pill-btn pill-btn-primary" id="ctx-url-submit">${icon('globe', 14)} 获取并插入</button>
    `,
    onMount(card) {
      const urlInp = card.querySelector('#ctx-url-input');
      const titleInp = card.querySelector('#ctx-url-title');
      const submitBtn = card.querySelector('#ctx-url-submit');
      card.querySelector('#ctx-url-cancel')?.addEventListener('click', closeSheet);

      const handleSubmit = async () => {
        let rawUrl = String(urlInp?.value || '').trim();
        if (!rawUrl) {
          showToast('请输入网址', 'warning');
          urlInp?.focus();
          return;
        }
        if (!/^https?:\/\//i.test(rawUrl)) {
          rawUrl = `https://${rawUrl}`;
        }
        const customTitle = String(titleInp?.value || '').trim();
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = '正在读取标题…';
        }
        let finalTitle = customTitle;
        let finalUrl = rawUrl;
        if (!finalTitle) {
          try {
            const res = await api.post('/api/tools/fetch-url-title', { url: rawUrl });
            if (res?.title) finalTitle = String(res.title).trim();
            if (res?.url) finalUrl = String(res.url).trim();
          } catch {
            try {
              finalTitle = new URL(rawUrl).hostname.replace(/^www\./i, '');
            } catch {
              finalTitle = rawUrl;
            }
          }
        }
        const safeTitle = (finalTitle || finalUrl).replace(/[|\[\]\r\n]/g, ' ').trim();
        const block = `[[url:${safeTitle}|${finalUrl}]]`;
        closeSheet();
        store.emit('doc:insert-block', { markdown: block, label: '网址胶囊' });
        showToast('已生成网址直达胶囊', 'success');
      };

      submitBtn?.addEventListener('click', handleSubmit);
      urlInp?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleSubmit();
        }
      });
      window.requestAnimationFrame(() => urlInp?.focus());
    },
  });
}

function positionAndOpenMenu(menu, clientX, clientY) {
  menu.classList.remove('is-open');
  setElementVisibility(menu, true);

  // Measure layout width/height (unaffected by pre-open transform scale(0.95))
  const menuW = menu.offsetWidth || Math.ceil(menu.getBoundingClientRect().width) || 240;
  const menuH = menu.offsetHeight || Math.ceil(menu.getBoundingClientRect().height) || 220;
  const { vw, vh } = getViewportSize();
  const left = Math.max(8, Math.min(clientX, vw - menuW - 8));
  const top = Math.max(8, Math.min(clientY, vh - menuH - 8));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  window.requestAnimationFrame(() => {
    menu.classList.add('is-open');
  });
}

function showContextMenu(clientX, clientY) {
  const menu = ensureContextMenu();
  if (!menu) return;

  delete menu.dataset.targetStickyId;
  menu.innerHTML = `
    <button type="button" class="context-menu-item" data-ctx-action="spawn-sticky" role="menuitem">
      <span class="ctx-item-left"><span>📌</span><span>在此处召唤闪念卡</span></span>
      <kbd class="ctx-kbd">Alt+N</kbd>
    </button>
    <button type="button" class="context-menu-item" data-ctx-action="insert-url" role="menuitem">
      <span class="ctx-item-left"><span>🔗</span><span>插入网址直达胶囊</span></span>
    </button>
    <div class="context-menu-sep" role="separator"></div>
    <button type="button" class="context-menu-item" data-ctx-action="ai-summarize" role="menuitem">
      <span class="ctx-item-left"><span>✨</span><span>AI 总结当前文档</span></span>
    </button>
    <button type="button" class="context-menu-item" data-ctx-action="ai-polish" role="menuitem">
      <span class="ctx-item-left"><span>🪄</span><span>AI 润色当前笔记</span></span>
    </button>
    <button type="button" class="context-menu-item" data-ctx-action="toggle-mindmap" role="menuitem">
      <span class="ctx-item-left"><span>🧠</span><span>切换脑图视图</span></span>
    </button>
    <button type="button" class="context-menu-item" data-ctx-action="semantic-search" role="menuitem">
      <span class="ctx-item-left"><span>🔍</span><span>语义描述检索</span></span>
      <kbd class="ctx-kbd">Ctrl+K</kbd>
    </button>
  `;

  menu.dataset.spawnX = String(clientX);
  menu.dataset.spawnY = String(clientY);
  positionAndOpenMenu(menu, clientX, clientY);
}

function showStickyCardContextMenu(stickyId, clientX, clientY) {
  const sticky = getCardById(stickyId);
  const menu = ensureContextMenu();
  if (!sticky || !menu) return;

  menu.dataset.targetStickyId = sticky.id;
  const curColor = migrateColor(sticky.color);
  const dotsHtml = STICKY_COLORS.map((c) => {
    const active = !sticky.customColor && curColor === c;
    return `<button type="button" class="sticky-ctx-dot ${active ? 'is-active' : ''}" data-sticky-ctx-color="${c}" title="${STICKY_COLOR_LABELS[c]}" aria-label="${STICKY_COLOR_LABELS[c]}" style="background:${STICKY_COLOR_SWATCHES[c]};"></button>`;
  }).join('');

  menu.innerHTML = `
    <button type="button" class="context-menu-item" data-sticky-ctx="copy" role="menuitem">
      <span class="ctx-item-left"><span>📋</span><span>复制闪念内容</span></span>
    </button>
    <button type="button" class="context-menu-item" data-sticky-ctx="toggle-pin" role="menuitem">
      <span class="ctx-item-left"><span>📌</span><span>${sticky.pinned ? '取消置顶' : '置顶闪念'}</span></span>
    </button>
    <div class="sticky-ctx-color-row" role="group" aria-label="切换颜色">
      <span>🎨 切换颜色</span>
      <span class="sticky-ctx-color-dots">${dotsHtml}</span>
    </div>
    <button type="button" class="context-menu-item" data-sticky-ctx="minimize" role="menuitem">
      <span class="ctx-item-left"><span>📦</span><span>收起到灵动岛</span></span>
    </button>
    <button type="button" class="context-menu-item" data-sticky-ctx="to-shelf" role="menuitem">
      <span class="ctx-item-left"><span>📥</span><span>暂存到灵动岛</span></span>
    </button>
    <div class="context-menu-sep" role="separator"></div>
    <button type="button" class="context-menu-item" data-sticky-ctx="trash" role="menuitem" style="color:var(--danger, #FF3B30);">
      <span class="ctx-item-left"><span>🗑</span><span>移入内置回收站</span></span>
    </button>
  `;

  positionAndOpenMenu(menu, clientX, clientY);
}

function findOverlapTarget(dragged, pendingX, pendingY, clientX, clientY, excludeStackId = null) {
  const dragArea = dragged.w * dragged.h;
  let best = null;
  let bestScore = 0;

  for (const other of stickies) {
    if (other.id === dragged.id || other.minimized || other.pinned) continue;
    if (excludeStackId && other.stackId === excludeStackId) continue;
    const pointerInside =
      clientX >= other.x &&
      clientX <= other.x + other.w &&
      clientY >= other.y &&
      clientY <= other.y + other.h;

    const ix = Math.max(0, Math.min(pendingX + dragged.w, other.x + other.w) - Math.max(pendingX, other.x));
    const iy = Math.max(0, Math.min(pendingY + dragged.h, other.y + other.h) - Math.max(pendingY, other.y));
    const interArea = ix * iy;
    const minArea = Math.min(dragArea, other.w * other.h);
    const ratio = minArea > 0 ? interArea / minArea : 0;

    if (pointerInside || ratio > 0.45) {
      const score = ratio + (pointerInside ? 0.5 : 0) + other.z * 0.0001;
      if (score > bestScore) {
        bestScore = score;
        best = other;
      }
    }
  }
  return best;
}

function detectEdgeZone(dragged, pendingX, pendingY, clientX, clientY) {
  const { vw, vh } = getViewportSize();
  const candidates = [];

  const leftDist = Math.min(pendingX - VIEWPORT_PAD, clientX);
  if (pendingX <= VIEWPORT_PAD + EDGE_SNAP_DIST || clientX <= EDGE_SNAP_DIST) {
    candidates.push({
      zone: 'left',
      dist: Math.max(0, leftDist),
      label: '左列整齐排布',
      rect: { x: 10, y: TOP_BAR_SAFE_Y + 4, w: Math.min(290, dragged.w + 16), h: Math.max(180, vh - TOP_BAR_SAFE_Y - 20) },
    });
  }

  const rightDist = Math.min(vw - VIEWPORT_PAD - (pendingX + dragged.w), vw - clientX);
  if (pendingX + dragged.w >= vw - VIEWPORT_PAD - EDGE_SNAP_DIST || clientX >= vw - EDGE_SNAP_DIST) {
    const previewW = Math.min(290, dragged.w + 16);
    candidates.push({
      zone: 'right',
      dist: Math.max(0, rightDist),
      label: '右列整齐排布',
      rect: { x: vw - previewW - 10, y: TOP_BAR_SAFE_Y + 4, w: previewW, h: Math.max(180, vh - TOP_BAR_SAFE_Y - 20) },
    });
  }

  const topDist = Math.min(pendingY - TOP_BAR_SAFE_Y, clientY - TOP_BAR_SAFE_Y);
  if (pendingY <= TOP_BAR_SAFE_Y + EDGE_SNAP_DIST || clientY <= TOP_BAR_SAFE_Y + EDGE_SNAP_DIST) {
    candidates.push({
      zone: 'top',
      dist: Math.max(0, topDist),
      label: '顶部横向排布',
      rect: { x: VIEWPORT_PAD, y: TOP_BAR_SAFE_Y + 4, w: Math.max(240, vw - VIEWPORT_PAD * 2), h: Math.min(230, dragged.h + 14) },
    });
  }

  const bottomDist = Math.min(vh - VIEWPORT_PAD - (pendingY + dragged.h), vh - clientY);
  if (pendingY + dragged.h >= vh - VIEWPORT_PAD - EDGE_SNAP_DIST || clientY >= vh - EDGE_SNAP_DIST) {
    const previewH = Math.min(230, dragged.h + 14);
    candidates.push({
      zone: 'bottom',
      dist: Math.max(0, bottomDist),
      label: '底部横向排布',
      rect: { x: VIEWPORT_PAD, y: vh - previewH - 10, w: Math.max(240, vw - VIEWPORT_PAD * 2), h: previewH },
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates[0];
}

function getCardById(id) {
  return stickies.find((s) => s.id === id) || null;
}

function bringStickyForward(sticky) {
  if (!sticky) return;
  zCounter += 1;
  sticky.z = zCounter;
  const card = layerEl?.querySelector(`.sticky-card[data-sticky-id="${CSS.escape(sticky.id)}"]`);
  if (card) {
    card.style.zIndex = String(computeZIndex(sticky));
  }
}

function createCardElement(stickyId) {
  const card = document.createElement('section');
  card.className = 'sticky-card';
  card.dataset.stickyId = stickyId;
  card.setAttribute('aria-label', '浮动灵感便签');

  const swatchItemsHtml = STICKY_COLORS.map(
    (c) => `
      <button
        type="button"
        class="sticky-color-swatch swatch-${c}"
        data-sticky-color="${c}"
        title="${STICKY_COLOR_LABELS[c]}"
        aria-label="切换为${STICKY_COLOR_LABELS[c]}"
        style="background:${STICKY_COLOR_SWATCHES[c]};"
      ></button>
    `
  ).join('');

  card.innerHTML = `
    <header class="sticky-header" title="按住拖动便签位置，堆叠时整组同移（按住 Alt 拖出单卡）">
      <div class="sticky-header-left">
        <span class="sticky-grip" aria-hidden="true">⋮⋮</span>
        <span class="sticky-title">闪念卡</span>
        <button type="button" class="sticky-stack-badge hidden" data-sticky-action="toggle-stack" hidden></button>
        <button type="button" class="sticky-detach-btn hidden" data-sticky-action="detach-stack" title="从堆叠中抽出此卡（或按住 Alt 拖出）" aria-label="从堆叠中抽出此卡" hidden>↗ 抽出</button>
      </div>
      <div class="sticky-win-actions">
        <div class="sticky-color-anchor">
          <button type="button" class="sticky-color-btn" data-sticky-action="toggle-color-popover" title="切换便签纸张颜色" aria-label="切换便签颜色"></button>
          <div class="sticky-color-popover hidden" role="menu" aria-label="选择便签颜色" hidden>
            ${swatchItemsHtml}
            <label class="sticky-custom-color-btn" title="自定义任意颜色">🎨<input type="color" class="sticky-custom-color-input" data-sticky-action="custom-color" value="${STICKY_COLOR_SWATCHES.yellow}" aria-label="自定义任意颜色"></label>
          </div>
        </div>
        <button type="button" class="sticky-icon-btn sticky-pin-btn" data-sticky-action="toggle-pin" title="固定位置（免受自动整理和误拖影响）" aria-label="固定便签位置">
          ${icon('pin', 13)}
        </button>
        <button type="button" class="sticky-icon-btn" data-sticky-action="minimize" title="收起到灵动岛闪念控制" aria-label="收起便签">—</button>
        <button type="button" class="sticky-icon-btn sticky-close-btn" data-sticky-action="delete" title="移入内置回收站" aria-label="移入回收站">✕</button>
      </div>
    </header>
    <textarea class="sticky-textarea" placeholder="随手记下灵感、待办或引用，可拖入笔记…"></textarea>
    <footer class="sticky-footer">
      <span class="sticky-action-pill" data-sticky-action="drag-to-note" draggable="true" title="按住拖入中间 Markdown 笔记或灵感收纳岛（按住 Ctrl 复制）">
        ⠿ 拖入笔记
      </span>
      <button type="button" class="sticky-action-pill" data-sticky-action="ai-todo" title="让 AI 提炼为结构化待办">
        ✨ AI 待办
      </button>
    </footer>
    <span class="sticky-resize-handle" title="按住拖动调节卡片大小" aria-hidden="true"></span>
  `;

  bindCardInteractions(card, stickyId);
  return card;
}

function bindCardInteractions(card, stickyId) {
  const header = card.querySelector('.sticky-header');
  const textarea = card.querySelector('.sticky-textarea');
  const dragPill = card.querySelector('[data-sticky-action="drag-to-note"]');
  const resizeHandle = card.querySelector('.sticky-resize-handle');
  const colorBtn = card.querySelector('[data-sticky-action="toggle-color-popover"]');
  const colorPopover = card.querySelector('.sticky-color-popover');
  const customColorInput = card.querySelector('.sticky-custom-color-input');
  const pinBtn = card.querySelector('[data-sticky-action="toggle-pin"]');
  const stackBadge = card.querySelector('[data-sticky-action="toggle-stack"]');
  const detachBtn = card.querySelector('[data-sticky-action="detach-stack"]');
  const minBtn = card.querySelector('[data-sticky-action="minimize"]');
  const closeBtn = card.querySelector('[data-sticky-action="delete"]');
  const todoBtn = card.querySelector('[data-sticky-action="ai-todo"]');

  card.addEventListener('pointerdown', (e) => {
    // Ignore header action controls & color UI so underlying stacked cards never re-render/steal clicks before click fires
    if (e.target.closest('.sticky-header button, .sticky-color-anchor, .sticky-color-popover, input')) {
      return;
    }
    const sticky = getCardById(stickyId);
    if (!sticky) return;

    // Header drag handles stack focus/layout on pointerup so lockstep dragging never shifts mid-grab
    if (e.target.closest('.sticky-header')) {
      if (!sticky.stackId) {
        bringStickyForward(sticky);
        saveStickies();
      }
      return;
    }

    bringStickyForward(sticky);
    if (sticky.stackId && !sticky.stackExpanded) {
      const group = getStackGroups().get(sticky.stackId);
      const anchorX = group ? Math.min(...group.map((m) => m.x)) : sticky.x;
      const anchorY = group ? Math.min(...group.map((m) => m.y)) : sticky.y;
      layoutStack(sticky.stackId, anchorX, anchorY);
      saveStickies();
      renderStickies();
    } else {
      saveStickies();
    }
  });

  // Free dragging with setPointerCapture + body.is-dragging-sticky + lockstep stack move + region/stack detection
  if (header) {
    let dragging = false;
    let rafId = 0;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;
    let pendingX = 0;
    let pendingY = 0;
    let lastClientX = 0;
    let lastClientY = 0;
    let movedFar = false;
    let activeOverlapTarget = null;
    let activeEdge = null;
    let origStackId = null;
    let isGroupDrag = false;
    let dragGroup = null;
    let preDragSnapshot = null;
    let altDetached = false;
    let globalDragStarted = false;

    const STICKY_TRASH_SEL = '#portable-trash-dock, [data-drop-zone="trash"], [data-drop-zone="app-trash"], [data-drop-zone="system-trash"]';
    const clearStickyGlobalDropHighlights = () => {
      document
        .querySelectorAll('#portable-trash-dock.is-drag-over, [data-drop-zone].is-drag-over, #dynamic-island.is-drag-over')
        .forEach((el) => el.classList.remove('is-drag-over'));
    };

    const hitTestGlobalDropTargets = (cx, cy) => {
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { trashTarget: null, shelfTarget: null };
      const hitEls = document.elementsFromPoint(cx, cy);
      const trashTarget = hitEls.find((el) => el.matches?.(STICKY_TRASH_SEL))
        || hitEls.map((el) => el.closest?.(STICKY_TRASH_SEL)).find(Boolean)
        || null;
      const shelfTarget = !trashTarget
        ? (hitEls.find((el) => el.matches?.('[data-drop-zone="drag-shelf"], #dynamic-island'))
          || hitEls.map((el) => el.closest?.('[data-drop-zone="drag-shelf"], #dynamic-island')).find(Boolean)
          || null)
        : null;
      return { trashTarget, shelfTarget };
    };

    const getGroupBBoxPending = () => {
      if (!dragGroup || dragGroup.length === 0) {
        const s = getCardById(stickyId);
        return { x: pendingX, y: pendingY, w: s?.w || DEFAULT_W, h: s?.h || DEFAULT_H };
      }
      const minX = Math.min(...dragGroup.map((m) => m.pendingX));
      const minY = Math.min(...dragGroup.map((m) => m.pendingY));
      const maxR = Math.max(...dragGroup.map((m) => m.pendingX + m.sticky.w));
      const maxB = Math.max(...dragGroup.map((m) => m.pendingY + m.sticky.h));
      return { x: minX, y: minY, w: maxR - minX, h: maxB - minY };
    };

    const flushDrag = () => {
      rafId = 0;
      const sticky = getCardById(stickyId);
      if (!sticky) return;

      if (isGroupDrag && dragGroup && dragGroup.length >= 2) {
        for (const m of dragGroup) {
          m.sticky.x = m.pendingX;
          m.sticky.y = m.pendingY;
          if (m.card) {
            m.card.style.transform = `translate3d(${m.pendingX}px, ${m.pendingY}px, 0)`;
          }
        }
      } else {
        sticky.x = pendingX;
        sticky.y = pendingY;
        card.style.transform = `translate3d(${pendingX}px, ${pendingY}px, 0)`;
      }

      clearStackTargetHighlights();
      clearStickyGlobalDropHighlights();
      if (globalDragStarted) {
        const { trashTarget, shelfTarget } = hitTestGlobalDropTargets(lastClientX, lastClientY);
        if (trashTarget) {
          trashTarget.classList.add('is-drag-over');
          activeOverlapTarget = null;
          activeEdge = null;
          hideSnapPreview();
          return;
        }
        if (shelfTarget) {
          shelfTarget.classList.add('is-drag-over');
          activeOverlapTarget = null;
          activeEdge = null;
          hideSnapPreview();
          return;
        }
      }

      const excludeSid = isGroupDrag ? origStackId : null;
      activeOverlapTarget = findOverlapTarget(sticky, pendingX, pendingY, lastClientX, lastClientY, excludeSid);
      if (activeOverlapTarget) {
        activeEdge = null;
        const targetEl = getCardElementById(activeOverlapTarget.id);
        targetEl?.classList.add('is-stack-target');
        showSnapPreview(
          { x: activeOverlapTarget.x, y: activeOverlapTarget.y, w: activeOverlapTarget.w, h: activeOverlapTarget.h },
          '松手合并堆叠'
        );
        return;
      }

      if (isGroupDrag && dragGroup && dragGroup.length >= 2) {
        const bbox = getGroupBBoxPending();
        activeEdge = detectEdgeZone(bbox, bbox.x, bbox.y, lastClientX, lastClientY);
      } else {
        activeEdge = detectEdgeZone(sticky, pendingX, pendingY, lastClientX, lastClientY);
      }

      if (activeEdge) {
        showSnapPreview(activeEdge.rect, activeEdge.label);
      } else {
        hideSnapPreview();
      }
    };

    const stopDrag = (e) => {
      if (!dragging) return;
      dragging = false;

      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      window.removeEventListener('blur', stopDrag);

      if (pointerId !== null) {
        try {
          header.releasePointerCapture?.(pointerId);
        } catch {
          // ignore
        }
        pointerId = null;
      }

      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }

      document.body.classList.remove('is-dragging-sticky');
      card.classList.remove('is-moving');
      if (dragGroup) {
        for (const m of dragGroup) {
          m.card?.classList.remove('is-moving');
        }
      }
      clearStackTargetHighlights();
      clearStickyGlobalDropHighlights();
      hideSnapPreview();

      const sticky = getCardById(stickyId);
      const isCancel = e?.type === 'pointercancel' || e?.type === 'blur';
      const dropX = Number.isFinite(e?.clientX) && e.clientX !== 0 ? e.clientX : lastClientX;
      const dropY = Number.isFinite(e?.clientY) && e.clientY !== 0 ? e.clientY : lastClientY;
      const hitResult = !isCancel && movedFar && globalDragStarted
        ? hitTestGlobalDropTargets(dropX, dropY)
        : { trashTarget: null, shelfTarget: null };

      if (globalDragStarted) {
        globalDragStarted = false;
        store.endGlobalDrag?.();
      }

      const restorePreDragGeometry = () => {
        if (dragGroup && dragGroup.length > 0) {
          for (const m of dragGroup) {
            m.sticky.x = m.origX;
            m.sticky.y = m.origY;
            m.sticky.w = m.origW;
            m.sticky.h = m.origH;
            m.sticky.origW = m.origOrigW;
            m.sticky.origH = m.origOrigH;
            m.sticky.stackId = m.origStackId;
            m.sticky.stackExpanded = m.origStackExpanded;
            m.sticky.zone = m.origZone;
          }
        } else if (sticky && preDragSnapshot) {
          sticky.x = preDragSnapshot.x;
          sticky.y = preDragSnapshot.y;
          sticky.w = preDragSnapshot.w;
          sticky.h = preDragSnapshot.h;
          sticky.origW = preDragSnapshot.origW;
          sticky.origH = preDragSnapshot.origH;
          sticky.stackId = preDragSnapshot.stackId;
          sticky.stackExpanded = preDragSnapshot.stackExpanded;
          sticky.zone = preDragSnapshot.zone;
        }
      };

      if (sticky && hitResult.trashTarget) {
        restorePreDragGeometry();
        activeOverlapTarget = null;
        activeEdge = null;
        dragGroup = null;
        preDragSnapshot = null;
        isGroupDrag = false;
        altDetached = false;
        trashStickyById(sticky.id);
        return;
      }

      if (sticky && hitResult.shelfTarget) {
        restorePreDragGeometry();
        const text = String(sticky.content || '').trim();
        if (text) {
          store.emit('shelf:add-item', {
            type: 'sticky',
            kind: 'sticky',
            title: getStickyTitle(sticky),
            label: getStickyTitle(sticky),
            markdown: sticky.content,
            content: sticky.content,
            sourceStickyId: sticky.id,
          });
        } else {
          showToast('空白闪念无法暂存，请先输入内容', 'warning');
        }
        activeOverlapTarget = null;
        activeEdge = null;
        dragGroup = null;
        preDragSnapshot = null;
        isGroupDrag = false;
        altDetached = false;
        saveStickies();
        renderStickies();
        return;
      }

      if (sticky) {
        if (isCancel) {
          restorePreDragGeometry();
        } else if (!movedFar) {
          if (isGroupDrag && origStackId) {
            const anchorX = Math.min(...dragGroup.map((m) => m.origX));
            const anchorY = Math.min(...dragGroup.map((m) => m.origY));
            bringStickyForward(sticky);
            if (!sticky.stackExpanded) {
              layoutStack(origStackId, anchorX, anchorY);
            }
          } else if (origStackId) {
            sticky.stackId = origStackId;
            bringStickyForward(sticky);
          }
        } else if (isGroupDrag && dragGroup && dragGroup.length >= 2) {
          for (const m of dragGroup) {
            m.sticky.x = m.pendingX;
            m.sticky.y = m.pendingY;
          }

          if (activeOverlapTarget) {
            const target = getCardById(activeOverlapTarget.id);
            if (target && !target.pinned) {
              const targetMembers = target.stackId
                ? (getStackGroups().get(target.stackId) || [target])
                : [target];
              const targetAnchorX = Math.min(...targetMembers.map((m) => m.x));
              const targetAnchorY = Math.min(...targetMembers.map((m) => m.y));

              const undoItems = [
                ...dragGroup.map((m) =>
                  snapshotStickyState(m.sticky, {
                    x: m.origX,
                    y: m.origY,
                    w: m.origW,
                    h: m.origH,
                    origW: m.origOrigW,
                    origH: m.origOrigH,
                    stackId: m.origStackId,
                    stackExpanded: m.origStackExpanded,
                    zone: m.origZone,
                    z: m.origZ,
                  })
                ),
                ...targetMembers.map((m) => snapshotStickyState(m)),
              ];
              pushMergeUndoSnapshot(undoItems);

              const sid = target.stackId || origStackId || `stack_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
              for (const m of [...targetMembers, ...dragGroup.map((d) => d.sticky)]) {
                if (!Number.isFinite(Number(m.origW)) || Number(m.origW) <= 0) m.origW = m.w;
                if (!Number.isFinite(Number(m.origH)) || Number(m.origH) <= 0) m.origH = m.h;
                m.stackId = sid;
                m.stackExpanded = false;
                m.zone = 'free';
              }
              for (const m of dragGroup) {
                m.sticky.z = ++zCounter;
              }
              cleanupOrphanStacks();
              applyUnifiedStackSize(sid);
              layoutStack(sid, targetAnchorX, targetAnchorY);
              showToast('已合并堆叠（按 Ctrl+Z 或在灵动岛闪念控制点「撤销合并」可还原）', 'success', { duration: 3200 });
            }
          } else if (activeEdge) {
            const { vw, vh } = getViewportSize();
            const bbox = getGroupBBoxPending();
            const maxCardW = Math.max(...dragGroup.map((m) => m.sticky.w));
            let anchorX = bbox.x;
            let anchorY = bbox.y;
            if (activeEdge.zone === 'left') {
              anchorX = VIEWPORT_PAD;
            } else if (activeEdge.zone === 'right') {
              anchorX = vw - maxCardW - VIEWPORT_PAD;
            } else if (activeEdge.zone === 'top') {
              anchorY = TOP_BAR_SAFE_Y + 4;
            } else if (activeEdge.zone === 'bottom') {
              anchorY = vh - bbox.h - VIEWPORT_PAD;
            }
            layoutStack(origStackId, anchorX, anchorY);
          }
        } else {
          sticky.x = pendingX;
          sticky.y = pendingY;

          if (activeOverlapTarget) {
            const target = getCardById(activeOverlapTarget.id);
            if (target && !target.pinned) {
              const targetMembers = target.stackId
                ? (getStackGroups().get(target.stackId) || [target])
                : [target];
              const targetAnchorX = Math.min(...targetMembers.map((m) => m.x));
              const targetAnchorY = Math.min(...targetMembers.map((m) => m.y));

              const undoItems = [
                preDragSnapshot || snapshotStickyState(sticky, { x: origX, y: origY }),
                ...targetMembers.map((m) => snapshotStickyState(m)),
              ];
              pushMergeUndoSnapshot(undoItems);

              const sid = target.stackId || `stack_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
              for (const m of targetMembers) {
                if (!Number.isFinite(Number(m.origW)) || Number(m.origW) <= 0) m.origW = m.w;
                if (!Number.isFinite(Number(m.origH)) || Number(m.origH) <= 0) m.origH = m.h;
                m.stackId = sid;
                m.stackExpanded = false;
                m.zone = 'free';
              }
              if (!Number.isFinite(Number(sticky.origW)) || Number(sticky.origW) <= 0) sticky.origW = sticky.w;
              if (!Number.isFinite(Number(sticky.origH)) || Number(sticky.origH) <= 0) sticky.origH = sticky.h;
              sticky.stackId = sid;
              sticky.stackExpanded = false;
              sticky.zone = 'free';
              sticky.z = ++zCounter;
              cleanupOrphanStacks();
              applyUnifiedStackSize(sid);
              layoutStack(sid, targetAnchorX, targetAnchorY);
              showToast('已合并堆叠（按 Ctrl+Z 或在灵动岛闪念控制点「撤销合并」可还原）', 'success', { duration: 3200 });
            }
          } else if (activeEdge) {
            sticky.stackId = null;
            sticky.stackExpanded = false;
            sticky.zone = activeEdge.zone;
            restoreStickyOrigSize(sticky);
            cleanupOrphanStacks();
            arrangeZone(activeEdge.zone);
          } else {
            sticky.stackId = null;
            sticky.stackExpanded = false;
            sticky.zone = 'free';
            restoreStickyOrigSize(sticky);
            cleanupOrphanStacks();
          }
        }
      }

      activeOverlapTarget = null;
      activeEdge = null;
      dragGroup = null;
      preDragSnapshot = null;
      isGroupDrag = false;
      altDetached = false;
      saveStickies();
      renderStickies();
    };

    const detachDraggedSingleCard = (sticky) => {
      const oldSid = sticky.stackId;
      if (!oldSid) return;
      sticky.stackId = null;
      sticky.stackExpanded = false;
      sticky.zone = 'free';
      origStackId = null;
      restoreStickyOrigSize(sticky);
      card.style.width = `${sticky.w}px`;
      card.style.height = `${sticky.h}px`;
      bringStickyForward(sticky);
      cleanupOrphanStacks();
      if (getStackGroups().has(oldSid)) {
        layoutStack(oldSid);
        syncStackCardsDom(oldSid);
      }
    };

    const onMove = (e) => {
      if (!dragging) return;
      const sticky = getCardById(stickyId);
      if (!sticky) return;

      lastClientX = e.clientX;
      lastClientY = e.clientY;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dist = Math.hypot(dx, dy);

      if (sticky.pinned) {
        if (dist > 4) {
          notifyPinnedBlocked(card);
        }
        return;
      }

      if (dist > 4) {
        movedFar = true;
        if (!globalDragStarted) {
          globalDragStarted = true;
          store.beginGlobalDrag?.({
            type: 'sticky',
            kind: 'sticky',
            id: sticky.id,
            sourceStickyId: sticky.id,
            title: getStickyTitle(sticky),
            content: sticky.content,
            sticky: { ...sticky },
          });
        }
      }

      // Alt+drag detaches ONLY this single card out of the stack
      if (isGroupDrag && e.altKey && dist > 4 && dragGroup) {
        for (const m of dragGroup) {
          if (m.sticky.id !== stickyId) {
            m.sticky.x = m.origX;
            m.sticky.y = m.origY;
            if (m.card) {
              m.card.style.transform = `translate3d(${m.origX}px, ${m.origY}px, 0)`;
              m.card.classList.remove('is-moving');
            }
          }
        }
        isGroupDrag = false;
        dragGroup = null;
        altDetached = true;
        detachDraggedSingleCard(sticky);
      } else if (!isGroupDrag && origStackId && !altDetached && dist > 4) {
        altDetached = true;
        detachDraggedSingleCard(sticky);
      }

      if (isGroupDrag && dragGroup && dragGroup.length >= 2) {
        const { vw, vh } = getViewportSize();
        const minOrigX = Math.min(...dragGroup.map((m) => m.origX));
        const minOrigY = Math.min(...dragGroup.map((m) => m.origY));
        const maxOrigR = Math.max(...dragGroup.map((m) => m.origX + m.sticky.w));
        const maxOrigB = Math.max(...dragGroup.map((m) => m.origY + m.sticky.h));

        const minDx = VIEWPORT_PAD - minOrigX;
        const maxDx = Math.max(minDx, vw - VIEWPORT_PAD - maxOrigR);
        const minDy = TOP_BAR_SAFE_Y - minOrigY;
        const maxDy = Math.max(minDy, vh - VIEWPORT_PAD - maxOrigB);

        const clampedDx = Math.round(Math.max(minDx, Math.min(maxDx, dx)));
        const clampedDy = Math.round(Math.max(minDy, Math.min(maxDy, dy)));

        for (const m of dragGroup) {
          m.pendingX = clampPosX(m.origX + clampedDx, m.sticky.w);
          m.pendingY = clampPosY(m.origY + clampedDy, m.sticky.h);
          if (m.sticky.id === stickyId) {
            pendingX = m.pendingX;
            pendingY = m.pendingY;
          }
        }
      } else {
        pendingX = clampPosX(origX + dx, sticky.w);
        pendingY = clampPosY(origY + dy, sticky.h);
      }

      if (!rafId) {
        rafId = window.requestAnimationFrame(flushDrag);
      }
    };

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, .sticky-color-anchor, .sticky-color-popover, input, label')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const sticky = getCardById(stickyId);
      if (!sticky) return;
      closeAllColorPopovers();

      if (sticky.pinned) {
        notifyPinnedBlocked(card);
        return;
      }

      e.preventDefault();
      dragging = true;
      movedFar = false;
      altDetached = false;
      pointerId = e.pointerId ?? null;
      startX = e.clientX;
      startY = e.clientY;
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      origX = sticky.x;
      origY = sticky.y;
      pendingX = sticky.x;
      pendingY = sticky.y;
      origStackId = sticky.stackId;
      preDragSnapshot = snapshotStickyState(sticky);

      const stackMembers = origStackId ? (getStackGroups().get(origStackId) || null) : null;
      if (!e.altKey && stackMembers && stackMembers.length >= 2) {
        isGroupDrag = true;
        dragGroup = stackMembers.map((m) => ({
          sticky: m,
          card: getCardElementById(m.id),
          origX: m.x,
          origY: m.y,
          pendingX: m.x,
          pendingY: m.y,
          origW: m.w,
          origH: m.h,
          origOrigW: m.origW ?? null,
          origOrigH: m.origH ?? null,
          origStackId: m.stackId ?? null,
          origStackExpanded: Boolean(m.stackExpanded),
          origZone: m.zone || 'free',
          origZ: m.z,
        }));
        for (const m of dragGroup) {
          m.card?.classList.add('is-moving');
        }
      } else {
        isGroupDrag = false;
        dragGroup = null;
        card.classList.add('is-moving');
      }

      document.body.classList.add('is-dragging-sticky');
      try {
        header.setPointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stopDrag);
      window.addEventListener('pointercancel', stopDrag);
      window.addEventListener('blur', stopDrag);
    });
  }

  // Smooth corner resizing with viewport clamping + adaptive stack sync
  if (resizeHandle) {
    let resizing = false;
    let rafId = 0;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let origW = DEFAULT_W;
    let origH = DEFAULT_H;
    let pendingW = DEFAULT_W;
    let pendingH = DEFAULT_H;
    let resizeStackId = null;
    let resizeAnchorX = 0;
    let resizeAnchorY = 0;

    const flushSize = () => {
      rafId = 0;
      const sticky = getCardById(stickyId);
      if (!sticky) return;

      if (resizeStackId) {
        const group = getStackGroups().get(resizeStackId);
        if (group && group.length >= 2) {
          for (const m of group) {
            m.w = pendingW;
            m.h = pendingH;
          }
          layoutStack(resizeStackId, resizeAnchorX, resizeAnchorY);
          syncStackCardsDom(resizeStackId);
          return;
        }
      }

      sticky.w = pendingW;
      sticky.h = pendingH;
      card.style.width = `${pendingW}px`;
      card.style.height = `${pendingH}px`;
    };

    const onResizeMove = (e) => {
      if (!resizing) return;
      const sticky = getCardById(stickyId);
      if (!sticky) return;
      pendingW = clampWidth(origW + (e.clientX - startX), sticky.x);
      pendingH = clampHeight(origH + (e.clientY - startY), sticky.y);
      if (!rafId) {
        rafId = window.requestAnimationFrame(flushSize);
      }
    };

    const stopResize = () => {
      if (!resizing) return;
      resizing = false;
      window.removeEventListener('pointermove', onResizeMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
      window.removeEventListener('blur', stopResize);

      if (pointerId !== null) {
        try {
          resizeHandle.releasePointerCapture?.(pointerId);
        } catch {
          // ignore
        }
        pointerId = null;
      }

      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      flushSize();

      document.body.classList.remove('is-dragging-sticky');
      card.classList.remove('is-resizing');
      resizeStackId = null;
      saveStickies();
      renderStickies();
    };

    resizeHandle.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const sticky = getCardById(stickyId);
      if (!sticky) return;

      if (sticky.pinned) {
        e.stopPropagation();
        notifyPinnedBlocked(card);
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      pointerId = e.pointerId ?? null;
      startX = e.clientX;
      startY = e.clientY;
      origW = sticky.w;
      origH = sticky.h;
      pendingW = sticky.w;
      pendingH = sticky.h;

      const group = sticky.stackId ? getStackGroups().get(sticky.stackId) : null;
      if (group && group.length >= 2) {
        resizeStackId = sticky.stackId;
        resizeAnchorX = Math.min(...group.map((m) => m.x));
        resizeAnchorY = Math.min(...group.map((m) => m.y));
      } else {
        resizeStackId = null;
      }

      card.classList.add('is-resizing');
      document.body.classList.add('is-dragging-sticky');
      try {
        resizeHandle.setPointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
      window.addEventListener('pointermove', onResizeMove);
      window.addEventListener('pointerup', stopResize);
      window.addEventListener('pointercancel', stopResize);
      window.addEventListener('blur', stopResize);
    });
  }

  // Persist text edits live without re-rendering DOM
  textarea?.addEventListener('input', () => {
    const sticky = getCardById(stickyId);
    if (!sticky) return;
    sticky.content = textarea.value;
    saveStickies();
  });

  // Rounded-square color swatch button -> toggle 6-swatch + custom color popover
  colorBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!colorPopover) return;
    const willOpen = colorPopover.hidden || colorPopover.classList.contains('hidden');
    closeAllColorPopovers(card);
    setElementVisibility(colorPopover, willOpen);
  });

  // 6-swatch selection inside popover
  colorPopover?.addEventListener('click', (e) => {
    const swatch = e.target.closest('[data-sticky-color]');
    if (!swatch) return;
    e.preventDefault();
    e.stopPropagation();
    const nextColor = swatch.dataset.stickyColor;
    const sticky = getCardById(stickyId);
    if (!sticky || !STICKY_COLORS.includes(nextColor)) return;
    sticky.color = nextColor;
    sticky.customColor = '';
    setElementVisibility(colorPopover, false);
    saveStickies();
    renderStickies();
  });

  // Custom color picker input (live preview on input, close & commit on change)
  if (customColorInput) {
    customColorInput.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    customColorInput.addEventListener('input', () => {
      const hex = normalizeCustomColor(customColorInput.value);
      const sticky = getCardById(stickyId);
      if (!sticky || !hex) return;
      sticky.customColor = hex;
      saveStickies();
      card.style.setProperty('--sticky-accent', hex);
      card.classList.add('has-custom-color');
      if (colorBtn) {
        colorBtn.style.backgroundColor = hex;
        colorBtn.dataset.color = 'custom';
        colorBtn.title = `当前颜色：自定义 (${hex})（点击切换）`;
      }
      card.querySelectorAll('.sticky-color-swatch').forEach((sw) => sw.classList.remove('is-active'));
      card.querySelector('.sticky-custom-color-btn')?.classList.add('is-active');
    });
    customColorInput.addEventListener('change', () => {
      const hex = normalizeCustomColor(customColorInput.value);
      const sticky = getCardById(stickyId);
      if (sticky && hex) {
        sticky.customColor = hex;
      }
      setElementVisibility(colorPopover, false);
      saveStickies();
      renderStickies();
    });
  }

  // Pin lock toggle
  pinBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sticky = getCardById(stickyId);
    if (!sticky) return;
    sticky.pinned = !sticky.pinned;
    if (sticky.pinned) {
      sticky.stackId = null;
      sticky.stackExpanded = false;
      sticky.zone = 'free';
      restoreStickyOrigSize(sticky);
      cleanupOrphanStacks();
      showToast('已固定位置（免受自动整理和拖拽影响）', 'success', { duration: 1800 });
    } else {
      showToast('已取消固定', 'info', { duration: 1500 });
    }
    saveStickies();
    renderStickies();
  });

  // Stack expand/collapse badge
  stackBadge?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sticky = getCardById(stickyId);
    if (!sticky || !sticky.stackId) return;
    const groups = getStackGroups();
    const list = groups.get(sticky.stackId);
    if (!list || list.length < 2) return;
    const nextExpanded = !list.some((s) => s.stackExpanded);
    list.forEach((s) => {
      s.stackExpanded = nextExpanded;
    });
    layoutStack(sticky.stackId);
    saveStickies();
    renderStickies();
  });

  // Detach single card from stack
  detachBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    detachStickyFromStack(stickyId, { offsetStep: true });
  });

  // Minimize card
  minBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sticky = getCardById(stickyId);
    if (!sticky) return;
    sticky.minimized = true;
    sticky.stackId = null;
    sticky.stackExpanded = false;
    restoreStickyOrigSize(sticky);
    cleanupOrphanStacks();
    saveStickies();
    renderStickies();
  });

  // Move sticky into built-in recycle bin
  closeBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    trashStickyById(stickyId);
  });

  // Send card content to AI Todo extraction
  todoBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sticky = getCardById(stickyId);
    if (!sticky) return;
    const text = String(sticky.content || '').trim();
    if (!text) {
      showToast('请先在便签中输入想法或待办内容', 'warning');
      textarea?.focus();
      return;
    }
    store.emit('ai:summarize-request', { text, autoRun: true });
    showToast('已发送便签内容至 AI 提取待办', 'info', { duration: 2000 });
  });

  // Drag-to-Note & Dynamic Island Dual Drop (<span draggable="true">)
  if (dragPill) {
    dragPill.addEventListener('dragstart', (e) => {
      const sticky = getCardById(stickyId);
      const text = String(sticky?.content || '').trim();
      if (!text) {
        e.preventDefault();
        showToast('空便签无法拖入笔记，请先写点内容', 'warning');
        return;
      }
      const title = getStickyTitle(sticky);
      const payload = {
        type: 'sticky',
        kind: 'sticky',
        id: sticky.id,
        label: title,
        title,
        markdown: sticky.content,
        content: sticky.content,
        dragMode: e.ctrlKey ? 'copy' : 'move',
        sourceStickyId: sticky.id,
        sticky: { ...sticky },
      };
      writeDragPayload(e, payload);
      store.beginGlobalDrag?.(payload);
      store.emit('drag:active', true);
      card.classList.add('is-dragging');
    });

    dragPill.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
      resetDragPayload();
      store.endGlobalDrag?.();
      store.emit('drag:active', false);
    });
  }
}

function updateCardElement(card, sticky, stackInfo, visibleIdx = 0) {
  const color = migrateColor(sticky.color);
  const customColor = normalizeCustomColor(sticky.customColor);
  const accentHex = customColor || STICKY_COLOR_SWATCHES[color];
  const mobileMode = isMobileStickyViewport();
  let w;
  let h;
  let renderX;
  let renderY;
  if (mobileMode) {
    const { vw, vh } = getViewportSize();
    w = Math.max(240, Math.min(380, Math.round(vw * 0.92)));
    const maxMobileH = Math.max(200, vh - 164);
    h = Math.max(200, Math.min(maxMobileH, Math.round(sticky.h || DEFAULT_H)));
    renderX = Math.max(8, Math.round((vw - w) / 2));
    const topSafe = 58;
    const maxY = Math.max(topSafe, vh - h - 84);
    const fallbackY = topSafe + (visibleIdx % 4) * 34;
    const rawY = Number.isFinite(Number(sticky.y)) ? Number(sticky.y) : fallbackY;
    renderY = Math.max(topSafe, Math.min(maxY, Math.round(rawY)));
  } else {
    w = clampWidth(sticky.w, sticky.x);
    h = clampHeight(sticky.h, sticky.y);
    renderX = sticky.x;
    renderY = sticky.y;
  }

  card.classList.remove(
    'sticky-yellow',
    'sticky-blue',
    'sticky-green',
    'sticky-pink',
    'sticky-purple',
    'sticky-slate'
  );
  card.classList.add(`sticky-${color}`);
  card.classList.toggle('is-mobile-card', mobileMode);
  card.classList.toggle('has-custom-color', Boolean(customColor));
  card.classList.toggle('is-pinned', Boolean(sticky.pinned));
  card.classList.toggle('is-stacked', !mobileMode && Boolean(stackInfo));
  card.classList.toggle('is-stack-expanded', !mobileMode && Boolean(stackInfo?.expanded));

  card.style.setProperty('--sticky-accent', accentHex);
  card.style.width = `${w}px`;
  card.style.height = `${h}px`;
  card.style.transform = `translate3d(${renderX}px, ${renderY}px, 0)`;
  card.style.zIndex = String(computeZIndex(sticky));

  // Sync textarea ONLY when not actively focused so cursor/scrollTop stay untouched
  const textarea = card.querySelector('.sticky-textarea');
  if (textarea && document.activeElement !== textarea && textarea.value !== sticky.content) {
    textarea.value = sticky.content;
  }

  // Sync single rounded-square color swatch button, 6 swatches & custom color picker
  const colorBtn = card.querySelector('.sticky-color-btn');
  if (colorBtn) {
    colorBtn.style.backgroundColor = accentHex;
    colorBtn.dataset.color = customColor ? 'custom' : color;
    colorBtn.title = customColor
      ? `当前颜色：自定义 (${customColor})（点击切换）`
      : `当前颜色：${STICKY_COLOR_LABELS[color]}（点击切换）`;
  }
  card.querySelectorAll('.sticky-color-swatch').forEach((sw) => {
    sw.classList.toggle('is-active', !customColor && sw.dataset.stickyColor === color);
  });
  const customInput = card.querySelector('.sticky-custom-color-input');
  if (customInput && document.activeElement !== customInput && customInput.value.toLowerCase() !== accentHex.toLowerCase()) {
    customInput.value = accentHex;
  }
  card.querySelector('.sticky-custom-color-btn')?.classList.toggle('is-active', Boolean(customColor));

  // Sync Pin button state & tooltip
  const pinBtn = card.querySelector('.sticky-pin-btn');
  if (pinBtn) {
    pinBtn.classList.toggle('is-active', Boolean(sticky.pinned));
    pinBtn.setAttribute('aria-pressed', sticky.pinned ? 'true' : 'false');
    pinBtn.title = sticky.pinned
      ? '已固定位置（点击钉子取消固定）'
      : '固定位置（免受自动整理和误拖影响）';
  }

  // Sync Stack badge on top card of a stack & detach button on all stacked cards
  const stackBadge = card.querySelector('.sticky-stack-badge');
  if (stackBadge) {
    if (stackInfo && stackInfo.isTop) {
      stackBadge.textContent = `📚 堆叠 ×${stackInfo.count} · ${stackInfo.expanded ? '收起' : '展开'}`;
      stackBadge.title = stackInfo.expanded ? '收起堆叠卡片' : '展开全部堆叠卡片';
      setElementVisibility(stackBadge, true);
    } else {
      setElementVisibility(stackBadge, false);
    }
  }
  const detachBtn = card.querySelector('[data-sticky-action="detach-stack"]');
  if (detachBtn) {
    setElementVisibility(detachBtn, Boolean(stackInfo));
  }
}

/**
 * Incremental DOM reconciliation for visible sticky cards & Island stickies control panel.
 */
function renderStickies() {
  const layer = ensureLayer();
  if (!layer) return;

  cleanupOrphanStacks();
  const stackGroups = getStackGroups();
  const visibleStickies = stickies.filter((s) => !s.minimized);
  const visibleIds = new Set(visibleStickies.map((s) => s.id));

  // Remove cards that are no longer visible
  Array.from(layer.querySelectorAll('.sticky-card[data-sticky-id]')).forEach((el) => {
    if (!visibleIds.has(el.dataset.stickyId)) {
      el.remove();
    }
  });

  // Update existing cards in-place or create missing ones
  visibleStickies.forEach((sticky, visibleIdx) => {
    let stackInfo = null;
    if (sticky.stackId && stackGroups.has(sticky.stackId)) {
      const group = stackGroups.get(sticky.stackId);
      stackInfo = {
        count: group.length,
        isTop: group[group.length - 1]?.id === sticky.id,
        expanded: group.some((s) => s.stackExpanded),
      };
    }

    let card = layer.querySelector(`.sticky-card[data-sticky-id="${CSS.escape(sticky.id)}"]`);
    if (!card) {
      card = createCardElement(sticky.id);
      layer.appendChild(card);
    }
    updateCardElement(card, sticky, stackInfo, visibleIdx);
  });

  renderStickiesControlPanel();
  syncStickiesCount();
}

export function spawnStickyAt(x, y, opts = {}) {
  return spawnStickyNote({ ...(opts || {}), x, y });
}

/**
 * Spawn a new floating tinted-paper sticky note at (x, y) and persist in localStorage.
 * @param {{ x?: number, y?: number, text?: string, content?: string, title?: string, color?: string, accent?: string, pinned?: boolean }} [opts={}]
 * @returns {object} created sticky object
 */
export function spawnStickyNote({ x, y, text, content, title = '', color, accent, customColor = '', pinned = false } = {}) {
  const { vw, vh } = getViewportSize();
  const offset = (stickies.length % 5) * 22;
  let w = DEFAULT_W;
  let h = DEFAULT_H;
  let targetX;
  let targetY;
  if (isMobileStickyViewport()) {
    const visibleCount = stickies.filter((s) => !s.minimized).length;
    const rect = getMobileStickyRect(visibleCount);
    w = rect.w;
    h = rect.h;
    targetX = rect.x;
    targetY = rect.y;
  } else {
    targetX = clampPosX(Number.isFinite(Number(x)) ? Number(x) : Math.round(vw * 0.56 + offset), w);
    targetY = clampPosY(Number.isFinite(Number(y)) ? Number(y) : Math.round(vh * 0.22 + offset), h);
  }
  const pickedColor = color || accent
    ? migrateColor(color || accent)
    : STICKY_COLORS[stickies.length % STICKY_COLORS.length];

  zCounter += 1;
  const sticky = {
    id: `sticky_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: String(title || '').trim(),
    content: String(content ?? text ?? ''),
    x: targetX,
    y: targetY,
    w,
    h,
    origW: null,
    origH: null,
    color: pickedColor,
    customColor: normalizeCustomColor(customColor),
    minimized: false,
    pinned: Boolean(pinned),
    z: zCounter,
    zone: 'free',
    stackId: null,
    stackExpanded: false,
  };

  stickies.push(sticky);
  saveStickies();
  renderStickies();

  window.requestAnimationFrame(() => {
    const ta = layerEl?.querySelector(`.sticky-card[data-sticky-id="${CSS.escape(sticky.id)}"] .sticky-textarea`);
    ta?.focus();
  });

  return sticky;
}

function handleContextMenuAction(action) {
  const spawnX = Number(menuEl?.dataset?.spawnX);
  const spawnY = Number(menuEl?.dataset?.spawnY);
  hideContextMenu();

  if (action === 'spawn-sticky') {
    spawnStickyAt(spawnX, spawnY);
  } else if (action === 'insert-url') {
    openUrlCapsuleSheet();
  } else if (action === 'ai-summarize') {
    const activeFile = store.state.activeFile;
    const text = store.state.activeDocumentText || '';
    if (!activeFile && !text.trim()) {
      showToast('请先打开一篇文档后再使用 AI 总结', 'warning');
      return;
    }
    const patch = { rightMode: 'summary', rightCollapsed: false };
    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
      patch.mobileTab = 'ai';
    }
    store.setState(patch, 'rightMode:changed');
    store.emit('layout:changed');
    store.emit('ai:summarize-request', {
      file_path: activeFile?.path || null,
      text,
      autoRun: true,
    });
  } else if (action === 'ai-polish') {
    const activeType = store.state.activeFile?.type;
    if (!store.state.activeFile || (activeType !== 'markdown' && activeType !== 'text')) {
      showToast('请先打开一篇 Markdown 或纯文本笔记后再使用 AI 润色', 'warning');
      return;
    }
    store.emit('center:polish-doc');
  } else if (action === 'toggle-mindmap') {
    store.emit('center:toggle-mindmap');
  } else if (action === 'semantic-search') {
    store.emit('spotlight:open', { mode: 'semantic' });
  }
}

function handleStickyCardContextAction(stickyId, action, colorValue = '') {
  const sticky = getCardById(stickyId);
  hideContextMenu();
  if (!sticky) return;

  if (colorValue && STICKY_COLORS.includes(colorValue)) {
    sticky.color = colorValue;
    sticky.customColor = '';
    saveStickies();
    renderStickies();
    return;
  }

  if (action === 'copy') {
    const text = String(sticky.content || '');
    if (!text.trim()) {
      showToast('闪念内容为空', 'warning');
      return;
    }
    copyInternal(text, '已复制闪念内容');
  } else if (action === 'toggle-pin') {
    sticky.pinned = !sticky.pinned;
    if (sticky.pinned) {
      sticky.stackId = null;
      sticky.stackExpanded = false;
      sticky.zone = 'free';
      restoreStickyOrigSize(sticky);
      cleanupOrphanStacks();
      showToast('已固定位置（免受自动整理和拖拽影响）', 'success', { duration: 1800 });
    } else {
      showToast('已取消固定', 'info', { duration: 1500 });
    }
    saveStickies();
    renderStickies();
  } else if (action === 'minimize') {
    sticky.minimized = true;
    sticky.stackId = null;
    sticky.stackExpanded = false;
    restoreStickyOrigSize(sticky);
    cleanupOrphanStacks();
    saveStickies();
    renderStickies();
    showToast('已收起到灵动岛闪念控制', 'info', { duration: 1600 });
  } else if (action === 'to-shelf') {
    const text = String(sticky.content || '').trim();
    if (!text) {
      showToast('空白闪念无法暂存，请先输入内容', 'warning');
      return;
    }
    const title = getStickyTitle(sticky);
    store.emit('shelf:add-item', {
      type: 'sticky',
      kind: 'sticky',
      title,
      label: title,
      markdown: sticky.content,
      content: sticky.content,
      sourceStickyId: sticky.id,
    });
  } else if (action === 'trash') {
    trashStickyById(sticky.id);
  }
}

function isSheetOpen() {
  const sheetOverlay = document.getElementById('sheet-overlay');
  return Boolean(
    sheetOverlay && !sheetOverlay.hidden && !sheetOverlay.classList.contains('hidden')
  );
}

/**
 * Initialize floating tinted-paper Stickies, Island control hub & Context Menus.
 */
export function initStickies() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;

  ensureV72StickiesStyles();
  document.getElementById('sticky-dock-pill')?.remove();

  stickies = loadStickies();
  ensureLayer();
  ensureSnapPreview();
  const menu = ensureContextMenu();
  bindStickiesPanelEvents();
  renderStickies();

  menu?.addEventListener('click', (e) => {
    const colorDot = e.target.closest('[data-sticky-ctx-color]');
    if (colorDot) {
      e.stopPropagation();
      const targetId = menu.dataset.targetStickyId;
      handleStickyCardContextAction(targetId, 'color', colorDot.dataset.stickyCtxColor);
      return;
    }
    const stickyBtn = e.target.closest('[data-sticky-ctx]');
    if (stickyBtn) {
      e.stopPropagation();
      const targetId = menu.dataset.targetStickyId;
      handleStickyCardContextAction(targetId, stickyBtn.dataset.stickyCtx);
      return;
    }
    const btn = e.target.closest('[data-ctx-action]');
    if (!btn) return;
    handleContextMenuAction(btn.dataset.ctxAction);
  });

  // Scoped right-click context menu: sticky cards anywhere + blank areas inside #center-panel
  document.addEventListener('contextmenu', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) {
      hideContextMenu();
      return;
    }

    const stickyCard = target.closest('.sticky-card[data-sticky-id]');
    if (stickyCard) {
      if (target.closest('input[type="color"]')) return;
      e.preventDefault();
      e.stopPropagation();
      closeAllColorPopovers();
      showStickyCardContextMenu(stickyCard.dataset.stickyId, e.clientX, e.clientY);
      return;
    }

    if (!target.closest('#center-panel')) {
      hideContextMenu();
      return;
    }

    if (
      target.closest(
        '#left-panel, #right-panel, #top-bar, #mindmap-canvas, .mindmap-stage, .mindmap-node, .explorer-home, .spark-card, .anchor-pill, .media-embed-card, #capsule-context-menu, #drag-shelf, #island-shelf-drawer, #module-context-menu, #slash-command-menu, #hover-peek-card'
      )
    ) {
      hideContextMenu();
      return;
    }

    // Preserve native copy/paste menu inside any editable element
    if (target.closest('input, textarea, [contenteditable="true"], [contenteditable]:not([contenteditable="false"])')) {
      hideContextMenu();
      return;
    }

    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
  });

  document.addEventListener('pointerdown', (e) => {
    if (menuEl && !menuEl.hidden && !menuEl.classList.contains('hidden') && !e.target.closest('#context-menu')) {
      hideContextMenu();
    }
    if (!e.target.closest('.sticky-color-anchor')) {
      closeAllColorPopovers();
    }
  });

  window.addEventListener('blur', () => {
    hideContextMenu();
    if (!document.activeElement?.classList?.contains('sticky-custom-color-input')) {
      closeAllColorPopovers();
    }
    document.body.classList.remove('is-dragging-sticky');
  });

  window.addEventListener('resize', () => {
    if (isMobileStickyViewport()) {
      renderStickies();
      return;
    }
    let changed = false;
    for (const s of stickies) {
      const nextX = clampPosX(s.x, s.w);
      const nextY = clampPosY(s.y, s.h);
      const nextW = clampWidth(s.w, nextX);
      const nextH = clampHeight(s.h, nextY);
      if (nextX !== s.x || nextY !== s.y || nextW !== s.w || nextH !== s.h) {
        s.x = nextX;
        s.y = nextY;
        s.w = nextW;
        s.h = nextH;
        changed = true;
      }
    }
    if (changed) {
      saveStickies();
      renderStickies();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
      closeAllColorPopovers();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
      const latest = lastMergeUndo[lastMergeUndo.length - 1];
      if (latest && Date.now() - latest.timestamp <= MERGE_UNDO_KEY_MS) {
        const active = document.activeElement;
        const isEditable =
          active instanceof Element &&
          Boolean(
            active.matches('input, textarea, [contenteditable="true"]') ||
              active.closest('input, textarea, [contenteditable="true"]') ||
              active.isContentEditable
          );
        if (!isEditable) {
          e.preventDefault();
          undoLastStackMerge();
          return;
        }
      }
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'n') {
      if (isSheetOpen()) return;
      e.preventDefault();
      hideContextMenu();
      spawnStickyNote();
    }
  });

  store.on('sticky:spawn', (opts) => {
    spawnStickyNote(opts || {});
  });

  store.on('stickies:spawn-at', ({ x, y, ...rest } = {}) => {
    spawnStickyAt(x, y, rest);
  });

  store.on('island:tab-change', (tab) => {
    if (tab === 'stickies') {
      renderStickiesControlPanel();
    }
  });

  store.on('sticky:consumed-by-drag', (payload) => {
    const sid = payload?.sourceStickyId || payload?.stickyId;
    if (!sid || payload?.dragMode === 'copy') return;
    const sticky = getCardById(sid);
    if (!sticky) return;
    if (payload?.remove) {
      stickies = stickies.filter((item) => item.id !== sid);
    } else {
      sticky.minimized = true;
      sticky.stackId = null;
      sticky.stackExpanded = false;
      restoreStickyOrigSize(sticky);
    }
    cleanupOrphanStacks();
    saveStickies();
    renderStickies();
  });

  store.on('trash:consumed-drag', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const kind = String(payload.kind || payload.type || '');
    const sid = payload.sourceStickyId || payload.stickyId || payload.sticky?.id || (kind === 'sticky' ? payload.id : '');
    if (!sid) return;
    if (!getCardById(sid)) return;
    stickies = stickies.filter((item) => item.id !== sid);
    cleanupOrphanStacks();
    saveStickies();
    renderStickies();
  });

  store.on('trash:restore-virtual', (res) => {
    const kind = String(res?.kind || res?.item?.kind || '');
    if (kind !== 'sticky') return;
    const item = res?.item || res;
    const saved = item?.payload && typeof item.payload === 'object' ? item.payload : {};
    const rawSticky = saved.sticky && typeof saved.sticky === 'object' ? saved.sticky : saved;
    const { vw, vh } = getViewportSize();
    let w;
    let h;
    let x;
    let y;
    if (isMobileStickyViewport()) {
      const rect = getMobileStickyRect(stickies.filter((s) => !s.minimized).length);
      w = rect.w;
      h = rect.h;
      x = rect.x;
      y = rect.y;
    } else {
      w = clampWidth(rawSticky.w ?? DEFAULT_W);
      h = clampHeight(rawSticky.h ?? DEFAULT_H);
      x = clampPosX(Number.isFinite(Number(rawSticky.x)) ? Number(rawSticky.x) : Math.round(vw * 0.52), w);
      y = clampPosY(Number.isFinite(Number(rawSticky.y)) ? Number(rawSticky.y) : Math.round(vh * 0.24), h);
    }
    const candidateId = String(rawSticky.id || saved.sourceStickyId || `sticky_${Date.now()}`);
    const uniqueId = getCardById(candidateId)
      ? `sticky_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      : candidateId;

    zCounter += 1;
    const restored = {
      id: uniqueId,
      title: String(rawSticky.title || ''),
      content: typeof rawSticky.content === 'string'
        ? rawSticky.content
        : (typeof rawSticky.text === 'string'
          ? rawSticky.text
          : String(saved.markdown || item?.title || '')),
      x,
      y,
      w,
      h,
      origW: null,
      origH: null,
      color: migrateColor(rawSticky.color || rawSticky.accent),
      customColor: normalizeCustomColor(rawSticky.customColor),
      minimized: false,
      pinned: Boolean(rawSticky.pinned),
      z: zCounter,
      zone: VALID_ZONES.has(rawSticky.zone) ? rawSticky.zone : 'free',
      stackId: null,
      stackExpanded: false,
    };

    stickies.push(restored);
    saveStickies();
    renderStickies();

    window.requestAnimationFrame(() => {
      const cardEl = getCardElementById(restored.id);
      if (cardEl) {
        cardEl.classList.remove('is-pin-pulse');
        void cardEl.offsetWidth;
        cardEl.classList.add('is-pin-pulse');
        window.setTimeout(() => cardEl.classList.remove('is-pin-pulse'), 650);
        cardEl.querySelector('.sticky-textarea')?.focus();
      }
    });
    showToast(`已从回收站还原闪念「${getStickyTitle(restored)}」`, 'success');
  });
}
