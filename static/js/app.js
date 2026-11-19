/**
 * SmartLocalNote - Application Bootstrap
 * Loads saved theme & /api/system/info, mounts Left/Center/Right/Spotlight modules,
 * binds top bar & responsive mobile/tablet controls, and sets initial Dynamic Island state.
 */

import * as storeMod from './store.js';
import {
  store,
  applyTheme,
  applyDocTypography,
  applyPaneWidths,
  recordRecentFile,
  clearDragPayload,
  setIsland,
  showToast,
  openSheet,
  closeSheet,
} from './store.js';
import { api, connectEventStream } from './api_client.js';
import { icon } from './icons.js';
import { initLeftTree } from './left_tree.js';
import { initCenterView } from './center_view.js';
import { initRightPanel } from './right_panel.js';
import { initSpotlight } from './spotlight.js';
import { initStickies } from './stickies.js';
import { initDragShelf } from './drag_shelf.js';

function syncLayoutClasses() {
  const shell = document.getElementById('app-shell') || document.body;
  const leftCollapsed = Boolean(store.state.leftCollapsed);
  const rightCollapsed = Boolean(store.state.rightCollapsed);
  const drawerOpen = Boolean(store.state.tabletDrawerOpen);
  const zenMode = Boolean(store.state.zenMode);
  const tab = store.state.mobileTab || 'doc';

  shell.dataset.leftCollapsed = String(leftCollapsed);
  shell.dataset.rightCollapsed = String(rightCollapsed);
  shell.dataset.drawerOpen = String(drawerOpen);
  shell.dataset.zenMode = String(zenMode);
  shell.dataset.mobileTab = tab;
  shell.classList.toggle('is-zen-mode', zenMode);
  document.body?.classList.toggle('is-zen-mode', zenMode);

  // Sync mobile bottom nav pill active state
  document.querySelectorAll('#mobile-nav .mobile-nav-item[data-tab]').forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function updateThemeButtonIcon() {
  const btn = document.getElementById('btn-theme');
  if (!btn) return;
  const isDark = store.state.theme === 'dark';
  btn.innerHTML = icon(isDark ? 'sun' : 'moon', 16);
  btn.title = isDark ? '切换浅色外观' : '切换深色外观';
}

function bindTopBarControls() {
  const btnLeft = document.getElementById('btn-toggle-left');
  const btnTabletDrawer = document.getElementById('btn-tablet-drawer');
  const btnRight = document.getElementById('btn-toggle-right');
  const btnTheme = document.getElementById('btn-theme');
  const drawerBackdrop = document.getElementById('drawer-backdrop');

  btnLeft?.addEventListener('click', () => {
    store.setState({ leftCollapsed: !store.state.leftCollapsed });
    syncLayoutClasses();
  });

  btnTabletDrawer?.addEventListener('click', () => {
    store.setState({ tabletDrawerOpen: !store.state.tabletDrawerOpen });
    syncLayoutClasses();
  });

  btnRight?.addEventListener('click', () => {
    store.setState({ rightCollapsed: !store.state.rightCollapsed });
    syncLayoutClasses();
  });

  drawerBackdrop?.addEventListener('click', () => {
    store.setState({ tabletDrawerOpen: false });
    syncLayoutClasses();
  });

  btnTheme?.addEventListener('click', () => {
    const next = store.state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    updateThemeButtonIcon();
  });

  const applyFullShellLayout = () => {
    if (store.state.theme) {
      applyTheme(store.state.theme);
    }
    applyDocTypography(store.state.docFontSize, store.state.docFontFamily);
    const widths = store.state.paneWidths || { left: 260, right: 360 };
    applyPaneWidths(widths.left ?? 260, widths.right ?? 360);
    updateThemeButtonIcon();
    syncLayoutClasses();
  };

  store.on('theme:changed', updateThemeButtonIcon);
  store.on('layout:changed', syncLayoutClasses);
  store.on('zen:changed', syncLayoutClasses);
  store.on('layout:applied', applyFullShellLayout);
  store.on('ui:layout-changed', () => {
    const widths = store.state.paneWidths || { left: 260, right: 360 };
    applyPaneWidths(widths.left ?? 260, widths.right ?? 360);
  });
  store.on('layout:persist-backend', async () => {
    try {
      const uiLayout = typeof storeMod.exportLayoutMemoryForConfig === 'function'
        ? storeMod.exportLayoutMemoryForConfig()
        : store.state.uiLayout;
      if (uiLayout && typeof uiLayout === 'object') {
        await api.put('/api/system/config', { ui_layout: uiLayout });
      }
    } catch {
      // ignore background persistence errors
    }
  });
  store.on('file:opened', (fileInfo) => {
    if (fileInfo) {
      recordRecentFile(fileInfo);
    }
    if (window.innerWidth <= 767) {
      store.setState({ mobileTab: 'doc' });
      syncLayoutClasses();
    } else if (store.state.tabletDrawerOpen) {
      store.setState({ tabletDrawerOpen: false });
      syncLayoutClasses();
    }
  });
}

function openQuickNewNoteSheet() {
  openSheet({
    title: '新建本地笔记 (Ctrl+N)',
    bodyHtml: `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label for="global-new-note-title" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">笔记标题</label>
          <input id="global-new-note-title" type="text" class="apple-input" placeholder="例如：高数第三章错题复盘" autocomplete="off" />
        </div>
        <div>
          <label for="global-new-note-content" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">初始正文（可选，支持 Markdown 与 [[锚点]]）</label>
          <textarea id="global-new-note-content" class="apple-textarea" rows="4" placeholder="# 笔记标题&#10;&#10;- 记录想法或参考 [[讲义.pdf#page=1]]"></textarea>
        </div>
      </div>
    `,
    footerHtml: `
      <button type="button" class="pill-btn pill-btn-ghost" id="global-note-cancel">取消</button>
      <button type="button" class="pill-btn pill-btn-primary" id="global-note-submit">${icon('check', 14)} 创建并打开</button>
    `,
    onMount(card) {
      const titleInput = card.querySelector('#global-new-note-title');
      const contentInput = card.querySelector('#global-new-note-content');
      const submitBtn = card.querySelector('#global-note-submit');

      window.requestAnimationFrame(() => titleInput?.focus());
      card.querySelector('#global-note-cancel')?.addEventListener('click', closeSheet);

      const doCreate = async () => {
        const title = titleInput?.value?.trim();
        if (!title) {
          showToast('请输入笔记标题', 'warning');
          titleInput?.focus();
          return;
        }
        const content = contentInput?.value ?? '';
        if (submitBtn) submitBtn.disabled = true;
        try {
          const created = await api.post('/api/files/create-note', { title, content });
          closeSheet();
          store.emit('files:updated', created);
          if (created?.path) {
            store.emit('file:open', created);
          }
          showToast(`已创建笔记：${created?.name || `${title}.md`}`, 'success');
        } catch (err) {
          showToast(`创建笔记失败：${err?.message || '未知错误'}`, 'error');
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      };

      submitBtn?.addEventListener('click', doCreate);
      titleInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          doCreate();
        }
      });
    },
  });
}

function bindGlobalShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+\ or Cmd+\ -> Toggle Zen Mode (Innovation D)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === '\\' || e.code === 'Backslash')) {
      e.preventDefault();
      if (typeof storeMod.toggleZenMode === 'function') {
        storeMod.toggleZenMode();
      } else {
        const next = !Boolean(store.state.zenMode);
        store.setState({ zenMode: next }, 'zen:changed');
      }
      return;
    }

    // Alt+ArrowLeft / Alt+ArrowRight -> History Back / Forward (Req #4)
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        store.emit('nav:go', -1);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        store.emit('nav:go', 1);
        return;
      }
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
      const activeEl = document.activeElement;
      const sheetOverlay = document.getElementById('sheet-overlay');
      const sheetOpen = Boolean(sheetOverlay && !sheetOverlay.hidden && !sheetOverlay.classList.contains('hidden'));
      const inModalInput = Boolean(
        sheetOpen && activeEl && sheetOverlay.contains(activeEl) && activeEl.matches('input, textarea, select')
      );
      if (inModalInput) return;
      e.preventDefault();
      if (window.innerWidth >= 1024 && !store.state.leftCollapsed && !store.state.zenMode) {
        store.emit('left:inline-new-note');
      } else {
        openQuickNewNoteSheet();
      }
    }
  });

  // Mouse side buttons (Back / Forward) -> History navigation (Req #4)
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) {
      e.preventDefault();
      store.emit('nav:go', -1);
    } else if (e.button === 4) {
      e.preventDefault();
      store.emit('nav:go', 1);
    }
  });
}

function bindPaneResizers() {
  const attachResizer = (el, side) => {
    if (!el) return;
    let dragging = false;
    let startX = 0;
    let startW = 0;

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('is-dragging');
      document.body.classList.toggle('is-resizing', false);
      if (e?.pointerId != null) {
        try {
          el.releasePointerCapture?.(e.pointerId);
        } catch {
          // ignore
        }
      }
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      const cur = store.state.paneWidths || { left: 260, right: 360 };
      startW = side === 'left' ? cur.left : cur.right;
      el.classList.add('is-dragging');
      document.body.classList.toggle('is-resizing', true);
      try {
        el.setPointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const cur = store.state.paneWidths || { left: 260, right: 360 };
      if (side === 'left') {
        applyPaneWidths(startW + dx, cur.right);
      } else {
        applyPaneWidths(cur.left, startW - dx);
      }
    });

    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

    el.addEventListener('dblclick', () => {
      const cur = store.state.paneWidths || { left: 260, right: 360 };
      if (side === 'left') {
        applyPaneWidths(260, cur.right);
      } else {
        applyPaneWidths(cur.left, 360);
      }
    });
  };

  attachResizer(document.getElementById('resizer-left'), 'left');
  attachResizer(document.getElementById('resizer-right'), 'right');
}

function bindMobileControls() {
  document.querySelectorAll('#mobile-nav .mobile-nav-item[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextTab = btn.dataset.tab || 'doc';
      store.setState({ mobileTab: nextTab, tabletDrawerOpen: false });
      syncLayoutClasses();
    });
  });

  const btnQuickAdd = document.getElementById('btn-mobile-quick-add');
  btnQuickAdd?.addEventListener('click', () => {
    openSheet({
      title: '随时速记 / 剪贴板汇入',
      bodyHtml: `
        <div class="sheet-form" style="display:flex;flex-direction:column;gap:10px;">
          <label class="field-label" style="font-size:12.5px;color:var(--text-secondary);">输入或粘贴学习笔记 / 待办想法</label>
          <textarea class="apple-textarea" id="mobile-quick-text" rows="4" placeholder="例如：今晚8点复习高数第三章，记得打开 WPS 查看讲义..."></textarea>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" class="pill-btn pill-btn-ghost pill-btn-sm" id="mobile-paste-btn">
              ${icon('clipboard', 14)} 读取剪贴板
            </button>
            <button type="button" class="pill-btn pill-btn-ghost pill-btn-sm" id="mobile-voice-btn">
              ${icon('mic', 14)} 语音速记
            </button>
          </div>
        </div>
      `,
      footerHtml: `
        <button type="button" class="pill-btn pill-btn-ghost" id="mobile-quick-cancel">取消</button>
        <button type="button" class="pill-btn" id="mobile-quick-ai">${icon('sparkles', 14)} AI 提取待办</button>
        <button type="button" class="pill-btn pill-btn-primary" id="mobile-quick-save">存为笔记</button>
      `,
      onMount(card) {
        const ta = card.querySelector('#mobile-quick-text');
        card.querySelector('#mobile-quick-cancel')?.addEventListener('click', closeSheet);
        card.querySelector('#mobile-paste-btn')?.addEventListener('click', async () => {
          try {
            const clip = await navigator.clipboard.readText();
            if (ta && clip) ta.value = clip;
          } catch {
            showToast('浏览器未授权剪贴板读取，请长按粘贴', 'warning');
          }
        });
        card.querySelector('#mobile-voice-btn')?.addEventListener('click', () => {
          closeSheet();
          store.emit('voice:open');
        });
        card.querySelector('#mobile-quick-ai')?.addEventListener('click', () => {
          const text = ta?.value?.trim();
          if (!text) {
            showToast('请先输入内容', 'warning');
            return;
          }
          closeSheet();
          store.setState({ mobileTab: 'ai' });
          syncLayoutClasses();
          store.emit('ai:summarize-request', { text, autoRun: true });
        });
        card.querySelector('#mobile-quick-save')?.addEventListener('click', async () => {
          const text = ta?.value?.trim();
          if (!text) {
            showToast('请先输入内容', 'warning');
            return;
          }
          try {
            const title = `随手速记_${text.replace(/[\r\n#>*`]/g, '').slice(0, 14) || '笔记'}`;
            const created = await api.post('/api/files/create-note', { title, content: text });
            closeSheet();
            store.emit('files:updated');
            if (created?.path) {
              store.emit('file:open', created);
            }
            showToast('已保存至本地笔记目录', 'success');
          } catch (err) {
            showToast(err?.message || '保存笔记失败', 'error');
          }
        });
      },
    });
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 1023 && store.state.tabletDrawerOpen) {
      store.setState({ tabletDrawerOpen: false });
      syncLayoutClasses();
    }
  });
}

async function loadSystemInfo() {
  try {
    const [info, cfg] = await Promise.all([
      api.get('/api/system/info'),
      api.get('/api/system/config').catch(() => null),
    ]);
    if (info && typeof info === 'object') {
      store.setState({ systemInfo: info }, 'system:info');
    }
    if (cfg && typeof cfg === 'object') {
      store.setState({ config: cfg }, 'system:config');
      let hasLocalAutoSave = false;
      try {
        hasLocalAutoSave = localStorage.getItem('sln_auto_save') !== null;
      } catch {
        // ignore storage errors
      }
      if (!hasLocalAutoSave && cfg.auto_save_on_switch !== undefined) {
        store.setState({ autoSaveOnSwitch: Boolean(cfg.auto_save_on_switch) }, 'autosave:changed');
      }
      let hasLocalSize = false;
      let hasLocalFamily = false;
      try {
        hasLocalSize = localStorage.getItem('sln_doc_font_size') !== null;
        hasLocalFamily = localStorage.getItem('sln_doc_font_family') !== null;
      } catch {
        // ignore storage errors
      }
      const nextSize = !hasLocalSize && cfg.doc_font_size != null
        ? cfg.doc_font_size
        : store.state.docFontSize;
      const nextFamily = !hasLocalFamily && cfg.doc_font_family != null
        ? cfg.doc_font_family
        : store.state.docFontFamily;
      if ((!hasLocalSize && cfg.doc_font_size != null) || (!hasLocalFamily && cfg.doc_font_family != null)) {
        applyDocTypography(nextSize, nextFamily);
      }
      if (cfg.ui_layout && typeof cfg.ui_layout === 'object') {
        if (typeof storeMod.loadLayoutMemoryFromConfig === 'function') {
          storeMod.loadLayoutMemoryFromConfig(cfg.ui_layout);
        }
        const widths = store.state.paneWidths || { left: 260, right: 360 };
        applyPaneWidths(widths.left ?? 260, widths.right ?? 360);
        updateThemeButtonIcon();
        syncLayoutClasses();
      }
    }
  } catch {
    // Graceful fallback if server unavailable
  }
}

async function bootstrap() {
  window.__SLN_BOOTED__ = true;
  // 1. Apply saved theme, typography & pane widths immediately
  applyTheme(store.state.theme);
  applyDocTypography(store.state.docFontSize, store.state.docFontFamily);
  applyPaneWidths(store.state.paneWidths?.left ?? 260, store.state.paneWidths?.right ?? 360);
  updateThemeButtonIcon();

  // 2. Mount panels cleanly with error isolation
  const leftEl = document.getElementById('left-panel');
  const centerEl = document.getElementById('center-panel');
  const rightEl = document.getElementById('right-panel');

  const safeMount = (name, fn) => {
    try {
      fn();
    } catch (err) {
      console.error(`[SmartLocalNote] Failed to mount ${name}:`, err);
      showToast(`${name} 模块初始化异常：${err?.message || err}`, 'error', { duration: 6000 });
    }
  };

  safeMount('left_tree', () => initLeftTree(leftEl));
  safeMount('center_view', () => initCenterView(centerEl));
  safeMount('right_panel', () => initRightPanel(rightEl));
  safeMount('spotlight', () => initSpotlight());
  safeMount('stickies', () => initStickies());
  safeMount('drag_shelf', () => initDragShelf());

  // 3. Bind shell controls, pane resizers, drag cleanup & responsive state
  bindTopBarControls();
  bindGlobalShortcuts();
  bindPaneResizers();
  bindMobileControls();
  window.addEventListener('dragend', () => {
    clearDragPayload();
    store.emit('drag:active', false);
  });
  syncLayoutClasses();

  // 4. Initialize Dynamic Island to idle
  setIsland('idle', { label: 'Local-First 工作台就绪' });

  // 5. Fetch system info & config silently, then connect SSE stream
  await loadSystemInfo();
  connectEventStream((evt) => {
    if (!evt) return;
    if (evt.type === 'reminder:fired') {
      setIsland('alert', evt.data || {});
    } else if (evt.type === 'snapshot:created') {
      showToast('已自动创建写前安全快照', 'info', { duration: 2000 });
    }
    store.emit(`sse:${evt.type}`, evt.data);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
