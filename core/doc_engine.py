"""Document engine for SmartLocalNote (multi-format preview, virtual archives, companion notes & AI extraction).

Strictly uses lazy imports for `pymupdf` inside PDF functions and `core.excel_engine`
inside Excel text extraction to keep idle RAM < 80MB and cold start < 1s.
All local file access and writes pass through `core.safe_io`.
"""

from __future__ import annotations

import base64
from collections import OrderedDict
import csv
import io
import json
import mimetypes
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import threading
from typing import Any
import webbrowser
import xml.etree.ElementTree as ET
import zipfile

from config import (
    APPS_FILE,
    DATA_DIR,
    TREE_FILE,
    atomic_write_json,
    get_default_notes_dir,
    load_config,
    save_config,
)
from core import safe_io

_INVALID_FILENAME_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_PDF_PAGE_CACHE_MAX = 32
_PDF_PAGE_CACHE: OrderedDict[tuple[str, int, int, float], bytes] = OrderedDict()
_PDF_PAGE_CACHE_LOCK = threading.Lock()
_ARCHIVE_MAX_ENTRIES = 300
_ARCHIVE_PREVIEW_MAX_BYTES = 512 * 1024
_OFFICE_PREVIEW_MAX_CHARS = 30000

_EXTRA_MIME_TYPES = {
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".aac": "audio/aac",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".m4v": "video/x-m4v",
    ".avi": "video/x-msvideo",
}


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

    def _add_file(path: Path, source: str, group: str, *, allow_any_ext: bool = False) -> None:
        try:
            resolved = path.resolve()
            if not resolved.exists() or not resolved.is_file():
                return
            ext = resolved.suffix.lower()
            if not allow_any_ext and ext not in safe_io.SUPPORTED_DOC_EXTS:
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

    # 3. Explicitly imported individual files (allow ANY extension)
    for raw_file in idx.get("files", []):
        if not raw_file:
            continue
        try:
            fpath = Path(raw_file).expanduser().resolve()
        except OSError:
            continue
        _add_file(fpath, source="imported", group=fpath.parent.name, allow_any_ext=True)

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


def companion_note_path_for(target_path: Path) -> Path:
    """Map a file to its companion Markdown note inside default_notes_dir without cross-format collisions."""
    notes_dir = get_default_notes_dir()
    ext = target_path.suffix.lower()
    if ext == ".pdf" or not ext:
        return (notes_dir / f"{target_path.stem}_伴生笔记.md").resolve()

    ext_no_dot = re.sub(r"[^a-zA-Z0-9_-]", "", ext.lstrip(".")) or "file"
    typed_path = (notes_dir / f"{target_path.stem}_{ext_no_dot}_伴生笔记.md").resolve()
    if typed_path.exists():
        return typed_path

    same_stem_pdf = target_path.with_suffix(".pdf")
    legacy_path = (notes_dir / f"{target_path.stem}_伴生笔记.md").resolve()
    if not same_stem_pdf.exists() and legacy_path.exists():
        try:
            legacy_text = _read_text_with_fallback(legacy_path)
            if f"[[{target_path.name}" in legacy_text and f"[[{target_path.stem}.pdf" not in legacy_text:
                return legacy_path
        except OSError:
            pass

    return typed_path


def companion_note_path_for_pdf(pdf_path: Path) -> Path:
    """Backward-compatible wrapper mapping a file to its companion Markdown note."""
    return companion_note_path_for(pdf_path)


def guess_mime_type(path: Path | str) -> str:
    """Guess a clean MIME type for media/document streaming."""
    ext = Path(path).suffix.lower()
    if ext in _EXTRA_MIME_TYPES:
        return _EXTRA_MIME_TYPES[ext]
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "application/octet-stream"


def _load_companion_note(target: Path) -> tuple[Path, str, bool]:
    companion_path = companion_note_path_for_pdf(target)
    companion_exists = companion_path.exists()
    if companion_exists:
        companion_content = _read_text_with_fallback(companion_path)
    else:
        ext = target.suffix.lower()
        default_link = f"[[{target.name}#page=1]]" if ext == ".pdf" else f"[[{target.name}]]"
        companion_content = f"# {target.stem} 伴生笔记\n\n- {default_link} 开始阅读\n"
    return companion_path, companion_content, companion_exists


def _decode_bytes_with_fallback(raw: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _decode_zip_member_name(info: zipfile.ZipInfo) -> str:
    raw_name = info.filename
    if info.flag_bits & 0x800:
        return raw_name
    try:
        raw_bytes = raw_name.encode("cp437")
    except UnicodeEncodeError:
        return raw_name
    for enc in ("utf-8", "gb18030", "gbk"):
        try:
            return raw_bytes.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw_name


def _is_archive_member_previewable(member_name: str, size: int, is_dir: bool) -> bool:
    if is_dir or size > _ARCHIVE_PREVIEW_MAX_BYTES:
        return False
    ext = Path(member_name).suffix.lower()
    return ext in safe_io.TEXT_EDIT_EXTS or ext in safe_io.IMAGE_EXTS


def _inspect_archive(target: Path) -> dict[str, Any]:
    """Inspect .zip / .tar / .tgz / .gz virtual tree completely in memory without disk extraction."""
    ext = target.suffix.lower()
    entries: list[dict[str, Any]] = []
    total_entries = 0
    total_uncompressed_size = 0

    if ext == ".zip":
        try:
            with zipfile.ZipFile(target, "r") as zf:
                infos = zf.infolist()
                total_entries = len(infos)
                for info in infos:
                    is_dir = info.is_dir()
                    if not is_dir:
                        total_uncompressed_size += int(info.file_size)
                    if len(entries) < _ARCHIVE_MAX_ENTRIES:
                        name = _decode_zip_member_name(info)
                        entries.append({
                            "name": name,
                            "size": int(info.file_size),
                            "compressed_size": int(info.compress_size),
                            "is_dir": is_dir,
                            "previewable": _is_archive_member_previewable(name, int(info.file_size), is_dir),
                        })
        except zipfile.BadZipFile as exc:
            raise ValueError(f"无法读取 ZIP 压缩包：{exc}") from exc
    else:
        is_tar_like = ext in (".tar", ".tgz") or target.name.lower().endswith(".tar.gz")
        if is_tar_like:
            try:
                with tarfile.open(target, "r:*") as tf:
                    members = tf.getmembers()
                    total_entries = len(members)
                    for m in members:
                        is_dir = m.isdir()
                        if not is_dir:
                            total_uncompressed_size += int(m.size)
                        if len(entries) < _ARCHIVE_MAX_ENTRIES:
                            entries.append({
                                "name": m.name,
                                "size": int(m.size),
                                "compressed_size": int(m.size),
                                "is_dir": is_dir,
                                "previewable": _is_archive_member_previewable(m.name, int(m.size), is_dir),
                            })
            except tarfile.TarError as exc:
                raise ValueError(f"无法读取 TAR 压缩包：{exc}") from exc
        elif ext == ".gz":
            import gzip

            inner_name = target.stem or "content.txt"
            size = 0
            try:
                with gzip.open(target, "rb") as gz:
                    while True:
                        chunk = gz.read(65536)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > 16 * 1024 * 1024:
                            break
            except OSError as exc:
                raise ValueError(f"无法读取 GZ 压缩文件：{exc}") from exc
            total_entries = 1
            total_uncompressed_size = size
            entries.append({
                "name": inner_name,
                "size": size,
                "compressed_size": int(target.stat().st_size),
                "is_dir": False,
                "previewable": _is_archive_member_previewable(inner_name, size, False),
            })

    return {
        "entries": entries,
        "total_entries": total_entries,
        "total_uncompressed_size": total_uncompressed_size,
        "truncated": total_entries > _ARCHIVE_MAX_ENTRIES,
    }


def _extract_office_preview_markdown(target: Path, max_chars: int = _OFFICE_PREVIEW_MAX_CHARS) -> str:
    """Extract readable paragraphs/slides from .docx or .pptx using stdlib zipfile + ElementTree."""
    ext = target.suffix.lower()
    limit = max(200, int(max_chars or _OFFICE_PREVIEW_MAX_CHARS))
    try:
        with zipfile.ZipFile(target, "r") as zf:
            if ext == ".docx":
                if "word/document.xml" not in zf.namelist():
                    return "（DOCX 文档中未找到正文 XML 内容）"
                xml_bytes = zf.read("word/document.xml")
                root = ET.fromstring(xml_bytes)
                paragraphs: list[str] = []
                for elem in root.iter():
                    if elem.tag.endswith("}p") or elem.tag == "p":
                        texts = [
                            node.text for node in elem.iter()
                            if (node.tag.endswith("}t") or node.tag == "t") and node.text
                        ]
                        line = "".join(texts).strip()
                        if line:
                            paragraphs.append(line)
                combined = "\n\n".join(paragraphs) if paragraphs else "（DOCX 文档暂无可提取的纯文本段落）"
                return combined[:limit]

            if ext == ".pptx":
                slide_names = [
                    n for n in zf.namelist()
                    if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)
                ]
                slide_names.sort(key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)))
                slides_md: list[str] = []
                for s_idx, s_name in enumerate(slide_names, start=1):
                    root = ET.fromstring(zf.read(s_name))
                    lines: list[str] = []
                    for elem in root.iter():
                        if elem.tag.endswith("}p") or elem.tag == "p":
                            texts = [
                                node.text for node in elem.iter()
                                if (node.tag.endswith("}t") or node.tag == "t") and node.text
                            ]
                            line = "".join(texts).strip()
                            if line:
                                lines.append(line)
                    body = "\n".join(f"- {ln}" for ln in lines) if lines else "（本页暂无文本）"
                    slides_md.append(f"## Slide {s_idx}\n{body}")
                combined = "\n\n".join(slides_md) if slides_md else "（PPTX 演示文稿暂无可提取的文本内容）"
                return combined[:limit]
    except (zipfile.BadZipFile, ET.ParseError, OSError) as exc:
        raise ValueError(f"无法解析 Office 文档：{exc}") from exc

    return ""


def read_document(path_str: str) -> dict[str, Any]:
    """Read multi-format document metadata, text content, virtual archive tree, or Office preview."""
    target = safe_io.resolve_safe_path(path_str, must_exist=True)
    ext = target.suffix.lower()
    st = target.stat()
    is_priv = safe_io.is_private(target)
    snapshots = safe_io.list_snapshots(str(target))

    if ext in safe_io.TEXT_EDIT_EXTS:
        text = _read_text_with_fallback(target)
        return {
            "type": "markdown" if ext == ".md" else "text",
            "path": str(target),
            "name": target.name,
            "ext": ext,
            "size": st.st_size,
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

        companion_path, companion_content, companion_exists = _load_companion_note(target)
        return {
            "type": "pdf",
            "path": str(target),
            "name": target.name,
            "ext": ".pdf",
            "size": st.st_size,
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
            "size": st.st_size,
            "is_private": is_priv,
            "snapshots": snapshots,
        }

    if ext in safe_io.IMAGE_EXTS:
        companion_path, companion_content, _ = _load_companion_note(target)
        return {
            "type": "image",
            "path": str(target),
            "name": target.name,
            "ext": ext,
            "size": st.st_size,
            "mime": guess_mime_type(target),
            "companion_path": str(companion_path),
            "companion_content": companion_content,
            "is_private": is_priv,
        }

    if ext in safe_io.AUDIO_EXTS:
        companion_path, companion_content, _ = _load_companion_note(target)
        return {
            "type": "audio",
            "path": str(target),
            "name": target.name,
            "ext": ext,
            "size": st.st_size,
            "mime": guess_mime_type(target),
            "companion_path": str(companion_path),
            "companion_content": companion_content,
            "is_private": is_priv,
        }

    if ext in safe_io.VIDEO_EXTS:
        companion_path, companion_content, _ = _load_companion_note(target)
        return {
            "type": "video",
            "path": str(target),
            "name": target.name,
            "ext": ext,
            "size": st.st_size,
            "mime": guess_mime_type(target),
            "companion_path": str(companion_path),
            "companion_content": companion_content,
            "is_private": is_priv,
        }

    if ext in safe_io.ARCHIVE_EXTS:
        archive_info = _inspect_archive(target)
        companion_path, companion_content, _ = _load_companion_note(target)
        return {
            "type": "archive",
            "path": str(target),
            "name": target.name,
            "ext": ext,
            "size": st.st_size,
            **archive_info,
            "companion_path": str(companion_path),
            "companion_content": companion_content,
            "is_private": is_priv,
        }

    if ext in safe_io.OFFICE_PREVIEW_EXTS:
        preview_md = _extract_office_preview_markdown(target)
        companion_path, companion_content, _ = _load_companion_note(target)
        return {
            "type": "office_preview",
            "path": str(target),
            "name": target.name,
            "ext": ext,
            "size": st.st_size,
            "preview_markdown": preview_md,
            "companion_path": str(companion_path),
            "companion_content": companion_content,
            "is_private": is_priv,
        }

    return {
        "type": "generic",
        "path": str(target),
        "name": target.name,
        "ext": ext,
        "size": st.st_size,
        "mtime": st.st_mtime,
        "is_private": is_priv,
        "message": "暂不支持内置编辑此格式，可点击「用系统程序打开」直接调用本机默认软件",
    }


def _norm_archive_member_name(name: str) -> str:
    cleaned = str(name or "").replace("\\", "/").strip().lstrip("/")
    while cleaned.startswith("./"):
        cleaned = cleaned[2:].lstrip("/")
    return cleaned


def read_archive_entry(path_str: str, member: str) -> dict[str, Any]:
    """Read a single member from a `.zip`/`.tar*`/`.gz` archive strictly in memory (max 512KB)."""
    target = safe_io.resolve_safe_path(path_str, must_exist=True)
    clean_member = _norm_archive_member_name(member)
    if not clean_member or "\x00" in clean_member or ".." in Path(clean_member).parts:
        raise PermissionError("非法压缩包成员路径")

    ext = target.suffix.lower()
    raw_bytes = b""
    actual_size = 0
    truncated = False

    if ext == ".zip":
        with zipfile.ZipFile(target, "r") as zf:
            matched_info: zipfile.ZipInfo | None = None
            for info in zf.infolist():
                decoded_name = _norm_archive_member_name(_decode_zip_member_name(info))
                if info.filename == member or decoded_name == clean_member:
                    matched_info = info
                    break
            if matched_info is None:
                raise FileNotFoundError(f"压缩包中不存在成员：{clean_member}")
            if matched_info.is_dir():
                raise ValueError("无法预览目录项")
            actual_size = int(matched_info.file_size)
            with zf.open(matched_info, "r") as fh:
                raw_bytes = fh.read(_ARCHIVE_PREVIEW_MAX_BYTES + 1)
                if len(raw_bytes) > _ARCHIVE_PREVIEW_MAX_BYTES:
                    raw_bytes = raw_bytes[:_ARCHIVE_PREVIEW_MAX_BYTES]
                    truncated = True
    elif ext in (".tar", ".tgz") or target.name.lower().endswith(".tar.gz"):
        with tarfile.open(target, "r:*") as tf:
            matched_member: tarfile.TarInfo | None = None
            for m in tf.getmembers():
                if m.name == member or _norm_archive_member_name(m.name) == clean_member:
                    matched_member = m
                    break
            if matched_member is None:
                raise FileNotFoundError(f"压缩包中不存在成员：{clean_member}")
            if matched_member.isdir():
                raise ValueError("无法预览目录项")
            actual_size = int(matched_member.size)
            fh = tf.extractfile(matched_member)
            if fh is None:
                raise ValueError("该压缩包条目不支持流式读取")
            with fh:
                raw_bytes = fh.read(_ARCHIVE_PREVIEW_MAX_BYTES + 1)
                if len(raw_bytes) > _ARCHIVE_PREVIEW_MAX_BYTES:
                    raw_bytes = raw_bytes[:_ARCHIVE_PREVIEW_MAX_BYTES]
                    truncated = True
    elif ext == ".gz":
        import gzip

        with gzip.open(target, "rb") as gz:
            raw_bytes = gz.read(_ARCHIVE_PREVIEW_MAX_BYTES + 1)
            if len(raw_bytes) > _ARCHIVE_PREVIEW_MAX_BYTES:
                raw_bytes = raw_bytes[:_ARCHIVE_PREVIEW_MAX_BYTES]
                truncated = True
            actual_size = len(raw_bytes)
    else:
        raise ValueError(f"不支持的压缩包格式：{ext or target.name}")

    member_ext = Path(clean_member).suffix.lower()
    if member_ext in safe_io.IMAGE_EXTS:
        mime = guess_mime_type(clean_member)
        b64 = base64.b64encode(raw_bytes).decode("ascii")
        return {
            "kind": "image",
            "member": clean_member,
            "mime": mime,
            "data_url": f"data:{mime};base64,{b64}",
        }

    is_text_ext = member_ext in safe_io.TEXT_EDIT_EXTS
    looks_binary = b"\x00" in raw_bytes[:4096]
    if is_text_ext or not looks_binary:
        return {
            "kind": "text",
            "member": clean_member,
            "content": _decode_bytes_with_fallback(raw_bytes),
            "truncated": truncated or actual_size > _ARCHIVE_PREVIEW_MAX_BYTES,
        }

    return {
        "kind": "binary",
        "member": clean_member,
        "size": actual_size,
        "message": "二进制文件不支持纯文本预览，建议用系统程序打开压缩包",
    }


def open_external(path_str: str, reveal_folder: bool = False) -> dict[str, Any]:
    """Open a local file or reveal it in the native file manager non-blocking."""
    target = safe_io.resolve_safe_path(path_str, must_exist=True)
    if sys.platform == "win32":
        if reveal_folder:
            subprocess.Popen(["explorer", "/select,", str(target)])
        else:
            os.startfile(str(target))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        cmd = ["open", "-R", str(target)] if reveal_folder else ["open", str(target)]
        subprocess.Popen(cmd, start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        open_target = str(target.parent if reveal_folder else target)
        try:
            subprocess.Popen(
                ["xdg-open", open_target],
                start_new_session=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError:
            pass
    return {"opened": True, "path": str(target), "reveal_folder": bool(reveal_folder)}


def open_external_url(url: str) -> dict[str, Any]:
    """Validate an http/https URL and open it in the system browser non-blocking."""
    cleaned = str(url or "").strip()
    if not (cleaned.startswith("http://") or cleaned.startswith("https://")):
        raise ValueError("仅支持打开 http:// 或 https:// 链接")
    try:
        webbrowser.open(cleaned)
    except Exception:
        pass
    return {"opened": True, "url": cleaned}


def relocate_missing_file(filename: str) -> dict[str, Any]:
    """Search authorized directories (max depth 5) for a missing file by basename and register it."""
    target_name = Path(str(filename or "").strip()).name
    if not target_name:
        raise ValueError("文件名不能为空")

    cfg = load_config()
    idx = safe_io.load_files_index()
    search_roots: list[Path] = [get_default_notes_dir()]
    for raw_dir in list(cfg.get("whitelist_dirs", [])) + list(idx.get("dirs", [])):
        if raw_dir:
            try:
                search_roots.append(Path(raw_dir).expanduser().resolve())
            except OSError:
                continue

    exact_match: Path | None = None
    ci_match: Path | None = None
    target_low = target_name.lower()

    seen_roots: set[str] = set()
    for root in search_roots:
        rs = str(root)
        if rs in seen_roots or not root.exists() or not root.is_dir():
            continue
        seen_roots.add(rs)
        for dirpath, dirnames, filenames in os.walk(root):
            cur = Path(dirpath)
            try:
                depth = len(cur.relative_to(root).parts)
            except ValueError:
                depth = 5
            dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and depth < 5)
            for fname in filenames:
                if fname == target_name:
                    exact_match = (cur / fname).resolve()
                    break
                if ci_match is None and fname.lower() == target_low:
                    ci_match = (cur / fname).resolve()
            if exact_match is not None:
                break
        if exact_match is not None:
            break

    found = exact_match or ci_match
    if found is None:
        return {
            "found": False,
            "filename": target_name,
            "message": f"未在已授权目录中找到「{target_name}」，请重新导入其所在文件夹",
        }

    if not safe_io.is_path_allowed(found):
        safe_io.register_import([str(found)], is_dir=False)

    return {
        "found": True,
        "path": str(found),
        "name": found.name,
        "ext": found.suffix.lower(),
    }


def _norm_path_for_compare(raw_path: Any) -> str | None:
    s = str(raw_path or "").strip()
    if not s:
        return None
    try:
        return str(Path(s).expanduser().resolve())
    except OSError:
        return s


def _update_renamed_references(old_str: str, new_str: str) -> None:
    """Atomically update saved path references across files.json, config.json, apps.json, and knowledge_tree.json."""
    # 1. files.json (files list)
    idx = safe_io.load_files_index()
    files_list = idx.get("files", [])
    files_changed = False
    updated_files: list[str] = []
    for item in files_list:
        if item == old_str or _norm_path_for_compare(item) == old_str:
            updated_files.append(new_str)
            files_changed = True
        else:
            updated_files.append(item)
    if files_changed:
        idx["files"] = updated_files
        safe_io.save_files_index(idx)

    # 2. config.json (private_files & default_progress_excel)
    cfg = load_config()
    cfg_changed = False
    priv_list = cfg.get("private_files", [])
    if isinstance(priv_list, list):
        new_priv: list[str] = []
        for p in priv_list:
            if p == old_str or _norm_path_for_compare(p) == old_str:
                new_priv.append(new_str)
                cfg_changed = True
            else:
                new_priv.append(p)
        if cfg_changed:
            cfg["private_files"] = list(dict.fromkeys(new_priv))

    prog_excel = cfg.get("default_progress_excel", "")
    if prog_excel and (prog_excel == old_str or _norm_path_for_compare(prog_excel) == old_str):
        cfg["default_progress_excel"] = new_str
        cfg_changed = True

    if cfg_changed:
        save_config(cfg)

    # 3. apps.json (workspaces[*].file_paths)
    if APPS_FILE.exists():
        try:
            apps_data = json.loads(APPS_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            apps_data = None
        if isinstance(apps_data, dict) and isinstance(apps_data.get("workspaces"), list):
            apps_changed = False
            for ws in apps_data["workspaces"]:
                if not isinstance(ws, dict) or not isinstance(ws.get("file_paths"), list):
                    continue
                new_fps: list[str] = []
                ws_changed = False
                for fp in ws["file_paths"]:
                    if fp == old_str or _norm_path_for_compare(fp) == old_str:
                        new_fps.append(new_str)
                        ws_changed = True
                    else:
                        new_fps.append(fp)
                if ws_changed:
                    ws["file_paths"] = list(dict.fromkeys(new_fps))
                    apps_changed = True
            if apps_changed:
                atomic_write_json(APPS_FILE, apps_data)

    # 4. knowledge_tree.json (nodes[*].files[*].path)
    if TREE_FILE.exists():
        try:
            tree_data = json.loads(TREE_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            tree_data = None
        if isinstance(tree_data, dict) and isinstance(tree_data.get("nodes"), list):
            tree_changed = False
            for node in tree_data["nodes"]:
                if not isinstance(node, dict) or not isinstance(node.get("files"), list):
                    continue
                for f_entry in node["files"]:
                    if not isinstance(f_entry, dict):
                        continue
                    fp = f_entry.get("path")
                    if fp and (fp == old_str or _norm_path_for_compare(fp) == old_str):
                        f_entry["path"] = new_str
                        tree_changed = True
            if tree_changed:
                atomic_write_json(TREE_FILE, tree_data)


def rename_file(path_str: str, new_name: str) -> dict[str, Any]:
    """Safely rename a workspace file in-place and atomically update all saved references."""
    target = safe_io.resolve_safe_path(path_str, must_exist=True)

    cleaned = str(new_name or "").strip()
    if not cleaned:
        raise ValueError("新文件名不能为空")
    if "/" in cleaned or "\\" in cleaned or ".." in cleaned or "\x00" in cleaned or cleaned == ".":
        raise ValueError("文件名包含非法字符（禁止 /、\\、.. 或空字节）")

    if target.is_file() and "." not in cleaned and target.suffix:
        cleaned = f"{cleaned}{target.suffix}"

    new_target = (target.parent / cleaned).resolve()
    if new_target.parent != target.parent:
        raise PermissionError("安全拦截：禁止跨目录重命名")

    if new_target == target:
        return {
            "old_path": str(target),
            "path": str(target),
            "name": target.name,
            "ext": target.suffix.lower(),
        }

    if new_target.exists():
        raise ValueError(f"目标文件名已存在：{new_target.name}")

    old_str = str(target)
    target.rename(new_target)
    new_str = str(new_target)
    _update_renamed_references(old_str, new_str)

    return {
        "old_path": old_str,
        "path": new_str,
        "name": new_target.name,
        "ext": new_target.suffix.lower(),
    }


def remove_from_workspace(path_str: str) -> dict[str, Any]:
    """Remove a file or mounted directory from workspace indexes without deleting anything on disk."""
    if not path_str or not isinstance(path_str, str) or not path_str.strip():
        raise ValueError("文件路径不能为空")
    if "\x00" in path_str:
        raise PermissionError("非法路径字符")

    target = Path(path_str).expanduser().resolve()
    target_s = str(target)

    idx = safe_io.load_files_index()
    orig_files = idx.get("files", [])
    orig_dirs = idx.get("dirs", [])
    new_files = [f for f in orig_files if f != target_s and _norm_path_for_compare(f) != target_s]
    new_dirs = [d for d in orig_dirs if d != target_s and _norm_path_for_compare(d) != target_s]
    was_explicit_dir = len(new_dirs) != len(orig_dirs)

    if len(new_files) != len(orig_files) or was_explicit_dir:
        safe_io.save_files_index({"files": new_files, "dirs": new_dirs})

    if was_explicit_dir:
        cfg = load_config()
        notes_dir_s = str(get_default_notes_dir().resolve())
        data_dir_s = str(DATA_DIR.resolve())
        whitelist = cfg.get("whitelist_dirs", [])
        if isinstance(whitelist, list) and target_s not in (notes_dir_s, data_dir_s):
            new_wl = [w for w in whitelist if w != target_s and _norm_path_for_compare(w) != target_s]
            if len(new_wl) != len(whitelist):
                cfg["whitelist_dirs"] = new_wl
                save_config(cfg)

    return {
        "removed_path": target_s,
        "deleted_from_disk": False,
        "message": "已从工作台列表移除，硬盘原文件未受影响",
    }


def write_text_document(path_str: str, content: str) -> dict[str, Any]:
    """Atomically write editable text content (`safe_io.TEXT_EDIT_EXTS`) with pre-write `.bak` snapshot."""
    target = safe_io.resolve_safe_path(path_str, must_exist=False)
    if target.suffix.lower() not in safe_io.TEXT_EDIT_EXTS:
        raise ValueError(f"仅支持写入纯文本/代码类文件：{target.name}")
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
    """Enforce privacy lock first, then extract plain text for AI RAG across supported formats."""
    target = safe_io.assert_not_private(path_str)
    ext = target.suffix.lower()

    if ext in safe_io.TEXT_EDIT_EXTS:
        text = _read_text_with_fallback(target)
        return _truncate_head_tail(text, max_chars)

    if ext == ".pdf":
        return extract_pdf_text(str(target), max_pages=12, max_chars=max_chars)

    if ext == ".xlsx":
        from core import excel_engine

        summary = excel_engine.extract_text_summary(str(target), max_rows=60, max_chars=max_chars)
        return _truncate_head_tail(summary, max_chars)

    if ext in safe_io.OFFICE_PREVIEW_EXTS:
        return _truncate_head_tail(_extract_office_preview_markdown(target), max_chars)

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


_INLINE_CODE_LANG_MAP = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".json": "json",
    ".css": "css",
    ".html": "html",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".ini": "ini",
    ".toml": "toml",
    ".log": "log",
    ".sql": "sql",
    ".sh": "bash",
    ".bat": "bat",
    ".csv": "csv",
}

_OFFICE_EMPTY_SENTINELS = {
    "（DOCX 文档中未找到正文 XML 内容）",
    "（DOCX 文档暂无可提取的纯文本段落）",
    "（PPTX 演示文稿暂无可提取的文本内容）",
}


def _truncate_inline_markdown(text: str, max_chars: int) -> tuple[str, bool]:
    if max_chars <= 0 or len(text) <= max_chars:
        return text, False
    notice = f"\n\n> *（内容超过 {max_chars} 字，已自动截断）*"
    budget = max(80, max_chars - len(notice))
    cut = text[:budget]
    nl = cut.rfind("\n")
    if nl > int(budget * 0.6):
        cut = cut[:nl]
    return cut.rstrip() + notice, True


def _wrap_fenced_code(code: str, lang: str, max_chars: int) -> tuple[str, bool]:
    trimmed = code.rstrip()
    fence = "````" if "```" in trimmed else "```"
    overhead = len(fence) * 2 + len(lang) + 2
    truncated = False
    if len(trimmed) + overhead > max_chars:
        notice = "\n# ...（内容已截断）"
        budget = max(80, max_chars - overhead - len(notice))
        cut = trimmed[:budget]
        nl = cut.rfind("\n")
        if nl > int(budget * 0.6):
            cut = cut[:nl]
        trimmed = cut.rstrip() + notice
        truncated = True
    return f"{fence}{lang}\n{trimmed}\n{fence}", truncated


def _csv_to_markdown(csv_text: str, max_chars: int) -> tuple[str, bool]:
    rows = [r for r in csv.reader(io.StringIO(csv_text)) if any(str(c).strip() for c in r)]
    if not rows:
        return "（CSV 文件为空）", False
    max_cols = max(len(r) for r in rows)
    if max_cols <= 1:
        return _wrap_fenced_code(csv_text, "csv", max_chars)

    shown_cols = min(max_cols, 12)
    header = rows[0]
    data_rows = rows[1:]
    max_data_rows = 35
    shown_data = data_rows[:max_data_rows]

    def _fmt_cell(val: str) -> str:
        return str(val or "").replace("|", "\\|").replace("\r", " ").replace("\n", " ").strip()

    head_cells = [_fmt_cell(header[i] if i < len(header) else f"列{i + 1}") or f"列{i + 1}" for i in range(shown_cols)]
    lines = [
        "| " + " | ".join(head_cells) + " |",
        "| " + " | ".join(["---"] * shown_cols) + " |",
    ]
    for r in shown_data:
        cells = [_fmt_cell(r[i] if i < len(r) else "") for i in range(shown_cols)]
        lines.append("| " + " | ".join(cells) + " |")

    truncated = len(data_rows) > max_data_rows or max_cols > shown_cols
    if truncated:
        lines.append(f"\n> *（CSV 共 {len(data_rows)} 行 × {max_cols} 列，已展示前 {len(shown_data)} 行 × {shown_cols} 列）*")

    md, char_trunc = _truncate_inline_markdown("\n".join(lines), max_chars)
    return md, truncated or char_trunc


def _format_inline_text_payload(raw_text: str, ext: str, max_chars: int) -> tuple[str, bool]:
    cleaned = raw_text.rstrip()
    if ext in (".md", ".txt", ""):
        return _truncate_inline_markdown(cleaned, max_chars)
    if ext == ".csv":
        return _csv_to_markdown(cleaned, max_chars)
    lang = _INLINE_CODE_LANG_MAP.get(ext, "")
    return _wrap_fenced_code(cleaned, lang, max_chars)


def _extract_xlsx_inline(
    target: Path,
    sheet: str | None,
    cell: str | None,
    max_chars: int,
) -> dict[str, Any]:
    from core import excel_engine

    sheets_meta = excel_engine.get_sheets(str(target))
    sheets_list = sheets_meta.get("sheets", [])
    if not sheets_list:
        return {"supported": False, "source_name": target.name, "reason": "Excel 文件不包含任何工作表"}

    target_sheet = (sheet or "").strip() or sheets_list[0]["name"]
    rows_res = excel_engine.get_rows(str(target), sheet=target_sheet, page=1, page_size=500)
    headers: list[str] = rows_res.get("headers") or []
    all_rows: list[dict[str, Any]] = rows_res.get("rows") or []
    total_rows = int(rows_res.get("total_rows") or len(all_rows))

    target_row_num: int | None = None
    if cell:
        m = re.search(r"(\d+)$", str(cell).strip())
        if m:
            target_row_num = int(m.group(1))

    if target_row_num is not None and target_row_num >= 2 and all_rows:
        hit_idx = 0
        for idx, r in enumerate(all_rows):
            if r.get("row_num") == target_row_num:
                hit_idx = idx
                break
        start = max(0, hit_idx - 10)
        selected_rows = all_rows[start : start + 25]
    else:
        selected_rows = all_rows[:40]

    shown_cols = min(max(1, len(headers)), 12)
    head_labels = [str(h).replace("|", "\\|").replace("\n", " ").strip() for h in headers[:shown_cols]]
    if not head_labels:
        head_labels = [f"列{i + 1}" for i in range(shown_cols)]

    lines = [
        f"### {target.name} · {target_sheet}" + (f"（定位 `{cell}`）" if cell else ""),
        "",
        "| 行号 | " + " | ".join(head_labels) + " |",
        "| --- | " + " | ".join(["---"] * shown_cols) + " |",
    ]
    for r in selected_rows:
        cells = r.get("cells") or []
        formatted = [
            str(cells[i] if i < len(cells) else "").replace("|", "\\|").replace("\r", " ").replace("\n", " ")
            for i in range(shown_cols)
        ]
        lines.append(f"| {r.get('row_num', '')} | " + " | ".join(formatted) + " |")

    if not selected_rows:
        lines.append("| - | " + " | ".join(["（空）"] * shown_cols) + " |")

    truncated = total_rows > len(selected_rows) or len(headers) > shown_cols
    if truncated:
        lines.append(f"\n> *（工作表「{target_sheet}」共 {total_rows} 行数据，当前展示 {len(selected_rows)} 行）*")

    md, char_trunc = _truncate_inline_markdown("\n".join(lines), max_chars)
    return {
        "supported": True,
        "kind": "xlsx",
        "source_name": target.name,
        "title": f"{target.name} · {target_sheet}",
        "markdown": md,
        "truncated": truncated or char_trunc,
    }


def _extract_pdf_inline(target: Path, page: int | None, max_chars: int) -> dict[str, Any]:
    import pymupdf

    doc = pymupdf.open(target)
    try:
        total_pages = len(doc)
        if total_pages == 0:
            return {"supported": False, "source_name": target.name, "reason": "该 PDF 文件为空，无可读页面"}

        if page is not None:
            page_num = int(page)
            if page_num < 1 or page_num > total_pages:
                raise ValueError(f"页码越界：{page_num}（PDF 共 {total_pages} 页）")
            text = (doc[page_num - 1].get_text("text") or "").strip()
            if not text:
                return {
                    "supported": False,
                    "source_name": target.name,
                    "reason": "该 PDF 无可提取的文字层（可能为纯图片扫描件），不支持直接展开为文本",
                }
            md, trunc = _truncate_inline_markdown(f"### {target.name} · 第 {page_num} 页\n\n{text}", max_chars)
            return {
                "supported": True,
                "kind": "pdf",
                "source_name": target.name,
                "title": f"{target.name} · 第 {page_num} 页",
                "markdown": md,
                "truncated": trunc,
            }

        limit = min(5, total_pages)
        blocks: list[str] = []
        for idx in range(limit):
            text = (doc[idx].get_text("text") or "").strip()
            if text:
                blocks.append(f"#### 第 {idx + 1} 页\n\n{text}")
        if not blocks:
            return {
                "supported": False,
                "source_name": target.name,
                "reason": "该 PDF 无可提取的文字层（可能为纯图片扫描件），不支持直接展开为文本",
            }
        truncated = total_pages > limit
        if truncated:
            blocks.append(f"> *（PDF 共 {total_pages} 页，已展开前 {limit} 页）*")
        md, char_trunc = _truncate_inline_markdown("\n\n".join(blocks), max_chars)
        return {
            "supported": True,
            "kind": "pdf",
            "source_name": target.name,
            "title": f"{target.name}（前 {limit} 页）",
            "markdown": md,
            "truncated": truncated or char_trunc,
        }
    finally:
        doc.close()


def extract_inline_content(
    path_str: str,
    page: int | None = None,
    sheet: str | None = None,
    cell: str | None = None,
    member: str | None = None,
    max_chars: int = 12000,
) -> dict[str, Any]:
    """Extract clean Markdown for inline note expansion across local formats (no privacy gate for local insertion)."""
    target = safe_io.resolve_safe_path(path_str, must_exist=True)
    ext = target.suffix.lower()
    char_limit = max(200, int(max_chars or 12000))

    if ext in safe_io.TEXT_EDIT_EXTS:
        raw_text = _read_text_with_fallback(target)
        md, truncated = _format_inline_text_payload(raw_text, ext, char_limit)
        kind = "markdown" if ext == ".md" else ("csv" if ext == ".csv" else ("text" if ext == ".txt" else "code"))
        return {
            "supported": True,
            "kind": kind,
            "source_name": target.name,
            "title": target.name,
            "markdown": md,
            "truncated": truncated,
        }

    if ext == ".xlsx":
        return _extract_xlsx_inline(target, sheet=sheet, cell=cell, max_chars=char_limit)

    if ext == ".pdf":
        return _extract_pdf_inline(target, page=page, max_chars=char_limit)

    if ext in safe_io.OFFICE_PREVIEW_EXTS:
        md = _extract_office_preview_markdown(target, max_chars=char_limit).strip()
        if not md or md in _OFFICE_EMPTY_SENTINELS:
            return {
                "supported": False,
                "source_name": target.name,
                "reason": "该 Office 文档未提取到可展开的文本内容",
            }
        md_final, trunc = _truncate_inline_markdown(md, char_limit)
        return {
            "supported": True,
            "kind": ext.lstrip("."),
            "source_name": target.name,
            "title": target.name,
            "markdown": md_final,
            "truncated": trunc or len(md) >= char_limit,
        }

    if ext in safe_io.ARCHIVE_EXTS or target.name.lower().endswith(".tar.gz"):
        clean_member = str(member or "").strip()
        if not clean_member:
            return {
                "supported": False,
                "source_name": target.name,
                "reason": "压缩包整体不支持直接展开，请定位并展开其中的具体文本文件（如 [[压缩包.zip!README.txt]]）",
            }
        entry = read_archive_entry(path_str, clean_member)
        if entry.get("kind") != "text":
            return {
                "supported": False,
                "source_name": clean_member,
                "reason": "压缩包内该条目为非文本/二进制文件，不支持直接展开填入",
            }
        m_name = str(entry.get("member") or clean_member)
        m_ext = Path(m_name).suffix.lower()
        md, trunc = _format_inline_text_payload(str(entry.get("content") or ""), m_ext, char_limit)
        return {
            "supported": True,
            "kind": "archive_entry",
            "source_name": m_name,
            "title": f"{target.name}!{m_name}",
            "markdown": md,
            "truncated": bool(entry.get("truncated")) or trunc,
        }

    return {
        "supported": False,
        "source_name": target.name,
        "reason": f"不支持将此文件类型（{ext or '二进制文件'}）直接展开填入笔记",
    }
