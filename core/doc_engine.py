"""Document engine for SmartLocalNote (.md, .txt, .pdf, .xlsx metadata & AI text extraction).

Strictly uses lazy imports for `pymupdf` inside PDF functions and `core.excel_engine`
inside Excel text extraction to keep idle RAM < 80MB and cold start < 1s.
All local file access and writes pass through `core.safe_io`.
"""

from __future__ import annotations

from collections import OrderedDict
import os
from pathlib import Path
import re
import threading
from typing import Any

from config import get_default_notes_dir, load_config
from core import safe_io

_INVALID_FILENAME_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_PDF_PAGE_CACHE_MAX = 32
_PDF_PAGE_CACHE: OrderedDict[tuple[str, int, int, float], bytes] = OrderedDict()
_PDF_PAGE_CACHE_LOCK = threading.Lock()


def _truncate_head_tail(text: str, max_chars: int) -> str:
    if max_chars <= 0:
        return ""
    if len(text) <= max_chars:
        return text
    marker = "\n\n... [内容过长已截断] ...\n\n"
    if max_chars <= len(marker) + 20:
        return text[:max_chars]
    budget = max_chars - len(marker)
    head_len = int(budget * 0.65)
    tail_len = budget - head_len
    return text[:head_len] + marker + text[-tail_len:]


def _read_text_with_fallback(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _scan_dir_shallow(root: Path, max_depth: int = 3) -> list[Path]:
    """Scan supported documents up to `max_depth` without reading file contents."""
    found: list[Path] = []
    if not root.exists() or not root.is_dir():
        return found

    root_resolved = root.resolve()
    for dirpath, dirnames, filenames in os.walk(root_resolved):
        cur = Path(dirpath)
        try:
            depth = len(cur.relative_to(root_resolved).parts)
        except ValueError:
            depth = max_depth

        # Prune hidden directories and keep traversal strictly bounded
        dirnames[:] = sorted(
            d for d in dirnames
            if not d.startswith(".") and depth < max_depth
        )

        for fname in sorted(filenames):
            if fname.startswith("."):
                continue
            fpath = cur / fname
            if fpath.suffix.lower() in safe_io.SUPPORTED_DOC_EXTS:
                found.append(fpath)
    return found


def list_workspace_files() -> dict[str, Any]:
    """List mounted files/directories and default notes without opening file contents."""
    idx = safe_io.load_files_index()
    cfg = load_config()
    notes_dir = get_default_notes_dir().resolve()

    seen: dict[str, dict[str, Any]] = {}
    private_set: set[str] = set()
    for p in cfg.get("private_files", []):
        try:
            private_set.add(str(Path(p).expanduser().resolve()))
        except OSError:
            continue

    def _add_file(path: Path, source: str, group: str) -> None:
        try:
            resolved = path.resolve()
            if not resolved.exists() or not resolved.is_file():
                return
            ext = resolved.suffix.lower()
            if ext not in safe_io.SUPPORTED_DOC_EXTS:
                return
            key = str(resolved)
            if key in seen:
                return
            st = resolved.stat()
            seen[key] = {
                "path": key,
                "name": resolved.name,
                "ext": ext,
                "size": st.st_size,
                "mtime": st.st_mtime,
                "is_private": key in private_set,
                "source": source,
                "group": group,
            }
        except OSError:
            return

    # 1. Default notes directory
    for fpath in _scan_dir_shallow(notes_dir, max_depth=3):
        _add_file(fpath, source="notes", group=notes_dir.name)

    # 2. Mounted directories from files.json and whitelist_dirs
    dir_candidates: list[str] = list(idx.get("dirs", []))
    for wd in cfg.get("whitelist_dirs", []):
        if wd and wd not in dir_candidates:
            dir_candidates.append(wd)

    valid_dirs: list[str] = []
    for raw_dir in dir_candidates:
        if not raw_dir:
            continue
        try:
            dpath = Path(raw_dir).expanduser().resolve()
        except OSError:
            continue
        if not dpath.exists() or not dpath.is_dir():
            continue
        ds = str(dpath)
        if ds not in valid_dirs:
            valid_dirs.append(ds)
        for fpath in _scan_dir_shallow(dpath, max_depth=3):
            _add_file(fpath, source="mounted_dir", group=dpath.name)

    # 3. Explicitly imported individual files
    for raw_file in idx.get("files", []):
        if not raw_file:
            continue
        try:
            fpath = Path(raw_file).expanduser().resolve()
        except OSError:
            continue
        _add_file(fpath, source="imported", group=fpath.parent.name)

    items = sorted(
        seen.values(),
        key=lambda item: (item["source"] != "notes", item["group"].lower(), item["name"].lower()),
    )
    private_files = [item["path"] for item in items if item["is_private"]]

    return {
        "items": items,
        "dirs": valid_dirs,
        "private_files": private_files,
    }


def _sanitize_note_filename(title: str) -> str:
    cleaned = _INVALID_FILENAME_RE.sub("_", (title or "").strip())
    cleaned = cleaned.strip(" .")
    if not cleaned:
        cleaned = "未命名笔记"
    if cleaned.lower().endswith(".md"):
        cleaned = cleaned[:-3].strip(" .") or "未命名笔记"
    return cleaned


def create_note(title: str, content: str = "", node_id: str | None = None) -> dict[str, Any]:
    """Create a new `.md` note in default notes directory via `safe_io` and optionally bind to knowledge tree."""
    notes_dir = get_default_notes_dir()
    stem = _sanitize_note_filename(title)
    candidate = notes_dir / f"{stem}.md"
    counter = 2
    while candidate.exists():
        candidate = notes_dir / f"{stem}_{counter}.md"
        counter += 1

    body = content if content else f"# {stem}\n\n"
    safe_io.atomic_write_text(candidate, body, snapshot=False)

    if node_id:
        try:
            from core import tree_store

            tree_store.bind_file(node_id, str(candidate.resolve()))
        except Exception:
            pass

    resolved = candidate.resolve()
    return {
        "path": str(resolved),
        "name": resolved.name,
        "ext": ".md",
        "node_id": node_id,
    }


def companion_note_path_for_pdf(pdf_path: Path) -> Path:
    """Map a PDF file to its companion Markdown note inside default_notes_dir."""
    return (get_default_notes_dir() / f"{pdf_path.stem}_伴生笔记.md").resolve()


def read_document(path_str: str) -> dict[str, Any]:
    """Read `.md`/`.txt` text, `.pdf` metadata + companion note, or `.xlsx` metadata."""
    target = safe_io.resolve_safe_path(path_str, must_exist=True)
    ext = target.suffix.lower()
    is_priv = safe_io.is_private(target)
    snapshots = safe_io.list_snapshots(str(target))

    if ext in (".md", ".txt"):
        text = _read_text_with_fallback(target)
        return {
            "type": "markdown" if ext == ".md" else "text",
            "path": str(target),
            "name": target.name,
            "ext": ext,
            "content": text,
            "is_private": is_priv,
            "snapshots": snapshots,
        }

    if ext == ".pdf":
        import pymupdf

        doc = pymupdf.open(target)
        try:
            page_count = len(doc)
        finally:
            doc.close()

        companion_path = companion_note_path_for_pdf(target)
        companion_exists = companion_path.exists()
        if companion_exists:
            companion_content = _read_text_with_fallback(companion_path)
        else:
            companion_content = f"# {target.stem} 伴生笔记\n\n- [[{target.name}#page=1]] 开始阅读\n"

        return {
            "type": "pdf",
            "path": str(target),
            "name": target.name,
            "ext": ".pdf",
            "page_count": page_count,
            "companion_path": str(companion_path),
            "companion_content": companion_content,
            "companion_exists": companion_exists,
            "is_private": is_priv,
            "snapshots": snapshots,
        }

    if ext == ".xlsx":
        return {
            "type": "excel",
            "path": str(target),
            "name": target.name,
            "ext": ".xlsx",
            "is_private": is_priv,
            "snapshots": snapshots,
        }

    raise ValueError(f"不支持的文档格式：{ext or target.name}")


def write_text_document(path_str: str, content: str) -> dict[str, Any]:
    """Atomically write `.md`/`.txt` content with pre-write `.bak` snapshot."""
    target = safe_io.resolve_safe_path(path_str, must_exist=False)
    if target.suffix.lower() not in (".md", ".txt"):
        raise ValueError(f"仅支持写入 .md 或 .txt 文本文件：{target.name}")
    return safe_io.atomic_write_text(str(target), content, snapshot=True)


def extract_pdf_text(path_str: str, max_pages: int = 12, max_chars: int = 4000) -> str:
    """Lazily extract page text from a PDF using PyMuPDF with head+tail truncation."""
    import pymupdf

    target = safe_io.resolve_safe_path(path_str, must_exist=True)
    if target.suffix.lower() != ".pdf":
        raise ValueError(f"仅支持 .pdf 文件：{target.name}")

    doc = pymupdf.open(target)
    try:
        total_pages = len(doc)
        limit = min(total_pages, max(1, int(max_pages)))
        chunks: list[str] = []
        current_len = 0

        for idx in range(limit):
            page_text = (doc[idx].get_text("text") or "").strip()
            block = f"[第 {idx + 1} 页]\n{page_text}" if page_text else f"[第 {idx + 1} 页]\n（本页无文本层）"
            chunks.append(block)
            current_len += len(block) + 2
            # Stop early if we already gathered well beyond the head+tail budget
            if current_len > max_chars * 2 and idx + 1 >= 3:
                break

        if total_pages > limit:
            chunks.append(f"\n（PDF 共 {total_pages} 页，已抽取前 {limit} 页）")

        combined = "\n\n".join(chunks)
        return _truncate_head_tail(combined, max_chars)
    finally:
        doc.close()


def annotate_pdf(path_str: str, page: int, note_text: str) -> dict[str, Any]:
    """Add a text annotation to a PDF page using PyMuPDF and save atomically with snapshot."""
    import pymupdf

    cleaned_note = (note_text or "").strip()
    if not cleaned_note:
        raise ValueError("批注内容不能为空")

    target = safe_io.resolve_safe_path(path_str, must_exist=True)
    if target.suffix.lower() != ".pdf":
        raise ValueError(f"仅支持 .pdf 文件：{target.name}")

    doc = pymupdf.open(target)
    try:
        total_pages = len(doc)
        page_num = int(page)
        if page_num < 1 or page_num > total_pages:
            raise ValueError(f"页码越界：{page_num}（PDF 共 {total_pages} 页）")

        page_obj = doc[page_num - 1]
        page_obj.add_text_annot(pymupdf.Point(48, 48), cleaned_note)

        def _save_pdf(tmp_path: Path) -> None:
            doc.save(str(tmp_path), garbage=3, deflate=True)
            doc.close()

        save_res = safe_io.atomic_save_via_callback(target, _save_pdf, snapshot=True)
        return {
            "path": str(target),
            "page": page_num,
            "snapshot_id": save_res["snapshot_id"],
        }
    finally:
        if not doc.is_closed:
            doc.close()


def extract_text_for_ai(path_str: str, max_chars: int = 4000) -> str:
    """Enforce privacy lock first, then extract plain text for AI RAG across `.md`/`.txt`/`.pdf`/`.xlsx`."""
    target = safe_io.assert_not_private(path_str)
    ext = target.suffix.lower()

    if ext in (".md", ".txt"):
        text = _read_text_with_fallback(target)
        return _truncate_head_tail(text, max_chars)

    if ext == ".pdf":
        return extract_pdf_text(str(target), max_pages=12, max_chars=max_chars)

    if ext == ".xlsx":
        from core import excel_engine

        summary = excel_engine.extract_text_summary(str(target), max_rows=60, max_chars=max_chars)
        return _truncate_head_tail(summary, max_chars)

    raise ValueError(f"暂不支持为该格式抽取 AI 文本：{ext or target.name}")


def render_pdf_page_png(path_str: str, page: int = 1, zoom: float = 1.6) -> bytes:
    """Render a PDF page as crisp PNG bytes using lazy PyMuPDF with a 32-entry LRU cache."""
    target = safe_io.resolve_safe_path(path_str, must_exist=True)
    if target.suffix.lower() != ".pdf":
        raise ValueError(f"仅支持 .pdf 文件：{target.name}")

    zoom_clamped = round(max(0.5, min(3.0, float(zoom))), 2)
    req_page = max(1, int(page))
    mtime_ns = target.stat().st_mtime_ns
    cache_key = (str(target), mtime_ns, req_page, zoom_clamped)

    with _PDF_PAGE_CACHE_LOCK:
        cached = _PDF_PAGE_CACHE.get(cache_key)
        if cached is not None:
            _PDF_PAGE_CACHE.move_to_end(cache_key)
            return cached

    import pymupdf

    with pymupdf.open(target) as doc:
        if len(doc) == 0:
            raise ValueError(f"PDF 文件为空：{target.name}")
        page_idx = max(0, min(len(doc) - 1, req_page - 1))
        pix = doc[page_idx].get_pixmap(matrix=pymupdf.Matrix(zoom_clamped, zoom_clamped), alpha=False)
        png_bytes = pix.tobytes("png")

    with _PDF_PAGE_CACHE_LOCK:
        _PDF_PAGE_CACHE[cache_key] = png_bytes
        _PDF_PAGE_CACHE.move_to_end(cache_key)
        while len(_PDF_PAGE_CACHE) > _PDF_PAGE_CACHE_MAX:
            _PDF_PAGE_CACHE.popitem(last=False)

    return png_bytes
