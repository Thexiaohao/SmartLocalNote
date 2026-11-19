/**
 * SmartLocalNote - Original Spark Card (闪念卡) & Scoped Center Context Menu (V4)
 *  - Original neutral frosted Spark Card with subtle 3px left accent strip (NO macOS Stickies look)
 *  - Zero-lag 60fps dragging via window pointermove + requestAnimationFrame + translate3d
 *  - Bottom-right resize handle (w: 220..520, h: 160..460), persisted in localStorage
 *  - Clean header with drag grip, title, minimize [—], and strict close [✕] (zero color mutation)
 *  - Clean footer with compact tag/accent cycler pill, [⠿ 拖入笔记], and [✨ 待办]
 *  - Right-click context menu STRICTLY scoped to #center-panel (never triggers on left/right/top/mindmap/spark-card)
 *
 * Exports: initStickies, spawnStickyNote (preserved for compatibility).
 * Communicates strictly via store EventBus.
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
const SPARK_ACCENTS = ['blue', 'amber', 'green', 'slate'];
const SPARK_TAG_META = {
  blue: { label: '闪念', badge: '🏷 闪念' },
  amber: { label: '重点', badge: '🏷 重点' },
  green: { label: '待办', badge: '🏷 待办' },
  slate: { label: '灵感', badge: '🏷 灵感' },
};

const DEFAULT_W = 280;
const DEFAULT_H = 210;
const MIN_W = 220;
const MAX_W = 520;
const MIN_H = 160;
const MAX_H = 460;

let initialized = false;
let stickies = [];
let layerEl = null;
let dockEl = null;
let menuEl = null;
let zCounter = 55;

function migrateAccent(raw) {
  if (SPARK_ACCENTS.includes(raw)) return raw;
  if (raw === 'yellow') return 'amber';
  if (raw === 'pink') return 'slate';
  return 'blue';
}

function clampWidth(w) {
  const num = Number(w);
  if (!Number.isFinite(num)) return DEFAULT_W;
  return Math.max(MIN_W, Math.min(MAX_W, Math.round(num)));
}

function clampHeight(h) {
  const num = Number(h);
  if (!Number.isFinite(num)) return DEFAULT_H;
  return Math.max(MIN_H, Math.min(MAX_H, Math.round(num)));
}

function clampPosX(x, w = DEFAULT_W) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const maxLeft = Math.max(12, vw - Math.min(w, vw - 24) - 12);
  return Math.max(12, Math.min(maxLeft, Math.round(x)));
}

function clampPosY(y, h = DEFAULT_H) {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const maxTop = Math.max(58, vh - Math.min(h, vh - 70) - 12);
  return Math.max(58, Math.min(maxTop, Math.round(y)));
}

function loadStickies() {
  try {
    const raw = localStorage.getItem(STICKIES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item, idx) => {
        const w = clampWidth(item.w);
        const h = clampHeight(item.h);
        const accent = migrateAccent(item.accent || item.color);
        return {
          id: String(item.id || `spark_${Date.now()}_${idx}`),
          text: typeof item.text === 'string' ? item.text : '',
          x: clampPosX(Number(item.x) || 80 + (idx % 4) * 28, w),
          y: clampPosY(Number(item.y) || 90 + (idx % 4) * 24, h),
          w,
          h,
          accent,
          minimized: Boolean(item.minimized),
        };
      });
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

function ensureDockPill() {
  if (typeof document === 'undefined') return null;
  if (!dockEl || !document.body.contains(dockEl)) {
    dockEl = document.getElementById('sticky-dock-pill');
    if (!dockEl) {
      dockEl = document.createElement('button');
      dockEl.id = 'sticky-dock-pill';
      dockEl.type = 'button';
      dockEl.className = 'sticky-dock-pill hidden';
      dockEl.title = '展开已最小化的闪念卡';
      dockEl.addEventListener('click', () => {
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
      });
      document.body.appendChild(dockEl);
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
      menuEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(menuEl);
    }
  }
  return menuEl;
}

function hideContextMenu() {
  if (!menuEl) return;
  menuEl.classList.add('hidden');
  menuEl.classList.remove('is-open');
  menuEl.setAttribute('aria-hidden', 'true');
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
  menu.classList.remove('hidden');
  menu.setAttribute('aria-hidden', 'false');

  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(8, Math.min(clientX, vw - rect.width - 8));
  const top = Math.max(8, Math.min(clientY, vh - rect.height - 8));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  window.requestAnimationFrame(() => {
    menu.classList.add('is-open');
  });
}

function bindCardInteractions(card, sticky) {
  const header = card.querySelector('.spark-header');
  const textarea = card.querySelector('.spark-textarea');
  const dragPill = card.querySelector('[data-spark-action="drag-to-note"]');
  const resizeHandle = card.querySelector('.spark-resize-handle');
  const tagBtn = card.querySelector('[data-spark-action="cycle-tag"]');
  const minBtn = card.querySelector('[data-spark-action="minimize"]');
  const closeBtn = card.querySelector('[data-spark-action="delete"]');
  const todoBtn = card.querySelector('[data-spark-action="ai-todo"]');

  card.addEventListener('pointerdown', () => {
    zCounter += 1;
    card.style.zIndex = String(zCounter);
  });

  // Zero-lag 60fps dragging via window listeners + requestAnimationFrame
  if (header) {
    let dragging = false;
    let rafId = 0;
    let startX = 0;
    let startY = 0;
    let origX = sticky.x;
    let origY = sticky.y;
    let pendingX = sticky.x;
    let pendingY = sticky.y;

    const flushPosition = () => {
      rafId = 0;
      sticky.x = pendingX;
      sticky.y = pendingY;
      card.style.transform = `translate3d(${pendingX}px, ${pendingY}px, 0)`;
    };

    const onMove = (e) => {
      if (!dragging) return;
      pendingX = clampPosX(origX + (e.clientX - startX), sticky.w);
      pendingY = clampPosY(origY + (e.clientY - startY), sticky.h);
      if (!rafId) {
        rafId = window.requestAnimationFrame(flushPosition);
      }
    };

    const stopDrag = () => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        flushPosition();
      }
      card.classList.remove('is-moving');
      saveStickies();
    };

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origX = sticky.x;
      origY = sticky.y;
      pendingX = sticky.x;
      pendingY = sticky.y;
      card.classList.add('is-moving');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stopDrag);
      window.addEventListener('pointercancel', stopDrag);
    });
  }

  // Smooth corner resizing via window pointer events + rAF
  if (resizeHandle) {
    let resizing = false;
    let rafId = 0;
    let startX = 0;
    let startY = 0;
    let origW = sticky.w;
    let origH = sticky.h;
    let pendingW = sticky.w;
    let pendingH = sticky.h;

    const flushSize = () => {
      rafId = 0;
      sticky.w = pendingW;
      sticky.h = pendingH;
      card.style.width = `${pendingW}px`;
      card.style.height = `${pendingH}px`;
    };

    const onResizeMove = (e) => {
      if (!resizing) return;
      pendingW = clampWidth(origW + (e.clientX - startX));
      pendingH = clampHeight(origH + (e.clientY - startY));
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
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        flushSize();
      }
      card.classList.remove('is-resizing');
      saveStickies();
    };

    resizeHandle.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      origW = sticky.w;
      origH = sticky.h;
      pendingW = sticky.w;
      pendingH = sticky.h;
      card.classList.add('is-resizing');
      window.addEventListener('pointermove', onResizeMove);
      window.addEventListener('pointerup', stopResize);
      window.addEventListener('pointercancel', stopResize);
    });
  }

  // Persist text edits live
  textarea?.addEventListener('input', () => {
    sticky.text = textarea.value;
    saveStickies();
  });

  // Footer tag / accent cycler (explicitly separate from close button)
  tagBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const curIdx = SPARK_ACCENTS.indexOf(sticky.accent);
    const nextAccent = SPARK_ACCENTS[(curIdx + 1) % SPARK_ACCENTS.length];
    sticky.accent = nextAccent;
    card.classList.remove('accent-blue', 'accent-amber', 'accent-green', 'accent-slate');
    card.classList.add(`accent-${nextAccent}`);
    tagBtn.textContent = SPARK_TAG_META[nextAccent].badge;
    saveStickies();
  });

  // Minimize card to dock pill
  minBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sticky.minimized = true;
    saveStickies();
    renderStickies();
  });

  // Strict close: stop propagation and delete ONLY this card (zero color mutation)
  closeBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    stickies = stickies.filter((item) => item.id !== sticky.id);
    saveStickies();
    renderStickies();
  });

  // Send card text to AI Todo extraction
  todoBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = String(sticky.text || '').trim();
    if (!text) {
      showToast('请先在闪念卡中输入想法或待办内容', 'warning');
      textarea?.focus();
      return;
    }
    store.emit('ai:summarize-request', { text, autoRun: true });
    showToast('已发送闪念内容至 AI 提取待办', 'info', { duration: 2000 });
  });

  // Drag card content directly into Center Note
  if (dragPill) {
    dragPill.addEventListener('dragstart', (e) => {
      const text = String(sticky.text || '').trim();
      if (!text) {
        e.preventDefault();
        showToast('空闪念卡无法拖入笔记，请先写点内容', 'warning');
        return;
      }
      setDragPayload(e, {
        type: 'sticky',
        label: '闪念卡',
        markdown: text,
      });
      card.classList.add('is-dragging');
    });

    dragPill.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
      clearDragPayload();
    });
  }
}

function renderStickies() {
  const layer = ensureLayer();
  const dock = ensureDockPill();
  if (!layer || !dock) return;

  const activeFocusId =
    document.activeElement?.closest?.('.spark-card')?.dataset?.stickyId || null;

  layer.innerHTML = '';

  const visibleStickies = stickies.filter((s) => !s.minimized);
  const minimizedCount = stickies.filter((s) => s.minimized).length;

  for (const sticky of visibleStickies) {
    const accent = migrateAccent(sticky.accent);
    const meta = SPARK_TAG_META[accent] || SPARK_TAG_META.blue;

    const card = document.createElement('section');
    card.className = `spark-card accent-${accent}`;
    card.dataset.stickyId = sticky.id;
    card.style.width = `${clampWidth(sticky.w)}px`;
    card.style.height = `${clampHeight(sticky.h)}px`;
    card.style.transform = `translate3d(${sticky.x}px, ${sticky.y}px, 0)`;
    card.style.zIndex = String(++zCounter);
    card.setAttribute('aria-label', '闪念卡');

    card.innerHTML = `
      <header class="spark-header" title="按住拖动闪念卡位置">
        <div class="spark-title-group">
          <span class="spark-grip" aria-hidden="true">⋮⋮</span>
          <span class="spark-title">闪念卡</span>
        </div>
        <div class="spark-win-actions">
          <button type="button" class="spark-icon-btn" data-spark-action="minimize" title="最小化到左下角" aria-label="最小化闪念卡">—</button>
          <button type="button" class="spark-icon-btn spark-close-btn" data-spark-action="delete" title="关闭并移除" aria-label="关闭闪念卡">✕</button>
        </div>
      </header>
      <textarea class="spark-textarea" placeholder="随手记下闪念、要点或待办，可拖入笔记…">${escapeHtml(sticky.text)}</textarea>
      <footer class="spark-footer">
        <button type="button" class="spark-tag-pill" data-spark-action="cycle-tag" title="点击切换标签属性">${escapeHtml(meta.badge)}</button>
        <div class="spark-footer-actions">
          <button type="button" class="spark-action-pill" data-spark-action="drag-to-note" draggable="true" title="按住拖入中间 Markdown 笔记">⠿ 拖入笔记</button>
          <button type="button" class="spark-action-pill" data-spark-action="ai-todo" title="让 AI 提炼为结构化待办">✨ 待办</button>
        </div>
      </footer>
      <span class="spark-resize-handle" title="按住拖动调节卡片大小" aria-hidden="true"></span>
    `;

    bindCardInteractions(card, sticky);
    layer.appendChild(card);

    if (activeFocusId && activeFocusId === sticky.id) {
      const ta = card.querySelector('.spark-textarea');
      ta?.focus();
    }
  }

  if (minimizedCount > 0) {
    dock.classList.remove('hidden');
    dock.innerHTML = `📌 闪念卡 (${minimizedCount})`;
  } else {
    dock.classList.add('hidden');
  }
}

/**
 * Spawn a new floating Spark Card at (x, y) and persist in localStorage.
 * @param {{ x?: number, y?: number, text?: string, accent?: 'blue'|'amber'|'green'|'slate', color?: string }} [opts={}]
 * @returns {object} created spark card object
 */
export function spawnStickyNote({ x, y, text = '', accent, color } = {}) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const offset = (stickies.length % 5) * 22;
  const w = DEFAULT_W;
  const h = DEFAULT_H;
  const targetX = clampPosX(Number.isFinite(Number(x)) ? Number(x) : Math.round(vw * 0.56 + offset), w);
  const targetY = clampPosY(Number.isFinite(Number(y)) ? Number(y) : Math.round(vh * 0.22 + offset), h);
  const pickedAccent = accent || color
    ? migrateAccent(accent || color)
    : SPARK_ACCENTS[stickies.length % SPARK_ACCENTS.length];

  const sticky = {
    id: `spark_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    text: String(text || ''),
    x: targetX,
    y: targetY,
    w,
    h,
    accent: pickedAccent,
    minimized: false,
  };

  stickies.push(sticky);
  saveStickies();
  renderStickies();

  window.requestAnimationFrame(() => {
    const ta = layerEl?.querySelector(`.spark-card[data-sticky-id="${CSS.escape(sticky.id)}"] .spark-textarea`);
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
    store.emit('center:polish-doc');
  } else if (action === 'toggle-mindmap') {
    store.emit('center:toggle-mindmap');
  } else if (action === 'semantic-search') {
    store.emit('spotlight:open', { mode: 'semantic' });
  }
}

/**
 * Initialize floating Spark Cards & center-panel-scoped Apple frosted right-click context menu.
 */
export function initStickies() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;

  stickies = loadStickies();
  ensureLayer();
  ensureDockPill();
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

    // Must be inside #center-panel and NOT in left/right/top/mindmap/spark-card
    if (!target.closest('#center-panel')) {
      hideContextMenu();
      return;
    }
    if (target.closest('#left-panel, #right-panel, #top-bar, #mindmap-canvas, .mindmap-stage, .mindmap-node, .spark-card')) {
      hideContextMenu();
      return;
    }

    // Keep native copy/paste menu inside inputs/textareas when text is selected
    const inputEl = target.closest('input, textarea');
    if (inputEl) {
      const selLen = Math.abs((inputEl.selectionEnd || 0) - (inputEl.selectionStart || 0));
      if (selLen > 0) {
        hideContextMenu();
        return;
      }
    }

    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
  });

  document.addEventListener('pointerdown', (e) => {
    if (menuEl && !menuEl.classList.contains('hidden') && !e.target.closest('#context-menu')) {
      hideContextMenu();
    }
  });

  window.addEventListener('blur', hideContextMenu);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      hideContextMenu();
      spawnStickyNote();
    }
  });

  store.on('sticky:spawn', (opts) => {
    spawnStickyNote(opts || {});
  });
}
