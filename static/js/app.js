/**
 * SmartLocalNote - Application Bootstrap
 * Loads saved theme & /api/system/info, mounts Left/Center/Right/Spotlight modules,
 * binds top bar & responsive mobile/tablet controls, and sets initial Dynamic Island state.
 */

import { store, applyTheme, setIsland, showToast, openSheet, closeSheet } from './store.js';
import { api, connectEventStream } from './api_client.js';
import { icon } from './icons.js';
import { initLeftTree } from './left_tree.js';
import { initCenterView } from './center_view.js';
import { initRightPanel } from './right_panel.js';
import { initSpotlight } from './spotlight.js';

function syncLayoutClasses() {
  const shell = document.getElementById('app-shell') || document.body;
  const leftCollapsed = Boolean(store.state.leftCollapsed);
  const rightCollapsed = Boolean(store.state.rightCollapsed);
  const drawerOpen = Boolean(store.state.tabletDrawerOpen);
  const tab = store.state.mobileTab || 'doc';

  shell.dataset.leftCollapsed = String(leftCollapsed);
  shell.dataset.rightCollapsed = String(rightCollapsed);
  shell.dataset.drawerOpen = String(drawerOpen);
  shell.dataset.mobileTab = tab;

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

  store.on('theme:changed', updateThemeButtonIcon);
  store.on('layout:changed', syncLayoutClasses);
  store.on('file:open', () => {
    if (window.innerWidth <= 767) {
      store.setState({ mobileTab: 'doc' });
      syncLayoutClasses();
    } else if (store.state.tabletDrawerOpen) {
      store.setState({ tabletDrawerOpen: false });
      syncLayoutClasses();
    }
  });
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
    }
  } catch {
    // Graceful fallback if server unavailable
  }
}

async function bootstrap() {
  // 1. Apply saved theme immediately
  applyTheme(store.state.theme);
  updateThemeButtonIcon();

  // 2. Mount panels cleanly
  const leftEl = document.getElementById('left-panel');
  const centerEl = document.getElementById('center-panel');
  const rightEl = document.getElementById('right-panel');

  initLeftTree(leftEl);
  initCenterView(centerEl);
  initRightPanel(rightEl);
  initSpotlight();

  // 3. Bind shell controls & responsive state
  bindTopBarControls();
  bindMobileControls();
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
