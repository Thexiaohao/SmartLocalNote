/**
 * SmartLocalNote - Center Workspace Panel (Stages 2, 3 & 4)
 * Supports:
 *  1. Welcome / Empty State + Auto-open first .md file on files:updated
 *  2. Markdown / TXT Mode (Edit/Preview segmented pill, atomic save, snapshots, AI summary, doc:append)
 *  3. Excel In-Place Editor Mode (Sheets, paginated rows, search, sort, inline cell edit, batch patch, append row, CSV export, snapshots, cell anchor copy)
 *  4. PDF Native Preview + Companion Markdown Note Mode (Stream iframe, page jump, PDF annotation, companion edit/preview/save, page anchor copy)
 *  5. Innovation 2: Cross-Format Atomic Anchors (anchor:jump to PDF #page=N or Excel #Sheet!Cell with smooth scroll & pulse)
 *
 * Communicates strictly via store EventBus.
 */

import {
  store,
  renderMarkdownSafe,
  showToast,
  copyInternal,
  escapeHtml,
  setIsland,
  openSheet,
  closeSheet,
} from './store.js';
import { api } from './api_client.js';
import { icon } from './icons.js';

/**
 * Convert 1-based column index to Excel column letter (1 -> A, 2 -> B, 27 -> AA).
 * @param {number} n
 * @returns {string}
 */
export function colIndexToLetter(n) {
  let num = Math.floor(Number(n));
  if (!Number.isFinite(num) || num < 1) return '';
  let result = '';
  while (num > 0) {
    const rem = (num - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    num = Math.floor((num - 1) / 26);
  }
  return result;
}

/**
 * Parse Excel cell reference such as "C4" into { col: 3, row: 4, colLetter: "C" }.
 * @param {string} cellStr
 * @returns {{ col: number, row: number, colLetter: string } | null}
 */
export function parseExcelCellRef(cellStr) {
  const m = String(cellStr || '').trim().match(/^([A-Za-z]+)(\d+)$/);
  if (!m) return null;
  const colLetter = m[1].toUpperCase();
  const row = Number.parseInt(m[2], 10);
  if (!Number.isFinite(row) || row < 1) return null;
  let col = 0;
  for (let i = 0; i < colLetter.length; i += 1) {
    col = col * 26 + (colLetter.charCodeAt(i) - 64);
  }
  return { col, row, colLetter };
}

function getBaseName(pathStr) {
  return String(pathStr || '').split(/[\\/]/).pop() || '';
}

function getExtLower(pathOrName) {
  const name = getBaseName(pathOrName);
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function normalizePath(pathStr) {
  return String(pathStr || '').trim().replace(/\\/g, '/');
}

function isSamePath(a, b) {
  if (!a || !b) return false;
  return normalizePath(a) === normalizePath(b);
}

function docIconName(type, ext) {
  if (type === 'pdf' || ext === '.pdf') return 'file-pdf';
  if (type === 'excel' || ext === '.xlsx') return 'file-spreadsheet';
  return 'file-text';
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatSnapTime(iso) {
  return String(iso || '').replace('T', ' ');
}

/**
 * Initialize Center Workspace Panel.
 * @param {HTMLElement} containerEl
 */
export function initCenterView(containerEl) {
  if (!containerEl) return;

  const state = {
    activeDoc: null, // { type, path, name, ext, isPrivate, content, snapshots, pageCount, companionPath, companionContent, companionExists }
    dirty: false,
    mdMode: 'preview', // 'edit' | 'preview'
    loading: false,
    saving: false,
    hasOpenedOnce: false,
    openSeq: 0,
    excelSeq: 0,
    excelSearchTimer: null,
    excel: {
      sheets: [],
      currentSheet: '',
      headers: [],
      rows: [],
      totalRows: 0,
      filteredRows: 0,
      page: 1,
      pageSize: 100,
      totalPages: 1,
      q: '',
      sortCol: null,
      sortDir: 'asc',
      selectedCell: null, // { row, col, colLetter }
      pendingChanges: new Map(), // Map<"row:col", value>
      loading: false,
      editingKey: null,
    },
    pdf: {
      currentPage: 1,
      totalPages: 1,
      companionMode: 'edit', // 'edit' | 'preview'
      companionDirty: false,
      cacheBust: Date.now(),
    },
  };

  function getErrorMsg(err, fallback = '操作失败') {
    return err?.message || fallback;
  }

  function findWorkspaceFile(queryNameOrPath) {
    const target = String(queryNameOrPath || '').trim();
    if (!target) return null;
    const items = store.state.files?.items || [];
    const targetNorm = normalizePath(target);
    const targetBase = getBaseName(target).toLowerCase();

    return (
      items.find((f) => isSamePath(f.path, targetNorm)) ||
      items.find((f) => String(f.name || '').toLowerCase() === targetBase) ||
      items.find((f) => getBaseName(f.path).toLowerCase() === targetBase) ||
      null
    );
  }

  function buildExcelSummaryText() {
    if (!state.activeDoc || state.activeDoc.type !== 'excel') return '';
    const { currentSheet, headers, rows, totalRows } = state.excel;
    const headerLine = headers.map((h, i) => `${colIndexToLetter(i + 1)}:${h}`).join(' | ');
    const sampleRows = rows.slice(0, 30).map((r) => `第${r.row_num}行: ${r.cells.join(' | ')}`);
    return [
      `表格: ${state.activeDoc.name} (${currentSheet}, 共 ${totalRows} 行)`,
      headerLine,
      ...sampleRows,
    ].join('\n');
  }

  function syncActiveFileStore() {
    if (!state.activeDoc) return;
    store.state.activeFile = {
      path: state.activeDoc.path,
      name: state.activeDoc.name,
      ext: state.activeDoc.ext,
      type: state.activeDoc.type,
      is_private: Boolean(state.activeDoc.isPrivate),
    };
    if (state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text') {
      store.state.activeDocumentText = state.activeDoc.content || '';
    } else if (state.activeDoc.type === 'pdf') {
      store.state.activeDocumentText = state.activeDoc.companionContent || '';
    } else if (state.activeDoc.type === 'excel') {
      store.state.activeDocumentText = state.activeDoc.isPrivate ? '' : buildExcelSummaryText();
    }
    setIsland('idle', { label: state.activeDoc.name });
  }

  function ensureDocTabOnMobile() {
    if (typeof window !== 'undefined' && window.innerWidth <= 767 && store.state.mobileTab !== 'doc') {
      store.setState({ mobileTab: 'doc' });
      store.emit('layout:changed');
    }
  }

  // =========================================================================
  // Rendering: Welcome / Loading
  // =========================================================================
  function renderWelcome() {
    const items = store.state.files?.items || [];
    const quickDocs = items.slice(0, 4);

    containerEl.innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          <span class="doc-title-pill">文档工作区</span>
        </div>
        <div class="center-toolbar-group">
          <button type="button" class="pill-btn pill-btn-sm" data-action="welcome-new-note">
            ${icon('plus', 13)} 新建笔记
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="welcome-ai-summary">
            ${icon('sparkles', 13)} 一键 AI 速记
          </button>
        </div>
      </div>

      <div style="flex:1 1 auto; min-height:0; overflow-y:auto; display:flex; align-items:center; justify-content:center; padding:24px;">
        <div class="empty-state glass-card" style="max-width:460px; width:100%; padding:32px 24px;">
          <div style="width:48px; height:48px; border-radius:16px; background:var(--accent-soft); color:var(--accent); display:inline-flex; align-items:center; justify-content:center; margin-bottom:6px;">
            ${icon('book-open', 24)}
          </div>
          <h2 class="empty-title" style="font-size:16px;">欢迎使用 SmartLocalNote</h2>
          <p class="empty-desc" style="max-width:340px;">
            本地优先的苹果风学习与办公工作台。支持 Markdown / TXT 编辑预览、Excel 原位分页编辑与 PDF 伴生笔记跨格式锚点直达。
          </p>
          <div style="display:flex; flex-wrap:wrap; justify-content:center; gap:8px; margin-top:10px;">
            <button type="button" class="pill-btn pill-btn-primary" data-action="welcome-new-note">
              ${icon('plus', 14)} 新建笔记
            </button>
            <button type="button" class="pill-btn" data-action="welcome-ai-summary">
              ${icon('sparkles', 14)} 一键 AI 速记
            </button>
          </div>
          ${
            quickDocs.length > 0
              ? `
            <div style="width:100%; margin-top:16px; padding-top:14px; border-top:1px solid var(--border-hairline); text-align:left;">
              <div class="section-heading" style="margin:0 0 8px;">快速打开工作区文档</div>
              <div style="display:flex; flex-wrap:wrap; gap:6px;">
                ${quickDocs
                  .map(
                    (f) => `
                  <button type="button" class="pill-btn pill-btn-sm" data-action="quick-open" data-path="${escapeHtml(f.path)}">
                    ${icon(docIconName('', f.ext), 13)} ${escapeHtml(f.name)}
                  </button>
                `
                  )
                  .join('')}
              </div>
            </div>
          `
              : ''
          }
        </div>
      </div>
    `;
  }

  function renderLoading(label = '正在加载本地文档…') {
    containerEl.innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          <span class="doc-title-pill">${escapeHtml(label)}</span>
        </div>
      </div>
      <div style="flex:1 1 auto; min-height:0; display:flex; align-items:center; justify-content:center;">
        <div class="empty-state">
          <p class="empty-title">${escapeHtml(label)}</p>
          <p class="empty-desc">通过 safe_io 本地安全网关读取中</p>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // Rendering: Markdown / TXT Mode
  // =========================================================================
  function renderMarkdownMode() {
    const doc = state.activeDoc;
    const isPreview = state.mdMode === 'preview';

    containerEl.innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          <span style="color:var(--accent); display:inline-flex; align-items:center;">${icon(docIconName(doc.type, doc.ext), 16)}</span>
          <span class="doc-title-pill" title="${escapeHtml(doc.path)}">${escapeHtml(doc.name)}</span>
          <span
            data-role="md-dirty-dot"
            title="有未保存修改"
            style="width:7px; height:7px; border-radius:9999px; background:var(--warning); display:${state.dirty ? 'inline-block' : 'none'}; flex-shrink:0;"
          ></span>
          ${
            doc.isPrivate
              ? `<span class="lock-badge" title="隐私锁已开启（严禁发送外部 AI）">${icon('lock', 12)}</span>`
              : ''
          }
        </div>

        <div class="center-toolbar-group">
          <div class="segmented-pill" data-seg="md-mode" role="tablist" aria-label="编辑与预览切换">
            <div class="segmented-thumb" style="width:calc(50% - 3px); transform:translateX(${isPreview ? '100%' : '0%'});"></div>
            <button type="button" class="segmented-btn ${!isPreview ? 'is-active' : ''}" data-md-mode="edit" role="tab" aria-selected="${!isPreview}">
              编辑
            </button>
            <button type="button" class="segmented-btn ${isPreview ? 'is-active' : ''}" data-md-mode="preview" role="tab" aria-selected="${isPreview}">
              预览
            </button>
          </div>

          <button type="button" class="pill-btn pill-btn-sm ${state.dirty ? 'pill-btn-primary' : ''}" data-action="md-save" title="保存 (Ctrl+S / Cmd+S)">
            ${icon('save', 13)} 保存
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="open-snapshots" title="查看与回滚写前安全快照">
            ${icon('rotate-ccw', 13)} 历史快照
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="ai-summarize" title="发送到右侧 AI 提炼摘要与待办">
            ${icon('sparkles', 13)} AI 总结
          </button>
        </div>
      </div>

      <div style="flex:1 1 auto; min-height:0; min-width:0; display:flex; flex-direction:column; overflow:${isPreview ? 'auto' : 'hidden'};">
        ${
          isPreview
            ? `<div class="md-preview">${renderMarkdownSafe(doc.content || '')}</div>`
            : `<textarea class="md-editor" spellcheck="false" placeholder="随时记录想法、笔记或输入 [[文件名.pdf#page=1]] / [[表格.xlsx#Sheet1!C4]]...">${escapeHtml(doc.content || '')}</textarea>`
        }
      </div>
    `;
  }

  function updateMdDirtyIndicators() {
    const dot = containerEl.querySelector('[data-role="md-dirty-dot"]');
    if (dot) {
      dot.style.display = state.dirty ? 'inline-block' : 'none';
    }
    const saveBtn = containerEl.querySelector('[data-action="md-save"]');
    if (saveBtn) {
      saveBtn.classList.toggle('pill-btn-primary', Boolean(state.dirty));
    }
  }

  // =========================================================================
  // Rendering: Excel In-Place Editor Mode
  // =========================================================================
  function getSelectedCoordLabel() {
    const sel = state.excel.selectedCell;
    if (!sel) return '未选单元格';
    return `${sel.colLetter}${sel.row}`;
  }

  function renderExcelTableSection() {
    const ex = state.excel;
    const headers = ex.headers || [];
    const rows = ex.rows || [];
    const pending = ex.pendingChanges;
    const sel = ex.selectedCell;

    const tableHtml = ex.loading && rows.length === 0
      ? `<div class="empty-state"><p class="empty-title">正在读取表格分页数据…</p></div>`
      : headers.length === 0
      ? `<div class="empty-state"><p class="empty-title">当前工作表暂无数据</p><p class="empty-desc">点击右上角「+ 追加行」添加首条记录</p></div>`
      : `
        <table class="excel-table">
          <thead>
            <tr>
              <th class="excel-row-num">#</th>
              ${headers
                .map((h, idx) => {
                  const letter = colIndexToLetter(idx + 1);
                  const isSorted = ex.sortCol === idx;
                  const sortArrow = isSorted ? (ex.sortDir === 'desc' ? ' ↓' : ' ↑') : '';
                  return `
                    <th data-sort-col="${idx}" style="cursor:pointer; user-select:none;" title="点击按「${escapeHtml(h)}」排序">
                      <span style="color:var(--text-tertiary); font-family:var(--font-mono); margin-right:4px;">${escapeHtml(letter)}</span>
                      <span>${escapeHtml(h)}</span>
                      <span style="color:var(--accent);">${sortArrow}</span>
                    </th>
                  `;
                })
                .join('')}
            </tr>
          </thead>
          <tbody>
            ${
              rows.length === 0
                ? `<tr><td colspan="${headers.length + 1}" style="text-align:center; padding:28px; color:var(--text-tertiary);">没有匹配的数据行</td></tr>`
                : rows
                    .map((rowObj) => {
                      const rowNum = rowObj.row_num;
                      const cells = rowObj.cells || [];
                      return `
                        <tr data-excel-row="${rowNum}">
                          <td class="excel-row-num">${rowNum}</td>
                          ${headers
                            .map((_, colIdx) => {
                              const col1 = colIdx + 1;
                              const key = `${rowNum}:${col1}`;
                              const isPending = pending.has(key);
                              const val = isPending ? pending.get(key) : (cells[colIdx] ?? '');
                              const isSelected = sel && sel.row === rowNum && sel.col === col1;
                              const isEditing = ex.editingKey === key;
                              const pendingStyle = isPending ? 'background:var(--warning-soft);' : '';
                              return `
                                <td
                                  class="${isSelected ? 'excel-cell-selected' : ''}"
                                  style="${pendingStyle}"
                                  data-excel-row="${rowNum}"
                                  data-excel-col="${col1}"
                                  title="${escapeHtml(val)}"
                                >
                                  ${
                                    isEditing
                                      ? `<input type="text" class="excel-cell-input" data-editing-key="${key}" value="${escapeHtml(val)}" />`
                                      : escapeHtml(val)
                                  }
                                </td>
                              `;
                            })
                            .join('')}
                        </tr>
                      `;
                    })
                    .join('')
            }
          </tbody>
        </table>
      `;

    const wrap = containerEl.querySelector('[data-role="excel-table-wrap"]');
    if (wrap) {
      wrap.innerHTML = tableHtml;
    }

    const footer = containerEl.querySelector('[data-role="excel-footer"]');
    if (footer) {
      const countText =
        ex.filteredRows !== ex.totalRows
          ? `筛选 ${ex.filteredRows} / 共 ${ex.totalRows} 行`
          : `共 ${ex.totalRows} 行`;
      footer.innerHTML = `
        <span style="font-size:12px; color:var(--text-secondary);">
          ${countText} · 第 ${ex.page} / ${ex.totalPages} 页
        </span>
        <div style="display:flex; align-items:center; gap:6px;">
          <button type="button" class="pill-btn pill-btn-sm" data-action="excel-prev-page" ${ex.page <= 1 ? 'disabled' : ''}>
            上一页
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="excel-next-page" ${ex.page >= ex.totalPages ? 'disabled' : ''}>
            下一页
          </button>
        </div>
      `;
    }

    updateExcelToolbarIndicators();
  }

  function updateExcelToolbarIndicators() {
    const coordEl = containerEl.querySelector('[data-role="excel-coord"]');
    if (coordEl) {
      coordEl.textContent = getSelectedCoordLabel();
    }
    const copyAnchorBtn = containerEl.querySelector('[data-action="excel-copy-anchor"]');
    if (copyAnchorBtn) {
      copyAnchorBtn.disabled = !state.excel.selectedCell;
    }
    const saveBtn = containerEl.querySelector('[data-action="excel-save"]');
    if (saveBtn) {
      const count = state.excel.pendingChanges.size;
      saveBtn.disabled = count === 0 || state.saving;
      saveBtn.classList.toggle('pill-btn-primary', count > 0);
      saveBtn.innerHTML = `${icon('save', 13)} 保存修改 (${count})`;
    }
  }

  function renderExcelMode() {
    const doc = state.activeDoc;
    const ex = state.excel;
    const pendingCount = ex.pendingChanges.size;

    containerEl.innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          <span style="color:var(--success); display:inline-flex; align-items:center;">${icon('file-spreadsheet', 16)}</span>
          <span class="doc-title-pill" title="${escapeHtml(doc.path)}">${escapeHtml(doc.name)}</span>
          ${
            doc.isPrivate
              ? `<span class="lock-badge" title="隐私锁已开启（严禁发送外部 AI）">${icon('lock', 12)}</span>`
              : ''
          }
          <span
            data-role="excel-coord"
            style="font-family:var(--font-mono); font-size:12px; font-weight:600; padding:3px 9px; border-radius:var(--radius-pill); background:var(--accent-soft); color:var(--accent);"
          >${escapeHtml(getSelectedCoordLabel())}</span>
          <button type="button" class="pill-btn pill-btn-sm" data-action="excel-copy-anchor" ${!ex.selectedCell ? 'disabled' : ''} title="复制当前单元格跨格式锚点">
            ${icon('pin', 13)} 复制单元格锚点
          </button>
        </div>

        <div class="center-toolbar-group">
          <div style="position:relative; width:170px; max-width:100%;">
            <input
              type="search"
              class="apple-input"
              data-role="excel-search"
              placeholder="搜索当前工作表…"
              value="${escapeHtml(ex.q)}"
              style="height:30px; padding:4px 10px; font-size:12.5px;"
            />
          </div>
          <button type="button" class="pill-btn pill-btn-sm ${pendingCount > 0 ? 'pill-btn-primary' : ''}" data-action="excel-save" ${pendingCount === 0 ? 'disabled' : ''} title="提交修改 (Ctrl+S / Cmd+S)">
            ${icon('save', 13)} 保存修改 (${pendingCount})
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="excel-append-row">
            ${icon('plus', 13)} 追加行
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="excel-export-csv">
            ${icon('download', 13)} 导出 CSV
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="open-snapshots">
            ${icon('rotate-ccw', 13)} 快照回滚
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="ai-summarize" title="AI 分析当前工作表">
            ${icon('sparkles', 13)} AI 总结
          </button>
        </div>
      </div>

      <div class="excel-sheet-bar" role="tablist" aria-label="Excel 工作表">
        ${ex.sheets
          .map(
            (s) => `
          <button
            type="button"
            class="pill-btn pill-btn-sm ${s.name === ex.currentSheet ? 'pill-btn-primary' : ''}"
            data-action="excel-switch-sheet"
            data-sheet="${escapeHtml(s.name)}"
            role="tab"
            aria-selected="${s.name === ex.currentSheet}"
          >
            ${escapeHtml(s.name)}
          </button>
        `
          )
          .join('')}
      </div>

      <div class="excel-table-wrap" data-role="excel-table-wrap"></div>

      <div
        data-role="excel-footer"
        style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; padding:8px 14px; border-top:1px solid var(--border-hairline); background:var(--bg-glass); flex-shrink:0;"
      ></div>
    `;

    renderExcelTableSection();
  }

  async function loadExcelRows({ preservePending = false } = {}) {
    if (!state.activeDoc || state.activeDoc.type !== 'excel') return;
    const seq = ++state.excelSeq;
    const ex = state.excel;
    ex.loading = true;
    if (!preservePending) {
      ex.editingKey = null;
    }

    const params = new URLSearchParams({
      path: state.activeDoc.path,
      sheet: ex.currentSheet || '',
      page: String(ex.page),
      page_size: String(ex.pageSize),
      q: ex.q || '',
      sort_dir: ex.sortDir || 'asc',
    });
    if (ex.sortCol !== null && ex.sortCol >= 0) {
      const hdr = ex.headers[ex.sortCol];
      const useHeaderName = hdr && ex.headers.indexOf(hdr) === ex.sortCol;
      params.set('sort_col', useHeaderName ? hdr : String(ex.sortCol));
    }

    try {
      const data = await api.get(`/api/excel/rows?${params.toString()}`);
      if (seq !== state.excelSeq || !state.activeDoc || state.activeDoc.type !== 'excel') return;

      ex.currentSheet = data.sheet || ex.currentSheet;
      ex.headers = Array.isArray(data.headers) ? data.headers : [];
      ex.rows = Array.isArray(data.rows) ? data.rows : [];
      ex.totalRows = Number(data.total_rows || 0);
      ex.filteredRows = Number(data.filtered_rows ?? ex.totalRows);
      ex.page = Number(data.page || 1);
      ex.totalPages = Math.max(1, Number(data.total_pages || 1));
      ex.loading = false;

      syncActiveFileStore();
      renderExcelTableSection();
    } catch (err) {
      if (seq !== state.excelSeq) return;
      ex.loading = false;
      showToast(getErrorMsg(err, '读取表格数据失败'), 'error');
      renderExcelTableSection();
    }
  }

  function focusInlineInput(key) {
    window.requestAnimationFrame(() => {
      const inp = containerEl.querySelector(`input.excel-cell-input[data-editing-key="${CSS.escape(key)}"]`);
      if (inp) {
        inp.focus();
        inp.select();
      }
    });
  }

  function startExcelInlineEdit(rowNum, col1) {
    const ex = state.excel;
    const key = `${rowNum}:${col1}`;
    ex.selectedCell = { row: rowNum, col: col1, colLetter: colIndexToLetter(col1) };
    ex.editingKey = key;
    renderExcelTableSection();
    focusInlineInput(key);
  }

  function commitExcelInlineEdit(inp, cancel = false) {
    if (!inp || inp.dataset.committed === '1') return;
    inp.dataset.committed = '1';

    const key = inp.dataset.editingKey || '';
    const ex = state.excel;
    if (!key || ex.editingKey !== key) return;

    const [rowStr, colStr] = key.split(':');
    const rowNum = Number(rowStr);
    const col1 = Number(colStr);

    if (!cancel) {
      const newVal = inp.value;
      const rowObj = ex.rows.find((r) => r.row_num === rowNum);
      const origVal = rowObj ? String(rowObj.cells[col1 - 1] ?? '') : '';
      if (newVal !== origVal) {
        ex.pendingChanges.set(key, newVal);
      } else {
        ex.pendingChanges.delete(key);
      }
    }

    ex.editingKey = null;
    renderExcelTableSection();
  }

  async function saveExcelChanges() {
    if (!state.activeDoc || state.activeDoc.type !== 'excel') return;
    const ex = state.excel;
    if (ex.pendingChanges.size === 0) {
      showToast('当前表格暂无待保存的修改', 'info', { duration: 1800 });
      return false;
    }

    const changes = Array.from(ex.pendingChanges.entries()).map(([key, value]) => {
      const [row, col] = key.split(':').map(Number);
      return { row, col, value };
    });

    state.saving = true;
    updateExcelToolbarIndicators();
    try {
      const res = await api.patch('/api/excel/cells', {
        path: state.activeDoc.path,
        sheet: ex.currentSheet,
        changes,
      });
      ex.pendingChanges.clear();
      state.saving = false;
      await loadExcelRows();
      store.emit('file:saved', {
        path: state.activeDoc.path,
        sheet: ex.currentSheet,
        snapshot_id: res?.snapshot_id || null,
      });
      showToast(`已保存 ${res?.updated ?? changes.length} 处修改（已创建写前安全快照）`, 'success');
      return true;
    } catch (err) {
      state.saving = false;
      updateExcelToolbarIndicators();
      showToast(getErrorMsg(err, '保存表格修改失败'), 'error');
      return false;
    }
  }

  async function switchExcelSheet(nextSheet) {
    if (!nextSheet || nextSheet === state.excel.currentSheet) return;
    const doSwitch = async () => {
      state.excel.currentSheet = nextSheet;
      state.excel.page = 1;
      state.excel.sortCol = null;
      state.excel.sortDir = 'asc';
      state.excel.selectedCell = null;
      state.excel.pendingChanges.clear();
      state.excel.editingKey = null;
      renderExcelMode();
      await loadExcelRows();
    };

    if (state.excel.pendingChanges.size > 0) {
      const count = state.excel.pendingChanges.size;
      openSheet({
        title: '切换工作表确认',
        bodyHtml: `<p style="margin:0; color:var(--text-secondary);">当前工作表「${escapeHtml(state.excel.currentSheet)}」有 <strong>${count}</strong> 项未保存修改，切换将丢失这些修改。</p>`,
        footerHtml: `
          <button type="button" class="pill-btn" data-sheet-act="cancel">取消</button>
          <button type="button" class="pill-btn pill-btn-danger" data-sheet-act="discard">丢弃并切换</button>
          <button type="button" class="pill-btn pill-btn-primary" data-sheet-act="save">保存并切换</button>
        `,
        onMount(card) {
          card.querySelector('[data-sheet-act="cancel"]')?.addEventListener('click', closeSheet);
          card.querySelector('[data-sheet-act="discard"]')?.addEventListener('click', () => {
            closeSheet();
            doSwitch();
          });
          card.querySelector('[data-sheet-act="save"]')?.addEventListener('click', async () => {
            const ok = await saveExcelChanges();
            if (ok) {
              closeSheet();
              await doSwitch();
            }
          });
        },
      });
      return;
    }

    await doSwitch();
  }

  function openAppendRowSheet() {
    if (!state.activeDoc || state.activeDoc.type !== 'excel') return;
    const headers = state.excel.headers || [];
    if (headers.length === 0) {
      showToast('当前工作表暂无表头列', 'warning');
      return;
    }

    openSheet({
      title: `追加行 · ${state.excel.currentSheet}`,
      bodyHtml: `
        <form id="excel-append-form" style="display:flex; flex-direction:column; gap:10px;">
          ${headers
            .map(
              (h, idx) => `
            <div>
              <label style="display:block; font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:4px;">
                <span style="font-family:var(--font-mono); color:var(--text-tertiary);">${colIndexToLetter(idx + 1)}</span> · ${escapeHtml(h)}
              </label>
              <input type="text" class="apple-input" data-col-idx="${idx}" placeholder="输入 ${escapeHtml(h)}…" />
            </div>
          `
            )
            .join('')}
        </form>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="append-cancel">取消</button>
        <button type="button" class="pill-btn pill-btn-primary" id="append-submit">确认追加</button>
      `,
      onMount(card) {
        card.querySelector('#append-cancel')?.addEventListener('click', closeSheet);
        const submitBtn = card.querySelector('#append-submit');
        const doSubmit = async () => {
          const inputs = Array.from(card.querySelectorAll('#excel-append-form input[data-col-idx]'));
          const rowValues = inputs.map((inp) => inp.value);
          if (rowValues.every((v) => v.trim() === '')) {
            showToast('请至少填写一个单元格内容', 'warning');
            return;
          }
          if (submitBtn) submitBtn.disabled = true;
          try {
            const res = await api.post('/api/excel/append-rows', {
              path: state.activeDoc.path,
              sheet: state.excel.currentSheet,
              rows: [rowValues],
            });
            closeSheet();
            const newTotal = Number(res?.new_total_rows || state.excel.totalRows + 1);
            state.excel.q = '';
            state.excel.sortCol = null;
            state.excel.page = Math.max(1, Math.ceil(newTotal / state.excel.pageSize));
            renderExcelMode();
            await loadExcelRows();
            store.emit('file:saved', {
              path: state.activeDoc.path,
              sheet: state.excel.currentSheet,
              snapshot_id: res?.snapshot_id || null,
            });
            showToast('已追加新行并创建安全快照', 'success');
          } catch (err) {
            if (submitBtn) submitBtn.disabled = false;
            showToast(getErrorMsg(err, '追加行失败'), 'error');
          }
        };
        submitBtn?.addEventListener('click', doSubmit);
        card.querySelector('#excel-append-form')?.addEventListener('submit', (e) => {
          e.preventDefault();
          doSubmit();
        });
        card.querySelector('#excel-append-form input')?.focus();
      },
    });
  }

  function highlightExcelCell(row, col, sheetName) {
    const td = containerEl.querySelector(`td[data-excel-row="${row}"][data-excel-col="${col}"]`);
    if (td) {
      state.excel.selectedCell = { row, col, colLetter: colIndexToLetter(col) };
      containerEl.querySelectorAll('td.excel-cell-selected').forEach((el) => el.classList.remove('excel-cell-selected'));
      td.classList.add('excel-cell-selected');
      updateExcelToolbarIndicators();

      td.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      td.classList.remove('cell-anchor-pulse');
      void td.offsetWidth;
      td.classList.add('cell-anchor-pulse');
      return true;
    }

    if (row === 1) {
      const th = containerEl.querySelector(`th[data-sort-col="${col - 1}"]`);
      if (th) {
        th.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        th.classList.remove('cell-anchor-pulse');
        void th.offsetWidth;
        th.classList.add('cell-anchor-pulse');
        return true;
      }
    }

    showToast(`目标单元格 ${sheetName}!${colIndexToLetter(col)}${row} 超出当前数据范围`, 'warning');
    return false;
  }

  // =========================================================================
  // Rendering: PDF Native Preview + Companion Markdown Note Mode
  // =========================================================================
  function buildPdfStreamSrc() {
    const p = encodeURIComponent(state.activeDoc.path);
    return `/api/files/pdf-stream?path=${p}&_t=${state.pdf.cacheBust}#page=${state.pdf.currentPage}`;
  }

  function updatePdfFrameAndControls() {
    const doc = state.activeDoc;
    if (!doc || doc.type !== 'pdf') return;
    const iframe = containerEl.querySelector('.pdf-frame');
    if (iframe) {
      state.pdf.cacheBust = Date.now();
      iframe.src = buildPdfStreamSrc();
    }
    const pagePill = containerEl.querySelector('[data-role="pdf-page-label"]');
    if (pagePill) {
      pagePill.textContent = `第 ${state.pdf.currentPage} / ${state.pdf.totalPages} 页`;
    }
    const pageInput = containerEl.querySelector('[data-role="pdf-page-input"]');
    if (pageInput) {
      pageInput.value = String(state.pdf.currentPage);
    }
  }

  function updatePdfCompanionDirtyIndicators() {
    const dot = containerEl.querySelector('[data-role="pdf-companion-dirty"]');
    if (dot) {
      dot.style.display = state.pdf.companionDirty ? 'inline-block' : 'none';
    }
    const saveBtn = containerEl.querySelector('[data-action="pdf-save-companion"]');
    if (saveBtn) {
      saveBtn.classList.toggle('pill-btn-primary', Boolean(state.pdf.companionDirty));
    }
  }

  function renderPdfMode() {
    const doc = state.activeDoc;
    const pdf = state.pdf;
    const isCompPreview = pdf.companionMode === 'preview';

    containerEl.innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          <span style="color:var(--danger); display:inline-flex; align-items:center;">${icon('file-pdf', 16)}</span>
          <span class="doc-title-pill" title="${escapeHtml(doc.path)}">${escapeHtml(doc.name)}</span>
          ${
            doc.isPrivate
              ? `<span class="lock-badge" title="隐私锁已开启（严禁发送外部 AI）">${icon('lock', 12)}</span>`
              : ''
          }
          <span
            data-role="pdf-page-label"
            style="font-size:12px; font-weight:600; padding:3px 10px; border-radius:var(--radius-pill); background:var(--bg-subtle); color:var(--text-secondary);"
          >第 ${pdf.currentPage} / ${pdf.totalPages} 页</span>
          <div style="display:inline-flex; align-items:center; gap:4px;">
            <input
              type="number"
              class="apple-input"
              data-role="pdf-page-input"
              min="1"
              max="${pdf.totalPages}"
              value="${pdf.currentPage}"
              aria-label="跳转页码"
              style="width:66px; height:28px; padding:2px 8px; font-size:12px; text-align:center;"
            />
            <button type="button" class="pill-btn pill-btn-sm" data-action="pdf-jump-page">跳转</button>
          </div>
        </div>

        <div class="center-toolbar-group">
          <button type="button" class="pill-btn pill-btn-sm" data-action="pdf-copy-anchor" title="复制当前页码锚点">
            ${icon('pin', 13)} 复制页码锚点
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="pdf-annotate">
            ${icon('plus', 13)} 写入 PDF 批注
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="open-snapshots">
            ${icon('rotate-ccw', 13)} 快照
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="ai-summarize">
            ${icon('sparkles', 13)} AI 总结
          </button>
        </div>
      </div>

      <div style="flex:1 1 auto; min-height:0; min-width:0; overflow:hidden;">
        <div class="pdf-workspace">
          <div class="pdf-frame-wrap">
            <iframe class="pdf-frame" src="${buildPdfStreamSrc()}" title="${escapeHtml(doc.name)}"></iframe>
          </div>

          <div class="pdf-side-notes">
            <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px; flex-shrink:0;">
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-size:13px; font-weight:600; color:var(--text-primary);">伴生笔记</span>
                <span
                  data-role="pdf-companion-dirty"
                  title="伴生笔记有未保存修改"
                  style="width:7px; height:7px; border-radius:9999px; background:var(--warning); display:${pdf.companionDirty ? 'inline-block' : 'none'};"
                ></span>
              </div>

              <div class="segmented-pill" data-seg="pdf-companion-mode" role="tablist" aria-label="伴生笔记模式">
                <div class="segmented-thumb" style="width:calc(50% - 3px); transform:translateX(${isCompPreview ? '100%' : '0%'});"></div>
                <button type="button" class="segmented-btn ${!isCompPreview ? 'is-active' : ''}" data-comp-mode="edit" role="tab" aria-selected="${!isCompPreview}">
                  编辑
                </button>
                <button type="button" class="segmented-btn ${isCompPreview ? 'is-active' : ''}" data-comp-mode="preview" role="tab" aria-selected="${isCompPreview}">
                  预览
                </button>
              </div>
            </div>

            <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px; flex-shrink:0;">
              <button type="button" class="pill-btn pill-btn-sm" data-action="pdf-insert-anchor">
                ${icon('pin', 12)} 插入当前页锚点
              </button>
              <button type="button" class="pill-btn pill-btn-sm ${pdf.companionDirty ? 'pill-btn-primary' : ''}" data-action="pdf-save-companion">
                ${icon('save', 12)} 保存
              </button>
            </div>

            <div style="flex:1 1 auto; min-height:0; display:flex; flex-direction:column;">
              ${
                isCompPreview
                  ? `<div class="md-preview" style="padding:8px 4px; flex:1 1 auto; overflow-y:auto;">${renderMarkdownSafe(doc.companionContent || '')}</div>`
                  : `<textarea class="md-editor" data-role="pdf-companion-editor" spellcheck="false" style="min-height:160px; flex:1 1 auto; padding:12px; border:1px solid var(--border-hairline); border-radius:var(--radius-control); background:var(--bg-subtle);" placeholder="边看 PDF 边记笔记，支持 [[${escapeHtml(doc.name)}#page=${pdf.currentPage}]] 锚点...">${escapeHtml(doc.companionContent || '')}</textarea>`
              }
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function openPdfAnnotateSheet() {
    if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
    const doc = state.activeDoc;
    openSheet({
      title: `写入 PDF 批注 · ${doc.name}`,
      bodyHtml: `
        <form id="pdf-annot-form" style="display:flex; flex-direction:column; gap:10px;">
          <div>
            <label style="display:block; font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:4px;">目标页码（共 ${state.pdf.totalPages} 页）</label>
            <input type="number" class="apple-input" id="pdf-annot-page" min="1" max="${state.pdf.totalPages}" value="${state.pdf.currentPage}" />
          </div>
          <div>
            <label style="display:block; font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:4px;">批注内容</label>
            <textarea class="apple-textarea" id="pdf-annot-text" rows="4" placeholder="输入需要永久写入 PDF 页面批注层的文字…"></textarea>
          </div>
        </form>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="pdf-annot-cancel">取消</button>
        <button type="button" class="pill-btn pill-btn-primary" id="pdf-annot-submit">写入批注</button>
      `,
      onMount(card) {
        card.querySelector('#pdf-annot-cancel')?.addEventListener('click', closeSheet);
        const submitBtn = card.querySelector('#pdf-annot-submit');
        const doAnnotate = async () => {
          const pageVal = Number.parseInt(card.querySelector('#pdf-annot-page')?.value, 10) || state.pdf.currentPage;
          const noteText = card.querySelector('#pdf-annot-text')?.value?.trim() || '';
          if (!noteText) {
            showToast('请输入批注内容', 'warning');
            return;
          }
          if (submitBtn) submitBtn.disabled = true;
          try {
            const res = await api.post('/api/files/pdf-annotate', {
              path: doc.path,
              page: Math.min(Math.max(1, pageVal), state.pdf.totalPages),
              note_text: noteText,
            });
            state.pdf.currentPage = Number(res?.page || pageVal);
            closeSheet();
            updatePdfFrameAndControls();
            store.emit('file:saved', { path: doc.path, page: state.pdf.currentPage, snapshot_id: res?.snapshot_id || null });
            showToast(`已写入第 ${state.pdf.currentPage} 页批注并创建安全快照`, 'success');
          } catch (err) {
            if (submitBtn) submitBtn.disabled = false;
            showToast(getErrorMsg(err, '写入 PDF 批注失败'), 'error');
          }
        };
        submitBtn?.addEventListener('click', doAnnotate);
        card.querySelector('#pdf-annot-text')?.focus();
      },
    });
  }

  // =========================================================================
  // Shared Operations: Open, Save, Snapshots, New Note
  // =========================================================================
  function renderActiveView() {
    if (!state.activeDoc) {
      renderWelcome();
      return;
    }
    if (state.activeDoc.type === 'excel') {
      renderExcelMode();
    } else if (state.activeDoc.type === 'pdf') {
      renderPdfMode();
    } else {
      renderMarkdownMode();
    }
  }

  async function openFile(pathStr, opts = {}) {
    const targetPath = String(pathStr || '').trim();
    if (!targetPath) return null;

    const seq = ++state.openSeq;
    state.loading = true;
    renderLoading(`正在打开 ${getBaseName(targetPath)}…`);

    try {
      const data = await api.get(`/api/files/read?path=${encodeURIComponent(targetPath)}`);
      if (seq !== state.openSeq) return null;

      const ext = String(data.ext || getExtLower(data.path || targetPath)).toLowerCase();
      const type = data.type || (ext === '.pdf' ? 'pdf' : ext === '.xlsx' ? 'excel' : ext === '.txt' ? 'text' : 'markdown');

      state.activeDoc = {
        type,
        path: data.path || targetPath,
        name: data.name || getBaseName(targetPath),
        ext,
        isPrivate: Boolean(data.is_private),
        content: data.content ?? '',
        snapshots: Array.isArray(data.snapshots) ? data.snapshots : [],
        pageCount: Number(data.page_count || 1),
        companionPath: data.companion_path || '',
        companionContent: data.companion_content ?? '',
        companionExists: Boolean(data.companion_exists),
      };
      state.dirty = false;
      state.loading = false;
      state.hasOpenedOnce = true;

      if (type === 'markdown' || type === 'text') {
        if (opts.mode === 'edit' || opts.mode === 'preview') {
          state.mdMode = opts.mode;
        } else {
          state.mdMode = (state.activeDoc.content || '').trim() ? 'preview' : 'edit';
        }
        syncActiveFileStore();
        renderMarkdownMode();
        ensureDocTabOnMobile();
        return state.activeDoc;
      }

      if (type === 'pdf') {
        const total = Math.max(1, Number(data.page_count || 1));
        const initPage = opts.initialPage ? Math.min(Math.max(1, Number(opts.initialPage)), total) : 1;
        state.pdf = {
          currentPage: initPage,
          totalPages: total,
          companionMode: 'edit',
          companionDirty: false,
          cacheBust: Date.now(),
        };
        syncActiveFileStore();
        renderPdfMode();
        ensureDocTabOnMobile();
        return state.activeDoc;
      }

      if (type === 'excel') {
        const sheetsRes = await api.get(`/api/excel/sheets?path=${encodeURIComponent(state.activeDoc.path)}`);
        if (seq !== state.openSeq) return null;

        const sheets = Array.isArray(sheetsRes?.sheets) ? sheetsRes.sheets : [];
        const targetSheet =
          opts.sheet && sheets.some((s) => s.name === opts.sheet)
            ? opts.sheet
            : sheets[0]?.name || '';

        state.excel = {
          sheets,
          currentSheet: targetSheet,
          headers: [],
          rows: [],
          totalRows: 0,
          filteredRows: 0,
          page: Math.max(1, Number(opts.page || 1)),
          pageSize: 100,
          totalPages: 1,
          q: '',
          sortCol: null,
          sortDir: 'asc',
          selectedCell: null,
          pendingChanges: new Map(),
          loading: false,
          editingKey: null,
        };

        syncActiveFileStore();
        renderExcelMode();
        await loadExcelRows();
        ensureDocTabOnMobile();
        return state.activeDoc;
      }

      renderActiveView();
      return state.activeDoc;
    } catch (err) {
      if (seq !== state.openSeq) return null;
      state.loading = false;
      showToast(getErrorMsg(err, '读取文档失败'), 'error');
      renderActiveView();
      return null;
    }
  }

  async function saveMarkdownDoc() {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
    if (state.saving) return;

    state.saving = true;
    try {
      const res = await api.put('/api/files/write', {
        path: doc.path,
        content: doc.content ?? '',
      });
      state.dirty = false;
      state.saving = false;
      updateMdDirtyIndicators();
      store.emit('file:saved', { path: doc.path, snapshot_id: res?.snapshot_id || null });
      showToast(
        res?.snapshot_id ? '已安全保存（自动创建写前快照）' : '已安全保存至本地磁盘',
        'success'
      );
    } catch (err) {
      state.saving = false;
      showToast(getErrorMsg(err, '保存文档失败'), 'error');
    }
  }

  async function savePdfCompanionNote() {
    const doc = state.activeDoc;
    if (!doc || doc.type !== 'pdf' || !doc.companionPath) return;
    if (state.saving) return;

    state.saving = true;
    try {
      const res = await api.put('/api/files/write', {
        path: doc.companionPath,
        content: doc.companionContent ?? '',
      });
      state.pdf.companionDirty = false;
      doc.companionExists = true;
      state.saving = false;
      updatePdfCompanionDirtyIndicators();
      store.emit('file:saved', { path: doc.companionPath, snapshot_id: res?.snapshot_id || null });
      showToast('PDF 伴生笔记已安全保存', 'success');
    } catch (err) {
      state.saving = false;
      showToast(getErrorMsg(err, '保存伴生笔记失败'), 'error');
    }
  }

  async function openSnapshotsSheet() {
    const doc = state.activeDoc;
    if (!doc) return;

    openSheet({
      title: `历史安全快照 · ${doc.name}`,
      bodyHtml: `<div class="empty-state"><p class="empty-title">正在读取快照历史…</p></div>`,
      footerHtml: `<button type="button" class="pill-btn" id="snap-close">关闭</button>`,
      async onMount(card) {
        card.querySelector('#snap-close')?.addEventListener('click', closeSheet);
        const bodyEl = card.querySelector('.sheet-body');
        try {
          const list = await api.get(`/api/files/snapshots?path=${encodeURIComponent(doc.path)}`);
          if (!Array.isArray(list) || list.length === 0) {
            if (bodyEl) {
              bodyEl.innerHTML = `
                <div class="empty-state">
                  <p class="empty-title">暂无写前快照</p>
                  <p class="empty-desc">每次保存修改时系统都会自动创建一份可回滚的安全备份（最多保留 15 份）。</p>
                </div>
              `;
            }
            return;
          }

          if (bodyEl) {
            bodyEl.innerHTML = `
              <div style="display:flex; flex-direction:column; gap:8px;">
                ${list
                  .map(
                    (snap) => `
                  <div class="glass-card" style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                    <div style="min-width:0;">
                      <div style="font-size:13px; font-weight:600; font-family:var(--font-mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(snap.id || snap.filename)}</div>
                      <div style="font-size:11.5px; color:var(--text-secondary);">${escapeHtml(formatSnapTime(snap.created_at))} · ${formatBytes(snap.size)}</div>
                    </div>
                    <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-restore-snap="${escapeHtml(snap.id)}">
                      ${icon('rotate-ccw', 12)} 回滚
                    </button>
                  </div>
                `
                  )
                  .join('')}
              </div>
            `;

            bodyEl.addEventListener('click', async (e) => {
              const btn = e.target.closest('[data-restore-snap]');
              if (!btn) return;
              const snapId = btn.dataset.restoreSnap;
              btn.disabled = true;
              try {
                await api.post('/api/files/snapshots', {
                  path: doc.path,
                  snapshot_id: snapId,
                });
                closeSheet();
                await openFile(doc.path, {
                  sheet: doc.type === 'excel' ? state.excel.currentSheet : undefined,
                  page: doc.type === 'excel' ? state.excel.page : undefined,
                  initialPage: doc.type === 'pdf' ? state.pdf.currentPage : undefined,
                });
                store.emit('file:saved', { path: doc.path, restored_from: snapId });
                showToast(`已成功回滚至快照 ${snapId}`, 'success');
              } catch (err) {
                btn.disabled = false;
                showToast(getErrorMsg(err, '快照回滚失败'), 'error');
              }
            });
          }
        } catch (err) {
          if (bodyEl) {
            bodyEl.innerHTML = `<div class="empty-state"><p class="empty-title">加载快照失败</p><p class="empty-desc">${escapeHtml(getErrorMsg(err))}</p></div>`;
          }
        }
      },
    });
  }

  function openNewNoteSheet() {
    openSheet({
      title: '新建本地 Markdown 笔记',
      bodyHtml: `
        <form id="center-new-note-form" style="display:flex; flex-direction:column; gap:10px;">
          <div>
            <label style="display:block; font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:4px;">笔记标题</label>
            <input type="text" class="apple-input" id="center-new-note-title" placeholder="例如：线性代数特征值复盘" />
          </div>
          <div>
            <label style="display:block; font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:4px;">初始正文（可选）</label>
            <textarea class="apple-textarea" id="center-new-note-body" rows="4" placeholder="支持 Markdown 与 [[文件名.pdf#page=1]] 锚点…"></textarea>
          </div>
        </form>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="center-new-note-cancel">取消</button>
        <button type="button" class="pill-btn pill-btn-primary" id="center-new-note-create">创建并打开</button>
      `,
      onMount(card) {
        card.querySelector('#center-new-note-cancel')?.addEventListener('click', closeSheet);
        const submitBtn = card.querySelector('#center-new-note-create');
        const doCreate = async () => {
          const title = card.querySelector('#center-new-note-title')?.value?.trim() || '未命名笔记';
          const content = card.querySelector('#center-new-note-body')?.value || '';
          if (submitBtn) submitBtn.disabled = true;
          try {
            const created = await api.post('/api/files/create-note', { title, content });
            closeSheet();
            try {
              const filesData = await api.get('/api/files/list');
              store.setState({ files: filesData });
              store.emit('files:updated', filesData);
            } catch {
              // ignore refresh error
            }
            if (created?.path) {
              await openFile(created.path, { mode: 'edit' });
            }
            showToast(`已创建笔记：${created?.name || title}`, 'success');
          } catch (err) {
            if (submitBtn) submitBtn.disabled = false;
            showToast(getErrorMsg(err, '创建笔记失败'), 'error');
          }
        };
        submitBtn?.addEventListener('click', doCreate);
        card.querySelector('#center-new-note-form')?.addEventListener('submit', (e) => {
          e.preventDefault();
          doCreate();
        });
        card.querySelector('#center-new-note-title')?.focus();
      },
    });
  }

  // =========================================================================
  // EventBus Subscriptions (STRICT decoupling)
  // =========================================================================
  store.on('files:updated', (filesData) => {
    const items = filesData?.items || store.state.files?.items || [];
    if (state.activeDoc) {
      const current = items.find((f) => isSamePath(f.path, state.activeDoc.path));
      if (current) {
        const nextPriv = Boolean(current.is_private);
        if (nextPriv !== state.activeDoc.isPrivate) {
          state.activeDoc.isPrivate = nextPriv;
          syncActiveFileStore();
          renderActiveView();
        }
      }
      return;
    }

    if (!state.hasOpenedOnce && !state.loading && items.length > 0) {
      const firstMd = items.find(
        (f) => String(f.ext || '').toLowerCase() === '.md' || String(f.name || '').toLowerCase().endsWith('.md')
      );
      if (firstMd?.path) {
        openFile(firstMd.path);
      } else {
        renderWelcome();
      }
    } else if (!state.activeDoc && !state.loading) {
      renderWelcome();
    }
  });

  store.on('file:open', (payload) => {
    const path = typeof payload === 'string' ? payload : payload?.path;
    if (!path) return;
    openFile(path, typeof payload === 'object' ? payload : {});
  });

  store.on('file:refresh-excel', async (payload = {}) => {
    if (!state.activeDoc || state.activeDoc.type !== 'excel') return;
    if (payload.path && !isSamePath(payload.path, state.activeDoc.path)) return;
    try {
      const sheetsRes = await api.get(`/api/excel/sheets?path=${encodeURIComponent(state.activeDoc.path)}`);
      if (Array.isArray(sheetsRes?.sheets)) {
        state.excel.sheets = sheetsRes.sheets;
      }
    } catch {
      // continue with row reload
    }
    await loadExcelRows({ preservePending: true });
  });

  store.on('doc:append', async ({ content, path } = {}) => {
    const textToAppend = String(content ?? '').trim();
    if (!textToAppend) return;

    const doc = state.activeDoc;
    if (!doc) {
      showToast('请先打开一篇笔记或 PDF 伴生笔记后再追加内容', 'warning');
      return;
    }

    if (doc.type === 'markdown' || doc.type === 'text') {
      if (path && !isSamePath(path, doc.path)) {
        showToast('目标追加路径与当前打开文档不一致', 'warning');
        return;
      }
      const prev = doc.content || '';
      const sep = !prev.trim() ? '' : prev.endsWith('\n\n') ? '' : prev.endsWith('\n') ? '\n' : '\n\n';
      const nextContent = `${prev}${sep}${textToAppend}\n`;

      try {
        const res = await api.put('/api/files/write', { path: doc.path, content: nextContent });
        doc.content = nextContent;
        state.dirty = false;
        syncActiveFileStore();
        renderMarkdownMode();
        store.emit('file:saved', { path: doc.path, snapshot_id: res?.snapshot_id || null });
        showToast(`已追加并保存至 ${doc.name}`, 'success');
      } catch (err) {
        showToast(getErrorMsg(err, '追加保存失败'), 'error');
      }
      return;
    }

    if (doc.type === 'pdf' && doc.companionPath) {
      const prev = doc.companionContent || '';
      const sep = !prev.trim() ? '' : prev.endsWith('\n\n') ? '' : prev.endsWith('\n') ? '\n' : '\n\n';
      const nextContent = `${prev}${sep}${textToAppend}\n`;

      try {
        const res = await api.put('/api/files/write', { path: doc.companionPath, content: nextContent });
        doc.companionContent = nextContent;
        doc.companionExists = true;
        state.pdf.companionDirty = false;
        syncActiveFileStore();
        renderPdfMode();
        store.emit('file:saved', { path: doc.companionPath, snapshot_id: res?.snapshot_id || null });
        showToast(`已追加并保存至 ${doc.name} 伴生笔记`, 'success');
      } catch (err) {
        showToast(getErrorMsg(err, '追加保存伴生笔记失败'), 'error');
      }
      return;
    }

    showToast('当前打开的是表格文件，请切换至笔记或 PDF 伴生笔记后追加', 'warning');
  });

  // Innovation 2: Cross-Format Atomic Anchor Jump
  store.on('anchor:jump', async (payload = {}) => {
    const rawFile = String(payload.file || '').trim();
    if (!rawFile) return;

    ensureDocTabOnMobile();

    let targetItem = findWorkspaceFile(rawFile);
    if (!targetItem) {
      try {
        const filesData = await api.get('/api/files/list');
        if (filesData) {
          store.setState({ files: filesData });
          store.emit('files:updated', filesData);
          targetItem = findWorkspaceFile(rawFile);
        }
      } catch {
        // ignore list refresh failure
      }
    }

    if (!targetItem) {
      showToast(`未在工作区找到目标文件：${rawFile}`, 'warning');
      return;
    }

    // Case 1: PDF Page Anchor
    if (payload.page) {
      const targetPage = Math.max(1, Number.parseInt(payload.page, 10) || 1);
      const isAlreadyOpen = state.activeDoc?.type === 'pdf' && isSamePath(state.activeDoc.path, targetItem.path);
      if (!isAlreadyOpen) {
        const opened = await openFile(targetItem.path, { initialPage: targetPage });
        if (!opened) return;
      } else {
        const clamped = Math.min(targetPage, state.pdf.totalPages || targetPage);
        state.pdf.currentPage = clamped;
        updatePdfFrameAndControls();
      }
      showToast(`已精准跳转至 ${targetItem.name} 第 ${state.pdf.currentPage} 页`, 'success');
      return;
    }

    // Case 2: Excel Cell Anchor
    if (payload.cell) {
      const ref = parseExcelCellRef(payload.cell);
      if (!ref) {
        showToast(`无效的单元格坐标：${payload.cell}`, 'warning');
        return;
      }

      const targetPage = Math.max(1, Math.ceil(Math.max(1, ref.row - 1) / state.excel.pageSize));
      const isAlreadyOpen = state.activeDoc?.type === 'excel' && isSamePath(state.activeDoc.path, targetItem.path);

      if (!isAlreadyOpen) {
        const opened = await openFile(targetItem.path, {
          sheet: payload.sheet || '',
          page: targetPage,
        });
        if (!opened) return;
      } else {
        const sheets = state.excel.sheets || [];
        const wantedSheet =
          payload.sheet && sheets.some((s) => s.name === payload.sheet)
            ? payload.sheet
            : payload.sheet || state.excel.currentSheet || sheets[0]?.name || '';

        state.excel.currentSheet = wantedSheet;
        state.excel.q = '';
        state.excel.sortCol = null;
        state.excel.sortDir = 'asc';
        state.excel.page = targetPage;
        state.excel.editingKey = null;

        renderExcelMode();
        await loadExcelRows({ preservePending: true });
      }

      const finalSheet = state.excel.currentSheet || payload.sheet || 'Sheet1';
      window.requestAnimationFrame(() => {
        if (highlightExcelCell(ref.row, ref.col, finalSheet)) {
          showToast(`已精准定位至 ${targetItem.name} · ${finalSheet}!${ref.colLetter}${ref.row}`, 'success');
        }
      });
      return;
    }

    // Fallback: open file directly
    await openFile(targetItem.path);
  });

  // =========================================================================
  // DOM Event Delegation on containerEl & Ctrl+S / Cmd+S Shortcut
  // =========================================================================
  containerEl.addEventListener('input', (e) => {
    const target = e.target;

    // Markdown / TXT editor
    if (target.matches('.md-editor') && !target.dataset.role) {
      if (!state.activeDoc) return;
      state.activeDoc.content = target.value;
      state.dirty = true;
      store.state.activeDocumentText = target.value;
      updateMdDirtyIndicators();
      return;
    }

    // PDF Companion Note editor
    if (target.matches('[data-role="pdf-companion-editor"]')) {
      if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
      state.activeDoc.companionContent = target.value;
      state.pdf.companionDirty = true;
      store.state.activeDocumentText = target.value;
      updatePdfCompanionDirtyIndicators();
      return;
    }

    // Excel debounced live search (250ms)
    if (target.matches('[data-role="excel-search"]')) {
      const nextQ = target.value;
      if (state.excelSearchTimer) {
        window.clearTimeout(state.excelSearchTimer);
      }
      state.excelSearchTimer = window.setTimeout(() => {
        state.excel.q = nextQ;
        state.excel.page = 1;
        loadExcelRows({ preservePending: true });
      }, 250);
    }
  });

  containerEl.addEventListener('click', (e) => {
    // 1. Anchor pill click in MD preview or PDF companion preview
    const anchorPill = e.target.closest('.anchor-pill');
    if (anchorPill) {
      store.emit('anchor:jump', {
        file: anchorPill.dataset.anchorFile || '',
        page: anchorPill.dataset.anchorPage || '',
        sheet: anchorPill.dataset.anchorSheet || '',
        cell: anchorPill.dataset.anchorCell || '',
      });
      return;
    }

    // 2. Markdown Edit / Preview segmented pill
    const mdSegBtn = e.target.closest('[data-md-mode]');
    if (mdSegBtn && state.activeDoc) {
      const nextMode = mdSegBtn.dataset.mdMode === 'edit' ? 'edit' : 'preview';
      if (nextMode !== state.mdMode) {
        state.mdMode = nextMode;
        renderMarkdownMode();
        if (nextMode === 'edit') {
          containerEl.querySelector('.md-editor')?.focus();
        }
      }
      return;
    }

    // 3. PDF Companion Edit / Preview segmented pill
    const compSegBtn = e.target.closest('[data-comp-mode]');
    if (compSegBtn && state.activeDoc?.type === 'pdf') {
      const nextMode = compSegBtn.dataset.compMode === 'preview' ? 'preview' : 'edit';
      if (nextMode !== state.pdf.companionMode) {
        state.pdf.companionMode = nextMode;
        renderPdfMode();
        if (nextMode === 'edit') {
          containerEl.querySelector('[data-role="pdf-companion-editor"]')?.focus();
        }
      }
      return;
    }

    // 4. Excel header sort click
    const sortTh = e.target.closest('th[data-sort-col]');
    if (sortTh && state.activeDoc?.type === 'excel') {
      const colIdx = Number(sortTh.dataset.sortCol);
      if (Number.isFinite(colIdx)) {
        if (state.excel.sortCol === colIdx) {
          state.excel.sortDir = state.excel.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.excel.sortCol = colIdx;
          state.excel.sortDir = 'asc';
        }
        state.excel.page = 1;
        loadExcelRows({ preservePending: true });
      }
      return;
    }

    // 5. Excel cell click (select or inline edit if already selected)
    const td = e.target.closest('td[data-excel-row][data-excel-col]');
    if (td && state.activeDoc?.type === 'excel') {
      if (e.target.closest('input.excel-cell-input')) return;
      const rowNum = Number(td.dataset.excelRow);
      const col1 = Number(td.dataset.excelCol);
      const sel = state.excel.selectedCell;

      if (sel && sel.row === rowNum && sel.col === col1) {
        startExcelInlineEdit(rowNum, col1);
      } else {
        state.excel.selectedCell = { row: rowNum, col: col1, colLetter: colIndexToLetter(col1) };
        containerEl.querySelectorAll('td.excel-cell-selected').forEach((el) => el.classList.remove('excel-cell-selected'));
        td.classList.add('excel-cell-selected');
        updateExcelToolbarIndicators();
      }
      return;
    }

    // 6. Toolbar & Action Buttons
    const actionBtn = e.target.closest('[data-action]');
    if (!actionBtn) return;
    const action = actionBtn.dataset.action;

    if (action === 'welcome-new-note') {
      openNewNoteSheet();
    } else if (action === 'welcome-ai-summary') {
      store.emit('ai:summarize-request', {
        text: store.state.activeDocumentText || '',
        file_path: state.activeDoc?.path || '',
      });
    } else if (action === 'quick-open') {
      const p = actionBtn.dataset.path;
      if (p) openFile(p);
    } else if (action === 'md-save') {
      saveMarkdownDoc();
    } else if (action === 'open-snapshots') {
      openSnapshotsSheet();
    } else if (action === 'ai-summarize') {
      if (!state.activeDoc) return;
      const text =
        state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text'
          ? state.activeDoc.content
          : state.activeDoc.type === 'pdf'
          ? state.activeDoc.companionContent
          : buildExcelSummaryText();
      store.emit('ai:summarize-request', {
        text: text || '',
        file_path: state.activeDoc.path,
      });
    } else if (action === 'excel-switch-sheet') {
      switchExcelSheet(actionBtn.dataset.sheet);
    } else if (action === 'excel-copy-anchor') {
      const sel = state.excel.selectedCell;
      if (!sel || !state.activeDoc) {
        showToast('请先点击选择一个单元格', 'warning');
        return;
      }
      const anchor = `[[${state.activeDoc.name}#${state.excel.currentSheet}!${sel.colLetter}${sel.row}]]`;
      copyInternal(anchor, '已复制单元格锚点');
    } else if (action === 'excel-save') {
      saveExcelChanges();
    } else if (action === 'excel-append-row') {
      openAppendRowSheet();
    } else if (action === 'excel-export-csv') {
      if (!state.activeDoc) return;
      const url = `/api/excel/export-csv?path=${encodeURIComponent(state.activeDoc.path)}&sheet=${encodeURIComponent(state.excel.currentSheet)}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `${state.activeDoc.name.replace(/\.xlsx$/i, '')}_${state.excel.currentSheet}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('正在导出 CSV 文件…', 'info', { duration: 2000 });
    } else if (action === 'excel-prev-page') {
      if (state.excel.page > 1) {
        state.excel.page -= 1;
        loadExcelRows({ preservePending: true });
      }
    } else if (action === 'excel-next-page') {
      if (state.excel.page < state.excel.totalPages) {
        state.excel.page += 1;
        loadExcelRows({ preservePending: true });
      }
    } else if (action === 'pdf-jump-page') {
      if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
      const inp = containerEl.querySelector('[data-role="pdf-page-input"]');
      const raw = Number.parseInt(inp?.value, 10) || 1;
      const clamped = Math.min(Math.max(1, raw), state.pdf.totalPages);
      state.pdf.currentPage = clamped;
      updatePdfFrameAndControls();
    } else if (action === 'pdf-copy-anchor') {
      if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
      const anchor = `[[${state.activeDoc.name}#page=${state.pdf.currentPage}]]`;
      copyInternal(anchor, '已复制页码锚点');
    } else if (action === 'pdf-annotate') {
      openPdfAnnotateSheet();
    } else if (action === 'pdf-insert-anchor') {
      if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
      const anchor = `[[${state.activeDoc.name}#page=${state.pdf.currentPage}]]`;
      if (state.pdf.companionMode !== 'edit') {
        state.pdf.companionMode = 'edit';
        state.activeDoc.companionContent = `${state.activeDoc.companionContent || ''}${state.activeDoc.companionContent?.endsWith('\n') ? '' : '\n'}- ${anchor} `;
        state.pdf.companionDirty = true;
        store.state.activeDocumentText = state.activeDoc.companionContent;
        renderPdfMode();
        return;
      }
      const ta = containerEl.querySelector('[data-role="pdf-companion-editor"]');
      if (ta) {
        const start = ta.selectionStart ?? ta.value.length;
        const end = ta.selectionEnd ?? ta.value.length;
        const before = ta.value.slice(0, start);
        const after = ta.value.slice(end);
        const nextVal = `${before}${anchor} ${after}`;
        ta.value = nextVal;
        ta.focus();
        const cursor = start + anchor.length + 1;
        ta.setSelectionRange(cursor, cursor);
        state.activeDoc.companionContent = nextVal;
        state.pdf.companionDirty = true;
        store.state.activeDocumentText = nextVal;
        updatePdfCompanionDirtyIndicators();
      }
    } else if (action === 'pdf-save-companion') {
      savePdfCompanionNote();
    }
  });

  containerEl.addEventListener('dblclick', (e) => {
    const td = e.target.closest('td[data-excel-row][data-excel-col]');
    if (!td || state.activeDoc?.type !== 'excel') return;
    if (e.target.closest('input.excel-cell-input')) return;
    const rowNum = Number(td.dataset.excelRow);
    const col1 = Number(td.dataset.excelCol);
    startExcelInlineEdit(rowNum, col1);
  });

  containerEl.addEventListener('keydown', (e) => {
    if (e.target.matches('input.excel-cell-input')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitExcelInlineEdit(e.target, false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        commitExcelInlineEdit(e.target, true);
      }
      return;
    }

    if (e.target.matches('[data-role="pdf-page-input"]') && e.key === 'Enter') {
      e.preventDefault();
      const raw = Number.parseInt(e.target.value, 10) || 1;
      state.pdf.currentPage = Math.min(Math.max(1, raw), state.pdf.totalPages);
      updatePdfFrameAndControls();
    }
  });

  containerEl.addEventListener(
    'blur',
    (e) => {
      if (e.target.matches('input.excel-cell-input')) {
        commitExcelInlineEdit(e.target, false);
      }
    },
    true
  );

  // Global Ctrl+S / Cmd+S handler for center workspace
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      if (!state.activeDoc) return;
      // Avoid intercepting when an overlay modal/spotlight is open
      const sheetOpen = document.getElementById('sheet-overlay')?.classList.contains('is-open');
      const spotlightOpen = document.getElementById('spotlight-overlay')?.classList.contains('is-open');
      if (sheetOpen || spotlightOpen) return;

      e.preventDefault();
      if (state.activeDoc.type === 'excel') {
        const activeInput = containerEl.querySelector('input.excel-cell-input');
        if (activeInput) {
          commitExcelInlineEdit(activeInput, false);
        }
        saveExcelChanges();
      } else if (state.activeDoc.type === 'pdf') {
        savePdfCompanionNote();
      } else {
        saveMarkdownDoc();
      }
    }
  });

  // Initial render (and auto-open first .md if files are already populated)
  const initialItems = store.state.files?.items || [];
  if (initialItems.length > 0) {
    const firstMd = initialItems.find(
      (f) => String(f.ext || '').toLowerCase() === '.md' || String(f.name || '').toLowerCase().endsWith('.md')
    );
    if (firstMd?.path) {
      openFile(firstMd.path);
      return;
    }
  }
  renderWelcome();
}
