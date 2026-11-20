/**
 * SmartLocalNote V6 - Pure Native Zero-Pollution WYSIWYG <-> Pure Markdown Engine
 * Zero external dependencies. Relies strictly on ./store.js helpers and native DOM APIs.
 */

import { renderMarkdownSafe } from './store.js';

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'HR',
]);

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

function normalizeTextValue(str, inCode = false) {
  const s = String(str ?? '').replace(/\u00A0/g, ' ');
  return inCode ? s.replace(/\r\n/g, '\n') : s.replace(/\r\n/g, '\n');
}

function isWhitespaceOnlyTextNode(node) {
  return Boolean(node && node.nodeType === 3 && /^[\s\u00A0]*$/.test(node.nodeValue || ''));
}

function isAnchorOrMediaNode(el) {
  if (!el || el.nodeType !== 1) return false;
  return Boolean(
    el.classList?.contains('anchor-pill') ||
    el.classList?.contains('media-embed-card')
  );
}

function getAnchorRawToken(el) {
  if (!el || el.nodeType !== 1) return '';
  return String(el.dataset?.anchorRaw || el.dataset?.mediaRaw || '').trim();
}

function isTrailingSentinelBr(brNode) {
  let next = brNode?.nextSibling;
  while (next) {
    if (next.nodeType === 3) {
      if (next.nodeValue && next.nodeValue.replace(/[\u200B\uFEFF]/g, '').length > 0 && !/^[\s\u00A0]*$/.test(next.nodeValue)) {
        return false;
      }
      next = next.nextSibling;
      continue;
    }
    if (next.nodeType === 1) {
      if (next.tagName === 'BR') {
        return false;
      }
      return false;
    }
    next = next.nextSibling;
  }
  return true;
}

function wrapInlineMarker(inner, marker) {
  if (!inner || !inner.trim()) return inner || '';
  const leadingMatch = inner.match(/^(\s*)/);
  const trailingMatch = inner.match(/(\s*)$/);
  const leading = leadingMatch ? leadingMatch[1] : '';
  const trailing = trailingMatch ? trailingMatch[1] : '';
  const core = inner.slice(leading.length, inner.length - trailing.length);
  if (!core) return inner;
  return `${leading}${marker}${core}${marker}${trailing}`;
}

function parseInlineStyleProp(el, propRegex) {
  const styleAttr = el.getAttribute?.('style') || '';
  const match = styleAttr.match(propRegex);
  return match ? match[1].trim().toLowerCase() : '';
}

function serializeSpanOrFont(el) {
  let inner = serializeInlineChildren(el);
  if (!inner) return '';

  const fontWeightRaw = (el.style?.fontWeight || parseInlineStyleProp(el, /font-weight\s*:\s*([^;]+)/i) || '').toLowerCase();
  const fontStyleRaw = (el.style?.fontStyle || parseInlineStyleProp(el, /font-style\s*:\s*([^;]+)/i) || '').toLowerCase();
  const textDecoRaw = (
    el.style?.textDecorationLine ||
    el.style?.textDecoration ||
    parseInlineStyleProp(el, /text-decoration(?:-line)?\s*:\s*([^;]+)/i) ||
    ''
  ).toLowerCase();

  const numericWeight = Number(fontWeightRaw);
  const isBold = fontWeightRaw === 'bold' || fontWeightRaw === 'bolder' || (Number.isFinite(numericWeight) && numericWeight >= 600);
  const isItalic = fontStyleRaw === 'italic' || fontStyleRaw === 'oblique';
  const isStrike = textDecoRaw.includes('line-through');

  if (isStrike) inner = wrapInlineMarker(inner, '~~');
  if (isItalic) inner = wrapInlineMarker(inner, '*');
  if (isBold) inner = wrapInlineMarker(inner, '**');
  return inner;
}

function serializeInlineCode(el) {
  const text = normalizeTextValue(el.textContent || '', true);
  if (!text) return '';
  let maxTicks = 0;
  const matches = text.match(/`+/g);
  if (matches) {
    for (const m of matches) {
      if (m.length > maxTicks) maxTicks = m.length;
    }
  }
  const fence = '`'.repeat(maxTicks + 1);
  const needsPad = text.startsWith('`') || text.endsWith('`');
  return needsPad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function serializeInlineNode(node) {
  if (!node) return '';
  if (node.nodeType === 3) {
    const raw = normalizeTextValue(node.nodeValue || '');
    return raw.replace(/\u200B/g, '');
  }
  if (node.nodeType !== 1) return '';

  const tag = node.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
    return '';
  }

  if (isAnchorOrMediaNode(node)) {
    return getAnchorRawToken(node);
  }

  if (tag === 'INPUT') {
    if ((node.type || node.getAttribute?.('type') || '').toLowerCase() === 'checkbox') {
      return '';
    }
    return '';
  }

  if (tag === 'BR') {
    return isTrailingSentinelBr(node) ? '' : '\n';
  }

  if (tag === 'STRONG' || tag === 'B') {
    return wrapInlineMarker(serializeInlineChildren(node), '**');
  }

  if (tag === 'EM' || tag === 'I') {
    return wrapInlineMarker(serializeInlineChildren(node), '*');
  }

  if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') {
    return wrapInlineMarker(serializeInlineChildren(node), '~~');
  }

  if (tag === 'MARK') {
    const inner = serializeInlineChildren(node);
    if (!inner.trim()) return inner;
    const leadingMatch = inner.match(/^(\s*)/);
    const trailingMatch = inner.match(/(\s*)$/);
    const leading = leadingMatch ? leadingMatch[1] : '';
    const trailing = trailingMatch ? trailingMatch[1] : '';
    const core = inner.slice(leading.length, inner.length - trailing.length);
    return `${leading}<mark>${core}</mark>${trailing}`;
  }

  if (tag === 'CODE') {
    return serializeInlineCode(node);
  }

  if (tag === 'A') {
    const href = (node.getAttribute('href') || '').trim();
    const label = serializeInlineChildren(node).trim();
    if (!href) return label;
    if (!label || label === href) return href;
    return `[${label}](${href})`;
  }

  if (tag === 'IMG') {
    const alt = (node.getAttribute('alt') || '').trim();
    const src = (node.getAttribute('src') || '').trim();
    if (!src) return alt;
    return `![${alt}](${src})`;
  }

  if (tag === 'SPAN' || tag === 'FONT' || tag === 'U' || tag === 'SUB' || tag === 'SUP') {
    return serializeSpanOrFont(node);
  }

  // Fallback for any unexpected inline or wrapper element: unwrap cleanly
  return serializeInlineChildren(node);
}

function serializeInlineChildren(el) {
  if (!el || !el.childNodes) return '';
  let out = '';
  const children = Array.from(el.childNodes);
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.nodeType === 3) {
      let val = normalizeTextValue(child.nodeValue || '').replace(/\u200B/g, '');
      // Strip HTML formatting newlines between block edges inside mixed parents
      if (i === 0) val = val.replace(/^\n+/, '');
      if (i === children.length - 1) val = val.replace(/\n+$/, '');
      out += val;
    } else {
      out += serializeInlineNode(child);
    }
  }
  return out;
}

function serializePreBlock(preEl) {
  const codeEl = preEl.querySelector('code');
  const target = codeEl || preEl;
  const className = String(target.className || preEl.className || '');
  const langMatch = className.match(/\blanguage-([a-zA-Z0-9_+-]+)/i);
  const lang = langMatch ? langMatch[1] : '';

  let raw = normalizeTextValue(target.textContent || '', true).replace(/\u200B/g, '');
  if (raw.endsWith('\n')) {
    raw = raw.slice(0, -1);
  }

  let maxFence = 3;
  const fenceMatches = raw.match(/`{3,}/g);
  if (fenceMatches) {
    for (const m of fenceMatches) {
      if (m.length >= maxFence) maxFence = m.length + 1;
    }
  }
  const fence = '`'.repeat(maxFence);
  return `${fence}${lang}\n${raw}\n${fence}`;
}

function serializeCalloutBlock(calloutEl) {
  let kind = 'NOTE';
  if (calloutEl.classList?.contains('callout-tip')) kind = 'TIP';
  else if (calloutEl.classList?.contains('callout-warning')) kind = 'WARNING';
  else if (calloutEl.classList?.contains('callout-important')) kind = 'IMPORTANT';

  const bodyEl = calloutEl.querySelector('.md-callout-body');
  const innerMd = bodyEl
    ? serializeBlockContainer(bodyEl)
    : serializeBlockContainer(calloutEl, (child) => !child.classList?.contains('md-callout-title'));

  const lines = innerMd ? innerMd.split('\n') : [];
  const prefixed = [`> [!${kind}]`, ...lines.map((l) => (l.trim() === '' ? '>' : `> ${l}`))];
  return prefixed.join('\n');
}

function serializeBlockquote(bqEl) {
  const innerMd = serializeBlockContainer(bqEl);
  if (!innerMd) return '';
  return innerMd
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

function findDirectTaskCheckbox(liEl) {
  for (const child of Array.from(liEl.childNodes)) {
    if (child.nodeType === 1) {
      if (child.tagName === 'INPUT' && (child.type || child.getAttribute?.('type') || '').toLowerCase() === 'checkbox') {
        return child;
      }
      if (child.tagName === 'P') {
        for (const pChild of Array.from(child.childNodes)) {
          if (pChild.nodeType === 1 && pChild.tagName === 'INPUT' && (pChild.type || pChild.getAttribute?.('type') || '').toLowerCase() === 'checkbox') {
            return pChild;
          }
          if (!isWhitespaceOnlyTextNode(pChild)) break;
        }
      }
      break;
    }
    if (!isWhitespaceOnlyTextNode(child)) break;
  }
  return null;
}

function serializeListItem(liEl, prefix, indentLevel) {
  const indent = '  '.repeat(indentLevel);
  const checkbox = findDirectTaskCheckbox(liEl);
  const effectivePrefix = checkbox
    ? (checkbox.checked ? '- [x] ' : '- [ ] ')
    : prefix;

  const nestedBlocks = [];
  const inlineParts = [];
  const subLists = [];
  let pendingInlineNodes = [];

  const flushInline = () => {
    if (pendingInlineNodes.length === 0) return;
    let text = '';
    for (const n of pendingInlineNodes) {
      text += serializeInlineNode(n);
    }
    pendingInlineNodes = [];
    const cleaned = text.replace(/^\s+/, (m) => (checkbox ? '' : m)).replace(/[ \t]+$/g, '');
    if (cleaned) {
      inlineParts.push(cleaned);
    }
  };

  for (const child of Array.from(liEl.childNodes)) {
    if (child === checkbox) continue;
    if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) {
      flushInline();
      const nestedMd = serializeList(child, indentLevel + 1);
      if (nestedMd) subLists.push(nestedMd);
      continue;
    }
    if (child.nodeType === 1 && (child.tagName === 'P' || child.tagName === 'DIV')) {
      flushInline();
      let pText = '';
      for (const pChild of Array.from(child.childNodes)) {
        if (pChild === checkbox) continue;
        pText += serializeInlineNode(pChild);
      }
      pText = pText.replace(/^\n+|\n+$/g, '').trimEnd();
      if (checkbox && inlineParts.length === 0 && nestedBlocks.length === 0) {
        pText = pText.replace(/^\s+/, '');
      }
      if (pText) nestedBlocks.push(pText);
      continue;
    }
    if (child.nodeType === 1 && (child.tagName === 'BLOCKQUOTE' || child.tagName === 'PRE' || child.tagName === 'TABLE')) {
      flushInline();
      const bMd = serializeBlockElement(child);
      if (bMd) nestedBlocks.push(bMd);
      continue;
    }
    if (child.nodeType === 3 && isWhitespaceOnlyTextNode(child) && pendingInlineNodes.length === 0) {
      continue;
    }
    pendingInlineNodes.push(child);
  }
  flushInline();

  const contentParts = [...inlineParts, ...nestedBlocks];
  const lines = [];
  if (contentParts.length > 0) {
    const firstLines = contentParts[0].split('\n');
    lines.push(`${indent}${effectivePrefix}${firstLines[0]}`);
    const contIndent = '  '.repeat(indentLevel + 1);
    for (let i = 1; i < firstLines.length; i += 1) {
      lines.push(firstLines[i] ? `${contIndent}${firstLines[i]}` : '');
    }
    for (let b = 1; b < contentParts.length; b += 1) {
      lines.push('');
      for (const subLine of contentParts[b].split('\n')) {
        lines.push(subLine ? `${contIndent}${subLine}` : '');
      }
    }
  } else if (checkbox) {
    lines.push(`${indent}${effectivePrefix.trimEnd()}`);
  } else if (subLists.length === 0) {
    return '';
  } else {
    lines.push(`${indent}${effectivePrefix.trimEnd()}`);
  }

  for (const sub of subLists) {
    lines.push(sub);
  }
  return lines.join('\n');
}

function serializeList(listEl, indentLevel = 0) {
  const isOrdered = listEl.tagName === 'OL';
  let index = isOrdered ? (Number.parseInt(listEl.getAttribute('start') || '1', 10) || 1) : 1;
  const lines = [];

  for (const child of Array.from(listEl.children)) {
    if (child.tagName === 'LI') {
      const prefix = isOrdered ? `${index}. ` : '- ';
      const itemMd = serializeListItem(child, prefix, indentLevel);
      if (itemMd) lines.push(itemMd);
      if (isOrdered) index += 1;
    } else if (child.tagName === 'UL' || child.tagName === 'OL') {
      const nestedMd = serializeList(child, indentLevel + 1);
      if (nestedMd) lines.push(nestedMd);
    }
  }
  return lines.join('\n');
}

function getTableCellAlign(cellEl) {
  const alignAttr = (cellEl.getAttribute('align') || '').trim().toLowerCase();
  const styleAlign = (cellEl.style?.textAlign || parseInlineStyleProp(cellEl, /text-align\s*:\s*([^;]+)/i) || '').toLowerCase();
  const align = styleAlign || alignAttr;
  if (align === 'center') return ':---:';
  if (align === 'right') return '---:';
  if (align === 'left') return ':---';
  return '---';
}

function serializeTable(tableEl) {
  const rowEls = [];
  for (const child of Array.from(tableEl.children)) {
    if (child.tagName === 'TR') {
      rowEls.push(child);
    } else if (child.tagName === 'THEAD' || child.tagName === 'TBODY' || child.tagName === 'TFOOT') {
      for (const tr of Array.from(child.children)) {
        if (tr.tagName === 'TR') rowEls.push(tr);
      }
    }
  }
  if (rowEls.length === 0) return '';

  const rows = [];
  let maxCols = 0;
  let headerCells = null;

  for (let r = 0; r < rowEls.length; r += 1) {
    const cellEls = Array.from(rowEls[r].children).filter((c) => c.tagName === 'TH' || c.tagName === 'TD');
    if (r === 0) headerCells = cellEls;
    const cells = cellEls.map((cell) =>
      serializeInlineChildren(cell)
        .replace(/\n+/g, '<br>')
        .replace(/\|/g, '\\|')
        .trim()
    );
    if (cells.length > maxCols) maxCols = cells.length;
    rows.push(cells);
  }
  if (maxCols === 0) return '';

  const padRow = (cells) => {
    const padded = [...cells];
    while (padded.length < maxCols) padded.push('');
    return `| ${padded.join(' | ')} |`;
  };

  const sepCells = [];
  for (let c = 0; c < maxCols; c += 1) {
    sepCells.push(headerCells && headerCells[c] ? getTableCellAlign(headerCells[c]) : '---');
  }

  const out = [padRow(rows[0]), `| ${sepCells.join(' | ')} |`];
  for (let r = 1; r < rows.length; r += 1) {
    out.push(padRow(rows[r]));
  }
  return out.join('\n');
}

function hasBlockChild(el) {
  for (const child of Array.from(el.children || [])) {
    if (
      BLOCK_TAGS.has(child.tagName) ||
      child.classList?.contains('media-embed-card') ||
      child.classList?.contains('md-callout')
    ) {
      return true;
    }
  }
  return false;
}

function serializeBlockElement(el) {
  if (!el || el.nodeType !== 1) return '';
  const tag = el.tagName;

  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
    return '';
  }

  if (isAnchorOrMediaNode(el)) {
    return getAnchorRawToken(el);
  }

  if (el.classList?.contains('md-callout')) {
    return serializeCalloutBlock(el);
  }

  if (HEADING_TAGS.has(tag)) {
    const level = Number(tag[1]);
    const inner = serializeInlineChildren(el).replace(/\n+/g, ' ').trim();
    if (!inner) return '';
    return `${'#'.repeat(level)} ${inner}`;
  }

  if (tag === 'PRE') {
    return serializePreBlock(el);
  }

  if (tag === 'BLOCKQUOTE') {
    return serializeBlockquote(el);
  }

  if (tag === 'UL' || tag === 'OL') {
    return serializeList(el, 0);
  }

  if (tag === 'TABLE') {
    return serializeTable(el);
  }

  if (tag === 'HR') {
    return '---';
  }

  if (tag === 'P') {
    if (hasBlockChild(el)) {
      return serializeBlockContainer(el);
    }
    return serializeInlineChildren(el).replace(/^\n+|\n+$/g, '').trimEnd();
  }

  if (tag === 'DIV') {
    if (hasBlockChild(el)) {
      return serializeBlockContainer(el);
    }
    return serializeInlineChildren(el).replace(/^\n+|\n+$/g, '').trimEnd();
  }

  // Fallback for unexpected block-like tags
  if (hasBlockChild(el)) {
    return serializeBlockContainer(el);
  }
  return serializeInlineNode(el);
}

function serializeBlockContainer(containerEl, filterFn = null) {
  if (!containerEl || !containerEl.childNodes) return '';
  const entries = [];
  let inlineBuffer = [];

  const flushInlineBuffer = () => {
    if (inlineBuffer.length === 0) return;
    let text = '';
    for (const n of inlineBuffer) {
      text += serializeInlineNode(n);
    }
    inlineBuffer = [];
    const trimmed = text.replace(/^\n+|\n+$/g, '').trimEnd();
    if (trimmed) {
      entries.push({ kind: 'inline', text: trimmed });
    }
  };

  for (const child of Array.from(containerEl.childNodes)) {
    if (filterFn && !filterFn(child)) continue;

    if (child.nodeType === 3) {
      if (isWhitespaceOnlyTextNode(child) && inlineBuffer.length === 0) {
        continue;
      }
      inlineBuffer.push(child);
      continue;
    }

    if (child.nodeType !== 1) continue;

    const tag = child.tagName;
    const isMediaOrCallout = child.classList?.contains('media-embed-card') || child.classList?.contains('md-callout');
    const isInlineAnchor = child.classList?.contains('anchor-pill');

    if (isInlineAnchor) {
      inlineBuffer.push(child);
      continue;
    }

    if (BLOCK_TAGS.has(tag) || isMediaOrCallout) {
      flushInlineBuffer();
      if (tag === 'DIV' && !isMediaOrCallout && !hasBlockChild(child)) {
        const divText = serializeInlineChildren(child).replace(/^\n+|\n+$/g, '').trimEnd();
        entries.push({ kind: 'div', text: divText });
      } else {
        const blockText = serializeBlockElement(child);
        if (blockText) {
          entries.push({ kind: tag.toLowerCase(), text: blockText });
        }
      }
      continue;
    }

    inlineBuffer.push(child);
  }
  flushInlineBuffer();

  if (entries.length === 0) return '';

  let result = '';
  let prevEntry = null;
  let hadEmptyDiv = false;

  for (const entry of entries) {
    if (entry.kind === 'div' && !entry.text) {
      hadEmptyDiv = true;
      continue;
    }
    if (!entry.text) continue;

    if (!prevEntry) {
      result = entry.text;
    } else if (
      !hadEmptyDiv &&
      entry.kind === 'div' &&
      (prevEntry.kind === 'div' || prevEntry.kind === 'inline')
    ) {
      result += `\n${entry.text}`;
    } else {
      result += `\n\n${entry.text}`;
    }
    prevEntry = entry;
    hadEmptyDiv = false;
  }

  return result;
}

/**
 * Render Markdown to clean, WYSIWYG-ready HTML.
 * Marks interactive capsules/embeds with contenteditable="false" and enables task checkboxes.
 * @param {string} mdRaw
 * @param {object} [opts={}]
 * @returns {string}
 */
export function markdownToWysiwygBlockHtml(mdRaw, opts = {}) {
  const raw = String(mdRaw ?? '');
  if (raw.trim() === '') {
    return '<p><br></p>';
  }

  const rendered = renderMarkdownSafe(raw, { compactMedia: false, ...opts });
  if (typeof document === 'undefined') {
    return rendered || '<p><br></p>';
  }

  const tpl = document.createElement('template');
  tpl.innerHTML = rendered;

  const capsules = tpl.content.querySelectorAll('.anchor-pill, .media-embed-card');
  for (const el of capsules) {
    el.setAttribute('contenteditable', 'false');
    if (!el.dataset.anchorRaw && el.dataset.mediaRaw) {
      el.dataset.anchorRaw = el.dataset.mediaRaw;
    }
  }

  const calloutTitles = tpl.content.querySelectorAll('.md-callout-title');
  for (const titleEl of calloutTitles) {
    titleEl.setAttribute('contenteditable', 'false');
  }

  const checkboxes = tpl.content.querySelectorAll('input[type="checkbox"]');
  for (const cb of checkboxes) {
    cb.disabled = false;
    cb.removeAttribute('disabled');
    cb.setAttribute('contenteditable', 'false');
    if (cb.hasAttribute('checked')) {
      cb.checked = true;
    }
  }

  const out = tpl.innerHTML.trim();
  return out || '<p><br></p>';
}

/**
 * Zero-pollution serializer: convert a WYSIWYG contenteditable root element back into pure Markdown.
 * Never emits raw <div>, <span>, style=..., or <font> into Markdown.
 * @param {HTMLElement} rootEl
 * @returns {string}
 */
export function wysiwygElementToMarkdown(rootEl) {
  if (!rootEl) return '';
  const rawMd = serializeBlockContainer(rootEl);
  if (!rawMd) return '';

  return rawMd
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getSelectionRangeInside(rootEl) {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!rootEl.contains(range.commonAncestorContainer)) return null;
  return { sel, range };
}

function placeCaretAtEnd(el) {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function selectNodeContents(el) {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

function findAncestorTagInside(node, rootEl, tagNames) {
  const set = new Set(Array.isArray(tagNames) ? tagNames : [tagNames]);
  let cur = node?.nodeType === 1 ? node : node?.parentElement;
  while (cur && cur !== rootEl) {
    if (set.has(cur.tagName)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function getActiveBlockElement(rootEl) {
  const info = getSelectionRangeInside(rootEl);
  const blockTagNames = ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'BLOCKQUOTE'];

  if (info) {
    let cur = info.range.startContainer;
    if (cur.nodeType === 3) cur = cur.parentElement;
    while (cur && cur !== rootEl) {
      if (blockTagNames.includes(cur.tagName)) {
        if (cur.tagName === 'BLOCKQUOTE' && cur.querySelector('p, div, h1, h2, h3, li')) {
          break;
        }
        return cur;
      }
      cur = cur.parentElement;
    }
    if (cur === rootEl) {
      // Bare text node directly under rootEl: wrap direct inline run into <p>
      const p = document.createElement('p');
      const anchor = info.range.startContainer;
      if (anchor.parentNode === rootEl) {
        rootEl.insertBefore(p, anchor);
        p.appendChild(anchor);
        placeCaretAtEnd(p);
        return p;
      }
    }
  }

  for (const child of Array.from(rootEl.children)) {
    if (child.tagName === 'UL' || child.tagName === 'OL') {
      const firstLi = child.querySelector('li');
      if (firstLi) return firstLi;
    }
    if (blockTagNames.includes(child.tagName)) {
      return child;
    }
  }

  const p = document.createElement('p');
  while (rootEl.firstChild) {
    p.appendChild(rootEl.firstChild);
  }
  if (!p.firstChild) p.appendChild(document.createElement('br'));
  rootEl.appendChild(p);
  placeCaretAtEnd(p);
  return p;
}

function unwrapElementKeepChildren(el) {
  const parent = el.parentNode;
  if (!parent) return null;
  const firstMoved = el.firstChild;
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  parent.removeChild(el);
  return firstMoved;
}

function toggleInlineTagViaRange(rootEl, tagName, placeholderText) {
  const upperTag = tagName.toUpperCase();
  const info = getSelectionRangeInside(rootEl);
  if (!info) {
    rootEl.focus?.();
    const target = getActiveBlockElement(rootEl);
    const el = document.createElement(tagName.toLowerCase());
    el.textContent = placeholderText;
    target.appendChild(el);
    selectNodeContents(el);
    return true;
  }

  const { sel, range } = info;
  const existing = findAncestorTagInside(range.startContainer, rootEl, upperTag);
  if (existing && !(upperTag === 'CODE' && existing.parentElement?.tagName === 'PRE')) {
    const parent = existing.parentNode;
    const textContent = existing.textContent || '';
    const textNode = document.createTextNode(textContent);
    parent.replaceChild(textNode, existing);
    const nextRange = document.createRange();
    nextRange.selectNodeContents(textNode);
    nextRange.collapse(false);
    sel.removeAllRanges();
    sel.addRange(nextRange);
    return true;
  }

  if (!range.collapsed) {
    const frag = range.extractContents();
    const wrapper = document.createElement(tagName.toLowerCase());
    wrapper.appendChild(frag);
    if (!wrapper.textContent) {
      wrapper.textContent = placeholderText;
    }
    range.insertNode(wrapper);
    selectNodeContents(wrapper);
    return true;
  }

  const wrapper = document.createElement(tagName.toLowerCase());
  wrapper.textContent = placeholderText;
  range.insertNode(wrapper);
  selectNodeContents(wrapper);
  return true;
}

function replaceBlockTag(blockEl, nextTagName) {
  const nextEl = document.createElement(nextTagName.toLowerCase());
  while (blockEl.firstChild) {
    nextEl.appendChild(blockEl.firstChild);
  }
  if (!nextEl.firstChild) {
    nextEl.appendChild(document.createElement('br'));
  }
  blockEl.replaceWith(nextEl);
  placeCaretAtEnd(nextEl);
  return nextEl;
}

function createTaskListItem(contentNodesOrText, checked = false) {
  const li = document.createElement('li');
  const cb = document.createElement('input');
  cb.setAttribute('type', 'checkbox');
  cb.type = 'checkbox';
  cb.checked = Boolean(checked);
  cb.setAttribute('contenteditable', 'false');
  li.appendChild(cb);
  li.appendChild(document.createTextNode(' '));
  if (typeof contentNodesOrText === 'string') {
    if (contentNodesOrText) {
      li.appendChild(document.createTextNode(contentNodesOrText));
    }
  } else if (Array.isArray(contentNodesOrText)) {
    for (const n of contentNodesOrText) {
      li.appendChild(n);
    }
  }
  return li;
}

/**
 * Apply Word/Typora-style WYSIWYG formatting directly inside an active contenteditable blockEl.
 * @param {'bold'|'italic'|'strike'|'mark'|'code'|'h1'|'h2'|'h3'|'p'|'quote'|'tip'|'warn'|'ul'|'ol'|'todo'|'codeblock'|'hr'} action
 * @param {HTMLElement} blockEl
 * @returns {boolean} true if DOM changed
 */
export function execWysiwygFormat(action, blockEl) {
  if (typeof document === 'undefined' || !blockEl) return false;
  const act = String(action || '').trim().toLowerCase();
  if (!act) return false;

  if (!getSelectionRangeInside(blockEl)) {
    blockEl.focus?.();
  }

  if (act === 'bold') {
    if (typeof document.execCommand === 'function') {
      document.execCommand('bold', false, null);
      return true;
    }
    return toggleInlineTagViaRange(blockEl, 'strong', '加粗文本');
  }

  if (act === 'italic') {
    if (typeof document.execCommand === 'function') {
      document.execCommand('italic', false, null);
      return true;
    }
    return toggleInlineTagViaRange(blockEl, 'em', '斜体文本');
  }

  if (act === 'strike') {
    if (typeof document.execCommand === 'function') {
      document.execCommand('strikeThrough', false, null);
      return true;
    }
    return toggleInlineTagViaRange(blockEl, 'del', '删除线文本');
  }

  if (act === 'mark') {
    return toggleInlineTagViaRange(blockEl, 'mark', '高亮文本');
  }

  if (act === 'code') {
    return toggleInlineTagViaRange(blockEl, 'code', 'code');
  }

  if (act === 'h1' || act === 'h2' || act === 'h3' || act === 'p') {
    const activeBlock = getActiveBlockElement(blockEl);
    const targetTag = act.toUpperCase();
    if (activeBlock.tagName === 'LI') {
      // Convert list item out to heading/paragraph if heading requested
      if (targetTag === 'P') return false;
      const p = document.createElement(act);
      while (activeBlock.firstChild) {
        if (activeBlock.firstChild.tagName === 'INPUT') {
          activeBlock.firstChild.remove();
          continue;
        }
        p.appendChild(activeBlock.firstChild);
      }
      const list = activeBlock.closest('ul, ol');
      if (list && list.children.length <= 1) {
        list.replaceWith(p);
      } else {
        activeBlock.remove();
        list?.parentNode?.insertBefore(p, list.nextSibling);
      }
      placeCaretAtEnd(p);
      return true;
    }
    const nextTag = activeBlock.tagName === targetTag && targetTag !== 'P' ? 'P' : targetTag;
    if (activeBlock.tagName === nextTag) return false;
    replaceBlockTag(activeBlock, nextTag);
    return true;
  }

  if (act === 'quote') {
    const info = getSelectionRangeInside(blockEl);
    const existingBq = info
      ? findAncestorTagInside(info.range.startContainer, blockEl, 'BLOCKQUOTE')
      : blockEl.querySelector('blockquote');

    if (existingBq) {
      const firstMoved = unwrapElementKeepChildren(existingBq);
      if (firstMoved) placeCaretAtEnd(firstMoved);
      return true;
    }

    const activeBlock = getActiveBlockElement(blockEl);
    const bq = document.createElement('blockquote');
    activeBlock.parentNode.insertBefore(bq, activeBlock);
    bq.appendChild(activeBlock);
    placeCaretAtEnd(activeBlock);
    return true;
  }

  if (act === 'tip' || act === 'warn') {
    const activeBlock = getActiveBlockElement(blockEl);
    const existingText = (activeBlock.textContent || '').trim();
    const bodyText = existingText || (act === 'tip' ? '在此输入提示内容' : '在此输入易错提醒内容');

    const bq = document.createElement('blockquote');
    const p = document.createElement('p');
    const prefixIcon = act === 'tip' ? '💡 ' : '⚠️ ';
    const titleLabel = act === 'tip' ? '提示' : '易错提醒';
    p.appendChild(document.createTextNode(prefixIcon));
    const strong = document.createElement('strong');
    strong.textContent = titleLabel;
    p.appendChild(strong);
    p.appendChild(document.createTextNode(`：${bodyText}`));
    bq.appendChild(p);

    const existingBq = activeBlock.closest('blockquote');
    if (existingBq && blockEl.contains(existingBq)) {
      existingBq.replaceWith(bq);
    } else {
      activeBlock.replaceWith(bq);
    }
    placeCaretAtEnd(p);
    return true;
  }

  if (act === 'ul' || act === 'ol') {
    const cmd = act === 'ul' ? 'insertUnorderedList' : 'insertOrderedList';
    if (typeof document.execCommand === 'function') {
      const beforeHtml = blockEl.innerHTML;
      document.execCommand(cmd, false, null);
      if (blockEl.innerHTML !== beforeHtml) return true;
    }
    const activeBlock = getActiveBlockElement(blockEl);
    const list = document.createElement(act);
    const li = document.createElement('li');
    while (activeBlock.firstChild) li.appendChild(activeBlock.firstChild);
    if (!li.firstChild) li.appendChild(document.createElement('br'));
    list.appendChild(li);
    activeBlock.replaceWith(list);
    placeCaretAtEnd(li);
    return true;
  }

  if (act === 'todo') {
    const activeBlock = getActiveBlockElement(blockEl);
    if (activeBlock.tagName === 'LI') {
      const cb = findDirectTaskCheckbox(activeBlock);
      const list = activeBlock.closest('ul, ol');
      if (cb) {
        // Toggle task item off -> convert back to <p>
        const p = document.createElement('p');
        for (const child of Array.from(activeBlock.childNodes)) {
          if (child === cb) continue;
          p.appendChild(child);
        }
        p.normalize();
        if (p.firstChild?.nodeType === 3) {
          p.firstChild.nodeValue = p.firstChild.nodeValue.replace(/^\s+/, '');
        }
        if (!p.textContent && !p.firstChild) p.appendChild(document.createElement('br'));
        if (list && list.children.length <= 1) {
          list.replaceWith(p);
        } else {
          activeBlock.remove();
          list?.parentNode?.insertBefore(p, list.nextSibling);
        }
        placeCaretAtEnd(p);
        return true;
      }
      // Regular LI -> task LI
      const newCb = document.createElement('input');
      newCb.setAttribute('type', 'checkbox');
      newCb.type = 'checkbox';
      newCb.setAttribute('contenteditable', 'false');
      activeBlock.insertBefore(document.createTextNode(' '), activeBlock.firstChild);
      activeBlock.insertBefore(newCb, activeBlock.firstChild);
      placeCaretAtEnd(activeBlock);
      return true;
    }

    const rawText = (activeBlock.innerText || activeBlock.textContent || '').trim();
    const lines = rawText ? rawText.split(/\n+/).map((l) => l.trim()).filter(Boolean) : ['待办事项'];
    const ul = document.createElement('ul');
    let lastLi = null;
    for (const line of lines) {
      lastLi = createTaskListItem(line, false);
      ul.appendChild(lastLi);
    }
    activeBlock.replaceWith(ul);
    if (lastLi) placeCaretAtEnd(lastLi);
    return true;
  }

  if (act === 'codeblock') {
    const info = getSelectionRangeInside(blockEl);
    const existingPre = info
      ? findAncestorTagInside(info.range.startContainer, blockEl, 'PRE')
      : null;

    if (existingPre) {
      const p = document.createElement('p');
      p.textContent = existingPre.textContent || '';
      if (!p.textContent) p.appendChild(document.createElement('br'));
      existingPre.replaceWith(p);
      placeCaretAtEnd(p);
      return true;
    }

    const activeBlock = getActiveBlockElement(blockEl);
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    const txt = (activeBlock.innerText || activeBlock.textContent || '').replace(/\u00A0/g, ' ');
    code.textContent = txt.trim() ? txt : '';
    pre.appendChild(code);
    activeBlock.replaceWith(pre);
    placeCaretAtEnd(code);
    return true;
  }

  if (act === 'hr') {
    const activeBlock = getActiveBlockElement(blockEl);
    const hr = document.createElement('hr');
    const nextP = document.createElement('p');
    nextP.appendChild(document.createElement('br'));
    const isEmpty = !(activeBlock.textContent || '').trim() && !activeBlock.querySelector('img, button, input');
    if (isEmpty) {
      activeBlock.replaceWith(hr);
      hr.parentNode.insertBefore(nextP, hr.nextSibling);
    } else {
      activeBlock.parentNode.insertBefore(hr, activeBlock.nextSibling);
      hr.parentNode.insertBefore(nextP, hr.nextSibling);
    }
    placeCaretAtEnd(nextP);
    return true;
  }

  return false;
}
