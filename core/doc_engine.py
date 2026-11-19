"""Document engine for SmartLocalNote (multi-format preview, virtual archives, companion notes & AI extraction).

Strictly uses lazy imports for `pymupdf` inside PDF functions and `core.excel_engine`
inside Excel text extraction to keep idle RAM < 80MB and cold start < 1s.
All local file access and writes pass through `core.safe_io`.
"""

from __future__ import annotations

import base64
from collections import OrderedDict
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

from config import get_default_notes_dir, load_config
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
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
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


def companion_note_path_for_pdf(pdf_path: Path) -> Path:
    """Map a file to its companion Markdown note inside default_notes_dir."""
    return (get_default_notes_dir() / f"{pdf_path.stem}_伴生笔记.md").resolve()


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


def _extract_office_preview_markdown(target: Path) -> str:
    """Extract readable paragraphs/slides from .docx or .pptx using stdlib zipfile + ElementTree."""
    ext = target.suffix.lower()
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
                return combined[:_OFFICE_PREVIEW_MAX_CHARS]

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
                return combined[:_OFFICE_PREVIEW_MAX_CHARS]
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


def read_archive_entry(path_str: str, member: str) -> dict[str, Any]:
    """Read a single member from a `.zip`/`.tar*`/`.gz` archive strictly in memory (max 512KB)."""
    target = safe_io.resolve_safe_path(path_str, must_exist=True)
    clean_member = str(member or "").replace("\\", "/").lstrip("/")
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
                decoded_name = _decode_zip_member_name(info).replace("\\", "/").lstrip("/")
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
                if m.name == member or m.name.replace("\\", "/").lstrip("/") == clean_member:
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
