/**
 * SmartLocalNote - Application Bootstrap
 * Loads saved theme & /api/system/info, mounts Left/Center/Right/Spotlight modules,
 * binds top bar & responsive mobile/tablet controls, and sets initial Dynamic Island state.
 */

import * as storeMod from './store.js';
import {
  store,
  escapeHtml,
  nextSequentialName,
  applyTheme,
  applyDocTypography,
  applyPaneWidths,
  recordRecentFile,
  clearDragPayload,
  readDragPayload,
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
  const btnCenterHome = document.getElementById('btn-center-home');
  const btnRight = document.getElementById('btn-toggle-right');
  const btnTheme = document.getElementById('btn-theme');
  const drawerBackdrop = document.getElementById('drawer-backdrop');

  const syncCenterHomeBtn = () => {
    const view = store.state.activeCenterView === 'explorer' ? 'explorer' : 'doc';
    const isExplorer = view === 'explorer';
    const shell = document.getElementById('app-shell') || document.body;
    if (shell) {
      shell.dataset.centerView = view;
    }
    if (btnCenterHome) {
      btnCenterHome.classList.toggle('is-active', isExplorer);
      btnCenterHome.setAttribute('aria-pressed', isExplorer ? 'true' : 'false');
    }
  };

  btnCenterHome?.addEventListener('click', () => {
    const nextView = store.state.activeCenterView === 'explorer' ? 'doc' : 'explorer';
    if (window.innerWidth <= 767) {
      store.setState({ mobileTab: 'doc' });
      syncLayoutClasses();
    }
    if (typeof store.setCenterView === 'function') {
      store.setCenterView(nextView);
    } else {
      store.setState({ activeCenterView: nextView }, 'center-view:change');
    }
  });
  store.on('center-view:change', syncCenterHomeBtn);
  syncCenterHomeBtn();

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
  const existingNames = (store.state.files?.items || []).map((f) => f?.name || f?.path || '');
  const defaultTitle = nextSequentialName('新建笔记', existingNames);

  openSheet({
    title: '新建本地笔记 (Ctrl+N)',
    bodyHtml: `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label for="global-new-note-title" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">笔记标题（留空自动顺延命名）</label>
          <input id="global-new-note-title" type="text" class="apple-input" value="${escapeHtml(defaultTitle)}" placeholder="留空自动命名为 ${escapeHtml(defaultTitle)}" autocomplete="off" />
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

      window.requestAnimationFrame(() => {
        titleInput?.focus();
        titleInput?.select?.();
      });
      card.querySelector('#global-note-cancel')?.addEventListener('click', closeSheet);

      const doCreate = async () => {
        const title = titleInput?.value?.trim() || defaultTitle;
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

export function bindPaneResizers() {
  let tooltipEl = null;

  const ensureTooltip = () => {
    if (tooltipEl && document.body.contains(tooltipEl)) return tooltipEl;
    tooltipEl = document.getElementById('pane-resize-tooltip');
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.id = 'pane-resize-tooltip';
      tooltipEl.className = 'pane-resize-tooltip';
      tooltipEl.style.cssText = [
        'position:fixed',
        'z-index:9999',
        'pointer-events:none',
        'padding:3px 8px',
        'border-radius:999px',
        'font-size:11px',
        'font-weight:600',
        'font-variant-numeric:tabular-nums',
        'background:var(--surface-elevated, rgba(24,24,28,0.88))',
        'color:var(--text-primary, #ffffff)',
        'border:1px solid var(--border-subtle, rgba(128,128,140,0.28))',
        'box-shadow:0 6px 16px rgba(0,0,0,0.16)',
        'backdrop-filter:blur(10px)',
      ].join(';');
      tooltipEl.hidden = true;
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  };

  const showTooltip = (x, y, px) => {
    const tip = ensureTooltip();
    tip.textContent = `${Math.round(px)}px`;
    tip.hidden = false;
    const left = Math.min(window.innerWidth - 72, Math.max(8, x + 14));
    const top = Math.min(window.innerHeight - 36, Math.max(8, y - 28));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const hideTooltip = () => {
    if (tooltipEl) {
      tooltipEl.hidden = true;
    }
  };

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
      hideTooltip();
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
      showTooltip(e.clientX, e.clientY, startW);
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
      let applied;
      if (side === 'left') {
        applied = applyPaneWidths(startW + dx, cur.right);
        showTooltip(e.clientX, e.clientY, applied.left);
      } else {
        applied = applyPaneWidths(cur.left, startW - dx);
        showTooltip(e.clientX, e.clientY, applied.right);
      }
    });

    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

    el.addEventListener('dblclick', () => {
      const cur = store.state.paneWidths || { left: 260, right: 360 };
      if (side === 'left') {
        applyPaneWidths(260, cur.right);
        showToast('左侧栏已恢复默认宽度 (260px)', 'info', { duration: 1500 });
      } else {
        applyPaneWidths(cur.left, 360);
        showToast('右侧栏已恢复默认宽度 (360px)', 'info', { duration: 1500 });
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

export function initFocusDurationPopover() {
  let popEl = document.getElementById('focus-duration-popover');
  if (!popEl) {
    popEl = document.createElement('div');
    popEl.id = 'focus-duration-popover';
    popEl.className = 'focus-duration-popover';
    popEl.setAttribute('role', 'dialog');
    popEl.setAttribute('aria-label', '选择专注时长');
    popEl.hidden = true;
    document.body.appendChild(popEl);
  }

  let currentOpts = null;

  const closePopover = () => {
    if (!popEl) return;
    popEl.hidden = true;
    popEl.classList.remove('is-open');
    popEl.innerHTML = '';
    currentOpts = null;
  };

  const triggerStart = (minutes) => {
    const mins = Math.min(240, Math.max(1, Math.round(Number(minutes) || 25)));
    const payload = { ...(currentOpts || {}), minutes: mins };
    closePopover();
    store.emit('focus:start', payload);
  };

  const openPopover = (opts = {}) => {
    currentOpts = opts && typeof opts === 'object' ? { ...opts } : {};
    const titleHint = currentOpts.title
      ? `<div class="focus-pop-title">${icon('clock', 12)} <span>${escapeHtml(String(currentOpts.title).slice(0, 28))}</span></div>`
      : `<div class="focus-pop-title">${icon('clock', 12)} <span>选择专注时长</span></div>`;

    popEl.innerHTML = `
      ${titleHint}
      <div class="focus-pop-presets">
        <button type="button" class="pill-btn pill-btn-sm" data-focus-min="15">15分</button>
        <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-focus-min="25">25分</button>
        <button type="button" class="pill-btn pill-btn-sm" data-focus-min="45">45分</button>
      </div>
      <div class="focus-pop-custom">
        <input type="number" class="apple-input focus-pop-input" id="focus-pop-custom-min" min="1" max="240" value="25" aria-label="自定义分钟数" />
        <span class="focus-pop-unit">分钟</span>
        <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-focus-action="start">开始专注</button>
      </div>
    `;

    popEl.hidden = false;
    popEl.classList.add('is-open');

    const anchor = currentOpts.anchorEl && typeof currentOpts.anchorEl.getBoundingClientRect === 'function'
      ? currentOpts.anchorEl
      : null;

    const popW = popEl.offsetWidth || 248;
    const popH = popEl.offsetHeight || 118;
    let left = Math.round((window.innerWidth - popW) / 2);
    let top = 72;
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      left = Math.min(window.innerWidth - popW - 12, Math.max(12, Math.round(rect.left)));
      const belowTop = Math.round(rect.bottom + 8);
      const aboveTop = Math.round(rect.top - popH - 8);
      top = belowTop + popH <= window.innerHeight - 12
        ? belowTop
        : Math.max(12, aboveTop);
    }

    popEl.style.position = 'fixed';
    popEl.style.left = `${left}px`;
    popEl.style.top = `${top}px`;
    popEl.style.zIndex = '1400';

    const customInput = popEl.querySelector('#focus-pop-custom-min');
    popEl.querySelectorAll('[data-focus-min]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerStart(btn.dataset.focusMin);
      });
    });
    popEl.querySelector('[data-focus-action="start"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerStart(customInput?.value);
    });
    customInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        triggerStart(customInput.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closePopover();
      }
    });
  };

  store.on('focus:pick-duration', openPopover);

  document.addEventListener('pointerdown', (e) => {
    if (popEl.hidden) return;
    if (popEl.contains(e.target)) return;
    if (currentOpts?.anchorEl && currentOpts.anchorEl.contains?.(e.target)) return;
    closePopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popEl.hidden) {
      closePopover();
    }
  });
}

export function initFloatingModulesHost() {
  let layerEl = document.getElementById('floating-modules-layer');
  if (!layerEl) {
    layerEl = document.createElement('div');
    layerEl.id = 'floating-modules-layer';
    layerEl.className = 'floating-modules-layer';
    layerEl.setAttribute('aria-label', '浮动模块窗口层');
    document.body.appendChild(layerEl);
  }

  const floatedMap = new Map();
  let topZ = 1120;

  const clampRect = (rect = {}) => {
    const maxW = Math.max(260, window.innerWidth - 24);
    const maxH = Math.max(200, window.innerHeight - 68);
    const w = Math.min(maxW, Math.max(240, Math.round(Number(rect.w) || 340)));
    const h = Math.min(maxH, Math.max(180, Math.round(Number(rect.h) || 420)));
    const x = Math.min(Math.max(8, window.innerWidth - w - 8), Math.max(8, Math.round(Number(rect.x) || 120)));
    const y = Math.min(Math.max(52, window.innerHeight - Math.min(h, 80) - 8), Math.max(52, Math.round(Number(rect.y) || 96)));
    return { x, y, w, h };
  };

  const applyWinRect = (winEl, rect) => {
    const c = clampRect(rect);
    winEl.style.left = `${c.x}px`;
    winEl.style.top = `${c.y}px`;
    winEl.style.width = `${c.w}px`;
    winEl.style.height = `${c.h}px`;
    return c;
  };

  const findSidebarModuleEl = (modId) => {
    const esc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(modId)
      : modId.replace(/"/g, '\\"');
    for (const rootId of ['left-panel', 'right-panel']) {
      const root = document.getElementById(rootId);
      if (!root) continue;
      const found = root.querySelector(`[data-module-id="${esc}"], [data-summary-module-id="${esc}"]`);
      if (found && !layerEl.contains(found)) {
        return found;
      }
    }
    return null;
  };

  const dockBack = (modId) => {
    const rec = floatedMap.get(modId);
    if (!rec) return;
    if (rec.placeholderEl?.isConnected && rec.moduleEl) {
      rec.placeholderEl.replaceWith(rec.moduleEl);
    } else {
      rec.placeholderEl?.remove();
    }
    rec.winEl?.remove();
    floatedMap.delete(modId);
  };

  const openFloatWindow = (modId, entry = {}) => {
    const existing = floatedMap.get(modId);
    if (existing && existing.winEl?.isConnected) {
      if (existing.winEl.dataset.dragging !== '1') {
        applyWinRect(existing.winEl, entry);
      }
      // If sidebar re-rendered a fresh copy, swap it in and re-insert placeholder
      if (!existing.placeholderEl?.isConnected) {
        const fresh = findSidebarModuleEl(modId);
        if (fresh && fresh !== existing.moduleEl && fresh.parentNode) {
          const ph = document.createElement('span');
          ph.className = 'floating-module-placeholder';
          ph.dataset.floatingPlaceholder = modId;
          ph.hidden = true;
          fresh.parentNode.insertBefore(ph, fresh);
          if (fresh.tagName === 'DETAILS') fresh.open = true;
          fresh.classList.remove('is-collapsed');
          existing.bodyEl.innerHTML = '';
          existing.bodyEl.appendChild(fresh);
          existing.placeholderEl = ph;
          existing.moduleEl = fresh;
        }
      }
      return true;
    }

    const moduleEl = findSidebarModuleEl(modId);
    if (!moduleEl || !moduleEl.parentNode) return false;

    const placeholderEl = document.createElement('span');
    placeholderEl.className = 'floating-module-placeholder';
    placeholderEl.dataset.floatingPlaceholder = modId;
    placeholderEl.hidden = true;
    moduleEl.parentNode.insertBefore(placeholderEl, moduleEl);

    if (moduleEl.tagName === 'DETAILS') {
      moduleEl.open = true;
    }
    moduleEl.classList.remove('is-collapsed');

    const titleText = entry.title
      || moduleEl.querySelector('.module-header, .tool-card-summary')?.textContent?.trim()?.slice(0, 32)
      || modId;

    const winEl = document.createElement('section');
    winEl.className = 'floating-module-window';
    winEl.dataset.floatingModuleId = modId;
    winEl.style.zIndex = String(++topZ);

    const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
      .map((dir) => `<div class="float-resize-handle float-resize-${dir}" data-resize-dir="${dir}" aria-hidden="true"></div>`)
      .join('');

    winEl.innerHTML = `
      <header class="floating-module-header" data-float-drag-handle="1">
        <span class="floating-module-title">${escapeHtml(titleText)}</span>
        <button type="button" class="pill-btn pill-btn-sm floating-dock-btn" data-float-action="dock" title="吸回侧栏">
          ${icon('corner-up-left', 12)} 吸回侧栏
        </button>
      </header>
      <div class="floating-module-body"></div>
      ${handles}
    `;

    const bodyEl = winEl.querySelector('.floating-module-body');
    bodyEl.appendChild(moduleEl);

    const rect = applyWinRect(winEl, entry);
    let curRect = { ...rect };

    winEl.addEventListener('pointerdown', () => {
      winEl.style.zIndex = String(++topZ);
    });

    winEl.querySelector('[data-float-action="dock"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof store.toggleModuleFloat === 'function') {
        store.toggleModuleFloat(modId, { open: false });
      } else {
        dockBack(modId);
      }
    });

    // Header drag move
    const headerEl = winEl.querySelector('[data-float-drag-handle]');
    headerEl?.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, a') || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      winEl.dataset.dragging = '1';
      const startX = e.clientX;
      const startY = e.clientY;
      const origin = { ...curRect };

      const onMove = (ev) => {
        curRect = applyWinRect(winEl, {
          ...origin,
          x: origin.x + (ev.clientX - startX),
          y: origin.y + (ev.clientY - startY),
        });
      };
      const onUp = () => {
        delete winEl.dataset.dragging;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        store.updateFloatingModuleRect?.(modId, curRect, { emit: false });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });

    // 8-direction (5-way + 4-corner) resize handles
    winEl.querySelectorAll('.float-resize-handle').forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        winEl.dataset.dragging = '1';
        const dir = handle.dataset.resizeDir || 'se';
        const startX = e.clientX;
        const startY = e.clientY;
        const origin = { ...curRect };

        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          let { x, y, w, h } = origin;

          if (dir.includes('e')) {
            w = Math.max(240, origin.w + dx);
          }
          if (dir.includes('s')) {
            h = Math.max(180, origin.h + dy);
          }
          if (dir.includes('w')) {
            const nextW = Math.max(240, origin.w - dx);
            x = origin.x + (origin.w - nextW);
            w = nextW;
          }
          if (dir.includes('n')) {
            const nextH = Math.max(180, origin.h - dy);
            y = origin.y + (origin.h - nextH);
            h = nextH;
          }
          curRect = applyWinRect(winEl, { x, y, w, h });
        };
        const onUp = () => {
          delete winEl.dataset.dragging;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          store.updateFloatingModuleRect?.(modId, curRect, { emit: false });
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });
    });

    layerEl.appendChild(winEl);
    floatedMap.set(modId, { modId, winEl, bodyEl, placeholderEl, moduleEl });
    return true;
  };

  const syncFloatingModules = () => {
    const map = store.state.uiLayout?.floatingModules || {};
    for (const modId of Array.from(floatedMap.keys())) {
      if (!map[modId]?.open) {
        dockBack(modId);
      }
    }
    for (const [modId, entry] of Object.entries(map)) {
      if (entry?.open) {
        openFloatWindow(modId, entry);
      }
    }
  };

  store.on('module:float-change', (evt) => {
    if (evt?.rectOnly) return;
    syncFloatingModules();
  });
  store.on('ui:layout-changed', syncFloatingModules);
  store.on('files:updated', () => window.requestAnimationFrame(syncFloatingModules));
  window.addEventListener('resize', () => {
    for (const rec of floatedMap.values()) {
      const r = {
        x: parseFloat(rec.winEl.style.left) || 120,
        y: parseFloat(rec.winEl.style.top) || 96,
        w: parseFloat(rec.winEl.style.width) || 340,
        h: parseFloat(rec.winEl.style.height) || 420,
      };
      applyWinRect(rec.winEl, r);
    }
  });

  window.requestAnimationFrame(syncFloatingModules);
  window.setTimeout(syncFloatingModules, 360);
}

function initStandaloneFloatingHubs() {
  const configs = {
    stickies: {
      id: 'floating-stickies-win',
      storageKey: 'sln_float_win_stickies_v1',
      defaultRect: () => ({
        x: Math.max(16, Math.round(window.innerWidth / 2 - 175)),
        y: 64,
        w: 350,
        h: 390,
      }),
    },
    trash: {
      id: 'floating-trash-win',
      storageKey: 'sln_float_win_trash_v1',
      defaultRect: () => ({
        x: Math.max(16, Math.round(window.innerWidth / 2 - 200)),
        y: 64,
        w: 400,
        h: 430,
      }),
    },
  };

  let topZ = 1220;

  const clampRect = (rect = {}) => {
    const maxW = Math.max(260, window.innerWidth - 20);
    const maxH = Math.max(200, window.innerHeight - 64);
    const w = Math.min(maxW, Math.max(260, Math.round(Number(rect.w) || 360)));
    const h = Math.min(maxH, Math.max(200, Math.round(Number(rect.h) || 400)));
    const x = Math.min(Math.max(8, window.innerWidth - w - 8), Math.max(8, Math.round(Number(rect.x) || 120)));
    const y = Math.min(Math.max(50, window.innerHeight - Math.min(h, 80) - 8), Math.max(50, Math.round(Number(rect.y) || 64)));
    return { x, y, w, h };
  };

  const loadRect = (cfg) => {
    try {
      const raw = localStorage.getItem(cfg.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return clampRect(parsed);
      }
    } catch {
      // ignore
    }
    return clampRect(cfg.defaultRect());
  };

  const saveRect = (cfg, rect) => {
    try {
      localStorage.setItem(cfg.storageKey, JSON.stringify(rect));
    } catch {
      // ignore
    }
  };

  const applyRect = (winEl, rect) => {
    const c = clampRect(rect);
    winEl.style.position = 'fixed';
    winEl.style.left = `${c.x}px`;
    winEl.style.top = `${c.y}px`;
    winEl.style.width = `${c.w}px`;
    winEl.style.height = `${c.h}px`;
    return c;
  };

  const bindWin = (key, cfg) => {
    const winEl = document.getElementById(cfg.id);
    if (!winEl || winEl.dataset.floatBound === '1') return;
    winEl.dataset.floatBound = '1';

    let curRect = applyRect(winEl, loadRect(cfg));

    winEl.addEventListener('pointerdown', () => {
      winEl.style.zIndex = String(++topZ);
    });

    winEl.querySelector(`[data-float-win-close="${key}"]`)?.addEventListener('click', (e) => {
      e.stopPropagation();
      winEl.hidden = true;
      winEl.classList.remove('is-open');
      store.emit('island:float-state', { which: key, open: false });
    });

    const headerEl = winEl.querySelector('[data-float-drag-handle]');
    headerEl?.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, select, a') || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      winEl.style.zIndex = String(++topZ);
      const startX = e.clientX;
      const startY = e.clientY;
      const origin = { ...curRect };
      const onMove = (ev) => {
        curRect = applyRect(winEl, {
          ...origin,
          x: origin.x + (ev.clientX - startX),
          y: origin.y + (ev.clientY - startY),
        });
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        saveRect(cfg, curRect);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });

    winEl.querySelectorAll('.float-resize-handle').forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        winEl.style.zIndex = String(++topZ);
        const dir = handle.dataset.resizeDir || 'se';
        const startX = e.clientX;
        const startY = e.clientY;
        const origin = { ...curRect };
        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          let { x, y, w, h } = origin;
          if (dir.includes('e')) w = Math.max(260, origin.w + dx);
          if (dir.includes('s')) h = Math.max(200, origin.h + dy);
          if (dir.includes('w')) {
            const nextW = Math.max(260, origin.w - dx);
            x = origin.x + (origin.w - nextW);
            w = nextW;
          }
          if (dir.includes('n')) {
            const nextH = Math.max(200, origin.h - dy);
            y = origin.y + (origin.h - nextH);
            h = nextH;
          }
          curRect = applyRect(winEl, { x, y, w, h });
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          saveRect(cfg, curRect);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });
    });
  };

  Object.entries(configs).forEach(([k, cfg]) => bindWin(k, cfg));

  const setWinOpen = (which, shouldOpen) => {
    const cfg = configs[which];
    if (!cfg) return;
    const winEl = document.getElementById(cfg.id);
    if (!winEl) return;
    const isCurrentlyOpen = !winEl.hidden;
    const nextOpen = typeof shouldOpen === 'boolean' ? shouldOpen : !isCurrentlyOpen;
    if (nextOpen) {
      applyRect(winEl, loadRect(cfg));
      winEl.style.zIndex = String(++topZ);
      winEl.hidden = false;
      winEl.removeAttribute('hidden');
      winEl.classList.add('is-open');
      if (which === 'trash') {
        store.refreshTrash?.().catch(() => {});
      }
      store.emit('island:tab-change', which);
    } else {
      winEl.hidden = true;
      winEl.classList.remove('is-open');
    }
    store.emit('island:float-state', { which, open: nextOpen });
  };

  store.on('island:toggle-float', (which) => {
    if (which === 'stickies' || which === 'trash') {
      setWinOpen(which);
    }
  });

  store.on('island:switch-tab', (tabName) => {
    if (tabName === 'stickies' || tabName === 'trash') {
      setWinOpen(tabName, true);
    } else if (tabName === 'shelf') {
      store.emit('shelf:toggle');
    }
  });
}

function initModuleSizePopover() {
  let popEl = document.getElementById('module-size-popover');
  if (!popEl) {
    popEl = document.createElement('div');
    popEl.id = 'module-size-popover';
    popEl.className = 'module-size-popover';
    popEl.setAttribute('role', 'menu');
    popEl.hidden = true;
    document.body.appendChild(popEl);
  }

  let activeTrigger = null;

  const closeMenu = () => {
    if (!popEl) return;
    popEl.hidden = true;
    popEl.classList.remove('is-open');
    popEl.innerHTML = '';
    activeTrigger = null;
  };

  const options = [
    { key: 'auto', label: 'Auto 自适应', desc: '随内容自然撑开' },
    { key: 's', label: 'S 紧凑', desc: '150px 高度' },
    { key: 'm', label: 'M 标准', desc: '280px 高度' },
    { key: 'l', label: 'L 展开', desc: '460px 高度' },
  ];

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-action="open-module-size-menu"]');
    if (trigger) {
      e.preventDefault();
      e.stopPropagation();
      if (activeTrigger === trigger && !popEl.hidden) {
        closeMenu();
        return;
      }
      activeTrigger = trigger;
      const panel = trigger.dataset.panel || 'left';
      const modId = trigger.dataset.moduleId || '';
      const curPreset = String(store.state.uiLayout?.moduleSizePresets?.[modId] || 'auto').toLowerCase();

      popEl.innerHTML = options
        .map((opt) => {
          const isCur = curPreset === opt.key;
          return `
            <button type="button" class="module-size-pop-item ${isCur ? 'is-active' : ''}" data-size-preset="${opt.key}" role="menuitem">
              <span class="module-size-pop-label">${isCur ? '✓ ' : ''}${opt.label}</span>
              <span class="module-size-pop-desc">${opt.desc}</span>
            </button>
          `;
        })
        .join('');

      popEl.hidden = false;
      popEl.classList.add('is-open');
      const rect = trigger.getBoundingClientRect();
      const popW = popEl.offsetWidth || 168;
      const popH = popEl.offsetHeight || 132;
      const left = Math.min(window.innerWidth - popW - 10, Math.max(10, Math.round(rect.right - popW)));
      const top = rect.bottom + popH + 8 <= window.innerHeight
        ? Math.round(rect.bottom + 6)
        : Math.max(10, Math.round(rect.top - popH - 6));
      popEl.style.position = 'fixed';
      popEl.style.left = `${left}px`;
      popEl.style.top = `${top}px`;
      popEl.style.zIndex = '1550';

      popEl.querySelectorAll('[data-size-preset]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const preset = btn.dataset.sizePreset || 'auto';
          store.setModuleSizePreset?.(panel, modId, preset);
          const shortLabel = preset === 'auto' ? 'Auto' : preset.toUpperCase();
          if (activeTrigger) {
            activeTrigger.textContent = `${shortLabel} ▾`;
          }
          closeMenu();
        });
      });
      return;
    }

    if (!popEl.hidden && !popEl.contains(e.target)) {
      closeMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popEl.hidden) {
      closeMenu();
    }
  });
}

function bindPortableTrashDock() {
  const dockEl = document.getElementById('portable-trash-dock');
  if (!dockEl || dockEl.dataset.bound === '1') return;
  dockEl.dataset.bound = '1';

  const clearZoneHighlights = () => {
    dockEl.classList.remove('is-drag-over');
    dockEl.querySelectorAll('.portable-trash-zone.is-drag-over').forEach((z) => z.classList.remove('is-drag-over'));
  };

  const showDock = (payload) => {
    if (store.state.isInternalReorderDrag || payload?.type === 'module-reorder' || payload?.type === 'tool-module') return;
    dockEl.hidden = false;
    dockEl.removeAttribute('hidden');
    window.requestAnimationFrame(() => dockEl.classList.add('is-visible'));
  };

  const hideDock = () => {
    clearZoneHighlights();
    dockEl.classList.remove('is-visible');
    window.setTimeout(() => {
      if (!store.state.globalDrag) {
        dockEl.hidden = true;
      }
    }, 180);
  };

  store.on('drag:global-start', showDock);
  store.on('drag:global-end', hideDock);

  dockEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dockEl.classList.add('is-drag-over');
    const zone = e.target.closest('.portable-trash-zone[data-drop-zone]');
    dockEl.querySelectorAll('.portable-trash-zone[data-drop-zone]').forEach((z) => {
      z.classList.toggle('is-drag-over', z === zone);
    });
  });

  dockEl.addEventListener('dragleave', (e) => {
    if (!dockEl.contains(e.relatedTarget)) {
      clearZoneHighlights();
    }
  });

  dockEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const zone = e.target.closest('.portable-trash-zone[data-drop-zone]');
    const dropMode = zone?.dataset.dropZone === 'system-trash' ? 'system' : 'app';
    clearZoneHighlights();
    const payload = readDragPayload(e) || store.getGlobalDrag() || {};
    clearDragPayload();
    store.endGlobalDrag?.();

    const kind = String(payload?.kind || payload?.type || '');
    const virtualKinds = ['snippet', 'block', 'lp-block', 'sticky', 'ai', 'summary', 'chat', 'mindmap-card', 'workspace', 'app', 'app-portal', 'capsule'];
    const paths = Array.isArray(payload?.paths) && payload.paths.length > 0
      ? payload.paths
      : (payload?.path ? [payload.path] : []);

    try {
      if (payload?.sourceShelfId) {
        store.removeFromShelf(payload.sourceShelfId);
        await store.trashVirtualItem({
          kind: 'staging',
          title: payload.label || '暂存片段',
          payload,
          source_path: payload.path || payload.sourceDocPath || '',
        });
        showToast('已将暂存片段移入内置回收站', 'info');
      } else if (paths.length > 0 && !virtualKinds.includes(kind)) {
        for (const p of paths) {
          await store.trashFile(p, dropMode);
        }
      } else if (payload && Object.keys(payload).length > 0) {
        await store.trashVirtualItem({
          kind: kind || 'snippet',
          title: payload.title || payload.label || '内容片段',
          payload,
          source_path: payload.sourceDocPath || payload.path || '',
        });
        store.emit('trash:consumed-drag', payload);
        showToast('已移入内置回收站', 'info');
      }
    } catch (err) {
      showToast(`移入回收站失败：${err?.message || '未知错误'}`, 'error');
    }
  });

  dockEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-trash-dock-action="open-trash"]');
    if (!btn) return;
    store.emit('island:toggle-float', 'trash');
  });
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

  // 3. Bind shell controls, pane resizers, floating hosts, trash dock, drag cleanup & responsive state
  bindTopBarControls();
  bindGlobalShortcuts();
  bindPaneResizers();
  bindMobileControls();
  initFocusDurationPopover();
  initFloatingModulesHost();
  initStandaloneFloatingHubs();
  initModuleSizePopover();
  bindPortableTrashDock();
  window.addEventListener('dragend', () => {
    clearDragPayload();
    store.endGlobalDrag?.();
    store.emit('drag:active', false);
  });
  syncLayoutClasses();

  // 4. Initialize Dynamic Island to idle
  setIsland('idle', { label: 'Local-First 工作台就绪' });

  // 5. Fetch system info, config, trash & todos silently, then connect SSE stream
  await loadSystemInfo();
  Promise.allSettled([
    store.refreshTrash?.().catch(() => {}),
    store.refreshAllTodos?.().catch(() => {}),
    store.refreshLinkGraph?.().catch(() => {}),
    (!store.state.folders?.length ? store.refreshFilesList?.().catch(() => {}) : Promise.resolve()),
  ]);
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
