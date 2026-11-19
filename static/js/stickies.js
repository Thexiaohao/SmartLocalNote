/**
 * SmartLocalNote - Floating Tinted-Paper Stickies (V5) & Scoped Center Context Menu
 *  - V3 warm tinted paper aesthetic ('yellow' | 'blue' | 'green' | 'pink') without macOS traffic-light dots
 *  - Single rounded-square color swatch button in header + 4-swatch popover
 *  - Incremental DOM reconciliation preserving textarea focus, selection, and scrollTop
 *  - 60fps dragging & viewport-clamped resizing with setPointerCapture + body.is-dragging-sticky (PDF iframe safe)
 *  - Pin lock (sticky.pinned), region-aware magnetic edge auto-arrange, and multi-card stack/expand
 *  - Dock toolbar (#sticky-dock-pill) for restoring, tiling, stacking, and spawning
 *  - Drag-to-note (<span draggable="true">) integrated with store DragPayload & Drag Shelf
 *
 * Exports: initStickies, spawnStickyNote.
 */

import {
  store,
  escapeHtml,
  showToast,
  openSheet,
  closeSheet,
  setDragPayload,
  clearDragPayload,
} from './store.js';
import { api } from './api_client.js';
import { icon } from './icons.js';

const STICKIES_STORAGE_KEY = 'sln_stickies';
const STICKY_COLORS = ['yellow', 'blue', 'green', 'pink'];
const STICKY_COLOR_LABELS = {
  yellow: '奶油黄',
  blue: '晴空蓝',
  green: '薄荷绿',
  pink: '樱花粉',
};
const STICKY_COLOR_SWATCHES = {
  yellow: '#F6D55C',
  blue: '#6BB8FF',
  green: '#6CD992',
  pink: '#F595B5',
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
const STACK_DETACH_DIST = 36;

let initialized = false;
let stickies = [];
let layerEl = null;
let dockEl = null;
let menuEl = null;
let snapPreviewEl = null;
let zCounter = 1;
let lastPinToastAt = 0;

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

function migrateColor(raw) {
  if (STICKY_COLORS.includes(raw)) return raw;
  if (raw === 'amber') return 'yellow';
  if (raw === 'slate') return 'blue';
  return 'yellow';
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
          color,
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
    card.classList.remove('is-pin-shake');
    void card.offsetWidth;
    card.classList.add('is-pin-shake');
    window.setTimeout(() => card.classList.remove('is-pin-shake'), 320);
  }
  const now = Date.now();
  if (now - lastPinToastAt > 1800) {
    lastPinToastAt = now;
    showToast('已固定位置（点击钉子取消固定后可移动或调大小）', 'info', { duration: 1800 });
  }
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

function layoutStack(stackId, anchorX = null, anchorY = null) {
  if (!stackId) return;
  const groups = getStackGroups();
  const list = groups.get(stackId);
  if (!list || list.length < 2) return;

  const { vw, vh } = getViewportSize();
  const expanded = list.some((s) => s.stackExpanded);
  const maxCardW = Math.max(...list.map((s) => s.w));
  const maxCardH = Math.max(...list.map((s) => s.h));

  let baseX = Number.isFinite(anchorX) ? anchorX : list[0].x;
  let baseY = Number.isFinite(anchorY) ? anchorY : list[0].y;
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

  // Expanded: fan out neatly vertically with 10px gap, or side-by-side if vertical space insufficient
  const totalVertH = list.reduce((sum, s) => sum + s.h, 0) + (list.length - 1) * STACK_EXPAND_GAP;
  if (totalVertH <= vh - TOP_BAR_SAFE_Y - VIEWPORT_PAD) {
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

  // Side-by-side fan-out (near bottom or many cards), wrapping rows cleanly inside viewport
  let curX = clampPosX(baseX, maxCardW);
  let curY = Math.max(TOP_BAR_SAFE_Y, Math.min(vh - maxCardH - VIEWPORT_PAD, Math.round(baseY)));
  const totalRowW = list.reduce((sum, s) => sum + s.w, 0) + (list.length - 1) * STACK_EXPAND_GAP;
  if (curX + totalRowW > vw - VIEWPORT_PAD) {
    curX = Math.max(VIEWPORT_PAD, vw - Math.min(totalRowW, vw - VIEWPORT_PAD * 2) - VIEWPORT_PAD);
  }
  let rowMaxH = 0;
  for (const s of list) {
    if (curX + s.w > vw - VIEWPORT_PAD && curX > VIEWPORT_PAD) {
      curX = VIEWPORT_PAD;
      curY = clampPosY(curY + rowMaxH + STACK_EXPAND_GAP, s.h);
      rowMaxH = 0;
    }
    s.stackExpanded = true;
    s.zone = 'free';
    s.x = clampPosX(curX, s.w);
    s.y = clampPosY(curY, s.h);
    curX += s.w + STACK_EXPAND_GAP;
    rowMaxH = Math.max(rowMaxH, s.h);
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

  const { vw, vh } = getViewportSize();
  const sid = `stack_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  const maxW = Math.max(...unpinned.map((s) => s.w));
  const maxH = Math.max(...unpinned.map((s) => s.h));
  const deckX = clampPosX(vw - maxW - 22, maxW);
  const deckY = clampPosY(vh - maxH - (unpinned.length - 1) * STACK_CASCADE_STEP - 64, maxH);

  unpinned.sort((a, b) => a.z - b.z).forEach((s) => {
    s.stackId = sid;
    s.stackExpanded = false;
    s.zone = 'free';
  });

  layoutStack(sid, deckX, deckY);
  saveStickies();
  renderStickies();
  showToast(`已将 ${unpinned.length} 张便签合并堆叠`, 'success', { duration: 1600 });
}

function ensureDockPill() {
  if (typeof document === 'undefined') return null;
  if (!dockEl || !document.body.contains(dockEl)) {
    dockEl = document.getElementById('sticky-dock-pill');
    if (dockEl && dockEl.tagName === 'BUTTON') {
      dockEl.remove();
      dockEl = null;
    }
    if (!dockEl) {
      dockEl = document.createElement('div');
      dockEl.id = 'sticky-dock-pill';
      dockEl.className = 'sticky-dock-pill hidden';
      dockEl.setAttribute('role', 'toolbar');
      dockEl.setAttribute('aria-label', '闪念便签工具条');
      setElementVisibility(dockEl, false);
      document.body.appendChild(dockEl);
    } else {
      dockEl.setAttribute('role', 'toolbar');
      dockEl.setAttribute('aria-label', '闪念便签工具条');
    }
    if (!dockEl.dataset.dockBound) {
      dockEl.dataset.dockBound = '1';
      dockEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-dock-action]');
        if (!btn) return;
        const action = btn.dataset.dockAction;
        if (action === 'restore') {
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
        } else if (action === 'tile') {
          tileAllUnpinned();
        } else if (action === 'stack-all') {
          stackAllUnpinned();
        } else if (action === 'new') {
          spawnStickyNote();
        }
      });
    }
  }
  return dockEl;
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

function showContextMenu(clientX, clientY) {
  const menu = ensureContextMenu();
  if (!menu) return;

  menu.innerHTML = `
    <button type="button" class="context-menu-item" data-ctx-action="spawn-sticky" role="menuitem">
      <span class="ctx-item-left"><span>📝</span><span>在此处召唤闪念卡</span></span>
      <kbd class="ctx-kbd">Alt+N</kbd>
    </button>
    <button type="button" class="context-menu-item" data-ctx-action="insert-url" role="menuitem">
      <span class="ctx-item-left"><span>🌐</span><span>插入网址直达胶囊</span></span>
    </button>
    <div class="context-menu-sep" role="separator"></div>
    <button type="button" class="context-menu-item" data-ctx-action="ai-polish" role="menuitem">
      <span class="ctx-item-left"><span>✨</span><span>AI 润色当前笔记</span></span>
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
  menu.classList.remove('is-open');
  setElementVisibility(menu, true);

  // Measure layout width/height (unaffected by pre-open transform scale(0.95))
  const menuW = menu.offsetWidth || Math.ceil(menu.getBoundingClientRect().width) || 230;
  const menuH = menu.offsetHeight || Math.ceil(menu.getBoundingClientRect().height) || 200;
  const { vw, vh } = getViewportSize();
  const left = Math.max(8, Math.min(clientX, vw - menuW - 8));
  const top = Math.max(8, Math.min(clientY, vh - menuH - 8));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  window.requestAnimationFrame(() => {
    menu.classList.add('is-open');
  });
}

function findOverlapTarget(dragged, pendingX, pendingY, clientX, clientY) {
  const dragArea = dragged.w * dragged.h;
  let best = null;
  let bestScore = 0;

  for (const other of stickies) {
    if (other.id === dragged.id || other.minimized || other.pinned) continue;
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
    <header class="sticky-header" title="按住拖动便签位置，拖至边缘自动排布或重叠堆叠">
      <div class="sticky-header-left">
        <span class="sticky-grip" aria-hidden="true">⋮⋮</span>
        <span class="sticky-title">闪念卡</span>
        <button type="button" class="sticky-stack-badge hidden" data-sticky-action="toggle-stack" hidden></button>
      </div>
      <div class="sticky-win-actions">
        <div class="sticky-color-anchor">
          <button type="button" class="sticky-color-btn" data-sticky-action="toggle-color-popover" title="切换便签纸张颜色" aria-label="切换便签颜色"></button>
          <div class="sticky-color-popover hidden" role="menu" aria-label="选择便签颜色" hidden>
            ${swatchItemsHtml}
          </div>
        </div>
        <button type="button" class="sticky-icon-btn sticky-pin-btn" data-sticky-action="toggle-pin" title="固定位置（免受自动整理和误拖影响）" aria-label="固定便签位置">
          ${icon('pin', 13)}
        </button>
        <button type="button" class="sticky-icon-btn" data-sticky-action="minimize" title="最小化到底部工具条" aria-label="最小化便签">—</button>
        <button type="button" class="sticky-icon-btn sticky-close-btn" data-sticky-action="delete" title="关闭并删除便签" aria-label="删除便签">✕</button>
      </div>
    </header>
    <textarea class="sticky-textarea" placeholder="随手记下灵感、待办或引用，可拖入笔记…"></textarea>
    <footer class="sticky-footer">
      <span class="sticky-action-pill" data-sticky-action="drag-to-note" draggable="true" title="按住拖入中间 Markdown 笔记或右侧暂存栏">
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
  const pinBtn = card.querySelector('[data-sticky-action="toggle-pin"]');
  const stackBadge = card.querySelector('[data-sticky-action="toggle-stack"]');
  const minBtn = card.querySelector('[data-sticky-action="minimize"]');
  const closeBtn = card.querySelector('[data-sticky-action="delete"]');
  const todoBtn = card.querySelector('[data-sticky-action="ai-todo"]');

  card.addEventListener('pointerdown', () => {
    const sticky = getCardById(stickyId);
    if (!sticky) return;
    bringStickyForward(sticky);
    if (sticky.stackId && !sticky.stackExpanded) {
      layoutStack(sticky.stackId, sticky.x, sticky.y - (getStackGroups().get(sticky.stackId)?.indexOf(sticky) || 0) * STACK_CASCADE_STEP);
      saveStickies();
      renderStickies();
    } else {
      saveStickies();
    }
  });

  // Free dragging with setPointerCapture + body.is-dragging-sticky + region/stack detection
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

    const flushDrag = () => {
      rafId = 0;
      const sticky = getCardById(stickyId);
      if (!sticky) return;
      sticky.x = pendingX;
      sticky.y = pendingY;
      card.style.transform = `translate3d(${pendingX}px, ${pendingY}px, 0)`;

      clearStackTargetHighlights();
      activeOverlapTarget = findOverlapTarget(sticky, pendingX, pendingY, lastClientX, lastClientY);
      if (activeOverlapTarget) {
        activeEdge = null;
        const targetEl = layerEl?.querySelector(`.sticky-card[data-sticky-id="${CSS.escape(activeOverlapTarget.id)}"]`);
        targetEl?.classList.add('is-stack-target');
        showSnapPreview(
          { x: activeOverlapTarget.x, y: activeOverlapTarget.y, w: activeOverlapTarget.w, h: activeOverlapTarget.h },
          '松手合并堆叠'
        );
        return;
      }

      activeEdge = detectEdgeZone(sticky, pendingX, pendingY, lastClientX, lastClientY);
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
      clearStackTargetHighlights();
      hideSnapPreview();

      const sticky = getCardById(stickyId);
      if (sticky) {
        sticky.x = pendingX;
        sticky.y = pendingY;

        const isCancel = e?.type === 'pointercancel' || e?.type === 'blur';
        if (!isCancel && movedFar) {
          if (activeOverlapTarget) {
            const target = getCardById(activeOverlapTarget.id);
            if (target && !target.pinned) {
              const sid = target.stackId || `stack_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
              target.stackId = sid;
              target.stackExpanded = false;
              target.zone = 'free';
              sticky.stackId = sid;
              sticky.stackExpanded = false;
              sticky.zone = 'free';
              sticky.z = ++zCounter;
              cleanupOrphanStacks();
              layoutStack(sid, target.x, target.y);
            }
          } else if (activeEdge) {
            sticky.stackId = null;
            sticky.stackExpanded = false;
            sticky.zone = activeEdge.zone;
            cleanupOrphanStacks();
            arrangeZone(activeEdge.zone);
          } else {
            sticky.stackId = null;
            sticky.stackExpanded = false;
            sticky.zone = 'free';
            cleanupOrphanStacks();
          }
        } else if (origStackId && !movedFar) {
          sticky.stackId = origStackId;
        }
      }

      activeOverlapTarget = null;
      activeEdge = null;
      saveStickies();
      renderStickies();
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

      if (dist > 4) movedFar = true;
      pendingX = clampPosX(origX + dx, sticky.w);
      pendingY = clampPosY(origY + dy, sticky.h);

      if (sticky.stackId && dist > STACK_DETACH_DIST) {
        const oldSid = sticky.stackId;
        sticky.stackId = null;
        sticky.stackExpanded = false;
        origStackId = null;
        cleanupOrphanStacks();
        if (getStackGroups().has(oldSid)) {
          layoutStack(oldSid);
        }
      }

      if (!rafId) {
        rafId = window.requestAnimationFrame(flushDrag);
      }
    };

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, .sticky-color-popover')) return;
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

      card.classList.add('is-moving');
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

  // Smooth corner resizing with viewport clamping + setPointerCapture + body.is-dragging-sticky
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

    const flushSize = () => {
      rafId = 0;
      const sticky = getCardById(stickyId);
      if (!sticky) return;
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
        flushSize();
      }
      document.body.classList.remove('is-dragging-sticky');
      card.classList.remove('is-resizing');
      saveStickies();
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

  // Rounded-square color swatch button -> toggle 4-swatch popover
  colorBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!colorPopover) return;
    const willOpen = colorPopover.hidden || colorPopover.classList.contains('hidden');
    closeAllColorPopovers(card);
    setElementVisibility(colorPopover, willOpen);
  });

  // 4-swatch selection inside popover
  colorPopover?.addEventListener('click', (e) => {
    const swatch = e.target.closest('[data-sticky-color]');
    if (!swatch) return;
    e.preventDefault();
    e.stopPropagation();
    const nextColor = swatch.dataset.stickyColor;
    const sticky = getCardById(stickyId);
    if (!sticky || !STICKY_COLORS.includes(nextColor)) return;
    sticky.color = nextColor;
    setElementVisibility(colorPopover, false);
    saveStickies();
    renderStickies();
  });

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

  // Minimize card
  minBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sticky = getCardById(stickyId);
    if (!sticky) return;
    sticky.minimized = true;
    sticky.stackId = null;
    sticky.stackExpanded = false;
    cleanupOrphanStacks();
    saveStickies();
    renderStickies();
  });

  // Strict close / delete
  closeBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    stickies = stickies.filter((item) => item.id !== stickyId);
    cleanupOrphanStacks();
    saveStickies();
    renderStickies();
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

  // Drag-to-Note & Shelf (<span draggable="true">)
  if (dragPill) {
    dragPill.addEventListener('dragstart', (e) => {
      const sticky = getCardById(stickyId);
      const text = String(sticky?.content || '').trim();
      if (!text) {
        e.preventDefault();
        showToast('空便签无法拖入笔记，请先写点内容', 'warning');
        return;
      }
      const firstLine = text.split(/\r?\n/)[0].replace(/^#+\s*/, '').trim().slice(0, 24);
      writeDragPayload(e, {
        type: 'sticky',
        label: firstLine || '闪念卡',
        markdown: sticky.content,
      });
      store.emit('drag:active', true);
      card.classList.add('is-dragging');
    });

    dragPill.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
      resetDragPayload();
      store.emit('drag:active', false);
    });
  }
}

function updateCardElement(card, sticky, stackInfo) {
  const color = migrateColor(sticky.color);
  const w = clampWidth(sticky.w, sticky.x);
  const h = clampHeight(sticky.h, sticky.y);

  card.classList.remove('sticky-yellow', 'sticky-blue', 'sticky-green', 'sticky-pink');
  card.classList.add(`sticky-${color}`);
  card.classList.toggle('is-pinned', Boolean(sticky.pinned));
  card.classList.toggle('is-stacked', Boolean(stackInfo));
  card.classList.toggle('is-stack-expanded', Boolean(stackInfo?.expanded));

  card.style.width = `${w}px`;
  card.style.height = `${h}px`;
  card.style.transform = `translate3d(${sticky.x}px, ${sticky.y}px, 0)`;
  card.style.zIndex = String(computeZIndex(sticky));

  // Sync textarea ONLY when not actively focused so cursor/scrollTop stay untouched
  const textarea = card.querySelector('.sticky-textarea');
  if (textarea && document.activeElement !== textarea && textarea.value !== sticky.content) {
    textarea.value = sticky.content;
  }

  // Sync single rounded-square color swatch button
  const colorBtn = card.querySelector('.sticky-color-btn');
  if (colorBtn) {
    colorBtn.style.backgroundColor = STICKY_COLOR_SWATCHES[color];
    colorBtn.dataset.color = color;
    colorBtn.title = `当前颜色：${STICKY_COLOR_LABELS[color]}（点击切换）`;
  }
  card.querySelectorAll('.sticky-color-swatch').forEach((sw) => {
    sw.classList.toggle('is-active', sw.dataset.stickyColor === color);
  });

  // Sync Pin button state & tooltip
  const pinBtn = card.querySelector('.sticky-pin-btn');
  if (pinBtn) {
    pinBtn.classList.toggle('is-active', Boolean(sticky.pinned));
    pinBtn.setAttribute('aria-pressed', sticky.pinned ? 'true' : 'false');
    pinBtn.title = sticky.pinned
      ? '已固定位置（点击钉子取消固定）'
      : '固定位置（免受自动整理和误拖影响）';
  }

  // Sync Stack badge on top card of a stack
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
}

function renderDockToolbar(dock, minimizedCount) {
  const showDock = stickies.length >= 2 || minimizedCount > 0;
  if (!showDock) {
    setElementVisibility(dock, false);
    return;
  }

  const restoreHtml =
    minimizedCount > 0
      ? `<button type="button" class="sticky-dock-btn is-accent" data-dock-action="restore" title="恢复已最小化的便签">📌 恢复 (${minimizedCount})</button>`
      : `<span class="sticky-dock-count" title="当前便签数量">📌 闪念 (${stickies.length})</span>`;

  dock.innerHTML = `
    ${restoreHtml}
    <button type="button" class="sticky-dock-btn" data-dock-action="tile" title="将未固定便签在右侧整齐平铺">⊞ 整理</button>
    <button type="button" class="sticky-dock-btn" data-dock-action="stack-all" title="将未固定便签合并堆叠或展开">📚 堆叠</button>
    <button type="button" class="sticky-dock-btn is-plus" data-dock-action="new" title="新建闪念卡 (Alt+N)" aria-label="新建闪念卡">+</button>
  `;
  setElementVisibility(dock, true);
}

/**
 * Incremental DOM reconciliation for visible sticky cards & dock toolbar.
 */
function renderStickies() {
  const layer = ensureLayer();
  const dock = ensureDockPill();
  if (!layer || !dock) return;

  cleanupOrphanStacks();
  const stackGroups = getStackGroups();
  const visibleStickies = stickies.filter((s) => !s.minimized);
  const minimizedCount = stickies.length - visibleStickies.length;
  const visibleIds = new Set(visibleStickies.map((s) => s.id));

  // Remove cards that are no longer visible
  Array.from(layer.querySelectorAll('.sticky-card[data-sticky-id]')).forEach((el) => {
    if (!visibleIds.has(el.dataset.stickyId)) {
      el.remove();
    }
  });

  // Update existing cards in-place or create missing ones
  for (const sticky of visibleStickies) {
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
    updateCardElement(card, sticky, stackInfo);
  }

  renderDockToolbar(dock, minimizedCount);
}

/**
 * Spawn a new floating tinted-paper sticky note at (x, y) and persist in localStorage.
 * @param {{ x?: number, y?: number, text?: string, content?: string, color?: string, accent?: string, pinned?: boolean }} [opts={}]
 * @returns {object} created sticky object
 */
export function spawnStickyNote({ x, y, text, content, color, accent, pinned = false } = {}) {
  const { vw, vh } = getViewportSize();
  const offset = (stickies.length % 5) * 22;
  const w = DEFAULT_W;
  const h = DEFAULT_H;
  const targetX = clampPosX(Number.isFinite(Number(x)) ? Number(x) : Math.round(vw * 0.56 + offset), w);
  const targetY = clampPosY(Number.isFinite(Number(y)) ? Number(y) : Math.round(vh * 0.22 + offset), h);
  const pickedColor = color || accent
    ? migrateColor(color || accent)
    : STICKY_COLORS[stickies.length % STICKY_COLORS.length];

  zCounter += 1;
  const sticky = {
    id: `sticky_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    content: String(content ?? text ?? ''),
    x: targetX,
    y: targetY,
    w,
    h,
    color: pickedColor,
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
    spawnStickyNote({ x: spawnX, y: spawnY });
  } else if (action === 'insert-url') {
    openUrlCapsuleSheet();
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

function isSheetOpen() {
  const sheetOverlay = document.getElementById('sheet-overlay');
  return Boolean(
    sheetOverlay && !sheetOverlay.hidden && !sheetOverlay.classList.contains('hidden')
  );
}

/**
 * Initialize floating tinted-paper Stickies & scoped Center Context Menu.
 */
export function initStickies() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;

  stickies = loadStickies();
  ensureLayer();
  ensureDockPill();
  ensureSnapPreview();
  const menu = ensureContextMenu();
  renderStickies();

  menu?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ctx-action]');
    if (!btn) return;
    handleContextMenuAction(btn.dataset.ctxAction);
  });

  // Strictly scoped right-click context menu ONLY inside #center-panel
  document.addEventListener('contextmenu', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) {
      hideContextMenu();
      return;
    }

    if (!target.closest('#center-panel')) {
      hideContextMenu();
      return;
    }

    if (
      target.closest(
        '#left-panel, #right-panel, #top-bar, #mindmap-canvas, .mindmap-stage, .mindmap-node, .sticky-card, .spark-card, .anchor-pill, .media-embed-card, #capsule-context-menu, #drag-shelf'
      )
    ) {
      hideContextMenu();
      return;
    }

    // Preserve native copy/paste menu inside any editable element
    if (target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) {
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
    closeAllColorPopovers();
    document.body.classList.remove('is-dragging-sticky');
  });

  window.addEventListener('resize', () => {
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
}
