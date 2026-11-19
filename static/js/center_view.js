/**
 * SmartLocalNote - Center Workspace Panel (V4 Super-Upgrade)
 * Preserves ALL V1/V2/V3 features:
 *  - Welcome state, typography controls (A-/A+/font family), snapshots rollback
 *  - Markdown / TXT editor & preview, atomic save, AI summary, doc:append
 *  - Excel pagination, inline cell edit, batch patch, search, sort, append row, CSV export, cell anchor pulse
 *  - PDF PyMuPDF HD viewer + zoom + native iframe toggle + annotation + companion note + AI mindmap
 *  - Multi-Format Readers: Archive (read-only virtual tree + in-memory preview), Image (zoomable),
 *    Audio/Video (native Range stream + timestamp anchor capsules), Office Preview, Generic Info Card
 *  - Unsaved Changes Guard + Auto-Save on Switch / Window Blur, Backlinks Badge, Auto-Relocate
 *  - Universal Portal Jump (app, url, pdf, excel, archive, media, file#heading) & Native SVG Mind Map
 * Adds V4 capabilities:
 *  1. Obsidian-Style Block Live Preview (live | source | mindmap, default 'live')
 *  2. Rock-solid Precision Blue-Line Drop + Guaranteed Blank Lines in live & source modes
 *  3. Interactive Inline Image & Video Poster Playback + Drag/Preset Width Resize
 *  4. 80-step Undo/Redo History Stack + Ctrl+F Find & Replace + Ctrl+B/I/Slash/Z/Y/S Shortcuts
 *  5. Updated full multi-format Welcome Copy & center:polish-doc listener
 *
 * Communicates strictly via store EventBus.
 */

import {
  store,
  renderMarkdownSafe,
  insertMarkdownWithPadding,
  insertMarkdownAtCharIndex,
  showToast,
  copyInternal,
  escapeHtml,
  setIsland,
  openSheet,
  closeSheet,
  applyDocTypography,
  setDragPayload,
  readDragPayload,
  clearDragPayload,
  findWorkspaceFileItem,
  DRAG_MIME,
} from './store.js';
import { api } from './api_client.js';
import { icon } from './icons.js';
import { renderMindMap } from './mindmap.js';

const PDF_ZOOM_STEPS = [0.8, 1.0, 1.25, 1.5, 1.6, 1.75, 2.0, 2.4];
const IMAGE_ZOOM_STEPS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];

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

const CODE_OR_TEXT_EXTS = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.json', '.csv', '.css', '.scss', '.html', '.htm', '.xml',
  '.yaml', '.yml', '.ini', '.toml', '.log', '.sql', '.sh', '.bat', '.ps1',
]);

function isCodeOrPlainTextExt(ext) {
  return CODE_OR_TEXT_EXTS.has(String(ext || '').toLowerCase());
}

function normalizeHeadingKey(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/^[#\s]+/, '')
    .replace(/[\s\-_.,，。、：:()（）【】[\]`*_~]+/g, '');
}

function docIconName(type, ext) {
  if (type === 'pdf' || ext === '.pdf') return 'file-pdf';
  if (type === 'excel' || ext === '.xlsx' || ext === '.xls') return 'file-spreadsheet';
  if (type === 'archive' || ['.zip', '.tar', '.gz', '.tgz', '.rar', '.7z'].includes(ext)) return 'layers';
  if (type === 'audio' || type === 'video') return 'play';
  if (type === 'image') return 'book-open';
  if (type === 'office_preview') return 'file-text';
  if (['.js', '.ts', '.py', '.json', '.html', '.css'].includes(ext)) return 'file-code';
  return 'file-text';
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSnapTime(iso) {
  return String(iso || '').replace('T', ' ');
}

function formatMediaTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function parseMediaTimeSeconds(raw) {
  if (raw == null || raw === '') return 0;
  const str = String(raw).trim();
  if (/^\d+(?:\.\d+)?$/.test(str)) {
    return Math.max(0, Number.parseFloat(str));
  }
  const parts = str.split(':').map((p) => Number.parseFloat(p));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 2) {
    return Math.max(0, parts[0] * 60 + parts[1]);
  }
  if (parts.length === 3) {
    return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }
  return 0;
}

function hasCompanionNote(doc) {
  return Boolean(doc && doc.companionPath);
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse Markdown text into cohesive top-level blocks with 0-based inclusive line ranges.
 * Splits cleanly on blank lines while keeping fenced code blocks, Markdown tables,
 * GitHub callout blockquotes, and contiguous list items intact.
 * @param {string} mdText
 * @returns {Array<{ startLine: number, endLine: number, raw: string }>}
 */
export function parseMarkdownBlocks(mdText) {
  const normalized = String(mdText ?? '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) return [];

  const lines = normalized.split('\n');
  const blocks = [];
  const total = lines.length;
  let i = 0;

  const isFenceStart = (ln) => /^\s*(`{3,}|~{3,})/.test(ln);
  const isHeading = (ln) => /^\s{0,3}#{1,6}(?:\s+|$)/.test(ln);
  const isQuote = (ln) => /^\s*>/.test(ln);
  const isListItem = (ln) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(ln);
  const isTableSep = (ln) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(ln) || /^\s*\|\s*:?-{3,}:?\s*\|\s*$/.test(ln);
  const isTableStart = (idx) => {
    const cur = lines[idx] || '';
    if (!cur.includes('|')) return false;
    if (/^\s*\|/.test(cur)) return true;
    return idx + 1 < total && isTableSep(lines[idx + 1]);
  };

  while (i < total) {
    if (lines[i].trim() === '') {
      i += 1;
      continue;
    }

    const line = lines[i];

    // 1. Fenced code block (``` ... ``` or ~~~ ... ~~~)
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      const closeRe = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);
      const start = i;
      i += 1;
      while (i < total && !closeRe.test(lines[i])) {
        i += 1;
      }
      const end = i < total ? i : total - 1;
      blocks.push({
        startLine: start,
        endLine: end,
        raw: lines.slice(start, end + 1).join('\n'),
      });
      i = end + 1;
      continue;
    }

    // 2. ATX Heading
    if (isHeading(line)) {
      blocks.push({
        startLine: i,
        endLine: i,
        raw: line,
      });
      i += 1;
      continue;
    }

    // 3. Blockquote / GitHub Callout (> ...)
    if (isQuote(line)) {
      const start = i;
      while (i + 1 < total && isQuote(lines[i + 1])) {
        i += 1;
      }
      blocks.push({
        startLine: start,
        endLine: i,
        raw: lines.slice(start, i + 1).join('\n'),
      });
      i += 1;
      continue;
    }

    // 4. Markdown Table (| ... |)
    if (isTableStart(i)) {
      const start = i;
      while (
        i + 1 < total &&
        lines[i + 1].trim() !== '' &&
        lines[i + 1].includes('|') &&
        !isFenceStart(lines[i + 1]) &&
        !isHeading(lines[i + 1]) &&
        !isQuote(lines[i + 1])
      ) {
        i += 1;
      }
      blocks.push({
        startLine: start,
        endLine: i,
        raw: lines.slice(start, i + 1).join('\n'),
      });
      i += 1;
      continue;
    }

    // 5. Contiguous List Block (including indented continuation lines)
    if (isListItem(line)) {
      const start = i;
      while (i + 1 < total) {
        const next = lines[i + 1];
        if (next.trim() === '') break;
        if (isFenceStart(next) || isHeading(next) || isQuote(next)) break;
        if (isListItem(next) || /^\s+\S/.test(next)) {
          i += 1;
        } else {
          break;
        }
      }
      blocks.push({
        startLine: start,
        endLine: i,
        raw: lines.slice(start, i + 1).join('\n'),
      });
      i += 1;
      continue;
    }

    // 6. Standard Paragraph / Multi-line prose block
    const start = i;
    while (i + 1 < total) {
      const next = lines[i + 1];
      if (next.trim() === '') break;
      if (isFenceStart(next) || isHeading(next) || isQuote(next) || isListItem(next) || isTableStart(i + 1)) {
        break;
      }
      i += 1;
    }
    blocks.push({
      startLine: start,
      endLine: i,
      raw: lines.slice(start, i + 1).join('\n'),
    });
    i += 1;
  }

  return blocks;
}

function injectV4CenterStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('sln-center-v4-style')) return;
  const style = document.createElement('style');
  style.id = 'sln-center-v4-style';
  style.textContent = `
    :where(.lp-container) {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 20px 26px 80px;
      min-height: 100%;
    }
    :where(.lp-block) {
      position: relative;
      border-radius: var(--radius-control);
      padding: 4px 8px;
      margin: 0 -8px;
      transition: opacity var(--dur-fast) var(--ease-apple),
                  transform var(--dur-fast) var(--ease-apple),
                  background-color var(--dur-fast) var(--ease-apple);
    }
    :where(.lp-block:not(.is-editing)):hover {
      background: var(--bg-subtle);
    }
    :where(.lp-block.is-editing) {
      background: var(--bg-island);
      box-shadow: 0 0 0 2px var(--accent-soft), inset 0 0 0 1px var(--accent);
      padding: 8px 10px;
    }
    :where(.lp-block-view) > :first-child { margin-top: 0; }
    :where(.lp-block-view) > :last-child { margin-bottom: 0; }
    .lp-block.is-editing .lp-block-editor {
      width: 100%;
      display: block;
      min-height: 26px;
      border: none;
      outline: none;
      resize: none;
      overflow: hidden;
      background: transparent;
      color: var(--text-primary);
      font-family: var(--doc-font-family);
      font-size: var(--doc-font-size);
      line-height: 1.72;
      padding: 0;
      margin: 0;
    }
    .media-embed-card.is-playing .video-play-badge {
      display: none !important;
    }
    .media-embed-card.is-resizing {
      box-shadow: 0 0 0 2px var(--accent);
    }
    :where(.lp-add-block-zone) {
      margin-top: 8px;
      padding: 14px 12px;
      border-radius: var(--radius-control);
      color: var(--text-tertiary);
      font-size: 13px;
      cursor: text;
      border: 1px dashed transparent;
      transition: opacity var(--dur-fast) var(--ease-apple),
                  background-color var(--dur-fast) var(--ease-apple),
                  border-color var(--dur-fast) var(--ease-apple);
    }
    :where(.lp-add-block-zone):hover {
      background: var(--bg-subtle);
      border-color: var(--border-hairline);
      color: var(--text-secondary);
    }
    @keyframes slnJustDroppedPulse {
      0% { opacity: 0.55; transform: scale(0.985); }
      40% { opacity: 1; transform: scale(1.008); }
      100% { opacity: 1; transform: scale(1); }
    }
    :where(.lp-block.just-dropped) {
      background: var(--accent-soft);
      box-shadow: 0 0 0 2px var(--accent);
      animation: slnJustDroppedPulse 900ms var(--ease-spring);
    }
    :where(.doc-find-bar) {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      padding: 7px 14px;
      border-bottom: 1px solid var(--border-hairline);
      background: var(--bg-glass);
      backdrop-filter: var(--blur-glass);
      -webkit-backdrop-filter: var(--blur-glass);
      flex-shrink: 0;
      animation: islandFadeIn var(--dur-fast) var(--ease-apple);
    }
    :where(.doc-find-hl) {
      background: rgba(255, 214, 10, 0.42);
      color: inherit;
      border-radius: 3px;
      padding: 0 1px;
    }
    :where(.doc-find-hl.is-active) {
      background: var(--warning);
      color: #1D1D1F;
      box-shadow: 0 0 0 2px rgba(255, 149, 0, 0.35);
    }
    :where(.media-embed-card) {
      position: relative;
      display: flex;
      flex-direction: column;
      max-width: 100%;
      margin: 6px 0;
      border-radius: var(--radius-card);
      border: 1px solid var(--border-hairline);
      background: var(--bg-subtle);
      overflow: hidden;
    }
    :where(.media-embed-card img),
    :where(.media-embed-card video) {
      display: block;
      width: 100%;
      height: auto;
      max-height: 520px;
      object-fit: contain;
    }
    :where(.media-resize-handle) {
      cursor: ew-resize;
      touch-action: none;
      user-select: none;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Initialize Center Workspace Panel.
 * @param {HTMLElement} containerEl
 */
export function initCenterView(containerEl) {
  if (!containerEl) return;
  injectV4CenterStyles();

  const state = {
    activeDoc: null,
    dirty: false,
    mdMode: 'live', // 'live' | 'source' | 'mindmap'
    editingBlockIdx: null,
    editingBlockRange: null, // { startLine, endLine }
    editingDraftNewBlock: false,
    justDroppedTarget: null, // { lineIdx, previewPrefix }
    loading: false,
    saving: false,
    hasOpenedOnce: false,
    openSeq: 0,
    excelSeq: 0,
    archiveSeq: 0,
    backlinkSeq: 0,
    excelSearchTimer: null,
    companionOpen: false, // collapsible companion note for archive/image/office/generic
    backlinks: { count: 0, items: [] },
    history: {
      path: '',
      undoStack: [],
      redoStack: [],
      typingBaseline: null,
      timer: null,
    },
    findBar: {
      open: false,
      query: '',
      replaceText: '',
      matches: [],
      activeIdx: -1,
    },
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
      selectedCell: null,
      pendingChanges: new Map(),
      loading: false,
      editingKey: null,
    },
    pdf: {
      viewMode: 'hd', // 'hd' | 'iframe'
      zoom: 1.6,
      currentPage: 1,
      totalPages: 1,
      companionMode: 'edit', // 'edit' | 'preview'
      companionDirty: false,
      cacheBust: Date.now(),
      imgLoading: false,
      imgError: false,
    },
    archive: {
      entries: [],
      fileCount: 0,
      totalSize: 0,
      selectedMember: '',
      entryLoading: false,
      entryData: null,
      entryError: '',
    },
    image: {
      fit: true,
      zoom: 1.0,
      cacheBust: Date.now(),
    },
    media: {
      initialTime: 0,
      autoPlay: false,
    },
  };

  let typographySaveTimer = null;
  let dragDepth = 0;
  let dropTargetLineIdx = null;
  let activeFormatBar = null;
  let activeFormatContext = null; // { startIdx, endIdx, selectedText }

  // =========================================================================
  // Floating Selection Format Bar & Precision Drop Line Helpers
  // =========================================================================
  function hideFormatBar() {
    if (activeFormatBar) {
      activeFormatBar.remove();
      activeFormatBar = null;
    }
    activeFormatContext = null;
  }

  function removeDropInsertLine() {
    dropTargetLineIdx = null;
    const line = document.getElementById('center-drop-insert-line');
    if (line) line.remove();
  }

  function ensureDropInsertLine() {
    let line = document.getElementById('center-drop-insert-line');
    if (!line) {
      line = document.createElement('div');
      line.id = 'center-drop-insert-line';
      line.className = 'drop-insert-line';
      line.style.cssText = [
        'position:fixed',
        'top:0px',
        'left:0px',
        'right:auto',
        'height:2.5px',
        'background:var(--accent)',
        'border-radius:9999px',
        'box-shadow:0 0 8px rgba(0,122,255,0.5)',
        'pointer-events:none',
        'z-index:90',
        'transition:transform 90ms var(--ease-apple), opacity 120ms ease',
      ].join(';');
      document.body.appendChild(line);
    }
    return line;
  }

  function ensureDropOverlay() {
    if (typeof window !== 'undefined' && window.getComputedStyle(containerEl).position === 'static') {
      containerEl.style.position = 'relative';
    }
    let overlay = containerEl.querySelector('#center-drop-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'center-drop-overlay';
      overlay.className = 'center-drop-overlay';
      overlay.innerHTML = `
        <div style="font-size:22px;line-height:1;">✨</div>
        <div>松开即可插入到当前笔记</div>
      `;
      containerEl.appendChild(overlay);
    }
    return overlay;
  }

  function showDropOverlay(visible) {
    const overlay = ensureDropOverlay();
    overlay.classList.toggle('is-visible', Boolean(visible));
  }

  // =========================================================================
  // Typography Controls
  // =========================================================================
  function renderTypographyControlsHtml(compact = false) {
    const size = store.state.docFontSize || 15;
    const family = store.state.docFontFamily || 'sans';
    const btnPad = compact ? 'height:24px;padding:0 7px;font-size:11px;' : 'height:26px;padding:0 8px;font-size:11.5px;';
    const selectStyle = compact
      ? 'width:auto;height:24px;padding:2px 6px;font-size:11px;border-radius:var(--radius-pill);'
      : 'width:auto;height:26px;padding:2px 8px;font-size:11.5px;border-radius:var(--radius-pill);';
    return `
      <div class="doc-typography-controls" style="display:inline-flex;align-items:center;gap:4px;padding:2px 4px;border-radius:var(--radius-pill);background:var(--bg-subtle);border:1px solid var(--border-hairline);">
        <button type="button" class="pill-btn pill-btn-ghost" data-action="font-dec" title="减小字号" style="${btnPad}">A-</button>
        <span class="font-size-label" data-role="font-size-label" style="font-size:11.5px;font-weight:600;color:var(--text-secondary);min-width:34px;text-align:center;">${size}px</span>
        <button type="button" class="pill-btn pill-btn-ghost" data-action="font-inc" title="增大字号" style="${btnPad}">A+</button>
        <select class="apple-select" data-action="font-family" aria-label="文档字体" style="${selectStyle}">
          <option value="sans" ${family === 'sans' ? 'selected' : ''}>无衬线</option>
          <option value="serif" ${family === 'serif' ? 'selected' : ''}>衬线</option>
          <option value="mono" ${family === 'mono' ? 'selected' : ''}>等宽</option>
        </select>
      </div>
    `;
  }

  function syncTypographyUi() {
    const size = store.state.docFontSize || 15;
    const family = store.state.docFontFamily || 'sans';
    containerEl.querySelectorAll('[data-role="font-size-label"]').forEach((el) => {
      el.textContent = `${size}px`;
    });
    containerEl.querySelectorAll('select[data-action="font-family"]').forEach((sel) => {
      if (sel.value !== family) sel.value = family;
    });
  }

  function updateTypographyAndPersist(nextSize, nextFamily) {
    const detail = applyDocTypography(nextSize, nextFamily);
    syncTypographyUi();
    if (typographySaveTimer) window.clearTimeout(typographySaveTimer);
    typographySaveTimer = window.setTimeout(() => {
      api.put('/api/system/config', {
        doc_font_size: detail.docFontSize,
        doc_font_family: detail.docFontFamily,
      }).catch(() => {});
    }, 350);
  }

  function getErrorMsg(err, fallback = '操作失败') {
    return err?.message || fallback;
  }

  function findWorkspaceFile(queryNameOrPath) {
    return findWorkspaceFileItem(queryNameOrPath);
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
    const doc = state.activeDoc;
    store.state.activeFile = {
      path: doc.path,
      name: doc.name,
      ext: doc.ext,
      type: doc.type,
      is_private: Boolean(doc.isPrivate),
    };
    if (doc.type === 'markdown' || doc.type === 'text') {
      store.state.activeDocumentText = doc.content || '';
    } else if (doc.type === 'excel') {
      store.state.activeDocumentText = doc.isPrivate ? '' : buildExcelSummaryText();
    } else if (doc.type === 'office_preview') {
      store.state.activeDocumentText = doc.companionContent || doc.previewMarkdown || '';
    } else {
      store.state.activeDocumentText = doc.companionContent || '';
    }
    setIsland('idle', { label: doc.name });
  }

  function ensureDocTabOnMobile() {
    if (typeof window !== 'undefined' && window.innerWidth <= 767 && store.state.mobileTab !== 'doc') {
      store.setState({ mobileTab: 'doc' });
      store.emit('layout:changed');
    }
  }

  // =========================================================================
  // Innovation C: Backlinks Badge & Sheet
  // =========================================================================
  function renderBacklinksSlotHtml() {
    const count = Number(state.backlinks?.count || 0);
    if (count <= 0) return '';
    return `
      <button type="button" class="pill-btn pill-btn-sm" data-action="open-backlinks" title="查看引用当前文档的笔记" style="background:var(--accent-soft);color:var(--accent);border-color:transparent;">
        🔗 被 ${count} 篇引用
      </button>
    `;
  }

  function syncBacklinksBadge() {
    const slot = containerEl.querySelector('[data-role="backlinks-slot"]');
    if (slot) {
      slot.innerHTML = renderBacklinksSlotHtml();
    }
  }

  async function loadBacklinksForActiveDoc(pathStr, openSeq) {
    const seq = ++state.backlinkSeq;
    state.backlinks = { count: 0, items: [] };
    syncBacklinksBadge();
    try {
      const res = await api.get(`/api/files/backlinks?path=${encodeURIComponent(pathStr)}`);
      if (seq !== state.backlinkSeq || openSeq !== state.openSeq) return;
      if (!state.activeDoc || !isSamePath(state.activeDoc.path, pathStr)) return;
      const items = Array.isArray(res) ? res : (res?.backlinks || res?.items || []);
      const count = Number(res?.count ?? items.length) || 0;
      state.backlinks = { count, items };
      syncBacklinksBadge();
    } catch {
      // Silently ignore if backlinks index unavailable
    }
  }

  function openBacklinksSheet() {
    const doc = state.activeDoc;
    if (!doc) return;
    const items = state.backlinks?.items || [];
    openSheet({
      title: `反向链接 · ${doc.name}（${items.length}）`,
      bodyHtml:
        items.length === 0
          ? `<div class="empty-state"><p class="empty-title">暂无笔记引用当前文件</p></div>`
          : `
            <div style="display:flex;flex-direction:column;gap:8px;">
              ${items
                .map((item) => {
                  const srcPath = item.source_path || item.path || '';
                  const srcName = item.source_name || item.name || getBaseName(srcPath) || '未命名笔记';
                  const snippet = item.snippet || item.context || item.line_text || '';
                  const anchor = item.anchor || item.token || '';
                  const rawLine = item.line ?? item.line_num ?? item.lineNum ?? item.lineno ?? '';
                  return `
                    <div class="glass-card" style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
                      <div style="min-width:0;flex:1;">
                        <div style="font-size:13px;font-weight:600;color:var(--text-primary);display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                          ${icon('file-text', 13)}
                          <span>${escapeHtml(srcName)}</span>
                          ${anchor ? `<span class="file-ext-badge" style="text-transform:none;">${escapeHtml(anchor)}</span>` : ''}
                        </div>
                        ${snippet ? `<div class="search-snippet" style="margin-top:4px;word-break:break-word;">${escapeHtml(snippet)}</div>` : ''}
                      </div>
                      <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-backlink-open="${escapeHtml(srcPath)}" data-backlink-line="${escapeHtml(rawLine)}">打开</button>
                    </div>
                  `;
                })
                .join('')}
            </div>
          `,
      footerHtml: `<button type="button" class="pill-btn" id="backlinks-close">关闭</button>`,
      onMount(card) {
        card.querySelector('#backlinks-close')?.addEventListener('click', closeSheet);
        card.addEventListener('click', async (e) => {
          const btn = e.target.closest('[data-backlink-open]');
          if (!btn) return;
          const targetPath = btn.dataset.backlinkOpen;
          if (!targetPath) return;
          const lineNum = Number.parseInt(btn.dataset.backlinkLine || '', 10);
          closeSheet();
          await openFile(targetPath, Number.isFinite(lineNum) ? { line: lineNum } : {});
        });
      },
    });
  }

  // =========================================================================
  // External Open Helper
  // =========================================================================
  async function openExternalFile(pathStr, revealFolder = false) {
    if (!pathStr) return;
    try {
      await api.post('/api/files/open-external', {
        path: pathStr,
        reveal_folder: Boolean(revealFolder),
      });
      showToast(revealFolder ? '已在文件管理器中定位' : '已调用系统默认应用打开', 'success');
    } catch (err) {
      showToast(getErrorMsg(err, '外部打开失败'), 'error');
    }
  }

  // =========================================================================
  // Pain Point #2: Unsaved Changes Guard + Auto-Save on Switch/Blur
  // =========================================================================
  function hasUnsavedChanges() {
    if (!state.activeDoc) return false;
    if ((state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text') && state.dirty) {
      return true;
    }
    if (state.pdf.companionDirty && hasCompanionNote(state.activeDoc)) {
      return true;
    }
    if (state.activeDoc.type === 'excel' && state.excel.pendingChanges.size > 0) {
      return true;
    }
    return false;
  }

  function clearUnsavedFlags() {
    state.dirty = false;
    state.pdf.companionDirty = false;
    state.excel.pendingChanges.clear();
  }

  async function saveCurrentDirtyDoc({ silent = false, toastMessage = '' } = {}) {
    if (!state.activeDoc) return true;
    if (state.activeDoc.type === 'excel') {
      const activeInput = containerEl.querySelector('input.excel-cell-input');
      if (activeInput) {
        commitExcelInlineEdit(activeInput, false);
      }
      if (state.excel.pendingChanges.size === 0) return true;
      return saveExcelChanges({ silent, toastMessage });
    }
    if (state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text') {
      if (!state.dirty) return true;
      return saveMarkdownDoc({ silent, toastMessage });
    }
    if (hasCompanionNote(state.activeDoc) && state.pdf.companionDirty) {
      return saveCompanionNote({ silent, toastMessage });
    }
    return true;
  }

  async function confirmOrAutoSaveBeforeSwitch() {
    if (state.activeDoc?.type === 'excel') {
      const activeInput = containerEl.querySelector('input.excel-cell-input');
      if (activeInput) {
        commitExcelInlineEdit(activeInput, false);
      }
    }

    if (!hasUnsavedChanges()) return true;

    if (store.state.autoSaveOnSwitch) {
      const saved = await saveCurrentDirtyDoc({ silent: true, toastMessage: '已自动保存修改' });
      return saved;
    }

    const docName = state.activeDoc?.name || '当前文档';
    return new Promise((resolve) => {
      let settled = false;
      let unsubClose = () => {};
      const finish = (val) => {
        if (settled) return;
        settled = true;
        unsubClose();
        resolve(val);
      };

      unsubClose = store.on('sheet:closed', () => {
        finish(false);
      });

      openSheet({
        title: '保存未保存的修改？',
        bodyHtml: `
          <p style="margin:0;color:var(--text-secondary);line-height:1.6;">
            文档「<strong style="color:var(--text-primary);">${escapeHtml(docName)}</strong>」存在尚未保存的修改。是否在切换前保存？
          </p>
        `,
        footerHtml: `
          <div class="sheet-footer-split">
            <button type="button" class="pill-btn pill-btn-primary" data-guard-act="save">💾 保存并退出</button>
            <button type="button" class="pill-btn pill-btn-danger" data-guard-act="discard">放弃修改</button>
            <button type="button" class="pill-btn" data-guard-act="cancel">取消</button>
          </div>
        `,
        onMount(card) {
          card.querySelector('[data-guard-act="cancel"]')?.addEventListener('click', () => {
            finish(false);
            closeSheet();
          });
          card.querySelector('[data-guard-act="discard"]')?.addEventListener('click', () => {
            clearUnsavedFlags();
            finish(true);
            closeSheet();
          });
          const saveBtn = card.querySelector('[data-guard-act="save"]');
          saveBtn?.addEventListener('click', async () => {
            if (saveBtn) saveBtn.disabled = true;
            const ok = await saveCurrentDirtyDoc({ silent: true, toastMessage: '已保存修改' });
            if (ok) {
              finish(true);
              closeSheet();
            } else if (saveBtn) {
              saveBtn.disabled = false;
            }
          });
        },
      });
    });
  }

  // =========================================================================
  // Rendering: Welcome / Loading
  // =========================================================================
  function renderWelcome() {
    hideFormatBar();
    removeDropInsertLine();
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
          <p class="empty-desc" style="max-width:380px;line-height:1.65;">
            本地优先的苹果风学习与办公工作台。全面支持 Markdown、TXT/代码、Excel 表格、PDF 高清阅览、ZIP 压缩包免解压预览、图片与音视频、Word/PPT 速览。
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
    ensureDropOverlay();
  }

  function renderLoading(label = '正在加载本地文档…') {
    hideFormatBar();
    removeDropInsertLine();
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
  // Shared Companion Note Panel (PDF / Audio / Video / Archive / Image / Office)
  // =========================================================================
  function renderCompanionPaneHtml(doc, { placeholderText = '', extraActionHtml = '' } = {}) {
    const isCompPreview = state.pdf.companionMode === 'preview';
    const disabledNote = !hasCompanionNote(doc);
    return `
      <div class="pdf-side-notes">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px; flex-shrink:0;">
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="font-size:13px; font-weight:600; color:var(--text-primary);">伴生笔记</span>
            <span
              data-role="pdf-companion-dirty"
              title="伴生笔记有未保存修改"
              style="width:7px; height:7px; border-radius:9999px; background:var(--warning); display:${state.pdf.companionDirty ? 'inline-block' : 'none'};"
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
          ${renderTypographyControlsHtml(true)}
        </div>

        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px; flex-shrink:0;">
          <div style="display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap;">
            ${extraActionHtml}
          </div>
          <button type="button" class="pill-btn pill-btn-sm ${state.pdf.companionDirty ? 'pill-btn-primary' : ''}" data-action="pdf-save-companion" ${disabledNote ? 'disabled' : ''}>
            ${icon('save', 12)} 保存
          </button>
        </div>

        <div style="flex:1 1 auto; min-height:0; display:flex; flex-direction:column;">
          ${
            disabledNote
              ? `<div class="empty-state"><p class="empty-desc">当前文件暂无关联伴生笔记路径</p></div>`
              : isCompPreview
              ? `<div class="md-scroll-area"><div class="md-preview" style="padding:8px 6px 40px;">${renderMarkdownSafe(doc.companionContent || '', { withLineMap: true })}</div></div>`
              : `<textarea class="md-editor" data-role="pdf-companion-editor" spellcheck="false" style="min-height:160px; flex:1 1 auto; padding:12px; border:1px solid var(--border-hairline); border-radius:var(--radius-control); background:var(--bg-subtle);" placeholder="${escapeHtml(placeholderText || `随时记录关于 ${doc.name} 的伴生笔记…`)}">${escapeHtml(doc.companionContent || '')}</textarea>`
          }
        </div>
      </div>
    `;
  }

  function insertTextIntoCompanionNote(snippet, { toastMsg = '已插入到伴生笔记' } = {}) {
    const doc = state.activeDoc;
    if (!doc || !hasCompanionNote(doc)) {
      copyInternal(snippet, '已复制锚点到剪贴板');
      return;
    }

    if (doc.type !== 'pdf' && doc.type !== 'audio' && doc.type !== 'video' && !state.companionOpen) {
      state.companionOpen = true;
    }

    if (state.pdf.companionMode !== 'edit') {
      state.pdf.companionMode = 'edit';
      const prev = doc.companionContent || '';
      const sep = !prev.trim() ? '' : prev.endsWith('\n') ? '' : '\n';
      doc.companionContent = `${prev}${sep}- ${snippet} `;
      state.pdf.companionDirty = true;
      store.state.activeDocumentText = doc.companionContent;
      renderActiveView();
      showToast(toastMsg, 'success');
      return;
    }

    const ta = containerEl.querySelector('[data-role="pdf-companion-editor"]');
    if (ta) {
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const nextVal = `${before}${snippet} ${after}`;
      ta.value = nextVal;
      ta.focus();
      const cursor = start + snippet.length + 1;
      ta.setSelectionRange(cursor, cursor);
      doc.companionContent = nextVal;
      state.pdf.companionDirty = true;
      store.state.activeDocumentText = nextVal;
      updatePdfCompanionDirtyIndicators();
      showToast(toastMsg, 'success');
    } else {
      const prev = doc.companionContent || '';
      const sep = !prev.trim() ? '' : prev.endsWith('\n') ? '' : '\n';
      doc.companionContent = `${prev}${sep}- ${snippet} `;
      state.pdf.companionDirty = true;
      store.state.activeDocumentText = doc.companionContent;
      renderActiveView();
      showToast(toastMsg, 'success');
    }
  }

  // =========================================================================
  // Undo / Redo History Stack (80 snapshots) & In-Doc Find / Replace Bar
  // =========================================================================
  const MAX_HISTORY_SNAPSHOTS = 80;

  function resetHistory(docPath = '') {
    if (state.history.timer) {
      window.clearTimeout(state.history.timer);
      state.history.timer = null;
    }
    state.history = {
      path: docPath,
      undoStack: [],
      redoStack: [],
      typingBaseline: null,
      timer: null,
    };
    updateMdUndoRedoButtons();
  }

  function flushPendingUndo() {
    if (state.history.timer) {
      window.clearTimeout(state.history.timer);
      state.history.timer = null;
    }
    const baseline = state.history.typingBaseline;
    state.history.typingBaseline = null;
    if (baseline !== null && state.activeDoc) {
      const current = String(state.activeDoc.content ?? '');
      if (baseline !== current) {
        const stack = state.history.undoStack;
        if (stack.length === 0 || stack[stack.length - 1] !== baseline) {
          stack.push(baseline);
          if (stack.length > MAX_HISTORY_SNAPSHOTS) {
            stack.shift();
          }
        }
        state.history.redoStack = [];
      }
    }
  }

  function pushUndoSnapshot(prevContent, { immediate = true } = {}) {
    if (!state.activeDoc || (state.activeDoc.type !== 'markdown' && state.activeDoc.type !== 'text')) return;
    const prevStr = String(prevContent ?? '');

    if (!immediate) {
      if (state.history.typingBaseline === null) {
        state.history.typingBaseline = prevStr;
        state.history.redoStack = [];
      }
      if (state.history.timer) {
        window.clearTimeout(state.history.timer);
      }
      state.history.timer = window.setTimeout(() => {
        flushPendingUndo();
        updateMdUndoRedoButtons();
      }, 450);
      updateMdUndoRedoButtons();
      return;
    }

    flushPendingUndo();
    const stack = state.history.undoStack;
    if (stack.length === 0 || stack[stack.length - 1] !== prevStr) {
      stack.push(prevStr);
      if (stack.length > MAX_HISTORY_SNAPSHOTS) {
        stack.shift();
      }
    }
    state.history.redoStack = [];
    updateMdUndoRedoButtons();
  }

  function updateMdUndoRedoButtons() {
    const canUndo = state.history.undoStack.length > 0 || state.history.typingBaseline !== null;
    const canRedo = state.history.redoStack.length > 0;
    const undoBtn = containerEl.querySelector('[data-action="md-undo"]');
    const redoBtn = containerEl.querySelector('[data-action="md-redo"]');
    if (undoBtn) undoBtn.disabled = !canUndo;
    if (redoBtn) redoBtn.disabled = !canRedo;
  }

  function performUndo() {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return false;
    flushPendingUndo();
    if (state.history.undoStack.length === 0) {
      updateMdUndoRedoButtons();
      return false;
    }
    const prevContent = state.history.undoStack.pop();
    const currentContent = String(doc.content ?? '');
    state.history.redoStack.push(currentContent);
    if (state.history.redoStack.length > MAX_HISTORY_SNAPSHOTS) {
      state.history.redoStack.shift();
    }
    doc.content = prevContent;
    state.dirty = true;
    state.editingBlockIdx = null;
    state.editingBlockRange = null;
    state.editingDraftNewBlock = false;
    store.state.activeDocumentText = prevContent;
    if (state.findBar.open) computeFindMatches();
    renderMarkdownMode();
    showToast('已撤回', 'info', { duration: 1500 });
    return true;
  }

  function performRedo() {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return false;
    flushPendingUndo();
    if (state.history.redoStack.length === 0) {
      updateMdUndoRedoButtons();
      return false;
    }
    const nextContent = state.history.redoStack.pop();
    const currentContent = String(doc.content ?? '');
    state.history.undoStack.push(currentContent);
    if (state.history.undoStack.length > MAX_HISTORY_SNAPSHOTS) {
      state.history.undoStack.shift();
    }
    doc.content = nextContent;
    state.dirty = true;
    state.editingBlockIdx = null;
    state.editingBlockRange = null;
    state.editingDraftNewBlock = false;
    store.state.activeDocumentText = nextContent;
    if (state.findBar.open) computeFindMatches();
    renderMarkdownMode();
    showToast('已重做', 'info', { duration: 1500 });
    return true;
  }

  function computeFindMatches() {
    const fb = state.findBar;
    const doc = state.activeDoc;
    const query = String(fb.query || '');
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text') || !query) {
      fb.matches = [];
      fb.activeIdx = -1;
      return;
    }
    const haystack = String(doc.content || '').toLowerCase();
    const needle = query.toLowerCase();
    const matches = [];
    let pos = 0;
    while (pos <= haystack.length - needle.length) {
      const idx = haystack.indexOf(needle, pos);
      if (idx === -1) break;
      matches.push({ start: idx, end: idx + needle.length });
      pos = idx + Math.max(1, needle.length);
      if (matches.length >= 2000) break;
    }
    fb.matches = matches;
    if (matches.length === 0) {
      fb.activeIdx = -1;
    } else if (fb.activeIdx < 0 || fb.activeIdx >= matches.length) {
      fb.activeIdx = 0;
    }
  }

  function clearLiveFindHighlights() {
    const lp = containerEl.querySelector('.lp-container');
    if (!lp) return;
    const marks = Array.from(lp.querySelectorAll('mark.doc-find-hl'));
    for (const mk of marks) {
      const parent = mk.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mk.textContent || ''), mk);
      parent.normalize();
    }
  }

  function applyLiveFindHighlights({ scrollToActive = false } = {}) {
    clearLiveFindHighlights();
    const fb = state.findBar;
    const query = String(fb.query || '');
    const lp = containerEl.querySelector('.lp-container');
    if (!lp || !query || state.mdMode !== 'live') return;

    const needle = query.toLowerCase();
    const views = Array.from(lp.querySelectorAll('.lp-block-view'));
    const hlNodes = [];

    for (const view of views) {
      const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue) continue;
        const pTag = node.parentElement?.tagName;
        if (pTag === 'SCRIPT' || pTag === 'STYLE') continue;
        textNodes.push(node);
      }

      for (const tNode of textNodes) {
        const val = tNode.nodeValue;
        const lowerVal = val.toLowerCase();
        if (!lowerVal.includes(needle)) continue;
        const frag = document.createDocumentFragment();
        let last = 0;
        let idx;
        while ((idx = lowerVal.indexOf(needle, last)) !== -1) {
          if (idx > last) {
            frag.appendChild(document.createTextNode(val.slice(last, idx)));
          }
          const mk = document.createElement('mark');
          mk.className = 'doc-find-hl';
          mk.textContent = val.slice(idx, idx + needle.length);
          hlNodes.push(mk);
          frag.appendChild(mk);
          last = idx + needle.length;
        }
        if (last < val.length) {
          frag.appendChild(document.createTextNode(val.slice(last)));
        }
        tNode.replaceWith(frag);
      }
    }

    if (hlNodes.length > 0 && fb.activeIdx >= 0) {
      const targetIdx = Math.min(hlNodes.length - 1, fb.activeIdx);
      const activeMk = hlNodes[targetIdx];
      activeMk.classList.add('is-active');
      if (scrollToActive) {
        activeMk.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else if (scrollToActive && fb.matches.length > 0 && fb.activeIdx >= 0) {
      const m = fb.matches[fb.activeIdx];
      const lineNum = String(state.activeDoc?.content || '').slice(0, m.start).split('\n').length - 1;
      const blkEl = Array.from(lp.querySelectorAll('.lp-block[data-md-start]')).find((b) => {
        const s = Number(b.dataset.mdStart);
        const e = Number(b.dataset.mdEnd);
        return lineNum >= s && lineNum <= e;
      });
      blkEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function syncSourceFindSelection({ focusEditor = false } = {}) {
    if (state.mdMode !== 'source') return;
    const fb = state.findBar;
    const ta = containerEl.querySelector('.md-editor:not([data-role])');
    if (!ta || fb.matches.length === 0 || fb.activeIdx < 0) return;
    const m = fb.matches[fb.activeIdx];
    if (focusEditor) {
      ta.focus();
    }
    if (focusEditor || document.activeElement === ta) {
      ta.setSelectionRange(m.start, m.end);
    }
    const lineIdx = ta.value.slice(0, m.start).split('\n').length - 1;
    const cs = window.getComputedStyle(ta);
    const lh = Number.parseFloat(cs.lineHeight) || (Number.parseFloat(cs.fontSize) || 15) * 1.7;
    const targetTop = Math.max(0, lineIdx * lh - ta.clientHeight * 0.35);
    ta.scrollTo({ top: targetTop, behavior: 'smooth' });
  }

  function updateFindBarUi({ scrollToActive = false, focusEditor = false } = {}) {
    computeFindMatches();
    const fb = state.findBar;
    const countEl = containerEl.querySelector('[data-role="doc-find-count"]');
    if (countEl) {
      countEl.textContent = fb.matches.length > 0 ? `${fb.activeIdx + 1} / ${fb.matches.length}` : '0 / 0';
    }
    if (state.mdMode === 'live') {
      applyLiveFindHighlights({ scrollToActive });
    } else if (state.mdMode === 'source' && scrollToActive) {
      syncSourceFindSelection({ focusEditor });
    }
  }

  function renderFindBarHtml() {
    if (!state.findBar.open) return '';
    const fb = state.findBar;
    const countText = fb.matches.length > 0 ? `${fb.activeIdx + 1} / ${fb.matches.length}` : '0 / 0';
    return `
      <div class="doc-find-bar" data-role="doc-find-bar">
        <div style="display:inline-flex;align-items:center;gap:6px;flex:1 1 220px;min-width:180px;">
          <span style="color:var(--text-tertiary);display:inline-flex;">${icon('search', 14)}</span>
          <input
            type="text"
            class="apple-input"
            data-role="doc-find-input"
            placeholder="查找文档内容…"
            value="${escapeHtml(fb.query)}"
            style="height:28px;padding:3px 10px;font-size:12.5px;min-width:120px;"
          />
          <span data-role="doc-find-count" style="font-size:11.5px;font-family:var(--font-mono);color:var(--text-secondary);min-width:46px;text-align:center;white-space:nowrap;">${countText}</span>
          <button type="button" class="pill-btn pill-btn-sm" data-action="find-prev" title="上一个 (Shift+Enter)" style="width:26px;padding:0;">↑</button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="find-next" title="下一个 (Enter)" style="width:26px;padding:0;">↓</button>
        </div>
        <div style="display:inline-flex;align-items:center;gap:6px;flex:1 1 220px;min-width:180px;">
          <input
            type="text"
            class="apple-input"
            data-role="doc-replace-input"
            placeholder="替换为…"
            value="${escapeHtml(fb.replaceText)}"
            style="height:28px;padding:3px 10px;font-size:12.5px;min-width:110px;"
          />
          <button type="button" class="pill-btn pill-btn-sm" data-action="find-replace-one">替换</button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="find-replace-all">全部替换</button>
          <button type="button" class="icon-pill" data-action="find-close" title="关闭 (Esc)" style="width:26px;height:26px;">
            ${icon('x', 13)}
          </button>
        </div>
      </div>
    `;
  }

  function openFindBar() {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
    if (state.mdMode === 'mindmap') {
      state.mdMode = 'live';
    }
    const prevSel = window.getSelection()?.toString()?.trim();
    if (!state.findBar.open && prevSel && !prevSel.includes('\n') && prevSel.length <= 80) {
      state.findBar.query = prevSel;
    }
    state.findBar.open = true;
    computeFindMatches();
    renderMarkdownMode();
    window.requestAnimationFrame(() => {
      const inp = containerEl.querySelector('[data-role="doc-find-input"]');
      if (inp) {
        inp.focus();
        inp.select();
      }
      updateFindBarUi({ scrollToActive: Boolean(state.findBar.query) });
    });
  }

  function closeFindBar() {
    if (!state.findBar.open) return;
    state.findBar.open = false;
    clearLiveFindHighlights();
    const bar = containerEl.querySelector('[data-role="doc-find-bar"]');
    if (bar) bar.remove();
  }

  function stepFindMatch(delta = 1) {
    const fb = state.findBar;
    computeFindMatches();
    if (fb.matches.length === 0) {
      updateFindBarUi();
      return;
    }
    fb.activeIdx = (fb.activeIdx + delta + fb.matches.length) % fb.matches.length;
    updateFindBarUi({ scrollToActive: true, focusEditor: false });
  }

  function replaceCurrentMatch() {
    const doc = state.activeDoc;
    const fb = state.findBar;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
    computeFindMatches();
    if (fb.matches.length === 0 || fb.activeIdx < 0) {
      showToast('未找到可替换的内容', 'warning', { duration: 1600 });
      return;
    }
    const m = fb.matches[fb.activeIdx];
    const content = String(doc.content || '');
    pushUndoSnapshot(content, { immediate: true });
    const rep = String(fb.replaceText ?? '');
    const nextContent = `${content.slice(0, m.start)}${rep}${content.slice(m.end)}`;
    doc.content = nextContent;
    state.dirty = true;
    state.editingBlockIdx = null;
    state.editingBlockRange = null;
    state.editingDraftNewBlock = false;
    store.state.activeDocumentText = nextContent;
    computeFindMatches();
    renderMarkdownMode();
    window.requestAnimationFrame(() => {
      updateFindBarUi({ scrollToActive: true });
      containerEl.querySelector('[data-role="doc-replace-input"]')?.focus();
    });
  }

  function replaceAllMatches() {
    const doc = state.activeDoc;
    const fb = state.findBar;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
    computeFindMatches();
    if (fb.matches.length === 0) {
      showToast('未找到可替换的内容', 'warning', { duration: 1600 });
      return;
    }
    const count = fb.matches.length;
    const content = String(doc.content || '');
    const rep = String(fb.replaceText ?? '');
    pushUndoSnapshot(content, { immediate: true });
    let result = '';
    let cursor = 0;
    for (const m of fb.matches) {
      result += content.slice(cursor, m.start) + rep;
      cursor = m.end;
    }
    result += content.slice(cursor);
    doc.content = result;
    state.dirty = true;
    state.editingBlockIdx = null;
    state.editingBlockRange = null;
    state.editingDraftNewBlock = false;
    store.state.activeDocumentText = result;
    computeFindMatches();
    renderMarkdownMode();
    showToast(`已全部替换 ${count} 处`, 'success', { duration: 2000 });
  }

  // =========================================================================
  // Rendering: Markdown / TXT Mode (3-mode: 实时阅览 | 纯源码 | 🧠 脑图)
  // =========================================================================
  function mountMindMapStage() {
    const doc = state.activeDoc;
    const stageEl = containerEl.querySelector('[data-role="mindmap-stage"]');
    if (!doc || !stageEl) return;

    renderMindMap(stageEl, {
      markdown: doc.content || '',
      docName: doc.name,
      onUpdateMarkdown(newMd) {
        pushUndoSnapshot(doc.content, { immediate: true });
        doc.content = String(newMd ?? '');
        state.dirty = true;
        store.state.activeDocumentText = doc.content;
        updateMdDirtyIndicators();
      },
      onAnchorClick(anchorOrEl) {
        if (anchorOrEl instanceof HTMLElement) {
          handleAnchorClick(anchorOrEl);
        } else if (anchorOrEl && typeof anchorOrEl === 'object') {
          store.emit('anchor:jump', anchorOrEl);
        }
      },
      onFocusNode(title, seconds = 1500) {
        store.emit('focus:start', {
          title: title || doc.name,
          seconds: Number(seconds) || 1500,
        });
      },
      async onAiGenerate() {
        const res = await api.post('/api/ai/mindmap', {
          text: doc.content || '',
          file_path: doc.path,
        });
        const outline = String(res?.markdown || res?.outline || res?.content || '').trim();
        if (!outline) {
          showToast('AI 未返回有效脑图大纲', 'warning');
          return null;
        }
        openSheet({
          title: `AI 提炼脑图大纲 · ${doc.name}`,
          bodyHtml: `
            <div style="display:flex;flex-direction:column;gap:10px;">
              <p style="margin:0;font-size:12.5px;color:var(--text-secondary);">以下为 AI 生成的结构化 Markdown 大纲，可预览并应用到当前文档：</p>
              <div class="glass-card md-preview" style="padding:12px 14px;max-height:46vh;overflow-y:auto;">
                ${renderMarkdownSafe(outline, { withLineMap: false })}
              </div>
            </div>
          `,
          footerHtml: `
            <button type="button" class="pill-btn" id="ai-mm-cancel">取消</button>
            <button type="button" class="pill-btn" id="ai-mm-copy">${icon('copy', 13)} 复制大纲</button>
            <button type="button" class="pill-btn pill-btn-primary" id="ai-mm-apply">${icon('check', 13)} 应用到当前脑图</button>
          `,
          onMount(card) {
            card.querySelector('#ai-mm-cancel')?.addEventListener('click', closeSheet);
            card.querySelector('#ai-mm-copy')?.addEventListener('click', () => {
              copyInternal(outline, '已复制 AI 脑图大纲');
            });
            card.querySelector('#ai-mm-apply')?.addEventListener('click', () => {
              pushUndoSnapshot(doc.content, { immediate: true });
              doc.content = outline;
              state.dirty = true;
              state.editingBlockIdx = null;
              state.editingBlockRange = null;
              store.state.activeDocumentText = outline;
              closeSheet();
              renderMarkdownMode();
              showToast('已应用 AI 脑图大纲（Ctrl+S 保存）', 'success');
            });
          },
        });
        return outline;
      },
    });
  }

  function syncBlockEditorHeight(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(28, ta.scrollHeight)}px`;
  }

  function renderLiveBlocksHtml(doc) {
    const blocks = parseMarkdownBlocks(doc.content || '');
    const editingIdx = state.editingBlockIdx;
    const draftNew = state.editingDraftNewBlock && editingIdx === blocks.length;

    const blocksHtml = blocks
      .map((blk, idx) => {
        const isEditing = editingIdx === idx;
        if (isEditing) {
          state.editingBlockRange = { startLine: blk.startLine, endLine: blk.endLine };
          return `
            <div class="lp-block is-editing" data-block-idx="${idx}" data-md-start="${blk.startLine}" data-md-end="${blk.endLine}">
              <textarea class="lp-block-editor" data-block-idx="${idx}" spellcheck="false" rows="1">${escapeHtml(blk.raw)}</textarea>
            </div>
          `;
        }
        return `
          <div class="lp-block" data-block-idx="${idx}" data-md-start="${blk.startLine}" data-md-end="${blk.endLine}">
            <div class="lp-block-view" data-md-start="${blk.startLine}" data-md-end="${blk.endLine}">
              ${renderMarkdownSafe(blk.raw, { withLineMap: false })}
            </div>
          </div>
        `;
      })
      .join('');

    let draftHtml = '';
    if (draftNew) {
      const totalLines = getMdLines().length;
      const startLine = Math.max(0, totalLines - 1);
      state.editingBlockRange = { startLine, endLine: startLine };
      draftHtml = `
        <div class="lp-block is-editing" data-block-idx="${blocks.length}" data-md-start="${startLine}" data-md-end="${startLine}" data-draft-block="1">
          <textarea class="lp-block-editor" data-block-idx="${blocks.length}" spellcheck="false" rows="1" placeholder="输入内容，支持 # 标题、- 列表、[[文件名]] 胶囊…"></textarea>
        </div>
      `;
    }

    return `
      <div class="md-scroll-area">
        <div class="lp-container md-preview">
          ${blocksHtml}
          ${draftHtml}
          <div class="lp-add-block-zone" data-action="lp-add-block" role="button" tabindex="0">
            ${blocks.length === 0 && !draftNew ? '+ 点击此处开始书写笔记（支持 # 标题、代码块、[[文件锚点]]）…' : '+ 点击此处继续书写…'}
          </div>
        </div>
      </div>
    `;
  }

  function focusActiveBlockEditor(cursorMode = 'end') {
    window.requestAnimationFrame(() => {
      const ta = containerEl.querySelector('.lp-block-editor');
      if (!ta) return;
      syncBlockEditorHeight(ta);
      ta.focus();
      const len = ta.value.length;
      if (cursorMode === 'start') {
        ta.setSelectionRange(0, 0);
      } else if (typeof cursorMode === 'number' && Number.isFinite(cursorMode)) {
        const pos = Math.max(0, Math.min(len, cursorMode));
        ta.setSelectionRange(pos, pos);
      } else {
        ta.setSelectionRange(len, len);
      }
    });
  }

  function cleanupEmptyTrailingDraftIfNeeded() {
    if (!state.editingDraftNewBlock || !state.activeDoc) return;
    state.editingDraftNewBlock = false;
    const raw = String(state.activeDoc.content ?? '').replace(/\r\n/g, '\n');
    const blocks = parseMarkdownBlocks(raw);
    if (blocks.length === 0) {
      state.activeDoc.content = '';
    } else {
      const lastEnd = blocks[blocks.length - 1].endLine;
      const lines = raw.split('\n');
      if (lines.length > lastEnd + 2) {
        state.activeDoc.content = `${lines.slice(0, lastEnd + 1).join('\n')}\n`;
      }
    }
    store.state.activeDocumentText = state.activeDoc.content;
  }

  function commitActiveBlock({ reRender = true } = {}) {
    if (state.editingBlockIdx === null && !state.editingDraftNewBlock) return false;
    const doc = state.activeDoc;
    const ta = containerEl.querySelector('.lp-block-editor');
    if (doc && ta) {
      const val = ta.value.replace(/\r\n/g, '\n');
      if (state.editingDraftNewBlock && !val.trim()) {
        cleanupEmptyTrailingDraftIfNeeded();
      } else {
        state.editingDraftNewBlock = false;
        if (!val.trim() && state.editingBlockRange) {
          // If an existing block was cleared completely, collapse surrounding redundant blank lines cleanly
          const { startLine, endLine } = state.editingBlockRange;
          const lines = getMdLines();
          let delStart = startLine;
          let delCount = endLine - startLine + 1;
          if (delStart > 0 && lines[delStart - 1].trim() === '' && delStart + delCount < lines.length && lines[delStart + delCount].trim() === '') {
            delCount += 1;
          }
          lines.splice(delStart, delCount);
          doc.content = lines.join('\n').replace(/^\n+/, '');
          store.state.activeDocumentText = doc.content;
        }
      }
    } else {
      state.editingDraftNewBlock = false;
    }

    state.editingBlockIdx = null;
    state.editingBlockRange = null;
    if (reRender && doc && (doc.type === 'markdown' || doc.type === 'text') && state.mdMode === 'live') {
      renderMarkdownMode();
    }
    return true;
  }

  function activateBlockByStartLine(targetStartLine, cursorMode = 'end') {
    const doc = state.activeDoc;
    if (!doc || state.mdMode !== 'live') return;
    const prevRangeStart = state.editingBlockRange?.startLine ?? Infinity;
    const prevLineCount = getMdLines().length;
    commitActiveBlock({ reRender: false });
    const lineDelta = getMdLines().length - prevLineCount;
    const adjustedLine =
      lineDelta !== 0 && prevRangeStart < targetStartLine
        ? Math.max(0, targetStartLine + lineDelta)
        : targetStartLine;
    const blocks = parseMarkdownBlocks(doc.content || '');
    let idx = blocks.findIndex((b) => b.startLine === adjustedLine);
    if (idx === -1) {
      idx = blocks.findIndex((b) => adjustedLine >= b.startLine && adjustedLine <= b.endLine);
    }
    if (idx === -1) return;
    state.editingBlockIdx = idx;
    state.editingDraftNewBlock = false;
    renderMarkdownMode();
    focusActiveBlockEditor(cursorMode);
  }

  function activateBlockByIndex(targetIdx, cursorMode = 'end') {
    const doc = state.activeDoc;
    if (!doc || state.mdMode !== 'live') return;
    commitActiveBlock({ reRender: false });
    const blocks = parseMarkdownBlocks(doc.content || '');
    if (targetIdx < 0 || targetIdx >= blocks.length) {
      renderMarkdownMode();
      return;
    }
    state.editingBlockIdx = targetIdx;
    state.editingDraftNewBlock = false;
    renderMarkdownMode();
    focusActiveBlockEditor(cursorMode);
  }

  function appendNewBlockAndFocus() {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
    commitActiveBlock({ reRender: false });
    const blocks = parseMarkdownBlocks(doc.content || '');
    const normalized = String(doc.content ?? '').replace(/\r\n/g, '\n');
    if (blocks.length > 0 && !normalized.endsWith('\n\n')) {
      const trimmedEnd = normalized.replace(/\n+$/g, '');
      doc.content = `${trimmedEnd}\n\n`;
    } else if (!normalized.trim()) {
      doc.content = '';
    }
    state.editingBlockIdx = blocks.length;
    state.editingDraftNewBlock = true;
    store.state.activeDocumentText = doc.content;
    renderMarkdownMode();
    focusActiveBlockEditor('start');
  }

  function renderMarkdownMode() {
    hideFormatBar();
    removeDropInsertLine();
    const doc = state.activeDoc;
    if (!doc) return;
    const isMd = doc.type === 'markdown';
    if (!isMd && state.mdMode === 'mindmap') {
      state.mdMode = 'live';
    }
    if (!['live', 'source', 'mindmap'].includes(state.mdMode)) {
      state.mdMode = 'live';
    }
    const mode = state.mdMode;
    const isLive = mode === 'live';
    const isSource = mode === 'source';
    const isMindmap = mode === 'mindmap';
    const segIdx = isMd ? (isLive ? 0 : isSource ? 1 : 2) : (isLive ? 0 : 1);
    const thumbWidth = isMd ? 'calc(33.333% - 3px)' : 'calc(50% - 3px)';

    const prevScrollEl = containerEl.querySelector('.md-scroll-area') || containerEl.querySelector('.md-editor:not([data-role])');
    const prevScrollTop = prevScrollEl ? prevScrollEl.scrollTop : 0;

    const canUndo = state.history.undoStack.length > 0 || state.history.typingBaseline !== null;
    const canRedo = state.history.redoStack.length > 0;

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
          <span data-role="backlinks-slot">${renderBacklinksSlotHtml()}</span>
        </div>

        <div class="center-toolbar-group">
          <div class="segmented-pill" data-seg="md-mode" role="tablist" aria-label="文档模式切换">
            <div class="segmented-thumb" style="width:${thumbWidth}; transform:translateX(${segIdx * 100}%);"></div>
            <button type="button" class="segmented-btn ${isLive ? 'is-active' : ''}" data-md-mode="live" role="tab" aria-selected="${isLive}">
              实时阅览
            </button>
            <button type="button" class="segmented-btn ${isSource ? 'is-active' : ''}" data-md-mode="source" role="tab" aria-selected="${isSource}">
              纯源码
            </button>
            ${
              isMd
                ? `<button type="button" class="segmented-btn ${isMindmap ? 'is-active' : ''}" data-md-mode="mindmap" role="tab" aria-selected="${isMindmap}">
                    🧠 脑图
                  </button>`
                : ''
            }
          </div>

          <div style="display:inline-flex;align-items:center;gap:3px;">
            <button type="button" class="pill-btn pill-btn-sm" data-action="md-undo" title="撤回 (Ctrl+Z)" ${canUndo ? '' : 'disabled'} style="padding:0 8px;min-width:28px;">↶</button>
            <button type="button" class="pill-btn pill-btn-sm" data-action="md-redo" title="重做 (Ctrl+Y / Ctrl+Shift+Z)" ${canRedo ? '' : 'disabled'} style="padding:0 8px;min-width:28px;">↷</button>
          </div>

          ${renderTypographyControlsHtml(false)}

          <button type="button" class="pill-btn pill-btn-sm ${state.dirty ? 'pill-btn-primary' : ''}" data-action="md-save" title="保存 (Ctrl+S / Cmd+S)">
            ${icon('save', 13)} 保存
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="ai-polish" title="AI 润色排版当前内容">
            ${icon('sparkles', 13)} 润色
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="open-snapshots" title="查看与回滚写前安全快照">
            ${icon('rotate-ccw', 13)} 历史快照
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="ai-summarize" title="发送到右侧 AI 提炼摘要与待办">
            ${icon('sparkles', 13)} AI 总结
          </button>
        </div>
      </div>

      ${renderFindBarHtml()}

      ${
        isMindmap
          ? `<div data-role="mindmap-stage" style="flex:1 1 auto; min-height:0; min-width:0; position:relative; overflow:hidden; display:flex; flex-direction:column;"></div>`
          : isLive
          ? renderLiveBlocksHtml(doc)
          : `<div style="flex:1 1 auto; min-height:0; min-width:0; display:flex; flex-direction:column; overflow:hidden;"><textarea class="md-editor" spellcheck="false" placeholder="随时记录想法、笔记或输入 [[文件名.pdf#page=1]] / [[表格.xlsx#Sheet1!C4]] / [[app:应用名]]...">${escapeHtml(doc.content || '')}</textarea></div>`
      }
    `;
    ensureDropOverlay();

    if (isMindmap) {
      mountMindMapStage();
    } else if (isLive) {
      const nextScrollEl = containerEl.querySelector('.md-scroll-area');
      if (nextScrollEl && prevScrollTop > 0) {
        nextScrollEl.scrollTop = prevScrollTop;
      }
      const activeTa = containerEl.querySelector('.lp-block-editor');
      if (activeTa) {
        syncBlockEditorHeight(activeTa);
      }
      if (state.justDroppedTarget) {
        const dropInfo = state.justDroppedTarget;
        state.justDroppedTarget = null;
        const lpBlocks = Array.from(containerEl.querySelectorAll('.lp-container .lp-block'));
        let targetBlk =
          (Number.isFinite(dropInfo.actualStartLine)
            ? lpBlocks.find((b) => Number(b.dataset.mdStart) === dropInfo.actualStartLine)
            : null) ||
          (dropInfo.prefix
            ? lpBlocks.find((b) => (b.textContent || '').includes(dropInfo.prefix))
            : null) ||
          lpBlocks.find((b) => Number(b.dataset.mdStart) >= dropInfo.lineIdx) ||
          lpBlocks[lpBlocks.length - 1];
        if (targetBlk) {
          targetBlk.classList.add('just-dropped');
          targetBlk.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          window.setTimeout(() => {
            targetBlk.classList.remove('just-dropped');
          }, 1300);
        }
      }
      if (state.findBar.open && state.findBar.query) {
        applyLiveFindHighlights({ scrollToActive: false });
      }
    } else if (isSource) {
      const ta = containerEl.querySelector('.md-editor:not([data-role])');
      if (ta && prevScrollTop > 0) {
        ta.scrollTop = prevScrollTop;
      }
    }
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
    updateMdUndoRedoButtons();
  }

  // =========================================================================
  // Pain Point #10: AI Polish Sheet
  // =========================================================================
  async function openAiPolishSheet() {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
    const rawText = String(doc.content || '').trim();
    if (!rawText) {
      showToast('当前文档内容为空，无需润色', 'warning');
      return;
    }

    openSheet({
      title: `AI 文章润色 · ${doc.name}`,
      bodyHtml: `
        <div class="empty-state" style="padding:28px 12px;">
          <p class="empty-title">正在进行 AI 润色与结构优化…</p>
          <p class="empty-desc">保持原意与锚点语法，优化表达流畅度与排版层级</p>
        </div>
      `,
      footerHtml: `<button type="button" class="pill-btn" id="polish-close">取消</button>`,
      async onMount(card) {
        card.querySelector('#polish-close')?.addEventListener('click', closeSheet);
        const bodyEl = card.querySelector('.sheet-body');
        const footerEl = card.querySelector('.sheet-footer');
        try {
          const res = await api.post('/api/ai/polish', {
            text: doc.content || '',
            style: 'article',
          });
          const polished = String(res?.polished || res?.result || res?.text || res?.content || '').trim();
          if (!polished) {
            if (bodyEl) {
              bodyEl.innerHTML = `<div class="empty-state"><p class="empty-title">AI 未返回润色内容</p></div>`;
            }
            return;
          }
          if (bodyEl) {
            bodyEl.innerHTML = `
              <div style="display:flex;flex-direction:column;gap:10px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                  <span style="font-size:12px;color:var(--text-secondary);">原文 ${rawText.length} 字 → 润色后 ${polished.length} 字</span>
                  <div class="segmented-pill" role="tablist">
                    <div class="segmented-thumb" data-role="polish-thumb" style="width:calc(50% - 3px);transform:translateX(0%);"></div>
                    <button type="button" class="segmented-btn is-active" data-polish-view="preview" style="height:24px;font-size:11.5px;">预览效果</button>
                    <button type="button" class="segmented-btn" data-polish-view="raw" style="height:24px;font-size:11.5px;">Markdown 源码</button>
                  </div>
                </div>
                <div data-role="polish-preview" class="glass-card md-preview" style="padding:12px 14px;max-height:48vh;overflow-y:auto;">
                  ${renderMarkdownSafe(polished, { withLineMap: false })}
                </div>
                <textarea data-role="polish-raw" class="apple-textarea" rows="12" style="display:none;font-family:var(--font-mono);font-size:12.5px;">${escapeHtml(polished)}</textarea>
              </div>
            `;

            const thumb = bodyEl.querySelector('[data-role="polish-thumb"]');
            const prevBox = bodyEl.querySelector('[data-role="polish-preview"]');
            const rawBox = bodyEl.querySelector('[data-role="polish-raw"]');
            bodyEl.querySelectorAll('[data-polish-view]').forEach((btn) => {
              btn.addEventListener('click', () => {
                const isRaw = btn.dataset.polishView === 'raw';
                bodyEl.querySelectorAll('[data-polish-view]').forEach((b) => b.classList.toggle('is-active', b === btn));
                if (thumb) thumb.style.transform = `translateX(${isRaw ? '100%' : '0%'})`;
                if (prevBox) prevBox.style.display = isRaw ? 'none' : 'block';
                if (rawBox) rawBox.style.display = isRaw ? 'block' : 'none';
              });
            });
          }

          if (footerEl) {
            footerEl.innerHTML = `
              <button type="button" class="pill-btn" id="polish-cancel">取消</button>
              <button type="button" class="pill-btn" id="polish-copy">${icon('copy', 13)} 复制</button>
              <button type="button" class="pill-btn pill-btn-primary" id="polish-apply">${icon('check', 13)} 应用替换</button>
            `;
            footerEl.querySelector('#polish-cancel')?.addEventListener('click', closeSheet);
            footerEl.querySelector('#polish-copy')?.addEventListener('click', () => {
              const latest = bodyEl?.querySelector('[data-role="polish-raw"]')?.value || polished;
              copyInternal(latest, '已复制润色文本');
            });
            footerEl.querySelector('#polish-apply')?.addEventListener('click', () => {
              const latest = bodyEl?.querySelector('[data-role="polish-raw"]')?.value ?? polished;
              pushUndoSnapshot(doc.content, { immediate: true });
              doc.content = latest;
              state.dirty = true;
              state.editingBlockIdx = null;
              state.editingBlockRange = null;
              store.state.activeDocumentText = latest;
              closeSheet();
              renderMarkdownMode();
              showToast('已应用 AI 润色结果（Ctrl+S 保存）', 'success');
            });
          }
        } catch (err) {
          if (bodyEl) {
            bodyEl.innerHTML = `<div class="empty-state"><p class="empty-title">AI 润色失败</p><p class="empty-desc">${escapeHtml(getErrorMsg(err))}</p></div>`;
          }
        }
      },
    });
  }

  function triggerAiPolish() {
    openAiPolishSheet();
  }

  // =========================================================================
  // Pain Point #7: Live-Preview WYSIWYG Selection Toolbar
  // =========================================================================
  function getMdLines() {
    return String(state.activeDoc?.content ?? '').replace(/\r\n/g, '\n').split('\n');
  }

  function commitMdContentChange(nextContent, { toastMsg = '', pushUndo = true } = {}) {
    if (!state.activeDoc) return;
    if (pushUndo) {
      pushUndoSnapshot(state.activeDoc.content, { immediate: true });
    }
    state.activeDoc.content = nextContent;
    state.dirty = true;
    state.editingBlockIdx = null;
    state.editingBlockRange = null;
    store.state.activeDocumentText = nextContent;
    renderMarkdownMode();
    if (toastMsg) {
      showToast(toastMsg, 'success', { duration: 1800 });
    }
  }

  function applyPreviewFormatAction(fmtAction) {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
    const ctx = activeFormatContext;
    if (!ctx) return;

    const lines = getMdLines();
    const hasLineRange = Number.isFinite(ctx.startIdx) && ctx.startIdx >= 0 && ctx.startIdx < lines.length;
    const sIdx = hasLineRange ? ctx.startIdx : 0;
    const eIdx = hasLineRange ? Math.min(lines.length - 1, Math.max(sIdx, ctx.endIdx)) : lines.length - 1;
    const selectedText = String(ctx.selectedText || '').trim();

    if (fmtAction === 'bold' || fmtAction === 'mark' || fmtAction === 'code') {
      const wrapMap = {
        bold: ['**', '**'],
        mark: ['<mark>', '</mark>'],
        code: ['`', '`'],
      };
      const [pre, post] = wrapMap[fmtAction];
      if (selectedText) {
        if (hasLineRange) {
          const sliceStr = lines.slice(sIdx, eIdx + 1).join('\n');
          const pos = sliceStr.indexOf(selectedText);
          if (pos >= 0) {
            const replaced = `${sliceStr.slice(0, pos)}${pre}${selectedText}${post}${sliceStr.slice(pos + selectedText.length)}`;
            const nextSlice = replaced.split('\n');
            lines.splice(sIdx, eIdx - sIdx + 1, ...nextSlice);
            hideFormatBar();
            commitMdContentChange(lines.join('\n'));
            return;
          }
        }
        const full = lines.join('\n');
        const globalPos = full.indexOf(selectedText);
        if (globalPos >= 0) {
          const nextFull = `${full.slice(0, globalPos)}${pre}${selectedText}${post}${full.slice(globalPos + selectedText.length)}`;
          hideFormatBar();
          commitMdContentChange(nextFull);
          return;
        }
      }
      if (hasLineRange) {
        lines[sIdx] = `${pre}${lines[sIdx]}${post}`;
        hideFormatBar();
        commitMdContentChange(lines.join('\n'));
      }
      return;
    }

    if (!hasLineRange) {
      showToast('未能定位该段落源码行，请切换编辑模式修改', 'warning');
      hideFormatBar();
      return;
    }

    const slice = lines.slice(sIdx, eIdx + 1);
    let transformed = slice;

    if (fmtAction === 'h1') {
      transformed = slice.map((ln, idx) => (idx === 0 ? `# ${ln.replace(/^#{1,6}\s*/, '').trim()}` : ln));
    } else if (fmtAction === 'h2') {
      transformed = slice.map((ln, idx) => (idx === 0 ? `## ${ln.replace(/^#{1,6}\s*/, '').trim()}` : ln));
    } else if (fmtAction === 'quote') {
      transformed = slice.map((ln) => (ln.trim().startsWith('>') ? ln : `> ${ln}`));
    } else if (fmtAction === 'todo') {
      transformed = slice.map((ln) => {
        const cleaned = ln.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?)?/, '').trim();
        return cleaned ? `- [ ] ${cleaned}` : ln;
      });
    } else if (fmtAction === 'tip') {
      transformed = slice.map((ln, idx) =>
        idx === 0 ? `> 💡 **提示**：${ln.replace(/^\s*>\s*/, '').trim()}` : `> ${ln.replace(/^\s*>\s*/, '')}`
      );
    } else if (fmtAction === 'warn') {
      transformed = slice.map((ln, idx) =>
        idx === 0 ? `> ⚠️ **易错提醒**：${ln.replace(/^\s*>\s*/, '').trim()}` : `> ${ln.replace(/^\s*>\s*/, '')}`
      );
    }

    lines.splice(sIdx, eIdx - sIdx + 1, ...transformed);
    hideFormatBar();
    commitMdContentChange(lines.join('\n'));
  }

  function maybeShowPreviewFormatBar() {
    if (!state.activeDoc || (state.activeDoc.type !== 'markdown' && state.activeDoc.type !== 'text')) {
      hideFormatBar();
      return;
    }
    if (state.mdMode !== 'live') {
      hideFormatBar();
      return;
    }
    const previewEl = containerEl.querySelector('.lp-container') || containerEl.querySelector('.md-preview');
    if (!previewEl) {
      hideFormatBar();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hideFormatBar();
      return;
    }
    const selectedText = sel.toString().trim();
    if (!selectedText) {
      hideFormatBar();
      return;
    }

    const range = sel.getRangeAt(0);
    const commonEl = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!commonEl || !previewEl.contains(commonEl)) {
      hideFormatBar();
      return;
    }
    if (
      commonEl.closest('.lp-block.is-editing') ||
      commonEl.closest('.lp-block-editor') ||
      commonEl.closest('[data-role="inline-block-editor-wrap"]') ||
      commonEl.closest('.anchor-pill') ||
      commonEl.closest('.media-embed-card')
    ) {
      hideFormatBar();
      return;
    }

    const blockEl = commonEl.closest('.lp-block[data-md-start]') || commonEl.closest('[data-md-start]');
    const startIdx = blockEl ? Number.parseInt(blockEl.dataset.mdStart, 10) : NaN;
    const endIdx = blockEl ? Number.parseInt(blockEl.dataset.mdEnd ?? blockEl.dataset.mdStart, 10) : startIdx;

    activeFormatContext = {
      startIdx,
      endIdx: Number.isFinite(endIdx) ? endIdx : startIdx,
      selectedText,
    };

    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hideFormatBar();
      return;
    }

    if (!activeFormatBar) {
      activeFormatBar = document.createElement('div');
      activeFormatBar.className = 'preview-format-bar';
      activeFormatBar.style.cssText = [
        'position:fixed',
        'z-index:85',
        'display:inline-flex',
        'align-items:center',
        'gap:3px',
        'flex-wrap:wrap',
        'max-width:calc(100vw - 24px)',
        'padding:4px 8px',
        'border-radius:9999px',
        'background:rgba(24,24,27,0.92)',
        'color:#F5F5F7',
        'backdrop-filter:blur(18px) saturate(180%)',
        '-webkit-backdrop-filter:blur(18px) saturate(180%)',
        'border:1px solid rgba(255,255,255,0.16)',
        'box-shadow:0 12px 32px rgba(0,0,0,0.28)',
      ].join(';');

      const btns = [
        ['h1', 'H1'],
        ['h2', 'H2'],
        ['bold', '加粗'],
        ['mark', '高亮'],
        ['quote', '引用'],
        ['todo', '待办'],
        ['tip', '💡提示框'],
        ['warn', '⚠易错框'],
        ['code', '代码'],
      ];
      activeFormatBar.innerHTML = btns
        .map(
          ([act, label]) => `
            <button type="button" data-fmt-act="${act}" style="height:24px;padding:0 8px;border-radius:9999px;font-size:11.5px;font-weight:500;color:#F5F5F7;background:rgba(255,255,255,0.08);white-space:nowrap;">
              ${escapeHtml(label)}
            </button>
          `
        )
        .join('');

      activeFormatBar.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
      });
      activeFormatBar.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-fmt-act]');
        if (!b) return;
        ev.stopPropagation();
        applyPreviewFormatAction(b.dataset.fmtAct);
      });
      document.body.appendChild(activeFormatBar);
    }

    const barRect = activeFormatBar.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const clampedLeft = Math.min(
      Math.max(12, centerX - barRect.width / 2),
      Math.max(12, window.innerWidth - barRect.width - 12)
    );
    const topPos = rect.top - barRect.height - 10 >= 10 ? rect.top - barRect.height - 10 : rect.bottom + 10;
    activeFormatBar.style.left = `${Math.round(clampedLeft)}px`;
    activeFormatBar.style.top = `${Math.round(topPos)}px`;
  }

  // =========================================================================
  // V4 Inline Media Card Token Resize Helper
  // =========================================================================
  function resolveMediaCardFileRef(card, triggerEl = null) {
    const candidates = [
      triggerEl?.dataset?.mediaFile,
      triggerEl?.dataset?.file,
      card?.dataset?.mediaFile,
      card?.dataset?.file,
      card?.dataset?.anchorFile,
    ];
    for (const c of candidates) {
      if (c && String(c).trim()) return String(c).trim();
    }
    const rawTok =
      card?.dataset?.mediaRaw ||
      card?.dataset?.mediaToken ||
      card?.dataset?.rawToken ||
      card?.dataset?.token ||
      '';
    if (rawTok) {
      const inner = rawTok.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0].split('#')[0].trim();
      if (inner) return inner;
    }
    const mediaNode = card?.querySelector('img, video');
    const srcAttr = mediaNode?.getAttribute('src') || '';
    const match = srcAttr.match(/[?&]path=([^&]+)/);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        // ignore decode error
      }
    }
    const alt = mediaNode?.getAttribute('alt') || '';
    return alt.trim();
  }

  function replaceMediaTokenWidth(innerToken, newW) {
    const clean = String(innerToken || '').trim();
    if (!clean) return clean;
    if (/\|\s*w\s*=\s*\d+(?:px)?/i.test(clean)) {
      return clean.replace(/\|\s*w\s*=\s*\d+(?:px)?/i, `|w=${newW}`);
    }
    return `${clean}|w=${newW}`;
  }

  function commitMediaCardWidth(card, rawWidthPx) {
    const doc = state.activeDoc;
    const isMainEditable = doc && (doc.type === 'markdown' || doc.type === 'text');
    const isCompanion = doc && !isMainEditable && hasCompanionNote(doc);
    if (!card || (!isMainEditable && !isCompanion)) return;
    const newW = Math.max(160, Math.min(960, Math.round(Number(rawWidthPx) || 420)));
    card.style.width = `${newW}px`;
    card.style.maxWidth = '100%';
    card.dataset.mediaWidth = String(newW);

    const widthLabel = card.querySelector('[data-role="media-width-label"]');
    if (widthLabel) widthLabel.textContent = `${newW}px`;

    const rawTokAttr =
      card.dataset.anchorRaw ||
      card.dataset.mediaRaw ||
      card.dataset.mediaToken ||
      card.dataset.rawToken ||
      card.dataset.token ||
      '';
    const fileRef = resolveMediaCardFileRef(card);
    const baseName = getBaseName(fileRef);

    const replaceInRange = (sourceStr, tokHint, fName, occurrenceIdx = 0) => {
      if (tokHint) {
        const inner = tokHint.replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
        const exact = `[[${inner}]]`;
        const idx = sourceStr.indexOf(exact);
        if (idx >= 0) {
          const nextInner = replaceMediaTokenWidth(inner, newW);
          return {
            text: `${sourceStr.slice(0, idx)}[[${nextInner}]]${sourceStr.slice(idx + exact.length)}`,
            nextInner,
          };
        }
      }
      if (fName) {
        const re = new RegExp(`\\[\\[([^\\[\\]]*?${escapeRegExp(fName)}[^\\[\\]]*?)\\]\\]`, 'g');
        let match;
        let seen = 0;
        while ((match = re.exec(sourceStr)) !== null) {
          if (seen === occurrenceIdx) {
            const nextInner = replaceMediaTokenWidth(match[1], newW);
            return {
              text: `${sourceStr.slice(0, match.index)}[[${nextInner}]]${sourceStr.slice(match.index + match[0].length)}`,
              nextInner,
            };
          }
          seen += 1;
        }
      }
      return null;
    };

    const prevContent = isMainEditable ? String(doc.content || '') : String(doc.companionContent || '');
    const blockEl = isMainEditable ? card.closest('.lp-block[data-md-start]') : null;
    let updated = null;

    if (blockEl) {
      const sIdx = Number.parseInt(blockEl.dataset.mdStart, 10);
      const eIdx = Number.parseInt(blockEl.dataset.mdEnd ?? blockEl.dataset.mdStart, 10);
      if (Number.isFinite(sIdx) && sIdx >= 0) {
        const lines = getMdLines();
        const slice = lines.slice(sIdx, Math.max(sIdx, eIdx) + 1).join('\n');
        const cardsInBlock = Array.from(blockEl.querySelectorAll('.media-embed-card'));
        const sameFileIdx = cardsInBlock
          .filter((c) => getBaseName(resolveMediaCardFileRef(c)) === baseName)
          .indexOf(card);
        const res = replaceInRange(slice, rawTokAttr, baseName, Math.max(0, sameFileIdx));
        if (res) {
          lines.splice(sIdx, Math.max(sIdx, eIdx) - sIdx + 1, ...res.text.split('\n'));
          updated = { text: lines.join('\n'), nextInner: res.nextInner };
        }
      }
    }

    if (!updated) {
      const allCards = Array.from(containerEl.querySelectorAll('.media-embed-card'));
      const globalIdx = allCards
        .filter((c) => getBaseName(resolveMediaCardFileRef(c)) === baseName)
        .indexOf(card);
      updated = replaceInRange(prevContent, rawTokAttr, baseName, Math.max(0, globalIdx));
    }

    if (updated && updated.text !== prevContent) {
      const nextToken = `[[${updated.nextInner}]]`;
      card.dataset.mediaRaw = nextToken;
      card.dataset.anchorRaw = nextToken;
      if (card.dataset.mediaToken !== undefined) card.dataset.mediaToken = updated.nextInner;
      if (card.dataset.rawToken !== undefined) card.dataset.rawToken = nextToken;
      if (card.dataset.token !== undefined) card.dataset.token = updated.nextInner;

      if (isMainEditable) {
        pushUndoSnapshot(prevContent, { immediate: true });
        doc.content = updated.text;
        state.dirty = true;
        store.state.activeDocumentText = updated.text;
        updateMdDirtyIndicators();
      } else {
        doc.companionContent = updated.text;
        state.pdf.companionDirty = true;
        store.state.activeDocumentText = updated.text;
        const compTa = containerEl.querySelector('[data-role="pdf-companion-editor"]');
        if (compTa) compTa.value = updated.text;
      }
      showToast(`已调整预览宽度：${newW}px`, 'success', { duration: 1600 });
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
    hideFormatBar();
    removeDropInsertLine();
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
          <span data-role="backlinks-slot">${renderBacklinksSlotHtml()}</span>
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
          <button type="button" class="pill-btn pill-btn-sm" data-action="open-folder" title="打开所在文件夹">
            ${icon('folder-open', 13)} 打开位置
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

  async function saveExcelChanges({ silent = false, toastMessage = '' } = {}) {
    if (!state.activeDoc || state.activeDoc.type !== 'excel') return false;
    const ex = state.excel;
    if (ex.pendingChanges.size === 0) {
      if (!silent) showToast('当前表格暂无待保存的修改', 'info', { duration: 1800 });
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
      showToast(
        toastMessage || `已保存 ${res?.updated ?? changes.length} 处修改（已创建写前安全快照）`,
        'success'
      );
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
          <div class="sheet-footer-split">
            <button type="button" class="pill-btn pill-btn-primary" data-sheet-act="save">💾 保存并切换</button>
            <button type="button" class="pill-btn pill-btn-danger" data-sheet-act="discard">丢弃并切换</button>
            <button type="button" class="pill-btn" data-sheet-act="cancel">取消</button>
          </div>
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
  // Rendering: PDF HD PyMuPDF Viewer + Iframe Toggle + Companion Note + AI MindMap
  // =========================================================================
  function buildPdfStreamSrc() {
    const p = encodeURIComponent(state.activeDoc.path);
    return `/api/files/pdf-stream?path=${p}&_t=${state.pdf.cacheBust}#page=${state.pdf.currentPage}`;
  }

  function buildPdfPageImgSrc() {
    const p = encodeURIComponent(state.activeDoc.path);
    const page = state.pdf.currentPage || 1;
    const zoom = Number(state.pdf.zoom || 1.6).toFixed(2);
    return `/api/files/pdf-page?path=${p}&page=${page}&zoom=${zoom}&_t=${state.pdf.cacheBust}`;
  }

  function renderPdfViewerStage() {
    const doc = state.activeDoc;
    const pdf = state.pdf;
    const wrap = containerEl.querySelector('[data-role="pdf-frame-wrap"]');
    if (!wrap || !doc) return;

    if (pdf.viewMode === 'iframe') {
      wrap.innerHTML = `<iframe class="pdf-frame" src="${buildPdfStreamSrc()}" title="${escapeHtml(doc.name)}"></iframe>`;
      return;
    }

    const zoomPct = Math.round((pdf.zoom || 1.6) * 100);
    wrap.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;min-height:0;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;padding:7px 12px;border-bottom:1px solid var(--border-hairline);background:var(--bg-glass);flex-shrink:0;">
          <div style="display:inline-flex;align-items:center;gap:6px;">
            <button type="button" class="pill-btn pill-btn-sm" data-action="pdf-prev-page" ${pdf.currentPage <= 1 ? 'disabled' : ''} title="上一页 (←)">上一页</button>
            <span data-role="pdf-stage-page-label" style="font-size:12px;font-weight:600;color:var(--text-secondary);">第 ${pdf.currentPage} / ${pdf.totalPages} 页</span>
            <button type="button" class="pill-btn pill-btn-sm" data-action="pdf-next-page" ${pdf.currentPage >= pdf.totalPages ? 'disabled' : ''} title="下一页 (→)">下一页</button>
          </div>
          <div style="display:inline-flex;align-items:center;gap:4px;">
            <button type="button" class="pill-btn pill-btn-sm" data-action="pdf-zoom-out" ${pdf.zoom <= PDF_ZOOM_STEPS[0] ? 'disabled' : ''} title="缩小" style="width:28px;padding:0;">－</button>
            <span data-role="pdf-zoom-label" style="font-size:11.5px;font-weight:600;min-width:44px;text-align:center;color:var(--text-secondary);">${zoomPct}%</span>
            <button type="button" class="pill-btn pill-btn-sm" data-action="pdf-zoom-in" ${pdf.zoom >= PDF_ZOOM_STEPS[PDF_ZOOM_STEPS.length - 1] ? 'disabled' : ''} title="放大" style="width:28px;padding:0;">＋</button>
          </div>
        </div>
        <div class="pdf-hd-viewer" data-role="pdf-hd-viewer">
          <div data-role="pdf-hd-loading" style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);padding:6px 12px;border-radius:var(--radius-pill);background:var(--bg-island);border:1px solid var(--border-hairline);">
            正在高清渲染第 ${pdf.currentPage} 页…
          </div>
          <div data-role="pdf-hd-error" class="glass-card" style="display:none;text-align:center;max-width:300px;padding:16px;">
            <p class="empty-title" style="font-size:13px;">页面渲染失败</p>
            <p class="empty-desc" style="margin:6px 0 10px;">请检查本地 PDF 是否存在或切换原生预览</p>
            <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="pdf-hd-retry">重试渲染</button>
          </div>
          <div class="pdf-page-card" data-role="pdf-page-card" style="display:none;">
            <img class="pdf-page-img" data-role="pdf-page-img" src="${buildPdfPageImgSrc()}" alt="${escapeHtml(doc.name)} 第 ${pdf.currentPage} 页" />
          </div>
        </div>
      </div>
    `;

    const img = wrap.querySelector('[data-role="pdf-page-img"]');
    const loadingEl = wrap.querySelector('[data-role="pdf-hd-loading"]');
    const errorEl = wrap.querySelector('[data-role="pdf-hd-error"]');
    const cardEl = wrap.querySelector('[data-role="pdf-page-card"]');

    if (img) {
      state.pdf.imgLoading = true;
      state.pdf.imgError = false;
      img.addEventListener('load', () => {
        state.pdf.imgLoading = false;
        state.pdf.imgError = false;
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) errorEl.style.display = 'none';
        if (cardEl) cardEl.style.display = 'block';
      });
      img.addEventListener('error', () => {
        state.pdf.imgLoading = false;
        state.pdf.imgError = true;
        if (loadingEl) loadingEl.style.display = 'none';
        if (cardEl) cardEl.style.display = 'none';
        if (errorEl) errorEl.style.display = 'block';
      });
    }
  }

  function updatePdfFrameAndControls({ forceReload = false } = {}) {
    const doc = state.activeDoc;
    if (!doc || doc.type !== 'pdf') return;
    if (forceReload) {
      state.pdf.cacheBust = Date.now();
    }
    const pagePill = containerEl.querySelector('[data-role="pdf-page-label"]');
    if (pagePill) {
      pagePill.textContent = `第 ${state.pdf.currentPage} / ${state.pdf.totalPages} 页`;
    }
    const pageInput = containerEl.querySelector('[data-role="pdf-page-input"]');
    if (pageInput) {
      pageInput.value = String(state.pdf.currentPage);
    }
    if (state.pdf.viewMode === 'iframe') {
      const iframe = containerEl.querySelector('.pdf-frame');
      if (iframe) {
        state.pdf.cacheBust = Date.now();
        iframe.src = buildPdfStreamSrc();
      } else {
        renderPdfViewerStage();
      }
    } else {
      renderPdfViewerStage();
    }
  }

  function setPdfPage(targetPage) {
    if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
    const clamped = Math.min(Math.max(1, Number(targetPage) || 1), state.pdf.totalPages || 1);
    state.pdf.currentPage = clamped;
    updatePdfFrameAndControls();
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
    hideFormatBar();
    removeDropInsertLine();
    const doc = state.activeDoc;
    const pdf = state.pdf;
    const isHd = pdf.viewMode !== 'iframe';

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
          <span data-role="backlinks-slot">${renderBacklinksSlotHtml()}</span>
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
          <div class="segmented-pill" data-seg="pdf-view-mode" role="tablist" aria-label="PDF 渲染模式切换">
            <div class="segmented-thumb" style="width:calc(50% - 3px); transform:translateX(${isHd ? '0%' : '100%'});"></div>
            <button type="button" class="segmented-btn ${isHd ? 'is-active' : ''}" data-pdf-view="hd" role="tab" aria-selected="${isHd}" style="height:24px;padding:0 9px;font-size:11.5px;">
              高清渲染
            </button>
            <button type="button" class="segmented-btn ${!isHd ? 'is-active' : ''}" data-pdf-view="iframe" role="tab" aria-selected="${!isHd}" style="height:24px;padding:0 9px;font-size:11.5px;">
              原生预览
            </button>
          </div>
        </div>

        <div class="center-toolbar-group">
          <button type="button" class="pill-btn pill-btn-sm" data-action="pdf-copy-anchor" title="复制当前页码锚点">
            ${icon('pin', 13)} 复制页码锚点
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="pdf-annotate">
            ${icon('plus', 13)} 写入 PDF 批注
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="pdf-ai-mindmap" title="AI 提炼 PDF 思维导图">
            ${icon('sparkles', 13)} AI 提炼脑图
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
          <div class="pdf-frame-wrap" data-role="pdf-frame-wrap"></div>
          ${renderCompanionPaneHtml(doc, {
            placeholderText: `边看 PDF 边记笔记，支持 [[${doc.name}#page=${pdf.currentPage}]] 锚点…`,
            extraActionHtml: `<button type="button" class="pill-btn pill-btn-sm" data-action="pdf-insert-anchor">${icon('pin', 12)} 插入当前页锚点</button>`,
          })}
        </div>
      </div>
    `;
    renderPdfViewerStage();
    ensureDropOverlay();
  }

  async function openPdfMindMapSheet() {
    const doc = state.activeDoc;
    if (!doc || doc.type !== 'pdf') return;
    openSheet({
      title: `AI 提炼脑图 · ${doc.name}`,
      bodyHtml: `<div class="empty-state" style="padding:28px 12px;"><p class="empty-title">正在提取 PDF 核心结构并生成思维导图…</p></div>`,
      footerHtml: `<button type="button" class="pill-btn" id="pdf-mm-close">关闭</button>`,
      async onMount(card) {
        card.querySelector('#pdf-mm-close')?.addEventListener('click', closeSheet);
        const bodyEl = card.querySelector('.sheet-body');
        const footerEl = card.querySelector('.sheet-footer');
        try {
          const res = await api.post('/api/ai/mindmap', {
            text: doc.companionContent || '',
            file_path: doc.path,
          });
          const outline = String(res?.markdown || res?.outline || res?.content || '').trim();
          if (!outline) {
            if (bodyEl) bodyEl.innerHTML = `<div class="empty-state"><p class="empty-title">未能提炼出脑图大纲</p></div>`;
            return;
          }
          if (bodyEl) {
            bodyEl.innerHTML = `<div data-role="pdf-mm-stage" style="height:52vh;min-height:280px;border:1px solid var(--border-hairline);border-radius:var(--radius-control);overflow:hidden;"></div>`;
            const stage = bodyEl.querySelector('[data-role="pdf-mm-stage"]');
            if (stage) {
              renderMindMap(stage, {
                markdown: outline,
                docName: doc.name,
                onAnchorClick(a) {
                  if (a instanceof HTMLElement) handleAnchorClick(a);
                  else if (a && typeof a === 'object') store.emit('anchor:jump', a);
                },
                onFocusNode(title, seconds = 1500) {
                  store.emit('focus:start', { title: title || doc.name, seconds });
                },
              });
            }
          }
          if (footerEl) {
            footerEl.innerHTML = `
              <button type="button" class="pill-btn" id="pdf-mm-cancel">关闭</button>
              <button type="button" class="pill-btn" id="pdf-mm-copy">${icon('copy', 13)} 复制大纲</button>
              <button type="button" class="pill-btn pill-btn-primary" id="pdf-mm-insert">${icon('plus', 13)} 写入伴生笔记</button>
            `;
            footerEl.querySelector('#pdf-mm-cancel')?.addEventListener('click', closeSheet);
            footerEl.querySelector('#pdf-mm-copy')?.addEventListener('click', () => copyInternal(outline, '已复制脑图大纲'));
            footerEl.querySelector('#pdf-mm-insert')?.addEventListener('click', () => {
              closeSheet();
              insertTextIntoCompanionNote(`\n${outline}\n`, { toastMsg: '已将 AI 脑图大纲写入伴生笔记' });
            });
          }
        } catch (err) {
          if (bodyEl) {
            bodyEl.innerHTML = `<div class="empty-state"><p class="empty-title">AI 脑图提炼失败</p><p class="empty-desc">${escapeHtml(getErrorMsg(err))}</p></div>`;
          }
        }
      },
    });
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
            updatePdfFrameAndControls({ forceReload: true });
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
  // Pain Point #1: Archive Reader (Read-Only Virtual Tree, NO Extraction!)
  // =========================================================================
  async function previewArchiveMember(memberPath) {
    const doc = state.activeDoc;
    if (!doc || doc.type !== 'archive' || !memberPath) return;
    const seq = ++state.archiveSeq;
    state.archive.selectedMember = memberPath;
    state.archive.entryLoading = true;
    state.archive.entryData = null;
    state.archive.entryError = '';
    renderArchivePreviewPane();
    highlightSelectedArchiveMember();

    try {
      const data = await api.get(
        `/api/files/archive-entry?path=${encodeURIComponent(doc.path)}&member=${encodeURIComponent(memberPath)}`
      );
      if (seq !== state.archiveSeq || !state.activeDoc || !isSamePath(state.activeDoc.path, doc.path)) return;
      state.archive.entryLoading = false;
      state.archive.entryData = data;
      renderArchivePreviewPane();
    } catch (err) {
      if (seq !== state.archiveSeq) return;
      state.archive.entryLoading = false;
      state.archive.entryError = getErrorMsg(err, '预览压缩包成员失败');
      renderArchivePreviewPane();
    }
  }

  function highlightSelectedArchiveMember() {
    const sel = state.archive.selectedMember;
    containerEl.querySelectorAll('.archive-tree [data-archive-member]').forEach((el) => {
      const active = el.dataset.archiveMember === sel;
      el.classList.toggle('is-selected', active);
      el.style.background = active ? 'var(--accent-soft)' : '';
      el.style.color = active ? 'var(--accent)' : '';
    });
  }

  function renderArchivePreviewPane() {
    const doc = state.activeDoc;
    const ar = state.archive;
    const pane = containerEl.querySelector('[data-role="archive-preview-pane"]');
    if (!pane || !doc) return;

    if (!ar.selectedMember) {
      pane.innerHTML = `
        <div class="empty-state" style="height:100%;">
          <p class="empty-title">只读虚拟压缩包树</p>
          <p class="empty-desc">点击左侧任意可预览文件，直接在内存中查看内容（不解压污染硬盘）</p>
        </div>
      `;
      return;
    }

    const headerBar = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border-hairline);background:var(--bg-glass);flex-shrink:0;flex-wrap:wrap;">
        <span style="font-family:var(--font-mono);font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;" title="${escapeHtml(ar.selectedMember)}">
          ${escapeHtml(ar.selectedMember)}
        </span>
        <button type="button" class="pill-btn pill-btn-sm" data-action="archive-copy-member-anchor">
          ${icon('pin', 12)} 复制内部文件锚点
        </button>
      </div>
    `;

    if (ar.entryLoading) {
      pane.innerHTML = `${headerBar}<div class="empty-state" style="flex:1;"><p class="empty-title">正在内存读取成员内容…</p></div>`;
      return;
    }

    if (ar.entryError) {
      pane.innerHTML = `${headerBar}<div class="empty-state" style="flex:1;"><p class="empty-title">无法预览</p><p class="empty-desc">${escapeHtml(ar.entryError)}</p></div>`;
      return;
    }

    const d = ar.entryData || {};
    const kind = String(d.kind || d.type || '').toLowerCase();
    const memberExt = getExtLower(ar.selectedMember);
    const isImg =
      kind === 'image' ||
      Boolean(d.data_url) ||
      Boolean(d.base64 && String(d.mime || '').startsWith('image/')) ||
      String(d.mime || '').startsWith('image/');

    let bodyHtml = '';
    if (isImg) {
      const src = d.data_url || (d.base64 ? `data:${d.mime || 'image/png'};base64,${d.base64}` : '');
      bodyHtml = src
        ? `<div style="flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg-subtle);"><img src="${escapeHtml(src)}" alt="${escapeHtml(ar.selectedMember)}" style="max-width:100%;max-height:100%;border-radius:10px;box-shadow:var(--shadow-island);" /></div>`
        : `<div class="empty-state"><p class="empty-desc">图片数据为空</p></div>`;
    } else if (d.content != null) {
      const text = String(d.content);
      if (memberExt === '.md') {
        bodyHtml = `<div class="md-scroll-area"><div class="md-preview">${renderMarkdownSafe(text, { withLineMap: false })}</div></div>`;
      } else {
        bodyHtml = `
          <div style="flex:1;overflow:auto;padding:14px 16px;">
            ${d.truncated ? `<div style="font-size:11.5px;color:var(--warning);margin-bottom:8px;">⚠ 文件较大，当前仅展示部分预览内容</div>` : ''}
            <pre style="margin:0;font-family:var(--font-mono);font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--text-primary);"><code>${escapeHtml(text)}</code></pre>
          </div>
        `;
      }
    } else {
      bodyHtml = `<div class="empty-state"><p class="empty-title">二进制文件</p><p class="empty-desc">${escapeHtml(d.message || '该成员暂不支持文本/图片预览')}</p></div>`;
    }

    pane.innerHTML = `${headerBar}${bodyHtml}`;
  }

  function renderArchiveMode() {
    hideFormatBar();
    removeDropInsertLine();
    const doc = state.activeDoc;
    const ar = state.archive;

    containerEl.innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          <span style="color:var(--warning); display:inline-flex; align-items:center;">${icon('layers', 16)}</span>
          <span class="doc-title-pill" title="${escapeHtml(doc.path)}">${escapeHtml(doc.name)}</span>
          <span class="file-ext-badge" style="text-transform:none;">${ar.fileCount} 项 · ${formatBytes(ar.totalSize)}</span>
          <span data-role="backlinks-slot">${renderBacklinksSlotHtml()}</span>
        </div>

        <div class="center-toolbar-group">
          <button type="button" class="pill-btn pill-btn-sm" data-action="copy-file-anchor">
            ${icon('pin', 13)} 复制胶囊锚点
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="open-folder">
            ${icon('folder-open', 13)} 打开所在文件夹
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="open-system">
            ${icon('rocket', 13)} 系统打开
          </button>
          ${
            hasCompanionNote(doc)
              ? `<button type="button" class="pill-btn pill-btn-sm ${state.companionOpen ? 'pill-btn-primary' : ''}" data-action="toggle-companion">
                  ${icon('file-text', 13)} 伴生笔记
                </button>`
              : ''
          }
        </div>
      </div>

      <div style="flex:1 1 auto; min-height:0; min-width:0; display:grid; grid-template-columns:${state.companionOpen && hasCompanionNote(doc) ? 'minmax(200px,0.75fr) minmax(0,1.25fr) minmax(240px,0.9fr)' : 'minmax(210px,0.8fr) minmax(0,1.4fr)'}; overflow:hidden;">
        <div class="archive-tree" style="border-right:1px solid var(--border-hairline); overflow-y:auto; padding:8px;">
          ${
            ar.entries.length === 0
              ? `<div class="empty-state"><p class="empty-desc">压缩包为空</p></div>`
              : ar.entries
                  .map((entry) => {
                    const memberName = entry.name || entry.path || '';
                    const isDir = Boolean(entry.is_dir || entry.isDir || memberName.endsWith('/'));
                    const previewable = !isDir && entry.previewable !== false;
                    const isSelected = ar.selectedMember === memberName;
                    return `
                      <div
                        class="tree-file-item ${isSelected ? 'is-selected' : ''}"
                        ${previewable ? `data-archive-member="${escapeHtml(memberName)}" draggable="true"` : ''}
                        style="padding:6px 8px; gap:6px; opacity:${previewable ? '1' : isDir ? '0.85' : '0.55'}; cursor:${previewable ? 'pointer' : 'default'};"
                        title="${escapeHtml(memberName)}"
                      >
                        <span style="flex-shrink:0;color:var(--text-tertiary);display:inline-flex;">${icon(isDir ? 'folder' : 'file-text', 13)}</span>
                        <span class="file-name" style="font-size:12px;">${escapeHtml(memberName)}</span>
                        ${!isDir ? `<span style="font-size:11px;color:var(--text-tertiary);font-family:var(--font-mono);flex-shrink:0;">${formatBytes(entry.size)}</span>` : ''}
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
        <div data-role="archive-preview-pane" style="display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;border-right:${state.companionOpen && hasCompanionNote(doc) ? '1px solid var(--border-hairline)' : 'none'};"></div>
        ${
          state.companionOpen && hasCompanionNote(doc)
            ? renderCompanionPaneHtml(doc, {
                placeholderText: `记录压缩包 ${doc.name} 的阅读笔记，支持 [[${doc.name}!路径]] 锚点…`,
                extraActionHtml: ar.selectedMember
                  ? `<button type="button" class="pill-btn pill-btn-sm" data-action="archive-insert-member-anchor">${icon('pin', 12)} 插入成员锚点</button>`
                  : '',
              })
            : ''
        }
      </div>
    `;

    renderArchivePreviewPane();
    ensureDropOverlay();
  }

  // =========================================================================
  // Pain Point #1: Image Viewer (Zoomable + Companion Note)
  // =========================================================================
  function renderImageMode() {
    hideFormatBar();
    removeDropInsertLine();
    const doc = state.activeDoc;
    const imgState = state.image;
    const src = `/api/files/raw-stream?path=${encodeURIComponent(doc.path)}&_t=${imgState.cacheBust}`;
    const zoomPct = imgState.fit ? '适应' : `${Math.round(imgState.zoom * 100)}%`;

    containerEl.innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          <span style="color:var(--accent); display:inline-flex; align-items:center;">${icon('book-open', 16)}</span>
          <span class="doc-title-pill" title="${escapeHtml(doc.path)}">${escapeHtml(doc.name)}</span>
          <span data-role="backlinks-slot">${renderBacklinksSlotHtml()}</span>
        </div>

        <div class="center-toolbar-group">
          <div style="display:inline-flex;align-items:center;gap:4px;padding:2px 4px;border-radius:var(--radius-pill);background:var(--bg-subtle);border:1px solid var(--border-hairline);">
            <button type="button" class="pill-btn pill-btn-ghost pill-btn-sm" data-action="img-zoom-out" title="缩小" style="height:24px;padding:0 8px;">－</button>
            <span data-role="img-zoom-label" style="font-size:11.5px;font-weight:600;min-width:42px;text-align:center;color:var(--text-secondary);">${zoomPct}</span>
            <button type="button" class="pill-btn pill-btn-ghost pill-btn-sm" data-action="img-zoom-in" title="放大" style="height:24px;padding:0 8px;">＋</button>
            <button type="button" class="pill-btn pill-btn-ghost pill-btn-sm" data-action="img-zoom-fit" title="适应窗口" style="height:24px;padding:0 8px;">适应</button>
          </div>

          <button type="button" class="pill-btn pill-btn-sm" data-action="copy-file-anchor">
            ${icon('pin', 13)} 复制胶囊
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="open-folder">
            ${icon('folder-open', 13)} 打开位置
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="open-system">
            ${icon('external-link', 13)} 系统打开
          </button>
          ${
            hasCompanionNote(doc)
              ? `<button type="button" class="pill-btn pill-btn-sm ${state.companionOpen ? 'pill-btn-primary' : ''}" data-action="toggle-companion">
                  ${icon('file-text', 13)} 伴生笔记
                </button>`
              : ''
          }
        </div>
      </div>

      <div style="flex:1 1 auto; min-height:0; min-width:0; overflow:hidden; ${state.companionOpen && hasCompanionNote(doc) ? '' : 'display:flex;flex-direction:column;'}">
        <div class="${state.companionOpen && hasCompanionNote(doc) ? 'pdf-workspace' : ''}" style="height:100%;min-height:0;display:${state.companionOpen && hasCompanionNote(doc) ? 'grid' : 'flex'};flex-direction:column;">
          <div style="flex:1 1 auto;min-width:0;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--bg-subtle);${state.companionOpen && hasCompanionNote(doc) ? 'border-right:1px solid var(--border-hairline);' : ''}">
            <img
              data-role="image-viewer-img"
              src="${src}"
              alt="${escapeHtml(doc.name)}"
              style="${
                imgState.fit
                  ? 'max-width:100%;max-height:100%;object-fit:contain;border-radius:12px;box-shadow:var(--shadow-island);'
                  : `max-width:none;transform:scale(${imgState.zoom});transform-origin:center center;border-radius:12px;box-shadow:var(--shadow-island);`
              }"
            />
          </div>
          ${
            state.companionOpen && hasCompanionNote(doc)
              ? renderCompanionPaneHtml(doc, {
                  placeholderText: `记录图片 ${doc.name} 的说明或 [[${doc.name}]] 胶囊…`,
                  extraActionHtml: `<button type="button" class="pill-btn pill-btn-sm" data-action="insert-file-anchor">${icon('pin', 12)} 插入图片锚点</button>`,
                })
              : ''
          }
        </div>
      </div>
    `;
    ensureDropOverlay();
  }

  // =========================================================================
  // Innovation B: Audio / Video Player + Timestamp Capsules
  // =========================================================================
  function seekActiveMedia(seconds, autoPlay = true) {
    const mediaEl = containerEl.querySelector('[data-role="media-player-el"]');
    if (!mediaEl) return false;
    const targetSec = Math.max(0, Number(seconds) || 0);
    const applySeek = () => {
      try {
        mediaEl.currentTime = targetSec;
        if (autoPlay) {
          mediaEl.play().catch(() => {});
        }
      } catch {
        // ignore seek error before metadata
      }
    };
    if (mediaEl.readyState >= 1) {
      applySeek();
    } else {
      mediaEl.addEventListener('loadedmetadata', applySeek, { once: true });
    }
    return true;
  }

  function renderMediaMode() {
    hideFormatBar();
    removeDropInsertLine();
    const doc = state.activeDoc;
    const isVideo = doc.type === 'video';
    const src = `/api/files/raw-stream?path=${encodeURIComponent(doc.path)}`;

    containerEl.innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          <span style="color:var(--accent); display:inline-flex; align-items:center;">${icon('play', 16)}</span>
          <span class="doc-title-pill" title="${escapeHtml(doc.path)}">${escapeHtml(doc.name)}</span>
          <span data-role="backlinks-slot">${renderBacklinksSlotHtml()}</span>
        </div>

        <div class="center-toolbar-group">
          <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="media-insert-timestamp" title="插入当前播放时间戳胶囊到伴生笔记并复制">
            ${icon('clock', 13)} ⏱ 插入当前时间戳锚点
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="copy-file-anchor">
            ${icon('pin', 13)} 复制胶囊
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="open-folder">
            ${icon('folder-open', 13)} 打开位置
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="open-system">
            ${icon('external-link', 13)} 系统打开
          </button>
        </div>
      </div>

      <div style="flex:1 1 auto; min-height:0; min-width:0; overflow:hidden;">
        <div class="pdf-workspace">
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:14px;background:var(--bg-subtle);border-right:1px solid var(--border-hairline);min-width:0;min-height:0;overflow:auto;">
            ${
              isVideo
                ? `<video data-role="media-player-el" controls preload="metadata" src="${src}" style="width:100%;max-height:72vh;border-radius:14px;background:#000;box-shadow:var(--shadow-float);outline:none;"></video>`
                : `
                  <div class="glass-card" style="width:100%;max-width:460px;padding:24px;display:flex;flex-direction:column;align-items:center;gap:14px;">
                    <div style="width:52px;height:52px;border-radius:16px;background:var(--accent-soft);color:var(--accent);display:inline-flex;align-items:center;justify-content:center;">
                      ${icon('play', 24)}
                    </div>
                    <div style="font-size:14px;font-weight:600;text-align:center;word-break:break-all;">${escapeHtml(doc.name)}</div>
                    <audio data-role="media-player-el" controls preload="metadata" src="${src}" style="width:100%;"></audio>
                  </div>
                `
            }
            <div style="font-size:12px;color:var(--text-secondary);text-align:center;">
              支持 Range 拖动定位 · 点击顶部「⏱ 插入当前时间戳锚点」记录 <code style="font-family:var(--font-mono);">[[${escapeHtml(doc.name)}#t=MM:SS]]</code>
            </div>
          </div>

          ${renderCompanionPaneHtml(doc, {
            placeholderText: `边听/看边记笔记，点击上方按钮自动插入 [[${doc.name}#t=00:00]] 时间戳锚点…`,
            extraActionHtml: `<button type="button" class="pill-btn pill-btn-sm" data-action="media-insert-timestamp">${icon('clock', 12)} 插入时间戳</button>`,
          })}
        </div>
      </div>
    `;

    if (state.media.initialTime > 0 || state.media.autoPlay) {
      seekActiveMedia(state.media.initialTime, state.media.autoPlay);
      state.media.initialTime = 0;
      state.media.autoPlay = false;
    }
    ensureDropOverlay();
  }

  // =========================================================================
  // Pain Point #1: Office Preview (.docx / .pptx) & Generic File Card
  // =========================================================================
  function renderOfficePreviewMode() {
    hideFormatBar();
    removeDropInsertLine();
    const doc = state.activeDoc;
    const previewMd = doc.previewMarkdown || doc.content || '*暂无可预览文本内容，可点击上方按钮用 WPS / Office 打开*';

    containerEl.innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          <span style="color:var(--accent); display:inline-flex; align-items:center;">${icon('file-text', 16)}</span>
          <span class="doc-title-pill" title="${escapeHtml(doc.path)}">${escapeHtml(doc.name)}</span>
          ${doc.size ? `<span class="file-ext-badge" style="text-transform:none;">${formatBytes(doc.size)}</span>` : ''}
          <span data-role="backlinks-slot">${renderBacklinksSlotHtml()}</span>
        </div>

        <div class="center-toolbar-group">
          ${renderTypographyControlsHtml(true)}
          <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="open-system">
            ${icon('rocket', 13)} 用 WPS / Office 原位打开
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="open-folder">
            ${icon('folder-open', 13)} 打开所在文件夹
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="copy-file-anchor">
            ${icon('pin', 13)} 复制胶囊
          </button>
          ${
            hasCompanionNote(doc)
              ? `<button type="button" class="pill-btn pill-btn-sm ${state.companionOpen ? 'pill-btn-primary' : ''}" data-action="toggle-companion">
                  ${icon('file-text', 13)} 伴生笔记
                </button>`
              : ''
          }
        </div>
      </div>

      <div style="flex:1 1 auto; min-height:0; min-width:0; overflow:hidden; ${state.companionOpen && hasCompanionNote(doc) ? '' : 'display:flex;flex-direction:column;'}">
        <div class="${state.companionOpen && hasCompanionNote(doc) ? 'pdf-workspace' : ''}" style="height:100%;min-height:0;display:${state.companionOpen && hasCompanionNote(doc) ? 'grid' : 'flex'};flex-direction:column;">
          <div class="md-scroll-area" style="${state.companionOpen && hasCompanionNote(doc) ? 'border-right:1px solid var(--border-hairline);' : ''}">
            <div class="md-preview">${renderMarkdownSafe(previewMd, { withLineMap: false })}</div>
          </div>
          ${
            state.companionOpen && hasCompanionNote(doc)
              ? renderCompanionPaneHtml(doc, {
                  placeholderText: `记录 ${doc.name} 的阅读批注与摘要…`,
                  extraActionHtml: `<button type="button" class="pill-btn pill-btn-sm" data-action="insert-file-anchor">${icon('pin', 12)} 插入文档锚点</button>`,
                })
              : ''
          }
        </div>
      </div>
    `;
    ensureDropOverlay();
  }

  function renderGenericMode() {
    hideFormatBar();
    removeDropInsertLine();
    const doc = state.activeDoc;

    containerEl.innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          <span style="color:var(--text-secondary); display:inline-flex; align-items:center;">${icon('file-text', 16)}</span>
          <span class="doc-title-pill" title="${escapeHtml(doc.path)}">${escapeHtml(doc.name)}</span>
          <span data-role="backlinks-slot">${renderBacklinksSlotHtml()}</span>
        </div>
        <div class="center-toolbar-group">
          <button type="button" class="pill-btn pill-btn-sm" data-action="copy-file-anchor">
            ${icon('pin', 13)} 复制胶囊
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="open-folder">
            ${icon('folder-open', 13)} 打开所在文件夹
          </button>
          <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="open-system">
            ${icon('rocket', 13)} 用系统默认软件打开
          </button>
          ${
            hasCompanionNote(doc)
              ? `<button type="button" class="pill-btn pill-btn-sm ${state.companionOpen ? 'pill-btn-primary' : ''}" data-action="toggle-companion">
                  ${icon('file-text', 13)} 伴生笔记
                </button>`
              : ''
          }
        </div>
      </div>

      <div style="flex:1 1 auto; min-height:0; min-width:0; overflow:hidden; ${state.companionOpen && hasCompanionNote(doc) ? '' : 'display:flex;flex-direction:column;'}">
        <div class="${state.companionOpen && hasCompanionNote(doc) ? 'pdf-workspace' : ''}" style="height:100%;min-height:0;display:${state.companionOpen && hasCompanionNote(doc) ? 'grid' : 'flex'};flex-direction:column;">
          <div style="flex:1;display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto;${state.companionOpen && hasCompanionNote(doc) ? 'border-right:1px solid var(--border-hairline);' : ''}">
            <div class="glass-card" style="max-width:460px;width:100%;padding:28px 24px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;">
              <div style="width:52px;height:52px;border-radius:16px;background:var(--bg-subtle);color:var(--accent);display:inline-flex;align-items:center;justify-content:center;">
                ${icon(docIconName(doc.type, doc.ext), 26)}
              </div>
              <div style="font-size:16px;font-weight:600;word-break:break-word;">${escapeHtml(doc.name)}</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">
                ${doc.ext ? `<span class="file-ext-badge">${escapeHtml(doc.ext)}</span>` : ''}
                ${doc.size ? `<span class="file-ext-badge" style="text-transform:none;">${formatBytes(doc.size)}</span>` : ''}
              </div>
              <div style="font-size:12px;font-family:var(--font-mono);color:var(--text-tertiary);word-break:break-all;background:var(--bg-subtle);padding:8px 12px;border-radius:var(--radius-control);width:100%;">
                ${escapeHtml(doc.path)}
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:6px;">
                <button type="button" class="pill-btn pill-btn-primary" data-action="open-system">
                  ${icon('rocket', 14)} 用系统默认软件打开
                </button>
                <button type="button" class="pill-btn" data-action="open-folder">
                  ${icon('folder-open', 14)} 打开所在文件夹
                </button>
              </div>
            </div>
          </div>
          ${
            state.companionOpen && hasCompanionNote(doc)
              ? renderCompanionPaneHtml(doc, {
                  placeholderText: `为 ${doc.name} 记一笔伴生笔记…`,
                  extraActionHtml: `<button type="button" class="pill-btn pill-btn-sm" data-action="insert-file-anchor">${icon('pin', 12)} 插入锚点</button>`,
                })
              : ''
          }
        </div>
      </div>
    `;
    ensureDropOverlay();
  }

  // =========================================================================
  // Shared Operations: Render Dispatch, Open, Save, Snapshots, New Note
  // =========================================================================
  function renderActiveView() {
    if (!state.activeDoc) {
      renderWelcome();
      return;
    }
    const t = state.activeDoc.type;
    if (t === 'excel') renderExcelMode();
    else if (t === 'pdf') renderPdfMode();
    else if (t === 'archive') renderArchiveMode();
    else if (t === 'image') renderImageMode();
    else if (t === 'audio' || t === 'video') renderMediaMode();
    else if (t === 'office_preview') renderOfficePreviewMode();
    else if (t === 'generic') renderGenericMode();
    else renderMarkdownMode();
  }

  function scrollToMarkdownHeading(headingText) {
    const rawQuery = String(headingText || '').trim();
    const query = rawQuery.toLowerCase();
    const normQuery = normalizeHeadingKey(rawQuery);
    if (!query && !normQuery) return false;
    const previewEl = containerEl.querySelector('.lp-container') || containerEl.querySelector('.md-preview');
    if (!previewEl) return false;
    const headings = Array.from(previewEl.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    const match =
      headings.find((h) => h.textContent.trim().toLowerCase() === query) ||
      (normQuery ? headings.find((h) => normalizeHeadingKey(h.textContent) === normQuery) : null) ||
      headings.find((h) => h.textContent.trim().toLowerCase().includes(query)) ||
      (normQuery ? headings.find((h) => normalizeHeadingKey(h.textContent).includes(normQuery)) : null);
    if (!match) return false;
    match.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const blk = match.closest('.lp-block');
    if (blk) {
      blk.classList.add('just-dropped');
      window.setTimeout(() => blk.classList.remove('just-dropped'), 1300);
    }
    const prevTransition = match.style.transition;
    const prevBg = match.style.backgroundColor;
    const prevRadius = match.style.borderRadius;
    match.style.transition = 'background-color 300ms ease';
    match.style.backgroundColor = 'var(--accent-soft)';
    match.style.borderRadius = '8px';
    window.setTimeout(() => {
      match.style.backgroundColor = prevBg || '';
      window.setTimeout(() => {
        match.style.transition = prevTransition || '';
        match.style.borderRadius = prevRadius || '';
      }, 320);
    }, 1200);
    return true;
  }

  function scrollToMarkdownLine(rawLine) {
    const lineNum = Number.parseInt(rawLine, 10);
    if (!Number.isFinite(lineNum)) return false;
    const targetLine0 = Math.max(0, lineNum > 0 ? lineNum - 1 : 0);

    if (state.mdMode === 'source') {
      const ta = containerEl.querySelector('.md-editor:not([data-role])');
      if (!ta) return false;
      const lines = String(ta.value || '').split('\n');
      const clamped = Math.min(Math.max(0, targetLine0), Math.max(0, lines.length - 1));
      let offset = 0;
      for (let i = 0; i < clamped; i += 1) {
        offset += lines[i].length + 1;
      }
      const lineLen = lines[clamped]?.length || 0;
      ta.focus();
      ta.setSelectionRange(offset, offset + lineLen);
      const ratio = lines.length > 1 ? clamped / lines.length : 0;
      ta.scrollTop = Math.max(0, Math.round(ta.scrollHeight * ratio - ta.clientHeight * 0.35));
      return true;
    }

    const lp = containerEl.querySelector('.lp-container');
    if (!lp) return false;
    const blocks = Array.from(lp.querySelectorAll('.lp-block[data-md-start]'));
    if (blocks.length === 0) return false;
    const targetBlk =
      blocks.find((b) => {
        const s = Number.parseInt(b.dataset.mdStart, 10);
        const e = Number.parseInt(b.dataset.mdEnd ?? b.dataset.mdStart, 10);
        return Number.isFinite(s) && targetLine0 >= s && targetLine0 <= e;
      }) ||
      blocks.find((b) => Number.parseInt(b.dataset.mdStart, 10) >= targetLine0) ||
      blocks[blocks.length - 1];
    if (!targetBlk) return false;
    targetBlk.scrollIntoView({ behavior: 'smooth', block: 'center' });
    targetBlk.classList.add('just-dropped');
    window.setTimeout(() => targetBlk.classList.remove('just-dropped'), 1300);
    return true;
  }

  function emitFileOpened(doc) {
    if (!doc) return;
    store.emit('file:opened', {
      path: doc.path,
      name: doc.name,
      ext: doc.ext,
      type: doc.type,
    });
  }

  async function openFile(pathStr, opts = {}) {
    const targetPath = String(pathStr || '').trim();
    if (!targetPath) return null;

    // If re-invoking currently open file without forceReload, handle lightweight sub-navigation
    if (
      state.activeDoc &&
      isSamePath(state.activeDoc.path, targetPath) &&
      !opts.forceReload &&
      !opts.skipUnsavedGuard
    ) {
      const t = state.activeDoc.type;
      if (t === 'markdown' || t === 'text') {
        const hasEditingBlock =
          state.editingBlockRange !== null ||
          state.editingBlockIdx !== null ||
          state.editingDraftNewBlock;
        if (hasEditingBlock) {
          commitActiveBlock({ reRender: true });
        }
        const mappedMode = opts.mode === 'preview' ? 'live' : opts.mode === 'edit' ? 'source' : opts.mode;
        let nextMode = state.mdMode;
        if (opts.heading) {
          nextMode = 'live';
        } else if (mappedMode && ['live', 'source', 'mindmap'].includes(mappedMode)) {
          nextMode = mappedMode;
        } else if (state.mdMode === 'mindmap' && opts.mode !== 'mindmap') {
          nextMode = 'live';
        }
        if (nextMode !== state.mdMode) {
          state.mdMode = nextMode;
          renderMarkdownMode();
        }
        if (opts.heading) {
          window.requestAnimationFrame(() => scrollToMarkdownHeading(opts.heading));
        } else if (opts.line != null && opts.line !== '') {
          window.requestAnimationFrame(() => scrollToMarkdownLine(opts.line));
        }
      } else if (t === 'office_preview' && opts.heading) {
        window.requestAnimationFrame(() => scrollToMarkdownHeading(opts.heading));
      } else if (t === 'pdf' && opts.initialPage) {
        setPdfPage(opts.initialPage);
      } else if (t === 'archive' && opts.member) {
        await previewArchiveMember(opts.member);
      } else if ((t === 'audio' || t === 'video') && opts.initialTime != null) {
        seekActiveMedia(opts.initialTime, opts.autoPlay !== false);
      }
      ensureDocTabOnMobile();
      return state.activeDoc;
    }

    // Pain Point #2: Unsaved changes guard when switching to a different file
    if (state.activeDoc && !opts.skipUnsavedGuard && !isSamePath(state.activeDoc.path, targetPath)) {
      const proceed = await confirmOrAutoSaveBeforeSwitch();
      if (!proceed) return null;
    }

    const seq = ++state.openSeq;
    state.loading = true;
    renderLoading(`正在打开 ${getBaseName(targetPath)}…`);

    try {
      const data = await api.get(`/api/files/read?path=${encodeURIComponent(targetPath)}`);
      if (seq !== state.openSeq) return null;

      const ext = String(data.ext || getExtLower(data.path || targetPath)).toLowerCase();
      const type =
        data.type ||
        (ext === '.pdf'
          ? 'pdf'
          : ext === '.xlsx'
          ? 'excel'
          : ext === '.txt'
          ? 'text'
          : ['.zip', '.tar', '.gz', '.tgz'].includes(ext)
          ? 'archive'
          : ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext)
          ? 'image'
          : ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'].includes(ext)
          ? 'audio'
          : ['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)
          ? 'video'
          : ['.docx', '.pptx'].includes(ext)
          ? 'office_preview'
          : 'markdown');

      state.activeDoc = {
        type,
        path: data.path || targetPath,
        name: data.name || getBaseName(targetPath),
        ext,
        size: Number(data.size || 0),
        isPrivate: Boolean(data.is_private),
        content: data.content ?? '',
        previewMarkdown: data.preview_markdown ?? data.previewMarkdown ?? '',
        snapshots: Array.isArray(data.snapshots) ? data.snapshots : [],
        pageCount: Number(data.page_count || 1),
        companionPath: data.companion_path || '',
        companionContent: data.companion_content ?? '',
        companionExists: Boolean(data.companion_exists),
      };
      state.dirty = false;
      state.pdf.companionDirty = false;
      state.loading = false;
      state.hasOpenedOnce = true;
      state.companionOpen = false;
      state.editingBlockIdx = null;
      state.editingBlockRange = null;
      state.editingDraftNewBlock = false;
      state.findBar.open = false;
      state.findBar.matches = [];
      state.findBar.activeIdx = -1;
      resetHistory(state.activeDoc.path);

      // Async backlinks badge
      loadBacklinksForActiveDoc(state.activeDoc.path, seq);

      if (type === 'markdown' || type === 'text') {
        const reqMode = opts.mode === 'preview' ? 'live' : opts.mode === 'edit' ? 'source' : opts.mode;
        if (opts.heading) {
          state.mdMode = 'live';
        } else if (reqMode === 'live' || reqMode === 'source' || (reqMode === 'mindmap' && type === 'markdown')) {
          state.mdMode = reqMode;
        } else if (isCodeOrPlainTextExt(ext)) {
          state.mdMode = 'source';
        } else {
          state.mdMode = 'live';
        }
        syncActiveFileStore();
        renderMarkdownMode();
        if (opts.heading) {
          window.requestAnimationFrame(() => scrollToMarkdownHeading(opts.heading));
        } else if (opts.line != null && opts.line !== '') {
          window.requestAnimationFrame(() => scrollToMarkdownLine(opts.line));
        }
        ensureDocTabOnMobile();
        emitFileOpened(state.activeDoc);
        return state.activeDoc;
      }

      if (type === 'pdf') {
        const total = Math.max(1, Number(data.page_count || 1));
        const initPage = opts.initialPage ? Math.min(Math.max(1, Number(opts.initialPage)), total) : 1;
        const prevViewMode = state.pdf?.viewMode === 'iframe' ? 'iframe' : 'hd';
        const prevZoom = Number(state.pdf?.zoom) || 1.6;
        state.pdf = {
          viewMode: prevViewMode,
          zoom: prevZoom,
          currentPage: initPage,
          totalPages: total,
          companionMode: 'edit',
          companionDirty: false,
          cacheBust: Date.now(),
          imgLoading: false,
          imgError: false,
        };
        syncActiveFileStore();
        renderPdfMode();
        ensureDocTabOnMobile();
        emitFileOpened(state.activeDoc);
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
        emitFileOpened(state.activeDoc);
        return state.activeDoc;
      }

      if (type === 'archive') {
        const entries = Array.isArray(data.entries)
          ? data.entries
          : Array.isArray(data.members)
          ? data.members
          : Array.isArray(data.files)
          ? data.files
          : [];
        const fileCount =
          Number(data.file_count ?? data.total_files) ||
          entries.filter((e) => !(e.is_dir || e.isDir || String(e.name || e.path || '').endsWith('/'))).length;
        const totalSize =
          Number(data.uncompressed_size ?? data.total_size ?? data.size) ||
          entries.reduce((acc, e) => acc + (Number(e.size) || 0), 0);

        state.archive = {
          entries,
          fileCount,
          totalSize,
          selectedMember: '',
          entryLoading: false,
          entryData: null,
          entryError: '',
        };
        syncActiveFileStore();
        renderArchiveMode();
        if (opts.member) {
          await previewArchiveMember(opts.member);
        }
        ensureDocTabOnMobile();
        emitFileOpened(state.activeDoc);
        return state.activeDoc;
      }

      if (type === 'image') {
        state.image = {
          fit: true,
          zoom: 1.0,
          cacheBust: Date.now(),
        };
        syncActiveFileStore();
        renderImageMode();
        ensureDocTabOnMobile();
        emitFileOpened(state.activeDoc);
        return state.activeDoc;
      }

      if (type === 'audio' || type === 'video') {
        state.media = {
          initialTime: Number(opts.initialTime || 0),
          autoPlay: Boolean(opts.autoPlay),
        };
        syncActiveFileStore();
        renderMediaMode();
        ensureDocTabOnMobile();
        emitFileOpened(state.activeDoc);
        return state.activeDoc;
      }

      syncActiveFileStore();
      renderActiveView();
      if (type === 'office_preview' && opts.heading) {
        window.requestAnimationFrame(() => scrollToMarkdownHeading(opts.heading));
      }
      ensureDocTabOnMobile();
      emitFileOpened(state.activeDoc);
      return state.activeDoc;
    } catch (err) {
      if (seq !== state.openSeq) return null;
      state.loading = false;
      showToast(getErrorMsg(err, '读取文档失败'), 'error');
      renderActiveView();
      return null;
    }
  }

  async function saveMarkdownDoc({ silent = false, toastMessage = '' } = {}) {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return false;
    if (state.saving) return false;
    cleanupEmptyTrailingDraftIfNeeded();
    flushPendingUndo();

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
      if (toastMessage) {
        showToast(toastMessage, 'success');
      } else if (!silent) {
        showToast(
          res?.snapshot_id ? '已安全保存（自动创建写前快照）' : '已安全保存至本地磁盘',
          'success'
        );
      }
      return true;
    } catch (err) {
      state.saving = false;
      showToast(getErrorMsg(err, '保存文档失败'), 'error');
      return false;
    }
  }

  async function saveCompanionNote({ silent = false, toastMessage = '' } = {}) {
    const doc = state.activeDoc;
    if (!doc || !hasCompanionNote(doc)) return false;
    if (state.saving) return false;

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
      if (toastMessage) {
        showToast(toastMessage, 'success');
      } else if (!silent) {
        showToast('伴生笔记已安全保存', 'success');
      }
      return true;
    } catch (err) {
      state.saving = false;
      showToast(getErrorMsg(err, '保存伴生笔记失败'), 'error');
      return false;
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
                  skipUnsavedGuard: true,
                  forceReload: true,
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
              await openFile(created.path, { mode: 'live' });
              if (!String(created.content || content || '').trim()) {
                appendNewBlockAndFocus();
              }
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
  // Pain Point #3 & #4 & Innovation A: Universal Portal Jump + Auto-Relocate
  // =========================================================================
  function handleAnchorClick(btn) {
    if (!btn) return;
    const ds = btn.dataset || {};
    let type = ds.anchorType || '';
    if (!type) {
      if (ds.anchorApp) type = 'app';
      else if (ds.anchorUrl) type = 'url';
      else if (ds.anchorPage) type = 'pdf';
      else if (ds.anchorCell || ds.anchorSheet) type = 'excel';
      else if (ds.anchorMember) type = 'archive';
      else if (ds.anchorTime) type = 'media';
      else if (!ds.anchorFile && ds.anchorHeading) type = 'heading';
      else if (ds.anchorFile) type = 'file';
    }
    store.emit('anchor:jump', {
      type,
      file: ds.anchorFile || '',
      page: ds.anchorPage || '',
      sheet: ds.anchorSheet || '',
      cell: ds.anchorCell || '',
      heading: ds.anchorHeading || '',
      member: ds.anchorMember || '',
      time: ds.anchorTime || '',
      app: ds.anchorApp || '',
      url: ds.anchorUrl || '',
      raw: ds.anchorRaw || '',
      broken: btn.classList.contains('is-broken'),
    });
  }

  async function tryRelocateMissingFile(rawFile) {
    const filename = getBaseName(rawFile) || rawFile;
    try {
      const res = await api.post('/api/files/relocate', { filename });
      const foundPath = res?.path || res?.file?.path || '';
      if (foundPath) {
        try {
          const filesData = await api.get('/api/files/list');
          if (filesData) {
            store.setState({ files: filesData });
            store.emit('files:updated', filesData);
          }
        } catch {
          // ignore list refresh error
        }
        const item = findWorkspaceFile(foundPath) || { path: foundPath, name: getBaseName(foundPath) };
        showToast(`已自动寻回移动的文件：${item.name}`, 'success');
        return item;
      }
    } catch {
      // fall through to manual folder picker sheet
    }
    return null;
  }

  function openRelocateFallbackSheet(rawFile, retryCallback) {
    openSheet({
      title: '未能找到目标文件',
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:10px;">
          <p style="margin:0;color:var(--text-secondary);line-height:1.6;">
            工作区及常见目录中均未找到「<strong style="color:var(--text-primary);">${escapeHtml(rawFile)}</strong>」。该文件可能已被移动至其它文件夹。
          </p>
          <p style="margin:0;font-size:12.5px;color:var(--text-tertiary);">
            您可以选择该文件现在所在的新文件夹挂载到工作区，系统将立即重新定位并打开它。
          </p>
        </div>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="reloc-cancel">关闭</button>
        <button type="button" class="pill-btn pill-btn-primary" id="reloc-pick">${icon('folder-open', 14)} 选择新文件夹并重定位</button>
      `,
      onMount(card) {
        card.querySelector('#reloc-cancel')?.addEventListener('click', closeSheet);
        const pickBtn = card.querySelector('#reloc-pick');
        pickBtn?.addEventListener('click', async () => {
          if (pickBtn) pickBtn.disabled = true;
          try {
            const picked = await api.post('/api/system/pick-path', { mode: 'folder' });
            const dirPath = picked?.path || '';
            if (!dirPath) {
              if (pickBtn) pickBtn.disabled = false;
              return;
            }
            await api.post('/api/files/import', { paths: [dirPath], is_dir: true });
            const filesData = await api.get('/api/files/list');
            if (filesData) {
              store.setState({ files: filesData });
              store.emit('files:updated', filesData);
            }
            closeSheet();
            await retryCallback?.();
          } catch (err) {
            if (pickBtn) pickBtn.disabled = false;
            showToast(getErrorMsg(err, '挂载新目录失败'), 'error');
          }
        });
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
      showToast('请先打开一篇笔记或伴生笔记后再追加内容', 'warning');
      return;
    }

    if (doc.type === 'markdown' || doc.type === 'text') {
      if (path && !isSamePath(path, doc.path)) {
        showToast('目标追加路径与当前打开文档不一致', 'warning');
        return;
      }
      pushUndoSnapshot(doc.content, { immediate: true });
      const nextContent = insertMarkdownWithPadding(
        doc.content || '',
        getMdLines().length,
        textToAppend
      );

      try {
        const res = await api.put('/api/files/write', { path: doc.path, content: nextContent });
        doc.content = nextContent;
        state.dirty = false;
        state.editingBlockIdx = null;
        state.editingBlockRange = null;
        syncActiveFileStore();
        renderMarkdownMode();
        store.emit('file:saved', { path: doc.path, snapshot_id: res?.snapshot_id || null });
        showToast(`已追加并保存至 ${doc.name}`, 'success');
      } catch (err) {
        showToast(getErrorMsg(err, '追加保存失败'), 'error');
      }
      return;
    }

    if (hasCompanionNote(doc)) {
      const prev = doc.companionContent || '';
      const nextContent = insertMarkdownWithPadding(
        prev,
        prev.replace(/\r\n/g, '\n').split('\n').length,
        textToAppend
      );

      try {
        const res = await api.put('/api/files/write', { path: doc.companionPath, content: nextContent });
        doc.companionContent = nextContent;
        doc.companionExists = true;
        state.pdf.companionDirty = false;
        syncActiveFileStore();
        renderActiveView();
        store.emit('file:saved', { path: doc.companionPath, snapshot_id: res?.snapshot_id || null });
        showToast(`已追加并保存至 ${doc.name} 伴生笔记`, 'success');
      } catch (err) {
        showToast(getErrorMsg(err, '追加保存伴生笔记失败'), 'error');
      }
      return;
    }

    showToast('当前打开的是表格或无伴生笔记文件，请切换至笔记后追加', 'warning');
  });

  // Pain Point #8: doc:insert-block listener (e.g. Right-click "Insert URL Portal")
  store.on('doc:insert-block', (payload = {}) => {
    const markdown = String(payload.markdown ?? payload.text ?? payload.content ?? '').trim();
    if (!markdown) return;
    insertDroppedMarkdown({ markdown, label: payload.label || '内容块' });
  });

  // V5 Drag Staging Shelf: insert single or batch items into current note
  store.on('shelf:insert-current', (payload = {}) => {
    if (Array.isArray(payload?.items) && payload.items.length > 0) {
      const joined = payload.items
        .map((it) => String(it?.markdown ?? it?.text ?? it?.content ?? '').trim())
        .filter(Boolean)
        .join('\n\n');
      if (!joined) return;
      insertDroppedMarkdown({
        markdown: joined,
        label: payload.label || `${payload.items.length} 项暂存内容`,
      });
      return;
    }
    const markdown = String(payload?.markdown ?? payload?.text ?? payload?.content ?? '').trim();
    if (!markdown) return;
    insertDroppedMarkdown({ markdown, label: payload?.label || '暂存内容' });
  });

  // Center Right-Click Menu: AI Polish
  store.on('center:polish-doc', () => triggerAiPolish());

  // Innovation D: center:toggle-mindmap listener
  store.on('center:toggle-mindmap', async (payload = {}) => {
    ensureDocTabOnMobile();
    if (payload?.path && (!state.activeDoc || !isSamePath(state.activeDoc.path, payload.path))) {
      await openFile(payload.path, { mode: 'mindmap' });
      return;
    }
    if (!state.activeDoc) {
      showToast('请先打开一篇 Markdown 笔记', 'warning');
      return;
    }
    if (state.activeDoc.type === 'markdown') {
      commitActiveBlock({ reRender: false });
      state.mdMode = payload?.toggle && state.mdMode === 'mindmap' ? 'live' : 'mindmap';
      renderMarkdownMode();
    } else if (state.activeDoc.type === 'pdf') {
      openPdfMindMapSheet();
    } else {
      showToast('仅 Markdown 笔记与 PDF 支持思维导图视图', 'warning');
    }
  });

  // Universal Portal Jump (app | url | pdf | excel | archive | media | file#heading)
  store.on('anchor:jump', async (payload = {}) => {
    const anchorType = String(payload.type || '').toLowerCase();

    // Case A: App Launcher Portal [[app:Name]]
    if (anchorType === 'app' || (!payload.file && payload.app)) {
      const query = String(payload.app || payload.file || '').trim().toLowerCase();
      if (!query) return;
      let apps = Array.isArray(store.state.apps) ? store.state.apps : [];
      if (apps.length === 0) {
        try {
          const res = await api.get('/api/apps');
          apps = Array.isArray(res) ? res : (res?.apps || []);
          if (apps.length > 0) store.setState({ apps });
        } catch {
          // ignore
        }
      }
      const matched =
        apps.find((a) => String(a.name || '').toLowerCase() === query) ||
        apps.find((a) => Array.isArray(a.aliases) && a.aliases.some((al) => String(al).toLowerCase() === query)) ||
        apps.find((a) => String(a.name || '').toLowerCase().includes(query)) ||
        apps.find((a) => Array.isArray(a.aliases) && a.aliases.some((al) => String(al).toLowerCase().includes(query)));

      if (!matched) {
        showToast(`未在软件库找到应用：${payload.app || payload.file}`, 'warning');
        return;
      }
      try {
        const res = await api.post('/api/apps/launch', { app_id: matched.id });
        if ((Array.isArray(res?.failed) && res.failed.length > 0) || (Array.isArray(res?.launched) && res.launched.length === 0)) {
          const reason = res?.failed?.[0]?.reason || `启动 ${matched.name} 失败`;
          showToast(reason, 'error');
          return;
        }
        showToast(`已直达启动：${matched.name}`, 'success');
      } catch (err) {
        showToast(getErrorMsg(err, `启动 ${matched.name} 失败`), 'error');
      }
      return;
    }

    // Case B: URL Portal [[url:Title|https://...]]
    if (anchorType === 'url' || payload.url) {
      const targetUrl = String(payload.url || '').trim();
      if (!targetUrl) return;
      try {
        await api.post('/api/files/open-url', { url: targetUrl });
        showToast('已在默认浏览器打开链接', 'success');
      } catch {
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
        showToast('已打开外部链接', 'info');
      }
      return;
    }

    // Case C: Same-file heading anchor [[#章节名]]
    if (anchorType === 'heading' || (!String(payload.file || '').trim() && String(payload.heading || '').trim())) {
      const heading = String(payload.heading || '').trim();
      if (!heading) return;
      if (!state.activeDoc) {
        showToast('请先打开一篇文档', 'warning');
        return;
      }
      const t = state.activeDoc.type;
      if (t === 'markdown' || t === 'text') {
        const hasEditing =
          state.editingBlockRange !== null ||
          state.editingBlockIdx !== null ||
          state.editingDraftNewBlock;
        if (hasEditing) {
          commitActiveBlock({ reRender: true });
        }
        if (state.mdMode === 'mindmap') {
          state.mdMode = 'live';
          renderMarkdownMode();
        }
        window.requestAnimationFrame(() => {
          const ok = scrollToMarkdownHeading(heading);
          if (ok) {
            showToast(`已定位至 # ${heading}`, 'success', { duration: 1800 });
          } else {
            showToast(`当前文档未找到标题：${heading}`, 'warning');
          }
        });
      } else if (t === 'office_preview') {
        const ok = scrollToMarkdownHeading(heading);
        if (!ok) showToast(`当前文档未找到标题：${heading}`, 'warning');
      } else {
        showToast('当前文档类型不支持标题锚点跳转', 'warning');
      }
      return;
    }

    const rawFile = String(payload.file || '').trim();
    if (!rawFile) return;

    ensureDocTabOnMobile();

    const executeJump = async () => {
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

      // Innovation A: Broken Portal Auto-Relocate
      if (!targetItem) {
        targetItem = await tryRelocateMissingFile(rawFile);
      }

      if (!targetItem) {
        openRelocateFallbackSheet(rawFile, executeJump);
        return;
      }

      // Case 1: PDF Page Anchor
      if (anchorType === 'pdf' || payload.page) {
        const hasExplicitPage = String(payload.page || '').trim() !== '';
        const parsedPage = hasExplicitPage ? Math.max(1, Number.parseInt(payload.page, 10) || 1) : null;
        const isAlreadyOpen = state.activeDoc?.type === 'pdf' && isSamePath(state.activeDoc.path, targetItem.path);
        if (!isAlreadyOpen) {
          const opened = await openFile(targetItem.path, parsedPage ? { initialPage: parsedPage } : {});
          if (!opened) return;
        } else if (parsedPage) {
          const clamped = Math.min(parsedPage, state.pdf.totalPages || parsedPage);
          state.pdf.currentPage = clamped;
          updatePdfFrameAndControls();
        }
        showToast(
          parsedPage
            ? `已精准跳转至 ${targetItem.name} 第 ${state.pdf.currentPage} 页`
            : `已打开 ${targetItem.name}（第 ${state.pdf.currentPage} 页）`,
          'success'
        );
        return;
      }

      // Case 2: Excel Cell / Sheet Anchor
      if (anchorType === 'excel' || payload.cell || payload.sheet) {
        const rawCell = String(payload.cell || '').trim();
        const rawSheet = String(payload.sheet || '').trim();
        if (!rawCell) {
          const isAlreadyOpen = state.activeDoc?.type === 'excel' && isSamePath(state.activeDoc.path, targetItem.path);
          if (!isAlreadyOpen) {
            const opened = await openFile(targetItem.path, rawSheet ? { sheet: rawSheet } : {});
            if (!opened) return;
          } else if (rawSheet && rawSheet !== state.excel.currentSheet) {
            await switchExcelSheet(rawSheet);
          }
          const finalSheet = state.excel.currentSheet || rawSheet;
          showToast(
            finalSheet ? `已直达表格：${targetItem.name} · ${finalSheet}` : `已直达表格：${targetItem.name}`,
            'success'
          );
          return;
        }

        const ref = parseExcelCellRef(rawCell);
        if (!ref) {
          showToast(`无效的单元格坐标：${rawCell}`, 'warning');
          return;
        }

        const targetPage = Math.max(1, Math.ceil(Math.max(1, ref.row - 1) / state.excel.pageSize));
        const isAlreadyOpen = state.activeDoc?.type === 'excel' && isSamePath(state.activeDoc.path, targetItem.path);

        if (!isAlreadyOpen) {
          const opened = await openFile(targetItem.path, {
            sheet: rawSheet,
            page: targetPage,
          });
          if (!opened) return;
        } else {
          const sheets = state.excel.sheets || [];
          const wantedSheet =
            rawSheet && sheets.some((s) => s.name === rawSheet)
              ? rawSheet
              : rawSheet || state.excel.currentSheet || sheets[0]?.name || '';

          state.excel.currentSheet = wantedSheet;
          state.excel.q = '';
          state.excel.sortCol = null;
          state.excel.sortDir = 'asc';
          state.excel.page = targetPage;
          state.excel.editingKey = null;

          renderExcelMode();
          await loadExcelRows({ preservePending: true });
        }

        const finalSheet = state.excel.currentSheet || rawSheet || 'Sheet1';
        window.requestAnimationFrame(() => {
          if (highlightExcelCell(ref.row, ref.col, finalSheet)) {
            showToast(`已精准定位至 ${targetItem.name} · ${finalSheet}!${ref.colLetter}${ref.row}`, 'success');
          }
        });
        return;
      }

      // Case 3: Archive Member Anchor [[pack.zip!member]]
      if (anchorType === 'archive' || payload.member) {
        const member = String(payload.member || '').trim();
        const isAlreadyOpen = state.activeDoc?.type === 'archive' && isSamePath(state.activeDoc.path, targetItem.path);
        if (!isAlreadyOpen) {
          await openFile(targetItem.path, { member });
        } else if (member) {
          await previewArchiveMember(member);
        }
        showToast(member ? `已定位压缩包成员：${member}` : `已打开压缩包：${targetItem.name}`, 'success');
        return;
      }

      // Case 4: Media Timestamp Anchor [[media.mp4#t=MM:SS]]
      if (anchorType === 'media' || payload.time) {
        const sec = parseMediaTimeSeconds(payload.time);
        const isAlreadyOpen =
          (state.activeDoc?.type === 'audio' || state.activeDoc?.type === 'video') &&
          isSamePath(state.activeDoc.path, targetItem.path);
        if (!isAlreadyOpen) {
          await openFile(targetItem.path, { initialTime: sec, autoPlay: true });
        } else {
          seekActiveMedia(sec, true);
        }
        showToast(`已跳转至 ${targetItem.name} · ${formatMediaTimestamp(sec)}`, 'success');
        return;
      }

      // Case 5: File / Markdown Heading Anchor [[note.md]] or [[note.md#Heading]]
      const heading = String(payload.heading || '').trim();
      await openFile(targetItem.path, { mode: heading ? 'live' : undefined, heading });
      if (heading) {
        showToast(`已跳转至 ${targetItem.name} # ${heading}`, 'success');
      }
    };

    await executeJump();
  });

  store.on('typography:changed', () => {
    syncTypographyUi();
  });

  // =========================================================================
  // Pain Point #8: Precision Drop Indicator (Blue Line) & Smart Blank-Line Padding
  // =========================================================================
  function isAcceptableBlockDrag(e) {
    const activePayload = store.state.activeDragPayload;
    if (activePayload) {
      if (activePayload.type === 'module-reorder' || activePayload.type === 'tool-module') return false;
      return true;
    }
    const types = Array.from(e.dataTransfer?.types || []);
    return types.includes(DRAG_MIME) || types.includes('text/plain');
  }

  function updatePrecisionDropLine(e) {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) {
      removeDropInsertLine();
      return false;
    }

    if (state.mdMode === 'live') {
      const lpContainer = containerEl.querySelector('.lp-container');
      const scrollArea = containerEl.querySelector('.md-scroll-area');
      if (!lpContainer) {
        removeDropInsertLine();
        return false;
      }

      const blocks = Array.from(lpContainer.querySelectorAll('.lp-block[data-block-idx]'));
      const refRect = (scrollArea || lpContainer).getBoundingClientRect();
      const linesCount = getMdLines().length;

      let chosenY = refRect.top + 22;
      let targetLineIdx = linesCount;

      if (blocks.length === 0) {
        const containerRect = lpContainer.getBoundingClientRect();
        chosenY = Math.max(refRect.top + 16, Math.min(refRect.bottom - 8, containerRect.top + 20));
        targetLineIdx = 0;
      } else {
        let matched = false;
        for (let i = 0; i < blocks.length; i += 1) {
          const blk = blocks[i];
          const r = blk.getBoundingClientRect();
          const midY = (r.top + r.bottom) / 2;
          const startIdx = Number.parseInt(blk.dataset.mdStart, 10);
          if (e.clientY < midY) {
            if (i === 0) {
              chosenY = r.top - 4;
            } else {
              const prevR = blocks[i - 1].getBoundingClientRect();
              chosenY = (prevR.bottom + r.top) / 2;
            }
            targetLineIdx = Number.isFinite(startIdx) ? startIdx : 0;
            matched = true;
            break;
          }
        }
        if (!matched) {
          const last = blocks[blocks.length - 1];
          const lastRect = last.getBoundingClientRect();
          const lastEnd = Number.parseInt(last.dataset.mdEnd ?? last.dataset.mdStart, 10);
          chosenY = lastRect.bottom + 6;
          targetLineIdx = Number.isFinite(lastEnd) ? lastEnd + 1 : linesCount;
        }
      }

      chosenY = Math.max(refRect.top + 3, Math.min(refRect.bottom - 3, chosenY));
      dropTargetLineIdx = Math.max(0, Math.min(linesCount, targetLineIdx));

      const lineEl = ensureDropInsertLine();
      lineEl.style.left = `${Math.round(refRect.left + 16)}px`;
      lineEl.style.width = `${Math.max(80, Math.round(refRect.width - 32))}px`;
      lineEl.style.transform = `translate3d(0, ${Math.round(chosenY)}px, 0) translateY(-50%)`;
      return true;
    }

    if (state.mdMode === 'source') {
      const ta = containerEl.querySelector('.md-editor:not([data-role])');
      if (!ta) {
        removeDropInsertLine();
        return false;
      }
      const rect = ta.getBoundingClientRect();
      const cs = window.getComputedStyle(ta);
      const approxLineHeight =
        Number.parseFloat(cs.lineHeight) || (Number.parseFloat(cs.fontSize) || 15) * 1.7;
      const linesCount = getMdLines().length;
      const rawLine = (e.clientY - rect.top + ta.scrollTop - 18) / approxLineHeight;
      const dropLine = Math.max(0, Math.min(linesCount, Math.round(rawLine)));
      dropTargetLineIdx = dropLine;

      const visualY = rect.top + 18 + dropLine * approxLineHeight - ta.scrollTop;
      const clampedY = Math.max(rect.top + 4, Math.min(rect.bottom - 4, visualY));
      const lineEl = ensureDropInsertLine();
      lineEl.style.left = `${Math.round(rect.left + 16)}px`;
      lineEl.style.width = `${Math.max(80, Math.round(rect.width - 32))}px`;
      lineEl.style.transform = `translate3d(0, ${Math.round(clampedY)}px, 0) translateY(-50%)`;
      return true;
    }

    removeDropInsertLine();
    return false;
  }

  function resolveSourceDropLine(ta, dropEvent) {
    if (!ta) return getMdLines().length;
    if (dropEvent) {
      const rect = ta.getBoundingClientRect();
      const cs = window.getComputedStyle(ta);
      const approxLineHeight =
        Number.parseFloat(cs.lineHeight) || (Number.parseFloat(cs.fontSize) || 15) * 1.7;
      const linesCount = getMdLines().length;
      const rawLine = (dropEvent.clientY - rect.top + ta.scrollTop - 18) / approxLineHeight;
      return Math.max(0, Math.min(linesCount, Math.round(rawLine)));
    }
    const caret = ta.selectionStart ?? ta.value.length;
    return ta.value.slice(0, caret).split('\n').length - 1;
  }

  function insertDroppedMarkdown(payload, { lineIdx = null, dropEvent = null } = {}) {
    const markdown = String(payload?.markdown ?? payload?.text ?? payload?.content ?? '').trim();
    if (!markdown) return;
    const label = payload?.label || payload?.title || '内容块';
    const doc = state.activeDoc;

    if (!doc || doc.type === 'excel') {
      showToast('请先打开一份 Markdown / TXT / 伴生笔记文档以插入内容', 'warning');
      return;
    }

    if (doc.type === 'markdown' || doc.type === 'text') {
      commitActiveBlock({ reRender: false });
      pushUndoSnapshot(doc.content, { immediate: true });

      if (state.mdMode === 'source') {
        const ta = containerEl.querySelector('.md-editor:not([data-role])');
        const targetLine = Number.isFinite(lineIdx) ? lineIdx : resolveSourceDropLine(ta, dropEvent);
        const nextVal = insertMarkdownWithPadding(doc.content || '', targetLine, markdown);
        doc.content = nextVal;
        state.dirty = true;
        store.state.activeDocumentText = nextVal;
        if (ta) {
          ta.value = nextVal;
          ta.focus();
        }
        updateMdDirtyIndicators();
        showToast(`已精准拖入「${label}」（Ctrl+Z 可撤回）`, 'success');
        return;
      }

      const lines = getMdLines();
      const targetLine = Number.isFinite(lineIdx) ? lineIdx : lines.length;
      const clampedLine = Math.max(0, Math.min(lines.length, targetLine));
      const beforeSlice = lines.slice(0, clampedLine).join('\n').replace(/\n+$/g, '');
      const actualStartLine = beforeSlice.trim() ? beforeSlice.split('\n').length + 1 : 0;
      const firstLinePrefix = markdown.split('\n')[0].replace(/[#>*`\[\]]/g, '').trim().slice(0, 16);
      doc.content = insertMarkdownWithPadding(doc.content || '', clampedLine, markdown);
      state.dirty = true;
      state.editingBlockIdx = null;
      state.editingBlockRange = null;
      state.justDroppedTarget = { lineIdx: clampedLine, actualStartLine, prefix: firstLinePrefix };
      store.state.activeDocumentText = doc.content;
      if (state.mdMode === 'mindmap') {
        state.mdMode = 'live';
      }
      renderMarkdownMode();
      showToast(`已精准拖入「${label}」（Ctrl+Z 可撤回）`, 'success');
      return;
    }

    if (hasCompanionNote(doc)) {
      const prev = doc.companionContent || '';
      const lines = prev.replace(/\r\n/g, '\n').split('\n');
      doc.companionContent = insertMarkdownWithPadding(prev, lines.length, markdown);
      state.pdf.companionDirty = true;
      store.state.activeDocumentText = doc.companionContent;
      if (doc.type !== 'pdf' && doc.type !== 'audio' && doc.type !== 'video') {
        state.companionOpen = true;
      }
      renderActiveView();
      showToast(`已插入「${label}」到伴生笔记`, 'success');
      return;
    }

    showToast('当前文档不支持直接拖入笔记', 'warning');
  }

  containerEl.addEventListener('dragenter', (e) => {
    if (!isAcceptableBlockDrag(e)) return;
    e.preventDefault();
    dragDepth += 1;
    if (!updatePrecisionDropLine(e)) {
      showDropOverlay(true);
    }
  });

  containerEl.addEventListener('dragover', (e) => {
    if (!isAcceptableBlockDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
    if (updatePrecisionDropLine(e)) {
      showDropOverlay(false);
    } else {
      showDropOverlay(true);
    }
  });

  containerEl.addEventListener('dragleave', (e) => {
    if (!isAcceptableBlockDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 || !containerEl.contains(e.relatedTarget)) {
      dragDepth = 0;
      showDropOverlay(false);
      removeDropInsertLine();
    }
  });

  containerEl.addEventListener('drop', (e) => {
    const acceptable = isAcceptableBlockDrag(e);
    const savedLineIdx = dropTargetLineIdx;
    dragDepth = 0;
    showDropOverlay(false);
    removeDropInsertLine();
    if (!acceptable) return;
    e.preventDefault();
    const payload = readDragPayload(e);
    clearDragPayload();
    if (!payload || payload.type === 'module-reorder') return;
    insertDroppedMarkdown(payload, { lineIdx: savedLineIdx, dropEvent: e });
  });

  function buildRawTokenFromEl(el) {
    if (!el) return '';
    const raw = el.dataset.anchorRaw || el.dataset.mediaRaw || '';
    if (raw) return raw;
    const ds = el.dataset || {};
    if (ds.anchorType === 'app' && ds.anchorApp) return `[[app:${ds.anchorApp}]]`;
    if (ds.anchorType === 'url' && ds.anchorUrl) return `[[url:${ds.anchorUrl}]]`;
    if (ds.anchorType === 'heading' && ds.anchorHeading) return `[[#${ds.anchorHeading}]]`;
    const file = ds.anchorFile || ds.mediaFile || '';
    if (!file) return '';
    if (ds.anchorType === 'pdf') return ds.anchorPage ? `[[${file}#page=${ds.anchorPage}]]` : `[[${file}]]`;
    if (ds.anchorType === 'excel') {
      const frag = ds.anchorSheet && ds.anchorCell ? `${ds.anchorSheet}!${ds.anchorCell}` : ds.anchorCell || ds.anchorSheet || '';
      return frag ? `[[${file}#${frag}]]` : `[[${file}]]`;
    }
    if (ds.anchorType === 'archive') return ds.anchorMember ? `[[${file}!${ds.anchorMember}]]` : `[[${file}]]`;
    if (ds.anchorType === 'media' || el.classList.contains('media-embed-card')) {
      const t = ds.anchorTime || ds.mediaTime || '';
      return t ? `[[${file}#t=${t}]]` : `[[${file}]]`;
    }
    return ds.anchorHeading ? `[[${file}#${ds.anchorHeading}]]` : `[[${file}]]`;
  }

  containerEl.addEventListener('dragstart', (e) => {
    if (e.target.closest('.media-resize-handle, .is-resizing')) {
      e.preventDefault();
      return;
    }
    const capEl = e.target.closest('.anchor-pill[draggable="true"], .media-embed-card[draggable="true"]');
    if (capEl) {
      const rawToken = buildRawTokenFromEl(capEl);
      if (!rawToken) return;
      const fileRef = capEl.dataset.anchorFile || capEl.dataset.mediaFile || '';
      const resolved = fileRef ? findWorkspaceFile(fileRef) : null;
      const filePath = resolved?.path || capEl.dataset.mediaPath || '';
      const label =
        capEl.querySelector('span')?.textContent?.trim() ||
        capEl.dataset.mediaFile ||
        capEl.dataset.anchorFile ||
        capEl.dataset.anchorApp ||
        '直达胶囊';
      const blockEl = capEl.closest('.lp-block[data-md-start]');
      const sourceBlockStart = blockEl ? Number.parseInt(blockEl.dataset.mdStart, 10) : undefined;
      setDragPayload(e, {
        type: 'capsule',
        label,
        markdown: rawToken,
        path: filePath,
        sourceDocPath: state.activeDoc?.path || '',
        ...(Number.isFinite(sourceBlockStart) ? { sourceBlockStart } : {}),
      });
      store.emit('drag:active', true);
      return;
    }

    const archiveMemberEl = e.target.closest('[data-archive-member][draggable="true"]');
    if (archiveMemberEl && state.activeDoc?.type === 'archive') {
      const member = archiveMemberEl.dataset.archiveMember;
      if (!member) return;
      const md = `[[${state.activeDoc.name}!${member}]]`;
      setDragPayload(e, {
        type: 'archive-member',
        label: member,
        markdown: md,
        path: state.activeDoc.path,
      });
      store.emit('drag:active', true);
    }
  });

  window.addEventListener('dragend', () => {
    dragDepth = 0;
    showDropOverlay(false);
    removeDropInsertLine();
    clearDragPayload();
    store.emit('drag:active', false);
  });

  // =========================================================================
  // DOM Event Delegation on containerEl & Global Shortcuts / Window Blur
  // =========================================================================
  function syncBlockEditorInput(ta) {
    const doc = state.activeDoc;
    if (!doc || !ta) return;
    const blockEl = ta.closest('.lp-block');
    if (!blockEl) return;

    const prevContent = String(doc.content ?? '');
    pushUndoSnapshot(prevContent, { immediate: false });

    const range = state.editingBlockRange || {
      startLine: Number.parseInt(blockEl.dataset.mdStart, 10) || 0,
      endLine: Number.parseInt(blockEl.dataset.mdEnd ?? blockEl.dataset.mdStart, 10) || 0,
    };

    const lines = prevContent.replace(/\r\n/g, '\n').split('\n');
    const editedLines = ta.value.replace(/\r\n/g, '\n').split('\n');
    const oldCount = Math.max(1, range.endLine - range.startLine + 1);
    const delta = editedLines.length - oldCount;

    lines.splice(range.startLine, oldCount, ...editedLines);
    const newEndLine = range.startLine + editedLines.length - 1;
    state.editingBlockRange = { startLine: range.startLine, endLine: newEndLine };
    blockEl.dataset.mdEnd = String(newEndLine);

    if (delta !== 0) {
      let sib = blockEl.nextElementSibling;
      while (sib) {
        if (sib.classList.contains('lp-block') && sib.dataset.mdStart !== undefined) {
          const s = Number.parseInt(sib.dataset.mdStart, 10);
          const e = Number.parseInt(sib.dataset.mdEnd ?? sib.dataset.mdStart, 10);
          if (Number.isFinite(s)) sib.dataset.mdStart = String(s + delta);
          if (Number.isFinite(e)) sib.dataset.mdEnd = String(e + delta);
        }
        sib = sib.nextElementSibling;
      }
    }

    if (ta.value.trim()) {
      state.editingDraftNewBlock = false;
      blockEl.removeAttribute('data-draft-block');
    }

    doc.content = lines.join('\n');
    state.dirty = true;
    store.state.activeDocumentText = doc.content;
    syncBlockEditorHeight(ta);
    updateMdDirtyIndicators();
  }

  function applyEditorInlineShortcut(ta, kind) {
    const doc = state.activeDoc;
    if (!doc || !ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? start;
    const val = ta.value;

    pushUndoSnapshot(doc.content, { immediate: true });

    let nextVal = val;
    let nextSelStart = start;
    let nextSelEnd = end;

    if (kind === 'bold' || kind === 'italic') {
      const marker = kind === 'bold' ? '**' : '*';
      const mLen = marker.length;
      const selected = val.slice(start, end);
      const before = val.slice(Math.max(0, start - mLen), start);
      const after = val.slice(end, end + mLen);
      const canUnwrap =
        before === marker &&
        after === marker &&
        (kind === 'bold' || (val.slice(Math.max(0, start - 2), start) !== '**' && val.slice(end, end + 2) !== '**'));

      if (canUnwrap) {
        nextVal = `${val.slice(0, start - mLen)}${selected}${val.slice(end + mLen)}`;
        nextSelStart = start - mLen;
        nextSelEnd = end - mLen;
      } else if (selected) {
        nextVal = `${val.slice(0, start)}${marker}${selected}${marker}${val.slice(end)}`;
        nextSelStart = start + mLen;
        nextSelEnd = end + mLen;
      } else {
        nextVal = `${val.slice(0, start)}${marker}${marker}${val.slice(end)}`;
        nextSelStart = start + mLen;
        nextSelEnd = start + mLen;
      }
    } else if (kind === 'quote') {
      const lineStart = val.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
      const lineEndIdx = val.indexOf('\n', end);
      const lineEnd = lineEndIdx === -1 ? val.length : lineEndIdx;
      const blockSlice = val.slice(lineStart, lineEnd);
      const segs = blockSlice.split('\n');
      const allQuoted = segs.every((ln) => /^\s*>/.test(ln));
      const toggled = allQuoted
        ? segs.map((ln) => ln.replace(/^\s*>\s?/, ''))
        : segs.map((ln) => `> ${ln}`);
      const joined = toggled.join('\n');
      nextVal = `${val.slice(0, lineStart)}${joined}${val.slice(lineEnd)}`;
      nextSelStart = lineStart;
      nextSelEnd = lineStart + joined.length;
    }

    ta.value = nextVal;
    ta.setSelectionRange(nextSelStart, nextSelEnd);

    if (ta.classList.contains('lp-block-editor')) {
      syncBlockEditorInput(ta);
    } else {
      doc.content = nextVal;
      state.dirty = true;
      store.state.activeDocumentText = nextVal;
      updateMdDirtyIndicators();
    }
  }

  containerEl.addEventListener('input', (e) => {
    const target = e.target;

    // Live Preview inline block editor
    if (target.matches('.lp-block-editor')) {
      syncBlockEditorInput(target);
      return;
    }

    // Markdown / TXT source editor
    if (target.matches('.md-editor') && !target.dataset.role) {
      if (!state.activeDoc) return;
      pushUndoSnapshot(state.activeDoc.content, { immediate: false });
      state.activeDoc.content = target.value;
      state.dirty = true;
      store.state.activeDocumentText = target.value;
      updateMdDirtyIndicators();
      return;
    }

    // In-Doc Find & Replace inputs
    if (target.matches('[data-role="doc-find-input"]')) {
      state.findBar.query = target.value;
      state.findBar.activeIdx = 0;
      updateFindBarUi({ scrollToActive: true });
      return;
    }
    if (target.matches('[data-role="doc-replace-input"]')) {
      state.findBar.replaceText = target.value;
      return;
    }

    // Companion Note editor (PDF / Audio / Video / Archive / Image / Office / Generic)
    if (target.matches('[data-role="pdf-companion-editor"]')) {
      if (!state.activeDoc || !hasCompanionNote(state.activeDoc)) return;
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

  containerEl.addEventListener('change', (e) => {
    const fontFamilySelect = e.target.closest('select[data-action="font-family"]');
    if (fontFamilySelect) {
      updateTypographyAndPersist(store.state.docFontSize, fontFamilySelect.value);
    }
  });

  containerEl.addEventListener('mouseup', () => {
    window.setTimeout(maybeShowPreviewFormatBar, 0);
  });

  containerEl.addEventListener('keyup', () => {
    maybeShowPreviewFormatBar();
  });

  let suppressNextBlockClick = false;
  let activeHoldSession = null;

  function cancelActiveHoldSession() {
    if (!activeHoldSession) return;
    const sess = activeHoldSession;
    activeHoldSession = null;
    if (sess.armTimer) window.clearTimeout(sess.armTimer);
    if (sess.holdTimer) window.clearTimeout(sess.holdTimer);
    if (sess.blockEl) {
      sess.blockEl.classList.remove('is-hold-arming', 'is-dragging-source');
    }
    if (sess.ghostEl) sess.ghostEl.remove();
    document.querySelectorAll('#drag-shelf.is-drag-over, [data-drop-zone="drag-shelf"].is-drag-over, #right-panel.is-drag-over, [data-drop-zone="right-ai"].is-drag-over').forEach((el) => {
      el.classList.remove('is-drag-over');
    });
    removeDropInsertLine();
    window.removeEventListener('pointermove', sess.onMove);
    window.removeEventListener('pointerup', sess.onUp);
    window.removeEventListener('pointercancel', sess.onCancel);
    window.removeEventListener('scroll', sess.onCancel, true);
    window.removeEventListener('keydown', sess.onKeyDown);
    if (sess.active) {
      clearDragPayload();
      store.emit('drag:active', false);
    }
  }

  function reorderLiveBlock(startLine, endLine, rawBlock, targetInsertLine) {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
    pushUndoSnapshot(doc.content, { immediate: true });
    const lines = String(doc.content ?? '').replace(/\r\n/g, '\n').split('\n');
    let delStart = Math.max(0, startLine);
    let delCount = Math.max(1, endLine - delStart + 1);

    if (
      delStart > 0 &&
      lines[delStart - 1]?.trim() === '' &&
      delStart + delCount < lines.length &&
      lines[delStart + delCount]?.trim() === ''
    ) {
      delCount += 1;
    } else if (delStart === 0 && delStart + delCount < lines.length && lines[delStart + delCount]?.trim() === '') {
      delCount += 1;
    }

    lines.splice(delStart, delCount);

    let adjustedTarget = targetInsertLine;
    if (adjustedTarget > delStart) {
      adjustedTarget -= Math.min(delCount, adjustedTarget - delStart);
    }
    const remaining = lines.join('\n').replace(/^\n+/, '');
    const remLines = remaining ? remaining.split('\n') : [];
    const clampedTarget = Math.max(0, Math.min(remLines.length, adjustedTarget));
    const beforeSlice = remLines.slice(0, clampedTarget).join('\n').replace(/\n+$/g, '');
    const actualStartLine = beforeSlice.trim() ? beforeSlice.split('\n').length + 1 : 0;
    const firstLinePrefix = rawBlock.split('\n')[0].replace(/[#>*`\[\]]/g, '').trim().slice(0, 16);

    doc.content = insertMarkdownWithPadding(remaining, clampedTarget, rawBlock);
    state.dirty = true;
    state.editingBlockIdx = null;
    state.editingBlockRange = null;
    state.justDroppedTarget = { lineIdx: clampedTarget, actualStartLine, prefix: firstLinePrefix };
    store.state.activeDocumentText = doc.content;
    renderMarkdownMode();
    showToast('已调整段落顺序（Ctrl+Z 可撤回）', 'success');
  }

  // V4 #6: Drag Resize Handle (.media-resize-handle) & V5 1s Long-Press Block Drag
  containerEl.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.media-resize-handle');
    if (handle) {
      const card = handle.closest('.media-embed-card');
      if (!card) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startW = card.getBoundingClientRect().width || 420;
      let currentW = Math.round(Math.max(160, Math.min(960, startW)));
      card.classList.add('is-resizing');

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        currentW = Math.round(Math.max(160, Math.min(960, startW + dx)));
        card.style.width = `${currentW}px`;
        card.style.maxWidth = '100%';
        const wLabel = card.querySelector('[data-role="media-width-label"]');
        if (wLabel) wLabel.textContent = `${currentW}px`;
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        card.classList.remove('is-resizing');
        commitMediaCardWidth(card, currentW);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      return;
    }

    // V5 1-Second Long-Press Block Dragging (Pointer-Hold Engine)
    if (e.button !== 0) return;
    if (!state.activeDoc || (state.activeDoc.type !== 'markdown' && state.activeDoc.type !== 'text')) return;
    if (state.mdMode !== 'live') return;
    const blockEl = e.target.closest('.lp-container .lp-block:not(.is-editing)');
    if (!blockEl) return;
    if (
      e.target.closest(
        '.anchor-pill, .media-embed-card, button, a, input, textarea, select, video, audio, .media-resize-handle, .media-embed-toolbar'
      )
    ) {
      return;
    }

    const startLine = Number.parseInt(blockEl.dataset.mdStart, 10);
    const endLineRaw = Number.parseInt(blockEl.dataset.mdEnd ?? blockEl.dataset.mdStart, 10);
    if (!Number.isFinite(startLine)) return;
    const endLine = Number.isFinite(endLineRaw) ? Math.max(startLine, endLineRaw) : startLine;
    const raw = getMdLines().slice(startLine, endLine + 1).join('\n');
    if (!raw.trim()) return;

    cancelActiveHoldSession();
    const startX = e.clientX;
    const startY = e.clientY;
    const firstLinePreview = raw.split('\n')[0].replace(/[#>*`\[\]]/g, '').trim().slice(0, 32) || '笔记段落';

    const sess = {
      active: false,
      blockEl,
      ghostEl: null,
      armTimer: null,
      holdTimer: null,
      payload: {
        type: 'lp-block',
        label: firstLinePreview,
        markdown: raw,
        sourceDocPath: state.activeDoc.path,
        startLine,
        endLine,
      },
      onMove: null,
      onUp: null,
      onCancel: null,
      onKeyDown: null,
    };

    const hasTextSel = () => {
      const sel = window.getSelection();
      return Boolean(sel && !sel.isCollapsed && sel.toString().trim().length > 0);
    };

    sess.onMove = (ev) => {
      if (!activeHoldSession || activeHoldSession !== sess) return;
      if (!sess.active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6 || hasTextSel()) {
          cancelActiveHoldSession();
        }
        return;
      }
      ev.preventDefault();
      if (sess.ghostEl) {
        sess.ghostEl.style.transform = `translate3d(${Math.round(ev.clientX + 14)}px, ${Math.round(ev.clientY + 14)}px, 0)`;
      }

      document.querySelectorAll('#drag-shelf.is-drag-over, [data-drop-zone="drag-shelf"].is-drag-over, #right-panel.is-drag-over, [data-drop-zone="right-ai"].is-drag-over').forEach((el) => {
        el.classList.remove('is-drag-over');
      });

      const hitEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const shelfEl = hitEl?.closest('#drag-shelf, [data-drop-zone="drag-shelf"]');
      const rightEl = hitEl?.closest('#right-panel, [data-drop-zone="right-ai"]');
      if (shelfEl) {
        shelfEl.classList.add('is-drag-over');
        removeDropInsertLine();
      } else if (rightEl) {
        rightEl.classList.add('is-drag-over');
        removeDropInsertLine();
      } else if (containerEl.contains(hitEl) && state.mdMode === 'live') {
        updatePrecisionDropLine(ev);
      } else {
        removeDropInsertLine();
      }
    };

    sess.onUp = (ev) => {
      if (!activeHoldSession || activeHoldSession !== sess) return;
      if (!sess.active) {
        cancelActiveHoldSession();
        return;
      }
      const savedLineIdx = dropTargetLineIdx;
      const hitEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const payload = sess.payload;
      cancelActiveHoldSession();
      window.setTimeout(() => {
        suppressNextBlockClick = false;
      }, 120);

      if (hitEl?.closest('#drag-shelf, [data-drop-zone="drag-shelf"]')) {
        store.addToShelf(payload);
        showToast('已放入拖拽暂存栏', 'success');
        return;
      }
      if (hitEl?.closest('#right-panel, [data-drop-zone="right-ai"]')) {
        store.emit('right:drop-payload', payload);
        return;
      }
      if (containerEl.contains(hitEl) && Number.isFinite(savedLineIdx)) {
        if (savedLineIdx < startLine || savedLineIdx > endLine + 1) {
          reorderLiveBlock(startLine, endLine, raw, savedLineIdx);
        }
      }
    };

    sess.onCancel = () => {
      if (activeHoldSession === sess) {
        cancelActiveHoldSession();
        window.setTimeout(() => {
          suppressNextBlockClick = false;
        }, 80);
      }
    };

    sess.onKeyDown = (ev) => {
      if (ev.key === 'Escape' && activeHoldSession === sess) {
        ev.preventDefault();
        cancelActiveHoldSession();
        window.setTimeout(() => {
          suppressNextBlockClick = false;
        }, 80);
      }
    };

    activeHoldSession = sess;
    window.addEventListener('pointermove', sess.onMove);
    window.addEventListener('pointerup', sess.onUp);
    window.addEventListener('pointercancel', sess.onCancel);
    window.addEventListener('scroll', sess.onCancel, true);
    window.addEventListener('keydown', sess.onKeyDown);

    sess.armTimer = window.setTimeout(() => {
      if (activeHoldSession !== sess || sess.active) return;
      if (hasTextSel()) {
        cancelActiveHoldSession();
        return;
      }
      blockEl.classList.add('is-hold-arming');
    }, 220);

    sess.holdTimer = window.setTimeout(() => {
      if (activeHoldSession !== sess) return;
      if (hasTextSel()) {
        cancelActiveHoldSession();
        return;
      }
      sess.active = true;
      suppressNextBlockClick = true;
      hideFormatBar();
      window.getSelection()?.removeAllRanges?.();
      blockEl.classList.remove('is-hold-arming');
      blockEl.classList.add('is-dragging-source');
      store.state.activeDragPayload = sess.payload;

      const ghost = document.createElement('div');
      ghost.className = 'lp-drag-ghost';
      ghost.style.pointerEvents = 'none';
      ghost.style.transform = `translate3d(${Math.round(startX + 14)}px, ${Math.round(startY + 14)}px, 0)`;
      ghost.textContent = `⠿ ${firstLinePreview}`;
      document.body.appendChild(ghost);
      sess.ghostEl = ghost;
      store.emit('drag:active', true);
    }, 1000);
  });

  // =========================================================================
  // V5 Capsule / Media Card Right-Click Context Menu (#capsule-context-menu)
  // =========================================================================
  let capsuleMenuTarget = null;
  let capsuleMenuListenersBound = false;

  function ensureCapsuleMenuEl() {
    let menu = document.getElementById('capsule-context-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'capsule-context-menu';
      menu.className = 'context-menu capsule-context-menu';
      menu.hidden = true;
      document.body.appendChild(menu);
    }
    if (!capsuleMenuListenersBound) {
      capsuleMenuListenersBound = true;
      document.addEventListener('mousedown', (ev) => {
        const cur = document.getElementById('capsule-context-menu');
        if (cur && !cur.hidden && !cur.contains(ev.target)) {
          hideCapsuleContextMenu();
        }
      });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') hideCapsuleContextMenu();
      });
      window.addEventListener('blur', hideCapsuleContextMenu);
      window.addEventListener('resize', hideCapsuleContextMenu);
    }
    return menu;
  }

  function hideCapsuleContextMenu() {
    capsuleMenuTarget = null;
    const menu = document.getElementById('capsule-context-menu');
    if (!menu) return;
    menu.hidden = true;
    menu.classList.remove('is-open');
    menu.innerHTML = '';
  }

  function replaceOrRemoveTokenInDoc(rawToken, replacementMd, blockRange) {
    const doc = state.activeDoc;
    if (!doc || !rawToken) return false;
    const fullText = String(doc.content ?? '').replace(/\r\n/g, '\n');

    const applyInSlice = (sliceStr) => {
      const idx = sliceStr.indexOf(rawToken);
      if (idx < 0) return null;
      const before = sliceStr.slice(0, idx);
      const after = sliceStr.slice(idx + rawToken.length);
      if (!replacementMd) {
        // Removing token cleanly
        const joined = `${before}${after}`;
        return joined
          .split('\n')
          .filter((ln, i, arr) => !(ln.trim() === '' && arr.length > 1 && (i === 0 || arr[i - 1].trim() === '')))
          .join('\n');
      }
      const bTrim = before.replace(/[ \t]+$/g, '');
      const aTrim = after.replace(/^[ \t]+/g, '');
      const pre = bTrim ? `${bTrim.replace(/\n+$/g, '')}\n\n` : '';
      const suf = aTrim ? `\n\n${aTrim.replace(/^\n+/g, '')}` : '';
      return `${pre}${replacementMd.trim()}${suf}`;
    };

    let nextFull = null;
    if (blockRange && Number.isFinite(blockRange.startLine)) {
      const lines = fullText.split('\n');
      const sIdx = Math.max(0, blockRange.startLine);
      const eIdx = Math.min(lines.length - 1, Math.max(sIdx, blockRange.endLine ?? sIdx));
      const slice = lines.slice(sIdx, eIdx + 1).join('\n');
      const replacedSlice = applyInSlice(slice);
      if (replacedSlice !== null) {
        const repLines = replacedSlice ? replacedSlice.split('\n') : [];
        lines.splice(sIdx, eIdx - sIdx + 1, ...repLines);
        nextFull = lines.join('\n');
      }
    }

    if (nextFull === null) {
      nextFull = applyInSlice(fullText);
    }
    if (nextFull === null) return false;

    nextFull = nextFull.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    if (nextFull && !nextFull.endsWith('\n')) nextFull += '\n';

    pushUndoSnapshot(doc.content, { immediate: true });
    doc.content = nextFull;
    state.dirty = true;
    state.editingBlockIdx = null;
    state.editingBlockRange = null;
    store.state.activeDocumentText = nextFull;
    renderMarkdownMode();
    return true;
  }

  async function handleCapsuleMenuAction(act) {
    const info = capsuleMenuTarget;
    hideCapsuleContextMenu();
    if (!info) return;

    const { el, anchorType, rawToken, fileRef, page, sheet, cell, member, label, blockRange } = info;
    const doc = state.activeDoc;
    const isEditableDoc = Boolean(doc && (doc.type === 'markdown' || doc.type === 'text'));

    if (act === 'open') {
      if (el.classList.contains('media-embed-card')) {
        const mediaPath = el.dataset.mediaPath || '';
        const timeStr = el.dataset.mediaTime || '';
        const sec = timeStr ? parseMediaTimeSeconds(timeStr) : 0;
        const target = (mediaPath ? { path: mediaPath, name: getBaseName(mediaPath) } : null) || findWorkspaceFile(fileRef);
        if (target?.path) {
          await openFile(target.path, sec > 0 ? { initialTime: sec, autoPlay: true } : {});
        } else if (fileRef) {
          store.emit('anchor:jump', { type: 'media', file: fileRef, time: timeStr });
        }
      } else {
        handleAnchorClick(el);
      }
      return;
    }

    if (act === 'copy') {
      copyInternal(rawToken, '已复制直达语法');
      return;
    }

    if (act === 'to-shelf') {
      const target = fileRef ? findWorkspaceFile(fileRef) : null;
      store.addToShelf({
        type: 'capsule',
        label: label || fileRef || '直达胶囊',
        markdown: rawToken,
        path: target?.path || el.dataset.mediaPath || '',
      });
      showToast('已放入拖拽暂存栏', 'success');
      return;
    }

    if (act === 'remove') {
      if (!isEditableDoc) return;
      commitActiveBlock({ reRender: false });
      const ok = replaceOrRemoveTokenInDoc(rawToken, '', blockRange);
      if (ok) {
        showToast('已从笔记移除此模块（Ctrl+Z 可撤回）', 'success');
      } else {
        showToast('未能在原文定位该胶囊语法', 'warning');
      }
      return;
    }

    if (act === 'expand-replace' || act === 'expand-keep') {
      if (!isEditableDoc) {
        showToast('当前文档不支持展开写入', 'warning');
        return;
      }
      if (anchorType === 'app' || anchorType === 'url') {
        showToast('不支持将软件或网址直达胶囊展开为文件内容', 'warning');
        return;
      }
      if (anchorType === 'heading' || !fileRef) {
        showToast('仅支持将关联文件胶囊展开为文件内容', 'warning');
        return;
      }

      let targetItem = findWorkspaceFile(fileRef);
      if (!targetItem) {
        targetItem = await tryRelocateMissingFile(fileRef);
      }
      if (!targetItem?.path) {
        showToast(`未找到目标文件：${fileRef}`, 'warning');
        return;
      }

      try {
        const reqPayload = {
          path: targetItem.path,
          ...(page ? { page: Number.parseInt(page, 10) || undefined } : {}),
          ...(sheet ? { sheet } : {}),
          ...(cell ? { cell } : {}),
          ...(member ? { member } : {}),
        };
        const res =
          typeof api.expandFileContent === 'function'
            ? await api.expandFileContent(reqPayload)
            : await api.post('/api/files/expand-content', reqPayload);

        if (!res?.supported) {
          showToast(res?.reason || '不支持此文件类型展开', 'warning');
          return;
        }
        const expandedMd = String(res.markdown || '').trim();
        if (!expandedMd) {
          showToast('目标文件内容为空，无可展开内容', 'warning');
          return;
        }

        commitActiveBlock({ reRender: false });
        if (act === 'expand-replace') {
          const ok = replaceOrRemoveTokenInDoc(rawToken, expandedMd, blockRange);
          if (ok) {
            showToast('已展开内容填入（Ctrl+Z 可一键还原）', 'success');
          } else {
            showToast('未能定位原胶囊，无法替换', 'warning');
          }
        } else {
          pushUndoSnapshot(doc.content, { immediate: true });
          const lines = getMdLines();
          const insertLine = blockRange && Number.isFinite(blockRange.endLine) ? blockRange.endLine + 1 : lines.length;
          doc.content = insertMarkdownWithPadding(doc.content || '', insertLine, expandedMd);
          state.dirty = true;
          state.editingBlockIdx = null;
          state.editingBlockRange = null;
          store.state.activeDocumentText = doc.content;
          renderMarkdownMode();
          showToast('已展开内容并保留原胶囊（Ctrl+Z 可一键还原）', 'success');
        }
      } catch (err) {
        showToast(getErrorMsg(err, '展开文件内容失败'), 'error');
      }
    }
  }

  containerEl.addEventListener('contextmenu', (e) => {
    const capEl = e.target.closest('.anchor-pill, .media-embed-card');
    if (!capEl) return;
    e.preventDefault();
    e.stopPropagation();

    const globalMenu = document.getElementById('context-menu');
    if (globalMenu) {
      globalMenu.classList.add('hidden');
      globalMenu.classList.remove('is-open');
    }

    const ds = capEl.dataset || {};
    const anchorType =
      ds.anchorType ||
      (capEl.classList.contains('media-embed-card') ? 'media' : ds.anchorApp ? 'app' : ds.anchorUrl ? 'url' : 'file');
    const rawToken = buildRawTokenFromEl(capEl);
    const fileRef = ds.anchorFile || ds.mediaFile || '';
    const blockEl = capEl.closest('.lp-block[data-md-start]');
    const blockRange = blockEl
      ? {
          startLine: Number.parseInt(blockEl.dataset.mdStart, 10),
          endLine: Number.parseInt(blockEl.dataset.mdEnd ?? blockEl.dataset.mdStart, 10),
        }
      : null;
    const isEditableDoc = Boolean(state.activeDoc && (state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text'));

    capsuleMenuTarget = {
      el: capEl,
      anchorType,
      rawToken,
      fileRef,
      page: ds.anchorPage || '',
      sheet: ds.anchorSheet || '',
      cell: ds.anchorCell || '',
      member: ds.anchorMember || '',
      label: capEl.querySelector('span, .media-embed-label')?.textContent?.trim() || fileRef || ds.anchorApp || '直达胶囊',
      blockRange,
    };

    const menu = ensureCapsuleMenuEl();
    menu.innerHTML = `
      ${
        isEditableDoc
          ? `
            <button type="button" class="context-menu-item" data-cap-act="expand-replace" role="menuitem">
              <span class="ctx-item-left"><span>📄</span><span>一键展开内容填入此处</span></span>
            </button>
            <button type="button" class="context-menu-item" data-cap-act="expand-keep" role="menuitem">
              <span class="ctx-item-left"><span>📎</span><span>展开并保留原胶囊</span></span>
            </button>
            <div class="context-menu-sep" role="separator"></div>
          `
          : ''
      }
      <button type="button" class="context-menu-item" data-cap-act="open" role="menuitem">
        <span class="ctx-item-left"><span>↗</span><span>打开原文件</span></span>
      </button>
      <button type="button" class="context-menu-item" data-cap-act="to-shelf" role="menuitem">
        <span class="ctx-item-left"><span>📥</span><span>放入拖拽暂存栏</span></span>
      </button>
      <button type="button" class="context-menu-item" data-cap-act="copy" role="menuitem">
        <span class="ctx-item-left"><span>📋</span><span>复制直达语法</span></span>
      </button>
      ${
        isEditableDoc
          ? `
            <div class="context-menu-sep" role="separator"></div>
            <button type="button" class="context-menu-item" data-cap-act="remove" role="menuitem" style="color:var(--danger);">
              <span class="ctx-item-left"><span>🗑</span><span>从笔记移除此模块</span></span>
            </button>
          `
          : ''
      }
    `;

    menu.querySelectorAll('[data-cap-act]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        handleCapsuleMenuAction(btn.dataset.capAct);
      });
    });

    menu.hidden = false;
    menu.classList.remove('hidden');
    menu.classList.add('is-open');
    const rect = menu.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - (rect.width || 220) - 10);
    const maxY = Math.max(8, window.innerHeight - (rect.height || 200) - 10);
    menu.style.left = `${Math.min(maxX, Math.max(8, e.clientX))}px`;
    menu.style.top = `${Math.min(maxY, Math.max(8, e.clientY))}px`;
  });

  document.addEventListener('mousedown', (e) => {
    if (activeFormatBar && !activeFormatBar.contains(e.target) && !e.target.closest('.lp-container, .md-preview')) {
      hideFormatBar();
    }
    // Commit active block editor when clicking outside any .lp-block (and not clicking find bar or add-block zone)
    if (
      state.activeDoc &&
      (state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text') &&
      state.mdMode === 'live' &&
      (state.editingBlockIdx !== null || state.editingDraftNewBlock)
    ) {
      if (
        !e.target.closest('.lp-block') &&
        !e.target.closest('.lp-add-block-zone') &&
        !e.target.closest('[data-role="doc-find-bar"]') &&
        !e.target.closest('[data-md-mode]') &&
        !e.target.closest('[data-action="md-undo"]') &&
        !e.target.closest('[data-action="md-redo"]')
      ) {
        commitActiveBlock({ reRender: true });
      }
    }
  });

  containerEl.addEventListener('click', (e) => {
    // 0a. Inline Media Card actions (play-inline, open-media, preset width buttons)
    const mediaPlayBtn = e.target.closest('[data-media-action="play-inline"]');
    if (mediaPlayBtn) {
      e.stopPropagation();
      const card = mediaPlayBtn.closest('.media-embed-card');
      mediaPlayBtn.style.display = 'none';
      if (card) {
        card.classList.add('is-playing');
        const badge = card.querySelector('.media-play-badge');
        if (badge && badge !== mediaPlayBtn) badge.style.display = 'none';
        const video = card.querySelector('video');
        if (video) {
          video.controls = true;
          video.muted = false;
          video.play().catch(() => {});
        }
      }
      return;
    }

    const mediaOpenBtn = e.target.closest('[data-media-action="open-media"], [data-media-action="open-external"]');
    if (mediaOpenBtn) {
      e.stopPropagation();
      const card = mediaOpenBtn.closest('.media-embed-card');
      const fileRef = resolveMediaCardFileRef(card, mediaOpenBtn);
      const mediaPath = card?.dataset?.mediaPath || '';
      const timeStr = card?.dataset?.mediaTime || '';
      const initialTime = timeStr ? parseMediaTimeSeconds(timeStr) : 0;
      const targetItem =
        (mediaPath ? { path: mediaPath, name: getBaseName(mediaPath) } : null) ||
        findWorkspaceFile(fileRef);
      if (targetItem?.path) {
        store.emit('file:open', {
          ...targetItem,
          ...(initialTime > 0 ? { initialTime, autoPlay: true } : {}),
        });
      } else if (fileRef) {
        store.emit('anchor:jump', { type: 'media', file: fileRef, time: timeStr });
      }
      return;
    }

    const mediaCard = e.target.closest('.media-embed-card');
    if (mediaCard) {
      const clickedBtn = e.target.closest('button');
      if (clickedBtn) {
        const pctAttr = clickedBtn.dataset.mediaPreset ?? clickedBtn.dataset.mediaPct ?? '';
        const wAttr =
          clickedBtn.dataset.mediaWidth ??
          clickedBtn.dataset.width ??
          clickedBtn.dataset.widthPct ??
          clickedBtn.dataset.resize ??
          '';
        const txt = (clickedBtn.textContent || '').trim();
        const pctMatch = pctAttr
          ? [pctAttr, pctAttr]
          : (wAttr || txt).match(/^(\d{2,3})%$/);
        const pxMatch = !pctMatch ? wAttr.match(/^(\d{2,4})(?:px)?$/) : null;
        if (pctMatch || pxMatch) {
          e.stopPropagation();
          let targetPx = 420;
          if (pctMatch) {
            const pct = Math.max(10, Math.min(100, Number.parseInt(pctMatch[1], 10))) / 100;
            const parentEl = mediaCard.closest('.lp-block-view, .lp-container, .md-preview') || mediaCard.parentElement;
            const availW = Math.min(960, Math.max(240, Math.round((parentEl?.clientWidth || 720) - 12)));
            targetPx = Math.round(availW * pct);
          } else if (pxMatch) {
            targetPx = Number.parseInt(pxMatch[1], 10);
          }
          commitMediaCardWidth(mediaCard, targetPx);
          return;
        }
      }
    }

    // 1. Anchor pill click in MD preview or companion preview
    const anchorPill = e.target.closest('.anchor-pill');
    if (anchorPill) {
      handleAnchorClick(anchorPill);
      return;
    }

    // 1a. Standard Markdown <a href="..."> link interceptor (prevent WebView2 404 navigation)
    const mdLink = e.target.closest('.md-preview a[href], .lp-container a[href]');
    if (mdLink && !mdLink.closest('.anchor-pill')) {
      const rawHref = (mdLink.getAttribute('href') || '').trim();
      if (!rawHref) {
        e.preventDefault();
        return;
      }
      if (/^mailto:/i.test(rawHref)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (/^https?:\/\//i.test(rawHref)) {
        store.emit('anchor:jump', { type: 'url', url: rawHref });
        return;
      }
      if (rawHref.startsWith('#')) {
        let heading = rawHref.slice(1);
        try {
          heading = decodeURIComponent(heading);
        } catch {
          // keep raw
        }
        store.emit('anchor:jump', { type: 'heading', file: '', heading });
        return;
      }
      const hashPos = rawHref.indexOf('#');
      let filePart = hashPos >= 0 ? rawHref.slice(0, hashPos) : rawHref;
      let fragPart = hashPos >= 0 ? rawHref.slice(hashPos + 1) : '';
      try {
        filePart = decodeURIComponent(filePart);
        fragPart = decodeURIComponent(fragPart);
      } catch {
        // keep raw
      }
      const linkExt = getExtLower(filePart);
      if (linkExt === '.pdf') {
        const pm = fragPart.match(/^(?:page=|p\.?)?(\d+)$/i);
        store.emit('anchor:jump', { type: 'pdf', file: filePart, page: pm ? pm[1] : '' });
      } else if (['.xlsx', '.xlsm', '.xls'].includes(linkExt)) {
        const sc = fragPart.match(/^([^!]+)!([A-Za-z]+\d+)$/);
        const co = fragPart.match(/^([A-Za-z]+\d+)$/);
        store.emit('anchor:jump', {
          type: 'excel',
          file: filePart,
          sheet: sc ? sc[1] : (!co && fragPart ? fragPart : ''),
          cell: sc ? sc[2].toUpperCase() : co ? co[1].toUpperCase() : '',
        });
      } else if (['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.m4a', '.ogg'].includes(linkExt)) {
        const tm = fragPart.match(/^t=(.+)$/i);
        store.emit('anchor:jump', { type: 'media', file: filePart, time: tm ? tm[1] : fragPart });
      } else {
        store.emit('anchor:jump', { type: 'file', file: filePart, heading: fragPart });
      }
      return;
    }

    // 1b. Archive virtual file tree member click
    const archiveMemberEl = e.target.closest('[data-archive-member]');
    if (archiveMemberEl && state.activeDoc?.type === 'archive') {
      const member = archiveMemberEl.dataset.archiveMember;
      if (member) previewArchiveMember(member);
      return;
    }

    // 2. Markdown Live / Source / MindMap segmented pill
    const mdSegBtn = e.target.closest('[data-md-mode]');
    if (mdSegBtn && state.activeDoc) {
      const nextMode = mdSegBtn.dataset.mdMode;
      if (['live', 'source', 'mindmap'].includes(nextMode) && nextMode !== state.mdMode) {
        commitActiveBlock({ reRender: false });
        state.mdMode = nextMode;
        renderMarkdownMode();
        if (nextMode === 'source') {
          containerEl.querySelector('.md-editor')?.focus();
        }
      }
      return;
    }

    // 2b. PDF HD / Native Iframe segmented pill
    const pdfViewBtn = e.target.closest('[data-pdf-view]');
    if (pdfViewBtn && state.activeDoc?.type === 'pdf') {
      const nextView = pdfViewBtn.dataset.pdfView === 'iframe' ? 'iframe' : 'hd';
      if (nextView !== state.pdf.viewMode) {
        state.pdf.viewMode = nextView;
        renderPdfMode();
      }
      return;
    }

    // 3. Companion Edit / Preview segmented pill
    const compSegBtn = e.target.closest('[data-comp-mode]');
    if (compSegBtn && state.activeDoc && hasCompanionNote(state.activeDoc)) {
      const nextMode = compSegBtn.dataset.compMode === 'preview' ? 'preview' : 'edit';
      if (nextMode !== state.pdf.companionMode) {
        state.pdf.companionMode = nextMode;
        renderActiveView();
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
    if (actionBtn) {
      const action = actionBtn.dataset.action;

      if (action === 'lp-add-block') {
        appendNewBlockAndFocus();
        return;
      } else if (action === 'md-undo') {
        performUndo();
        return;
      } else if (action === 'md-redo') {
        performRedo();
        return;
      } else if (action === 'find-prev') {
        stepFindMatch(-1);
        return;
      } else if (action === 'find-next') {
        stepFindMatch(1);
        return;
      } else if (action === 'find-replace-one') {
        replaceCurrentMatch();
        return;
      } else if (action === 'find-replace-all') {
        replaceAllMatches();
        return;
      } else if (action === 'find-close') {
        closeFindBar();
        return;
      } else if (action === 'font-dec') {
        updateTypographyAndPersist((store.state.docFontSize || 15) - 1, store.state.docFontFamily);
        return;
      } else if (action === 'font-inc') {
        updateTypographyAndPersist((store.state.docFontSize || 15) + 1, store.state.docFontFamily);
        return;
      } else if (action === 'welcome-new-note') {
        openNewNoteSheet();
        return;
      } else if (action === 'welcome-ai-summary') {
        store.emit('ai:summarize-request', {
          text: store.state.activeDocumentText || '',
          file_path: state.activeDoc?.path || '',
        });
        return;
      } else if (action === 'quick-open') {
        const p = actionBtn.dataset.path;
        if (p) openFile(p);
        return;
      } else if (action === 'md-save') {
        saveMarkdownDoc();
        return;
      } else if (action === 'ai-polish') {
        triggerAiPolish();
        return;
      } else if (action === 'open-snapshots') {
        openSnapshotsSheet();
        return;
      } else if (action === 'open-backlinks') {
        openBacklinksSheet();
        return;
      } else if (action === 'open-folder') {
        if (state.activeDoc?.path) openExternalFile(state.activeDoc.path, true);
        return;
      } else if (action === 'open-system') {
        if (state.activeDoc?.path) openExternalFile(state.activeDoc.path, false);
        return;
      } else if (action === 'copy-file-anchor') {
        if (state.activeDoc?.name) {
          copyInternal(`[[${state.activeDoc.name}]]`, '已复制文件胶囊锚点');
        }
        return;
      } else if (action === 'insert-file-anchor') {
        if (state.activeDoc?.name) {
          insertTextIntoCompanionNote(`[[${state.activeDoc.name}]]`, { toastMsg: '已插入文件锚点' });
        }
        return;
      } else if (action === 'toggle-companion') {
        state.companionOpen = !state.companionOpen;
        renderActiveView();
        return;
      } else if (action === 'archive-copy-member-anchor') {
        if (state.activeDoc && state.archive.selectedMember) {
          copyInternal(`[[${state.activeDoc.name}!${state.archive.selectedMember}]]`, '已复制内部文件锚点');
        }
        return;
      } else if (action === 'archive-insert-member-anchor') {
        if (state.activeDoc && state.archive.selectedMember) {
          insertTextIntoCompanionNote(`[[${state.activeDoc.name}!${state.archive.selectedMember}]]`, {
            toastMsg: '已插入压缩包成员锚点',
          });
        }
        return;
      } else if (action === 'img-zoom-out') {
        const cur = state.image.fit ? 1.0 : state.image.zoom;
        const prev = [...IMAGE_ZOOM_STEPS].reverse().find((z) => z < cur - 0.01) || IMAGE_ZOOM_STEPS[0];
        state.image.fit = false;
        state.image.zoom = prev;
        renderImageMode();
        return;
      } else if (action === 'img-zoom-in') {
        const cur = state.image.fit ? 1.0 : state.image.zoom;
        const next = IMAGE_ZOOM_STEPS.find((z) => z > cur + 0.01) || IMAGE_ZOOM_STEPS[IMAGE_ZOOM_STEPS.length - 1];
        state.image.fit = false;
        state.image.zoom = next;
        renderImageMode();
        return;
      } else if (action === 'img-zoom-fit') {
        state.image.fit = true;
        state.image.zoom = 1.0;
        renderImageMode();
        return;
      } else if (action === 'media-insert-timestamp') {
        if (!state.activeDoc) return;
        const mediaEl = containerEl.querySelector('[data-role="media-player-el"]');
        const ts = formatMediaTimestamp(mediaEl?.currentTime || 0);
        const anchor = `[[${state.activeDoc.name}#t=${ts}]]`;
        copyInternal(anchor, false);
        insertTextIntoCompanionNote(anchor, { toastMsg: `已插入并复制时间戳锚点 ${ts}` });
        return;
      } else if (action === 'ai-summarize') {
        if (!state.activeDoc) return;
        const text =
          state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text'
            ? state.activeDoc.content
            : state.activeDoc.type === 'excel'
            ? buildExcelSummaryText()
            : state.activeDoc.type === 'office_preview'
            ? state.activeDoc.previewMarkdown || state.activeDoc.companionContent
            : state.activeDoc.companionContent;
        store.emit('ai:summarize-request', {
          text: text || '',
          file_path: state.activeDoc.path,
        });
        return;
      } else if (action === 'excel-switch-sheet') {
        switchExcelSheet(actionBtn.dataset.sheet);
        return;
      } else if (action === 'excel-copy-anchor') {
        const sel = state.excel.selectedCell;
        if (!sel || !state.activeDoc) {
          showToast('请先点击选择一个单元格', 'warning');
          return;
        }
        const anchor = `[[${state.activeDoc.name}#${state.excel.currentSheet}!${sel.colLetter}${sel.row}]]`;
        copyInternal(anchor, '已复制单元格锚点');
        return;
      } else if (action === 'excel-save') {
        saveExcelChanges();
        return;
      } else if (action === 'excel-append-row') {
        openAppendRowSheet();
        return;
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
        return;
      } else if (action === 'excel-prev-page') {
        if (state.excel.page > 1) {
          state.excel.page -= 1;
          loadExcelRows({ preservePending: true });
        }
        return;
      } else if (action === 'excel-next-page') {
        if (state.excel.page < state.excel.totalPages) {
          state.excel.page += 1;
          loadExcelRows({ preservePending: true });
        }
        return;
      } else if (action === 'pdf-jump-page') {
        if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
        const inp = containerEl.querySelector('[data-role="pdf-page-input"]');
        const raw = Number.parseInt(inp?.value, 10) || 1;
        setPdfPage(raw);
        return;
      } else if (action === 'pdf-prev-page') {
        if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
        setPdfPage(state.pdf.currentPage - 1);
        return;
      } else if (action === 'pdf-next-page') {
        if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
        setPdfPage(state.pdf.currentPage + 1);
        return;
      } else if (action === 'pdf-zoom-out') {
        if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
        const cur = Number(state.pdf.zoom || 1.6);
        const prevStep = [...PDF_ZOOM_STEPS].reverse().find((z) => z < cur - 0.01);
        if (prevStep) {
          state.pdf.zoom = prevStep;
          renderPdfViewerStage();
        }
        return;
      } else if (action === 'pdf-zoom-in') {
        if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
        const cur = Number(state.pdf.zoom || 1.6);
        const nextStep = PDF_ZOOM_STEPS.find((z) => z > cur + 0.01);
        if (nextStep) {
          state.pdf.zoom = nextStep;
          renderPdfViewerStage();
        }
        return;
      } else if (action === 'pdf-hd-retry') {
        if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
        updatePdfFrameAndControls({ forceReload: true });
        return;
      } else if (action === 'pdf-copy-anchor') {
        if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
        const anchor = `[[${state.activeDoc.name}#page=${state.pdf.currentPage}]]`;
        copyInternal(anchor, '已复制页码锚点');
        return;
      } else if (action === 'pdf-annotate') {
        openPdfAnnotateSheet();
        return;
      } else if (action === 'pdf-ai-mindmap') {
        openPdfMindMapSheet();
        return;
      } else if (action === 'pdf-insert-anchor') {
        if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
        const anchor = `[[${state.activeDoc.name}#page=${state.pdf.currentPage}]]`;
        insertTextIntoCompanionNote(anchor, { toastMsg: '已插入页码锚点到伴生笔记' });
        return;
      } else if (action === 'pdf-save-companion') {
        saveCompanionNote();
        return;
      }
    }

    // 7. V4 Live Preview click-to-edit block activation
    if (
      (state.activeDoc?.type === 'markdown' || state.activeDoc?.type === 'text') &&
      state.mdMode === 'live'
    ) {
      if (suppressNextBlockClick) {
        suppressNextBlockClick = false;
        return;
      }
      const lpBlock = e.target.closest('.lp-container .lp-block');
      if (lpBlock && !lpBlock.classList.contains('is-editing')) {
        if (
          e.target.closest(
            '.anchor-pill, button, a, video, audio, input, textarea, select, .media-resize-handle, .media-embed-toolbar, [data-media-action]'
          )
        ) {
          return;
        }
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
          return;
        }
        const startLine = Number.parseInt(lpBlock.dataset.mdStart, 10);
        if (Number.isFinite(startLine)) {
          activateBlockByStartLine(startLine, 'end');
        }
      }
    }
  });

  containerEl.addEventListener('dblclick', (e) => {
    // Excel cell double-click edit
    const td = e.target.closest('td[data-excel-row][data-excel-col]');
    if (td && state.activeDoc?.type === 'excel') {
      if (e.target.closest('input.excel-cell-input')) return;
      const rowNum = Number(td.dataset.excelRow);
      const col1 = Number(td.dataset.excelCol);
      startExcelInlineEdit(rowNum, col1);
      return;
    }
  });

  containerEl.addEventListener('keydown', (e) => {
    // V4: Inline block editor keyboard flow (ArrowUp, ArrowDown, Escape, Ctrl+B/I//)
    if (e.target.matches('.lp-block-editor')) {
      const ta = e.target;
      const idx = Number.parseInt(ta.dataset.blockIdx, 10);
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        applyEditorInlineShortcut(ta, 'bold');
        return;
      }
      if (mod && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        applyEditorInlineShortcut(ta, 'italic');
        return;
      }
      if (mod && e.key === '/') {
        e.preventDefault();
        applyEditorInlineShortcut(ta, 'quote');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        commitActiveBlock({ reRender: true });
        return;
      }
      if (
        e.key === 'ArrowUp' &&
        !e.shiftKey &&
        !e.altKey &&
        !mod &&
        ta.selectionStart === ta.selectionEnd &&
        !ta.value.slice(0, ta.selectionStart).includes('\n')
      ) {
        const blockEl = ta.closest('.lp-block');
        const curStart = state.editingBlockRange?.startLine ?? (Number.parseInt(blockEl?.dataset?.mdStart, 10) || 0);
        if (curStart > 0) {
          e.preventDefault();
          commitActiveBlock({ reRender: false });
          const blocks = parseMarkdownBlocks(state.activeDoc?.content || '');
          const prevBlkIdx = blocks.reduce((acc, b, i) => (b.startLine < curStart ? i : acc), -1);
          if (prevBlkIdx >= 0) {
            activateBlockByIndex(prevBlkIdx, 'end');
          } else {
            renderMarkdownMode();
          }
        }
        return;
      }
      if (
        e.key === 'ArrowDown' &&
        !e.shiftKey &&
        !e.altKey &&
        !mod &&
        ta.selectionStart === ta.selectionEnd &&
        !ta.value.slice(ta.selectionStart).includes('\n')
      ) {
        const blockEl = ta.closest('.lp-block');
        const curEnd =
          state.editingBlockRange?.endLine ??
          (Number.parseInt(blockEl?.dataset?.mdEnd ?? blockEl?.dataset?.mdStart, 10) || 0);
        const prevLineCount = getMdLines().length;
        const blocksBefore = parseMarkdownBlocks(state.activeDoc?.content || '');
        const hasNext = blocksBefore.some((b) => b.startLine > curEnd);
        if (hasNext) {
          e.preventDefault();
          commitActiveBlock({ reRender: false });
          const lineDelta = getMdLines().length - prevLineCount;
          const blocksAfter = parseMarkdownBlocks(state.activeDoc?.content || '');
          const nextBlkIdx = blocksAfter.findIndex((b) => b.startLine > curEnd + lineDelta);
          if (nextBlkIdx >= 0) {
            activateBlockByIndex(nextBlkIdx, 'start');
          } else {
            renderMarkdownMode();
          }
        }
        return;
      }
      return;
    }

    // V4: Source mode Ctrl+B / Ctrl+I / Ctrl+/
    if (e.target.matches('.md-editor') && !e.target.dataset.role) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        applyEditorInlineShortcut(e.target, 'bold');
        return;
      }
      if (mod && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        applyEditorInlineShortcut(e.target, 'italic');
        return;
      }
      if (mod && e.key === '/') {
        e.preventDefault();
        applyEditorInlineShortcut(e.target, 'quote');
        return;
      }
    }

    // V4: Find & Replace bar keyboard navigation
    if (e.target.matches('[data-role="doc-find-input"]')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        stepFindMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeFindBar();
      }
      return;
    }
    if (e.target.matches('[data-role="doc-replace-input"]')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        replaceCurrentMatch();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeFindBar();
      }
      return;
    }

    if (e.target.matches('.lp-add-block-zone') && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      appendNewBlockAndFocus();
      return;
    }

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
      setPdfPage(raw);
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

  // Pain Point #2: Auto-save silently on window blur when autoSaveOnSwitch is enabled
  window.addEventListener('blur', () => {
    if (!store.state.autoSaveOnSwitch || state.saving) return;
    window.setTimeout(() => {
      if (hasUnsavedChanges() && !state.saving) {
        saveCurrentDirtyDoc({ silent: true, toastMessage: '已自动保存修改' });
      }
    }, 30);
  });

  // Global Shortcuts: Ctrl+S, Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z, Ctrl+F, PDF Left/Right
  document.addEventListener('keydown', (e) => {
    const sheetOpen = document.getElementById('sheet-overlay')?.classList.contains('is-open');
    const spotlightOpen = document.getElementById('spotlight-overlay')?.classList.contains('is-open');
    if (sheetOpen || spotlightOpen) return;

    const mod = e.metaKey || e.ctrlKey;
    const keyLower = String(e.key || '').toLowerCase();

    if (mod && keyLower === 's') {
      if (!state.activeDoc) return;
      e.preventDefault();
      if (state.activeDoc.type === 'excel') {
        const activeInput = containerEl.querySelector('input.excel-cell-input');
        if (activeInput) {
          commitExcelInlineEdit(activeInput, false);
        }
        saveExcelChanges();
      } else if (state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text') {
        saveMarkdownDoc();
      } else if (hasCompanionNote(state.activeDoc)) {
        saveCompanionNote();
      }
      return;
    }

    if (mod && keyLower === 'f') {
      if (!state.activeDoc) return;
      if (state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text') {
        e.preventDefault();
        openFindBar();
        return;
      }
      if (state.activeDoc.type === 'excel') {
        e.preventDefault();
        const searchEl = containerEl.querySelector('[data-role="excel-search"]');
        searchEl?.focus();
        searchEl?.select?.();
        return;
      }
    }

    if (mod && (keyLower === 'z' || keyLower === 'y')) {
      const doc = state.activeDoc;
      if (doc && (doc.type === 'markdown' || doc.type === 'text')) {
        const activeEl = document.activeElement;
        const isUnrelatedInput =
          activeEl &&
          activeEl.matches('input, textarea, select, [contenteditable="true"]') &&
          !activeEl.classList.contains('lp-block-editor') &&
          !(activeEl.classList.contains('md-editor') && containerEl.contains(activeEl) && !activeEl.dataset.role);

        if (!isUnrelatedInput) {
          e.preventDefault();
          if (keyLower === 'z' && !e.shiftKey) {
            performUndo();
          } else {
            performRedo();
          }
          return;
        }
      }
    }

    if (e.key === 'Escape' && state.findBar.open) {
      const activeEl = document.activeElement;
      if (!activeEl || activeEl === document.body || containerEl.contains(activeEl)) {
        e.preventDefault();
        closeFindBar();
        return;
      }
    }

    if (state.activeDoc?.type === 'pdf' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const activeEl = document.activeElement;
      if (activeEl && activeEl.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'ArrowLeft' && state.pdf.currentPage > 1) {
        e.preventDefault();
        setPdfPage(state.pdf.currentPage - 1);
      } else if (e.key === 'ArrowRight' && state.pdf.currentPage < state.pdf.totalPages) {
        e.preventDefault();
        setPdfPage(state.pdf.currentPage + 1);
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
