"""Dual-mode local search engine for SmartLocalNote (Keyword + AI Semantic Description).

Pure core logic (zero FastAPI/HTTP imports, zero heavy vector databases):
- Lightweight mtime-keyed in-memory chunk cache (`_DOC_CHUNK_CACHE`) across `.md`/`.txt`/`.pdf`/`.xlsx`.
- All local disk reads go through `core.safe_io.resolve_safe_path`.
- Keyword mode: multi-term full-text scoring + filename bonus + concise ±55-char snippets.
- Semantic mode: strictly skips `safe_io.is_private` files, scores via Chinese+English
  character bigrams, word tokens, and domain synonym groups, then optionally reranks top
  candidates via `core.ai_service.semantic_rerank` with seamless local fallback.
"""

from __future__ import annotations

from pathlib import Path
import re
import threading
from typing import Any

from core import doc_engine, safe_io

# path_str -> (mtime_ns, list[chunk_dict])
_DOC_CHUNK_CACHE: dict[str, tuple[int, list[dict[str, Any]]]] = {}
_CHUNK_CACHE_LOCK = threading.Lock()

_PDF_MAX_PAGES = 40
_XLSX_MAX_ROWS_PER_SHEET = 120
_TEXT_CHUNK_TARGET = 260
_TEXT_INDEX_MAX_BYTES = 512 * 1024

_SYNONYM_GROUPS: tuple[tuple[str, ...], ...] = (
    ("错题", "错因", "做错", "错误", "易错", "卡壳", "失误", "重做", "复盘"),
    ("进度", "完成率", "正确率", "刷题", "统计", "表格", "记录", "情况", "比例"),
    ("公式", "定理", "展开", "推导", "证明", "法则", "积分", "极限", "泰勒", "中值"),
    ("待办", "任务", "计划", "提醒", "安排", "要做", "截止", "ddl", "今晚"),
    ("总结", "摘要", "重点", "核心", "复习", "考点", "讲义", "笔记", "速查"),
    ("软件", "程序", "应用", "打开", "启动", "工具", "计算器", "wps", "记事本"),
)

_SYNONYM_LOOKUP: dict[str, tuple[int, tuple[str, ...]]] = {}
for _gid, _grp in enumerate(_SYNONYM_GROUPS):
    for _term in _grp:
        _SYNONYM_LOOKUP[_term.lower()] = (_gid, _grp)


def _read_text_file(target: Path, max_bytes: int | None = None) -> str:
    if max_bytes is not None and max_bytes > 0:
        with open(target, "rb") as fh:
            raw = fh.read(max_bytes)
    else:
        raw = target.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _make_chunk(
    *,
    path: str,
    name: str,
    ext: str,
    chunk_text: str,
    anchor: str | None = None,
    page: int | None = None,
    sheet: str | None = None,
    cell: str | None = None,
    line: int | None = None,
) -> dict[str, Any]:
    return {
        "path": path,
        "name": name,
        "ext": ext,
        "chunk_text": chunk_text,
        "anchor": anchor,
        "page": page,
        "sheet": sheet,
        "cell": cell,
        "line": line,
    }


def _chunk_text_document(target: Path) -> list[dict[str, Any]]:
    text = _read_text_file(target, max_bytes=_TEXT_INDEX_MAX_BYTES)
    if not text.strip():
        return []

    path_str = str(target)
    name = target.name
    ext = target.suffix.lower()
    lines = text.splitlines()

    # Group into logical paragraphs / heading sections first
    blocks: list[tuple[int, str]] = []
    cur_lines: list[str] = []
    cur_start = 1

    for idx, raw_line in enumerate(lines, start=1):
        stripped = raw_line.strip()
        is_heading = bool(re.match(r"^#{1,6}\s+", stripped))
        if is_heading and cur_lines:
            joined = "\n".join(cur_lines).strip()
            if joined:
                blocks.append((cur_start, joined))
            cur_lines = [raw_line]
            cur_start = idx
        elif not stripped:
            if cur_lines:
                joined = "\n".join(cur_lines).strip()
                if joined:
                    blocks.append((cur_start, joined))
                cur_lines = []
        else:
            if not cur_lines:
                cur_start = idx
            cur_lines.append(raw_line)

    if cur_lines:
        joined = "\n".join(cur_lines).strip()
        if joined:
            blocks.append((cur_start, joined))

    # Merge small adjacent blocks or split oversized blocks around ~260 chars
    chunks: list[dict[str, Any]] = []
    buf_text = ""
    buf_start: int | None = None

    def _flush() -> None:
        nonlocal buf_text, buf_start
        cleaned = buf_text.strip()
        if cleaned and buf_start is not None:
            chunks.append(
                _make_chunk(
                    path=path_str,
                    name=name,
                    ext=ext,
                    chunk_text=cleaned,
                    anchor=None,
                    line=buf_start,
                )
            )
        buf_text = ""
        buf_start = None

    for start_line, block_text in blocks:
        if len(block_text) > _TEXT_CHUNK_TARGET:
            _flush()
            pos = 0
            line_offset = 0
            while pos < len(block_text):
                part = block_text[pos : pos + _TEXT_CHUNK_TARGET].strip()
                if part:
                    chunks.append(
                        _make_chunk(
                            path=path_str,
                            name=name,
                            ext=ext,
                            chunk_text=part,
                            anchor=None,
                            line=start_line + line_offset,
                        )
                    )
                line_offset += block_text[pos : pos + _TEXT_CHUNK_TARGET].count("\n")
                pos += _TEXT_CHUNK_TARGET
            continue

        if buf_text and len(buf_text) + 1 + len(block_text) > _TEXT_CHUNK_TARGET:
            _flush()

        if buf_start is None:
            buf_start = start_line
        buf_text = f"{buf_text}\n{block_text}".strip() if buf_text else block_text

    _flush()
    return chunks


def _chunk_pdf_document(target: Path) -> list[dict[str, Any]]:
    import pymupdf

    path_str = str(target)
    name = target.name
    chunks: list[dict[str, Any]] = []

    with pymupdf.open(target) as doc:
        limit = min(len(doc), _PDF_MAX_PAGES)
        for idx in range(limit):
            page_num = idx + 1
            text = (doc[idx].get_text("text") or "").strip()
            if not text:
                continue
            chunks.append(
                _make_chunk(
                    path=path_str,
                    name=name,
                    ext=".pdf",
                    chunk_text=text,
                    anchor=f"[[{name}#page={page_num}]]",
                    page=page_num,
                )
            )
    return chunks


def _chunk_xlsx_document(target: Path) -> list[dict[str, Any]]:
    import openpyxl

    path_str = str(target)
    name = target.name
    chunks: list[dict[str, Any]] = []

    wb = openpyxl.load_workbook(target, read_only=True, data_only=True)
    try:
        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            headers: list[str] = []
            for row_num, row in enumerate(ws.iter_rows(values_only=True), start=1):
                if row_num > _XLSX_MAX_ROWS_PER_SHEET:
                    break
                vals = ["" if v is None else str(v).replace("\n", " ").strip() for v in row]
                if not any(vals):
                    continue
                if row_num == 1:
                    headers = vals
                    row_text = f"[{sheet_name}] 表头: " + " | ".join(v for v in vals if v)
                else:
                    pairs: list[str] = []
                    for col_idx, val in enumerate(vals):
                        if not val:
                            continue
                        hdr = headers[col_idx] if col_idx < len(headers) and headers[col_idx] else f"列{col_idx + 1}"
                        pairs.append(f"{hdr}: {val}")
                    row_text = f"[{sheet_name} 第{row_num}行] " + " | ".join(pairs)

                cell_ref = f"A{row_num}"
                chunks.append(
                    _make_chunk(
                        path=path_str,
                        name=name,
                        ext=".xlsx",
                        chunk_text=row_text,
                        anchor=f"[[{name}#{sheet_name}!{cell_ref}]]",
                        sheet=sheet_name,
                        cell=cell_ref,
                        line=row_num,
                    )
                )
    finally:
        wb.close()
    return chunks


def _chunk_office_document(target: Path) -> list[dict[str, Any]]:
    md = doc_engine._extract_office_preview_markdown(target).strip()
    if not md or md in (
        "（DOCX 文档中未找到正文 XML 内容）",
        "（DOCX 文档暂无可提取的纯文本段落）",
        "（PPTX 演示文稿暂无可提取的文本内容）",
    ):
        return []

    path_str = str(target)
    name = target.name
    ext = target.suffix.lower()
    chunks: list[dict[str, Any]] = []

    if ext == ".pptx":
        sections = re.split(r"(?=^## Slide \d+\b)", md, flags=re.MULTILINE)
        for sec in sections:
            part = sec.strip()
            if not part:
                continue
            m = re.match(r"^## Slide (\d+)\b", part)
            anchor = f"[[{name}#Slide {m.group(1)}]]" if m else f"[[{name}]]"
            line_num = int(m.group(1)) if m else None
            for pos in range(0, len(part), _TEXT_CHUNK_TARGET):
                sub = part[pos : pos + _TEXT_CHUNK_TARGET].strip()
                if sub:
                    chunks.append(
                        _make_chunk(
                            path=path_str,
                            name=name,
                            ext=ext,
                            chunk_text=sub,
                            anchor=anchor,
                            line=line_num,
                        )
                    )
        return chunks

    buf = ""
    for para in re.split(r"\n{2,}", md):
        p = para.strip()
        if not p:
            continue
        if buf and len(buf) + 2 + len(p) > _TEXT_CHUNK_TARGET:
            chunks.append(_make_chunk(path=path_str, name=name, ext=ext, chunk_text=buf, anchor=f"[[{name}]]"))
            buf = ""
        if len(p) > _TEXT_CHUNK_TARGET:
            for pos in range(0, len(p), _TEXT_CHUNK_TARGET):
                sub = p[pos : pos + _TEXT_CHUNK_TARGET].strip()
                if sub:
                    chunks.append(_make_chunk(path=path_str, name=name, ext=ext, chunk_text=sub, anchor=f"[[{name}]]"))
        else:
            buf = f"{buf}\n\n{p}" if buf else p
    if buf:
        chunks.append(_make_chunk(path=path_str, name=name, ext=ext, chunk_text=buf, anchor=f"[[{name}]]"))
    return chunks


def _get_file_chunks(path_str: str) -> list[dict[str, Any]]:
    """Return mtime-cached chunks for an authorized file via `core.safe_io`."""
    try:
        target = safe_io.resolve_safe_path(path_str, must_exist=True)
        mtime_ns = target.stat().st_mtime_ns
    except (OSError, PermissionError, FileNotFoundError, ValueError):
        return []

    key = str(target)
    with _CHUNK_CACHE_LOCK:
        cached = _DOC_CHUNK_CACHE.get(key)
        if cached is not None and cached[0] == mtime_ns:
            return cached[1]

    ext = target.suffix.lower()
    try:
        if ext in safe_io.TEXT_EDIT_EXTS:
            chunks = _chunk_text_document(target)
        elif ext == ".pdf":
            chunks = _chunk_pdf_document(target)
        elif ext == ".xlsx":
            chunks = _chunk_xlsx_document(target)
        elif ext in safe_io.OFFICE_PREVIEW_EXTS:
            chunks = _chunk_office_document(target)
        else:
            chunks = []
    except Exception:
        chunks = []

    with _CHUNK_CACHE_LOCK:
        _DOC_CHUNK_CACHE[key] = (mtime_ns, chunks)
    return chunks


def _extract_snippet(text: str, terms: list[str], radius: int = 55) -> str:
    clean = re.sub(r"\s+", " ", text).strip()
    if not clean:
        return ""
    low = clean.lower()
    best_pos = -1
    for term in terms:
        pos = low.find(term)
        if pos != -1 and (best_pos == -1 or pos < best_pos):
            best_pos = pos

    if best_pos == -1:
        return clean[: radius * 2] + ("..." if len(clean) > radius * 2 else "")

    start = max(0, best_pos - radius)
    end = min(len(clean), best_pos + radius)
    prefix = "..." if start > 0 else ""
    suffix = "..." if end < len(clean) else ""
    return f"{prefix}{clean[start:end]}{suffix}"


def _tokenize_semantic(text: str) -> tuple[set[str], set[str], set[int], list[str]]:
    """Extract lowercase word tokens, 2-char Chinese/mixed bigrams, and matched synonym group IDs."""
    low = (text or "").lower()
    words = {w for w in re.findall(r"[a-z0-9_]+|[\u4e00-\u9fff]{2,}", low) if len(w) >= 2}

    bigrams: set[str] = set()
    for seg in re.findall(r"[\u4e00-\u9fff]+", low):
        if len(seg) == 1:
            bigrams.add(seg)
        else:
            for i in range(len(seg) - 1):
                bigrams.add(seg[i : i + 2])

    syn_ids: set[int] = set()
    syn_hits: list[str] = []
    for term, (gid, _grp) in _SYNONYM_LOOKUP.items():
        if term in low:
            syn_ids.add(gid)
            if term not in syn_hits:
                syn_hits.append(term)

    return words, bigrams, syn_ids, syn_hits


def _keyword_search(query: str, limit: int) -> dict[str, Any]:
    terms = [t.lower() for t in re.split(r"\s+", query) if t.strip()]
    if not terms:
        terms = [query.lower()]

    workspace = doc_engine.list_workspace_files()
    items = workspace.get("items", [])

    scored: list[dict[str, Any]] = []
    for item in items:
        fpath = str(item.get("path") or "")
        if not fpath:
            continue
        chunks = _get_file_chunks(fpath)
        fname_low = str(item.get("name") or "").lower()
        name_bonus = sum(3.0 for t in terms if t in fname_low)

        for chunk in chunks:
            text_low = chunk["chunk_text"].lower()
            matched_terms = [t for t in terms if t in text_low or t in fname_low]
            if not matched_terms:
                continue

            tf_score = sum(float(text_low.count(t)) * 2.0 for t in terms if t in text_low)
            all_bonus = 6.0 if len(matched_terms) == len(terms) else 0.0
            score = round(tf_score + all_bonus + name_bonus, 3)

            scored.append({
                "path": chunk["path"],
                "name": chunk["name"],
                "ext": chunk["ext"],
                "score": score,
                "snippet": _extract_snippet(chunk["chunk_text"], matched_terms, radius=55),
                "anchor": chunk["anchor"],
                "page": chunk["page"],
                "sheet": chunk["sheet"],
                "cell": chunk["cell"],
                "line": chunk["line"],
                "matched_terms": matched_terms,
                "reason": f"关键词命中：{'、'.join(matched_terms[:4])}",
            })

    scored.sort(key=lambda r: (-r["score"], r["name"], r["page"] or r["line"] or 0))
    return {
        "mode": "keyword",
        "query": query,
        "engine": "local_keyword",
        "total": len(scored),
        "skipped_private": 0,
        "results": scored[:limit],
    }


def _score_semantic_chunk(
    query: str,
    q_words: set[str],
    q_bigrams: set[str],
    q_syn_ids: set[int],
    chunk: dict[str, Any],
) -> tuple[float, str, list[str]]:
    text = chunk["chunk_text"]
    name_low = chunk["name"].lower()
    full_text = f"{chunk['name']} {text}"
    c_words, c_bigrams, c_syn_ids, c_syn_hits = _tokenize_semantic(full_text)

    q_low = query.lower()
    exact_phrase_bonus = 10.0 if q_low in full_text.lower() else 0.0

    # Direct word token & query substring matches
    word_overlap = sorted(q_words & c_words)
    word_score = float(len(word_overlap)) * 3.2

    # Chinese character bigram overlap
    bigram_overlap = q_bigrams & c_bigrams
    bigram_ratio = (len(bigram_overlap) / max(1, len(q_bigrams))) if q_bigrams else 0.0
    bigram_score = float(len(bigram_overlap)) * 1.4 + bigram_ratio * 4.0

    # Domain synonym group expansion
    shared_syn_ids = q_syn_ids & c_syn_ids
    syn_terms: list[str] = []
    for gid in sorted(shared_syn_ids):
        for term in _SYNONYM_GROUPS[gid]:
            if term.lower() in full_text.lower() and term not in syn_terms:
                syn_terms.append(term)
                if len(syn_terms) >= 4:
                    break
    syn_score = float(len(shared_syn_ids)) * 4.5 + float(len(syn_terms)) * 0.8

    # Filename hint
    fname_hits = [w for w in q_words if w in name_low]
    fname_bonus = float(len(fname_hits)) * 2.0

    total = round(exact_phrase_bonus + word_score + bigram_score + syn_score + fname_bonus, 3)

    reason_parts: list[str] = []
    if word_overlap:
        reason_parts.append("命中词 " + "/".join(word_overlap[:3]))
    if syn_terms:
        reason_parts.append("近义概念 " + "/".join(syn_terms[:3]))
    if not reason_parts and bigram_overlap:
        sample_bg = sorted(bigram_overlap)[:3]
        reason_parts.append("字面语义重合 " + "/".join(sample_bg))

    reason = (
        f"语义关联：{'；'.join(reason_parts)}"
        if reason_parts
        else "语义关联：与当前描述存在上下文相关性"
    )
    hit_tokens = list(dict.fromkeys([*word_overlap, *syn_terms]))
    return total, reason, hit_tokens


async def _semantic_search(query: str, limit: int) -> dict[str, Any]:
    workspace = doc_engine.list_workspace_files()
    items = workspace.get("items", [])

    q_words, q_bigrams, q_syn_ids, _ = _tokenize_semantic(query)
    raw_terms = [t.lower() for t in re.split(r"\s+", query) if t.strip()]
    q_words_all = q_words | set(raw_terms)

    skipped_private = 0
    scored_chunks: list[dict[str, Any]] = []

    for item in items:
        fpath = str(item.get("path") or "")
        if not fpath:
            continue
        if safe_io.is_private(fpath):
            skipped_private += 1
            continue

        chunks = _get_file_chunks(fpath)
        for chunk in chunks:
            score, reason, hit_tokens = _score_semantic_chunk(
                query,
                q_words_all,
                q_bigrams,
                q_syn_ids,
                chunk,
            )
            if score <= 0:
                continue

            snippet_terms = hit_tokens or raw_terms
            scored_chunks.append({
                "path": chunk["path"],
                "name": chunk["name"],
                "ext": chunk["ext"],
                "score": score,
                "snippet": _extract_snippet(chunk["chunk_text"], [t.lower() for t in snippet_terms], radius=55),
                "anchor": chunk["anchor"],
                "page": chunk["page"],
                "sheet": chunk["sheet"],
                "cell": chunk["cell"],
                "line": chunk["line"],
                "chunk_text": chunk["chunk_text"],
                "reason": reason,
            })

    scored_chunks.sort(key=lambda r: (-r["score"], r["name"], r["page"] or r["line"] or 0))
    candidates = scored_chunks[:16]

    engine = "local_semantic"
    provider_label = "本地中文语义近义词引擎"

    if candidates:
        try:
            from core import ai_service

            rerank_fn = getattr(ai_service, "semantic_rerank", None)
            if callable(rerank_fn):
                ai_resp = await rerank_fn(query, candidates, limit=limit)
                if isinstance(ai_resp, dict):
                    reranked = ai_resp.get("results")
                    if isinstance(reranked, list) and reranked:
                        merged: list[dict[str, Any]] = []
                        by_idx = {i: c for i, c in enumerate(candidates)}
                        by_anchor_or_path = {
                            (c["path"], c.get("anchor"), c.get("line")): c for c in candidates
                        }
                        used_keys: set[tuple[Any, ...]] = set()
                        for item in reranked:
                            if not isinstance(item, dict):
                                continue
                            base = None
                            if isinstance(item.get("index"), int) and item["index"] in by_idx:
                                base = by_idx[item["index"]]
                            else:
                                k = (item.get("path"), item.get("anchor"), item.get("line"))
                                base = by_anchor_or_path.get(k)
                            if base is None:
                                continue
                            uk = (base["path"], base.get("anchor"), base.get("line"))
                            if uk in used_keys:
                                continue
                            used_keys.add(uk)
                            entry = dict(base)
                            if isinstance(item.get("score"), (int, float)):
                                entry["score"] = round(float(item["score"]), 3)
                            if str(item.get("reason") or "").strip():
                                entry["reason"] = str(item["reason"]).strip()
                            merged.append(entry)
                        if merged:
                            candidates = merged
                            if not ai_resp.get("offline_mode", False):
                                engine = "ai_semantic"
                                provider_label = str(ai_resp.get("provider_label") or "AI 语义重排")
        except Exception:
            pass

    final_results: list[dict[str, Any]] = []
    for c in candidates[:limit]:
        clean_item = {k: v for k, v in c.items() if k != "chunk_text"}
        final_results.append(clean_item)

    return {
        "mode": "semantic",
        "query": query,
        "engine": engine,
        "provider_label": provider_label,
        "total": len(scored_chunks),
        "skipped_private": skipped_private,
        "results": final_results,
    }


async def search_workspace(query: str, mode: str = "keyword", limit: int = 15) -> dict[str, Any]:
    """Search workspace files in `keyword` (full-text) or `semantic` (AI/synonym) mode."""
    clean_query = (query or "").strip()
    if not clean_query:
        raise ValueError("搜索关键词或语义描述不能为空")

    safe_limit = max(1, min(50, int(limit)))
    normalized_mode = (mode or "keyword").strip().lower()
    if normalized_mode not in ("keyword", "semantic"):
        raise ValueError(f"不支持的搜索模式：{mode}")

    if normalized_mode == "semantic":
        return await _semantic_search(clean_query, safe_limit)
    return _keyword_search(clean_query, safe_limit)


def find_backlinks(path_str: str) -> dict[str, Any]:
    """Scan workspace .md/.txt files for `[[<target.name>` backlinks (case-insensitive)."""
    target = safe_io.resolve_safe_path(path_str)
    target_key = str(target.resolve())
    target_name = target.name
    pattern = re.compile(
        r"\[\[" + re.escape(target_name) + r"(?:[#!\|\]])",
        re.IGNORECASE,
    )

    workspace = doc_engine.list_workspace_files()
    backlinks: list[dict[str, Any]] = []

    for item in workspace.get("items", []):
        fpath = str(item.get("path") or "")
        ext = str(item.get("ext") or "").lower()
        if not fpath or ext not in (".md", ".txt"):
            continue
        try:
            src = safe_io.resolve_safe_path(fpath, must_exist=True)
        except (OSError, PermissionError, FileNotFoundError, ValueError):
            continue
        if str(src.resolve()) == target_key:
            continue

        try:
            text = _read_text_file(src)
        except OSError:
            continue

        for line_no, raw_line in enumerate(text.splitlines(), start=1):
            if pattern.search(raw_line):
                clean_line = re.sub(r"\s+", " ", raw_line).strip()
                snippet = clean_line[:160] + ("..." if len(clean_line) > 160 else "")
                backlinks.append({
                    "path": str(src),
                    "name": src.name,
                    "ext": ext,
                    "snippet": snippet,
                    "line": line_no,
                })
                break

    return {
        "target": target_name,
        "count": len(backlinks),
        "backlinks": backlinks,
    }
