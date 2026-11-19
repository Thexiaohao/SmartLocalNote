/**
 * SmartLocalNote - Floating Frosted-Glass Stickies & Global Apple Context Menu (V3)
 * Pain Point #6 + Innovation E:
 *  - Right-click anywhere (except Mind Map canvas/nodes & selected text in inputs) -> Apple frosted context menu
 *  - Spawn floating stickies anywhere, drag freely, pick 4 soft Apple tints, minimize to bottom-left dock pill
 *  - Drag sticky directly into Center Markdown note via setDragPayload() or send to AI Todo extraction
 *  - Alt+N global shortcut + store.on('sticky:spawn')
 *
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
const STICKY_COLORS = ['yellow', 'blue', 'green', 'pink'];
const STICKY_COLOR_LABELS = {
  yellow: '奶油黄',
  blue: '晴空蓝',
  green: '薄荷绿',
  pink: '樱花粉',
};

let initialized = false;
let stickies = [];
let layerEl = null;
let dockEl = null;
let menuEl = null;
let zCounter = 55;

function loadStickies() {
  try {
    const raw = localStorage.getItem(STICKIES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item, idx) => ({
        id: String(item.id || `sticky_${Date.now()}_${idx}`),
        text: typeof item.text === 'string' ? item.text : '',
        x: clampPosX(Number(item.x) || 80 + (idx % 4) * 28),
        y: clampPosY(Number(item.y) || 90 + (idx % 4) * 24),
        color: STICKY_COLORS.includes(item.color) ? item.color : 'yellow',
        minimized: Boolean(item.minimized),
      }));
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

function clampPosX(x) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  return Math.max(12, Math.min(Math.max(12, vw - 276), Math.round(x)));
}

function clampPosY(y) {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  return Math.max(58, Math.min(Math.max(58, vh - 190), Math.round(y)));
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
      dockEl.title = '展开已最小化的灵感便签';
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
        let customTitle = String(titleInp?.value || '').trim();
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
            // fallback to hostname if endpoint unavailable or offline
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
      <span class="ctx-item-left"><span>📝</span><span>在此处召唤灵感便签</span></span>
      <kbd class="ctx-kbd">Alt+N</kbd>
    </button>
    <button type="button" class="context-menu-item" data-ctx-action="insert-url" role="menuitem">
      <span class="ctx-item-left"><span>🌐</span><span>插入网址直达胶囊</span></span>
    </button>
    <div class="context-menu-sep" role="separator"></div>
    <button type="button" class="context-menu-item" data-ctx-action="ai-summarize" role="menuitem">
      <span class="ctx-item-left"><span>✨</span><span>AI 总结当前文档</span></span>
    </button>
    <button type="button" class="context-menu-item" data-ctx-action="toggle-mindmap" role="menuitem">
      <span class="ctx-item-left"><span>🧠</span><span>切换脑图视图</span></span>
    </button>
    <button type="button" class="context-menu-item" data-ctx-action="semantic-search" role="menuitem">
      <span class="ctx-item-left"><span>🔍</span><span>语义描述检索</span></span>
      <kbd class="ctx-kbd">⌘K</kbd>
    </button>
  `;

  menu.dataset.spawnX = String(clientX);
  menu.dataset.spawnY = String(clientY);
  menu.classList.remove('hidden');
  menu.setAttribute('aria-hidden', 'false');

  // Measure then clamp strictly inside viewport
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
  const header = card.querySelector('.sticky-header');
  const textarea = card.querySelector('.sticky-textarea');
  const dragPill = card.querySelector('[data-sticky-action="drag-to-note"]');

  // Bring card forward on interaction
  card.addEventListener('pointerdown', () => {
    zCounter += 1;
    card.style.zIndex = String(zCounter);
  });

  // Free screen-space dragging via header pointer events
  if (header) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origX = sticky.x;
    let origY = sticky.y;

    const stopDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      card.classList.remove('is-moving');
      if (e?.pointerId != null) {
        try {
          header.releasePointerCapture?.(e.pointerId);
        } catch {
          // ignore
        }
      }
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
      card.classList.add('is-moving');
      try {
        header.setPointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
    });

    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const nextX = clampPosX(origX + (e.clientX - startX));
      const nextY = clampPosY(origY + (e.clientY - startY));
      sticky.x = nextX;
      sticky.y = nextY;
      card.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;
    });

    header.addEventListener('pointerup', stopDrag);
    header.addEventListener('pointercancel', stopDrag);
  }

  // Persist text edits live
  textarea?.addEventListener('input', () => {
    sticky.text = textarea.value;
    saveStickies();
  });

  // Color dot switching
  card.querySelectorAll('[data-sticky-color]').forEach((dot) => {
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextColor = dot.dataset.stickyColor;
      if (!STICKY_COLORS.includes(nextColor)) return;
      sticky.color = nextColor;
      saveStickies();
      renderStickies();
    });
  });

  // Minimize toggle
  card.querySelector('[data-sticky-action="minimize"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    sticky.minimized = true;
    saveStickies();
    renderStickies();
  });

  // Delete sticky
  card.querySelector('[data-sticky-action="delete"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    stickies = stickies.filter((item) => item.id !== sticky.id);
    saveStickies();
    renderStickies();
  });

  // AI Todo extraction
  card.querySelector('[data-sticky-action="ai-todo"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = String(sticky.text || '').trim();
    if (!text) {
      showToast('请先在便签中输入想法或待办内容', 'warning');
      textarea?.focus();
      return;
    }
    store.emit('ai:summarize-request', { text, autoRun: true });
    showToast('已发送便签内容至 AI 提取待办', 'info', { duration: 2000 });
  });

  // Drag sticky directly into Center Note
  if (dragPill) {
    dragPill.addEventListener('dragstart', (e) => {
      const text = String(sticky.text || '').trim();
      if (!text) {
        e.preventDefault();
        showToast('空便签无法拖入笔记，请先写点内容', 'warning');
        return;
      }
      setDragPayload(e, {
        type: 'sticky',
        label: '灵感便签',
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
    document.activeElement?.closest?.('.sticky-card')?.dataset?.stickyId || null;

  layer.innerHTML = '';

  const visibleStickies = stickies.filter((s) => !s.minimized);
  const minimizedCount = stickies.filter((s) => s.minimized).length;

  for (const sticky of visibleStickies) {
    const card = document.createElement('section');
    card.className = `sticky-card sticky-${sticky.color}`;
    card.dataset.stickyId = sticky.id;
    card.style.transform = `translate3d(${sticky.x}px, ${sticky.y}px, 0)`;
    card.style.zIndex = String(++zCounter);
    card.setAttribute('aria-label', '浮动灵感便签');

    const colorDotsHtml = STICKY_COLORS.map(
      (c) => `
        <button
          type="button"
          class="sticky-color-dot dot-${c} ${sticky.color === c ? 'is-active' : ''}"
          data-sticky-color="${c}"
          title="${STICKY_COLOR_LABELS[c]}"
          aria-label="切换为${STICKY_COLOR_LABELS[c]}"
        ></button>
      `
    ).join('');

    card.innerHTML = `
      <header class="sticky-header" title="按住拖动便签位置">
        <div class="sticky-colors">${colorDotsHtml}</div>
        <div class="sticky-win-actions">
          <button type="button" class="sticky-icon-btn" data-sticky-action="minimize" title="最小化到左下角" aria-label="最小化便签">—</button>
          <button type="button" class="sticky-icon-btn" data-sticky-action="delete" title="关闭删除便签" aria-label="删除便签">✕</button>
        </div>
      </header>
      <textarea class="sticky-textarea" placeholder="随手记下灵感、待办或引用，可拖入笔记…">${escapeHtml(sticky.text)}</textarea>
      <footer class="sticky-footer">
        <button type="button" class="sticky-action-pill" data-sticky-action="drag-to-note" draggable="true" title="按住拖入中间 Markdown 笔记">
          ⠿ 拖入笔记
        </button>
        <button type="button" class="sticky-action-pill" data-sticky-action="ai-todo" title="让 AI 提炼为结构化待办">
          ✨ AI 待办
        </button>
      </footer>
    `;

    bindCardInteractions(card, sticky);
    layer.appendChild(card);

    if (activeFocusId && activeFocusId === sticky.id) {
      const ta = card.querySelector('.sticky-textarea');
      ta?.focus();
    }
  }

  if (minimizedCount > 0) {
    dock.classList.remove('hidden');
    dock.innerHTML = `📌 便签 (${minimizedCount})`;
  } else {
    dock.classList.add('hidden');
  }
}

/**
 * Spawn a new floating frosted-glass sticky note at (x, y) and persist in localStorage.
 * @param {{ x?: number, y?: number, text?: string, color?: 'yellow'|'blue'|'green'|'pink' }} [opts={}]
 * @returns {object} created sticky object
 */
export function spawnStickyNote({ x, y, text = '', color } = {}) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const offset = (stickies.length % 5) * 22;
  const targetX = clampPosX(Number.isFinite(Number(x)) ? Number(x) : Math.round(vw * 0.56 + offset));
  const targetY = clampPosY(Number.isFinite(Number(y)) ? Number(y) : Math.round(vh * 0.22 + offset));
  const pickedColor = STICKY_COLORS.includes(color)
    ? color
    : STICKY_COLORS[stickies.length % STICKY_COLORS.length];

  const sticky = {
    id: `sticky_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    text: String(text || ''),
    x: targetX,
    y: targetY,
    color: pickedColor,
    minimized: false,
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
  } else if (action === 'ai-summarize') {
    store.emit('ai:summarize-request', {
      text: store.state.activeDocumentText || '',
      file_path: store.state.activeFile?.path || null,
      autoRun: true,
    });
  } else if (action === 'toggle-mindmap') {
    store.emit('center:toggle-mindmap');
  } else if (action === 'semantic-search') {
    store.emit('spotlight:open', { mode: 'semantic' });
  }
}

/**
 * Initialize floating stickies & global Apple frosted right-click context menu.
 */
export function initStickies() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;

  stickies = loadStickies();
  ensureLayer();
  ensureDockPill();
  const menu = ensureContextMenu();
  renderStickies();

  // Context menu action delegation
  menu?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ctx-action]');
    if (!btn) return;
    handleContextMenuAction(btn.dataset.ctxAction);
  });

  // Global right-click listener
  document.addEventListener('contextmenu', (e) => {
    // Allow Mind Map canvas & nodes to handle their own Innovation D context menu
    if (e.target.closest('#mindmap-canvas, .mindmap-stage, .mindmap-node')) {
      hideContextMenu();
      return;
    }

    // Keep native copy/paste menu inside inputs/textareas when text is selected
    const inputEl = e.target.closest('input, textarea');
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

  // Dismiss context menu on outside click, scroll, or ESC
  document.addEventListener('pointerdown', (e) => {
    if (menuEl && !menuEl.classList.contains('hidden') && !e.target.closest('#context-menu')) {
      hideContextMenu();
    }
  });

  window.addEventListener('blur', hideContextMenu);

  // Global Alt+N shortcut to spawn a sticky note immediately
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

  // EventBus listener for sticky spawning
  store.on('sticky:spawn', (opts) => {
    spawnStickyNote(opts || {});
  });
}
