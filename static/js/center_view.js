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
  pushNavHistory,
  updateCurrentNavSnapshot,
  canNavBack,
  canNavForward,
  getNavBackLabel,
  getNavForwardLabel,
  stepNavBack,
  stepNavForward,
  setBgAiTask,
  openSplitDoc,
  closeSplitDoc,
  consumeShelfItem,
  addToShelf,
  nextSequentialName,
  setCenterView,
  togglePinFile,
  DRAG_MIME,
} from './store.js';
import {
  markdownToWysiwygBlockHtml,
  wysiwygElementToMarkdown,
  execWysiwygFormat,
} from './md_wysiwyg.js';
import { api } from './api_client.js';
import { icon, getFileTypeStyle } from './icons.js';
import { renderMindMap } from './mindmap.js';

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
    :where(.lp-block-wysiwyg[data-placeholder]:empty)::before {
      content: attr(data-placeholder);
      color: var(--text-tertiary);
      pointer-events: none;
    }
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
    :where(.center-split-pane-body .split-pdf-frame) {
      width: 100%;
      height: 100%;
      min-height: 360px;
      border: none;
      border-radius: var(--radius-control);
      background: var(--bg-subtle);
    }
    :where(.center-split-pane-body .split-media-stage) {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 240px;
      padding: 12px;
      background: var(--bg-subtle);
      border-radius: var(--radius-control);
    }
    :where(.center-split-pane-body .split-media-stage img),
    :where(.center-split-pane-body .split-media-stage video) {
      max-width: 100%;
      max-height: 70vh;
      border-radius: 10px;
    }
    :where(.center-split-pane-body .split-code-pre) {
      margin: 0;
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text-primary);
    }
    body.is-pane-resizing,
    body.is-pane-resizing * {
      user-select: none !important;
    }
    body.is-pane-resizing iframe {
      pointer-events: none !important;
    }
    .center-split-resizer,
    .companion-split-resizer {
      width: 8px;
      flex: 0 0 8px;
      cursor: col-resize;
      position: relative;
      background: transparent;
      z-index: 18;
      user-select: none;
      touch-action: none;
    }
    .center-split-resizer::after,
    .companion-split-resizer::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: 3px;
      width: 1px;
      background: var(--border-hairline);
      transition: background 0.14s ease, width 0.14s ease, left 0.14s ease;
    }
    .center-split-resizer:hover::after,
    .center-split-resizer.is-resizing::after,
    .companion-split-resizer:hover::after,
    .companion-split-resizer.is-resizing::after {
      left: 2px;
      width: 3px;
      background: var(--accent);
    }
    .pdf-workspace.is-comp-split {
      display: flex !important;
      flex-direction: row !important;
      width: 100%;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      position: relative;
    }
    .pdf-workspace.is-comp-float {
      display: flex !important;
      flex-direction: column !important;
      width: 100%;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      position: relative;
    }
    .pdf-workspace.is-comp-split > .pdf-frame-wrap,
    .pdf-workspace.is-comp-float > .pdf-frame-wrap {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      border-right: none;
    }
    .companion-float-win {
      position: absolute;
      z-index: 42;
      display: flex;
      flex-direction: column;
      background: var(--bg-island);
      backdrop-filter: blur(22px) saturate(180%);
      -webkit-backdrop-filter: blur(22px) saturate(180%);
      border: 1px solid rgba(128, 128, 136, 0.28);
      border-radius: 14px;
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.2), 0 2px 10px rgba(0, 0, 0, 0.08);
      overflow: hidden;
      min-width: 260px;
      min-height: 220px;
    }
    .companion-float-win .pdf-side-notes {
      flex: 1 1 auto;
      min-height: 0;
      padding: 10px 12px 12px;
    }
    .companion-float-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border-hairline);
      background: var(--bg-glass);
      cursor: move;
      user-select: none;
      flex-shrink: 0;
    }
    .comp-resize-handle {
      position: absolute;
      z-index: 5;
      touch-action: none;
      user-select: none;
    }
    .comp-resize-w {
      top: 10px;
      bottom: 14px;
      left: 0;
      width: 6px;
      cursor: ew-resize;
    }
    .comp-resize-e {
      top: 10px;
      bottom: 14px;
      right: 0;
      width: 6px;
      cursor: ew-resize;
    }
    .comp-resize-s {
      left: 14px;
      right: 14px;
      bottom: 0;
      height: 6px;
      cursor: ns-resize;
    }
    .comp-resize-sw {
      left: 0;
      bottom: 0;
      width: 14px;
      height: 14px;
      cursor: nesw-resize;
    }
    .comp-resize-se {
      right: 0;
      bottom: 0;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;
    }
    .comp-resize-se::after {
      content: '';
      position: absolute;
      right: 4px;
      bottom: 4px;
      width: 7px;
      height: 7px;
      border-right: 2px solid var(--text-tertiary);
      border-bottom: 2px solid var(--text-tertiary);
      opacity: 0.65;
    }
    .center-home-pill-btn {
      height: 26px;
      padding: 0 9px;
      font-size: 11.5px;
      font-weight: 600;
      gap: 4px;
      flex-shrink: 0;
    }
    .explorer-home {
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .explorer-topbar {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border-hairline);
      background: var(--bg-glass);
      flex-shrink: 0;
    }
    .explorer-topbar-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .explorer-breadcrumbs {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .explorer-crumb {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 26px;
      padding: 0 10px;
      border-radius: var(--radius-pill);
      border: 1px solid var(--border-hairline);
      background: var(--bg-subtle);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: transform var(--dur-fast) var(--ease-apple), opacity var(--dur-fast) var(--ease-apple);
    }
    .explorer-crumb:hover { opacity: 0.92; transform: translateY(-0.5px); }
    .explorer-crumb.is-active {
      background: var(--accent-soft);
      border-color: var(--accent);
      color: var(--accent);
      font-weight: 600;
    }
    .explorer-crumb-sep {
      color: var(--text-tertiary);
      font-size: 11px;
      user-select: none;
    }
    .explorer-actions-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .explorer-filter-pills {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-wrap: wrap;
    }
    .explorer-type-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 24px;
      padding: 0 9px;
      border-radius: var(--radius-pill);
      border: 1px solid var(--border-hairline);
      background: var(--bg-subtle);
      color: var(--text-secondary);
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      transition: transform var(--dur-fast) var(--ease-apple), opacity var(--dur-fast) var(--ease-apple);
    }
    .explorer-type-pill:hover { transform: translateY(-0.5px); opacity: 0.95; }
    .explorer-type-pill.is-active {
      box-shadow: 0 0 0 1px currentColor inset;
    }
    .explorer-quick-inline {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 12px;
      background: var(--bg-subtle);
      border: 1px solid var(--border-glass-edge);
      flex-wrap: wrap;
    }
    .explorer-body {
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
      display: flex;
      overflow: hidden;
      position: relative;
    }
    .explorer-files-pane {
      flex: 1 1 62%;
      min-width: 180px;
      min-height: 0;
      overflow-y: auto;
      padding: 14px 16px 24px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      position: relative;
    }
    .explorer-todo-pane {
      flex: 0 0 38%;
      min-width: 220px;
      max-width: none;
      min-height: 0;
      border-left: 1px solid var(--border-hairline);
      background: var(--bg-glass);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .explorer-home.is-todo-full .explorer-files-pane,
    .explorer-home.is-todo-full .explorer-split-resizer {
      display: none !important;
    }
    .explorer-home.is-todo-full .explorer-todo-pane {
      flex: 1 1 100% !important;
      width: 100% !important;
      max-width: none;
      border-left: none;
    }
    .explorer-home.is-todo-collapsed .explorer-todo-pane,
    .explorer-home.is-todo-collapsed .explorer-split-resizer {
      display: none !important;
    }
    .explorer-home.is-todo-collapsed .explorer-files-pane {
      flex: 1 1 100% !important;
      width: 100% !important;
    }
    @media (max-width: 920px) {
      .explorer-body { flex-direction: column; }
      .explorer-split-resizer { display: none !important; }
      .explorer-files-pane { flex: 1 1 55% !important; width: 100% !important; min-width: 0; }
      .explorer-todo-pane {
        flex: 1 1 45% !important;
        width: 100% !important;
        max-width: none;
        min-width: 0;
        border-left: none;
        border-top: 1px solid var(--border-hairline);
      }
    }
    .explorer-section-label {
      font-size: 11.5px;
      font-weight: 700;
      letter-spacing: 0.2px;
      color: var(--text-tertiary);
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .explorer-folder-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(175px, 1fr));
      gap: 9px;
    }
    .explorer-folder-card {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 9px 11px;
      border-radius: 12px;
      background: var(--bg-glass);
      border: 1px solid var(--border-hairline);
      cursor: pointer;
      min-width: 0;
      transition: transform var(--dur-fast) var(--ease-apple), opacity var(--dur-fast) var(--ease-apple);
    }
    .explorer-folder-card:hover {
      transform: translateY(-1px);
      border-color: rgba(217, 119, 6, 0.45);
    }
    .explorer-folder-card.is-drop-target,
    .explorer-crumb.is-drop-target {
      border-color: var(--accent) !important;
      background: var(--accent-soft) !important;
      box-shadow: 0 0 0 2px var(--accent) inset;
      transform: scale(1.02);
    }
    .explorer-file-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(218px, 1fr));
      gap: 10px;
    }
    .explorer-file-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 11px 12px;
      border-radius: 14px;
      background: var(--bg-glass);
      border: 1px solid var(--border-hairline);
      cursor: pointer;
      min-width: 0;
      position: relative;
      transition: transform var(--dur-fast) var(--ease-apple), opacity var(--dur-fast) var(--ease-apple);
    }
    .explorer-file-card:hover {
      transform: translateY(-1px);
      border-color: var(--accent);
      box-shadow: var(--shadow-card);
    }
    .explorer-file-card.is-active-doc,
    .explorer-file-row.is-active-doc {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .explorer-file-card.is-selected,
    .explorer-file-row.is-selected {
      border-color: var(--accent);
      background: var(--accent-soft);
      box-shadow: 0 0 0 1.5px var(--accent) inset;
    }
    .explorer-select-check {
      width: 15px;
      height: 15px;
      accent-color: var(--accent);
      cursor: pointer;
      flex-shrink: 0;
      margin: 0;
    }
    .explorer-batch-bar {
      position: sticky;
      bottom: 0;
      z-index: 16;
      margin-top: auto;
      padding: 10px 14px;
      border-radius: 14px;
      background: var(--bg-island);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid var(--accent);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .explorer-file-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .explorer-file-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 11px;
      border-radius: 11px;
      background: var(--bg-glass);
      border: 1px solid var(--border-hairline);
      cursor: pointer;
      min-width: 0;
      transition: transform var(--dur-fast) var(--ease-apple), opacity var(--dur-fast) var(--ease-apple);
    }
    .explorer-file-row:hover {
      border-color: var(--accent);
      transform: translateX(1px);
    }
    .explorer-ft-icon {
      width: 30px;
      height: 30px;
      border-radius: 9px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .explorer-ft-badge {
      display: inline-flex;
      align-items: center;
      padding: 1px 6px;
      border-radius: var(--radius-pill);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.3px;
      flex-shrink: 0;
    }
    .explorer-todo-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 7px;
      border-radius: var(--radius-pill);
      font-size: 10.5px;
      font-weight: 600;
      flex-shrink: 0;
    }
    .explorer-todo-badge.is-open {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .explorer-todo-badge.is-done {
      background: rgba(22, 163, 74, 0.12);
      color: #16A34A;
    }
    .explorer-pin-btn {
      width: 22px;
      height: 22px;
      border-radius: 9999px;
      border: none;
      background: transparent;
      color: var(--text-tertiary);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 12px;
      flex-shrink: 0;
      opacity: 0.72;
      transition: transform var(--dur-fast) var(--ease-apple), opacity var(--dur-fast) var(--ease-apple);
    }
    .explorer-pin-btn:hover { opacity: 1; transform: scale(1.1); }
    .explorer-pin-btn.is-pinned { opacity: 1; color: #D97706; }
    .explorer-todo-header {
      padding: 10px 13px;
      border-bottom: 1px solid var(--border-hairline);
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
    }
    .explorer-todo-list {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding: 10px 12px 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .explorer-todo-group {
      border-radius: 12px;
      border: 1px solid var(--border-hairline);
      background: var(--bg-subtle);
      overflow: hidden;
    }
    .explorer-todo-group-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 7px 10px;
      background: var(--bg-glass);
      border-bottom: 1px solid var(--border-hairline);
    }
    .explorer-todo-group.is-collapsed .explorer-todo-group-head {
      border-bottom: none;
    }
    .explorer-todo-group.is-collapsed .explorer-todo-group-body {
      display: none;
    }
    .explorer-todo-quick-add {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border-hairline);
      background: rgba(128, 128, 128, 0.04);
    }
    .explorer-todo-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border-hairline);
      font-size: 12.5px;
      line-height: 1.45;
    }
    .explorer-todo-row:last-child {
      border-bottom: none;
    }
    .explorer-todo-row.is-checked .explorer-todo-text {
      text-decoration: line-through;
      color: var(--text-tertiary);
    }
    .explorer-todo-check {
      margin-top: 2px;
      flex-shrink: 0;
      cursor: pointer;
      accent-color: var(--accent);
    }
    .explorer-todo-text {
      flex: 1 1 auto;
      min-width: 0;
      word-break: break-word;
      cursor: pointer;
      color: var(--text-primary);
    }
    .explorer-todo-text:hover {
      color: var(--accent);
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

  const loadStoredFloatRect = () => {
    try {
      const r = JSON.parse(localStorage.getItem('sln_companion_float_rect') || 'null');
      if (r && Number.isFinite(r.w) && Number.isFinite(r.h) && r.w >= 260 && r.h >= 220) {
        return r;
      }
    } catch {
      // ignore
    }
    return { right: 16, top: 14, left: null, w: 360, h: 430 };
  };

  const state = {
    activeDoc: null,
    dirty: false,
    mdMode: 'live', // 'live' | 'source' | 'mindmap'
    dragDefaultMode: (() => {
      try {
        return localStorage.getItem('sln_drag_default_mode') === 'copy' ? 'copy' : 'cut';
      } catch {
        return 'cut';
      }
    })(),
    splitRatio: (() => {
      try {
        const v = Number.parseFloat(localStorage.getItem('sln_split_ratio'));
        return Number.isFinite(v) ? Math.min(0.8, Math.max(0.2, v)) : 0.5;
      } catch {
        return 0.5;
      }
    })(),
    editingBlockIdx: null,
    editingBlockRange: null, // { startLine, endLine }
    editingDraftNewBlock: false,
    editingDraftInsert: null, // { afterBlockIdx, startLine }
    justDroppedTarget: null, // { lineIdx, previewPrefix }
    loading: false,
    saving: false,
    hasOpenedOnce: false,
    openSeq: 0,
    excelSeq: 0,
    archiveSeq: 0,
    backlinkSeq: 0,
    splitSeq: 0,
    excelSearchTimer: null,
    companionOpen: true, // toggleable companion note across PDF / media / archive / image / office
    companionLayout: (() => {
      try {
        return localStorage.getItem('sln_companion_layout') === 'split' ? 'split' : 'float';
      } catch {
        return 'float';
      }
    })(),
    companionSplitRatio: (() => {
      try {
        const v = Number.parseFloat(localStorage.getItem('sln_companion_split_ratio'));
        return Number.isFinite(v) ? Math.min(0.72, Math.max(0.22, v)) : 0.36;
      } catch {
        return 0.36;
      }
    })(),
    companionFloatRect: loadStoredFloatRect(),
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
      currentPage: 1,
      totalPages: 1,
      companionMode: 'edit', // 'edit' | 'preview'
      companionDirty: false,
      cacheBust: Date.now(),
      annotOpen: false,
      annotColor: 'yellow',
    },
    archiveTreeWidth: (() => {
      try {
        const v = Number.parseInt(localStorage.getItem('sln_archive_tree_w'), 10);
        return Number.isFinite(v) ? Math.min(460, Math.max(150, v)) : 230;
      } catch {
        return 230;
      }
    })(),
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
    explorer: {
      scope: 'all', // 'all' | 'notes' | 'imported' | 'mounted'
      relDir: '',
      mountedDir: '',
      search: '',
      typeFilter: 'all',
      viewMode: 'grid', // 'grid' | 'list'
      todoPaneMode: 'side', // 'side' | 'collapsed' | 'full'
      mobileSection: 'files', // 'files' | 'todos' (<= 768px single-column switcher)
      todoFilter: 'open', // 'open' | 'all' | 'done'
      collapsedTodoFiles: new Set(),
      inlineCreateMode: '', // '' | 'note' | 'folder'
      lastRefreshAt: 0,
      splitRatio: (() => {
        try {
          const v = Number.parseFloat(localStorage.getItem('sln_explorer_split_ratio'));
          return Number.isFinite(v) ? Math.min(0.78, Math.max(0.28, v)) : 0.62;
        } catch {
          return 0.62;
        }
      })(),
      selectedPaths: new Set(),
      lastClickedPath: '',
      draggingPaths: null,
    },
  };

  function showPaneResizeTooltip(x, y, text) {
    let tip = document.getElementById('pane-resize-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'pane-resize-tooltip';
      tip.className = 'pane-resize-tooltip';
      tip.style.cssText = [
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
      document.body.appendChild(tip);
    }
    tip.textContent = text;
    tip.hidden = false;
    const left = Math.min(window.innerWidth - 110, Math.max(8, x + 14));
    const top = Math.min(window.innerHeight - 36, Math.max(8, y - 28));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function hidePaneResizeTooltip() {
    const tip = document.getElementById('pane-resize-tooltip');
    if (tip) tip.hidden = true;
  }

  let typographySaveTimer = null;
  let dragDepth = 0;
  let dropTargetLineIdx = null;
  let activeFormatBar = null;
  let activeFormatContext = null; // { startIdx, endIdx, selectedText }
  let internalClipboard = '';
  const splitExtraMeta = new Map(); // path -> { member, time }

  // =========================================================================
  // Split-Pane Main Container & Back/Forward Navigation Helpers
  // =========================================================================
  function ensureSplitLayoutEl() {
    let layout = containerEl.querySelector(':scope > .center-split-layout');
    if (!layout) {
      containerEl.innerHTML = '';
      layout = document.createElement('div');
      layout.className = 'center-split-layout';
      containerEl.appendChild(layout);
    } else {
      Array.from(containerEl.children).forEach((child) => {
        if (child !== layout && child.id !== 'center-drop-overlay' && child.id !== 'center-drop-insert-line') {
          child.remove();
        }
      });
    }
    return layout;
  }

  function ensureMainPaneEl() {
    const layout = ensureSplitLayoutEl();
    let mainPane = layout.querySelector(':scope > [data-role="center-main-pane"]');
    if (!mainPane) {
      mainPane = document.createElement('div');
      mainPane.className = 'center-split-main';
      mainPane.dataset.role = 'center-main-pane';
      mainPane.style.position = 'relative';
      const splitAnchor = layout.querySelector(':scope > [data-role="center-split-resizer"], :scope > .center-split-pane');
      if (splitAnchor) {
        layout.insertBefore(mainPane, splitAnchor);
      } else {
        layout.appendChild(mainPane);
      }
    }
    return mainPane;
  }

  function renderNavButtonsHtml() {
    const canBack = typeof canNavBack === 'function' ? canNavBack() : false;
    const canFwd = typeof canNavForward === 'function' ? canNavForward() : false;
    const backLabel = typeof getNavBackLabel === 'function' ? getNavBackLabel() : '';
    const fwdLabel = typeof getNavForwardLabel === 'function' ? getNavForwardLabel() : '';
    const backTitle = backLabel ? `返回：${backLabel} (Alt+←)` : '返回上一文档 (Alt+←)';
    const fwdTitle = fwdLabel ? `前进：${fwdLabel} (Alt+→)` : '前进下一文档 (Alt+→)';
    return `
      <div class="nav-history-group" role="group" aria-label="文档导航历史">
        <button type="button" class="nav-history-btn ${canBack ? '' : 'is-disabled'}" data-action="nav-back" title="${escapeHtml(backTitle)}" aria-label="后退" ${canBack ? '' : 'disabled'}>
          ${icon('arrow-left', 14)}
        </button>
        <button type="button" class="nav-history-btn ${canFwd ? '' : 'is-disabled'}" data-action="nav-forward" title="${escapeHtml(fwdTitle)}" aria-label="前进" ${canFwd ? '' : 'disabled'}>
          ${icon('arrow-right', 14)}
        </button>
      </div>
      <button type="button" class="pill-btn pill-btn-sm center-home-pill-btn" data-action="open-explorer-home" title="返回工作区主面板">🏠 主面板</button>
    `;
  }

  function syncNavButtonsUi() {
    const canBack = typeof canNavBack === 'function' ? canNavBack() : false;
    const canFwd = typeof canNavForward === 'function' ? canNavForward() : false;
    const backLabel = typeof getNavBackLabel === 'function' ? getNavBackLabel() : '';
    const fwdLabel = typeof getNavForwardLabel === 'function' ? getNavForwardLabel() : '';
    const backBtn = containerEl.querySelector('[data-action="nav-back"]');
    const fwdBtn = containerEl.querySelector('[data-action="nav-forward"]');
    if (backBtn) {
      backBtn.disabled = !canBack;
      backBtn.classList.toggle('is-disabled', !canBack);
      backBtn.title = backLabel ? `返回：${backLabel} (Alt+←)` : '返回上一文档 (Alt+←)';
    }
    if (fwdBtn) {
      fwdBtn.disabled = !canFwd;
      fwdBtn.classList.toggle('is-disabled', !canFwd);
      fwdBtn.title = fwdLabel ? `前进：${fwdLabel} (Alt+→)` : '前进下一文档 (Alt+→)';
    }
  }

  function getActiveMainScrollEl() {
    const mainPane = ensureMainPaneEl();
    return (
      mainPane.querySelector('.md-scroll-area') ||
      mainPane.querySelector('.md-editor:not([data-role])') ||
      mainPane.querySelector('.excel-table-wrap')
    );
  }

  function captureCurrentNavSnapshot() {
    if (!state.activeDoc || typeof updateCurrentNavSnapshot !== 'function') return;
    const scrollEl = getActiveMainScrollEl();
    updateCurrentNavSnapshot({
      scrollTop: scrollEl ? scrollEl.scrollTop : 0,
      pdfPage: state.activeDoc.type === 'pdf' ? state.pdf.currentPage : undefined,
      excelSheet: state.activeDoc.type === 'excel' ? state.excel.currentSheet : undefined,
    });
  }

  const LAST_SESSION_KEY = 'sln_last_session_v1';
  let lastSessionSaveTimer = null;

  function persistLastSessionNow() {
    if (!state.activeDoc?.path) return;
    try {
      const scrollEl = getActiveMainScrollEl();
      localStorage.setItem(
        LAST_SESSION_KEY,
        JSON.stringify({
          path: state.activeDoc.path,
          scrollTop: scrollEl ? Math.max(0, Math.round(scrollEl.scrollTop || 0)) : 0,
        })
      );
    } catch {
      // ignore storage quota errors
    }
  }

  function schedulePersistLastSession() {
    if (lastSessionSaveTimer) window.clearTimeout(lastSessionSaveTimer);
    lastSessionSaveTimer = window.setTimeout(() => {
      lastSessionSaveTimer = null;
      persistLastSessionNow();
    }, 350);
  }

  function readLastSession() {
    try {
      const raw = localStorage.getItem(LAST_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed.path === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  async function openInitialStartupDoc(items) {
    if (!Array.isArray(items) || items.length === 0) return false;
    const saved = readLastSession();
    const matched = saved?.path ? items.find((f) => isSamePath(f.path, saved.path)) : null;
    const target =
      matched ||
      items.find(
        (f) => String(f.ext || '').toLowerCase() === '.md' || String(f.name || '').toLowerCase().endsWith('.md')
      );
    if (!target?.path) return false;
    const doc = await openFile(target.path);
    if (doc && matched && Number.isFinite(saved?.scrollTop) && saved.scrollTop > 0) {
      window.requestAnimationFrame(() => {
        const scrollEl = getActiveMainScrollEl();
        if (scrollEl) scrollEl.scrollTop = saved.scrollTop;
      });
    }
    return Boolean(doc);
  }

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
    const host = ensureMainPaneEl();
    if (typeof window !== 'undefined' && window.getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }
    let overlay = host.querySelector('#center-drop-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'center-drop-overlay';
      overlay.className = 'center-drop-overlay';
      overlay.innerHTML = `
        <div style="font-size:22px;line-height:1;">✨</div>
        <div>松开即可插入到当前笔记</div>
      `;
      host.appendChild(overlay);
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

  function isMobileViewport() {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= 768 || Boolean(document.body?.classList?.contains('is-android-app'));
  }

  function syncMobileTopbarTitle(title) {
    const island = document.getElementById('dynamic-island');
    if (island) {
      const clean = String(title || '').trim() || 'SmartLocalNote';
      island.setAttribute('data-mobile-title', clean.slice(0, 22));
    }
  }

  function syncMobileMdBarBodyClass(active) {
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('has-mobile-md-bar', Boolean(active));
    }
  }

  function ensureDocTabOnMobile() {
    if (isMobileViewport() && store.state.mobileTab !== 'doc') {
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
          <button type="button" class="pill-btn pill-btn-primary" data-guard-act="save">💾 保存并退出</button>
          <button type="button" class="pill-btn pill-btn-danger" data-guard-act="discard">放弃修改</button>
          <button type="button" class="pill-btn" data-guard-act="cancel">取消</button>
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
  // Rendering: Explorer Home (Workspace Files + Global Todos) & Loading
  // =========================================================================
  const EXPLORER_TYPE_FILTERS = [
    { key: 'all', label: '全部', color: 'var(--text-primary)', bg: 'var(--bg-subtle)' },
    { key: 'md', label: 'MD', color: '#4F46E5', bg: 'rgba(79,70,229,0.12)' },
    { key: 'pdf', label: 'PDF', color: '#DC2626', bg: 'rgba(220,38,38,0.12)' },
    { key: 'word', label: 'Word', color: '#2563EB', bg: 'rgba(37,99,235,0.12)' },
    { key: 'excel', label: '表格', color: '#16A34A', bg: 'rgba(22,163,74,0.12)' },
    { key: 'ppt', label: 'PPT', color: '#EA580C', bg: 'rgba(234,88,12,0.12)' },
    { key: 'image', label: '图片', color: '#9333EA', bg: 'rgba(147,51,234,0.12)' },
    { key: 'code', label: '代码', color: '#0D9488', bg: 'rgba(13,148,136,0.12)' },
  ];

  function getWorkspaceFilesList() {
    const raw = store.state.files;
    if (Array.isArray(raw)) return raw;
    return Array.isArray(raw?.items) ? raw.items : [];
  }

  function getWorkspaceFoldersList() {
    const raw = store.state.files;
    if (Array.isArray(raw?.folders)) return raw.folders;
    return Array.isArray(store.state.folders) ? store.state.folders : [];
  }

  function findTodoStatsForFile(filePath) {
    const byFile = store.state.todos?.by_file;
    if (!byFile || !filePath) return null;
    if (byFile[filePath]) return byFile[filePath];
    for (const [k, v] of Object.entries(byFile)) {
      if (isSamePath(k, filePath)) return v;
    }
    return null;
  }

  function formatExplorerTime(mtimeSec) {
    const n = Number(mtimeSec);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n * 1000);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const pad = (v) => String(v).padStart(2, '0');
    if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.getFullYear() === now.getFullYear()) {
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function openExplorerRenameSheet(fileItem) {
    if (!fileItem?.path) return;
    const oldName = fileItem.name || getBaseName(fileItem.path);
    openSheet({
      title: '重命名文件',
      bodyHtml: `
        <form id="explorer-rename-form" style="display:flex;flex-direction:column;gap:8px;">
          <label for="explorer-rename-input" style="font-size:12.5px;font-weight:600;color:var(--text-secondary);">新文件名（含扩展名）</label>
          <input id="explorer-rename-input" type="text" class="apple-input" value="${escapeHtml(oldName)}" autocomplete="off" />
        </form>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="explorer-rename-cancel">取消</button>
        <button type="button" class="pill-btn pill-btn-primary" id="explorer-rename-submit">${icon('check', 13)} 确认重命名</button>
      `,
      onMount(card) {
        const input = card.querySelector('#explorer-rename-input');
        const submitBtn = card.querySelector('#explorer-rename-submit');
        card.querySelector('#explorer-rename-cancel')?.addEventListener('click', closeSheet);
        const doRename = async () => {
          const nextName = String(input?.value || '').trim();
          if (!nextName || nextName === oldName) {
            closeSheet();
            return;
          }
          if (submitBtn) submitBtn.disabled = true;
          try {
            const res = await api.post('/api/files/rename', {
              path: fileItem.path,
              new_name: nextName,
            });
            closeSheet();
            if (state.activeDoc && isSamePath(state.activeDoc.path, fileItem.path) && res?.path) {
              state.activeDoc.path = res.path;
              state.activeDoc.name = res.name || nextName;
              syncActiveFileStore();
            }
            await Promise.allSettled([
              store.refreshFilesList?.(),
              store.refreshAllTodos?.(),
            ]);
            showToast(`已重命名为「${res?.name || nextName}」`, 'success');
          } catch (err) {
            if (submitBtn) submitBtn.disabled = false;
            showToast(getErrorMsg(err, '重命名失败'), 'error');
          }
        };
        submitBtn?.addEventListener('click', doRename);
        card.querySelector('#explorer-rename-form')?.addEventListener('submit', (ev) => {
          ev.preventDefault();
          doRename();
        });
        window.requestAnimationFrame(() => {
          if (!input) return;
          input.focus();
          const dotIdx = oldName.lastIndexOf('.');
          input.setSelectionRange(0, dotIdx > 0 ? dotIdx : oldName.length);
        });
      },
    });
  }

  function isExplorerFileSelected(pathStr) {
    if (!pathStr) return false;
    const set = state.explorer.selectedPaths;
    if (set.has(pathStr)) return true;
    for (const p of set) {
      if (isSamePath(p, pathStr)) return true;
    }
    return false;
  }

  function setExplorerFileSelected(pathStr, selected) {
    if (!pathStr) return;
    const set = state.explorer.selectedPaths;
    for (const p of Array.from(set)) {
      if (p === pathStr || isSamePath(p, pathStr)) {
        set.delete(p);
      }
    }
    if (selected) {
      set.add(pathStr);
    }
  }

  function showExplorerItemContextMenu(e, kind, item) {
    e.preventDefault();
    e.stopPropagation();
    hideHoverPeekCard();
    const menu = ensureCapsuleMenuEl();
    if (kind === 'folder') {
      menu.innerHTML = `
        <button type="button" class="context-menu-item" data-exp-ctx="open-folder" role="menuitem">
          <span class="ctx-item-left"><span>📂</span><span>打开文件夹</span></span>
        </button>
        <div class="context-menu-sep" role="separator"></div>
        <button type="button" class="context-menu-item" data-exp-ctx="trash-folder-app" role="menuitem">
          <span class="ctx-item-left"><span>📦</span><span>移入内置回收站</span></span>
        </button>
        <button type="button" class="context-menu-item" data-exp-ctx="trash-folder-system" role="menuitem" style="color:var(--danger);">
          <span class="ctx-item-left"><span>🖥</span><span>扔进系统回收站</span></span>
        </button>
        <button type="button" class="context-menu-item" data-exp-ctx="remove-doc" role="menuitem">
          <span class="ctx-item-left"><span>✕</span><span>从工作台列表移除</span></span>
        </button>
      `;
    } else {
      menu.innerHTML = `
        <button type="button" class="context-menu-item" data-exp-ctx="open-doc" role="menuitem">
          <span class="ctx-item-left"><span>📄</span><span>打开文档</span></span>
        </button>
        <button type="button" class="context-menu-item" data-exp-ctx="split-doc" role="menuitem">
          <span class="ctx-item-left"><span>◫</span><span>分屏打开</span></span>
        </button>
        <button type="button" class="context-menu-item" data-exp-ctx="rename-doc" role="menuitem">
          <span class="ctx-item-left"><span>✏</span><span>重命名</span></span>
        </button>
        <div class="context-menu-sep" role="separator"></div>
        <button type="button" class="context-menu-item" data-exp-ctx="trash-doc-app" role="menuitem">
          <span class="ctx-item-left"><span>📦</span><span>移入内置回收站</span></span>
        </button>
        <button type="button" class="context-menu-item" data-exp-ctx="trash-doc-system" role="menuitem" style="color:var(--danger);">
          <span class="ctx-item-left"><span>🖥</span><span>扔进系统回收站</span></span>
        </button>
        <button type="button" class="context-menu-item" data-exp-ctx="remove-doc" role="menuitem">
          <span class="ctx-item-left"><span>✕</span><span>从工作台列表移除</span></span>
        </button>
      `;
    }

    menu.querySelectorAll('[data-exp-ctx]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const act = btn.dataset.expCtx;
        hideCapsuleContextMenu();
        if (act === 'open-folder') {
          state.explorer.scope = 'notes';
          state.explorer.relDir = item.rel_dir || '';
          renderExplorerHome({ refresh: false });
        } else if (act === 'trash-folder' || act === 'trash-folder-app' || act === 'trash-folder-system') {
          const trashMode = act === 'trash-folder-system' ? 'system' : 'app';
          try {
            await store.trashFile?.(item.path, trashMode);
            if (state.explorer.relDir && (state.explorer.relDir === item.rel_dir || state.explorer.relDir.startsWith(`${item.rel_dir}/`))) {
              state.explorer.relDir = item.parent_rel || '';
            }
            renderExplorerHome({ refresh: false });
          } catch (err) {
            showToast(getErrorMsg(err, '移入回收站失败'), 'error');
          }
        } else if (act === 'open-doc') {
          openFile(item.path);
        } else if (act === 'split-doc') {
          openSplitDoc({ path: item.path, name: item.name, ext: item.ext });
          if (store.state.activeCenterView === 'explorer' && typeof setCenterView === 'function') {
            setCenterView('doc');
          }
        } else if (act === 'rename-doc') {
          openExplorerRenameSheet(item);
        } else if (act === 'trash-doc' || act === 'trash-doc-app' || act === 'trash-doc-system') {
          const trashMode = act === 'trash-doc-system' ? 'system' : 'app';
          try {
            await store.trashFile?.(item.path, trashMode);
            setExplorerFileSelected(item.path, false);
            if (state.activeDoc && isSamePath(state.activeDoc.path, item.path)) {
              state.activeDoc = null;
              state.dirty = false;
              syncActiveFileStore();
            }
            await store.refreshAllTodos?.().catch(() => {});
            renderExplorerHome({ refresh: false });
          } catch (err) {
            showToast(getErrorMsg(err, '移入回收站失败'), 'error');
          }
        } else if (act === 'remove-doc') {
          try {
            await api.post('/api/files/remove', { path: item.path });
            setExplorerFileSelected(item.path, false);
            if (state.activeDoc && isSamePath(state.activeDoc.path, item.path)) {
              state.activeDoc = null;
              state.dirty = false;
              syncActiveFileStore();
            }
            await Promise.allSettled([
              store.refreshFilesList?.(),
              store.refreshAllTodos?.(),
            ]);
            renderExplorerHome({ refresh: false });
            showToast('已从工作台列表移除（磁盘原文件未删除）', 'info');
          } catch (err) {
            showToast(getErrorMsg(err, '移除失败'), 'error');
          }
        }
      });
    });

    menu.hidden = false;
    menu.classList.remove('hidden');
    menu.classList.add('is-open');
    const rect = menu.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - (rect.width || 220) - 10);
    const maxY = Math.max(8, window.innerHeight - (rect.height || 240) - 10);
    menu.style.left = `${Math.min(maxX, Math.max(8, e.clientX))}px`;
    menu.style.top = `${Math.min(maxY, Math.max(8, e.clientY))}px`;
  }

  function buildExplorerFilesSectionData() {
    const exp = state.explorer;
    const allItems = getWorkspaceFilesList();
    const allFolders = getWorkspaceFoldersList();
    if (allItems.length > 0 && exp.selectedPaths instanceof Set && exp.selectedPaths.size > 0) {
      const validSet = new Set(allItems.map((it) => it.path));
      for (const p of Array.from(exp.selectedPaths)) {
        if (!validSet.has(p) && !allItems.some((it) => isSamePath(it.path, p))) {
          exp.selectedPaths.delete(p);
        }
      }
    }
    const mountedDirs = Array.isArray(store.state.files?.dirs) ? store.state.files.dirs : [];
    const searchLower = String(exp.search || '').trim().toLowerCase();
    const typeFilter = exp.typeFilter || 'all';
    const hasFilter = Boolean(searchLower || typeFilter !== 'all');

    let folders = [];
    if (exp.scope === 'notes') {
      folders = allFolders.filter((f) => {
        const pRel = f.parent_rel || '';
        const inBranch = hasFilter
          ? (!exp.relDir || (f.rel_dir || '').startsWith(`${exp.relDir}/`) || pRel === exp.relDir)
          : pRel === (exp.relDir || '');
        if (!inBranch) return false;
        if (searchLower) {
          return `${f.name || ''} ${f.rel_dir || ''}`.toLowerCase().includes(searchLower);
        }
        return !hasFilter || typeFilter === 'all';
      });
    } else if (exp.scope === 'all' && typeFilter === 'all') {
      folders = allFolders.filter((f) => {
        if (searchLower) {
          return `${f.name || ''} ${f.rel_dir || ''}`.toLowerCase().includes(searchLower);
        }
        return !(f.parent_rel || '');
      });
    }

    const files = allItems.filter((f) => {
      if (exp.scope === 'notes') {
        if (f.source !== 'notes') return false;
        const fRel = f.rel_dir || '';
        const targetRel = exp.relDir || '';
        if (hasFilter) {
          if (targetRel && fRel !== targetRel && !fRel.startsWith(`${targetRel}/`)) return false;
        } else if (fRel !== targetRel) {
          return false;
        }
      } else if (exp.scope === 'imported') {
        if (f.source !== 'imported') return false;
      } else if (exp.scope === 'mounted') {
        if (f.source !== 'mounted_dir') return false;
        if (exp.mountedDir && !normalizePath(f.path).startsWith(normalizePath(exp.mountedDir))) {
          return false;
        }
      }

      if (typeFilter !== 'all') {
        const ft = getFileTypeStyle(f.name || '');
        if (ft.key !== typeFilter) return false;
      }
      if (searchLower) {
        const hay = `${f.name || ''} ${f.rel_dir || ''} ${f.group || ''} ${f.path || ''}`.toLowerCase();
        if (!hay.includes(searchLower)) return false;
      }
      return true;
    });

    const pinnedSet = new Set((store.state.pinnedFiles || []).map((p) => normalizePath(p)));
    files.sort((a, b) => {
      const pa = pinnedSet.has(normalizePath(a.path)) ? 0 : 1;
      const pb = pinnedSet.has(normalizePath(b.path)) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (Number(b.mtime) || 0) - (Number(a.mtime) || 0);
    });

    return { folders, files, mountedDirs, pinnedSet, allItems, allFolders };
  }

  function renderExplorerFilesPaneInnerHtml(data) {
    const exp = state.explorer;
    const { folders, files, pinnedSet, allFolders } = data;

    const folderSectionHtml =
      folders.length > 0
        ? `
          <div>
            <div class="explorer-section-label">
              <span>📁 子文件夹 (${folders.length})</span>
              <span style="font-weight:500;">可将下方文件拖入任意文件夹或顶部面包屑归档</span>
            </div>
            <div class="explorer-folder-grid">
              ${folders
                .map((fld) => {
                  const ft = getFileTypeStyle('', true);
                  return `
                    <div
                      class="explorer-folder-card"
                      draggable="true"
                      data-explorer-folder="${escapeHtml(fld.rel_dir)}"
                      data-folder-path="${escapeHtml(fld.path)}"
                      title="${escapeHtml(fld.rel_dir || fld.name)}"
                    >
                      <span class="explorer-ft-icon" style="color:${ft.color}; background:${ft.bg}; border:1px solid ${ft.border};">
                        ${icon(ft.iconName, 16)}
                      </span>
                      <div style="min-width:0; flex:1 1 auto;">
                        <div style="font-size:13px; font-weight:600; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                          ${escapeHtml(fld.name)}
                        </div>
                        <div style="font-size:11px; color:var(--text-tertiary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                          ${escapeHtml(fld.rel_dir || '子目录')}
                        </div>
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </div>
        `
        : '';

    const renderFileBadgesHtml = (file) => {
      const todoStat = findTodoStatsForFile(file.path);
      const todoHtml =
        todoStat && todoStat.total > 0
          ? todoStat.open > 0
            ? `<span class="explorer-todo-badge is-open" title="未完成待办 ${todoStat.open} 项">☑ ${todoStat.done}/${todoStat.total}</span>`
            : `<span class="explorer-todo-badge is-done" title="本篇待办已全部完成">✓ 全部完成</span>`
          : '';
      const dirText =
        file.rel_dir ||
        (file.source === 'notes' ? '默认笔记' : file.source === 'imported' ? '已导入' : file.group || '挂载目录');
      return { todoHtml, dirText };
    };

    const filesSectionHtml =
      files.length > 0
        ? `
          <div>
            <div class="explorer-section-label">
              <span>📄 工作区文档 (${files.length})</span>
              <span style="font-weight:500;">单击打开 · Ctrl+点击多选 · Shift+点击连选 · 拖入文件夹归档</span>
            </div>
            <div class="${exp.viewMode === 'list' ? 'explorer-file-list' : 'explorer-file-grid'}">
              ${files
                .map((file) => {
                  const ft = getFileTypeStyle(file.name || '');
                  const isPinned = pinnedSet.has(normalizePath(file.path));
                  const isCurrent = Boolean(state.activeDoc && isSamePath(state.activeDoc.path, file.path));
                  const isSelected = isExplorerFileSelected(file.path);
                  const { todoHtml, dirText } = renderFileBadgesHtml(file);
                  const mtimeStr = formatExplorerTime(file.mtime);
                  if (exp.viewMode === 'list') {
                    return `
                      <div
                        class="explorer-file-row ${isCurrent ? 'is-active-doc' : ''} ${isSelected ? 'is-selected' : ''}"
                        draggable="true"
                        data-explorer-file="${escapeHtml(file.path)}"
                        title="${escapeHtml(file.path)}"
                      >
                        <div style="display:flex; align-items:center; gap:8px; min-width:0; flex:1 1 auto; overflow:hidden;">
                          <input
                            type="checkbox"
                            class="explorer-select-check"
                            data-explorer-select="${escapeHtml(file.path)}"
                            ${isSelected ? 'checked' : ''}
                            title="勾选文件（Ctrl+点击多选 / Shift+点击区间连选）"
                            aria-label="选择 ${escapeHtml(file.name)}"
                          />
                          <span class="explorer-ft-icon" style="color:${ft.color}; background:${ft.bg}; border:1px solid ${ft.border}; width:26px; height:26px;">
                            ${icon(ft.iconName, 14)}
                          </span>
                          <span class="explorer-ft-badge" style="color:${ft.color}; background:${ft.bg}; border:1px solid ${ft.border}; flex-shrink:0;">
                            ${escapeHtml(ft.label)}
                          </span>
                          <span style="flex:1 1 auto; min-width:0; font-size:13px; font-weight:600; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                            ${escapeHtml(file.name)}
                          </span>
                          ${file.is_private ? `<span class="lock-badge" style="flex-shrink:0;" title="隐私锁">${icon('lock', 11)}</span>` : ''}
                          <span style="font-size:10.5px; color:var(--text-tertiary); padding:1px 6px; border-radius:var(--radius-pill); background:var(--bg-subtle); max-width:82px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-shrink:1;">
                            ${escapeHtml(dirText)}
                          </span>
                        </div>
                        <div style="display:flex; align-items:center; gap:6px; flex-shrink:0; white-space:nowrap;">
                          ${todoHtml}
                          ${mtimeStr ? `<span style="font-size:11px; color:var(--text-tertiary); white-space:nowrap;">${escapeHtml(mtimeStr)}</span>` : ''}
                          <button type="button" class="explorer-pin-btn ${isPinned ? 'is-pinned' : ''}" data-explorer-pin="${escapeHtml(file.path)}" title="${isPinned ? '取消置顶' : '置顶文件'}">
                            ${isPinned ? '★' : '☆'}
                          </button>
                          <button type="button" class="explorer-mobile-more-btn" data-explorer-mobile-more="${escapeHtml(file.path)}" aria-label="更多操作" title="更多操作">⋯</button>
                        </div>
                      </div>
                    `;
                  }
                  return `
                    <div
                      class="explorer-file-card ${isCurrent ? 'is-active-doc' : ''} ${isSelected ? 'is-selected' : ''}"
                      draggable="true"
                      data-explorer-file="${escapeHtml(file.path)}"
                      title="${escapeHtml(file.path)}"
                    >
                      <div class="explorer-card-head" style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                        <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                          <input
                            type="checkbox"
                            class="explorer-select-check"
                            data-explorer-select="${escapeHtml(file.path)}"
                            ${isSelected ? 'checked' : ''}
                            title="勾选文件（Ctrl+点击多选 / Shift+点击区间连选）"
                            aria-label="选择 ${escapeHtml(file.name)}"
                          />
                          <span class="explorer-ft-icon" style="color:${ft.color}; background:${ft.bg}; border:1px solid ${ft.border};">
                            ${icon(ft.iconName, 16)}
                          </span>
                          <span class="explorer-ft-badge" style="color:${ft.color}; background:${ft.bg}; border:1px solid ${ft.border};">
                            ${escapeHtml(ft.label)}
                          </span>
                          ${file.is_private ? `<span class="lock-badge" title="隐私锁">${icon('lock', 11)}</span>` : ''}
                        </div>
                        <button type="button" class="explorer-pin-btn ${isPinned ? 'is-pinned' : ''}" data-explorer-pin="${escapeHtml(file.path)}" title="${isPinned ? '取消置顶' : '置顶文件'}">
                          ${isPinned ? '★' : '☆'}
                        </button>
                      </div>
                      <div class="explorer-card-title" style="font-size:13.5px; font-weight:600; color:var(--text-primary); line-height:1.35; word-break:break-word;">
                        ${escapeHtml(file.name)}
                      </div>
                      <div class="explorer-card-meta" style="display:flex; align-items:center; justify-content:space-between; gap:6px; flex-wrap:wrap; margin-top:auto;">
                        <span class="explorer-card-dir" style="font-size:11px; color:var(--text-tertiary); padding:1px 7px; border-radius:var(--radius-pill); background:var(--bg-subtle); max-width:130px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                          ${escapeHtml(dirText)}
                        </span>
                        <div class="explorer-card-right" style="display:inline-flex; align-items:center; gap:6px;">
                          ${todoHtml}
                          ${mtimeStr ? `<span class="explorer-card-time" style="font-size:10.5px; color:var(--text-tertiary);">${escapeHtml(mtimeStr)}</span>` : ''}
                          <button type="button" class="explorer-mobile-more-btn" data-explorer-mobile-more="${escapeHtml(file.path)}" aria-label="更多操作" title="更多操作">⋯</button>
                        </div>
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </div>
        `
        : `
          <div class="empty-state" style="padding:36px 16px;">
            <p class="empty-title" style="font-size:14px;">当前筛选下暂无文件</p>
            <p class="empty-desc">可点击上方「+ 新建笔记」或切换筛选条件查看全部工作区文件。</p>
          </div>
        `;

    const selectedCount = exp.selectedPaths instanceof Set ? exp.selectedPaths.size : 0;
    const batchBarHtml =
      selectedCount > 0
        ? `
          <div class="explorer-batch-bar" data-explorer-role="batch-bar" role="region" aria-label="批量文件操作栏">
            <div style="display:inline-flex; align-items:center; gap:8px;">
              <span class="explorer-batch-count" style="font-size:12.5px; font-weight:700; color:var(--accent);">
                已选 ${selectedCount} 项
              </span>
            </div>
            <div style="display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <select
                class="apple-select explorer-batch-folder-select"
                data-explorer-role="batch-move-select"
                aria-label="📁 移至文件夹"
                style="width:auto; min-width:136px; height:26px; padding:2px 8px; font-size:11.5px; border-radius:var(--radius-pill);"
              >
                <option value="__placeholder__" selected>📁 移至文件夹…</option>
                <option value="">📁 默认笔记主目录 (根)</option>
                ${(allFolders || [])
                  .map(
                    (fld) =>
                      `<option value="${escapeHtml(fld.rel_dir)}">📁 ${escapeHtml(fld.rel_dir || fld.name)}</option>`
                  )
                  .join('')}
              </select>
              <button type="button" class="pill-btn pill-btn-sm" data-explorer-act="batch-pin" title="批量置顶或取消置顶">
                ★ 批量置顶
              </button>
              <button type="button" class="pill-btn pill-btn-sm" data-explorer-act="batch-trash-app" title="将已选文件移入软件内置回收站（可随时还原）">
                📦 批量入内置回收站
              </button>
              <button type="button" class="pill-btn pill-btn-sm pill-btn-danger" data-explorer-act="batch-trash-system" title="将已选文件扔进 Windows 系统回收站">
                🖥 批量入系统回收站
              </button>
              <button type="button" class="pill-btn pill-btn-sm" data-explorer-act="batch-clear-select" title="取消选择">
                ✕ 取消选择
              </button>
            </div>
          </div>
        `
        : '';

    return `${folderSectionHtml}${filesSectionHtml}${batchBarHtml}`;
  }

  function renderExplorerTodoPaneHtml() {
    const exp = state.explorer;
    const todosState = store.state.todos || { items: [], by_file: {}, stats: { total: 0, done: 0, open: 0 } };
    const allTodoItems = Array.isArray(todosState.items) ? todosState.items : [];
    const stats = todosState.stats || {
      total: allTodoItems.length,
      done: allTodoItems.filter((it) => Boolean(it?.checked)).length,
      open: allTodoItems.filter((it) => !it?.checked).length,
    };

    const groupsMap = new Map();
    for (const item of allTodoItems) {
      if (!item?.file_path) continue;
      if (exp.todoFilter === 'open' && item.checked) continue;
      if (exp.todoFilter === 'done' && !item.checked) continue;
      const key = item.file_path;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          file_path: item.file_path,
          file_name: item.file_name || getBaseName(item.file_path),
          items: [],
        });
      }
      groupsMap.get(key).items.push(item);
    }

    // If user is on 'all' or there are no todos yet, ensure active/first MD note is still reachable for quick todo creation
    const mdFiles = getWorkspaceFilesList().filter((f) => String(f.ext || '').toLowerCase() === '.md');
    const mdFt = getFileTypeStyle('note.md');
    const groups = Array.from(groupsMap.values());

    return `
      <div class="explorer-todo-header">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; flex-wrap:wrap;">
          <div style="display:flex; align-items:center; gap:7px;">
            <span style="font-size:13.5px; font-weight:700; color:var(--text-primary);">☑ 全库待办整理</span>
            <span style="font-size:11px; font-weight:600; padding:2px 8px; border-radius:var(--radius-pill); background:var(--bg-subtle); color:var(--text-secondary);">
              未完成 ${stats.open ?? 0} · 已完成 ${stats.done ?? 0}
            </span>
          </div>
          <div style="display:inline-flex; align-items:center; gap:4px;">
            <button type="button" class="pill-btn pill-btn-sm" data-explorer-act="refresh-todos" title="立即重新扫描全库待办" style="height:24px; padding:0 8px;">🔄</button>
            <button type="button" class="pill-btn pill-btn-sm" data-explorer-act="toggle-todo-full" title="${exp.todoPaneMode === 'full' ? '恢复双栏布局' : '全宽整理待办'}" style="height:24px; padding:0 8px;">
              ${exp.todoPaneMode === 'full' ? '◫ 双栏' : '⛶ 全屏'}
            </button>
          </div>
        </div>
        <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; flex-wrap:wrap;">
          <div style="display:inline-flex; align-items:center; gap:4px;">
            <button type="button" class="pill-btn pill-btn-sm ${exp.todoFilter === 'open' ? 'pill-btn-primary' : ''}" data-explorer-todo-filter="open" style="height:23px; padding:0 9px; font-size:11px;">未完成</button>
            <button type="button" class="pill-btn pill-btn-sm ${exp.todoFilter === 'all' ? 'pill-btn-primary' : ''}" data-explorer-todo-filter="all" style="height:23px; padding:0 9px; font-size:11px;">全部</button>
            <button type="button" class="pill-btn pill-btn-sm ${exp.todoFilter === 'done' ? 'pill-btn-primary' : ''}" data-explorer-todo-filter="done" style="height:23px; padding:0 9px; font-size:11px;">已完成</button>
          </div>
          ${
            mdFiles.length > 0
              ? `<button type="button" class="pill-btn pill-btn-sm" data-explorer-act="quick-add-first-todo" title="向「${escapeHtml(mdFiles[0].name)}」追加待办" style="height:23px; padding:0 8px; font-size:11px;">+ 速添待办</button>`
              : ''
          }
        </div>
      </div>
      <div class="explorer-todo-list" data-explorer-role="todo-list">
        ${
          groups.length === 0
            ? `
              <div class="empty-state" style="padding:28px 14px;">
                <p class="empty-title" style="font-size:13.5px;">${exp.todoFilter === 'open' ? '暂无未完成待办' : '当前筛选下暂无待办'}</p>
                <p class="empty-desc">在任意 .md 笔记中写下 <code>- [ ] 任务</code>，即可在此跨文档汇总与双向勾选。</p>
                ${
                  mdFiles.length > 0
                    ? `
                      <div style="width:100%; max-width:300px; margin-top:10px;">
                        <input
                          type="text"
                          class="apple-input"
                          data-explorer-todo-add="${escapeHtml(mdFiles[0].path)}"
                          placeholder="向 ${escapeHtml(mdFiles[0].name)} 添加：${escapeHtml(nextSequentialName('新建待办', []))}"
                          style="height:28px; font-size:12px;"
                        />
                      </div>
                    `
                    : ''
                }
              </div>
            `
            : groups
                .map((grp) => {
                  const collapsed = exp.collapsedTodoFiles.has(normalizePath(grp.file_path));
                  const fStat = findTodoStatsForFile(grp.file_path) || {
                    total: grp.items.length,
                    done: grp.items.filter((x) => x.checked).length,
                    open: grp.items.filter((x) => !x.checked).length,
                  };
                  const nextTodoPlaceholder = nextSequentialName(
                    '新建待办',
                    allTodoItems
                      .filter((x) => isSamePath(x.file_path, grp.file_path))
                      .map((x) => x.text || '')
                  );
                  return `
                    <div class="explorer-todo-group ${collapsed ? 'is-collapsed' : ''}" data-todo-group-path="${escapeHtml(grp.file_path)}">
                      <div class="explorer-todo-group-head">
                        <div style="display:flex; align-items:center; gap:6px; min-width:0; flex:1 1 auto;">
                          <button type="button" class="pill-btn pill-btn-sm" data-explorer-todo-collapse="${escapeHtml(grp.file_path)}" title="${collapsed ? '展开分组' : '折叠分组'}" style="height:20px; width:20px; padding:0; justify-content:center; font-size:10px;">
                            ${collapsed ? '▶' : '▼'}
                          </button>
                          <span class="explorer-ft-badge" style="color:${mdFt.color}; background:${mdFt.bg}; border:1px solid ${mdFt.border};">MD</span>
                          <button type="button" data-explorer-open-note="${escapeHtml(grp.file_path)}" title="打开 ${escapeHtml(grp.file_name)}" style="border:none; background:transparent; padding:0; font-size:12.5px; font-weight:700; color:var(--text-primary); cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:left;">
                            ${escapeHtml(grp.file_name)}
                          </button>
                        </div>
                        <span class="explorer-todo-badge ${fStat.open > 0 ? 'is-open' : 'is-done'}">
                          ${fStat.done}/${fStat.total}
                        </span>
                      </div>
                      <div class="explorer-todo-group-body">
                        <div class="explorer-todo-quick-add">
                          <input
                            type="text"
                            class="apple-input"
                            data-explorer-todo-add="${escapeHtml(grp.file_path)}"
                            placeholder="+ 快添待办（留空回车：${escapeHtml(nextTodoPlaceholder)}）"
                            style="height:26px; font-size:11.5px; padding:2px 8px;"
                          />
                        </div>
                        ${grp.items
                          .map(
                            (it) => `
                            <div class="explorer-todo-row ${it.checked ? 'is-checked' : ''}">
                              <input
                                type="checkbox"
                                class="explorer-todo-check"
                                data-explorer-todo-check="1"
                                data-file-path="${escapeHtml(it.file_path)}"
                                data-line-no="${Number(it.line_no) || 0}"
                                data-expected-text="${escapeHtml(it.text || '')}"
                                ${it.checked ? 'checked' : ''}
                              />
                              <div
                                class="explorer-todo-text"
                                data-explorer-todo-jump="${escapeHtml(it.file_path)}"
                                data-line-no="${Number(it.line_no) || 0}"
                                title="点击跳转至 ${escapeHtml(grp.file_name)} 第 ${Number(it.line_no) || 1} 行"
                              >
                                ${escapeHtml(it.text || '')}
                                ${
                                  it.heading
                                    ? `<span style="margin-left:6px; font-size:10.5px; color:var(--text-tertiary);">#${escapeHtml(it.heading)}</span>`
                                    : ''
                                }
                              </div>
                            </div>
                          `
                          )
                          .join('')}
                      </div>
                    </div>
                  `;
                })
                .join('')
        }
      </div>
    `;
  }

  function renderExplorerHome({ refresh = false } = {}) {
    hideFormatBar();
    removeDropInsertLine();
    syncMobileMdBarBodyClass(false);

    const mainPane = ensureMainPaneEl();
    const prevFilesScroll = mainPane.querySelector('.explorer-files-pane')?.scrollTop || 0;
    const prevTodosScroll = mainPane.querySelector('[data-explorer-role="todo-list"]')?.scrollTop || 0;

    const exp = state.explorer;
    const mobileSec = exp.mobileSection === 'todos' ? 'todos' : 'files';
    syncMobileTopbarTitle(mobileSec === 'todos' ? '全局待办' : '全部笔记');

    const filesData = buildExplorerFilesSectionData();
    const { mountedDirs, allItems, allFolders } = filesData;
    const todoStats = store.state.todos?.stats || {};
    const openTodoCount =
      todoStats.open != null
        ? Number(todoStats.open)
        : (store.state.todos?.items || []).filter((it) => !it?.checked).length;

    const currentRelSegments = exp.scope === 'notes' && exp.relDir ? exp.relDir.split('/').filter(Boolean) : [];
    const targetFolderNames = allFolders
      .filter((f) => (f.parent_rel || '') === (exp.scope === 'notes' ? exp.relDir : ''))
      .map((f) => f.name);
    const defaultNotePlaceholder = nextSequentialName(
      '新建笔记',
      allItems.map((f) => f.name)
    );
    const defaultFolderPlaceholder = nextSequentialName('新建文件夹', targetFolderNames);

    const todoPaneModeClass =
      exp.todoPaneMode === 'full'
        ? 'is-todo-full'
        : exp.todoPaneMode === 'collapsed'
        ? 'is-todo-collapsed'
        : '';

    const splitRatio = Math.min(0.78, Math.max(0.28, Number(exp.splitRatio) || 0.62));
    const filesPct = (splitRatio * 100).toFixed(1);
    const todoPct = ((1 - splitRatio) * 100).toFixed(1);
    const allVisibleSelected =
      filesData.files.length > 0 && filesData.files.every((f) => isExplorerFileSelected(f.path));

    mainPane.innerHTML = `
      <div class="explorer-home ${todoPaneModeClass}" data-mobile-section="${mobileSec}">
        <div class="explorer-mobile-seg" role="tablist" aria-label="主面板切换">
          <button
            type="button"
            class="explorer-mobile-seg-btn ${mobileSec === 'files' ? 'is-active' : ''}"
            data-explorer-mobile-sec="files"
            role="tab"
            aria-selected="${mobileSec === 'files'}"
          >📁 全部文件</button>
          <button
            type="button"
            class="explorer-mobile-seg-btn ${mobileSec === 'todos' ? 'is-active' : ''}"
            data-explorer-mobile-sec="todos"
            role="tab"
            aria-selected="${mobileSec === 'todos'}"
          >✅ 全局待办${openTodoCount > 0 ? ` (${openTodoCount})` : ''}</button>
        </div>
        <div class="explorer-topbar explorer-topbar-files-only">
          <div class="explorer-topbar-row">
            <div class="explorer-breadcrumbs" role="navigation" aria-label="工作区面包屑">
              <button type="button" class="explorer-crumb ${exp.scope === 'all' ? 'is-active' : ''}" data-explorer-scope="all">
                🏠 全部工作区
              </button>
              <button type="button" class="explorer-crumb ${exp.scope === 'notes' && !exp.relDir ? 'is-active' : ''}" data-explorer-scope="notes" data-rel-dir="" data-crumb-rel="">
                📁 默认笔记主目录
              </button>
              ${currentRelSegments
                .map((seg, idx) => {
                  const pathSoFar = currentRelSegments.slice(0, idx + 1).join('/');
                  const isLast = idx === currentRelSegments.length - 1;
                  return `
                    <span class="explorer-crumb-sep">/</span>
                    <button type="button" class="explorer-crumb ${isLast ? 'is-active' : ''}" data-explorer-scope="notes" data-rel-dir="${escapeHtml(pathSoFar)}" data-crumb-rel="${escapeHtml(pathSoFar)}">
                      ${escapeHtml(seg)}
                    </button>
                  `;
                })
                .join('')}
              <button type="button" class="explorer-crumb ${exp.scope === 'imported' ? 'is-active' : ''}" data-explorer-scope="imported">
                📎 已导入文件
              </button>
              ${
                mountedDirs.length > 0
                  ? mountedDirs
                      .map((dirPath) => {
                        const dName = getBaseName(dirPath) || dirPath;
                        const isActiveMounted = exp.scope === 'mounted' && isSamePath(exp.mountedDir, dirPath);
                        return `
                          <button type="button" class="explorer-crumb ${isActiveMounted ? 'is-active' : ''}" data-explorer-scope="mounted" data-mounted-dir="${escapeHtml(dirPath)}" title="${escapeHtml(dirPath)}">
                            🗂 ${escapeHtml(dName)}
                          </button>
                        `;
                      })
                      .join('')
                  : ''
              }
            </div>

            <div class="explorer-actions-group">
              ${
                state.activeDoc
                  ? `<button type="button" class="pill-btn pill-btn-sm" data-explorer-act="back-to-doc" title="回到正在打开的文档">📄 ${escapeHtml(state.activeDoc.name)}</button>`
                  : ''
              }
              <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-explorer-act="toggle-new-note">
                ${icon('plus', 13)} 新建笔记
              </button>
              <button type="button" class="pill-btn pill-btn-sm" data-explorer-act="toggle-new-folder">
                ${icon('folder-open', 13)} 新建文件夹
              </button>
              <button type="button" class="pill-btn pill-btn-sm ${exp.selectedPaths.size > 0 ? 'pill-btn-primary' : ''}" data-explorer-act="toggle-select-all" title="全选当前筛选文件或取消选择">
                ${allVisibleSelected ? '☑ 取消全选' : '☑ 全选 / 取消'}
              </button>
              <div class="segmented-pill" role="group" aria-label="视图切换" style="height:26px; padding:2px;">
                <button type="button" class="segmented-btn ${exp.viewMode === 'grid' ? 'is-active' : ''}" data-explorer-view="grid" style="height:22px; font-size:11px; padding:0 8px;">⊞ 网格</button>
                <button type="button" class="segmented-btn ${exp.viewMode === 'list' ? 'is-active' : ''}" data-explorer-view="list" style="height:22px; font-size:11px; padding:0 8px;">☰ 列表</button>
              </div>
              <button type="button" class="pill-btn pill-btn-sm" data-explorer-act="cycle-todo-pane" title="切换右栏待办展开 / 全屏 / 折叠">
                ${exp.todoPaneMode === 'collapsed' ? '☑ 展开待办' : exp.todoPaneMode === 'full' ? '◫ 双栏视图' : '◨ 折叠待办'}
              </button>
            </div>
          </div>

          <div class="explorer-topbar-row">
            <div style="position:relative; width:220px; max-width:100%; flex:0 1 240px;">
              <input
                type="search"
                class="apple-input"
                data-explorer-role="search"
                placeholder="筛选文件名或路径…"
                value="${escapeHtml(exp.search)}"
                style="height:28px; padding:3px 10px; font-size:12px;"
              />
            </div>
            <div class="explorer-filter-pills" role="group" aria-label="格式筛选">
              ${EXPLORER_TYPE_FILTERS.map((f) => {
                const active = exp.typeFilter === f.key;
                return `
                  <button
                    type="button"
                    class="explorer-type-pill ${active ? 'is-active' : ''}"
                    data-explorer-type="${f.key}"
                    style="color:${f.color}; background:${active ? f.bg : 'var(--bg-subtle)'}; ${active ? `border-color:${f.color};` : ''}"
                  >${f.label}</button>
                `;
              }).join('')}
            </div>
          </div>

          ${
            exp.inlineCreateMode === 'note' || exp.inlineCreateMode === 'folder'
              ? `
                <div class="explorer-quick-inline">
                  <span style="font-size:12px; font-weight:600; color:var(--text-primary);">
                    ${exp.inlineCreateMode === 'note' ? '📝 新建笔记：' : '📁 新建文件夹：'}
                  </span>
                  <input
                    type="text"
                    class="apple-input"
                    data-explorer-inline-input="1"
                    placeholder="${escapeHtml(exp.inlineCreateMode === 'note' ? `留空回车直接创建「${defaultNotePlaceholder}」` : `留空回车直接创建「${defaultFolderPlaceholder}」`)}"
                    style="flex:1 1 220px; height:28px; font-size:12.5px;"
                    autocomplete="off"
                  />
                  <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-explorer-act="confirm-inline-create">确认创建</button>
                  <button type="button" class="pill-btn pill-btn-sm" data-explorer-act="cancel-inline-create">取消</button>
                </div>
              `
              : ''
          }
        </div>

        <div class="explorer-body">
          <div class="explorer-files-pane" data-explorer-role="files-pane" style="flex:0 0 calc(${filesPct}% - 4px); width:calc(${filesPct}% - 4px);">
            ${renderExplorerFilesPaneInnerHtml(filesData)}
          </div>
          <div class="center-split-resizer explorer-split-resizer" data-role="explorer-split-resizer" title="左右拖动调整文件区与全局待办区宽度，双击恢复默认"></div>
          <aside class="explorer-todo-pane" data-explorer-role="todo-pane" style="flex:1 1 calc(${todoPct}% - 4px); width:calc(${todoPct}% - 4px);">
            ${renderExplorerTodoPaneHtml()}
          </aside>
        </div>
      </div>
    `;
    ensureDropOverlay();

    const homeEl = mainPane.querySelector('.explorer-home');
    const filesPane = mainPane.querySelector('.explorer-files-pane');
    const todoListEl = mainPane.querySelector('[data-explorer-role="todo-list"]');
    if (filesPane) filesPane.scrollTop = prevFilesScroll;
    if (todoListEl) todoListEl.scrollTop = prevTodosScroll;

    if (exp.inlineCreateMode) {
      window.requestAnimationFrame(() => mainPane.querySelector('[data-explorer-inline-input]')?.focus());
    }

    if (homeEl) {
      bindExplorerHomeEvents(homeEl);
    }

    if (refresh) {
      const now = Date.now();
      if (now - exp.lastRefreshAt > 800) {
        exp.lastRefreshAt = now;
        Promise.allSettled([
          store.refreshAllTodos?.(),
          store.refreshFilesList?.(),
        ]);
      }
    }
  }

  function bindExplorerHomeEvents(homeEl) {
    const selectExplorerRange = (targetPath) => {
      const visibleFiles = buildExplorerFilesSectionData().files;
      const anchorPath = state.explorer.lastClickedPath || targetPath;
      const i1 = visibleFiles.findIndex((f) => isSamePath(f.path, anchorPath));
      const i2 = visibleFiles.findIndex((f) => isSamePath(f.path, targetPath));
      if (i1 >= 0 && i2 >= 0) {
        const start = Math.min(i1, i2);
        const end = Math.max(i1, i2);
        for (let i = start; i <= end; i += 1) {
          setExplorerFileSelected(visibleFiles[i].path, true);
        }
      } else {
        setExplorerFileSelected(targetPath, !isExplorerFileSelected(targetPath));
      }
      state.explorer.lastClickedPath = targetPath;
    };

    const moveBatchPathsToFolder = async (paths, targetRelDir) => {
      const cleanPaths = (Array.isArray(paths) ? paths : [paths])
        .map((p) => String(p || '').trim())
        .filter(Boolean);
      if (cleanPaths.length === 0) return;
      try {
        const res = await store.moveFilesToFolder(cleanPaths, targetRelDir);
        if (state.activeDoc && Array.isArray(res?.moved)) {
          const hit = res.moved.find((m) => isSamePath(m?.from, state.activeDoc.path));
          if (hit?.to) {
            state.activeDoc.path = hit.to;
            state.activeDoc.name = getBaseName(hit.to);
            syncActiveFileStore();
          }
        }
        state.explorer.selectedPaths.clear();
        renderExplorerHome({ refresh: false });
        showToast(
          `已将 ${res?.count ?? cleanPaths.length} 项文件移至「${targetRelDir || '默认笔记主目录'}」`,
          'success'
        );
      } catch (err) {
        showToast(getErrorMsg(err, '移动文件失败'), 'error');
      }
    };

    const submitInlineCreate = async () => {
      const inp = homeEl.querySelector('[data-explorer-inline-input]');
      const mode = state.explorer.inlineCreateMode;
      const rawVal = String(inp?.value || '').trim();
      const targetRelDir = state.explorer.scope === 'notes' ? state.explorer.relDir || '' : '';

      if (mode === 'note') {
        const defaultName = nextSequentialName(
          '新建笔记',
          getWorkspaceFilesList().map((f) => f.name)
        );
        const title = rawVal || defaultName;
        if (inp) inp.disabled = true;
        try {
          const created = await api.post('/api/files/create-note', {
            title,
            content: '',
            folder_rel: targetRelDir,
          });
          state.explorer.inlineCreateMode = '';
          await store.refreshFilesList?.().catch(() => {});
          if (created?.path) {
            await openFile(created.path, { mode: 'live' });
            appendNewBlockAndFocus();
          }
          showToast(`已创建笔记：${created?.name || title}`, 'success');
        } catch (err) {
          if (inp) inp.disabled = false;
          showToast(getErrorMsg(err, '创建笔记失败'), 'error');
        }
      } else if (mode === 'folder') {
        if (inp) inp.disabled = true;
        try {
          const res = await store.createFolder?.(targetRelDir, rawVal);
          state.explorer.inlineCreateMode = '';
          renderExplorerHome({ refresh: false });
          showToast(`已创建文件夹：${res?.name || rawVal || '新建文件夹'}`, 'success');
        } catch (err) {
          if (inp) inp.disabled = false;
          showToast(getErrorMsg(err, '创建文件夹失败'), 'error');
        }
      }
    };

    const searchInput = homeEl.querySelector('[data-explorer-role="search"]');
    searchInput?.addEventListener('input', () => {
      state.explorer.search = searchInput.value || '';
      const fp = homeEl.querySelector('[data-explorer-role="files-pane"]');
      if (fp) {
        fp.innerHTML = renderExplorerFilesPaneInnerHtml(buildExplorerFilesSectionData());
      }
    });

    homeEl.addEventListener('keydown', async (e) => {
      if (e.target.matches('[data-explorer-inline-input]')) {
        if (e.key === 'Enter') {
          e.preventDefault();
          await submitInlineCreate();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          state.explorer.inlineCreateMode = '';
          renderExplorerHome({ refresh: false });
        }
        return;
      }

      if (e.target.matches('[data-explorer-todo-add]')) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const inputEl = e.target;
        const filePath = inputEl.dataset.explorerTodoAdd;
        if (!filePath || inputEl.disabled) return;
        const todoText = String(inputEl.value || '').trim();
        inputEl.disabled = true;
        try {
          const res = await store.addWorkspaceTodo?.(filePath, todoText);
          if (typeof res?.content === 'string' && state.activeDoc && isSamePath(state.activeDoc.path, filePath) && !state.dirty) {
            state.activeDoc.content = res.content;
            store.state.activeDocumentText = res.content;
          }
          showToast(`已添加待办：${res?.text || todoText || '新建待办'}`, 'success');
          renderExplorerHome({ refresh: false });
        } catch (err) {
          inputEl.disabled = false;
          showToast(getErrorMsg(err, '添加待办失败'), 'error');
        }
      }
    });

    homeEl.addEventListener('change', async (e) => {
      const moveSelect = e.target.closest('[data-explorer-role="batch-move-select"]');
      if (moveSelect) {
        const targetRel = moveSelect.value;
        if (targetRel === '__placeholder__') return;
        moveSelect.disabled = true;
        await moveBatchPathsToFolder(Array.from(state.explorer.selectedPaths), targetRel);
        return;
      }

      const cb = e.target.closest('[data-explorer-todo-check]');
      if (!cb) return;
      const filePath = cb.dataset.filePath;
      const lineNo = Number.parseInt(cb.dataset.lineNo, 10);
      const expectedText = cb.dataset.expectedText || '';
      const checked = Boolean(cb.checked);
      if (!filePath || !Number.isFinite(lineNo)) return;
      cb.disabled = true;
      try {
        await store.toggleWorkspaceTodo?.({
          file_path: filePath,
          line_no: lineNo,
          checked,
          expected_text: expectedText,
        });
      } catch (err) {
        cb.checked = !checked;
        cb.disabled = false;
        showToast(getErrorMsg(err, '同步待办状态失败'), 'error');
      }
    });

    homeEl.addEventListener('click', async (e) => {
      const selectCb = e.target.closest('[data-explorer-select]');
      if (selectCb) {
        e.stopPropagation();
        const p = selectCb.dataset.explorerSelect;
        if (!p) return;
        if (e.shiftKey && state.explorer.lastClickedPath) {
          selectExplorerRange(p);
        } else {
          setExplorerFileSelected(p, Boolean(selectCb.checked));
          state.explorer.lastClickedPath = p;
        }
        renderExplorerHome({ refresh: false });
        return;
      }

      const mobileSecBtn = e.target.closest('[data-explorer-mobile-sec]');
      if (mobileSecBtn) {
        const nextSec = mobileSecBtn.dataset.explorerMobileSec === 'todos' ? 'todos' : 'files';
        state.explorer.mobileSection = nextSec;
        if (isMobileViewport()) {
          store.setState({ mobileTab: nextSec === 'todos' ? 'todos' : 'doc' });
          store.emit('layout:changed');
        }
        renderExplorerHome({ refresh: false });
        return;
      }

      const mobileMoreBtn = e.target.closest('[data-explorer-mobile-more]');
      if (mobileMoreBtn) {
        e.stopPropagation();
        const filePath = mobileMoreBtn.dataset.explorerMobileMore;
        if (!filePath) return;
        const item = getWorkspaceFilesList().find((f) => isSamePath(f.path, filePath)) || {
          path: filePath,
          name: getBaseName(filePath),
        };
        const pinnedSet = new Set((store.state.pinnedFiles || []).map((p) => normalizePath(p)));
        const isPinned = pinnedSet.has(normalizePath(item.path));
        openSheet({
          title: item.name,
          bodyHtml: `
            <div class="mobile-action-sheet-list">
              <button type="button" class="mobile-sheet-action-btn" data-mfile-act="open">📄 打开文档</button>
              <button type="button" class="mobile-sheet-action-btn" data-mfile-act="pin">${isPinned ? '☆ 取消置顶' : '★ 置顶到顶部'}</button>
              <button type="button" class="mobile-sheet-action-btn" data-mfile-act="ai-sum">✨ AI 提炼摘要与待办</button>
              <button type="button" class="mobile-sheet-action-btn" data-mfile-act="copy-anchor">🔗 复制 [[双链]] 锚点</button>
              <button type="button" class="mobile-sheet-action-btn is-danger" data-mfile-act="trash">🗑 移入内置回收站</button>
            </div>
          `,
          footerHtml: `<button type="button" class="pill-btn pill-btn-ghost" data-mfile-act="close" style="width:100%;justify-content:center;">取消</button>`,
          onMount(card) {
            card.addEventListener('click', async (ev) => {
              const btn = ev.target.closest('[data-mfile-act]');
              if (!btn) return;
              const act = btn.dataset.mfileAct;
              closeSheet();
              if (act === 'open') {
                openFile(item.path);
              } else if (act === 'pin') {
                togglePinFile?.(item.path);
                renderExplorerHome({ refresh: false });
              } else if (act === 'ai-sum') {
                store.setState({ mobileTab: 'ai', rightMode: 'summary', rightCollapsed: false }, 'rightMode:changed');
                store.emit('layout:changed');
                store.emit('ai:summarize-request', { file_path: item.path, autoRun: true });
              } else if (act === 'copy-anchor') {
                copyInternal(`[[${item.name}]]`, '已复制双链锚点');
              } else if (act === 'trash') {
                try {
                  await store.trashFile?.(item.path, 'app');
                  if (state.activeDoc && isSamePath(state.activeDoc.path, item.path)) {
                    state.activeDoc = null;
                    state.dirty = false;
                    syncActiveFileStore();
                  }
                  await store.refreshAllTodos?.().catch(() => {});
                  renderExplorerHome({ refresh: false });
                } catch (err) {
                  showToast(getErrorMsg(err, '移入回收站失败'), 'error');
                }
              }
            });
          },
        });
        return;
      }

      const scopeBtn = e.target.closest('[data-explorer-scope]');
      if (scopeBtn) {
        state.explorer.scope = scopeBtn.dataset.explorerScope || 'all';
        state.explorer.relDir = scopeBtn.dataset.relDir || '';
        state.explorer.mountedDir = scopeBtn.dataset.mountedDir || '';
        renderExplorerHome({ refresh: false });
        return;
      }

      const typeBtn = e.target.closest('[data-explorer-type]');
      if (typeBtn) {
        state.explorer.typeFilter = typeBtn.dataset.explorerType || 'all';
        renderExplorerHome({ refresh: false });
        return;
      }

      const viewBtn = e.target.closest('[data-explorer-view]');
      if (viewBtn) {
        state.explorer.viewMode = viewBtn.dataset.explorerView === 'list' ? 'list' : 'grid';
        renderExplorerHome({ refresh: false });
        return;
      }

      const todoFilterBtn = e.target.closest('[data-explorer-todo-filter]');
      if (todoFilterBtn) {
        state.explorer.todoFilter = todoFilterBtn.dataset.explorerTodoFilter || 'open';
        renderExplorerHome({ refresh: false });
        return;
      }

      const collapseBtn = e.target.closest('[data-explorer-todo-collapse]');
      if (collapseBtn) {
        const key = normalizePath(collapseBtn.dataset.explorerTodoCollapse);
        if (state.explorer.collapsedTodoFiles.has(key)) {
          state.explorer.collapsedTodoFiles.delete(key);
        } else {
          state.explorer.collapsedTodoFiles.add(key);
        }
        renderExplorerHome({ refresh: false });
        return;
      }

      const openNoteBtn = e.target.closest('[data-explorer-open-note]');
      if (openNoteBtn) {
        const p = openNoteBtn.dataset.explorerOpenNote;
        if (p) openFile(p, { mode: 'live' });
        return;
      }

      const jumpTodoEl = e.target.closest('[data-explorer-todo-jump]');
      if (jumpTodoEl) {
        const p = jumpTodoEl.dataset.explorerTodoJump;
        const line = Number.parseInt(jumpTodoEl.dataset.lineNo, 10);
        if (p) openFile(p, Number.isFinite(line) ? { mode: 'live', line } : { mode: 'live' });
        return;
      }

      const pinBtn = e.target.closest('[data-explorer-pin]');
      if (pinBtn) {
        e.stopPropagation();
        const p = pinBtn.dataset.explorerPin;
        if (p && typeof togglePinFile === 'function') {
          togglePinFile(p);
          renderExplorerHome({ refresh: false });
        }
        return;
      }

      const actBtn = e.target.closest('[data-explorer-act]');
      if (actBtn) {
        const act = actBtn.dataset.explorerAct;
        if (act === 'back-to-doc') {
          if (typeof setCenterView === 'function') setCenterView('doc');
          return;
        }
        if (act === 'toggle-new-note') {
          state.explorer.inlineCreateMode = state.explorer.inlineCreateMode === 'note' ? '' : 'note';
          renderExplorerHome({ refresh: false });
          return;
        }
        if (act === 'toggle-new-folder') {
          state.explorer.inlineCreateMode = state.explorer.inlineCreateMode === 'folder' ? '' : 'folder';
          renderExplorerHome({ refresh: false });
          return;
        }
        if (act === 'toggle-select-all') {
          const visibleFiles = buildExplorerFilesSectionData().files;
          const allSelected = visibleFiles.length > 0 && visibleFiles.every((f) => isExplorerFileSelected(f.path));
          if (allSelected || (visibleFiles.length === 0 && state.explorer.selectedPaths.size > 0)) {
            state.explorer.selectedPaths.clear();
          } else {
            visibleFiles.forEach((f) => setExplorerFileSelected(f.path, true));
          }
          renderExplorerHome({ refresh: false });
          return;
        }
        if (act === 'batch-clear-select') {
          state.explorer.selectedPaths.clear();
          renderExplorerHome({ refresh: false });
          return;
        }
        if (act === 'batch-pin') {
          const paths = Array.from(state.explorer.selectedPaths);
          if (paths.length === 0) return;
          const pinnedSet = new Set((store.state.pinnedFiles || []).map((p) => normalizePath(p)));
          const allPinned = paths.every((p) => pinnedSet.has(normalizePath(p)));
          for (const p of paths) {
            const isP = pinnedSet.has(normalizePath(p));
            if (allPinned ? isP : !isP) {
              togglePinFile?.(p);
            }
          }
          renderExplorerHome({ refresh: false });
          showToast(allPinned ? `已取消置顶 ${paths.length} 项文件` : `已批量置顶 ${paths.length} 项文件`, 'success');
          return;
        }
        if (act === 'batch-trash-app' || act === 'batch-trash-system') {
          const mode = act === 'batch-trash-system' ? 'system' : 'app';
          const paths = Array.from(state.explorer.selectedPaths);
          if (paths.length === 0) return;
          actBtn.disabled = true;
          let okCount = 0;
          for (const p of paths) {
            try {
              await store.trashFile?.(p, mode);
              setExplorerFileSelected(p, false);
              if (state.activeDoc && isSamePath(state.activeDoc.path, p)) {
                state.activeDoc = null;
                state.dirty = false;
                syncActiveFileStore();
              }
              okCount += 1;
            } catch (err) {
              showToast(getErrorMsg(err, '移入回收站失败'), 'error');
            }
          }
          await store.refreshAllTodos?.().catch(() => {});
          renderExplorerHome({ refresh: false });
          if (okCount > 0) {
            showToast(
              mode === 'app'
                ? `已将 ${okCount} 项文件批量移入内置回收站`
                : `已将 ${okCount} 项文件批量移至系统回收站`,
              'success'
            );
          }
          return;
        }
        if (act === 'confirm-inline-create') {
          await submitInlineCreate();
          return;
        }
        if (act === 'cancel-inline-create') {
          state.explorer.inlineCreateMode = '';
          renderExplorerHome({ refresh: false });
          return;
        }
        if (act === 'cycle-todo-pane') {
          const cur = state.explorer.todoPaneMode;
          state.explorer.todoPaneMode = cur === 'side' ? 'collapsed' : 'side';
          renderExplorerHome({ refresh: false });
          return;
        }
        if (act === 'toggle-todo-full') {
          state.explorer.todoPaneMode = state.explorer.todoPaneMode === 'full' ? 'side' : 'full';
          renderExplorerHome({ refresh: false });
          return;
        }
        if (act === 'refresh-todos') {
          await store.refreshAllTodos?.().catch(() => {});
          showToast('已刷新全库待办', 'success');
          return;
        }
        if (act === 'quick-add-first-todo') {
          const firstInput = homeEl.querySelector('[data-explorer-todo-add]');
          if (firstInput) {
            firstInput.focus();
            firstInput.scrollIntoView({ block: 'nearest' });
          } else {
            const firstMd = getWorkspaceFilesList().find((f) => String(f.ext || '').toLowerCase() === '.md');
            if (firstMd) {
              const res = await store.addWorkspaceTodo?.(firstMd.path, '');
              if (typeof res?.content === 'string' && state.activeDoc && isSamePath(state.activeDoc.path, firstMd.path) && !state.dirty) {
                state.activeDoc.content = res.content;
                store.state.activeDocumentText = res.content;
              }
              showToast(`已向「${firstMd.name}」添加待办：${res?.text || '新建待办'}`, 'success');
            }
          }
          return;
        }
      }

      const folderCard = e.target.closest('[data-explorer-folder]');
      if (folderCard) {
        state.explorer.scope = 'notes';
        state.explorer.relDir = folderCard.dataset.explorerFolder || '';
        renderExplorerHome({ refresh: false });
        return;
      }

      const fileCard = e.target.closest('[data-explorer-file]');
      if (fileCard) {
        const p = fileCard.dataset.explorerFile;
        if (!p) return;
        const item = getWorkspaceFilesList().find((f) => isSamePath(f.path, p)) || { path: p, name: getBaseName(p), ext: getExtLower(p) };
        if (e.shiftKey) {
          e.preventDefault();
          selectExplorerRange(item.path);
          renderExplorerHome({ refresh: false });
          return;
        }
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          setExplorerFileSelected(item.path, !isExplorerFileSelected(item.path));
          state.explorer.lastClickedPath = item.path;
          renderExplorerHome({ refresh: false });
          return;
        }
        state.explorer.lastClickedPath = item.path;
        openFile(item.path);
      }
    });

    homeEl.addEventListener('contextmenu', (e) => {
      const folderCard = e.target.closest('[data-explorer-folder]');
      if (folderCard) {
        const relDir = folderCard.dataset.explorerFolder || '';
        const folderPath = folderCard.dataset.folderPath || '';
        const folder =
          getWorkspaceFoldersList().find((f) => f.rel_dir === relDir || isSamePath(f.path, folderPath)) || {
            rel_dir: relDir,
            path: folderPath,
            name: getBaseName(folderPath || relDir),
          };
        showExplorerItemContextMenu(e, 'folder', folder);
        return;
      }

      const fileCard = e.target.closest('[data-explorer-file]');
      if (fileCard) {
        const p = fileCard.dataset.explorerFile;
        const item = getWorkspaceFilesList().find((f) => isSamePath(f.path, p)) || {
          path: p,
          name: getBaseName(p),
          ext: getExtLower(p),
        };
        showExplorerItemContextMenu(e, 'file', item);
      }
    });

    homeEl.addEventListener('dragstart', (e) => {
      const fileCard = e.target.closest('[data-explorer-file]');
      if (fileCard) {
        const p = fileCard.dataset.explorerFile;
        const item = getWorkspaceFilesList().find((f) => isSamePath(f.path, p)) || {
          path: p,
          name: getBaseName(p),
          ext: getExtLower(p),
        };
        const isSel = isExplorerFileSelected(item.path);
        const batchPaths =
          isSel && state.explorer.selectedPaths.size > 0
            ? Array.from(state.explorer.selectedPaths)
            : [item.path];
        state.explorer.draggingPaths = batchPaths;
        setDragPayload(e, {
          type: 'file',
          kind: 'file',
          path: item.path,
          paths: batchPaths,
          name: item.name,
          ext: item.ext,
          label: batchPaths.length > 1 ? `${item.name} 等 ${batchPaths.length} 项` : item.name,
        });
        return;
      }

      const folderCard = e.target.closest('[data-explorer-folder]');
      if (folderCard) {
        const folderPath = folderCard.dataset.folderPath || '';
        const relDir = folderCard.dataset.explorerFolder || '';
        const name = getBaseName(folderPath || relDir);
        setDragPayload(e, {
          type: 'folder',
          kind: 'folder',
          path: folderPath,
          name,
          label: name,
        });
      }
    });

    homeEl.addEventListener('dragover', (e) => {
      const dropTarget = e.target.closest(
        '.explorer-folder-card[data-explorer-folder], .explorer-crumb[data-crumb-rel]'
      );
      if (!dropTarget) return;
      const activePayload = store.state.activeDragPayload;
      const hasFiles =
        (Array.isArray(state.explorer.draggingPaths) && state.explorer.draggingPaths.length > 0) ||
        activePayload?.type === 'file' ||
        activePayload?.kind === 'file';
      if (!hasFiles && !Array.from(e.dataTransfer?.types || []).includes(DRAG_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
      homeEl.querySelectorAll('.is-drop-target').forEach((el) => {
        if (el !== dropTarget) el.classList.remove('is-drop-target');
      });
      dropTarget.classList.add('is-drop-target');
    });

    homeEl.addEventListener('dragleave', (e) => {
      const dropTarget = e.target.closest(
        '.explorer-folder-card[data-explorer-folder], .explorer-crumb[data-crumb-rel]'
      );
      if (!dropTarget) return;
      if (!e.relatedTarget || !dropTarget.contains(e.relatedTarget)) {
        dropTarget.classList.remove('is-drop-target');
      }
    });

    homeEl.addEventListener('drop', async (e) => {
      const dropTarget = e.target.closest(
        '.explorer-folder-card[data-explorer-folder], .explorer-crumb[data-crumb-rel]'
      );
      homeEl.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
      if (!dropTarget) return;
      e.preventDefault();
      e.stopPropagation();
      const payload = readDragPayload(e);
      const paths =
        Array.isArray(payload?.paths) && payload.paths.length > 0
          ? payload.paths
          : Array.isArray(state.explorer.draggingPaths) && state.explorer.draggingPaths.length > 0
          ? state.explorer.draggingPaths
          : payload?.path
          ? [payload.path]
          : [];
      state.explorer.draggingPaths = null;
      clearDragPayload();
      store.endGlobalDrag?.();
      if (paths.length === 0) return;
      const targetRelDir =
        dropTarget.dataset.explorerFolder !== undefined
          ? dropTarget.dataset.explorerFolder
          : dropTarget.dataset.crumbRel || '';
      await moveBatchPathsToFolder(paths, targetRelDir);
    });

    homeEl.addEventListener('dragend', () => {
      state.explorer.draggingPaths = null;
      homeEl.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
      clearDragPayload();
      store.endGlobalDrag?.();
    });
  }

  function renderWelcome() {
    renderExplorerHome({ refresh: false });
  }

  function renderLoading(label = '正在加载本地文档…') {
    hideFormatBar();
    removeDropInsertLine();
    ensureMainPaneEl().innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          ${renderNavButtonsHtml()}
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
  // Supports Floating Resizable Window ('float') & Resizable Split-Pane ('split')
  // =========================================================================
  function renderMobileCompanionTriggerHtml(doc) {
    if (!hasCompanionNote(doc) || state.companionOpen) return '';
    return `
      <div class="mobile-companion-bar">
        <button type="button" class="mobile-companion-trigger-btn" data-action="toggle-companion">
          <span>📝 伴生笔记${state.pdf.companionDirty ? ' · 未保存' : ''}</span>
          <span class="mobile-companion-trigger-hint">点击展开</span>
        </button>
      </div>
    `;
  }

  function renderCompanionPaneHtml(doc, { placeholderText = '', extraActionHtml = '' } = {}) {
    if (!state.companionOpen) return '';
    const isCompPreview = state.pdf.companionMode === 'preview';
    const disabledNote = !hasCompanionNote(doc);
    const isFloat = state.companionLayout !== 'split';

    const headerControlsHtml = `
      <div class="sheet-grabber companion-mobile-grabber" aria-hidden="true"></div>
      <div class="companion-float-header" data-role="companion-float-header" title="${isFloat ? '按住拖动伴生笔记浮窗位置' : '伴生笔记分屏栏'}">
        <div style="display:flex; align-items:center; gap:6px; min-width:0; overflow:hidden;">
          <span style="font-size:12.5px; font-weight:600; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${isFloat ? '❐ 伴生笔记' : '◫ 伴生笔记'}</span>
          <span
            data-role="pdf-companion-dirty"
            title="伴生笔记有未保存修改"
            style="width:7px; height:7px; border-radius:9999px; background:var(--warning); display:${state.pdf.companionDirty ? 'inline-block' : 'none'}; flex-shrink:0;"
          ></span>
        </div>

        <div style="display:inline-flex; align-items:center; gap:4px; flex-shrink:0;">
          <button type="button" class="pill-btn pill-btn-sm desktop-only-inline ${isFloat ? 'pill-btn-primary' : ''}" data-action="companion-set-float" title="切换为可自由拖动与调节大小的浮窗模块" style="height:22px;padding:0 7px;font-size:11px;">浮窗</button>
          <button type="button" class="pill-btn pill-btn-sm desktop-only-inline ${!isFloat ? 'pill-btn-primary' : ''}" data-action="companion-set-split" title="切换为可拖动分隔条调节左右间距的分屏模式" style="height:22px;padding:0 7px;font-size:11px;">分屏</button>
          <button type="button" class="pill-btn pill-btn-sm companion-close-btn" data-action="toggle-companion" title="收起伴生笔记" style="height:22px;width:22px;padding:0;">✕</button>
        </div>
      </div>
    `;

    const innerBodyHtml = `
      <div class="pdf-side-notes" style="padding:8px 12px 12px; gap:8px;">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px; flex-shrink:0;">
          <div style="display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap;">
            <div class="segmented-pill" data-seg="pdf-companion-mode" role="tablist" aria-label="伴生笔记模式" style="height:24px;">
              <div class="segmented-thumb" style="width:calc(50% - 3px); transform:translateX(${isCompPreview ? '100%' : '0%'});"></div>
              <button type="button" class="segmented-btn ${!isCompPreview ? 'is-active' : ''}" data-comp-mode="edit" role="tab" aria-selected="${!isCompPreview}" style="height:20px;padding:0 8px;font-size:11px;">
                编辑
              </button>
              <button type="button" class="segmented-btn ${isCompPreview ? 'is-active' : ''}" data-comp-mode="preview" role="tab" aria-selected="${isCompPreview}" style="height:20px;padding:0 8px;font-size:11px;">
                预览
              </button>
            </div>
            ${renderTypographyControlsHtml(true)}
          </div>
          <div style="display:inline-flex; align-items:center; gap:5px; flex-wrap:wrap;">
            ${extraActionHtml}
            <button type="button" class="pill-btn pill-btn-sm ${state.pdf.companionDirty ? 'pill-btn-primary' : ''}" data-action="pdf-save-companion" ${disabledNote ? 'disabled' : ''}>
              ${icon('save', 12)} 保存
            </button>
          </div>
        </div>

        <div style="flex:1 1 auto; min-height:0; display:flex; flex-direction:column;">
          ${
            disabledNote
              ? `<div class="empty-state"><p class="empty-desc">当前文件暂无关联伴生笔记路径</p></div>`
              : isCompPreview
              ? `<div class="md-scroll-area"><div class="md-preview" style="padding:8px 6px 28px;">${renderMarkdownSafe(doc.companionContent || '', { withLineMap: true })}</div></div>`
              : `<textarea class="md-editor" data-role="pdf-companion-editor" spellcheck="false" style="min-height:130px; flex:1 1 auto; padding:10px 12px; border:1px solid var(--border-hairline); border-radius:var(--radius-control); background:var(--bg-subtle);" placeholder="${escapeHtml(placeholderText || `随时记录关于 ${doc.name} 的伴生笔记…`)}">${escapeHtml(doc.companionContent || '')}</textarea>`
          }
        </div>
      </div>
    `;

    if (isFloat) {
      const r = state.companionFloatRect || { right: 16, top: 14, left: null, w: 360, h: 430 };
      const hostEl = containerEl.querySelector(':scope > .center-split-layout > [data-role="center-main-pane"]') || containerEl;
      const hostW = Math.max(320, hostEl?.clientWidth || window.innerWidth || 960);
      const hostH = Math.max(260, (hostEl?.clientHeight || window.innerHeight || 680) - 56);
      const clampedW = Math.min(Math.max(260, Math.round(r.w || 360)), Math.max(260, hostW - 20));
      const clampedH = Math.min(Math.max(220, Math.round(r.h || 430)), Math.max(220, hostH - 20));
      const maxLeft = Math.max(8, hostW - clampedW - 8);
      const maxTop = Math.max(8, hostH - Math.min(clampedH, 120) - 8);
      const posStyle = Number.isFinite(r.left)
        ? `left:${Math.min(maxLeft, Math.max(8, Math.round(r.left)))}px;`
        : `right:${Math.max(8, Math.round(r.right ?? 16))}px;`;
      const topStyle = `top:${Math.min(maxTop, Math.max(8, Math.round(r.top ?? 14)))}px;`;
      const sizeStyle = `width:${clampedW}px; height:${clampedH}px; max-width:calc(100% - 16px); max-height:calc(100% - 16px);`;
      return `
        <div class="companion-float-win" data-role="companion-float-win" style="${posStyle}${topStyle}${sizeStyle}">
          ${headerControlsHtml}
          ${innerBodyHtml}
          <div class="comp-resize-handle comp-resize-w" data-comp-resize="w" title="拖动调节宽度"></div>
          <div class="comp-resize-handle comp-resize-e" data-comp-resize="e" title="拖动调节宽度"></div>
          <div class="comp-resize-handle comp-resize-s" data-comp-resize="s" title="拖动调节高度"></div>
          <div class="comp-resize-handle comp-resize-sw" data-comp-resize="sw" title="拖动调节大小"></div>
          <div class="comp-resize-handle comp-resize-se" data-comp-resize="se" title="拖动调节大小"></div>
        </div>
      `;
    }

    const pct = (Math.min(0.72, Math.max(0.22, state.companionSplitRatio || 0.36)) * 100).toFixed(1);
    return `
      <div class="companion-split-resizer" data-role="companion-split-resizer" title="拖动调节伴生笔记左右间距（双击恢复默认比例）"></div>
      <div data-role="companion-split-pane" style="flex:0 0 ${pct}%; width:${pct}%; min-width:230px; max-width:75%; height:100%; display:flex; flex-direction:column; border-left:1px solid var(--border-hairline); background:var(--bg-island); overflow:hidden;">
        ${headerControlsHtml}
        ${innerBodyHtml}
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
  // Rendering: Markdown / TXT Mode (3-mode: 实时编辑 | 纯源码 | 🧠 脑图)
  // =========================================================================
  function showMdMindMapResultSheet(targetDoc, outline) {
    if (!outline) return;
    openSheet({
      title: `AI 提炼脑图大纲 · ${targetDoc.name}`,
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
        card.querySelector('#ai-mm-apply')?.addEventListener('click', async () => {
          if (state.activeDoc && isSamePath(state.activeDoc.path, targetDoc.path)) {
            pushUndoSnapshot(state.activeDoc.content, { immediate: true });
            state.activeDoc.content = outline;
            state.dirty = true;
            state.editingBlockIdx = null;
            state.editingBlockRange = null;
            state.editingDraftInsert = null;
            store.state.activeDocumentText = outline;
            closeSheet();
            renderMarkdownMode();
            showToast('已应用 AI 脑图大纲（Ctrl+S 保存）', 'success');
          } else {
            try {
              await api.put('/api/files/write', { path: targetDoc.path, content: outline });
              closeSheet();
              await openFile(targetDoc.path, { skipUnsavedGuard: true, forceReload: true, mode: 'mindmap' });
              showToast(`已写入 ${targetDoc.name} 脑图大纲`, 'success');
            } catch (err) {
              showToast(getErrorMsg(err, '写入脑图大纲失败'), 'error');
            }
          }
        });
      },
    });
  }

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
        const snapDoc = { path: doc.path, name: doc.name, content: doc.content || '' };
        const taskId = `mm_${Date.now()}`;
        setBgAiTask({ id: taskId, label: `AI 正在提炼 ${snapDoc.name} 脑图…`, status: 'running' });
        showToast('AI 已在后台运行，可继续浏览编辑', 'info', { duration: 2200 });
        try {
          const res = await api.post('/api/ai/mindmap', {
            text: snapDoc.content,
            file_path: snapDoc.path,
          });
          const outline = String(res?.markdown || res?.outline || res?.content || '').trim();
          if (!outline) {
            setBgAiTask({ id: taskId, label: 'AI 未返回有效脑图大纲', status: 'error' });
            showToast('AI 未返回有效脑图大纲', 'warning');
            return null;
          }
          setBgAiTask({
            id: taskId,
            label: `AI 脑图已完成 · ${snapDoc.name}`,
            status: 'done',
            onOpen: () => showMdMindMapResultSheet(snapDoc, outline),
          });
          showToast(`AI 脑图已生成 · ${snapDoc.name}`, 'success', {
            duration: 4200,
            actionLabel: '查看脑图',
            onAction: () => showMdMindMapResultSheet(snapDoc, outline),
          });
          return outline;
        } catch (err) {
          setBgAiTask({ id: taskId, label: 'AI 脑图生成失败', status: 'error' });
          showToast(getErrorMsg(err, 'AI 脑图生成失败'), 'error');
          return null;
        }
      },
    });
  }

  function renderLiveBlocksHtml(doc) {
    const blocks = parseMarkdownBlocks(doc.content || '');
    const editingIdx = state.editingBlockIdx;
    const draftInsert = state.editingDraftInsert;
    const draftNew = state.editingDraftNewBlock && editingIdx === blocks.length && !draftInsert;

    const makeDraftHtml = (blockIdx, startLine, initialHtml = '<p><br></p>') => `
      <div class="lp-block is-editing" data-block-idx="${blockIdx}" data-md-start="${startLine}" data-md-end="${startLine}" data-draft-block="1">
        <div class="lp-block-view lp-block-wysiwyg" contenteditable="true" data-block-idx="${blockIdx}" data-placeholder="输入内容，或输入 / 呼出斜杠命令…" spellcheck="false">${initialHtml}</div>
      </div>
    `;

    const parts = [];
    if (draftInsert && draftInsert.afterBlockIdx === -1) {
      parts.push(makeDraftHtml(-1, draftInsert.startLine, draftInsert.initialHtml || '<p><br></p>'));
    }

    blocks.forEach((blk, idx) => {
      const isEditing = !draftInsert && editingIdx === idx;
      if (isEditing) {
        state.editingBlockRange = { startLine: blk.startLine, endLine: blk.endLine };
        parts.push(`
          <div class="lp-block is-editing" data-block-idx="${idx}" data-md-start="${blk.startLine}" data-md-end="${blk.endLine}">
            <div class="lp-block-view lp-block-wysiwyg" contenteditable="true" data-block-idx="${idx}" data-placeholder="输入内容，或输入 / 呼出斜杠命令…" spellcheck="false">${markdownToWysiwygBlockHtml(blk.raw)}</div>
          </div>
        `);
      } else {
        parts.push(`
          <div class="lp-block" data-block-idx="${idx}" data-md-start="${blk.startLine}" data-md-end="${blk.endLine}">
            <div class="lp-block-view" data-md-start="${blk.startLine}" data-md-end="${blk.endLine}">
              ${markdownToWysiwygBlockHtml(blk.raw)}
            </div>
          </div>
        `);
      }
      if (draftInsert && draftInsert.afterBlockIdx === idx) {
        const afterLine = blk.endLine + 1;
        state.editingBlockRange = { startLine: afterLine, endLine: afterLine };
        parts.push(makeDraftHtml(idx + 1, afterLine, draftInsert.initialHtml || '<p><br></p>'));
      }
    });

    let draftHtml = '';
    if (draftNew) {
      const totalLines = getMdLines().length;
      const startLine = Math.max(0, totalLines - 1);
      state.editingBlockRange = { startLine, endLine: startLine };
      draftHtml = makeDraftHtml(blocks.length, startLine);
    }

    return `
      <div class="md-scroll-area">
        <div class="lp-container md-preview">
          ${parts.join('')}
          ${draftHtml}
          <div class="lp-add-block-zone" data-action="lp-add-block" role="button" tabindex="0">
            ${blocks.length === 0 && !draftNew && !draftInsert ? '+ 点击此处开始书写笔记（支持 / 斜杠命令、拖拽块、[[文件锚点]]）…' : '+ 点击此处继续书写…'}
          </div>
        </div>
      </div>
    `;
  }

  function placeCaretInsideWysiwyg(editorEl, cursorMode = 'end', clickPoint = null) {
    if (!editorEl || typeof window === 'undefined') return;
    const sel = window.getSelection();
    if (!sel) return;

    if (clickPoint && Number.isFinite(clickPoint.x) && Number.isFinite(clickPoint.y)) {
      let range = null;
      if (typeof document.caretRangeFromPoint === 'function') {
        range = document.caretRangeFromPoint(clickPoint.x, clickPoint.y);
      } else if (typeof document.caretPositionFromPoint === 'function') {
        const pos = document.caretPositionFromPoint(clickPoint.x, clickPoint.y);
        if (pos && pos.offsetNode) {
          range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
          range.collapse(true);
        }
      }
      if (range && editorEl.contains(range.startContainer)) {
        const ceFalse = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)?.closest('[contenteditable="false"]');
        if (!ceFalse || ceFalse === editorEl) {
          sel.removeAllRanges();
          sel.addRange(range);
          return;
        }
      }
    }

    const range = document.createRange();
    range.selectNodeContents(editorEl);
    range.collapse(cursorMode === 'start');
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function focusActiveBlockEditor(cursorMode = 'end', clickPoint = null) {
    window.requestAnimationFrame(() => {
      const editorEl = containerEl.querySelector('.lp-block-wysiwyg');
      if (!editorEl) return;
      editorEl.focus({ preventScroll: true });
      placeCaretInsideWysiwyg(editorEl, cursorMode, clickPoint);
    });
  }

  function cleanupEmptyTrailingDraftIfNeeded() {
    if (!state.editingDraftNewBlock && !state.editingDraftInsert) return;
    state.editingDraftNewBlock = false;
    state.editingDraftInsert = null;
    if (!state.activeDoc) return;
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
    if (state.editingBlockIdx === null && !state.editingDraftNewBlock && !state.editingDraftInsert) {
      return false;
    }
    closeSlashMenu();
    const doc = state.activeDoc;
    const editorEl = containerEl.querySelector('.lp-block-wysiwyg');
    if (doc && editorEl) {
      const val = wysiwygElementToMarkdown(editorEl);
      if ((state.editingDraftNewBlock || state.editingDraftInsert) && !val.trim()) {
        cleanupEmptyTrailingDraftIfNeeded();
      } else {
        state.editingDraftNewBlock = false;
        state.editingDraftInsert = null;
        if (!val.trim() && state.editingBlockRange) {
          const { startLine, endLine } = state.editingBlockRange;
          const lines = getMdLines();
          let delStart = startLine;
          let delCount = endLine - startLine + 1;
          if (delStart > 0 && lines[delStart - 1]?.trim() === '' && delStart + delCount < lines.length && lines[delStart + delCount]?.trim() === '') {
            delCount += 1;
          }
          lines.splice(delStart, delCount);
          doc.content = lines.join('\n').replace(/^\n+/, '');
          store.state.activeDocumentText = doc.content;
        }
      }
    } else {
      state.editingDraftNewBlock = false;
      state.editingDraftInsert = null;
    }

    state.editingBlockIdx = null;
    state.editingBlockRange = null;
    if (reRender && doc && (doc.type === 'markdown' || doc.type === 'text') && state.mdMode === 'live') {
      renderMarkdownMode();
    }
    return true;
  }

  function activateBlockByStartLine(targetStartLine, cursorMode = 'end', clickPoint = null) {
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
    state.editingDraftInsert = null;
    renderMarkdownMode();
    focusActiveBlockEditor(cursorMode, clickPoint);
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
    state.editingDraftInsert = null;
    renderMarkdownMode();
    focusActiveBlockEditor(cursorMode);
  }

  function insertDraftBlockAfter(afterBlockIdx, startLine, initialHtml = '<p><br></p>') {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
    state.editingBlockIdx = null;
    state.editingBlockRange = null;
    state.editingDraftNewBlock = false;
    state.editingDraftInsert = { afterBlockIdx, startLine, initialHtml };
    renderMarkdownMode();
    focusActiveBlockEditor('start');
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
    state.editingDraftInsert = null;
    store.state.activeDocumentText = doc.content;
    renderMarkdownMode();
    focusActiveBlockEditor('start');
  }

  function isCopyDragEvent(ev) {
    if (state.dragDefaultMode === 'copy') {
      return !Boolean(ev?.shiftKey);
    }
    return Boolean(ev?.ctrlKey || ev?.metaKey);
  }

  function setDragDefaultMode(nextMode, { showMsg = true } = {}) {
    const mode = nextMode === 'copy' ? 'copy' : 'cut';
    state.dragDefaultMode = mode;
    try {
      localStorage.setItem('sln_drag_default_mode', mode);
    } catch {
      // ignore
    }
    containerEl.querySelectorAll('[data-action="toggle-drag-mode"]').forEach((btn) => {
      btn.classList.toggle('pill-btn-primary', mode === 'copy');
      btn.title =
        mode === 'copy'
          ? '当前拖动默认：复制插入（按住 Shift 拖动为剪切移动，点击切换）'
          : '当前拖动默认：剪切移动（按住 Ctrl 拖动为复制插入，点击切换）';
      btn.innerHTML = `${icon(mode === 'copy' ? 'copy' : 'scissors', 12)}<span data-role="drag-mode-label">${mode === 'copy' ? '拖动:默认复制' : '拖动:默认剪切'}</span>`;
    });
    if (showMsg) {
      showToast(
        mode === 'copy'
          ? '已切换为「拖动默认：复制」（按住 Shift 为剪切移动）'
          : '已切换为「拖动默认：剪切移动」（按住 Ctrl 为复制）',
        'success',
        { duration: 2000 }
      );
    }
  }

  function renderWysiwygFormatBarHtml() {
    const isCopyDefault = state.dragDefaultMode === 'copy';
    return `
      <div class="wysiwyg-format-bar" data-role="wysiwyg-format-bar" role="toolbar" aria-label="文档格式工具栏">
        <button type="button" class="fmt-icon-btn" data-fmt-bar="h1" title="一级标题">${icon('heading-1', 14)}</button>
        <button type="button" class="fmt-icon-btn" data-fmt-bar="h2" title="二级标题">${icon('heading-2', 14)}</button>
        <button type="button" class="fmt-icon-btn" data-fmt-bar="h3" title="三级标题">${icon('heading-3', 14)}</button>
        <span class="fmt-sep" aria-hidden="true"></span>
        <button type="button" class="fmt-icon-btn" data-fmt-bar="bold" title="加粗 Ctrl+B">${icon('bold', 14)}</button>
        <button type="button" class="fmt-icon-btn" data-fmt-bar="italic" title="斜体 Ctrl+I">${icon('italic', 14)}</button>
        <button type="button" class="fmt-icon-btn" data-fmt-bar="strike" title="删除线 Ctrl+Shift+X">${icon('strikethrough', 14)}</button>
        <button type="button" class="fmt-icon-btn" data-fmt-bar="mark" title="荧光高亮">${icon('highlighter', 14)}</button>
        <button type="button" class="fmt-icon-btn" data-fmt-bar="code" title="行内代码 Ctrl+E">${icon('code', 14)}</button>
        <span class="fmt-sep" aria-hidden="true"></span>
        <button type="button" class="fmt-icon-btn" data-fmt-bar="quote" title="引用块 Ctrl+/">${icon('quote', 14)}</button>
        <button type="button" class="fmt-icon-btn" data-fmt-bar="ul" title="无序列表">${icon('list', 14)}</button>
        <button type="button" class="fmt-icon-btn" data-fmt-bar="todo" title="待办清单">${icon('list-checks', 14)}</button>
        <span class="fmt-sep" aria-hidden="true"></span>
        <button type="button" class="fmt-icon-btn" data-fmt-bar="cut" title="剪切 Ctrl+X">${icon('scissors', 14)}</button>
        <button type="button" class="fmt-icon-btn" data-fmt-bar="copy" title="复制 Ctrl+C">${icon('copy', 14)}</button>
        <button type="button" class="fmt-icon-btn" data-fmt-bar="paste" title="粘贴 Ctrl+V">${icon('clipboard-paste', 14)}</button>
        <span class="fmt-sep" aria-hidden="true"></span>
        <button
          type="button"
          class="pill-btn pill-btn-sm ${isCopyDefault ? 'pill-btn-primary' : ''}"
          data-action="toggle-drag-mode"
          title="${isCopyDefault ? '当前拖动默认：复制插入（按住 Shift 拖动为剪切移动，点击切换）' : '当前拖动默认：剪切移动（按住 Ctrl 拖动为复制插入，点击切换）'}"
          style="height:24px;padding:0 8px;font-size:11.5px;gap:4px;"
        >
          ${icon(isCopyDefault ? 'copy' : 'scissors', 12)}
          <span data-role="drag-mode-label">${isCopyDefault ? '拖动:默认复制' : '拖动:默认剪切'}</span>
        </button>
      </div>
    `;
  }

  function renderMobileMdKbdBarHtml(canUndo) {
    return `
      <div class="mobile-md-kbd-bar" data-role="mobile-md-kbd-bar" role="toolbar" aria-label="手机端 Markdown 快捷工具栏">
        <button type="button" class="mobile-md-kbd-btn" data-mobile-kbd="h1" aria-label="一级标题">H1</button>
        <button type="button" class="mobile-md-kbd-btn" data-mobile-kbd="h2" aria-label="二级标题">H2</button>
        <button type="button" class="mobile-md-kbd-btn" data-mobile-kbd="bold" aria-label="加粗"><strong>B</strong> 加粗</button>
        <button type="button" class="mobile-md-kbd-btn" data-mobile-kbd="todo" aria-label="待办">☑ 待办</button>
        <button type="button" class="mobile-md-kbd-btn" data-mobile-kbd="ul" aria-label="列表">• 列表</button>
        <button type="button" class="mobile-md-kbd-btn" data-mobile-kbd="mark" aria-label="高亮">== 高亮</button>
        <button type="button" class="mobile-md-kbd-btn" data-mobile-kbd="wikilink" aria-label="双链">[[ 双链</button>
        <button type="button" class="mobile-md-kbd-btn" data-mobile-kbd="tag" aria-label="标签"># 标签</button>
        <button type="button" class="mobile-md-kbd-btn" data-mobile-kbd="insert-image" aria-label="插入图片">📷 插图</button>
        <button type="button" class="mobile-md-kbd-btn" data-mobile-kbd="undo" aria-label="撤回" ${canUndo ? '' : 'disabled'}>↩ 撤回</button>
        <button type="button" class="mobile-md-kbd-btn ${state.dirty ? 'is-primary' : ''}" data-mobile-kbd="save" aria-label="保存">💾 保存</button>
      </div>
    `;
  }

  function insertRawSnippetAtActiveCursor(snippet, backOffset = 0) {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;

    if (state.mdMode === 'source') {
      const ta = ensureMainPaneEl().querySelector('.md-editor:not([data-role])');
      if (!ta) return;
      ta.focus();
      pushUndoSnapshot(doc.content, { immediate: true });
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? start;
      const nextVal = `${ta.value.slice(0, start)}${snippet}${ta.value.slice(end)}`;
      const caret = Math.max(start, start + snippet.length - backOffset);
      ta.value = nextVal;
      ta.setSelectionRange(caret, caret);
      doc.content = nextVal;
      state.dirty = true;
      store.state.activeDocumentText = nextVal;
      updateMdDirtyIndicators();
      return;
    }

    if (state.mdMode !== 'live') return;
    let editorEl = containerEl.querySelector('.lp-block-wysiwyg');
    if (!editorEl) {
      const targetBlk = containerEl.querySelector('.lp-block[data-block-idx]');
      if (targetBlk) {
        const bIdx = Number.parseInt(targetBlk.dataset.blockIdx, 10);
        if (Number.isFinite(bIdx)) {
          state.editingBlockIdx = bIdx;
          state.editingDraftNewBlock = false;
          state.editingDraftInsert = null;
          renderMarkdownMode();
          editorEl = containerEl.querySelector('.lp-block-wysiwyg');
          if (editorEl) {
            editorEl.focus({ preventScroll: true });
            placeCaretInsideWysiwyg(editorEl, 'end');
          }
        }
      } else {
        appendNewBlockAndFocus();
        window.requestAnimationFrame(() => {
          const ed = containerEl.querySelector('.lp-block-wysiwyg');
          if (ed) {
            ed.focus({ preventScroll: true });
            if (typeof document.execCommand === 'function') {
              document.execCommand('insertText', false, snippet);
            } else {
              ed.textContent = `${ed.textContent || ''}${snippet}`;
            }
            syncWysiwygBlockInput(ed);
          }
        });
        return;
      }
    }
    if (!editorEl) return;
    pushUndoSnapshot(doc.content, { immediate: true });
    editorEl.focus({ preventScroll: true });
    if (typeof document.execCommand === 'function') {
      document.execCommand('insertText', false, snippet);
    } else {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(snippet);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
      } else {
        editorEl.appendChild(document.createTextNode(snippet));
      }
    }
    syncWysiwygBlockInput(editorEl, { immediateUndoAlreadyPushed: true });
  }

  function insertImageMarkdownToActiveDoc(src, altName = '图片') {
    const doc = state.activeDoc;
    if (!doc || !src) return;
    const cleanAlt = String(altName || '图片').replace(/[\[\]()\r\n]/g, '').slice(0, 32) || '图片';
    const md = `![${cleanAlt}](${src})`;
    if (doc.type === 'markdown' || doc.type === 'text') {
      commitActiveBlock({ reRender: false });
      pushUndoSnapshot(doc.content, { immediate: true });
      const lines = getMdLines();
      const targetLine = Number.isFinite(state.editingBlockRange?.endLine)
        ? state.editingBlockRange.endLine + 1
        : lines.length;
      doc.content = insertMarkdownWithPadding(doc.content || '', targetLine, md);
      state.dirty = true;
      state.editingBlockIdx = null;
      state.editingBlockRange = null;
      state.editingDraftInsert = null;
      store.state.activeDocumentText = doc.content;
      renderMarkdownMode();
      showToast('已插入图片到当前笔记', 'success');
    } else if (hasCompanionNote(doc)) {
      insertTextIntoCompanionNote(md, { toastMsg: '已插入图片到伴生笔记' });
    }
  }

  function compressImageFileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.onload = () => {
        const rawUrl = String(reader.result || '');
        const img = new Image();
        img.onerror = () => resolve(rawUrl);
        img.onload = () => {
          const maxDim = 1280;
          let w = img.naturalWidth || img.width || 800;
          let h = img.naturalHeight || img.height || 600;
          if (w > maxDim || h > maxDim) {
            const scale = maxDim / Math.max(w, h);
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
          }
          try {
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              resolve(rawUrl);
              return;
            }
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.82));
          } catch {
            resolve(rawUrl);
          }
        };
        img.src = rawUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  function triggerMobileImageInsert() {
    const bridge = typeof window !== 'undefined' ? window.SmartLocalNoteAndroid : null;
    if (bridge && typeof bridge === 'object') {
      const fn =
        bridge.pickImage ||
        bridge.openCameraOrGallery ||
        bridge.captureImage ||
        bridge.selectImage ||
        bridge.pickPhoto ||
        bridge.openCamera;
      if (typeof fn === 'function') {
        try {
          fn.call(bridge);
          return;
        } catch {
          // fallback to standard file input below
        }
      }
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const altName = (file.name || '图片').replace(/\.[^.]+$/, '');
      try {
        // Try backend upload endpoint if available, else embed compressed image cleanly
        let uploadedUrl = '';
        try {
          const form = new FormData();
          form.append('file', file);
          const resp = await fetch('/api/files/upload', { method: 'POST', body: form });
          if (resp.ok) {
            const json = await resp.json().catch(() => null);
            const payload = json?.data || json || {};
            if (payload.url) {
              uploadedUrl = payload.url;
            } else if (payload.path) {
              uploadedUrl = `/api/files/raw-stream?path=${encodeURIComponent(payload.path)}`;
            }
          }
        } catch {
          // fallback to local data URL
        }
        const finalSrc = uploadedUrl || (await compressImageFileToDataUrl(file));
        insertImageMarkdownToActiveDoc(finalSrc, altName);
      } catch (err) {
        showToast(getErrorMsg(err, '插入图片失败'), 'error');
      }
    }, { once: true });
    input.click();
  }

  function handleMobileKbdAction(kind) {
    if (!kind) return;
    if (kind === 'undo') {
      performUndo();
      return;
    }
    if (kind === 'save') {
      saveMarkdownDoc();
      return;
    }
    if (kind === 'insert-image') {
      triggerMobileImageInsert();
      return;
    }
    if (kind === 'wikilink') {
      insertRawSnippetAtActiveCursor(state.mdMode === 'source' ? '[[]]' : '[[', state.mdMode === 'source' ? 2 : 0);
      return;
    }
    if (kind === 'tag') {
      insertRawSnippetAtActiveCursor('#', 0);
      return;
    }
    applyWysiwygBarAction(kind);
  }

  function openMobileDocMoreSheet() {
    const doc = state.activeDoc;
    if (!doc) return;
    const isMd = doc.type === 'markdown';
    const curFontSize = Number(store.state.docFontSize || 15);
    const blCount = Number(state.backlinks?.count || 0);
    openSheet({
      title: doc.name,
      bodyHtml: `
        <div class="mobile-action-sheet-list">
          <div class="mobile-sheet-section-row">
            <span class="mobile-sheet-section-label">编辑视图</span>
            <div style="display:inline-flex;gap:6px;flex-wrap:wrap;">
              <button type="button" class="pill-btn pill-btn-sm ${state.mdMode === 'live' ? 'pill-btn-primary' : ''}" data-mdoc-act="mode-live">实时编辑</button>
              <button type="button" class="pill-btn pill-btn-sm ${state.mdMode === 'source' ? 'pill-btn-primary' : ''}" data-mdoc-act="mode-source">纯源码</button>
              ${isMd ? `<button type="button" class="pill-btn pill-btn-sm ${state.mdMode === 'mindmap' ? 'pill-btn-primary' : ''}" data-mdoc-act="mode-mindmap">🧠 脑图</button>` : ''}
            </div>
          </div>
          <div class="mobile-sheet-section-row">
            <span class="mobile-sheet-section-label">字号 (${curFontSize}px)</span>
            <div style="display:inline-flex;gap:8px;align-items:center;">
              <button type="button" class="pill-btn pill-btn-sm" data-mdoc-act="font-dec">A-</button>
              <button type="button" class="pill-btn pill-btn-sm" data-mdoc-act="font-inc">A+</button>
            </div>
          </div>
          <button type="button" class="mobile-sheet-action-btn" data-mdoc-act="find">🔍 文档内查找与替换</button>
          <button type="button" class="mobile-sheet-action-btn" data-mdoc-act="ai-polish">🪄 AI 润色排版</button>
          <button type="button" class="mobile-sheet-action-btn" data-mdoc-act="ai-summarize">✨ AI 提炼摘要与待办</button>
          <button type="button" class="mobile-sheet-action-btn" data-mdoc-act="snapshots">↺ 历史写前快照</button>
          ${blCount > 0 ? `<button type="button" class="mobile-sheet-action-btn" data-mdoc-act="backlinks">🔗 查看反向链接 (${blCount})</button>` : ''}
        </div>
      `,
      footerHtml: `<button type="button" class="pill-btn pill-btn-ghost" data-mdoc-act="close" style="width:100%;justify-content:center;">完成</button>`,
      onMount(card) {
        card.addEventListener('click', (ev) => {
          const btn = ev.target.closest('[data-mdoc-act]');
          if (!btn) return;
          const act = btn.dataset.mdocAct;
          if (act === 'font-dec') {
            updateTypographyAndPersist((store.state.docFontSize || 15) - 1, store.state.docFontFamily);
            const lbl = card.querySelector('.mobile-sheet-section-label:nth-of-type(1)');
            const allLbls = card.querySelectorAll('.mobile-sheet-section-label');
            if (allLbls[1]) allLbls[1].textContent = `字号 (${store.state.docFontSize || 15}px)`;
            return;
          }
          if (act === 'font-inc') {
            updateTypographyAndPersist((store.state.docFontSize || 15) + 1, store.state.docFontFamily);
            const allLbls = card.querySelectorAll('.mobile-sheet-section-label');
            if (allLbls[1]) allLbls[1].textContent = `字号 (${store.state.docFontSize || 15}px)`;
            return;
          }
          closeSheet();
          if (act === 'mode-live' || act === 'mode-source' || act === 'mode-mindmap') {
            const nextMode = act.replace('mode-', '');
            commitActiveBlock({ reRender: false });
            state.mdMode = nextMode;
            renderMarkdownMode();
          } else if (act === 'find') {
            openFindBar();
          } else if (act === 'ai-polish') {
            triggerAiPolish();
          } else if (act === 'ai-summarize') {
            store.setState({ mobileTab: 'ai', rightMode: 'summary', rightCollapsed: false }, 'rightMode:changed');
            store.emit('layout:changed');
            store.emit('ai:summarize-request', {
              file_path: doc.path,
              text: store.state.activeDocumentText || doc.content || '',
              autoRun: true,
            });
          } else if (act === 'snapshots') {
            openSnapshotsSheet();
          } else if (act === 'backlinks') {
            openBacklinksSheet();
          }
        });
      },
    });
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

    syncMobileTopbarTitle(doc.name.replace(/\.md$/i, ''));
    syncMobileMdBarBodyClass(isLive || isSource);

    const mainPane = ensureMainPaneEl();
    const prevScrollEl = mainPane.querySelector('.md-scroll-area') || mainPane.querySelector('.md-editor:not([data-role])');
    const prevScrollTop = prevScrollEl ? prevScrollEl.scrollTop : 0;

    const canUndo = state.history.undoStack.length > 0 || state.history.typingBaseline !== null;
    const canRedo = state.history.redoStack.length > 0;
    const shortTitle = doc.name.replace(/\.md$/i, '');

    mainPane.innerHTML = `
      <div class="mobile-md-toolbar" role="toolbar" aria-label="手机端文档工具栏">
        <button type="button" class="mobile-tb-back-btn" data-action="open-explorer-home" aria-label="返回主面板">
          ← 主面板
        </button>
        <div class="mobile-tb-title-wrap">
          <span class="mobile-tb-title" title="${escapeHtml(doc.path)}">${escapeHtml(shortTitle)}</span>
          <span
            data-role="md-dirty-dot"
            title="有未保存修改"
            style="width:7px; height:7px; border-radius:9999px; background:var(--warning); display:${state.dirty ? 'inline-block' : 'none'}; flex-shrink:0;"
          ></span>
        </div>
        <div class="mobile-tb-actions">
          ${
            isMd
              ? `<button type="button" class="mobile-tb-chip ${isMindmap ? 'is-active' : ''}" data-md-mode="${isMindmap ? 'live' : 'mindmap'}" title="${isMindmap ? '返回正文' : '脑图视图'}">🧠</button>`
              : ''
          }
          <button type="button" class="mobile-tb-chip ${state.dirty ? 'is-primary' : ''}" data-action="md-save" title="保存文档">💾</button>
          <button type="button" class="mobile-tb-chip" data-action="mobile-doc-more" aria-label="更多操作" title="更多操作">⋯</button>
        </div>
      </div>

      <div class="center-toolbar desktop-center-toolbar">
        <div class="center-toolbar-group">
          ${renderNavButtonsHtml()}
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
              实时编辑
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

      ${isLive || isSource ? renderWysiwygFormatBarHtml() : ''}

      ${renderFindBarHtml()}

      ${
        isMindmap
          ? `<div data-role="mindmap-stage" style="flex:1 1 auto; min-height:0; min-width:0; position:relative; overflow:hidden; display:flex; flex-direction:column;"></div>`
          : isLive
          ? renderLiveBlocksHtml(doc)
          : `<div style="flex:1 1 auto; min-height:0; min-width:0; display:flex; flex-direction:column; overflow:hidden;"><textarea class="md-editor" spellcheck="false" placeholder="随时记录想法、笔记或输入 [[文件名.pdf#page=1]] / [[表格.xlsx#Sheet1!C4]] / [[app:应用名]]...">${escapeHtml(doc.content || '')}</textarea></div>`
      }

      ${isLive || isSource ? renderMobileMdKbdBarHtml(canUndo) : ''}
    `;
    ensureDropOverlay();

    const fmtBar = mainPane.querySelector('[data-role="wysiwyg-format-bar"]');
    if (fmtBar) {
      fmtBar.addEventListener('mousedown', (ev) => {
        if (ev.target.closest('[data-fmt-bar]')) {
          ev.preventDefault();
        }
      });
    }

    const mobileKbdBar = mainPane.querySelector('[data-role="mobile-md-kbd-bar"]');
    if (mobileKbdBar) {
      mobileKbdBar.addEventListener('mousedown', (ev) => {
        if (ev.target.closest('[data-mobile-kbd]')) {
          ev.preventDefault();
        }
      });
    }

    if (isMindmap) {
      mountMindMapStage();
    } else if (isLive) {
      const nextScrollEl = mainPane.querySelector('.md-scroll-area');
      if (nextScrollEl && prevScrollTop > 0) {
        nextScrollEl.scrollTop = prevScrollTop;
      }
      if (state.justDroppedTarget) {
        const dropInfo = state.justDroppedTarget;
        state.justDroppedTarget = null;
        const lpBlocks = Array.from(mainPane.querySelectorAll('.lp-container .lp-block'));
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
      const ta = mainPane.querySelector('.md-editor:not([data-role])');
      if (ta && prevScrollTop > 0) {
        ta.scrollTop = prevScrollTop;
      }
    }
  }

  function updateMdDirtyIndicators() {
    containerEl.querySelectorAll('[data-role="md-dirty-dot"]').forEach((dot) => {
      dot.style.display = state.dirty ? 'inline-block' : 'none';
    });
    containerEl.querySelectorAll('[data-action="md-save"]').forEach((saveBtn) => {
      saveBtn.classList.toggle('pill-btn-primary', Boolean(state.dirty));
      saveBtn.classList.toggle('is-primary', Boolean(state.dirty));
    });
    const kbdSave = containerEl.querySelector('[data-mobile-kbd="save"]');
    if (kbdSave) {
      kbdSave.classList.toggle('is-primary', Boolean(state.dirty));
    }
    const kbdUndo = containerEl.querySelector('[data-mobile-kbd="undo"]');
    if (kbdUndo) {
      const canUndo = state.history.undoStack.length > 0 || state.history.typingBaseline !== null;
      kbdUndo.disabled = !canUndo;
    }
    updateMdUndoRedoButtons();
  }

  // =========================================================================
  // Pain Point #10 & V6 Req #6: Non-Blocking Background AI Polish Sheet
  // =========================================================================
  function showPolishResultSheet(targetDoc, origLength, polished) {
    openSheet({
      title: `AI 文章润色 · ${targetDoc.name}`,
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span style="font-size:12px;color:var(--text-secondary);">原文 ${origLength} 字 → 润色后 ${polished.length} 字</span>
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
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="polish-cancel">取消</button>
        <button type="button" class="pill-btn" id="polish-copy">${icon('copy', 13)} 复制</button>
        <button type="button" class="pill-btn pill-btn-primary" id="polish-apply">${icon('check', 13)} 应用替换</button>
      `,
      onMount(card) {
        const bodyEl = card.querySelector('.sheet-body');
        const thumb = bodyEl?.querySelector('[data-role="polish-thumb"]');
        const prevBox = bodyEl?.querySelector('[data-role="polish-preview"]');
        const rawBox = bodyEl?.querySelector('[data-role="polish-raw"]');
        bodyEl?.querySelectorAll('[data-polish-view]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const isRaw = btn.dataset.polishView === 'raw';
            bodyEl.querySelectorAll('[data-polish-view]').forEach((b) => b.classList.toggle('is-active', b === btn));
            if (thumb) thumb.style.transform = `translateX(${isRaw ? '100%' : '0%'})`;
            if (prevBox) prevBox.style.display = isRaw ? 'none' : 'block';
            if (rawBox) rawBox.style.display = isRaw ? 'block' : 'none';
          });
        });

        card.querySelector('#polish-cancel')?.addEventListener('click', closeSheet);
        card.querySelector('#polish-copy')?.addEventListener('click', () => {
          const latest = rawBox?.value || polished;
          copyInternal(latest, '已复制润色文本');
        });
        card.querySelector('#polish-apply')?.addEventListener('click', async () => {
          const latest = rawBox?.value ?? polished;
          if (state.activeDoc && isSamePath(state.activeDoc.path, targetDoc.path)) {
            pushUndoSnapshot(state.activeDoc.content, { immediate: true });
            state.activeDoc.content = latest;
            state.dirty = true;
            state.editingBlockIdx = null;
            state.editingBlockRange = null;
            state.editingDraftInsert = null;
            store.state.activeDocumentText = latest;
            closeSheet();
            renderMarkdownMode();
            showToast('已应用 AI 润色结果（Ctrl+S 保存）', 'success');
          } else {
            try {
              await api.put('/api/files/write', { path: targetDoc.path, content: latest });
              closeSheet();
              await openFile(targetDoc.path, { skipUnsavedGuard: true, forceReload: true });
              showToast(`已将润色结果写入 ${targetDoc.name}`, 'success');
            } catch (err) {
              showToast(getErrorMsg(err, '应用润色失败'), 'error');
            }
          }
        });
      },
    });
  }

  async function openAiPolishSheet() {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
    commitActiveBlock({ reRender: false });
    const rawText = String(doc.content || '').trim();
    if (!rawText) {
      showToast('当前文档内容为空，无需润色', 'warning');
      return;
    }

    const snapDoc = { path: doc.path, name: doc.name, content: doc.content || '' };
    const taskId = `polish_${Date.now()}`;
    setBgAiTask({ id: taskId, label: `AI 正在润色 ${snapDoc.name}…`, status: 'running' });
    showToast('AI 已在后台运行，可继续浏览编辑', 'info', { duration: 2200 });

    try {
      const res = await api.post('/api/ai/polish', {
        text: snapDoc.content,
        style: 'article',
      });
      const polished = String(res?.polished || res?.result || res?.text || res?.content || '').trim();
      if (!polished) {
        setBgAiTask({ id: taskId, label: 'AI 未返回润色内容', status: 'error' });
        showToast('AI 未返回润色内容', 'warning');
        return;
      }
      setBgAiTask({
        id: taskId,
        label: `AI 润色已完成 · ${snapDoc.name}`,
        status: 'done',
        onOpen: () => showPolishResultSheet(snapDoc, rawText.length, polished),
      });
      showToast(`AI 润色已完成 · ${snapDoc.name}`, 'success', {
        duration: 4200,
        actionLabel: '查看结果',
        onAction: () => showPolishResultSheet(snapDoc, rawText.length, polished),
      });
    } catch (err) {
      setBgAiTask({ id: taskId, label: 'AI 润色失败', status: 'error' });
      showToast(getErrorMsg(err, 'AI 润色失败'), 'error');
    }
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
    syncMobileMdBarBodyClass(false);
    const doc = state.activeDoc;
    syncMobileTopbarTitle(doc?.name);
    const ex = state.excel;
    const pendingCount = ex.pendingChanges.size;

    ensureMainPaneEl().innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          ${renderNavButtonsHtml()}
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
          <button type="button" class="pill-btn pill-btn-primary" data-sheet-act="save">💾 保存并切换</button>
          <button type="button" class="pill-btn pill-btn-danger" data-sheet-act="discard">丢弃并切换</button>
          <button type="button" class="pill-btn" data-sheet-act="cancel">取消</button>
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
  // Rendering: PDF Native Vector Viewer + Companion Note + AI MindMap
  // =========================================================================
  function buildPdfStreamSrc() {
    const p = encodeURIComponent(state.activeDoc.path);
    return `/api/files/pdf-stream?path=${p}&_t=${state.pdf.cacheBust}#page=${state.pdf.currentPage}`;
  }

  function renderPdfViewerStage() {
    const doc = state.activeDoc;
    const wrap = containerEl.querySelector('[data-role="pdf-frame-wrap"]');
    if (!wrap || !doc) return;
    wrap.innerHTML = `<iframe class="pdf-frame" src="${buildPdfStreamSrc()}" title="${escapeHtml(doc.name)}"></iframe>`;
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
    const iframe = containerEl.querySelector('.pdf-frame');
    if (iframe) {
      state.pdf.cacheBust = Date.now();
      iframe.src = buildPdfStreamSrc();
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
    syncMobileMdBarBodyClass(false);
    const doc = state.activeDoc;
    syncMobileTopbarTitle(doc?.name);
    const pdf = state.pdf;
    const compModeCls = state.companionLayout === 'split' ? 'is-comp-split' : 'is-comp-float';

    ensureMainPaneEl().innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          ${renderNavButtonsHtml()}
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
        </div>

        <div class="center-toolbar-group">
          <button type="button" class="pill-btn pill-btn-sm" data-action="pdf-copy-anchor" title="复制当前页码锚点">
            ${icon('pin', 13)} 复制页码锚点
          </button>
          <button type="button" class="pill-btn pill-btn-sm ${pdf.annotOpen ? 'pill-btn-primary' : ''}" data-action="pdf-annotate" title="打开/收起非遮挡行内批注栏">
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
          ${
            hasCompanionNote(doc)
              ? `<button type="button" class="pill-btn pill-btn-sm ${state.companionOpen ? 'pill-btn-primary' : ''}" data-action="toggle-companion" title="打开/收起伴生笔记浮窗或分屏">
                  ${icon('file-text', 13)} 伴生笔记
                </button>`
              : ''
          }
        </div>
      </div>

      <div
        data-role="pdf-annot-bar"
        style="display:${pdf.annotOpen ? 'flex' : 'none'}; align-items:center; flex-wrap:wrap; gap:8px; padding:8px 14px; border-bottom:1px solid var(--border-hairline); background:var(--bg-glass); flex-shrink:0;"
      >
        <div style="display:inline-flex; align-items:center; gap:5px; flex-shrink:0;">
          <span style="font-size:12px; font-weight:600; color:var(--text-secondary);">页码</span>
          <input
            type="number"
            class="apple-input"
            data-role="pdf-annot-page"
            min="1"
            max="${pdf.totalPages}"
            value="${pdf.currentPage}"
            aria-label="批注目标页码"
            style="width:62px; height:28px; padding:2px 6px; font-size:12px; text-align:center;"
          />
        </div>
        <div style="display:inline-flex; align-items:center; gap:4px; flex-shrink:0;" role="group" aria-label="批注标签颜色">
          ${[
            { id: 'yellow', label: '🟡 重点' },
            { id: 'red', label: '🔴 疑问' },
            { id: 'green', label: '🟢 结论' },
            { id: 'blue', label: '🔵 摘录' },
          ]
            .map(
              (c) => `
            <button
              type="button"
              class="pill-btn pill-btn-sm ${(pdf.annotColor || 'yellow') === c.id ? 'pill-btn-primary' : ''}"
              data-pdf-annot-color="${c.id}"
              style="height:26px; padding:0 8px; font-size:11.5px;"
            >${c.label}</button>
          `
            )
            .join('')}
        </div>
        <input
          type="text"
          class="apple-input"
          data-role="pdf-annot-input"
          placeholder="边看 PDF 边输入批注（回车立即写入并同步至伴生笔记，Esc 关闭）…"
          style="flex:1 1 220px; min-width:180px; height:28px; padding:2px 10px; font-size:12.5px;"
        />
        <div style="display:inline-flex; align-items:center; gap:5px; flex-shrink:0;">
          <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="pdf-annot-submit">写入批注</button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="pdf-annot-close" title="收起批注栏" style="width:26px; padding:0;">✕</button>
        </div>
      </div>

      <div style="flex:1 1 auto; min-height:0; min-width:0; overflow:hidden; position:relative;">
        <div class="pdf-workspace ${compModeCls}">
          <div class="pdf-frame-wrap" data-role="pdf-frame-wrap"></div>
          ${renderCompanionPaneHtml(doc, {
            placeholderText: `边看 PDF 边记笔记，支持 [[${doc.name}#page=${pdf.currentPage}]] 锚点…`,
            extraActionHtml: `<button type="button" class="pill-btn pill-btn-sm" data-action="pdf-insert-anchor">${icon('pin', 12)} 插入当前页锚点</button>`,
          })}
        </div>
        ${renderMobileCompanionTriggerHtml(doc)}
      </div>
    `;
    renderPdfViewerStage();
    ensureDropOverlay();
  }

  function showPdfMindMapResultSheet(targetDoc, outline) {
    openSheet({
      title: `AI 提炼脑图 · ${targetDoc.name}`,
      bodyHtml: `<div data-role="pdf-mm-stage" style="height:52vh;min-height:280px;border:1px solid var(--border-hairline);border-radius:var(--radius-control);overflow:hidden;"></div>`,
      footerHtml: `
        <button type="button" class="pill-btn" id="pdf-mm-cancel">关闭</button>
        <button type="button" class="pill-btn" id="pdf-mm-copy">${icon('copy', 13)} 复制大纲</button>
        <button type="button" class="pill-btn pill-btn-primary" id="pdf-mm-insert">${icon('plus', 13)} 写入伴生笔记</button>
      `,
      onMount(card) {
        const stage = card.querySelector('[data-role="pdf-mm-stage"]');
        if (stage) {
          renderMindMap(stage, {
            markdown: outline,
            docName: targetDoc.name,
            onAnchorClick(a) {
              if (a instanceof HTMLElement) handleAnchorClick(a);
              else if (a && typeof a === 'object') store.emit('anchor:jump', a);
            },
            onFocusNode(title, seconds = 1500) {
              store.emit('focus:start', { title: title || targetDoc.name, seconds });
            },
          });
        }
        card.querySelector('#pdf-mm-cancel')?.addEventListener('click', closeSheet);
        card.querySelector('#pdf-mm-copy')?.addEventListener('click', () => copyInternal(outline, '已复制脑图大纲'));
        card.querySelector('#pdf-mm-insert')?.addEventListener('click', () => {
          closeSheet();
          if (state.activeDoc && isSamePath(state.activeDoc.path, targetDoc.path)) {
            insertTextIntoCompanionNote(`\n${outline}\n`, { toastMsg: '已将 AI 脑图大纲写入伴生笔记' });
          } else {
            copyInternal(outline, '已切换文档，已复制脑图大纲到剪贴板');
          }
        });
      },
    });
  }

  async function openPdfMindMapSheet() {
    const doc = state.activeDoc;
    if (!doc || doc.type !== 'pdf') return;
    const snapDoc = { path: doc.path, name: doc.name, companionContent: doc.companionContent || '' };
    const taskId = `pdf_mm_${Date.now()}`;
    setBgAiTask({ id: taskId, label: `AI 正在提炼 ${snapDoc.name} 脑图…`, status: 'running' });
    showToast('AI 已在后台运行，可继续浏览编辑', 'info', { duration: 2200 });

    try {
      const res = await api.post('/api/ai/mindmap', {
        text: snapDoc.companionContent,
        file_path: snapDoc.path,
      });
      const outline = String(res?.markdown || res?.outline || res?.content || '').trim();
      if (!outline) {
        setBgAiTask({ id: taskId, label: '未能提炼出 PDF 脑图大纲', status: 'error' });
        showToast('未能提炼出脑图大纲', 'warning');
        return;
      }
      setBgAiTask({
        id: taskId,
        label: `AI 脑图已完成 · ${snapDoc.name}`,
        status: 'done',
        onOpen: () => showPdfMindMapResultSheet(snapDoc, outline),
      });
      showToast(`AI 脑图已生成 · ${snapDoc.name}`, 'success', {
        duration: 4200,
        actionLabel: '查看脑图',
        onAction: () => showPdfMindMapResultSheet(snapDoc, outline),
      });
    } catch (err) {
      setBgAiTask({ id: taskId, label: 'AI 脑图提炼失败', status: 'error' });
      showToast(getErrorMsg(err, 'AI 脑图提炼失败'), 'error');
    }
  }

  function openPdfAnnotateSheet(forceOpen = null) {
    if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
    const bar = containerEl.querySelector('[data-role="pdf-annot-bar"]');
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : !state.pdf.annotOpen;
    state.pdf.annotOpen = nextOpen;
    const toggleBtn = containerEl.querySelector('[data-action="pdf-annotate"]');
    if (toggleBtn) toggleBtn.classList.toggle('pill-btn-primary', nextOpen);
    if (!bar) {
      renderPdfMode();
      if (nextOpen) {
        containerEl.querySelector('[data-role="pdf-annot-input"]')?.focus();
      }
      return;
    }
    bar.style.display = nextOpen ? 'flex' : 'none';
    if (nextOpen) {
      const pageInp = bar.querySelector('[data-role="pdf-annot-page"]');
      if (pageInp) pageInp.value = String(state.pdf.currentPage);
      const textInp = bar.querySelector('[data-role="pdf-annot-input"]');
      if (textInp) {
        textInp.focus();
        textInp.select?.();
      }
    }
  }

  async function submitPdfInlineAnnotation() {
    const doc = state.activeDoc;
    if (!doc || doc.type !== 'pdf') return;
    const bar = containerEl.querySelector('[data-role="pdf-annot-bar"]');
    const pageInp = bar?.querySelector('[data-role="pdf-annot-page"]');
    const textInp = bar?.querySelector('[data-role="pdf-annot-input"]');
    const submitBtn = bar?.querySelector('[data-action="pdf-annot-submit"]');
    const pageVal = Number.parseInt(pageInp?.value, 10) || state.pdf.currentPage;
    const clampedPage = Math.min(Math.max(1, pageVal), state.pdf.totalPages || 1);
    const noteText = String(textInp?.value || '').trim();
    if (!noteText) {
      showToast('请输入批注内容', 'warning');
      textInp?.focus();
      return;
    }
    if (submitBtn) submitBtn.disabled = true;
    try {
      // Preserve any unsaved user edits in companion note before backend appends annotation
      if (state.pdf.companionDirty && hasCompanionNote(doc)) {
        await saveCompanionNote({ silent: true });
      }
      const color = state.pdf.annotColor || 'yellow';
      const res = await api.post('/api/files/pdf-annotate', {
        path: doc.path,
        page: clampedPage,
        note_text: noteText,
        color,
      });
      state.pdf.currentPage = Number(res?.page || clampedPage);
      state.pdf.cacheBust = Date.now();
      if (typeof res?.companion_content === 'string') {
        doc.companionContent = res.companion_content;
        doc.companionExists = true;
        state.pdf.companionDirty = false;
        store.state.activeDocumentText = doc.companionContent;
      }
      state.companionOpen = true;
      if (textInp) textInp.value = '';
      renderPdfMode();
      // Keep inline bar open for quick consecutive annotations and refocus input
      const nextInp = containerEl.querySelector('[data-role="pdf-annot-input"]');
      if (nextInp && state.pdf.annotOpen) nextInp.focus();
      store.emit('file:saved', { path: doc.path, page: state.pdf.currentPage, snapshot_id: res?.snapshot_id || null });
      showToast(`已写入第 ${state.pdf.currentPage} 页批注（${res?.tag || color}）并同步至伴生笔记`, 'success');
    } catch (err) {
      if (submitBtn) submitBtn.disabled = false;
      showToast(getErrorMsg(err, '写入 PDF 批注失败'), 'error');
    }
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
    syncMobileMdBarBodyClass(false);
    const doc = state.activeDoc;
    syncMobileTopbarTitle(doc?.name);
    const ar = state.archive;
    const treeW = Math.min(460, Math.max(150, Number(state.archiveTreeWidth) || 230));

    ensureMainPaneEl().innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          ${renderNavButtonsHtml()}
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

      <div class="archive-workspace" style="flex:1 1 auto; min-height:0; min-width:0; display:flex; flex-direction:row; overflow:hidden; position:relative;">
        <div class="archive-tree" style="width:${treeW}px; flex:0 0 ${treeW}px; border-right:1px solid var(--border-hairline); overflow-y:auto; padding:8px;">
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
        <div class="center-split-resizer archive-split-resizer" data-role="archive-split-resizer" title="拖动调整目录树宽度，双击恢复默认"></div>
        <div data-role="archive-preview-pane" style="flex:1 1 auto; display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;"></div>
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
        ${renderMobileCompanionTriggerHtml(doc)}
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
    syncMobileMdBarBodyClass(false);
    const doc = state.activeDoc;
    syncMobileTopbarTitle(doc?.name);
    const imgState = state.image;
    const src = `/api/files/raw-stream?path=${encodeURIComponent(doc.path)}&_t=${imgState.cacheBust}`;
    const zoomPct = imgState.fit ? '适应' : `${Math.round(imgState.zoom * 100)}%`;

    ensureMainPaneEl().innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          ${renderNavButtonsHtml()}
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

      <div style="flex:1 1 auto; min-height:0; min-width:0; overflow:hidden; position:relative;">
        <div class="pdf-workspace ${state.companionLayout === 'split' ? 'is-comp-split' : 'is-comp-float'}">
          <div style="flex:1 1 auto;min-width:0;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--bg-subtle);">
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
        ${renderMobileCompanionTriggerHtml(doc)}
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
    syncMobileMdBarBodyClass(false);
    const doc = state.activeDoc;
    syncMobileTopbarTitle(doc?.name);
    const isVideo = doc.type === 'video';
    const src = `/api/files/raw-stream?path=${encodeURIComponent(doc.path)}`;

    ensureMainPaneEl().innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          ${renderNavButtonsHtml()}
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
          ${
            hasCompanionNote(doc)
              ? `<button type="button" class="pill-btn pill-btn-sm ${state.companionOpen ? 'pill-btn-primary' : ''}" data-action="toggle-companion">
                  ${icon('file-text', 13)} 伴生笔记
                </button>`
              : ''
          }
        </div>
      </div>

      <div style="flex:1 1 auto; min-height:0; min-width:0; overflow:hidden; position:relative;">
        <div class="pdf-workspace ${state.companionLayout === 'split' ? 'is-comp-split' : 'is-comp-float'}">
          <div style="flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:14px;background:var(--bg-subtle);min-width:0;min-height:0;overflow:auto;">
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
        ${renderMobileCompanionTriggerHtml(doc)}
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
    syncMobileMdBarBodyClass(false);
    const doc = state.activeDoc;
    syncMobileTopbarTitle(doc?.name);
    const previewMd = doc.previewMarkdown || doc.content || '*暂无可预览文本内容，可点击上方按钮用 WPS / Office 打开*';

    ensureMainPaneEl().innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          ${renderNavButtonsHtml()}
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

      <div style="flex:1 1 auto; min-height:0; min-width:0; overflow:hidden; position:relative;">
        <div class="pdf-workspace ${state.companionLayout === 'split' ? 'is-comp-split' : 'is-comp-float'}">
          <div class="md-scroll-area" style="flex:1 1 auto;">
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
        ${renderMobileCompanionTriggerHtml(doc)}
      </div>
    `;
    ensureDropOverlay();
  }

  function renderGenericMode() {
    hideFormatBar();
    removeDropInsertLine();
    syncMobileMdBarBodyClass(false);
    const doc = state.activeDoc;
    syncMobileTopbarTitle(doc?.name);

    ensureMainPaneEl().innerHTML = `
      <div class="center-toolbar">
        <div class="center-toolbar-group">
          ${renderNavButtonsHtml()}
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

      <div style="flex:1 1 auto; min-height:0; min-width:0; overflow:hidden; position:relative;">
        <div class="pdf-workspace ${state.companionLayout === 'split' ? 'is-comp-split' : 'is-comp-float'}">
          <div style="flex:1;display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto;">
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
        ${renderMobileCompanionTriggerHtml(doc)}
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

  function recordOpenedNavAndEmit(doc, opts = {}) {
    if (!doc) return;
    if (!opts._fromNavHistory && !opts.forceReload && typeof pushNavHistory === 'function') {
      pushNavHistory({
        path: doc.path,
        name: doc.name,
        ext: doc.ext,
        heading: opts.heading || '',
        pdfPage: doc.type === 'pdf' ? state.pdf.currentPage : undefined,
        excelSheet: doc.type === 'excel' ? state.excel.currentSheet : undefined,
      });
      syncNavButtonsUi();
    }
    store.emit('file:opened', {
      path: doc.path,
      name: doc.name,
      ext: doc.ext,
      type: doc.type,
    });
    Promise.resolve(store.refreshLinkGraph?.(doc.path)).catch(() => {});
    persistLastSessionNow();
  }

  async function navigateHistory(dir) {
    captureCurrentNavSnapshot();
    const entry = dir < 0
      ? (typeof stepNavBack === 'function' ? stepNavBack() : null)
      : (typeof stepNavForward === 'function' ? stepNavForward() : null);
    if (!entry || !entry.path) return null;
    const opened = await openFile(entry.path, {
      _fromNavHistory: true,
      heading: entry.heading || undefined,
      initialPage: entry.pdfPage || undefined,
      sheet: entry.excelSheet || undefined,
    });
    if (opened && Number.isFinite(entry.scrollTop) && entry.scrollTop > 0) {
      window.requestAnimationFrame(() => {
        const scrollEl = getActiveMainScrollEl();
        if (scrollEl) scrollEl.scrollTop = entry.scrollTop;
      });
    }
    syncNavButtonsUi();
    return opened;
  }

  async function openFile(pathStr, opts = {}) {
    const targetPath = String(pathStr || '').trim();
    if (!targetPath) return null;

    if (!opts._fromNavHistory) {
      captureCurrentNavSnapshot();
    }

    // If re-invoking currently open file without forceReload, handle lightweight sub-navigation
    if (
      state.activeDoc &&
      isSamePath(state.activeDoc.path, targetPath) &&
      !opts.forceReload &&
      !opts.skipUnsavedGuard
    ) {
      if (store.state.activeCenterView === 'explorer' && typeof setCenterView === 'function') {
        setCenterView('doc');
      }
      const t = state.activeDoc.type;
      if (t === 'markdown' || t === 'text') {
        const hasEditingBlock =
          state.editingBlockRange !== null ||
          state.editingBlockIdx !== null ||
          state.editingDraftNewBlock ||
          state.editingDraftInsert !== null;
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
      if (!opts._fromNavHistory && (opts.heading || opts.initialPage || opts.sheet)) {
        if (typeof pushNavHistory === 'function') {
          pushNavHistory({
            path: state.activeDoc.path,
            name: state.activeDoc.name,
            ext: state.activeDoc.ext,
            heading: opts.heading || '',
            pdfPage: t === 'pdf' ? state.pdf.currentPage : undefined,
            excelSheet: t === 'excel' ? state.excel.currentSheet : undefined,
          });
          syncNavButtonsUi();
        }
      }
      Promise.resolve(store.refreshLinkGraph?.(state.activeDoc.path)).catch(() => {});
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
    if (store.state.activeCenterView !== 'doc' && typeof setCenterView === 'function') {
      setCenterView('doc');
    }

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
      state.editingDraftInsert = null;
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
        recordOpenedNavAndEmit(state.activeDoc, opts);
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
          annotOpen: false,
          annotColor: state.pdf?.annotColor || 'yellow',
        };
        syncActiveFileStore();
        renderPdfMode();
        ensureDocTabOnMobile();
        recordOpenedNavAndEmit(state.activeDoc, opts);
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
        recordOpenedNavAndEmit(state.activeDoc, opts);
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
        recordOpenedNavAndEmit(state.activeDoc, opts);
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
        recordOpenedNavAndEmit(state.activeDoc, opts);
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
        recordOpenedNavAndEmit(state.activeDoc, opts);
        return state.activeDoc;
      }

      syncActiveFileStore();
      renderActiveView();
      if (type === 'office_preview' && opts.heading) {
        window.requestAnimationFrame(() => scrollToMarkdownHeading(opts.heading));
      }
      ensureDocTabOnMobile();
      recordOpenedNavAndEmit(state.activeDoc, opts);
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
      Promise.resolve(store.refreshLinkGraph?.(doc.path)).catch(() => {});
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
      Promise.resolve(store.refreshLinkGraph?.(doc.path)).catch(() => {});
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
    const defaultTitle = nextSequentialName(
      '新建笔记',
      getWorkspaceFilesList().map((f) => f.name)
    );
    const defaultFolderRel =
      store.state.activeCenterView === 'explorer' && state.explorer.scope === 'notes'
        ? state.explorer.relDir || ''
        : '';

    openSheet({
      title: '新建本地 Markdown 笔记',
      bodyHtml: `
        <form id="center-new-note-form" style="display:flex; flex-direction:column; gap:10px;">
          <div>
            <label style="display:block; font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:4px;">笔记标题（留空回车将自动命名为「${escapeHtml(defaultTitle)}」）</label>
            <input type="text" class="apple-input" id="center-new-note-title" placeholder="${escapeHtml(defaultTitle)}" autocomplete="off" />
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
          const title = card.querySelector('#center-new-note-title')?.value?.trim() || defaultTitle;
          const content = card.querySelector('#center-new-note-body')?.value || '';
          if (submitBtn) submitBtn.disabled = true;
          try {
            const created = await api.post('/api/files/create-note', {
              title,
              content,
              folder_rel: defaultFolderRel,
            });
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
  function refreshExplorerUiIfVisible() {
    if (state.loading) return;
    const isExplorerMode = store.state.activeCenterView === 'explorer' || !state.activeDoc;
    if (!isExplorerMode) return;
    const mainPane = ensureMainPaneEl();
    const homeEl = mainPane.querySelector('.explorer-home');
    if (!homeEl) {
      renderExplorerHome({ refresh: false });
      return;
    }
    const activeEl = document.activeElement;
    if (activeEl && homeEl.contains(activeEl) && activeEl.matches('input')) {
      const filesPane = homeEl.querySelector('[data-explorer-role="files-pane"]');
      const todoPane = homeEl.querySelector('[data-explorer-role="todo-pane"]');
      if (activeEl.matches('[data-explorer-todo-add]')) {
        if (filesPane) filesPane.innerHTML = renderExplorerFilesPaneInnerHtml(buildExplorerFilesSectionData());
      } else {
        if (filesPane && !activeEl.matches('[data-explorer-inline-input]')) {
          filesPane.innerHTML = renderExplorerFilesPaneInnerHtml(buildExplorerFilesSectionData());
        }
        if (todoPane) {
          const prevScroll = todoPane.querySelector('[data-explorer-role="todo-list"]')?.scrollTop || 0;
          todoPane.innerHTML = renderExplorerTodoPaneHtml();
          const newList = todoPane.querySelector('[data-explorer-role="todo-list"]');
          if (newList) newList.scrollTop = prevScroll;
        }
      }
      return;
    }
    renderExplorerHome({ refresh: false });
  }

  store.on('center-view:change', (view) => {
    const next = (view === 'explorer' || store.state.activeCenterView === 'explorer') ? 'explorer' : 'doc';
    if (next === 'explorer') {
      commitActiveBlock({ reRender: false });
      renderExplorerHome({ refresh: true });
      return;
    }
    if (state.loading) return;
    if (state.activeDoc) {
      renderActiveView();
    } else {
      renderExplorerHome({ refresh: false });
    }
  });

  store.on('mobile:focus-todos', () => {
    commitActiveBlock({ reRender: false });
    state.explorer.mobileSection = 'todos';
    if (store.state.activeCenterView !== 'explorer') {
      if (typeof setCenterView === 'function') {
        setCenterView('explorer');
      } else {
        store.setState({ activeCenterView: 'explorer' }, 'center-view:change');
      }
    } else {
      renderExplorerHome({ refresh: true });
    }
  });

  store.on('mobile:focus-files', () => {
    commitActiveBlock({ reRender: false });
    state.explorer.mobileSection = 'files';
    if (store.state.activeCenterView !== 'explorer') {
      if (typeof setCenterView === 'function') {
        setCenterView('explorer');
      } else {
        store.setState({ activeCenterView: 'explorer' }, 'center-view:change');
      }
    } else {
      renderExplorerHome({ refresh: false });
    }
  });

  store.on('layout:changed', () => {
    if (!isMobileViewport()) return;
    const tab = store.state.mobileTab || 'doc';
    if (tab === 'files') {
      syncMobileTopbarTitle('笔记目录');
    } else if (tab === 'ai') {
      syncMobileTopbarTitle('AI 与工具');
    } else if (tab === 'todos') {
      syncMobileTopbarTitle('全局待办');
    } else if (store.state.activeCenterView === 'explorer') {
      syncMobileTopbarTitle(state.explorer.mobileSection === 'todos' ? '全局待办' : '全部笔记');
    } else if (state.activeDoc?.name) {
      syncMobileTopbarTitle(state.activeDoc.name.replace(/\.md$/i, ''));
    }
  });

  store.on('android:image-picked', (payload = {}) => {
    const src = payload.url || payload.dataUrl || payload.data_url || (payload.path ? `/api/files/raw-stream?path=${encodeURIComponent(payload.path)}` : '');
    if (src) {
      insertImageMarkdownToActiveDoc(src, payload.name || '相册图片');
    }
  });

  if (typeof window !== 'undefined') {
    window.__slnOnAndroidImagePicked = (srcOrPayload, altName = '相册图片') => {
      if (typeof srcOrPayload === 'string' && srcOrPayload.trim()) {
        insertImageMarkdownToActiveDoc(srcOrPayload.trim(), altName);
      } else if (srcOrPayload && typeof srcOrPayload === 'object') {
        store.emit('android:image-picked', srcOrPayload);
      }
    };
  }

  store.on('todos:updated', () => {
    refreshExplorerUiIfVisible();
  });

  store.on('todos:toggled', ({ file_path, content } = {}) => {
    if (typeof content !== 'string' || !file_path) return;
    if (state.activeDoc && isSamePath(state.activeDoc.path, file_path) && !state.dirty) {
      state.activeDoc.content = content;
      store.state.activeDocumentText = content;
      if (
        store.state.activeCenterView !== 'explorer' &&
        (state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text')
      ) {
        renderMarkdownMode();
      }
    }
  });

  store.on('ai:polish-request', async (payload = {}) => {
    const targetPath = String(payload?.filePath || payload?.file_path || '').trim();
    if (targetPath && (!state.activeDoc || !isSamePath(state.activeDoc.path, targetPath))) {
      await openFile(targetPath, { mode: 'live' });
    }
    triggerAiPolish();
  });

  store.on('trash:restore-virtual', async (res = {}) => {
    const kind = String(res?.kind || res?.item?.kind || '');
    if (kind !== 'lp-block') return;
    const item = res?.item || res;
    const payload = item?.payload || {};
    const md = String(payload.markdown ?? payload.text ?? item?.title ?? '').trim();
    if (!md) return;
    const targetPath = String(payload.docPath || payload.sourceDocPath || item?.source_path || '').trim();

    if (
      state.activeDoc &&
      (state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text') &&
      (!targetPath || isSamePath(state.activeDoc.path, targetPath))
    ) {
      commitActiveBlock({ reRender: false });
      pushUndoSnapshot(state.activeDoc.content, { immediate: true });
      const nextContent = insertMarkdownWithPadding(state.activeDoc.content || '', getMdLines().length, md);
      state.activeDoc.content = nextContent;
      state.dirty = true;
      state.editingBlockIdx = null;
      state.editingBlockRange = null;
      state.editingDraftInsert = null;
      store.state.activeDocumentText = nextContent;
      if (store.state.activeCenterView !== 'explorer') {
        renderMarkdownMode();
      }
      showToast('已从内置回收站还原段落到当前笔记', 'success');
      return;
    }

    if (targetPath) {
      try {
        await openFile(targetPath, { mode: 'live' });
        if (
          state.activeDoc &&
          (state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text') &&
          isSamePath(state.activeDoc.path, targetPath)
        ) {
          pushUndoSnapshot(state.activeDoc.content, { immediate: true });
          const nextContent = insertMarkdownWithPadding(state.activeDoc.content || '', getMdLines().length, md);
          state.activeDoc.content = nextContent;
          state.dirty = true;
          store.state.activeDocumentText = nextContent;
          renderMarkdownMode();
          showToast(`已打开「${state.activeDoc.name}」并还原段落`, 'success');
          return;
        }
      } catch {
        // fall through to clipboard fallback
      }
    }
    copyInternal(md);
    showToast('当前未打开原笔记，已将还原段落复制到剪贴板', 'info');
  });

  store.on('files:updated', (filesData) => {
    const items = filesData?.items || store.state.files?.items || [];
    if (state.activeDoc) {
      const current = items.find((f) => isSamePath(f.path, state.activeDoc.path));
      if (current) {
        const nextPriv = Boolean(current.is_private);
        if (nextPriv !== state.activeDoc.isPrivate) {
          state.activeDoc.isPrivate = nextPriv;
          syncActiveFileStore();
          if (store.state.activeCenterView !== 'explorer') {
            renderActiveView();
          }
        }
      }
      if (store.state.activeCenterView === 'explorer') {
        refreshExplorerUiIfVisible();
      }
      return;
    }

    if (store.state.activeCenterView === 'explorer') {
      refreshExplorerUiIfVisible();
      return;
    }

    if (!state.hasOpenedOnce && !state.loading && items.length > 0) {
      openInitialStartupDoc(items).then((ok) => {
        if (!ok && !state.activeDoc && !state.loading) {
          renderWelcome();
        }
      });
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

  // V5/V6 Drag Staging Shelf: insert single or batch items into current note
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
    if (payload?.sourceShelfId && payload?.dragMode !== 'copy' && typeof consumeShelfItem === 'function') {
      consumeShelfItem(payload.sourceShelfId);
    }
  });

  // V6: Cut source capsule/token when dragged out into Dynamic Island shelf
  store.on('center:cut-source-token', (payload = {}) => {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
    if (payload?.sourceDocPath && !isSamePath(payload.sourceDocPath, doc.path)) return;
    const rawTok = String(payload?.sourceRawToken || '').trim();
    if (!rawTok) return;
    commitActiveBlock({ reRender: false });
    const exactBlk = Number.isFinite(payload?.sourceBlockStart)
      ? parseMarkdownBlocks(doc.content || '').find((b) => b.startLine === payload.sourceBlockStart)
      : null;
    replaceOrRemoveTokenInDoc(rawTok, '', exactBlk || null);
  });

  // V6: Navigation History listeners
  store.on('nav:go', (payload) => {
    const dir = payload === 'forward' || payload?.dir === 'forward' || Number(payload) > 0 ? 1 : -1;
    navigateHistory(dir);
  });
  store.on('nav:changed', () => {
    syncNavButtonsUi();
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
      const mainPane = ensureMainPaneEl();
      const lpContainer = mainPane.querySelector('.lp-container');
      const scrollArea = mainPane.querySelector('.md-scroll-area');
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
          const blkEnd = Number.parseInt(blk.dataset.mdEnd ?? blk.dataset.mdStart, 10);
          const endLine = Number.isFinite(blkEnd) ? blkEnd : 0;

          if (i === 0 && e.clientY < r.top + r.height * 0.22) {
            chosenY = r.top - 4;
            targetLineIdx = 0;
            matched = true;
            break;
          }

          const midY = (r.top + r.bottom) / 2;
          if (e.clientY < midY && i > 0) {
            const prevBlk = blocks[i - 1];
            const prevR = prevBlk.getBoundingClientRect();
            const prevEnd = Number.parseInt(prevBlk.dataset.mdEnd ?? prevBlk.dataset.mdStart, 10);
            chosenY = (prevR.bottom + r.top) / 2;
            targetLineIdx = Number.isFinite(prevEnd) ? prevEnd + 1 : 0;
            matched = true;
            break;
          }

          const nextBlk = i + 1 < blocks.length ? blocks[i + 1] : null;
          const nextTop = nextBlk ? nextBlk.getBoundingClientRect().top : r.bottom + 12;
          if (e.clientY <= r.bottom || (nextBlk && e.clientY < (r.bottom + nextTop) / 2)) {
            chosenY = nextBlk ? (r.bottom + nextTop) / 2 : r.bottom + 6;
            targetLineIdx = endLine + 1;
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
      const ta = ensureMainPaneEl().querySelector('.md-editor:not([data-role])');
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

  function removeSourceTokenForMove(sourceText, rawToken, sourceBlockStart, targetInsertLine) {
    const lines = String(sourceText ?? '').replace(/\r\n/g, '\n').split('\n');
    let searchStart = 0;
    let searchEnd = lines.length - 1;
    if (Number.isFinite(sourceBlockStart)) {
      const blk = parseMarkdownBlocks(sourceText).find((b) => b.startLine === sourceBlockStart);
      if (blk) {
        searchStart = blk.startLine;
        searchEnd = blk.endLine;
      }
    }

    let foundLine = -1;
    for (let i = searchStart; i <= searchEnd && i < lines.length; i += 1) {
      if (lines[i].includes(rawToken)) {
        foundLine = i;
        break;
      }
    }
    if (foundLine < 0) {
      foundLine = lines.findIndex((ln) => ln.includes(rawToken));
    }
    if (foundLine < 0) return null;

    const lineStr = lines[foundLine];
    const tokIdx = lineStr.indexOf(rawToken);
    const cleanedLine = `${lineStr.slice(0, tokIdx)}${lineStr.slice(tokIdx + rawToken.length)}`
      .replace(/[ \t]{2,}/g, ' ')
      .trimEnd();

    let nextTarget = targetInsertLine;
    if (!cleanedLine.trim()) {
      let delStart = foundLine;
      let delCount = 1;
      if (
        delStart > 0 &&
        lines[delStart - 1]?.trim() === '' &&
        delStart + 1 < lines.length &&
        lines[delStart + 1]?.trim() === ''
      ) {
        delCount += 1;
      } else if (delStart === 0 && delStart + 1 < lines.length && lines[delStart + 1]?.trim() === '') {
        delCount += 1;
      }
      lines.splice(delStart, delCount);
      if (nextTarget > delStart) {
        nextTarget -= Math.min(delCount, nextTarget - delStart);
      }
    } else {
      lines[foundLine] = cleanedLine;
    }

    const rawRemaining = lines.join('\n');
    const leadingBlankMatch = rawRemaining.match(/^\n+/);
    const strippedLeading = leadingBlankMatch ? leadingBlankMatch[0].length : 0;
    const remaining = rawRemaining.slice(strippedLeading);
    const remLines = remaining ? remaining.split('\n') : [];
    const adjustedTarget = Math.max(0, Math.min(remLines.length, nextTarget - strippedLeading));
    return { remaining, adjustedTarget };
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

      const isSameDocMove = Boolean(
        payload?.dragMode === 'move' &&
        !isCopyDragEvent(dropEvent) &&
        payload?.sourceRawToken &&
        payload?.sourceDocPath &&
        isSamePath(payload.sourceDocPath, doc.path)
      );

      if (state.mdMode === 'source') {
        const ta = ensureMainPaneEl().querySelector('.md-editor:not([data-role])');
        let baseContent = doc.content || '';
        let targetLine = Number.isFinite(lineIdx) ? lineIdx : resolveSourceDropLine(ta, dropEvent);
        if (isSameDocMove) {
          const moved = removeSourceTokenForMove(baseContent, payload.sourceRawToken, payload.sourceBlockStart, targetLine);
          if (moved) {
            baseContent = moved.remaining;
            targetLine = moved.adjustedTarget;
          }
        }
        const nextVal = insertMarkdownWithPadding(baseContent, targetLine, markdown);
        doc.content = nextVal;
        state.dirty = true;
        store.state.activeDocumentText = nextVal;
        if (ta) {
          ta.value = nextVal;
          ta.focus();
        }
        updateMdDirtyIndicators();
        showToast(isSameDocMove ? `已移动「${label}」（Ctrl+Z 可撤回）` : `已精准拖入「${label}」（Ctrl+Z 可撤回）`, 'success');
        return;
      }

      let baseContent = doc.content || '';
      const origLines = getMdLines();
      let clampedLine = Math.max(0, Math.min(origLines.length, Number.isFinite(lineIdx) ? lineIdx : origLines.length));

      if (isSameDocMove) {
        const moved = removeSourceTokenForMove(baseContent, payload.sourceRawToken, payload.sourceBlockStart, clampedLine);
        if (moved) {
          baseContent = moved.remaining;
          clampedLine = moved.adjustedTarget;
        }
      }

      const baseLines = baseContent ? baseContent.replace(/\r\n/g, '\n').split('\n') : [];
      const beforeSlice = baseLines.slice(0, clampedLine).join('\n').replace(/\n+$/g, '');
      const actualStartLine = beforeSlice.trim() ? beforeSlice.split('\n').length + 1 : 0;
      const firstLinePrefix = markdown.split('\n')[0].replace(/[#>*`\[\]]/g, '').trim().slice(0, 16);
      doc.content = insertMarkdownWithPadding(baseContent, clampedLine, markdown);
      state.dirty = true;
      state.editingBlockIdx = null;
      state.editingBlockRange = null;
      state.editingDraftInsert = null;
      state.justDroppedTarget = { lineIdx: clampedLine, actualStartLine, prefix: firstLinePrefix };
      store.state.activeDocumentText = doc.content;
      if (state.mdMode === 'mindmap') {
        state.mdMode = 'live';
      }
      renderMarkdownMode();
      showToast(isSameDocMove ? `已移动「${label}」（Ctrl+Z 可撤回）` : `已精准拖入「${label}」（Ctrl+Z 可撤回）`, 'success');
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
    if (e.target.closest('.center-split-pane, .explorer-home')) return;
    if (!isAcceptableBlockDrag(e)) return;
    e.preventDefault();
    dragDepth += 1;
    if (!updatePrecisionDropLine(e)) {
      showDropOverlay(true);
    }
  });

  containerEl.addEventListener('dragover', (e) => {
    if (e.target.closest('.center-split-pane, .explorer-home')) return;
    if (!isAcceptableBlockDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = isCopyDragEvent(e) ? 'copy' : 'move';
    }
    if (updatePrecisionDropLine(e)) {
      showDropOverlay(false);
    } else {
      showDropOverlay(true);
    }
  });

  containerEl.addEventListener('dragleave', (e) => {
    if (e.target.closest('.explorer-home')) return;
    if (!isAcceptableBlockDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    const mainRect = ensureMainPaneEl().getBoundingClientRect();
    const isOutsideBounds =
      e.clientX <= mainRect.left ||
      e.clientX >= mainRect.right ||
      e.clientY <= mainRect.top ||
      e.clientY >= mainRect.bottom;
    const relOutside = e.relatedTarget !== null && !ensureMainPaneEl().contains(e.relatedTarget);
    if (dragDepth <= 0 && (isOutsideBounds || relOutside)) {
      dragDepth = 0;
      showDropOverlay(false);
      removeDropInsertLine();
    }
  });

  containerEl.addEventListener('drop', (e) => {
    if (e.target.closest('.center-split-pane, .explorer-home')) return;
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
    const isCopy = isCopyDragEvent(e);
    if (isCopy) {
      payload.dragMode = 'copy';
    }
    insertDroppedMarkdown(payload, { lineIdx: savedLineIdx, dropEvent: e });
    if (payload.sourceShelfId && !isCopy && typeof consumeShelfItem === 'function') {
      consumeShelfItem(payload.sourceShelfId);
    }
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
    hideHoverPeekCard();
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
        dragMode: isCopyDragEvent(e) ? 'copy' : 'move',
        sourceDocPath: state.activeDoc?.path || '',
        sourceRawToken: rawToken,
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
  // DOM Event Delegation, WYSIWYG Sync, Format Toolbar & Slash Commands
  // =========================================================================
  function syncWysiwygBlockInput(editorEl, { immediateUndoAlreadyPushed = false } = {}) {
    const doc = state.activeDoc;
    if (!doc || !editorEl) return;
    const blockEl = editorEl.closest('.lp-block');
    if (!blockEl) return;

    const prevContent = String(doc.content ?? '');
    if (!immediateUndoAlreadyPushed) {
      pushUndoSnapshot(prevContent, { immediate: false });
    }

    const mdText = wysiwygElementToMarkdown(editorEl);
    const isDraftInsert = Boolean(state.editingDraftInsert);

    if (isDraftInsert) {
      if (!mdText.trim()) {
        return;
      }
      const insertAt = state.editingDraftInsert.startLine;
      state.editingDraftInsert = null;
      state.editingDraftNewBlock = false;
      blockEl.removeAttribute('data-draft-block');

      const nextDoc = insertMarkdownWithPadding(prevContent, insertAt, mdText);
      const blocksAfter = parseMarkdownBlocks(nextDoc);
      const insertedBlk =
        blocksAfter.find((b) => b.startLine >= insertAt) ||
        blocksAfter[blocksAfter.length - 1] ||
        { startLine: insertAt, endLine: insertAt };
      state.editingBlockIdx = blocksAfter.indexOf(insertedBlk);
      state.editingBlockRange = { startLine: insertedBlk.startLine, endLine: insertedBlk.endLine };
      blockEl.dataset.blockIdx = String(state.editingBlockIdx);
      blockEl.dataset.mdStart = String(insertedBlk.startLine);
      blockEl.dataset.mdEnd = String(insertedBlk.endLine);
      editorEl.dataset.blockIdx = String(state.editingBlockIdx);

      const oldLinesCount = prevContent.replace(/\r\n/g, '\n').split('\n').length;
      const newLinesCount = nextDoc.replace(/\r\n/g, '\n').split('\n').length;
      const delta = newLinesCount - oldLinesCount;
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

      doc.content = nextDoc;
      state.dirty = true;
      store.state.activeDocumentText = doc.content;
      updateMdDirtyIndicators();
      return;
    }

    const range = state.editingBlockRange || {
      startLine: Number.parseInt(blockEl.dataset.mdStart, 10) || 0,
      endLine: Number.parseInt(blockEl.dataset.mdEnd ?? blockEl.dataset.mdStart, 10) || 0,
    };

    const lines = prevContent.replace(/\r\n/g, '\n').split('\n');
    const editedLines = mdText === '' ? [''] : mdText.split('\n');
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

    if (mdText.trim()) {
      state.editingDraftNewBlock = false;
      blockEl.removeAttribute('data-draft-block');
    }

    doc.content = lines.join('\n');
    state.dirty = true;
    store.state.activeDocumentText = doc.content;
    updateMdDirtyIndicators();
  }

  function applySourceFormatAction(ta, kind) {
    const doc = state.activeDoc;
    if (!doc || !ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? start;
    const val = ta.value;

    if (kind === 'copy') {
      const slice = start < end ? val.slice(start, end) : (() => {
        const ls = val.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
        const le = val.indexOf('\n', end);
        return val.slice(ls, le === -1 ? val.length : le);
      })();
      if (slice) {
        internalClipboard = slice;
        copyInternal(slice, '已复制');
      }
      return;
    }

    if (kind === 'cut') {
      pushUndoSnapshot(doc.content, { immediate: true });
      let cStart = start;
      let cEnd = end;
      if (cStart === cEnd) {
        cStart = val.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
        const le = val.indexOf('\n', end);
        cEnd = le === -1 ? val.length : Math.min(val.length, le + 1);
      }
      const cutStr = val.slice(cStart, cEnd);
      if (cutStr) {
        internalClipboard = cutStr;
        copyInternal(cutStr, '已剪切');
        const nextVal = `${val.slice(0, cStart)}${val.slice(cEnd)}`;
        ta.value = nextVal;
        ta.setSelectionRange(cStart, cStart);
        doc.content = nextVal;
        state.dirty = true;
        store.state.activeDocumentText = nextVal;
        updateMdDirtyIndicators();
      }
      return;
    }

    if (kind === 'paste') {
      navigator.clipboard?.readText?.().then((clip) => {
        const txt = clip || internalClipboard;
        if (!txt) {
          showToast('剪贴板为空', 'info', { duration: 1500 });
          return;
        }
        pushUndoSnapshot(doc.content, { immediate: true });
        const curS = ta.selectionStart ?? start;
        const curE = ta.selectionEnd ?? curS;
        const nextVal = `${ta.value.slice(0, curS)}${txt}${ta.value.slice(curE)}`;
        ta.value = nextVal;
        ta.setSelectionRange(curS + txt.length, curS + txt.length);
        doc.content = nextVal;
        state.dirty = true;
        store.state.activeDocumentText = nextVal;
        updateMdDirtyIndicators();
      }).catch(() => {
        if (internalClipboard) {
          pushUndoSnapshot(doc.content, { immediate: true });
          const nextVal = `${val.slice(0, start)}${internalClipboard}${val.slice(end)}`;
          ta.value = nextVal;
          ta.setSelectionRange(start + internalClipboard.length, start + internalClipboard.length);
          doc.content = nextVal;
          state.dirty = true;
          store.state.activeDocumentText = nextVal;
          updateMdDirtyIndicators();
        } else {
          showToast('请使用 Ctrl+V 粘贴', 'info', { duration: 1600 });
        }
      });
      return;
    }

    pushUndoSnapshot(doc.content, { immediate: true });

    let nextVal = val;
    let nextSelStart = start;
    let nextSelEnd = end;

    const inlineWraps = {
      bold: ['**', '**'],
      italic: ['*', '*'],
      strike: ['~~', '~~'],
      mark: ['<mark>', '</mark>'],
      code: ['`', '`'],
    };

    if (inlineWraps[kind]) {
      const [pre, post] = inlineWraps[kind];
      const selected = val.slice(start, end);
      const before = val.slice(Math.max(0, start - pre.length), start);
      const after = val.slice(end, end + post.length);
      const canUnwrap =
        before === pre &&
        after === post &&
        (kind !== 'italic' || (val.slice(Math.max(0, start - 2), start) !== '**' && val.slice(end, end + 2) !== '**'));

      if (canUnwrap) {
        nextVal = `${val.slice(0, start - pre.length)}${selected}${val.slice(end + post.length)}`;
        nextSelStart = start - pre.length;
        nextSelEnd = end - pre.length;
      } else if (selected) {
        nextVal = `${val.slice(0, start)}${pre}${selected}${post}${val.slice(end)}`;
        nextSelStart = start + pre.length;
        nextSelEnd = end + pre.length;
      } else {
        nextVal = `${val.slice(0, start)}${pre}${post}${val.slice(end)}`;
        nextSelStart = start + pre.length;
        nextSelEnd = start + pre.length;
      }
    } else if (kind === 'h1' || kind === 'h2' || kind === 'h3') {
      const prefix = kind === 'h1' ? '# ' : kind === 'h2' ? '## ' : '### ';
      const lineStart = val.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
      const lineEndIdx = val.indexOf('\n', end);
      const lineEnd = lineEndIdx === -1 ? val.length : lineEndIdx;
      const lineStr = val.slice(lineStart, lineEnd);
      const stripped = lineStr.replace(/^\s{0,3}#{1,6}\s+/, '');
      const toggled = lineStr.startsWith(prefix) ? stripped : `${prefix}${stripped}`;
      nextVal = `${val.slice(0, lineStart)}${toggled}${val.slice(lineEnd)}`;
      nextSelStart = lineStart + toggled.length;
      nextSelEnd = nextSelStart;
    } else if (kind === 'quote' || kind === 'ul' || kind === 'todo') {
      const lineStart = val.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
      const lineEndIdx = val.indexOf('\n', end);
      const lineEnd = lineEndIdx === -1 ? val.length : lineEndIdx;
      const segs = val.slice(lineStart, lineEnd).split('\n');
      let toggled;
      if (kind === 'quote') {
        const allQ = segs.every((ln) => /^\s*>/.test(ln));
        toggled = allQ ? segs.map((ln) => ln.replace(/^\s*>\s?/, '')) : segs.map((ln) => `> ${ln}`);
      } else if (kind === 'ul') {
        const allU = segs.every((ln) => /^\s*[-*+]\s+/.test(ln));
        toggled = allU ? segs.map((ln) => ln.replace(/^\s*[-*+]\s+/, '')) : segs.map((ln) => `- ${ln}`);
      } else {
        const allT = segs.every((ln) => /^\s*[-*+]\s+\[[ xX]\]\s+/.test(ln));
        toggled = allT
          ? segs.map((ln) => ln.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, ''))
          : segs.map((ln) => `- [ ] ${ln.replace(/^\s*[-*+]\s+/, '')}`);
      }
      const joined = toggled.join('\n');
      nextVal = `${val.slice(0, lineStart)}${joined}${val.slice(lineEnd)}`;
      nextSelStart = lineStart;
      nextSelEnd = lineStart + joined.length;
    }

    ta.value = nextVal;
    ta.setSelectionRange(nextSelStart, nextSelEnd);
    doc.content = nextVal;
    state.dirty = true;
    store.state.activeDocumentText = nextVal;
    updateMdDirtyIndicators();
  }

  function applyWysiwygBarAction(act) {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;

    if (state.mdMode === 'source') {
      const ta = ensureMainPaneEl().querySelector('.md-editor:not([data-role])');
      if (ta) {
        ta.focus();
        applySourceFormatAction(ta, act);
      }
      return;
    }

    if (state.mdMode !== 'live') return;

    let editorEl = containerEl.querySelector('.lp-block-wysiwyg');
    if (!editorEl) {
      // Check if user has a selection inside a non-editing block, else activate block 0 or create draft
      const sel = window.getSelection();
      const selNode = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).startContainer : null;
      const selEl = selNode?.nodeType === 1 ? selNode : selNode?.parentElement;
      const targetBlk = selEl?.closest('.lp-block[data-block-idx]') || containerEl.querySelector('.lp-block[data-block-idx]');
      if (targetBlk) {
        const bIdx = Number.parseInt(targetBlk.dataset.blockIdx, 10);
        if (Number.isFinite(bIdx)) {
          state.editingBlockIdx = bIdx;
          state.editingDraftNewBlock = false;
          state.editingDraftInsert = null;
          renderMarkdownMode();
          editorEl = containerEl.querySelector('.lp-block-wysiwyg');
          if (editorEl) {
            editorEl.focus({ preventScroll: true });
            placeCaretInsideWysiwyg(editorEl, 'end');
          }
        }
      } else {
        appendNewBlockAndFocus();
        window.requestAnimationFrame(() => {
          const ed = containerEl.querySelector('.lp-block-wysiwyg');
          if (ed && act !== 'cut' && act !== 'copy' && act !== 'paste') {
            execWysiwygFormat(act, ed);
            syncWysiwygBlockInput(ed);
          }
        });
        return;
      }
    }

    if (!editorEl) return;

    if (act === 'copy') {
      const sel = window.getSelection();
      const selStr = sel && !sel.isCollapsed ? sel.toString() : '';
      const textToCopy = selStr || wysiwygElementToMarkdown(editorEl);
      if (textToCopy) {
        internalClipboard = textToCopy;
        copyInternal(textToCopy, '已复制');
      }
      return;
    }

    if (act === 'cut') {
      const sel = window.getSelection();
      const hasRangeSel = Boolean(sel && !sel.isCollapsed && editorEl.contains(sel.getRangeAt(0).commonAncestorContainer));
      if (hasRangeSel) {
        const selStr = sel.toString();
        internalClipboard = selStr;
        copyInternal(selStr, '已剪切');
        pushUndoSnapshot(doc.content, { immediate: true });
        document.execCommand?.('delete', false, null);
        syncWysiwygBlockInput(editorEl, { immediateUndoAlreadyPushed: true });
      } else {
        const blkMd = wysiwygElementToMarkdown(editorEl);
        if (blkMd) {
          internalClipboard = blkMd;
          copyInternal(blkMd, '已剪切当前段落');
        }
        deleteActiveEmptyOrSelectedBlock(editorEl);
      }
      return;
    }

    if (act === 'paste') {
      const insertClipText = (clipText) => {
        if (!clipText) {
          showToast('剪贴板为空', 'info', { duration: 1500 });
          return;
        }
        pushUndoSnapshot(doc.content, { immediate: true });
        editorEl.focus({ preventScroll: true });
        if (typeof document.execCommand === 'function') {
          document.execCommand('insertText', false, clipText);
        } else {
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            range.insertNode(document.createTextNode(clipText));
            range.collapse(false);
          }
        }
        syncWysiwygBlockInput(editorEl, { immediateUndoAlreadyPushed: true });
      };

      if (navigator.clipboard?.readText) {
        navigator.clipboard.readText().then((clip) => {
          insertClipText(clip || internalClipboard);
        }).catch(() => {
          if (internalClipboard) insertClipText(internalClipboard);
          else showToast('请使用 Ctrl+V 粘贴', 'info', { duration: 1600 });
        });
      } else if (internalClipboard) {
        insertClipText(internalClipboard);
      } else {
        showToast('请使用 Ctrl+V 粘贴', 'info', { duration: 1600 });
      }
      return;
    }

    pushUndoSnapshot(doc.content, { immediate: true });
    const changed = execWysiwygFormat(act, editorEl);
    if (changed) {
      syncWysiwygBlockInput(editorEl, { immediateUndoAlreadyPushed: true });
    }
  }

  function deleteActiveEmptyOrSelectedBlock(editorEl) {
    const doc = state.activeDoc;
    if (!doc) return;
    const prevIdx = state.editingDraftInsert
      ? state.editingDraftInsert.afterBlockIdx
      : (Number.isFinite(state.editingBlockIdx) ? state.editingBlockIdx - 1 : -1);

    if (state.editingDraftInsert || state.editingDraftNewBlock) {
      cleanupEmptyTrailingDraftIfNeeded();
      state.editingBlockIdx = null;
      state.editingBlockRange = null;
      if (prevIdx >= 0) {
        activateBlockByIndex(prevIdx, 'end');
      } else {
        renderMarkdownMode();
      }
      return;
    }

    if (state.editingBlockRange) {
      pushUndoSnapshot(doc.content, { immediate: true });
      const { startLine, endLine } = state.editingBlockRange;
      const lines = getMdLines();
      let delStart = Math.max(0, startLine);
      let delCount = Math.max(1, endLine - delStart + 1);
      if (delStart > 0 && lines[delStart - 1]?.trim() === '' && delStart + delCount < lines.length && lines[delStart + delCount]?.trim() === '') {
        delCount += 1;
      } else if (delStart === 0 && delStart + delCount < lines.length && lines[delStart + delCount]?.trim() === '') {
        delCount += 1;
      }
      lines.splice(delStart, delCount);
      doc.content = lines.join('\n').replace(/^\n+/, '');
      state.dirty = true;
      store.state.activeDocumentText = doc.content;
      state.editingBlockIdx = null;
      state.editingBlockRange = null;
      if (prevIdx >= 0) {
        activateBlockByIndex(prevIdx, 'end');
      } else {
        renderMarkdownMode();
      }
    }
  }

  containerEl.addEventListener('paste', (e) => {
    const editorEl = e.target.closest?.('.lp-block-wysiwyg');
    if (!editorEl) return;
    const plain = e.clipboardData?.getData('text/plain');
    if (typeof plain === 'string') {
      e.preventDefault();
      if (typeof document.execCommand === 'function') {
        document.execCommand('insertText', false, plain);
      } else {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(plain));
          range.collapse(false);
        }
      }
      syncWysiwygBlockInput(editorEl);
    }
  });

  containerEl.addEventListener('input', (e) => {
    const target = e.target;

    // Live Preview WYSIWYG inline block editor
    const wysiwygEl = target.closest?.('.lp-block-wysiwyg') || (target.matches?.('.lp-block-wysiwyg') ? target : null);
    if (wysiwygEl) {
      syncWysiwygBlockInput(wysiwygEl);
      maybeTriggerSlashMenuFromWysiwyg(wysiwygEl);
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
      maybeTriggerSlashMenuFromSource(target);
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
      return;
    }

    // Task checkbox toggle inside .lp-block-view (editing or non-editing)
    if (e.target.matches('.lp-block-view input[type="checkbox"]')) {
      const doc = state.activeDoc;
      if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
      const wysiwygEl = e.target.closest('.lp-block-wysiwyg');
      if (wysiwygEl) {
        syncWysiwygBlockInput(wysiwygEl);
        return;
      }
      const viewEl = e.target.closest('.lp-block-view');
      const blockEl = e.target.closest('.lp-block[data-md-start]');
      if (!viewEl || !blockEl) return;
      const startLine = Number.parseInt(blockEl.dataset.mdStart, 10);
      const endLine = Number.parseInt(blockEl.dataset.mdEnd ?? blockEl.dataset.mdStart, 10);
      if (!Number.isFinite(startLine)) return;
      const nextBlockMd = wysiwygElementToMarkdown(viewEl);
      const lines = getMdLines();
      const oldCount = Math.max(1, endLine - startLine + 1);
      const newLines = nextBlockMd.split('\n');
      pushUndoSnapshot(doc.content, { immediate: true });
      lines.splice(startLine, oldCount, ...newLines);
      doc.content = lines.join('\n');
      state.dirty = true;
      store.state.activeDocumentText = doc.content;
      updateMdDirtyIndicators();
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
    document.querySelectorAll('#island-shelf-drawer.is-drag-over, #drag-shelf.is-drag-over, [data-drop-zone="drag-shelf"].is-drag-over, #right-panel.is-drag-over, [data-drop-zone="right-ai"].is-drag-over, #portable-trash-dock.is-drag-over, [data-drop-zone="trash"].is-drag-over, [data-drop-zone="portable-trash"].is-drag-over').forEach((el) => {
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
      store.endGlobalDrag?.();
      store.emit('drag:active', false);
    }
  }

  function cutBlockRangeFromDoc(startLine, endLine) {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
    pushUndoSnapshot(doc.content, { immediate: true });
    const lines = String(doc.content ?? '').replace(/\r\n/g, '\n').split('\n');
    const delStart = Math.max(0, startLine);
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
    let nextContent = lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
    if (nextContent.trim() && !nextContent.endsWith('\n')) {
      nextContent += '\n';
    } else if (!nextContent.trim()) {
      nextContent = '';
    }
    doc.content = nextContent;
    state.dirty = true;
    state.editingBlockIdx = null;
    state.editingBlockRange = null;
    state.editingDraftInsert = null;
    store.state.activeDocumentText = nextContent;
    renderMarkdownMode();
  }

  function reorderLiveBlock(startLine, endLine, rawBlock, targetInsertLine) {
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;
    pushUndoSnapshot(doc.content, { immediate: true });
    const lines = String(doc.content ?? '').replace(/\r\n/g, '\n').split('\n');
    const delStart = Math.max(0, startLine);
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

    const rawRemaining = lines.join('\n');
    const leadingBlankMatch = rawRemaining.match(/^\n+/);
    const strippedLeadingCount = leadingBlankMatch ? leadingBlankMatch[0].length : 0;
    const remaining = rawRemaining.slice(strippedLeadingCount);
    const remLines = remaining ? remaining.split('\n') : [];
    const clampedTarget = Math.max(0, Math.min(remLines.length, adjustedTarget - strippedLeadingCount));
    const beforeSlice = remLines.slice(0, clampedTarget).join('\n').replace(/\n+$/g, '');
    const actualStartLine = beforeSlice.trim() ? beforeSlice.split('\n').length + 1 : 0;
    const firstLinePrefix = rawBlock.split('\n')[0].replace(/[#>*`\[\]]/g, '').trim().slice(0, 16);

    doc.content = insertMarkdownWithPadding(remaining, clampedTarget, rawBlock);
    state.dirty = true;
    state.editingBlockIdx = null;
    state.editingBlockRange = null;
    state.editingDraftInsert = null;
    state.justDroppedTarget = { lineIdx: clampedTarget, actualStartLine, prefix: firstLinePrefix };
    store.state.activeDocumentText = doc.content;
    renderMarkdownMode();
    showToast('已调整段落顺序（Ctrl+Z 可撤回）', 'success');
  }

  // V4 #6: Drag Resize Handle (.media-resize-handle), Split Resizers, Companion Float Win & V6 0.5s Long-Press Block Drag
  containerEl.addEventListener('pointerdown', (e) => {
    // 1. Main Dual-Pane Split Resizer (.center-split-resizer)
    const splitResizer = e.target.closest('[data-role="center-split-resizer"]');
    if (splitResizer) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const layout = ensureSplitLayoutEl();
      const mainPane = layout.querySelector(':scope > [data-role="center-main-pane"]');
      const splitPane = layout.querySelector(':scope > .center-split-pane');
      if (!mainPane || !splitPane) return;

      splitResizer.classList.add('is-resizing');
      document.body.classList.add('is-pane-resizing');

      const onMove = (ev) => {
        const rect = layout.getBoundingClientRect();
        if (!rect.width) return;
        const relX = ev.clientX - rect.left;
        const rightRatio = Math.min(0.8, Math.max(0.2, 1 - relX / rect.width));
        state.splitRatio = Number(rightRatio.toFixed(3));
        const leftPct = ((1 - state.splitRatio) * 100).toFixed(1);
        const rightPct = (state.splitRatio * 100).toFixed(1);
        mainPane.style.flex = `0 0 calc(${leftPct}% - 4px)`;
        splitPane.style.flex = `1 1 calc(${rightPct}% - 4px)`;
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        splitResizer.classList.remove('is-resizing');
        document.body.classList.remove('is-pane-resizing');
        try {
          localStorage.setItem('sln_split_ratio', String(state.splitRatio));
        } catch {
          // ignore
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      return;
    }

    // 1b. Explorer Home Split Resizer ([data-role="explorer-split-resizer"])
    const explorerSplitResizer = e.target.closest('[data-role="explorer-split-resizer"]');
    if (explorerSplitResizer) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const bodyEl = explorerSplitResizer.closest('.explorer-body');
      const filesPane = bodyEl?.querySelector(':scope > .explorer-files-pane');
      const todoPane = bodyEl?.querySelector(':scope > .explorer-todo-pane');
      if (!bodyEl || !filesPane || !todoPane) return;

      explorerSplitResizer.classList.add('is-resizing');
      document.body.classList.add('is-pane-resizing');

      const onMove = (ev) => {
        const rect = bodyEl.getBoundingClientRect();
        if (!rect.width) return;
        const relX = ev.clientX - rect.left;
        const nextRatio = Math.min(0.78, Math.max(0.28, relX / rect.width));
        state.explorer.splitRatio = Number(nextRatio.toFixed(3));
        const filesPct = (state.explorer.splitRatio * 100).toFixed(1);
        const todoPct = ((1 - state.explorer.splitRatio) * 100).toFixed(1);
        filesPane.style.flex = `0 0 calc(${filesPct}% - 4px)`;
        filesPane.style.width = `calc(${filesPct}% - 4px)`;
        todoPane.style.flex = `1 1 calc(${todoPct}% - 4px)`;
        todoPane.style.width = `calc(${todoPct}% - 4px)`;
        const filesPx = Math.round(rect.width * state.explorer.splitRatio);
        showPaneResizeTooltip(ev.clientX, ev.clientY, `${Math.round(state.explorer.splitRatio * 100)}% (${filesPx}px)`);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        explorerSplitResizer.classList.remove('is-resizing');
        document.body.classList.remove('is-pane-resizing');
        hidePaneResizeTooltip();
        try {
          localStorage.setItem('sln_explorer_split_ratio', String(state.explorer.splitRatio));
        } catch {
          // ignore
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      return;
    }

    // 1c. Archive Virtual Tree Split Resizer ([data-role="archive-split-resizer"])
    const archiveSplitResizer = e.target.closest('[data-role="archive-split-resizer"]');
    if (archiveSplitResizer) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const ws = archiveSplitResizer.parentElement;
      const treeEl = ws?.querySelector(':scope > .archive-tree');
      if (!ws || !treeEl) return;

      archiveSplitResizer.classList.add('is-resizing');
      document.body.classList.add('is-pane-resizing');

      const onMove = (ev) => {
        const rect = ws.getBoundingClientRect();
        if (!rect.width) return;
        const relX = ev.clientX - rect.left;
        const nextW = Math.round(Math.min(460, Math.max(150, relX)));
        state.archiveTreeWidth = nextW;
        treeEl.style.width = `${nextW}px`;
        treeEl.style.flex = `0 0 ${nextW}px`;
        showPaneResizeTooltip(ev.clientX, ev.clientY, `${nextW}px`);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        archiveSplitResizer.classList.remove('is-resizing');
        document.body.classList.remove('is-pane-resizing');
        hidePaneResizeTooltip();
        try {
          localStorage.setItem('sln_archive_tree_w', String(state.archiveTreeWidth));
        } catch {
          // ignore
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      return;
    }

    // 2. Companion Split-Pane Resizer (.companion-split-resizer)
    const compSplitResizer = e.target.closest('[data-role="companion-split-resizer"]');
    if (compSplitResizer) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const ws = compSplitResizer.parentElement;
      const compPane = ws?.querySelector(':scope > [data-role="companion-split-pane"]');
      if (!ws || !compPane) return;

      compSplitResizer.classList.add('is-resizing');
      document.body.classList.add('is-pane-resizing');

      const onMove = (ev) => {
        const rect = ws.getBoundingClientRect();
        if (!rect.width) return;
        const relX = ev.clientX - rect.left;
        const compRatio = Math.min(0.72, Math.max(0.22, 1 - relX / rect.width));
        state.companionSplitRatio = Number(compRatio.toFixed(3));
        const pct = (state.companionSplitRatio * 100).toFixed(1);
        compPane.style.flex = `0 0 ${pct}%`;
        compPane.style.width = `${pct}%`;
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        compSplitResizer.classList.remove('is-resizing');
        document.body.classList.remove('is-pane-resizing');
        try {
          localStorage.setItem('sln_companion_split_ratio', String(state.companionSplitRatio));
        } catch {
          // ignore
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      return;
    }

    // 3. Companion Floating Window 5-Way Resize Handles ([data-comp-resize])
    const compResizeHandle = e.target.closest('[data-comp-resize]');
    if (compResizeHandle) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const floatWin = compResizeHandle.closest('[data-role="companion-float-win"]');
      const hostEl = floatWin?.offsetParent || floatWin?.parentElement;
      if (!floatWin || !hostEl) return;
      e.preventDefault();
      e.stopPropagation();

      const dir = compResizeHandle.dataset.compResize || 'se';
      const hostRect = hostEl.getBoundingClientRect();
      const winRect = floatWin.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = winRect.left - hostRect.left;
      const startTop = winRect.top - hostRect.top;
      const startW = winRect.width;
      const startH = winRect.height;

      document.body.classList.add('is-pane-resizing');

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let nextLeft = startLeft;
        let nextTop = startTop;
        let nextW = startW;
        let nextH = startH;

        if (dir.includes('e')) {
          nextW = Math.min(Math.max(260, startW + dx), Math.max(280, hostRect.width - startLeft - 8));
        }
        if (dir.includes('w')) {
          const maxDeltaLeft = startW - 260;
          const clampedDx = Math.min(maxDeltaLeft, Math.max(-startLeft + 8, dx));
          nextLeft = Math.round(startLeft + clampedDx);
          nextW = Math.round(startW - clampedDx);
        }
        if (dir.includes('s')) {
          nextH = Math.min(Math.max(220, startH + dy), Math.max(240, hostRect.height - startTop - 8));
        }

        floatWin.style.right = 'auto';
        floatWin.style.left = `${Math.round(nextLeft)}px`;
        floatWin.style.top = `${Math.round(nextTop)}px`;
        floatWin.style.width = `${Math.round(nextW)}px`;
        floatWin.style.height = `${Math.round(nextH)}px`;

        state.companionFloatRect = {
          left: Math.round(nextLeft),
          right: null,
          top: Math.round(nextTop),
          w: Math.round(nextW),
          h: Math.round(nextH),
        };
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('is-pane-resizing');
        try {
          localStorage.setItem('sln_companion_float_rect', JSON.stringify(state.companionFloatRect));
        } catch {
          // ignore
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      return;
    }

    // 4. Companion Floating Window Header Drag Move ([data-role="companion-float-header"])
    const compFloatHeader = e.target.closest('[data-role="companion-float-header"]');
    if (compFloatHeader && state.companionLayout !== 'split' && !e.target.closest('button, input, select, .segmented-pill')) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const floatWin = compFloatHeader.closest('[data-role="companion-float-win"]');
      const hostEl = floatWin?.offsetParent || floatWin?.parentElement;
      if (floatWin && hostEl) {
        e.preventDefault();
        e.stopPropagation();
        const hostRect = hostEl.getBoundingClientRect();
        const winRect = floatWin.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        const startLeft = winRect.left - hostRect.left;
        const startTop = winRect.top - hostRect.top;
        const winW = winRect.width;
        const winH = winRect.height;

        document.body.classList.add('is-pane-resizing');

        const onMove = (ev) => {
          const maxLeft = Math.max(8, hostRect.width - winW - 8);
          const maxTop = Math.max(8, hostRect.height - Math.min(winH, 80) - 8);
          const nextLeft = Math.round(Math.min(maxLeft, Math.max(8, startLeft + (ev.clientX - startX))));
          const nextTop = Math.round(Math.min(maxTop, Math.max(8, startTop + (ev.clientY - startY))));
          floatWin.style.right = 'auto';
          floatWin.style.left = `${nextLeft}px`;
          floatWin.style.top = `${nextTop}px`;
          state.companionFloatRect = {
            ...state.companionFloatRect,
            left: nextLeft,
            right: null,
            top: nextTop,
            w: Math.round(winW),
            h: Math.round(winH),
          };
        };

        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          document.body.classList.remove('is-pane-resizing');
          try {
            localStorage.setItem('sln_companion_float_rect', JSON.stringify(state.companionFloatRect));
          } catch {
            // ignore
          }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return;
      }
    }

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

    // V6 0.5-Second Long-Press Block Dragging (Pointer-Hold Engine)
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

      document.querySelectorAll('#island-shelf-drawer.is-drag-over, #drag-shelf.is-drag-over, [data-drop-zone="drag-shelf"].is-drag-over, #right-panel.is-drag-over, [data-drop-zone="right-ai"].is-drag-over, #portable-trash-dock.is-drag-over, [data-drop-zone="trash"].is-drag-over, [data-drop-zone="portable-trash"].is-drag-over').forEach((el) => {
        el.classList.remove('is-drag-over');
      });

      const hitEls = typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(ev.clientX, ev.clientY)
        : [];
      const hitEl = hitEls[0] || document.elementFromPoint(ev.clientX, ev.clientY);
      const trashEl = hitEls
        .map((el) => el?.closest?.('#portable-trash-dock, [data-drop-zone="trash"], [data-drop-zone="portable-trash"]'))
        .find(Boolean) || hitEl?.closest('#portable-trash-dock, [data-drop-zone="trash"], [data-drop-zone="portable-trash"]');
      const shelfEl = hitEl?.closest('#island-shelf-drawer, #drag-shelf, [data-drop-zone="drag-shelf"], #dynamic-island');
      const rightEl = hitEl?.closest('#right-panel, [data-drop-zone="right-ai"]');
      if (trashEl) {
        trashEl.classList.add('is-drag-over');
        removeDropInsertLine();
      } else if (shelfEl) {
        shelfEl.classList.add('is-drag-over');
        removeDropInsertLine();
      } else if (rightEl) {
        rightEl.classList.add('is-drag-over');
        removeDropInsertLine();
      } else if (ensureMainPaneEl().contains(hitEl) && state.mdMode === 'live') {
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
      const hitEls = typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(ev.clientX, ev.clientY)
        : [];
      const hitEl = hitEls[0] || document.elementFromPoint(ev.clientX, ev.clientY);
      const trashDropEl = hitEls
        .map((el) => el?.closest?.('#portable-trash-dock, [data-drop-zone="trash"], [data-drop-zone="portable-trash"]'))
        .find(Boolean) || hitEl?.closest('#portable-trash-dock, [data-drop-zone="trash"], [data-drop-zone="portable-trash"]');
      const payload = sess.payload;
      const isCopyDrag = isCopyDragEvent(ev);
      cancelActiveHoldSession();
      window.setTimeout(() => {
        suppressNextBlockClick = false;
      }, 120);

      if (trashDropEl) {
        cutBlockRangeFromDoc(startLine, endLine);
        Promise.resolve(
          store.trashVirtualItem?.({
            kind: 'lp-block',
            title: firstLinePreview,
            payload: {
              markdown: raw,
              docPath: payload.sourceDocPath,
              startLine,
              endLine,
            },
            source_path: payload.sourceDocPath,
          })
        ).catch(() => {});
        showToast('已将段落移入内置回收站', 'success');
        return;
      }

      if (hitEl?.closest('#island-shelf-drawer, #drag-shelf, [data-drop-zone="drag-shelf"], #dynamic-island')) {
        if (typeof addToShelf === 'function') {
          addToShelf({ ...payload, dragMode: isCopyDrag ? 'copy' : 'move' });
        } else {
          store.addToShelf?.(payload);
        }
        if (!isCopyDrag) {
          cutBlockRangeFromDoc(startLine, endLine);
          showToast('已剪切至灵动岛暂存栏（可在工具栏或右键切换默认复制/剪切）', 'success');
        } else {
          showToast('已复制至灵动岛暂存栏', 'success');
        }
        return;
      }
      if (hitEl?.closest('#right-panel, [data-drop-zone="right-ai"]')) {
        store.emit('right:drop-payload', payload);
        return;
      }
      if (ensureMainPaneEl().contains(hitEl) && Number.isFinite(savedLineIdx)) {
        if (isCopyDrag) {
          insertDroppedMarkdown(
            { ...payload, dragMode: 'copy' },
            { lineIdx: savedLineIdx, dropEvent: ev }
          );
        } else if (savedLineIdx < startLine || savedLineIdx > endLine + 1) {
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
    }, 120);

    sess.holdTimer = window.setTimeout(() => {
      if (activeHoldSession !== sess) return;
      if (hasTextSel()) {
        cancelActiveHoldSession();
        return;
      }
      sess.active = true;
      suppressNextBlockClick = true;
      hideFormatBar();
      hideHoverPeekCard();
      window.getSelection()?.removeAllRanges?.();
      blockEl.classList.remove('is-hold-arming');
      blockEl.classList.add('is-dragging-source');
      store.state.activeDragPayload = sess.payload;
      store.beginGlobalDrag?.({
        type: 'lp-block',
        kind: 'lp-block',
        title: firstLinePreview,
        label: firstLinePreview,
        markdown: raw,
        sourceDocPath: state.activeDoc.path,
        startLine,
        endLine,
      });

      const ghost = document.createElement('div');
      ghost.className = 'lp-drag-ghost';
      ghost.style.pointerEvents = 'none';
      ghost.style.transform = `translate3d(${Math.round(startX + 14)}px, ${Math.round(startY + 14)}px, 0)`;
      ghost.textContent = `${state.dragDefaultMode === 'copy' ? '📋 复制' : '✂ 移动'} · ⠿ ${firstLinePreview}`;
      document.body.appendChild(ghost);
      sess.ghostEl = ghost;
      store.emit('drag:active', true);
    }, 500);
  });

  // =========================================================================
  // V5/V6 Capsule / Media Card Right-Click Context Menu (#capsule-context-menu)
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
      // Prevent mousedown inside context menu from stealing editor focus or collapsing text selection
      menu.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
      });
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
    state.editingDraftInsert = null;
    store.state.activeDocumentText = nextFull;
    renderMarkdownMode();
    return true;
  }

  async function handleCapsuleMenuAction(act) {
    const info = capsuleMenuTarget;
    hideCapsuleContextMenu();
    if (!info) return;

    const { el, anchorType, rawToken, fileRef, page, sheet, cell, heading, member, time, label, blockRange } = info;
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

    if (act === 'open-split') {
      await openCapsuleInSplit(el);
      return;
    }

    if (act === 'copy') {
      internalClipboard = rawToken;
      copyInternal(rawToken, '已复制直达语法');
      return;
    }

    if (act === 'cut') {
      if (!isEditableDoc) return;
      internalClipboard = rawToken;
      copyInternal(rawToken, false);
      commitActiveBlock({ reRender: false });
      const ok = replaceOrRemoveTokenInDoc(rawToken, '', blockRange);
      if (ok) {
        showToast('已剪切直达胶囊（Ctrl+Z 可撤回）', 'success');
      } else {
        showToast('未能在原文定位该胶囊语法', 'warning');
      }
      return;
    }

    if (act === 'paste') {
      if (!isEditableDoc) return;
      let clipText = '';
      try {
        clipText = await navigator.clipboard.readText();
      } catch {
        clipText = '';
      }
      const textToPaste = String(clipText || internalClipboard || '').trim();
      if (!textToPaste) {
        showToast('剪贴板为空', 'warning');
        return;
      }
      const insertLine = blockRange && Number.isFinite(blockRange.endLine) ? blockRange.endLine + 1 : getMdLines().length;
      insertDroppedMarkdown({ markdown: textToPaste, label: '剪贴板内容' }, { lineIdx: insertLine });
      return;
    }

    if (act === 'to-shelf') {
      const target = fileRef ? findWorkspaceFile(fileRef) : null;
      const shelfPayload = {
        type: 'capsule',
        label: label || fileRef || '直达胶囊',
        markdown: rawToken,
        path: target?.path || el.dataset.mediaPath || '',
      };
      if (typeof addToShelf === 'function') addToShelf(shelfPayload);
      else store.addToShelf?.(shelfPayload);
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
          state.editingDraftInsert = null;
          store.state.activeDocumentText = doc.content;
          renderMarkdownMode();
          showToast('已展开内容并保留原胶囊（Ctrl+Z 可一键还原）', 'success');
        }
      } catch (err) {
        showToast(getErrorMsg(err, '展开文件内容失败'), 'error');
      }
    }
  }

  function restoreEditorContextSelection(ctxInfo) {
    if (!ctxInfo) return false;
    if (ctxInfo.taEl && Number.isFinite(ctxInfo.taSelStart) && Number.isFinite(ctxInfo.taSelEnd)) {
      ctxInfo.taEl.focus({ preventScroll: true });
      try {
        ctxInfo.taEl.setSelectionRange(ctxInfo.taSelStart, ctxInfo.taSelEnd);
      } catch {
        // ignore
      }
      return true;
    }
    if (ctxInfo.savedRange) {
      try {
        const activeEditor = containerEl.querySelector('.lp-block-wysiwyg');
        if (activeEditor && activeEditor.contains(ctxInfo.savedRange.commonAncestorContainer)) {
          activeEditor.focus({ preventScroll: true });
        }
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(ctxInfo.savedRange);
          return true;
        }
      } catch {
        // ignore detached range
      }
    }
    return false;
  }

  function openEditorUrlCapsuleSheet(ctxInfo) {
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
          const insertLine = Number.isFinite(ctxInfo?.endLine) ? ctxInfo.endLine + 1 : undefined;
          insertDroppedMarkdown(
            { markdown: block, label: '网址胶囊', dragMode: 'copy' },
            Number.isFinite(insertLine) ? { lineIdx: insertLine } : {}
          );
          showToast('已生成网址直达胶囊', 'success');
        };

        submitBtn?.addEventListener('click', handleSubmit);
        urlInp?.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            handleSubmit();
          }
        });
        window.requestAnimationFrame(() => urlInp?.focus());
      },
    });
  }

  async function handleEditorContextMenuAction(act, ctxInfo) {
    hideCapsuleContextMenu();
    const doc = state.activeDoc;
    if (!doc || (doc.type !== 'markdown' && doc.type !== 'text')) return;

    if (act === 'set-drag-cut') {
      setDragDefaultMode('cut');
      return;
    }
    if (act === 'set-drag-copy') {
      setDragDefaultMode('copy');
      return;
    }

    if (act === 'editor-spawn-sticky') {
      store.emit('stickies:spawn-at', { x: ctxInfo?.clientX, y: ctxInfo?.clientY });
      return;
    }
    if (act === 'editor-insert-url') {
      openEditorUrlCapsuleSheet(ctxInfo);
      return;
    }
    if (act === 'editor-ai-summarize') {
      store.emit('ai:summarize-request', {
        filePath: doc.path,
        file_path: doc.path,
        text: doc.content || '',
        autoRun: true,
      });
      return;
    }
    if (act === 'editor-ai-polish') {
      store.emit('ai:polish-request', { filePath: doc.path });
      return;
    }
    if (act === 'editor-toggle-mindmap') {
      store.emit('center:toggle-mindmap', { toggle: true, path: doc.path });
      return;
    }
    if (act === 'editor-semantic-search') {
      store.emit('spotlight:open', { mode: 'semantic' });
      return;
    }

    const { selectedText, blockEl, blockIdx, startLine, endLine, blockRaw } = ctxInfo || {};

    if (act === 'editor-copy') {
      const textToCopy = (selectedText || blockRaw || doc.content || '').trim();
      if (textToCopy) {
        internalClipboard = textToCopy;
        copyInternal(textToCopy, selectedText ? '已复制选中文本' : '已复制当前段落');
      } else {
        showToast('当前无可复制内容', 'info');
      }
      return;
    }

    if (act === 'editor-cut') {
      if (state.mdMode === 'source') {
        const ta = ensureMainPaneEl().querySelector('.md-editor:not([data-role])');
        if (ta) {
          restoreEditorContextSelection(ctxInfo);
          applySourceFormatAction(ta, 'cut');
        }
        return;
      }
      const activeEditor = containerEl.querySelector('.lp-block-wysiwyg');
      if (selectedText && state.mdMode === 'live' && activeEditor && (!blockEl || blockEl.contains(activeEditor))) {
        restoreEditorContextSelection(ctxInfo);
        applyWysiwygBarAction('cut');
        return;
      }
      // If user selected partial text in a rendered (non-editing) block, cut only that selected substring
      if (selectedText && state.mdMode === 'live' && Number.isFinite(startLine) && blockRaw && blockRaw.includes(selectedText)) {
        internalClipboard = selectedText;
        copyInternal(selectedText, '已剪切选中文本（Ctrl+Z 可撤回）');
        commitActiveBlock({ reRender: false });
        pushUndoSnapshot(doc.content, { immediate: true });
        const lines = getMdLines();
        const sIdx = Math.max(0, startLine);
        const eIdx = Math.min(lines.length - 1, Math.max(sIdx, endLine ?? sIdx));
        const slice = lines.slice(sIdx, eIdx + 1).join('\n');
        const nextSlice = slice.replace(selectedText, '');
        const repLines = nextSlice.trim() ? nextSlice.split('\n') : [];
        lines.splice(sIdx, eIdx - sIdx + 1, ...repLines);
        let nextFull = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
        if (nextFull && !nextFull.endsWith('\n')) nextFull += '\n';
        doc.content = nextFull;
        state.dirty = true;
        store.state.activeDocumentText = nextFull;
        renderMarkdownMode();
        return;
      }
      if (Number.isFinite(startLine) && blockRaw) {
        internalClipboard = blockRaw;
        copyInternal(blockRaw, '已剪切当前段落（Ctrl+Z 可撤回）');
        commitActiveBlock({ reRender: false });
        cutBlockRangeFromDoc(startLine, endLine);
      }
      return;
    }

    if (act === 'editor-paste') {
      let clipText = '';
      try {
        clipText = await navigator.clipboard.readText();
      } catch {
        clipText = '';
      }
      const textToPaste = String(clipText || internalClipboard || '');
      if (!textToPaste.trim()) {
        showToast('剪贴板为空', 'warning');
        return;
      }
      const activeEditor = containerEl.querySelector('.lp-block-wysiwyg');
      if (state.mdMode === 'live' && activeEditor && (!blockEl || blockEl.contains(activeEditor))) {
        pushUndoSnapshot(doc.content, { immediate: true });
        restoreEditorContextSelection(ctxInfo);
        activeEditor.focus({ preventScroll: true });
        document.execCommand?.('insertText', false, textToPaste);
        syncWysiwygBlockInput(activeEditor, { immediateUndoAlreadyPushed: true });
        showToast('已粘贴到光标处', 'success');
        return;
      }
      if (state.mdMode === 'source') {
        const ta = ensureMainPaneEl().querySelector('.md-editor:not([data-role])');
        if (ta) {
          restoreEditorContextSelection(ctxInfo);
          applySourceFormatAction(ta, 'paste');
          return;
        }
      }
      commitActiveBlock({ reRender: false });
      const insertAt = Number.isFinite(endLine) ? endLine + 1 : getMdLines().length;
      insertDroppedMarkdown({ markdown: textToPaste.trim(), label: '剪贴板内容' }, { lineIdx: insertAt });
      return;
    }

    if (act === 'editor-duplicate-block') {
      if (!Number.isFinite(startLine) || !blockRaw) return;
      commitActiveBlock({ reRender: false });
      insertDroppedMarkdown({ markdown: blockRaw, label: '克隆段落', dragMode: 'copy' }, { lineIdx: endLine + 1 });
      return;
    }

    if (act === 'editor-to-shelf') {
      const md = (selectedText || blockRaw || '').trim();
      if (!md) return;
      const preview = md.split('\n')[0].replace(/[#>*`\[\]]/g, '').trim().slice(0, 28) || '笔记片段';
      if (typeof addToShelf === 'function') {
        addToShelf({ type: 'lp-block', label: preview, markdown: md, sourceDocPath: doc.path });
      }
      showToast('已放入顶部灵动岛暂存栏', 'success');
      return;
    }

    if (act === 'editor-delete-block') {
      if (!Number.isFinite(startLine)) return;
      commitActiveBlock({ reRender: false });
      cutBlockRangeFromDoc(startLine, endLine);
      showToast('已删除段落（Ctrl+Z 可撤回）', 'success');
      return;
    }

    if (act.startsWith('fmt:')) {
      const fmtKind = act.slice(4);
      if (Number.isFinite(blockIdx) && state.mdMode === 'live' && state.editingBlockIdx !== blockIdx) {
        state.editingBlockIdx = blockIdx;
        state.editingDraftNewBlock = false;
        state.editingDraftInsert = null;
        renderMarkdownMode();
      } else {
        restoreEditorContextSelection(ctxInfo);
      }
      applyWysiwygBarAction(fmtKind);
    }
  }

  containerEl.addEventListener('contextmenu', (e) => {
    const capEl = e.target.closest('.anchor-pill, .media-embed-card');
    if (!capEl) {
      // Check if user right-clicked inside the Live WYSIWYG editor or Source editor
      const isEditableDoc = Boolean(
        state.activeDoc && (state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text')
      );
      const inEditorArea = e.target.closest('.lp-container, .lp-block, .lp-block-wysiwyg, .md-scroll-area, .md-editor:not([data-role])');
      if (!isEditableDoc || !inEditorArea) return;

      e.preventDefault();
      e.stopPropagation();
      hideHoverPeekCard();

      const taEl = e.target.closest('.md-editor:not([data-role])');
      const sel = window.getSelection();
      const taSelStart = taEl ? taEl.selectionStart : null;
      const taSelEnd = taEl ? taEl.selectionEnd : null;
      const selectedText = taEl
        ? taSelStart !== null && taSelEnd !== null && taSelEnd > taSelStart
          ? taEl.value.slice(taSelStart, taSelEnd)
          : ''
        : sel && !sel.isCollapsed
        ? sel.toString()
        : '';
      const savedRange = !taEl && sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
      const blockEl = e.target.closest('.lp-block[data-md-start]');
      const blockIdx = blockEl && blockEl.dataset.blockIdx !== undefined ? Number.parseInt(blockEl.dataset.blockIdx, 10) : null;
      const startLine = blockEl ? Number.parseInt(blockEl.dataset.mdStart, 10) : null;
      const endLine = blockEl ? Number.parseInt(blockEl.dataset.mdEnd ?? blockEl.dataset.mdStart, 10) : null;
      const blockRaw =
        Number.isFinite(startLine) && Number.isFinite(endLine)
          ? getMdLines().slice(startLine, Math.max(startLine, endLine) + 1).join('\n')
          : '';

      const ctxInfo = {
        selectedText,
        savedRange,
        taEl,
        taSelStart,
        taSelEnd,
        blockEl,
        blockIdx,
        startLine,
        endLine,
        blockRaw,
        clientX: e.clientX,
        clientY: e.clientY,
      };
      const isCopyMode = state.dragDefaultMode === 'copy';
      const menu = ensureCapsuleMenuEl();
      menu.innerHTML = `
        <button type="button" class="context-menu-item" data-ed-ctx="editor-copy" role="menuitem">
          <span class="ctx-item-left"><span>📋</span><span>${selectedText ? '复制选中内容 (Ctrl+C)' : '复制当前段落 (Ctrl+C)'}</span></span>
        </button>
        <button type="button" class="context-menu-item" data-ed-ctx="editor-cut" role="menuitem">
          <span class="ctx-item-left"><span>✂</span><span>${selectedText ? '剪切选中内容 (Ctrl+X)' : '剪切当前段落 (Ctrl+X)'}</span></span>
        </button>
        <button type="button" class="context-menu-item" data-ed-ctx="editor-paste" role="menuitem">
          <span class="ctx-item-left"><span>📥</span><span>粘贴到此处 (Ctrl+V)</span></span>
        </button>
        ${
          Number.isFinite(startLine)
            ? `
              <button type="button" class="context-menu-item" data-ed-ctx="editor-duplicate-block" role="menuitem">
                <span class="ctx-item-left"><span>📑</span><span>克隆当前段落到下方</span></span>
              </button>
            `
            : ''
        }
        <button type="button" class="context-menu-item" data-ed-ctx="editor-to-shelf" role="menuitem">
          <span class="ctx-item-left"><span>🏝</span><span>放入顶部灵动岛暂存栏</span></span>
        </button>
        <div class="context-menu-sep" role="separator"></div>
        <div style="display:flex;align-items:center;gap:4px;padding:4px 8px;">
          <button type="button" class="pill-btn pill-btn-sm" data-ed-ctx="fmt:h1" title="一级标题" style="height:24px;padding:0 7px;font-size:11px;">H1</button>
          <button type="button" class="pill-btn pill-btn-sm" data-ed-ctx="fmt:h2" title="二级标题" style="height:24px;padding:0 7px;font-size:11px;">H2</button>
          <button type="button" class="pill-btn pill-btn-sm" data-ed-ctx="fmt:h3" title="三级标题" style="height:24px;padding:0 7px;font-size:11px;">H3</button>
          <button type="button" class="pill-btn pill-btn-sm" data-ed-ctx="fmt:bold" title="加粗" style="height:24px;padding:0 7px;font-size:11px;font-weight:700;">B</button>
          <button type="button" class="pill-btn pill-btn-sm" data-ed-ctx="fmt:mark" title="荧光高亮" style="height:24px;padding:0 7px;font-size:11px;">高亮</button>
          <button type="button" class="pill-btn pill-btn-sm" data-ed-ctx="fmt:todo" title="待办清单" style="height:24px;padding:0 7px;font-size:11px;">待办</button>
        </div>
        <div class="context-menu-sep" role="separator"></div>
        <button type="button" class="context-menu-item ${!isCopyMode ? 'is-active' : ''}" data-ed-ctx="set-drag-cut" role="menuitem">
          <span class="ctx-item-left"><span>${!isCopyMode ? '✓' : '✂'}</span><span>拖动默认：剪切移动 (Ctrl 为复制)</span></span>
        </button>
        <button type="button" class="context-menu-item ${isCopyMode ? 'is-active' : ''}" data-ed-ctx="set-drag-copy" role="menuitem">
          <span class="ctx-item-left"><span>${isCopyMode ? '✓' : '📋'}</span><span>拖动默认：复制插入 (Shift 为剪切)</span></span>
        </button>
        ${
          Number.isFinite(startLine)
            ? `
              <button type="button" class="context-menu-item" data-ed-ctx="editor-delete-block" role="menuitem" style="color:var(--danger);">
                <span class="ctx-item-left"><span>🗑</span><span>删除当前段落</span></span>
              </button>
            `
            : ''
        }
        <div class="context-menu-sep" role="separator"></div>
        <button type="button" class="context-menu-item" data-ed-ctx="editor-spawn-sticky" role="menuitem">
          <span class="ctx-item-left"><span>📌</span><span>在此处召唤闪念卡 (Alt+N)</span></span>
        </button>
        <button type="button" class="context-menu-item" data-ed-ctx="editor-insert-url" role="menuitem">
          <span class="ctx-item-left"><span>🔗</span><span>插入网址直达胶囊</span></span>
        </button>
        <button type="button" class="context-menu-item" data-ed-ctx="editor-ai-summarize" role="menuitem">
          <span class="ctx-item-left"><span>✨</span><span>AI 总结当前文档</span></span>
        </button>
        <button type="button" class="context-menu-item" data-ed-ctx="editor-ai-polish" role="menuitem">
          <span class="ctx-item-left"><span>🪄</span><span>AI 润色当前笔记</span></span>
        </button>
        ${
          state.activeDoc?.type === 'markdown'
            ? `
              <button type="button" class="context-menu-item" data-ed-ctx="editor-toggle-mindmap" role="menuitem">
                <span class="ctx-item-left"><span>🧠</span><span>切换脑图视图</span></span>
              </button>
            `
            : ''
        }
        <button type="button" class="context-menu-item" data-ed-ctx="editor-semantic-search" role="menuitem">
          <span class="ctx-item-left"><span>🔍</span><span>语义描述检索 (Ctrl+K)</span></span>
        </button>
      `;

      menu.querySelectorAll('[data-ed-ctx]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          handleEditorContextMenuAction(btn.dataset.edCtx, ctxInfo);
        });
      });

      menu.hidden = false;
      menu.classList.remove('hidden');
      menu.classList.add('is-open');
      const rect = menu.getBoundingClientRect();
      const maxX = Math.max(8, window.innerWidth - (rect.width || 240) - 10);
      const maxY = Math.max(8, window.innerHeight - (rect.height || 300) - 10);
      menu.style.left = `${Math.min(maxX, Math.max(8, e.clientX))}px`;
      menu.style.top = `${Math.min(maxY, Math.max(8, e.clientY))}px`;
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    hideHoverPeekCard();

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
    const canSplit = anchorType !== 'app' && anchorType !== 'url' && (Boolean(fileRef) || Boolean(ds.anchorHeading));

    capsuleMenuTarget = {
      el: capEl,
      anchorType,
      rawToken,
      fileRef,
      page: ds.anchorPage || '',
      sheet: ds.anchorSheet || '',
      cell: ds.anchorCell || '',
      heading: ds.anchorHeading || '',
      member: ds.anchorMember || '',
      time: ds.anchorTime || ds.mediaTime || '',
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
      ${
        canSplit
          ? `
            <button type="button" class="context-menu-item" data-cap-act="open-split" role="menuitem">
              <span class="ctx-item-left"><span>◫</span><span>在右侧分屏打开</span></span>
            </button>
          `
          : ''
      }
      <button type="button" class="context-menu-item" data-cap-act="to-shelf" role="menuitem">
        <span class="ctx-item-left"><span>📥</span><span>放入拖拽暂存栏</span></span>
      </button>
      <div class="context-menu-sep" role="separator"></div>
      ${
        isEditableDoc
          ? `
            <button type="button" class="context-menu-item" data-cap-act="cut" role="menuitem">
              <span class="ctx-item-left"><span>✂</span><span>剪切</span></span>
            </button>
          `
          : ''
      }
      <button type="button" class="context-menu-item" data-cap-act="copy" role="menuitem">
        <span class="ctx-item-left"><span>📋</span><span>复制</span></span>
      </button>
      ${
        isEditableDoc
          ? `
            <button type="button" class="context-menu-item" data-cap-act="paste" role="menuitem">
              <span class="ctx-item-left"><span>📥</span><span>粘贴到此处</span></span>
            </button>
            <div class="context-menu-sep" role="separator"></div>
            <button type="button" class="context-menu-item ${state.dragDefaultMode !== 'copy' ? 'is-active' : ''}" data-cap-act="set-drag-cut" role="menuitem">
              <span class="ctx-item-left"><span>${state.dragDefaultMode !== 'copy' ? '✓' : '✂'}</span><span>拖动默认：剪切移动</span></span>
            </button>
            <button type="button" class="context-menu-item ${state.dragDefaultMode === 'copy' ? 'is-active' : ''}" data-cap-act="set-drag-copy" role="menuitem">
              <span class="ctx-item-left"><span>${state.dragDefaultMode === 'copy' ? '✓' : '📋'}</span><span>拖动默认：复制插入</span></span>
            </button>
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
        const act = btn.dataset.capAct;
        if (act === 'set-drag-cut') {
          hideCapsuleContextMenu();
          setDragDefaultMode('cut');
          return;
        }
        if (act === 'set-drag-copy') {
          hideCapsuleContextMenu();
          setDragDefaultMode('copy');
          return;
        }
        handleCapsuleMenuAction(act);
      });
    });

    menu.hidden = false;
    menu.classList.remove('hidden');
    menu.classList.add('is-open');
    const rect = menu.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - (rect.width || 220) - 10);
    const maxY = Math.max(8, window.innerHeight - (rect.height || 240) - 10);
    menu.style.left = `${Math.min(maxX, Math.max(8, e.clientX))}px`;
    menu.style.top = `${Math.min(maxY, Math.max(8, e.clientY))}px`;
  });

  document.addEventListener('mousedown', (e) => {
    if (activeFormatBar && !activeFormatBar.contains(e.target) && !e.target.closest('.lp-container, .md-preview')) {
      hideFormatBar();
    }
    const slashEl = document.getElementById('slash-command-menu');
    if (slashEl && !slashEl.hidden && !slashEl.contains(e.target)) {
      closeSlashMenu();
    }
    // Commit active block editor when clicking outside any .lp-block (and not clicking find bar, format bar, slash menu, or add-block zone)
    if (
      state.activeDoc &&
      (state.activeDoc.type === 'markdown' || state.activeDoc.type === 'text') &&
      state.mdMode === 'live' &&
      (state.editingBlockIdx !== null || state.editingDraftNewBlock || state.editingDraftInsert !== null)
    ) {
      if (
        !e.target.closest('.lp-block') &&
        !e.target.closest('.lp-add-block-zone') &&
        !e.target.closest('[data-role="doc-find-bar"]') &&
        !e.target.closest('[data-role="wysiwyg-format-bar"]') &&
        !e.target.closest('#slash-command-menu') &&
        !e.target.closest('#capsule-context-menu') &&
        !e.target.closest('[data-md-mode]') &&
        !e.target.closest('[data-action="md-undo"]') &&
        !e.target.closest('[data-action="md-redo"]')
      ) {
        commitActiveBlock({ reRender: true });
      }
    }
  });

  // =========================================================================
  // Innovation A: Slash Command Menu (/ -> #slash-command-menu)
  // =========================================================================
  const SLASH_COMMANDS = [
    { id: 'h1', icon: 'H1', label: '一级标题', hint: '# ', keywords: 'h1 heading title yijibiaoti 一级标题' },
    { id: 'h2', icon: 'H2', label: '二级标题', hint: '## ', keywords: 'h2 heading erjibiaoti 二级标题' },
    { id: 'h3', icon: 'H3', label: '三级标题', hint: '### ', keywords: 'h3 heading sanjibiaoti 三级标题' },
    { id: 'todo', icon: '☑', label: '待办清单', hint: '- [ ]', keywords: 'todo task check daiban 待办清单' },
    { id: 'quote', icon: '”', label: '引用块', hint: '> ', keywords: 'quote blockquote yinyong 引用块' },
    { id: 'tip', icon: '💡', label: '提示卡片', hint: 'TIP', keywords: 'tip callout note tishi 提示卡片' },
    { id: 'warn', icon: '⚠️', label: '易错提醒', hint: 'WARN', keywords: 'warn warning callout yicuo 易错提醒' },
    { id: 'codeblock', icon: '💻', label: '代码块', hint: '```', keywords: 'code codeblock daima 代码块' },
    { id: 'hr', icon: '—', label: '分割线', hint: '---', keywords: 'hr divider line fengexian 分割线' },
    { id: 'file', icon: '🔗', label: '插入文件直达胶囊', hint: '[[文件]]', keywords: 'file link capsule anchor wenjian 插入文件直达胶囊' },
    { id: 'url', icon: '🌐', label: '插入网址胶囊', hint: '[[url:]]', keywords: 'url web link wangzhi 插入网址胶囊' },
    { id: 'app', icon: '🚀', label: '插入软件直达', hint: '[[app:]]', keywords: 'app software launcher ruanjian 插入软件直达' },
  ];

  let slashState = {
    open: false,
    mode: 'commands', // 'commands' | 'file' | 'url' | 'app'
    query: '',
    activeIdx: 0,
    sourceKind: 'wysiwyg', // 'wysiwyg' | 'source'
    editorEl: null,
    textNode: null,
    startOffset: 0,
    endOffset: 0,
    taStart: 0,
    taEnd: 0,
    anchorRect: null,
  };

  function getSlashMenuEl() {
    let menu = document.getElementById('slash-command-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'slash-command-menu';
      menu.className = 'slash-command-menu';
      menu.setAttribute('role', 'listbox');
      menu.hidden = true;
      document.body.appendChild(menu);
    }
    return menu;
  }

  function closeSlashMenu() {
    slashState.open = false;
    slashState.mode = 'commands';
    slashState.textNode = null;
    slashState.editorEl = null;
    const menu = document.getElementById('slash-command-menu');
    if (menu) {
      menu.hidden = true;
      menu.innerHTML = '';
    }
  }

  function positionSlashMenu(menu, rect) {
    const r = rect || { left: 160, bottom: 180, top: 160 };
    const mRect = menu.getBoundingClientRect();
    const mw = mRect.width || 248;
    const mh = mRect.height || 260;
    const left = Math.min(Math.max(10, r.left), Math.max(10, window.innerWidth - mw - 12));
    const spaceBelow = window.innerHeight - r.bottom;
    const top = spaceBelow >= Math.min(mh, 200) || r.top < mh + 12
      ? Math.min(window.innerHeight - mh - 10, Math.max(10, r.bottom + 6))
      : Math.max(10, r.top - mh - 6);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function getFilteredSlashCommands() {
    const q = slashState.query.trim().toLowerCase();
    if (!q) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((c) =>
      c.label.toLowerCase().includes(q) || c.keywords.toLowerCase().includes(q) || c.id.includes(q)
    );
  }

  function removeSlashTriggerText() {
    if (slashState.sourceKind === 'source') {
      const ta = slashState.editorEl;
      if (!ta) return null;
      const val = ta.value;
      const s = Math.max(0, Math.min(val.length, slashState.taStart));
      const e = Math.max(s, Math.min(val.length, slashState.taEnd));
      ta.value = `${val.slice(0, s)}${val.slice(e)}`;
      ta.focus();
      ta.setSelectionRange(s, s);
      return { kind: 'source', ta, pos: s };
    }

    const editorEl = slashState.editorEl;
    const tNode = slashState.textNode;
    if (!editorEl) return null;
    if (tNode && editorEl.contains(tNode) && tNode.nodeType === 3) {
      const len = (tNode.nodeValue || '').length;
      const s = Math.max(0, Math.min(len, slashState.startOffset));
      const e = Math.max(s, Math.min(len, slashState.endOffset));
      const range = document.createRange();
      range.setStart(tNode, s);
      range.setEnd(tNode, e);
      range.deleteContents();
      const sel = window.getSelection();
      if (sel) {
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (!tNode.nodeValue && tNode.parentElement && tNode.parentElement.childNodes.length === 0) {
        tNode.parentElement.appendChild(document.createElement('br'));
      }
    }
    return { kind: 'wysiwyg', editorEl };
  }

  function insertTokenAtActiveSlashTarget(tokenMd) {
    const cleanToken = String(tokenMd || '').trim();
    if (!cleanToken) return;
    const doc = state.activeDoc;
    if (!doc) return;

    const targetInfo = removeSlashTriggerText();
    closeSlashMenu();
    if (!targetInfo) return;

    if (targetInfo.kind === 'source') {
      const { ta, pos } = targetInfo;
      pushUndoSnapshot(doc.content, { immediate: true });
      const val = ta.value;
      const nextVal = `${val.slice(0, pos)}${cleanToken} ${val.slice(pos)}`;
      ta.value = nextVal;
      ta.setSelectionRange(pos + cleanToken.length + 1, pos + cleanToken.length + 1);
      doc.content = nextVal;
      state.dirty = true;
      store.state.activeDocumentText = nextVal;
      updateMdDirtyIndicators();
      return;
    }

    const { editorEl } = targetInfo;
    pushUndoSnapshot(doc.content, { immediate: true });
    editorEl.focus({ preventScroll: true });

    const tpl = document.createElement('template');
    tpl.innerHTML = markdownToWysiwygBlockHtml(cleanToken);
    const pillNode = tpl.content.querySelector('.anchor-pill, .media-embed-card');

    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && editorEl.contains(sel.getRangeAt(0).startContainer)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      if (pillNode) {
        const spaceNode = document.createTextNode(' ');
        range.insertNode(spaceNode);
        range.insertNode(pillNode);
        const afterRange = document.createRange();
        afterRange.setStartAfter(spaceNode);
        afterRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(afterRange);
      } else {
        const txtNode = document.createTextNode(`${cleanToken} `);
        range.insertNode(txtNode);
        range.setStartAfter(txtNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else if (pillNode) {
      const p = editorEl.querySelector('p') || editorEl;
      p.appendChild(pillNode);
      p.appendChild(document.createTextNode(' '));
      placeCaretInsideWysiwyg(editorEl, 'end');
    }
    syncWysiwygBlockInput(editorEl, { immediateUndoAlreadyPushed: true });
  }

  function applySlashFormatCommand(cmdId) {
    const doc = state.activeDoc;
    if (!doc) return;
    const targetInfo = removeSlashTriggerText();
    closeSlashMenu();
    if (!targetInfo) return;

    if (targetInfo.kind === 'source') {
      const { ta, pos } = targetInfo;
      pushUndoSnapshot(doc.content, { immediate: true });
      const insertMap = {
        h1: '# ',
        h2: '## ',
        h3: '### ',
        todo: '- [ ] ',
        quote: '> ',
        tip: '> 💡 **提示**：',
        warn: '> ⚠️ **易错提醒**：',
        codeblock: '```\n\n```',
        hr: '\n---\n',
      };
      const snippet = insertMap[cmdId] || '';
      const val = ta.value;
      const nextVal = `${val.slice(0, pos)}${snippet}${val.slice(pos)}`;
      ta.value = nextVal;
      const nextPos = cmdId === 'codeblock' ? pos + 4 : pos + snippet.length;
      ta.setSelectionRange(nextPos, nextPos);
      doc.content = nextVal;
      state.dirty = true;
      store.state.activeDocumentText = nextVal;
      updateMdDirtyIndicators();
      return;
    }

    const { editorEl } = targetInfo;
    pushUndoSnapshot(doc.content, { immediate: true });
    editorEl.focus({ preventScroll: true });
    execWysiwygFormat(cmdId, editorEl);
    syncWysiwygBlockInput(editorEl, { immediateUndoAlreadyPushed: true });
  }

  async function renderSlashSubPicker(mode) {
    slashState.mode = mode;
    const menu = getSlashMenuEl();
    menu.hidden = false;

    if (mode === 'file') {
      let items = Array.isArray(store.state.files?.items) ? store.state.files.items : [];
      if (items.length === 0) {
        menu.innerHTML = `<div style="padding:10px;font-size:12px;color:var(--text-secondary);">正在加载工作区文件…</div>`;
        positionSlashMenu(menu, slashState.anchorRect);
        try {
          const filesData = await api.get('/api/files/list');
          if (filesData) {
            store.setState({ files: filesData });
            items = filesData.items || [];
          }
        } catch {
          // ignore
        }
      }
      if (!slashState.open || slashState.mode !== 'file') return;

      menu.innerHTML = `
        <div style="display:flex;align-items:center;gap:4px;padding:3px 4px 5px;border-bottom:1px solid var(--border-hairline);margin-bottom:4px;">
          <button type="button" class="pill-btn pill-btn-ghost pill-btn-sm" data-slash-back="1" style="height:24px;padding:0 6px;font-size:11px;">←</button>
          <input type="text" class="apple-input" data-slash-sub-filter="1" placeholder="筛选工作区文件…" style="height:26px;padding:2px 8px;font-size:12px;flex:1;min-width:0;" />
        </div>
        <div data-slash-sub-list="1" style="max-height:210px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;"></div>
      `;

      const listEl = menu.querySelector('[data-slash-sub-list]');
      const filterInput = menu.querySelector('[data-slash-sub-filter]');
      let subIdx = 0;

      const renderList = () => {
        const q = (filterInput?.value || '').trim().toLowerCase();
        const filtered = (q ? items.filter((f) => String(f.name || f.path || '').toLowerCase().includes(q)) : items).slice(0, 14);
        if (filtered.length === 0) {
          listEl.innerHTML = `<div style="padding:10px;font-size:12px;color:var(--text-tertiary);text-align:center;">未匹配到工作区文件</div>`;
          return;
        }
        subIdx = Math.max(0, Math.min(subIdx, filtered.length - 1));
        listEl.innerHTML = filtered
          .map((f, idx) => `
            <button type="button" class="slash-cmd-item ${idx === subIdx ? 'is-active' : ''}" data-slash-file="${escapeHtml(f.name)}">
              <span class="slash-cmd-main">
                <span class="slash-cmd-icon">${icon(docIconName('', f.ext), 12)}</span>
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(f.name)}</span>
              </span>
              <span class="slash-cmd-hint">${escapeHtml(f.ext || '')}</span>
            </button>
          `)
          .join('');
      };

      renderList();
      positionSlashMenu(menu, slashState.anchorRect);
      window.requestAnimationFrame(() => filterInput?.focus());

      menu.querySelector('[data-slash-back]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        renderSlashCommandsMenu();
      });
      filterInput?.addEventListener('input', () => {
        subIdx = 0;
        renderList();
      });
      filterInput?.addEventListener('keydown', (ev) => {
        const rows = Array.from(listEl.querySelectorAll('[data-slash-file]'));
        if (ev.key === 'ArrowDown' && rows.length > 0) {
          ev.preventDefault();
          subIdx = (subIdx + 1) % rows.length;
          renderList();
        } else if (ev.key === 'ArrowUp' && rows.length > 0) {
          ev.preventDefault();
          subIdx = (subIdx - 1 + rows.length) % rows.length;
          renderList();
        } else if (ev.key === 'Enter' && rows[subIdx]) {
          ev.preventDefault();
          insertTokenAtActiveSlashTarget(`[[${rows[subIdx].dataset.slashFile}]]`);
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          const ed = slashState.editorEl;
          closeSlashMenu();
          ed?.focus?.();
        }
      });
      listEl.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-slash-file]');
        if (!btn) return;
        ev.stopPropagation();
        insertTokenAtActiveSlashTarget(`[[${btn.dataset.slashFile}]]`);
      });
      return;
    }

    if (mode === 'url') {
      menu.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:3px 4px 6px;border-bottom:1px solid var(--border-hairline);margin-bottom:6px;">
          <span style="font-size:12px;font-weight:600;">🌐 插入网址胶囊</span>
          <button type="button" class="pill-btn pill-btn-ghost pill-btn-sm" data-slash-back="1" style="height:22px;padding:0 6px;font-size:11px;">返回</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;padding:2px 4px 4px;">
          <input type="text" class="apple-input" data-slash-url-title="1" placeholder="标题（可选）" style="height:27px;padding:3px 8px;font-size:12px;" />
          <input type="url" class="apple-input" data-slash-url-href="1" placeholder="https://..." style="height:27px;padding:3px 8px;font-size:12px;" />
          <button type="button" class="pill-btn pill-btn-primary pill-btn-sm" data-slash-url-submit="1" style="justify-content:center;">插入网址胶囊</button>
        </div>
      `;
      positionSlashMenu(menu, slashState.anchorRect);
      const titleInp = menu.querySelector('[data-slash-url-title]');
      const hrefInp = menu.querySelector('[data-slash-url-href]');
      const submitBtn = menu.querySelector('[data-slash-url-submit]');
      window.requestAnimationFrame(() => hrefInp?.focus());

      const doInsertUrl = () => {
        const url = (hrefInp?.value || '').trim();
        if (!url) {
          showToast('请输入网址 URL', 'warning');
          hrefInp?.focus();
          return;
        }
        const title = (titleInp?.value || '').trim();
        const tok = title ? `[[url:${title}|${url}]]` : `[[url:${url}]]`;
        insertTokenAtActiveSlashTarget(tok);
      };

      menu.querySelector('[data-slash-back]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        renderSlashCommandsMenu();
      });
      submitBtn?.addEventListener('click', doInsertUrl);
      menu.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          doInsertUrl();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          const ed = slashState.editorEl;
          closeSlashMenu();
          ed?.focus?.();
        }
      });
      return;
    }

    if (mode === 'app') {
      let apps = Array.isArray(store.state.apps) ? store.state.apps : [];
      if (apps.length === 0) {
        menu.innerHTML = `<div style="padding:10px;font-size:12px;color:var(--text-secondary);">正在读取已登记软件…</div>`;
        positionSlashMenu(menu, slashState.anchorRect);
        try {
          const res = await api.get('/api/apps');
          apps = Array.isArray(res) ? res : (res?.apps || []);
          if (apps.length > 0) store.setState({ apps });
        } catch {
          // ignore
        }
      }
      if (!slashState.open || slashState.mode !== 'app') return;

      menu.innerHTML = `
        <div style="display:flex;align-items:center;gap:4px;padding:3px 4px 5px;border-bottom:1px solid var(--border-hairline);margin-bottom:4px;">
          <button type="button" class="pill-btn pill-btn-ghost pill-btn-sm" data-slash-back="1" style="height:24px;padding:0 6px;font-size:11px;">←</button>
          <input type="text" class="apple-input" data-slash-app-filter="1" placeholder="输入或选择软件名…" style="height:26px;padding:2px 8px;font-size:12px;flex:1;min-width:0;" />
        </div>
        <div data-slash-app-list="1" style="max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;"></div>
      `;
      const listEl = menu.querySelector('[data-slash-app-list]');
      const filterInp = menu.querySelector('[data-slash-app-filter]');

      const renderApps = () => {
        const q = (filterInp?.value || '').trim().toLowerCase();
        const filtered = (q ? apps.filter((a) => String(a.name || '').toLowerCase().includes(q)) : apps).slice(0, 12);
        const rowsHtml = filtered
          .map((a) => `
            <button type="button" class="slash-cmd-item" data-slash-app="${escapeHtml(a.name)}">
              <span class="slash-cmd-main">
                <span class="slash-cmd-icon">🚀</span>
                <span>${escapeHtml(a.name)}</span>
              </span>
              <span class="slash-cmd-hint">app</span>
            </button>
          `)
          .join('');
        const customHtml = q && filtered.length === 0
          ? `<button type="button" class="slash-cmd-item is-active" data-slash-app="${escapeHtml(filterInp.value.trim())}">
              <span class="slash-cmd-main"><span class="slash-cmd-icon">🚀</span><span>插入 [[app:${escapeHtml(filterInp.value.trim())}]]</span></span>
             </button>`
          : '';
        listEl.innerHTML = rowsHtml || customHtml || `<div style="padding:10px;font-size:12px;color:var(--text-tertiary);text-align:center;">输入软件名称后按 Enter</div>`;
      };

      renderApps();
      positionSlashMenu(menu, slashState.anchorRect);
      window.requestAnimationFrame(() => filterInp?.focus());

      menu.querySelector('[data-slash-back]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        renderSlashCommandsMenu();
      });
      filterInp?.addEventListener('input', renderApps);
      filterInp?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const first = listEl.querySelector('[data-slash-app]');
          const appName = first?.dataset.slashApp || filterInp.value.trim();
          if (appName) insertTokenAtActiveSlashTarget(`[[app:${appName}]]`);
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          const ed = slashState.editorEl;
          closeSlashMenu();
          ed?.focus?.();
        }
      });
      listEl.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-slash-app]');
        if (!btn) return;
        ev.stopPropagation();
        insertTokenAtActiveSlashTarget(`[[app:${btn.dataset.slashApp}]]`);
      });
    }
  }

  function executeSlashCommand(cmdId) {
    if (cmdId === 'file' || cmdId === 'url' || cmdId === 'app') {
      renderSlashSubPicker(cmdId);
      return;
    }
    applySlashFormatCommand(cmdId);
  }

  function renderSlashCommandsMenu() {
    slashState.mode = 'commands';
    const menu = getSlashMenuEl();
    const items = getFilteredSlashCommands();
    if (items.length === 0) {
      closeSlashMenu();
      return;
    }
    slashState.activeIdx = Math.max(0, Math.min(slashState.activeIdx, items.length - 1));
    menu.innerHTML = items
      .map((cmd, idx) => `
        <button type="button" class="slash-cmd-item ${idx === slashState.activeIdx ? 'is-active' : ''}" data-slash-cmd="${cmd.id}" role="option" aria-selected="${idx === slashState.activeIdx}">
          <span class="slash-cmd-main">
            <span class="slash-cmd-icon">${cmd.icon}</span>
            <span>${escapeHtml(cmd.label)}</span>
          </span>
          <span class="slash-cmd-hint">${escapeHtml(cmd.hint)}</span>
        </button>
      `)
      .join('');

    menu.onmousedown = (ev) => {
      if (ev.target.closest('[data-slash-cmd]')) {
        ev.preventDefault();
      }
    };
    menu.onclick = (ev) => {
      const btn = ev.target.closest('[data-slash-cmd]');
      if (!btn) return;
      ev.stopPropagation();
      executeSlashCommand(btn.dataset.slashCmd);
    };

    menu.hidden = false;
    positionSlashMenu(menu, slashState.anchorRect);
  }

  function maybeTriggerSlashMenuFromWysiwyg(editorEl) {
    if (!editorEl || state.mdMode !== 'live') {
      closeSlashMenu();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
      closeSlashMenu();
      return;
    }
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (!editorEl.contains(node) || node.nodeType !== 3) {
      closeSlashMenu();
      return;
    }
    const parentTag = node.parentElement?.tagName;
    if (parentTag === 'CODE' || node.parentElement?.closest('pre')) {
      closeSlashMenu();
      return;
    }
    const before = (node.nodeValue || '').slice(0, range.startOffset);
    const m = before.match(/(?:^|\s)\/([^\s/]*)$/);
    if (!m) {
      closeSlashMenu();
      return;
    }
    const query = m[1] || '';
    const slashOffset = range.startOffset - query.length - 1;
    // If '/' is at offset 0 of text node, ensure previous sibling in block isn't plain inline text without space
    if (slashOffset === 0 && node.previousSibling && node.previousSibling.nodeType === 3 && !/\s$/.test(node.previousSibling.nodeValue || '')) {
      closeSlashMenu();
      return;
    }

    let rect = range.getBoundingClientRect();
    if (!rect || (rect.left === 0 && rect.top === 0 && rect.bottom === 0)) {
      rect = (node.parentElement || editorEl).getBoundingClientRect();
    }

    slashState = {
      open: true,
      mode: 'commands',
      query,
      activeIdx: 0,
      sourceKind: 'wysiwyg',
      editorEl,
      textNode: node,
      startOffset: slashOffset,
      endOffset: range.startOffset,
      taStart: 0,
      taEnd: 0,
      anchorRect: rect,
    };
    renderSlashCommandsMenu();
  }

  function maybeTriggerSlashMenuFromSource(ta) {
    if (!ta || state.mdMode !== 'source') {
      closeSlashMenu();
      return;
    }
    const pos = ta.selectionStart ?? 0;
    const beforeAll = ta.value.slice(0, pos);
    const lineStart = beforeAll.lastIndexOf('\n') + 1;
    const lineBefore = beforeAll.slice(lineStart);
    const m = lineBefore.match(/(?:^|\s)\/([^\s/]*)$/);
    if (!m) {
      closeSlashMenu();
      return;
    }
    const query = m[1] || '';
    const taRect = ta.getBoundingClientRect();
    const cs = window.getComputedStyle(ta);
    const lh = Number.parseFloat(cs.lineHeight) || (Number.parseFloat(cs.fontSize) || 15) * 1.7;
    const lineNum = beforeAll.split('\n').length - 1;
    const approxTop = Math.min(taRect.bottom - 20, Math.max(taRect.top + 16, taRect.top + 18 + lineNum * lh - ta.scrollTop));

    slashState = {
      open: true,
      mode: 'commands',
      query,
      activeIdx: 0,
      sourceKind: 'source',
      editorEl: ta,
      textNode: null,
      startOffset: 0,
      endOffset: 0,
      taStart: pos - query.length - 1,
      taEnd: pos,
      anchorRect: { left: taRect.left + 32, top: approxTop, bottom: approxTop + lh },
    };
    renderSlashCommandsMenu();
  }

  // =========================================================================
  // Innovation B: Capsule Hover Peek Card (400ms -> #hover-peek-card)
  // =========================================================================
  const hoverPeekCache = new Map(); // key -> { ts, title, bodyHtml, targetItem, payload }
  const HOVER_PEEK_TTL_MS = 30000;
  let hoverPeekOpenTimer = 0;
  let hoverPeekCloseTimer = 0;
  let hoverPeekActivePill = null;
  let hoverPeekBound = false;

  function clearHoverPeekTimers() {
    if (hoverPeekOpenTimer) {
      window.clearTimeout(hoverPeekOpenTimer);
      hoverPeekOpenTimer = 0;
    }
    if (hoverPeekCloseTimer) {
      window.clearTimeout(hoverPeekCloseTimer);
      hoverPeekCloseTimer = 0;
    }
  }

  function hideHoverPeekCard() {
    clearHoverPeekTimers();
    hoverPeekActivePill = null;
    const card = document.getElementById('hover-peek-card');
    if (card) {
      card.hidden = true;
      card.innerHTML = '';
    }
  }

  function scheduleHoverPeekClose() {
    if (hoverPeekCloseTimer) window.clearTimeout(hoverPeekCloseTimer);
    hoverPeekCloseTimer = window.setTimeout(() => {
      hoverPeekCloseTimer = 0;
      hideHoverPeekCard();
    }, 180);
  }

  function getHoverPeekCardEl() {
    let card = document.getElementById('hover-peek-card');
    if (!card) {
      card = document.createElement('div');
      card.id = 'hover-peek-card';
      card.className = 'hover-peek-card';
      card.hidden = true;
      document.body.appendChild(card);
    }
    if (!hoverPeekBound) {
      hoverPeekBound = true;
      card.addEventListener('mouseenter', () => {
        if (hoverPeekCloseTimer) {
          window.clearTimeout(hoverPeekCloseTimer);
          hoverPeekCloseTimer = 0;
        }
      });
      card.addEventListener('mouseleave', (ev) => {
        if (hoverPeekActivePill && ev.relatedTarget && hoverPeekActivePill.contains(ev.relatedTarget)) {
          return;
        }
        scheduleHoverPeekClose();
      });
    }
    return card;
  }

  function extractAnchorPayloadFromPill(pill) {
    const ds = pill?.dataset || {};
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
    return {
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
    };
  }

  function positionHoverPeekCard(card, anchorRect) {
    const rect = card.getBoundingClientRect();
    const cw = rect.width || 320;
    const ch = rect.height || 200;
    const left = Math.min(Math.max(12, anchorRect.left), Math.max(12, window.innerWidth - cw - 12));
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const top = spaceBelow >= ch + 14 || anchorRect.top < ch + 14
      ? Math.min(window.innerHeight - ch - 12, anchorRect.bottom + 8)
      : Math.max(12, anchorRect.top - ch - 8);
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  async function buildHoverPeekData(payload) {
    const cacheKey = JSON.stringify([
      payload.type,
      payload.file,
      payload.page,
      payload.sheet,
      payload.cell,
      payload.member,
      payload.heading,
      payload.app,
      payload.url,
    ]);
    const cached = hoverPeekCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < HOVER_PEEK_TTL_MS) {
      return cached;
    }

    let result = {
      ts: Date.now(),
      title: payload.file || payload.app || payload.url || payload.heading || '链接速览',
      iconName: 'file-text',
      bodyHtml: '',
      targetItem: null,
      canSplit: false,
      payload,
    };

    if (payload.type === 'app' || (!payload.file && payload.app)) {
      result.title = `软件直达 · ${payload.app}`;
      result.iconName = 'rocket';
      result.bodyHtml = `<div style="color:var(--text-secondary);">点击「↗ 直达」立即启动本地应用 <strong>${escapeHtml(payload.app)}</strong></div>`;
      hoverPeekCache.set(cacheKey, result);
      return result;
    }

    if (payload.type === 'url' || payload.url) {
      result.title = '外部网页链接';
      result.iconName = 'globe';
      result.bodyHtml = `<div style="font-family:var(--font-mono);font-size:11.5px;word-break:break-all;color:var(--accent);">${escapeHtml(payload.url)}</div>`;
      hoverPeekCache.set(cacheKey, result);
      return result;
    }

    if (payload.type === 'heading' && !payload.file && state.activeDoc) {
      result.title = `${state.activeDoc.name} # ${payload.heading}`;
      result.iconName = 'file-text';
      result.targetItem = { path: state.activeDoc.path, name: state.activeDoc.name, ext: state.activeDoc.ext };
      result.canSplit = true;
      const lines = String(state.activeDoc.content || '').split('\n');
      const hNorm = normalizeHeadingKey(payload.heading);
      const hIdx = lines.findIndex((ln) => /^\s{0,3}#{1,6}\s+/.test(ln) && normalizeHeadingKey(ln).includes(hNorm));
      const snippet = (hIdx >= 0 ? lines.slice(hIdx, hIdx + 10) : lines.slice(0, 10)).join('\n').slice(0, 420);
      result.bodyHtml = `<pre style="margin:0;white-space:pre-wrap;color:var(--text-secondary);">${escapeHtml(snippet || '无章节预览内容')}</pre>`;
      hoverPeekCache.set(cacheKey, result);
      return result;
    }

    const targetItem = payload.file ? findWorkspaceFile(payload.file) : null;
    if (!targetItem?.path) {
      result.bodyHtml = `<div style="color:var(--warning);">工作区暂未定位到「${escapeHtml(payload.file)}」，点击直达可自动寻回。</div>`;
      hoverPeekCache.set(cacheKey, result);
      return result;
    }

    result.targetItem = targetItem;
    result.canSplit = true;
    const ext = getExtLower(targetItem.path);
    result.iconName = docIconName('', ext);
    const badgeParts = [];
    if (payload.page) badgeParts.push(`P.${payload.page}`);
    if (payload.sheet || payload.cell) badgeParts.push(`${payload.sheet || ''}${payload.cell ? `!${payload.cell}` : ''}`);
    if (payload.member) badgeParts.push(`!${payload.member}`);
    if (payload.heading) badgeParts.push(`#${payload.heading}`);
    if (payload.time) badgeParts.push(`⏱ ${payload.time}`);
    result.title = badgeParts.length ? `${targetItem.name} · ${badgeParts.join(' ')}` : targetItem.name;

    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext)) {
      const src = `/api/files/raw-stream?path=${encodeURIComponent(targetItem.path)}`;
      result.bodyHtml = `<div style="display:flex;justify-content:center;"><img src="${src}" alt="${escapeHtml(targetItem.name)}" /></div>`;
      hoverPeekCache.set(cacheKey, result);
      return result;
    }

    if (['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) {
      const isVid = ['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext);
      result.iconName = 'play';
      result.bodyHtml = `
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div>${isVid ? '🎬 本地视频文件' : '🎵 本地音频文件'}${payload.time ? ` · 时间戳 <strong>${escapeHtml(payload.time)}</strong>` : ''}</div>
          <div style="font-size:11px;font-family:var(--font-mono);color:var(--text-tertiary);">${escapeHtml(targetItem.path)}</div>
        </div>
      `;
      hoverPeekCache.set(cacheKey, result);
      return result;
    }

    try {
      const reqPayload = {
        path: targetItem.path,
        ...(payload.page ? { page: Number.parseInt(payload.page, 10) || undefined } : {}),
        ...(payload.sheet ? { sheet: payload.sheet } : {}),
        ...(payload.cell ? { cell: payload.cell } : {}),
        ...(payload.member ? { member: payload.member } : {}),
      };
      const res = await api.expandFileContent(reqPayload);
      const rawPreview = String(res?.markdown || res?.content || res?.text || '').trim();
      if (rawPreview) {
        const truncated = rawPreview.split('\n').slice(0, 12).join('\n').slice(0, 450);
        const suffix = rawPreview.length > truncated.length ? '\n…' : '';
        result.bodyHtml = `<pre style="margin:0;white-space:pre-wrap;color:var(--text-secondary);">${escapeHtml(truncated + suffix)}</pre>`;
      } else {
        result.bodyHtml = `<div style="color:var(--text-tertiary);">${escapeHtml(res?.reason || '该文件暂无可预览文本内容')}</div>`;
      }
    } catch {
      result.bodyHtml = `<div style="font-size:11px;font-family:var(--font-mono);color:var(--text-tertiary);">${escapeHtml(targetItem.path)}</div>`;
    }

    hoverPeekCache.set(cacheKey, result);
    return result;
  }

  async function showHoverPeekForPill(pill) {
    if (!pill || !document.body.contains(pill)) return;
    if (activeHoldSession?.active || store.state.activeDragPayload) return;
    const capMenu = document.getElementById('capsule-context-menu');
    if (capMenu && !capMenu.hidden) return;

    const payload = extractAnchorPayloadFromPill(pill);
    const pillRect = pill.getBoundingClientRect();
    const card = getHoverPeekCardEl();

    card.innerHTML = `
      <div class="hover-peek-header">
        <span class="hover-peek-title">${icon('file-text', 13)} ${escapeHtml(payload.file || payload.app || payload.url || payload.heading || '速览')}</span>
      </div>
      <div class="hover-peek-body">正在加载速览…</div>
    `;
    card.hidden = false;
    positionHoverPeekCard(card, pillRect);

    const data = await buildHoverPeekData(payload);
    if (hoverPeekActivePill !== pill || card.hidden) return;

    card.innerHTML = `
      <div class="hover-peek-header">
        <span class="hover-peek-title" style="display:inline-flex;align-items:center;gap:5px;">
          ${icon(data.iconName, 13)} <span>${escapeHtml(data.title)}</span>
        </span>
      </div>
      <div class="hover-peek-body">${data.bodyHtml}</div>
      <div class="hover-peek-footer">
        <button type="button" class="pill-btn pill-btn-sm" data-peek-act="jump">↗ 直达</button>
        ${data.canSplit ? `<button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-peek-act="split">◫ 分屏看</button>` : ''}
      </div>
    `;
    positionHoverPeekCard(card, pill.getBoundingClientRect());

    card.querySelector('[data-peek-act="jump"]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      hideHoverPeekCard();
      handleAnchorClick(pill);
    });
    card.querySelector('[data-peek-act="split"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      hideHoverPeekCard();
      await openCapsuleInSplit(pill);
    });
  }

  containerEl.addEventListener('mouseover', (e) => {
    const pill = e.target.closest('.lp-container .anchor-pill, .md-preview .anchor-pill');
    if (!pill) return;
    if (hoverPeekActivePill === pill) {
      if (hoverPeekCloseTimer) {
        window.clearTimeout(hoverPeekCloseTimer);
        hoverPeekCloseTimer = 0;
      }
      return;
    }
    if (activeHoldSession?.active || store.state.activeDragPayload) return;
    const capMenu = document.getElementById('capsule-context-menu');
    if (capMenu && !capMenu.hidden) return;

    clearHoverPeekTimers();
    hoverPeekActivePill = pill;
    hoverPeekOpenTimer = window.setTimeout(() => {
      hoverPeekOpenTimer = 0;
      if (hoverPeekActivePill === pill) {
        showHoverPeekForPill(pill);
      }
    }, 400);
  });

  containerEl.addEventListener('mouseout', (e) => {
    const pill = e.target.closest('.lp-container .anchor-pill, .md-preview .anchor-pill');
    if (!pill || pill !== hoverPeekActivePill) return;
    const rel = e.relatedTarget;
    const card = document.getElementById('hover-peek-card');
    if (rel && (pill.contains(rel) || (card && card.contains(rel)))) {
      return;
    }
    if (hoverPeekOpenTimer) {
      window.clearTimeout(hoverPeekOpenTimer);
      hoverPeekOpenTimer = 0;
    }
    scheduleHoverPeekClose();
  });

  // =========================================================================
  // Innovation C: Dual-Pane Split View (renderSplitPane & openCapsuleInSplit)
  // =========================================================================
  async function openCapsuleInSplit(pillEl) {
    if (!pillEl) return;
    const ds = pillEl.dataset || {};
    const payload = extractAnchorPayloadFromPill(pillEl);
    if (payload.type === 'app' || payload.type === 'url') {
      showToast('应用/网址胶囊暂不支持分屏预览，请直接点击打开', 'info');
      return;
    }

    if (payload.type === 'heading' && !payload.file) {
      if (!state.activeDoc) return;
      splitExtraMeta.set(normalizePath(state.activeDoc.path), { member: '', time: '' });
      openSplitDoc({
        path: state.activeDoc.path,
        name: state.activeDoc.name,
        ext: state.activeDoc.ext,
        heading: payload.heading,
      });
      return;
    }

    if (!payload.file) return;
    let targetItem = findWorkspaceFile(payload.file);
    if (!targetItem) {
      targetItem = await tryRelocateMissingFile(payload.file);
    }
    if (!targetItem?.path) {
      showToast(`未找到目标文件：${payload.file}`, 'warning');
      return;
    }

    splitExtraMeta.set(normalizePath(targetItem.path), {
      member: payload.member || '',
      time: payload.time || '',
    });

    openSplitDoc({
      path: targetItem.path,
      name: targetItem.name || getBaseName(targetItem.path),
      ext: targetItem.ext || getExtLower(targetItem.path),
      page: payload.page ? Number.parseInt(payload.page, 10) || payload.page : null,
      sheet: payload.sheet || '',
      cell: payload.cell || '',
      heading: payload.heading || '',
    });
  }

  async function renderSplitPane(splitDoc = store.state.splitDoc) {
    const layout = ensureSplitLayoutEl();
    const mainPane = ensureMainPaneEl();
    const existingResizer = layout.querySelector(':scope > [data-role="center-split-resizer"]');
    const existingPane = layout.querySelector(':scope > .center-split-pane');

    if (!splitDoc || !splitDoc.path) {
      containerEl.classList.remove('has-split-pane');
      if (existingResizer) existingResizer.remove();
      if (existingPane) existingPane.remove();
      mainPane.style.flex = '1 1 100%';
      return;
    }

    const seq = ++state.splitSeq;
    containerEl.classList.add('has-split-pane');
    let resizerEl = existingResizer;
    if (!resizerEl) {
      resizerEl = document.createElement('div');
      resizerEl.className = 'center-split-resizer';
      resizerEl.dataset.role = 'center-split-resizer';
      resizerEl.title = '拖动调节左右分屏宽度比例（双击恢复 50:50）';
      if (existingPane) {
        layout.insertBefore(resizerEl, existingPane);
      } else {
        layout.appendChild(resizerEl);
      }
    }

    let splitPane = existingPane;
    if (!splitPane) {
      splitPane = document.createElement('aside');
      splitPane.className = 'center-split-pane';
      splitPane.setAttribute('aria-label', '右侧分屏预览');
      layout.appendChild(splitPane);
    }

    const ratio = Math.min(0.8, Math.max(0.2, Number(state.splitRatio) || 0.5));
    const leftPct = ((1 - ratio) * 100).toFixed(1);
    const rightPct = (ratio * 100).toFixed(1);
    mainPane.style.flex = `0 0 calc(${leftPct}% - 4px)`;
    splitPane.style.flex = `1 1 calc(${rightPct}% - 4px)`;

    const ext = String(splitDoc.ext || getExtLower(splitDoc.path)).toLowerCase();
    const extra = splitExtraMeta.get(normalizePath(splitDoc.path)) || {};
    const member = extra.member || '';
    const timeStr = extra.time || '';
    const subTag = splitDoc.page
      ? `P.${splitDoc.page}`
      : splitDoc.sheet || splitDoc.cell
      ? `${splitDoc.sheet || ''}${splitDoc.cell ? `!${splitDoc.cell}` : ''}`
      : member
      ? `!${member}`
      : splitDoc.heading
      ? `#${splitDoc.heading}`
      : '';

    splitPane.innerHTML = `
      <div class="center-split-pane-header">
        <div style="display:inline-flex;align-items:center;gap:6px;min-width:0;flex:1;">
          <span style="color:var(--accent);display:inline-flex;flex-shrink:0;">${icon(docIconName('', ext), 14)}</span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(splitDoc.path)}">${escapeHtml(splitDoc.name)}</span>
          ${subTag ? `<span class="file-ext-badge" style="text-transform:none;flex-shrink:0;">${escapeHtml(subTag)}</span>` : ''}
        </div>
        <div style="display:inline-flex;align-items:center;gap:4px;flex-shrink:0;">
          <button type="button" class="pill-btn pill-btn-sm" data-split-act="open-main" title="在主栏打开此文件">主栏打开</button>
          <button type="button" class="pill-btn pill-btn-sm" data-split-act="close" title="关闭分屏">✕ 关闭分屏</button>
        </div>
      </div>
      <div class="center-split-pane-body" data-role="split-pane-body">
        <div class="empty-state"><p class="empty-desc">正在加载分屏预览…</p></div>
      </div>
    `;

    const bodyEl = splitPane.querySelector('[data-role="split-pane-body"]');
    if (!bodyEl) return;

    if (ext === '.pdf') {
      const pageHash = splitDoc.page ? `#page=${encodeURIComponent(splitDoc.page)}` : '';
      bodyEl.style.padding = '8px';
      bodyEl.innerHTML = `<iframe class="split-pdf-frame" src="/api/files/pdf-stream?path=${encodeURIComponent(splitDoc.path)}${pageHash}" title="${escapeHtml(splitDoc.name)}"></iframe>`;
      return;
    }

    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext)) {
      bodyEl.innerHTML = `
        <div class="split-media-stage">
          <img src="/api/files/raw-stream?path=${encodeURIComponent(splitDoc.path)}" alt="${escapeHtml(splitDoc.name)}" />
        </div>
      `;
      return;
    }

    if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) {
      bodyEl.innerHTML = `
        <div class="split-media-stage">
          <video controls preload="metadata" data-role="split-media-el" src="/api/files/raw-stream?path=${encodeURIComponent(splitDoc.path)}"></video>
        </div>
      `;
      if (timeStr) {
        const vid = bodyEl.querySelector('[data-role="split-media-el"]');
        const sec = parseMediaTimeSeconds(timeStr);
        vid?.addEventListener('loadedmetadata', () => {
          try { vid.currentTime = sec; } catch {}
        }, { once: true });
      }
      return;
    }

    if (['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'].includes(ext)) {
      bodyEl.innerHTML = `
        <div class="split-media-stage" style="flex-direction:column;gap:10px;">
          <div style="font-size:13px;font-weight:600;">${escapeHtml(splitDoc.name)}</div>
          <audio controls preload="metadata" data-role="split-media-el" src="/api/files/raw-stream?path=${encodeURIComponent(splitDoc.path)}" style="width:100%;"></audio>
        </div>
      `;
      if (timeStr) {
        const aud = bodyEl.querySelector('[data-role="split-media-el"]');
        const sec = parseMediaTimeSeconds(timeStr);
        aud?.addEventListener('loadedmetadata', () => {
          try { aud.currentTime = sec; } catch {}
        }, { once: true });
      }
      return;
    }

    if (['.xlsx', '.xls', '.xlsm'].includes(ext)) {
      try {
        const params = new URLSearchParams({
          path: splitDoc.path,
          sheet: splitDoc.sheet || '',
          page: '1',
          page_size: '60',
        });
        const data = await api.get(`/api/excel/rows?${params.toString()}`);
        if (seq !== state.splitSeq) return;
        const headers = Array.isArray(data?.headers) ? data.headers : [];
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        const targetRef = splitDoc.cell ? parseExcelCellRef(splitDoc.cell) : null;
        bodyEl.innerHTML = `
          <div style="font-size:11.5px;color:var(--text-secondary);margin-bottom:8px;">工作表：<strong>${escapeHtml(data?.sheet || splitDoc.sheet || 'Sheet1')}</strong>（前 ${rows.length} 行）</div>
          <div style="overflow:auto;border:1px solid var(--border-hairline);border-radius:var(--radius-control);">
            <table class="excel-table">
              <thead>
                <tr>
                  <th class="excel-row-num">#</th>
                  ${headers.map((h, i) => `<th><span style="color:var(--text-tertiary);margin-right:3px;">${colIndexToLetter(i + 1)}</span>${escapeHtml(h)}</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${rows.map((r) => `
                  <tr>
                    <td class="excel-row-num">${r.row_num}</td>
                    ${headers.map((_, cIdx) => {
                      const isHit = targetRef && targetRef.row === r.row_num && targetRef.col === cIdx + 1;
                      return `<td class="${isHit ? 'excel-cell-selected' : ''}">${escapeHtml(r.cells?.[cIdx] ?? '')}</td>`;
                    }).join('')}
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
      } catch (err) {
        if (seq !== state.splitSeq) return;
        bodyEl.innerHTML = `<div class="empty-state"><p class="empty-title">表格预览失败</p><p class="empty-desc">${escapeHtml(getErrorMsg(err))}</p></div>`;
      }
      return;
    }

    if (['.zip', '.tar', '.gz', '.tgz'].includes(ext) && member) {
      try {
        const d = await api.get(`/api/files/archive-entry?path=${encodeURIComponent(splitDoc.path)}&member=${encodeURIComponent(member)}`);
        if (seq !== state.splitSeq) return;
        if (d?.data_url || (d?.base64 && String(d?.mime || '').startsWith('image/'))) {
          const src = d.data_url || `data:${d.mime};base64,${d.base64}`;
          bodyEl.innerHTML = `<div class="split-media-stage"><img src="${escapeHtml(src)}" alt="${escapeHtml(member)}" /></div>`;
        } else if (d?.content != null) {
          bodyEl.innerHTML = getExtLower(member) === '.md'
            ? `<div class="md-preview split-md-preview">${renderMarkdownSafe(String(d.content), { withLineMap: false })}</div>`
            : `<pre class="split-code-pre"><code>${escapeHtml(String(d.content))}</code></pre>`;
        } else {
          bodyEl.innerHTML = `<div class="empty-state"><p class="empty-desc">${escapeHtml(d?.message || '二进制成员不支持预览')}</p></div>`;
        }
      } catch (err) {
        if (seq !== state.splitSeq) return;
        bodyEl.innerHTML = `<div class="empty-state"><p class="empty-desc">${escapeHtml(getErrorMsg(err))}</p></div>`;
      }
      return;
    }

    try {
      const data = await api.get(`/api/files/read?path=${encodeURIComponent(splitDoc.path)}`);
      if (seq !== state.splitSeq) return;
      const dType = data?.type || '';
      if (ext === '.docx' || ext === '.pptx' || dType === 'office_preview') {
        const md = data?.preview_markdown || data?.previewMarkdown || data?.content || '*暂无可预览文本*';
        bodyEl.innerHTML = `<div class="md-preview split-md-preview">${renderMarkdownSafe(md, { withLineMap: false })}</div>`;
      } else if (ext === '.md' || dType === 'markdown') {
        bodyEl.innerHTML = `<div class="md-preview split-md-preview">${renderMarkdownSafe(data?.content || '', { withLineMap: false })}</div>`;
        if (splitDoc.heading) {
          const hKey = normalizeHeadingKey(splitDoc.heading);
          const matchH = Array.from(bodyEl.querySelectorAll('h1,h2,h3,h4,h5,h6')).find(
            (h) => normalizeHeadingKey(h.textContent).includes(hKey)
          );
          matchH?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } else if (data?.content != null) {
        bodyEl.innerHTML = `<pre class="split-code-pre"><code>${escapeHtml(String(data.content))}</code></pre>`;
      } else {
        bodyEl.innerHTML = `
          <div class="empty-state">
            <p class="empty-title">${escapeHtml(splitDoc.name)}</p>
            <p class="empty-desc">暂不支持该格式分屏内置预览</p>
            <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-split-act="open-main">在主栏打开</button>
          </div>
        `;
      }
    } catch (err) {
      if (seq !== state.splitSeq) return;
      bodyEl.innerHTML = `<div class="empty-state"><p class="empty-title">分屏读取失败</p><p class="empty-desc">${escapeHtml(getErrorMsg(err))}</p></div>`;
    }
  }

  store.on('split:changed', (doc) => {
    renderSplitPane(doc);
  });

  // =========================================================================
  // Click / Double-Click / Keydown Delegation
  // =========================================================================
  containerEl.addEventListener('click', (e) => {
    // 0. Split-pane header actions
    const splitActBtn = e.target.closest('[data-split-act]');
    if (splitActBtn) {
      const act = splitActBtn.dataset.splitAct;
      const sDoc = store.state.splitDoc;
      if (act === 'close') {
        closeSplitDoc();
      } else if (act === 'open-main' && sDoc?.path) {
        const extra = splitExtraMeta.get(normalizePath(sDoc.path)) || {};
        closeSplitDoc();
        openFile(sDoc.path, {
          initialPage: sDoc.page || undefined,
          sheet: sDoc.sheet || undefined,
          heading: sDoc.heading || undefined,
          member: extra.member || undefined,
          initialTime: extra.time ? parseMediaTimeSeconds(extra.time) : undefined,
        });
      }
      return;
    }

    // 0b. Word-style Icon Format Toolbar (.wysiwyg-format-bar) & Mobile Keyboard Format Bar (.mobile-md-kbd-bar)
    const fmtBarBtn = e.target.closest('[data-fmt-bar]');
    if (fmtBarBtn) {
      e.preventDefault();
      e.stopPropagation();
      applyWysiwygBarAction(fmtBarBtn.dataset.fmtBar);
      return;
    }

    const mobileKbdBtn = e.target.closest('[data-mobile-kbd]');
    if (mobileKbdBtn) {
      e.preventDefault();
      e.stopPropagation();
      handleMobileKbdAction(mobileKbdBtn.dataset.mobileKbd);
      return;
    }

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

    // 1. Anchor pill click in MD preview, split preview, or companion preview (Ctrl+Click = Split View!)
    const anchorPill = e.target.closest('.anchor-pill');
    if (anchorPill) {
      hideHoverPeekCard();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        openCapsuleInSplit(anchorPill);
        return;
      }
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
          ensureMainPaneEl().querySelector('.md-editor')?.focus();
        }
      }
      return;
    }

    // 2b. PDF inline annotation color pill
    const pdfAnnotColorBtn = e.target.closest('[data-pdf-annot-color]');
    if (pdfAnnotColorBtn && state.activeDoc?.type === 'pdf') {
      const nextColor = pdfAnnotColorBtn.dataset.pdfAnnotColor || 'yellow';
      state.pdf.annotColor = nextColor;
      containerEl.querySelectorAll('[data-pdf-annot-color]').forEach((b) => {
        b.classList.toggle('pill-btn-primary', b.dataset.pdfAnnotColor === nextColor);
      });
      containerEl.querySelector('[data-role="pdf-annot-input"]')?.focus();
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

      if (action === 'nav-back') {
        navigateHistory(-1);
        return;
      } else if (action === 'nav-forward') {
        navigateHistory(1);
        return;
      } else if (action === 'open-explorer-home') {
        if (typeof setCenterView === 'function') {
          setCenterView('explorer');
        } else {
          renderExplorerHome({ refresh: true });
        }
        return;
      } else if (action === 'lp-add-block') {
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
      } else if (action === 'mobile-doc-more') {
        openMobileDocMoreSheet();
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
      } else if (action === 'toggle-drag-mode') {
        setDragDefaultMode(state.dragDefaultMode === 'copy' ? 'cut' : 'copy');
        return;
      } else if (action === 'companion-set-float') {
        state.companionLayout = 'float';
        state.companionOpen = true;
        try {
          localStorage.setItem('sln_companion_layout', 'float');
        } catch {
          // ignore
        }
        renderActiveView();
        showToast('已切换伴生笔记为「浮窗模式」（可拖动顶栏移动、拖动边框调节大小）', 'info', { duration: 2000 });
        return;
      } else if (action === 'companion-set-split') {
        state.companionLayout = 'split';
        state.companionOpen = true;
        try {
          localStorage.setItem('sln_companion_layout', 'split');
        } catch {
          // ignore
        }
        renderActiveView();
        showToast('已切换伴生笔记为「分屏模式」（可拖动中间分隔线调节左右间距）', 'info', { duration: 2000 });
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
      } else if (action === 'pdf-copy-anchor') {
        if (!state.activeDoc || state.activeDoc.type !== 'pdf') return;
        const anchor = `[[${state.activeDoc.name}#page=${state.pdf.currentPage}]]`;
        copyInternal(anchor, '已复制页码锚点');
        return;
      } else if (action === 'pdf-annotate') {
        openPdfAnnotateSheet();
        return;
      } else if (action === 'pdf-annot-submit') {
        submitPdfInlineAnnotation();
        return;
      } else if (action === 'pdf-annot-close') {
        openPdfAnnotateSheet(false);
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

    // 7. V6 Live Preview click-to-edit WYSIWYG block activation
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
          activateBlockByStartLine(startLine, 'end', { x: e.clientX, y: e.clientY });
        }
      }
    }
  });

  containerEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-role="center-split-resizer"]')) {
      state.splitRatio = 0.5;
      try {
        localStorage.setItem('sln_split_ratio', '0.5');
      } catch {
        // ignore
      }
      const layout = ensureSplitLayoutEl();
      const mainPane = layout.querySelector(':scope > [data-role="center-main-pane"]');
      const splitPane = layout.querySelector(':scope > .center-split-pane');
      if (mainPane && splitPane) {
        mainPane.style.flex = '0 0 calc(50% - 4px)';
        splitPane.style.flex = '1 1 calc(50% - 4px)';
      }
      showToast('已重置分屏比例为 50:50', 'info', { duration: 1400 });
      return;
    }

    if (e.target.closest('[data-role="explorer-split-resizer"]')) {
      state.explorer.splitRatio = 0.62;
      try {
        localStorage.setItem('sln_explorer_split_ratio', '0.62');
      } catch {
        // ignore
      }
      const filesPane = containerEl.querySelector('.explorer-files-pane');
      const todoPane = containerEl.querySelector('.explorer-todo-pane');
      if (filesPane && todoPane) {
        filesPane.style.flex = '0 0 calc(62.0% - 4px)';
        filesPane.style.width = 'calc(62.0% - 4px)';
        todoPane.style.flex = '1 1 calc(38.0% - 4px)';
        todoPane.style.width = 'calc(38.0% - 4px)';
      }
      showToast('已重置主面板分栏比例为 62:38', 'info', { duration: 1400 });
      return;
    }

    if (e.target.closest('[data-role="archive-split-resizer"]')) {
      state.archiveTreeWidth = 230;
      try {
        localStorage.setItem('sln_archive_tree_w', '230');
      } catch {
        // ignore
      }
      const treeEl = containerEl.querySelector('.archive-tree');
      if (treeEl) {
        treeEl.style.width = '230px';
        treeEl.style.flex = '0 0 230px';
      }
      showToast('已重置压缩包目录树宽度为 230px', 'info', { duration: 1400 });
      return;
    }

    if (e.target.closest('[data-role="companion-split-resizer"]')) {
      state.companionSplitRatio = 0.36;
      try {
        localStorage.setItem('sln_companion_split_ratio', '0.36');
      } catch {
        // ignore
      }
      const compPane = containerEl.querySelector('[data-role="companion-split-pane"]');
      if (compPane) {
        compPane.style.flex = '0 0 36%';
        compPane.style.width = '36%';
      }
      showToast('已重置伴生笔记分屏宽度', 'info', { duration: 1400 });
      return;
    }

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

  function isCaretAtVisualEdge(editorEl, edge) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!editorEl.contains(range.startContainer)) return false;
    const rawMd = wysiwygElementToMarkdown(editorEl);
    if (!rawMd.trim()) return true;

    const edRect = editorEl.getBoundingClientRect();
    let caretRect = range.getBoundingClientRect();
    if (!caretRect || (caretRect.width === 0 && caretRect.height === 0 && caretRect.top === 0)) {
      const rects = range.getClientRects();
      caretRect = rects.length > 0 ? rects[0] : (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)?.getBoundingClientRect();
    }
    if (!caretRect || caretRect.height === 0) {
      const probe = document.createRange();
      if (edge === 'top') {
        probe.setStart(editorEl, 0);
        probe.setEnd(range.startContainer, range.startOffset);
      } else {
        probe.setStart(range.endContainer, range.endOffset);
        probe.setEnd(editorEl, editorEl.childNodes.length);
      }
      return probe.toString().trim() === '';
    }
    const lineTol = Math.max(22, caretRect.height * 1.45);
    return edge === 'top'
      ? (caretRect.top - edRect.top <= lineTol)
      : (edRect.bottom - caretRect.bottom <= lineTol);
  }

  containerEl.addEventListener('keydown', (e) => {
    // Slash Command Menu navigation when open in commands mode
    if (slashState.open && slashState.mode === 'commands') {
      const items = getFilteredSlashCommands();
      if (e.key === 'ArrowDown' && items.length > 0) {
        e.preventDefault();
        slashState.activeIdx = (slashState.activeIdx + 1) % items.length;
        renderSlashCommandsMenu();
        return;
      }
      if (e.key === 'ArrowUp' && items.length > 0) {
        e.preventDefault();
        slashState.activeIdx = (slashState.activeIdx - 1 + items.length) % items.length;
        renderSlashCommandsMenu();
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && items[slashState.activeIdx]) {
        e.preventDefault();
        executeSlashCommand(items[slashState.activeIdx].id);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlashMenu();
        return;
      }
    }

    // V6: Pure WYSIWYG inline block editor keyboard flow
    const wysiwygEl = e.target.closest?.('.lp-block-wysiwyg') || (e.target.matches?.('.lp-block-wysiwyg') ? e.target : null);
    if (wysiwygEl) {
      const mod = e.metaKey || e.ctrlKey;
      const keyLower = String(e.key || '').toLowerCase();

      if (mod && !e.shiftKey && keyLower === 'b') {
        e.preventDefault();
        applyWysiwygBarAction('bold');
        return;
      }
      if (mod && !e.shiftKey && keyLower === 'i') {
        e.preventDefault();
        applyWysiwygBarAction('italic');
        return;
      }
      if (mod && e.shiftKey && keyLower === 'x') {
        e.preventDefault();
        applyWysiwygBarAction('strike');
        return;
      }
      if (mod && !e.shiftKey && keyLower === 'e') {
        e.preventDefault();
        applyWysiwygBarAction('code');
        return;
      }
      if (mod && e.key === '/') {
        e.preventDefault();
        applyWysiwygBarAction('quote');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        commitActiveBlock({ reRender: true });
        return;
      }

      // Backspace when block is completely empty: delete empty block & focus previous block
      if (e.key === 'Backspace' && !mod && !e.altKey) {
        const mdNow = wysiwygElementToMarkdown(wysiwygEl);
        const txtNow = (wysiwygEl.textContent || '').replace(/\u200B/g, '').trim();
        if (!mdNow && !txtNow && !wysiwygEl.querySelector('img, .anchor-pill, .media-embed-card, input[type="checkbox"]')) {
          e.preventDefault();
          deleteActiveEmptyOrSelectedBlock(wysiwygEl);
          return;
        }
      }

      // Enter inside paragraph/heading (not Shift+Enter, not inside <pre> or <li> or <table>)
      if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey && !e.isComposing) {
        const sel = window.getSelection();
        const anchorNode = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).startContainer : null;
        const anchorEl = anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement;
        if (!anchorEl?.closest('pre, li, table, thead, tbody, tr, td, th')) {
          e.preventDefault();
          const doc = state.activeDoc;
          if (!doc) return;
          let tailMd = '';
          if (sel && sel.rangeCount > 0 && wysiwygEl.contains(sel.getRangeAt(0).endContainer)) {
            const range = sel.getRangeAt(0);
            const blockNode = anchorEl?.closest('p, h1, h2, h3, h4, h5, h6, div');
            const scopeEl = blockNode && wysiwygEl.contains(blockNode) && blockNode !== wysiwygEl ? blockNode : wysiwygEl;
            const tailRange = document.createRange();
            tailRange.setStart(range.endContainer, range.endOffset);
            tailRange.setEnd(scopeEl, scopeEl.childNodes.length);
            const frag = tailRange.extractContents();
            const tmp = document.createElement('div');
            tmp.appendChild(frag);
            tailMd = wysiwygElementToMarkdown(tmp);
          }

          syncWysiwygBlockInput(wysiwygEl);
          const headMd = wysiwygElementToMarkdown(wysiwygEl);
          if (!headMd && !tailMd && state.editingDraftInsert) {
            return;
          }

          const blocksNow = parseMarkdownBlocks(doc.content || '');
          const curIdx = Number.isFinite(state.editingBlockIdx)
            ? state.editingBlockIdx
            : blocksNow.findIndex((b) => b.startLine === state.editingBlockRange?.startLine);
          const curEnd = state.editingBlockRange?.endLine ?? (blocksNow[curIdx]?.endLine ?? 0);
          const afterLine = curEnd + 1;

          if (tailMd) {
            pushUndoSnapshot(doc.content, { immediate: true });
            doc.content = insertMarkdownWithPadding(doc.content || '', afterLine, tailMd);
            state.dirty = true;
            state.editingDraftNewBlock = false;
            state.editingDraftInsert = null;
            store.state.activeDocumentText = doc.content;
            activateBlockByIndex(Math.max(0, curIdx) + 1, 'start');
            return;
          }

          commitActiveBlock({ reRender: false });
          const afterBlocks = parseMarkdownBlocks(doc.content || '');
          if (curIdx < 0 || curIdx >= afterBlocks.length - 1) {
            appendNewBlockAndFocus();
          } else {
            insertDraftBlockAfter(curIdx, afterBlocks[curIdx].endLine + 1);
          }
          return;
        }
      }

      // ArrowUp at top edge -> previous block
      if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !mod && isCaretAtVisualEdge(wysiwygEl, 'top')) {
        const blockEl = wysiwygEl.closest('.lp-block');
        const curStart = state.editingDraftInsert
          ? state.editingDraftInsert.startLine
          : (state.editingBlockRange?.startLine ?? (Number.parseInt(blockEl?.dataset?.mdStart, 10) || 0));
        if (curStart > 0 || (state.editingDraftInsert && state.editingDraftInsert.afterBlockIdx >= 0)) {
          e.preventDefault();
          const prevAfterIdx = state.editingDraftInsert ? state.editingDraftInsert.afterBlockIdx : -1;
          commitActiveBlock({ reRender: false });
          const blocks = parseMarkdownBlocks(state.activeDoc?.content || '');
          const prevBlkIdx = prevAfterIdx >= 0
            ? prevAfterIdx
            : blocks.reduce((acc, b, i) => (b.startLine < curStart ? i : acc), -1);
          if (prevBlkIdx >= 0) {
            activateBlockByIndex(prevBlkIdx, 'end');
          } else {
            renderMarkdownMode();
          }
        }
        return;
      }

      // ArrowDown at bottom edge -> next block
      if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !mod && isCaretAtVisualEdge(wysiwygEl, 'bottom')) {
        const blockEl = wysiwygEl.closest('.lp-block');
        const curEnd = state.editingDraftInsert
          ? state.editingDraftInsert.startLine - 1
          : (state.editingBlockRange?.endLine ?? (Number.parseInt(blockEl?.dataset?.mdEnd ?? blockEl?.dataset?.mdStart, 10) || 0));
        const prevLineCount = getMdLines().length;
        const blocksBefore = parseMarkdownBlocks(state.activeDoc?.content || '');
        const hasNext = state.editingDraftInsert
          ? (state.editingDraftInsert.afterBlockIdx + 1 < blocksBefore.length)
          : blocksBefore.some((b) => b.startLine > curEnd);
        if (hasNext) {
          e.preventDefault();
          const targetIdxHint = state.editingDraftInsert ? state.editingDraftInsert.afterBlockIdx + 1 : -1;
          commitActiveBlock({ reRender: false });
          const lineDelta = getMdLines().length - prevLineCount;
          const blocksAfter = parseMarkdownBlocks(state.activeDoc?.content || '');
          const nextBlkIdx = targetIdxHint >= 0
            ? targetIdxHint
            : blocksAfter.findIndex((b) => b.startLine > curEnd + lineDelta);
          if (nextBlkIdx >= 0 && nextBlkIdx < blocksAfter.length) {
            activateBlockByIndex(nextBlkIdx, 'start');
          } else {
            renderMarkdownMode();
          }
        }
        return;
      }
      return;
    }

    // V4/V6: Source mode Ctrl+B / Ctrl+I / Ctrl+Shift+X / Ctrl+E / Ctrl+/
    if (e.target.matches('.md-editor') && !e.target.dataset.role) {
      const mod = e.metaKey || e.ctrlKey;
      const keyLower = String(e.key || '').toLowerCase();
      if (mod && !e.shiftKey && keyLower === 'b') {
        e.preventDefault();
        applySourceFormatAction(e.target, 'bold');
        return;
      }
      if (mod && !e.shiftKey && keyLower === 'i') {
        e.preventDefault();
        applySourceFormatAction(e.target, 'italic');
        return;
      }
      if (mod && e.shiftKey && keyLower === 'x') {
        e.preventDefault();
        applySourceFormatAction(e.target, 'strike');
        return;
      }
      if (mod && !e.shiftKey && keyLower === 'e') {
        e.preventDefault();
        applySourceFormatAction(e.target, 'code');
        return;
      }
      if (mod && e.key === '/') {
        e.preventDefault();
        applySourceFormatAction(e.target, 'quote');
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

    if (e.target.matches('[data-role="pdf-annot-input"], [data-role="pdf-annot-page"]')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitPdfInlineAnnotation();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        openPdfAnnotateSheet(false);
      }
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
    hideHoverPeekCard();
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
          !activeEl.classList.contains('lp-block-wysiwyg') &&
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

  containerEl.addEventListener('scroll', schedulePersistLastSession, true);
  window.addEventListener('beforeunload', persistLastSessionNow);

  // Mobile soft-keyboard & Android visualViewport tracking (hides #mobile-nav & docks .mobile-md-kbd-bar above keyboard)
  (function bindMobileSoftKeyboardAdaptation() {
    if (typeof document === 'undefined' || document.documentElement.dataset.mobileKbdBound === '1') return;
    document.documentElement.dataset.mobileKbdBound = '1';

    let blurTimer = 0;
    const isEditableTarget = (el) => {
      if (!(el instanceof Element)) return false;
      if (el.matches('textarea, [contenteditable="true"], [contenteditable=""]')) return true;
      if (el.matches('input')) {
        const t = String(el.getAttribute('type') || 'text').toLowerCase();
        return !['checkbox', 'radio', 'file', 'color', 'button', 'submit', 'reset', 'range'].includes(t);
      }
      return Boolean(el.closest?.('[contenteditable="true"]'));
    };

    const updateKbdBottom = () => {
      if (!isMobileViewport()) {
        document.body?.classList.remove('is-mobile-kbd-open');
        document.documentElement.style.removeProperty('--mobile-kbd-bottom');
        return;
      }
      const vv = window.visualViewport;
      const kbdInset = vv ? Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop))) : 0;
      const focusedEditable = isEditableTarget(document.activeElement);
      const kbdOpen = kbdInset > 90 || focusedEditable;
      document.body?.classList.toggle('is-mobile-kbd-open', kbdOpen);
      if (kbdInset > 90) {
        document.documentElement.style.setProperty('--mobile-kbd-bottom', `${kbdInset}px`);
      } else if (focusedEditable) {
        document.documentElement.style.setProperty('--mobile-kbd-bottom', '0px');
      } else {
        document.documentElement.style.removeProperty('--mobile-kbd-bottom');
      }
    };

    document.addEventListener('focusin', (e) => {
      if (!isMobileViewport()) return;
      if (isEditableTarget(e.target)) {
        if (blurTimer) window.clearTimeout(blurTimer);
        updateKbdBottom();
      }
    }, true);

    document.addEventListener('focusout', () => {
      if (blurTimer) window.clearTimeout(blurTimer);
      blurTimer = window.setTimeout(updateKbdBottom, 130);
    }, true);

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateKbdBottom);
      window.visualViewport.addEventListener('scroll', updateKbdBottom);
    }
    window.addEventListener('resize', updateKbdBottom);
  })();

  syncMobileTopbarTitle('工作区');

  // Initial render (restore last session file+scroll or open Explorer Home)
  if (store.state.splitDoc) {
    renderSplitPane(store.state.splitDoc);
  }
  if (store.state.activeCenterView === 'explorer') {
    renderExplorerHome({ refresh: true });
    return;
  }
  const initialItems = store.state.files?.items || [];
  if (initialItems.length > 0) {
    openInitialStartupDoc(initialItems).then((ok) => {
      if (!ok && !state.activeDoc && !state.loading) {
        renderWelcome();
      }
    });
    return;
  }
  renderWelcome();
}
