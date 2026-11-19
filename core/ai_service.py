"""AI Copilot core service for SmartLocalNote.

Implements pure business logic (no FastAPI dependencies):
- Privacy lock enforcement via `safe_io.assert_not_private` before any AI operation.
- Multi-file cross-format context budget management (`validate_chat_context`).
- OpenAI-compatible Chat Completions over `httpx.AsyncClient` (zero openai SDK).
- Robust offline rule-based fallbacks for summarize, streaming chat, table row extraction,
  and knowledge-tree file classification.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
import importlib
import json
from pathlib import Path
import re
import time
from typing import Any, AsyncGenerator
from urllib.parse import urlparse

import httpx

from config import APPS_FILE, TREE_FILE, ensure_data_dirs, load_config
from core import safe_io

MAX_CHAT_CONTEXT_FILES = 5
PER_FILE_MAX_CHARS = 4000
TOTAL_CONTEXT_MAX_CHARS = 12000
SUMMARIZE_FILE_MAX_CHARS = 6000
TRUNCATED_MARKER = "\n...[总上下文超长已智能截断]...\n"


# ---------------------------------------------------------------------------
# Internal lazy module & data accessors (avoid hard import coupling / failures)
# ---------------------------------------------------------------------------

def _optional_import(module_name: str) -> Any | None:
    try:
        return importlib.import_module(module_name)
    except ImportError:
        return None


def _extract_text_fallback(resolved_path: Path, max_chars: int) -> str:
    """Fallback text extractor when core.doc_engine is unavailable."""
    ext = resolved_path.suffix.lower()
    if ext in (".md", ".txt", ".csv", ".json", ".log"):
        try:
            text = resolved_path.read_text(encoding="utf-8", errors="replace")
            return _head_tail_truncate(text, max_chars)
        except OSError:
            return ""

    if ext == ".pdf":
        try:
            import fitz  # PyMuPDF

            chunks: list[str] = []
            total = 0
            with fitz.open(str(resolved_path)) as doc:
                for idx, page in enumerate(doc, start=1):
                    page_text = (page.get_text("text") or "").strip()
                    if not page_text:
                        continue
                    block = f"[第{idx}页]\n{page_text}"
                    chunks.append(block)
                    total += len(block)
                    if total >= max_chars + 500:
                        break
            return _head_tail_truncate("\n\n".join(chunks), max_chars)
        except Exception:
            return ""

    if ext in (".xlsx", ".xlsm"):
        try:
            import openpyxl

            wb = openpyxl.load_workbook(str(resolved_path), read_only=True, data_only=True)
            parts: list[str] = []
            try:
                for sheet_name in wb.sheetnames[:3]:
                    ws = wb[sheet_name]
                    rows_md: list[str] = [f"### Sheet: {sheet_name}"]
                    row_count = 0
                    for r_idx, row in enumerate(ws.iter_rows(values_only=True), start=1):
                        if r_idx > 60:
                            break
                        vals = ["" if v is None else str(v).replace("\n", " ").strip() for v in row]
                        if not any(vals):
                            continue
                        col_cells = [f"{_col_letter(c_i)}{r_idx}:{val}" for c_i, val in enumerate(vals, start=1) if val]
                        rows_md.append(f"Row {r_idx}: " + " | ".join(col_cells))
                        row_count += 1
                    if row_count:
                        parts.append("\n".join(rows_md))
            finally:
                wb.close()
            return _head_tail_truncate("\n\n".join(parts), max_chars)
        except Exception:
            return ""

    try:
        text = resolved_path.read_text(encoding="utf-8", errors="replace")
        return _head_tail_truncate(text, max_chars)
    except OSError:
        return ""


def _col_letter(col_idx: int) -> str:
    result = ""
    n = col_idx
    while n > 0:
        n, rem = divmod(n - 1, 26)
        result = chr(65 + rem) + result
    return result or "A"


def _extract_text_for_ai(path_str: str, max_chars: int = 4000) -> tuple[Path, str]:
    """Assert not private and extract text using doc_engine.extract_text_for_ai when present."""
    resolved = safe_io.assert_not_private(path_str)
    doc_engine = _optional_import("core.doc_engine")
    fn = getattr(doc_engine, "extract_text_for_ai", None) if doc_engine else None
    if callable(fn):
        try:
            extracted = fn(str(resolved), max_chars=max_chars)
            if isinstance(extracted, dict):
                extracted = extracted.get("text", "")
            text = str(extracted or "")
            return resolved, _head_tail_truncate(text, max_chars)
        except (PermissionError, FileNotFoundError, ValueError):
            raise
        except Exception:
            pass
    return resolved, _extract_text_fallback(resolved, max_chars=max_chars)


def _list_registered_apps() -> list[dict[str, Any]]:
    app_launcher = _optional_import("core.app_launcher")
    fn = getattr(app_launcher, "list_apps", None) if app_launcher else None
    if callable(fn):
        try:
            res = fn()
            if isinstance(res, list):
                return [a for a in res if isinstance(a, dict)]
            if isinstance(res, dict) and isinstance(res.get("apps"), list):
                return [a for a in res["apps"] if isinstance(a, dict)]
        except Exception:
            pass
    ensure_data_dirs()
    try:
        raw = json.loads(APPS_FILE.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("apps"), list):
            return [a for a in raw["apps"] if isinstance(a, dict)]
    except (OSError, json.JSONDecodeError):
        pass
    return []


def _list_workspace_files() -> list[dict[str, Any]]:
    doc_engine = _optional_import("core.doc_engine")
    fn = getattr(doc_engine, "list_workspace_files", None) if doc_engine else None
    if callable(fn):
        try:
            res = fn()
            if isinstance(res, dict) and isinstance(res.get("items"), list):
                return [i for i in res["items"] if isinstance(i, dict)]
        except Exception:
            pass

    items: list[dict[str, Any]] = []
    idx = safe_io.load_files_index()
    seen: set[str] = set()
    for raw_f in idx.get("files", []):
        try:
            p = Path(raw_f).expanduser().resolve()
            ps = str(p)
            if ps not in seen and p.exists():
                seen.add(ps)
                items.append({"path": ps, "name": p.name, "ext": p.suffix.lower()})
        except OSError:
            continue
    for raw_d in idx.get("dirs", []):
        try:
            d = Path(raw_d).expanduser().resolve()
            if not d.is_dir():
                continue
            for p in d.rglob("*"):
                if p.is_file() and p.suffix.lower() in safe_io.SUPPORTED_DOC_EXTS:
                    ps = str(p.resolve())
                    if ps not in seen:
                        seen.add(ps)
                        items.append({"path": ps, "name": p.name, "ext": p.suffix.lower()})
        except OSError:
            continue
    return items


def _get_tree_nodes() -> list[dict[str, Any]]:
    tree_store = _optional_import("core.tree_store")
    fn = getattr(tree_store, "get_tree", None) if tree_store else None
    if callable(fn):
        try:
            res = fn()
            if isinstance(res, dict) and isinstance(res.get("nodes"), list):
                return [n for n in res["nodes"] if isinstance(n, dict)]
        except Exception:
            pass
    ensure_data_dirs()
    try:
        raw = json.loads(TREE_FILE.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("nodes"), list):
            return [n for n in raw["nodes"] if isinstance(n, dict)]
    except (OSError, json.JSONDecodeError):
        pass
    return []


# ---------------------------------------------------------------------------
# Text & JSON helpers
# ---------------------------------------------------------------------------

def _head_tail_truncate(text: str, max_chars: int, marker: str = "\n...[已智能截断]...\n") -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    if max_chars <= len(marker) + 20:
        return text[:max_chars]
    available = max_chars - len(marker)
    head_len = int(available * 0.65)
    tail_len = available - head_len
    return text[:head_len].rstrip() + marker + text[-tail_len:].lstrip()


def _parse_json_robust(raw_text: str) -> dict[str, Any]:
    """Extract and parse a JSON object from LLM text (including ```json fences)."""
    cleaned = (raw_text or "").strip()
    if not cleaned:
        raise ValueError("Empty AI response")

    # Strip fenced markdown blocks if present.
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", cleaned, re.IGNORECASE)
    if fence_match:
        cleaned = fence_match.group(1).strip()

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    # Fallback: scan outermost {...}
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end > start:
        parsed = json.loads(cleaned[start : end + 1])
        if isinstance(parsed, dict):
            return parsed

    raise ValueError("Unable to parse JSON object from AI response")


_OLLAMA_PROBE_TTL = 60.0
_ollama_probe_cache: dict[str, Any] = {"ts": 0.0, "model": None}
_FREE_PUBLIC_BASE_URL = "https://text.pollinations.ai/openai"
_OFFLINE_LABEL = "本地离线增强引擎"


def _is_localhost_url(url: str) -> bool:
    if not url:
        return False
    try:
        host = (urlparse(url).hostname or "").strip().lower()
    except ValueError:
        return False
    return host in ("127.0.0.1", "localhost", "::1")


def _build_chat_url(base_url: str) -> str:
    cleaned = base_url.strip().rstrip("/")
    if cleaned.endswith("/chat/completions"):
        return cleaned
    return f"{cleaned}/chat/completions"


async def _probe_local_ollama_model() -> str | None:
    """Probe http://127.0.0.1:11434/api/tags with a 0.3s timeout and 60s TTL cache."""
    now = time.monotonic()
    if now - float(_ollama_probe_cache.get("ts") or 0.0) < _OLLAMA_PROBE_TTL:
        cached = _ollama_probe_cache.get("model")
        return str(cached) if cached else None

    detected_model: str | None = None
    try:
        async with httpx.AsyncClient(timeout=0.3) as client:
            resp = await client.get("http://127.0.0.1:11434/api/tags")
            if resp.status_code == 200:
                payload = resp.json()
                models = payload.get("models") if isinstance(payload, dict) else None
                if isinstance(models, list) and models:
                    first = models[0] if isinstance(models[0], dict) else {}
                    candidate = str(first.get("name") or first.get("model") or "").strip()
                    if candidate:
                        detected_model = candidate
    except Exception:
        detected_model = None

    _ollama_probe_cache["ts"] = now
    _ollama_probe_cache["model"] = detected_model
    return detected_model


async def _resolve_ai_runtime() -> dict[str, Any]:
    """Resolve active AI endpoint using the 3-tier Zero-Key Free AI router."""
    cfg = load_config()
    ai_cfg = cfg.get("ai") if isinstance(cfg.get("ai"), dict) else {}
    raw_base_url = str(ai_cfg.get("base_url") or "").strip().rstrip("/")
    api_key = str(ai_cfg.get("api_key") or "").strip()
    model = str(ai_cfg.get("model") or "").strip()
    wsp = str(ai_cfg.get("web_search_param") or "").strip()
    enable_free_ai = bool(ai_cfg.get("enable_free_ai", True))

    # Tier 1: Configured custom API key or explicit local Ollama URL
    if api_key:
        eff_base = raw_base_url or "https://dashscope.aliyuncs.com/compatible-mode/v1"
        eff_model = model or "qwen-plus"
        return {
            "mode": "custom",
            "label": f"自定义模型 ({eff_model})",
            "base_url": eff_base,
            "api_key": api_key,
            "model": eff_model,
            "web_search_param": wsp,
            "timeout": 45.0,
        }

    if _is_localhost_url(raw_base_url):
        eff_model = model or "qwen2.5:7b"
        return {
            "mode": "ollama",
            "label": f"本机模型 ({eff_model})",
            "base_url": raw_base_url,
            "api_key": "ollama",
            "model": eff_model,
            "web_search_param": "",
            "timeout": 35.0,
        }

    # Tier 2: Zero-key free auto-detection (local Ollama -> free public gateway)
    if enable_free_ai:
        ollama_model = await _probe_local_ollama_model()
        if ollama_model:
            return {
                "mode": "ollama_auto",
                "label": f"本机 Ollama ({ollama_model})",
                "base_url": "http://127.0.0.1:11434/v1",
                "api_key": "ollama",
                "model": ollama_model,
                "web_search_param": "",
                "timeout": 35.0,
            }
        return {
            "mode": "free_public",
            "label": "免 Key 免费基础 AI",
            "base_url": _FREE_PUBLIC_BASE_URL,
            "api_key": "",
            "model": "openai",
            "web_search_param": "",
            "timeout": 12.0,
        }

    # Tier 3: Pure local rule-based offline engine
    return {"mode": "offline", "label": _OFFLINE_LABEL}


async def _call_chat_json(
    system_prompt: str,
    user_prompt: str,
    *,
    runtime: dict[str, Any] | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    rt = runtime or await _resolve_ai_runtime()
    if rt.get("mode") == "offline":
        raise RuntimeError("AI runtime is in offline mode")

    url = _build_chat_url(str(rt["base_url"]))
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if rt.get("api_key"):
        headers["Authorization"] = f"Bearer {rt['api_key']}"

    payload: dict[str, Any] = {
        "model": rt["model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
    }

    eff_timeout = float(rt.get("timeout", 45.0)) if timeout is None else min(float(timeout), float(rt.get("timeout", 45.0)))
    async with httpx.AsyncClient(timeout=eff_timeout) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()

    choices = data.get("choices") or []
    if not choices:
        raise ValueError("No choices in AI response")
    content = str(((choices[0].get("message") or {}).get("content")) or "")
    return _parse_json_robust(content)


# ---------------------------------------------------------------------------
# 1. validate_chat_context
# ---------------------------------------------------------------------------

def validate_chat_context(context_paths: list[str] | None) -> list[dict[str, Any]]:
    """Validate and extract text from up to 5 cross-format files for AI chat.

    Enforces:
    - Max 5 files (`ValueError` if exceeded)
    - `safe_io.assert_not_private` on every path (`PermissionError` naming exact file)
    - Per-file limit: 4000 chars
    - Total combined context limit: 12000 chars (head/tail truncated cleanly)
    """
    if not context_paths:
        return []

    deduped: list[str] = []
    seen_raw: set[str] = set()
    for raw in context_paths:
        s = str(raw or "").strip()
        if s and s not in seen_raw:
            seen_raw.add(s)
            deduped.append(s)

    if len(deduped) > MAX_CHAT_CONTEXT_FILES:
        raise ValueError("跨格式联合问答最多同时勾选 5 份文件")

    docs: list[dict[str, Any]] = []
    seen_resolved: set[str] = set()
    for raw_path in deduped:
        resolved, extracted = _extract_text_for_ai(raw_path, max_chars=PER_FILE_MAX_CHARS)
        resolved_str = str(resolved)
        if resolved_str in seen_resolved:
            continue
        seen_resolved.add(resolved_str)
        docs.append({
            "path": resolved_str,
            "name": resolved.name,
            "ext": resolved.suffix.lower(),
            "text": extracted,
        })

    # Enforce 12000-char combined context budget across extracted texts.
    total_chars = sum(len(d["text"]) for d in docs)
    if total_chars > TOTAL_CONTEXT_MAX_CHARS and docs:
        per_doc_budget = max(300, TOTAL_CONTEXT_MAX_CHARS // len(docs))
        remaining_budget = TOTAL_CONTEXT_MAX_CHARS
        for idx, doc in enumerate(docs):
            left_docs = len(docs) - idx
            alloc = min(per_doc_budget, remaining_budget) if left_docs > 1 else remaining_budget
            if len(doc["text"]) > alloc:
                doc["text"] = _head_tail_truncate(
                    doc["text"],
                    max(alloc, 80),
                    marker=TRUNCATED_MARKER,
                )
            remaining_budget = max(0, remaining_budget - len(doc["text"]))

    return docs


# ---------------------------------------------------------------------------
# 2. summarize_content
# ---------------------------------------------------------------------------

def _match_apps_and_files(
    text: str,
    apps: list[dict[str, Any]],
    workspace_files: list[dict[str, Any]],
) -> tuple[list[str], list[str]]:
    lower_text = text.lower()
    matched_app_ids: list[str] = []
    for app in apps:
        app_id = str(app.get("id") or "").strip()
        if not app_id:
            continue
        candidates: list[str] = []
        name = str(app.get("name") or "").strip()
        if name:
            candidates.append(name)
        aliases = app.get("aliases")
        if isinstance(aliases, list):
            candidates.extend(str(a).strip() for a in aliases if str(a).strip())
        for kw in candidates:
            if len(kw) >= 2 and kw.lower() in lower_text:
                if app_id not in matched_app_ids:
                    matched_app_ids.append(app_id)
                break

    matched_files: list[str] = []
    for item in workspace_files:
        fpath = str(item.get("path") or "").strip()
        fname = str(item.get("name") or (Path(fpath).name if fpath else "")).strip()
        if not fpath or not fname:
            continue
        stem = Path(fname).stem
        if (len(fname) >= 3 and fname.lower() in lower_text) or (len(stem) >= 2 and stem.lower() in lower_text):
            if fpath not in matched_files:
                matched_files.append(fpath)

    return matched_app_ids, matched_files


def _detect_trigger_time(text: str) -> str | None:
    patterns = [
        r"(今天|明天|后天|今晚|明早|上午|下午|晚上)?\s*\d{1,2}[:点：]\d{1,2}分?",
        r"(今天|明天|后天|今晚|明早|上午|下午|晚上)\s*\d{1,2}点半?",
        r"\d+\s*(?:分钟后|小时后|秒后)",
        r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:\s+\d{1,2}[:点]\d{1,2})?",
        r"(今天|明天|今晚|上午|下午|晚上)",
    ]
    for pat in patterns:
        m = re.search(pat, text)
        if m:
            found = re.sub(r"\s+", " ", m.group(0)).strip()
            if found:
                return found
    return None


def _extract_tags_offline(text: str) -> list[str]:
    tags: list[str] = []
    for m in re.findall(r"#([\w\u4e00-\u9fff-]{1,20})", text):
        if m not in tags:
            tags.append(m)

    for m in re.findall(r"^#{1,3}\s+(.+)$", text, flags=re.MULTILINE):
        clean = re.sub(r"[#*`\[\]]", "", m).strip()
        if 2 <= len(clean) <= 16 and clean not in tags:
            tags.append(clean)

    domain_keywords = ["高数", "复习", "笔记", "进度", "表格", "报告", "会议", "计划", "错题", "代码", "英语", "论文"]
    for kw in domain_keywords:
        if kw in text and kw not in tags:
            tags.append(kw)

    if not tags:
        tags.append("随手记")
    return tags[:6]


def _extract_todos_offline(text: str, trigger_time: str | None) -> list[dict[str, str]]:
    todos: list[dict[str, str]] = []
    seen_titles: set[str] = set()
    action_cues = ("需要", "记得", "完成", "复习", "刷题", "整理", "提交", "打开", "准备", "检查", "写", "做", "联系", "确认", "录入")
    high_cues = ("马上", "立即", "务必", "紧急", "今晚", "今天", "截止", "ddl", "重点")

    def _add_todo(raw_title: str) -> None:
        title = re.sub(r"^[-*•\d.)、\[\]xX\s]+", "", raw_title).strip(" ：:;；,，。")
        if len(title) < 2 or len(title) > 80:
            return
        if title in seen_titles:
            return
        seen_titles.add(title)
        local_time = _detect_trigger_time(raw_title) or trigger_time or ""
        priority = "high" if any(c in raw_title.lower() for c in high_cues) else "medium"
        todos.append({
            "title": title,
            "suggested_time": local_time,
            "priority": priority,
        })

    # 1. Markdown checkboxes or bullet/numbered lines
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if re.match(r"^[-*]\s*\[\s\]\s+", s):
            _add_todo(re.sub(r"^[-*]\s*\[\s\]\s+", "", s))
        elif re.match(r"^(?:[-*•]|\d+[.)、])\s+", s):
            if any(cue in s for cue in action_cues) or len(s) <= 45:
                _add_todo(s)

    # 2. Sentences with action cues
    if len(todos) < 5:
        for seg in re.split(r"[。！？!\?\n；;]+", text):
            seg_s = seg.strip()
            if not seg_s or seg_s.startswith("#"):
                continue
            if any(cue in seg_s for cue in action_cues):
                _add_todo(seg_s)
                if len(todos) >= 5:
                    break

    # 3. Guarantee at least 1 actionable todo
    if not todos:
        first_line = next(
            (ln.strip().lstrip("#").strip() for ln in text.splitlines() if ln.strip()),
            text.strip()[:40],
        )
        _add_todo(f"跟进处理：{first_line[:36]}")

    return todos[:6]


def _summarize_offline(
    text: str,
    matched_app_ids: list[str],
    matched_files: list[str],
    apps_by_id: dict[str, dict[str, Any]],
    provider_label: str = _OFFLINE_LABEL,
) -> dict[str, Any]:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    headings = [ln.lstrip("#").strip() for ln in lines if ln.startswith("#")]
    body_lines = [ln for ln in lines if not ln.startswith("#")]

    sentences = [s.strip() for s in re.split(r"[。！？!\?\n]+", " ".join(body_lines) or text) if len(s.strip()) >= 4]
    if headings and sentences:
        summary = f"核心主题为「{headings[0][:24]}」，要点包括：{'；'.join(sentences[:2])[:140]}。"
    elif sentences:
        summary = "；".join(sentences[:2])[:150] + ("。" if not sentences[0].endswith("。") else "")
    else:
        summary = text.strip()[:120]

    trigger_time = _detect_trigger_time(text)
    tags = _extract_tags_offline(text)
    todos = _extract_todos_offline(text, trigger_time)

    return {
        "summary": summary,
        "tags": tags,
        "todos": todos,
        "trigger_time": trigger_time,
        "matched_app_ids": matched_app_ids,
        "matched_files": matched_files,
        "matched_apps": [apps_by_id[aid] for aid in matched_app_ids if aid in apps_by_id],
        "offline_mode": True,
        "provider_label": provider_label,
    }


async def summarize_content(text: str = "", file_path: str | None = None) -> dict[str, Any]:
    """Summarize text and/or a non-private file into structured JSON + matched apps/files."""
    parts: list[str] = []
    if file_path:
        resolved, file_text = _extract_text_for_ai(file_path, max_chars=SUMMARIZE_FILE_MAX_CHARS)
        if file_text.strip():
            parts.append(f"[文件: {resolved.name}]\n{file_text.strip()}")
    if text and text.strip():
        parts.append(text.strip())

    combined_text = "\n\n".join(parts).strip()
    if not combined_text:
        raise ValueError("请输入文本或选择一份有内容的文档")

    apps = _list_registered_apps()
    apps_by_id = {str(a.get("id")): a for a in apps if a.get("id")}
    workspace_files = _list_workspace_files()
    local_app_ids, local_files = _match_apps_and_files(combined_text, apps, workspace_files)

    runtime = await _resolve_ai_runtime()
    if runtime.get("mode") == "offline":
        return _summarize_offline(combined_text, local_app_ids, local_files, apps_by_id, provider_label=runtime["label"])

    apps_hint = [
        {"id": a.get("id"), "name": a.get("name"), "aliases": a.get("aliases", [])}
        for a in apps[:30]
    ]
    files_hint = [f.get("path") for f in workspace_files[:40] if f.get("path")]

    system_prompt = (
        "你是 SmartLocalNote 智能本地工作台助手。请将用户输入整理为严格 JSON 对象（不要输出多余解释）：\n"
        '{"summary": "简洁中文总结(2-3句)", "tags": ["标签1", "标签2"], '
        '"todos": [{"title": "具体需要做什么", "suggested_time": "建议时间或空字符串", "priority": "high|medium|low"}], '
        '"trigger_time": "识别到的提醒时间表达式或null", '
        '"matched_app_ids": ["匹配到的应用id"], "matched_files": ["匹配到的完整文件路径"]}'
    )
    user_prompt = (
        f"可用本地软件列表：{json.dumps(apps_hint, ensure_ascii=False)}\n"
        f"可用本地文件列表：{json.dumps(files_hint, ensure_ascii=False)}\n\n"
        f"待整理内容：\n{_head_tail_truncate(combined_text, 6500)}"
    )

    try:
        parsed = await _call_chat_json(system_prompt, user_prompt, runtime=runtime, timeout=float(runtime.get("timeout", 45.0)))
        summary = str(parsed.get("summary") or "").strip()
        if not summary:
            raise ValueError("Empty summary")

        raw_tags = parsed.get("tags")
        tags = [str(t).strip() for t in raw_tags if str(t).strip()][:8] if isinstance(raw_tags, list) else []
        if not tags:
            tags = _extract_tags_offline(combined_text)

        raw_todos = parsed.get("todos")
        todos: list[dict[str, str]] = []
        if isinstance(raw_todos, list):
            for td in raw_todos[:8]:
                if isinstance(td, dict) and str(td.get("title") or "").strip():
                    prio = str(td.get("priority") or "medium").lower()
                    if prio not in ("high", "medium", "low"):
                        prio = "medium"
                    todos.append({
                        "title": str(td["title"]).strip(),
                        "suggested_time": str(td.get("suggested_time") or "").strip(),
                        "priority": prio,
                    })
                elif isinstance(td, str) and td.strip():
                    todos.append({"title": td.strip(), "suggested_time": "", "priority": "medium"})
        if not todos:
            todos = _extract_todos_offline(combined_text, _detect_trigger_time(combined_text))

        trigger_time = parsed.get("trigger_time")
        trigger_str = str(trigger_time).strip() if trigger_time else _detect_trigger_time(combined_text)

        ai_app_ids = [str(x) for x in (parsed.get("matched_app_ids") or []) if str(x) in apps_by_id]
        merged_app_ids = list(dict.fromkeys([*local_app_ids, *ai_app_ids]))

        valid_file_set = {str(f.get("path")) for f in workspace_files if f.get("path")}
        ai_files = [str(x) for x in (parsed.get("matched_files") or []) if str(x) in valid_file_set]
        merged_files = list(dict.fromkeys([*local_files, *ai_files]))

        return {
            "summary": summary,
            "tags": tags,
            "todos": todos,
            "trigger_time": trigger_str or None,
            "matched_app_ids": merged_app_ids,
            "matched_files": merged_files,
            "matched_apps": [apps_by_id[aid] for aid in merged_app_ids if aid in apps_by_id],
            "offline_mode": False,
            "provider_label": runtime["label"],
        }
    except Exception:
        return _summarize_offline(combined_text, local_app_ids, local_files, apps_by_id, provider_label=_OFFLINE_LABEL)


# ---------------------------------------------------------------------------
# 3. stream_chat
# ---------------------------------------------------------------------------

def _build_chat_system_prompt(context_docs: list[dict[str, Any]], web_search: bool) -> str:
    base = (
        "你是 SmartLocalNote 本地工作台的 AI 副驾驶。请使用清晰、简洁的中文 Markdown 回答用户问题。\n"
        "规范要求：\n"
        "1. 若下方附带了多份本地文档参考资料，请综合跨文件信息精准作答，不要编造未出现的数据。\n"
        "2. 引用 PDF 页码时，必须使用可点击锚点语法 `[[文件名.pdf#page=页码]]`（例如 `[[高数笔记.pdf#page=3]]`）。\n"
        "3. 引用 Excel 单元格时，必须使用可点击锚点语法 `[[文件名.xlsx#Sheet名!单元格]]`（例如 `[[刷题表.xlsx#Sheet1!B2]]`）。\n"
    )
    if web_search:
        base += "4. 当前已开启联网检索开关，如本地文档不足以回答，可结合联网常识补充说明。\n"

    if context_docs:
        sections: list[str] = ["\n--- 以下为本次勾选的本地跨格式参考资料 ---"]
        for i, doc in enumerate(context_docs, start=1):
            sections.append(
                f"\n[文档 {i}] 文件名: {doc.get('name')} | 类型: {doc.get('ext')}\n"
                f"内容:\n{doc.get('text', '')}"
            )
        base += "\n".join(sections)

    return base


def _extract_query_keywords(query: str) -> list[str]:
    clean = re.sub(r"[^\w\u4e00-\u9fff]+", " ", query or "").strip()
    tokens: list[str] = []
    for part in clean.split():
        if len(part) >= 2:
            tokens.append(part.lower())
        # Add 2-char Chinese bigrams for better offline keyword matching
        if re.search(r"[\u4e00-\u9fff]", part) and len(part) > 2:
            for i in range(len(part) - 1):
                bg = part[i : i + 2]
                if bg not in tokens:
                    tokens.append(bg.lower())
    return tokens[:16]


def _generate_offline_chat_reply(
    messages: list[dict[str, Any]],
    web_search: bool,
    context_docs: list[dict[str, Any]],
) -> str:
    last_user = ""
    for msg in reversed(messages):
        if str(msg.get("role")) == "user":
            last_user = str(msg.get("content") or "").strip()
            break

    keywords = _extract_query_keywords(last_user)
    lines: list[str] = []

    if web_search:
        lines.append("> 🌐 **联网问答开关已开启**（当前处于未配置外部 API Key 的离线演示模式，以下优先基于本地文档检索作答；在设置中填入 API Key 后即可启用云端实时联网检索）。\n")
    else:
        lines.append("> 💡 **离线智能分析模式**（未配置外部大模型 API Key，以下为您基于本地勾选文档的实时检索分析）：\n")

    if not context_docs:
        lines.append(f"针对您的问题：**“{last_user or '当前咨询'}”**\n")
        lines.append("- 目前左侧文件树未勾选参考文档。您可以勾选最多 **5 份** PDF / Excel / Markdown / TXT 文件进行跨格式联合问答。")
        lines.append("- 您也可以在右上角设置中填写兼容 OpenAI 接口的 `Base URL` 与 `API Key` 解锁完整云端大模型流式对话。")
        return "\n".join(lines)

    lines.append(f"已联合检索 **{len(context_docs)}** 份本地文件（{', '.join(d['name'] for d in context_docs)}）：\n")

    for doc in context_docs:
        name = str(doc.get("name") or "未知文件")
        ext = str(doc.get("ext") or "").lower()
        text = str(doc.get("text") or "")
        doc_lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

        # Find best matching snippets
        scored_lines: list[tuple[int, int, str]] = []
        current_page = 1
        current_sheet = "Sheet1"

        for idx, ln in enumerate(doc_lines):
            page_m = re.match(r"^\[第\s*(\d+)\s*页\]", ln)
            if page_m:
                current_page = int(page_m.group(1))
            sheet_m = re.match(r"^(?:###\s*Sheet:\s*|当前摘要工作表：)([^\s（(]+)", ln)
            if sheet_m:
                current_sheet = sheet_m.group(1).strip()

            low = ln.lower()
            score = sum(1 for kw in keywords if kw in low)
            if score > 0:
                scored_lines.append((score, idx, f"{current_page}|{current_sheet}|{ln}"))

        scored_lines.sort(key=lambda x: (-x[0], x[1]))

        lines.append(f"### 📄 {name}")
        if scored_lines:
            for _, _, packed in scored_lines[:3]:
                pg_s, sh_s, snippet = packed.split("|", 2)
                anchor = ""
                if ext == ".pdf":
                    anchor = f" [[{name}#page={pg_s}]]"
                elif ext in (".xlsx", ".xlsm"):
                    cell_m = re.search(r"\b([A-Z]{1,3}\d+):", snippet)
                    row_m = re.search(r"第\s*(\d+)\s*行", snippet)
                    if cell_m:
                        cell_ref = cell_m.group(1)
                    elif row_m:
                        cell_ref = f"A{row_m.group(1)}"
                    else:
                        cell_ref = "A1"
                    anchor = f" [[{name}#{sh_s}!{cell_ref}]]"
                clean_snip = re.sub(r"^\[第\s*\d+\s*页\]\s*", "", snippet)[:150]
                lines.append(f"- {clean_snip}{anchor}")
        else:
            preview = next(
                (ln for ln in doc_lines if not ln.startswith("[第") and not ln.startswith("###") and not ln.startswith("| ---")),
                "",
            )
            anchor = ""
            if ext == ".pdf":
                anchor = f" [[{name}#page=1]]"
            elif ext in (".xlsx", ".xlsm"):
                sheet_m = re.search(r"(?:###\s*Sheet:\s*|当前摘要工作表：)([^\s（(]+)", text)
                sh = sheet_m.group(1).strip() if sheet_m else "Sheet1"
                anchor = f" [[{name}#{sh}!A1]]"
            lines.append(f"- 文档摘要：{preview[:140] or '暂无可读文本'}{anchor}")
        lines.append("")

    if last_user:
        lines.append(f"**综合建议**：针对「{last_user[:50]}」，可点击上方蓝色锚点胶囊直接跳转定位到对应 PDF 页码或 Excel 单元格进行核对与原位修改。")
    return "\n".join(lines)


async def stream_chat(
    messages: list[dict[str, Any]],
    web_search: bool = False,
    context_docs: list[dict[str, Any]] | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    """Stream SSE-ready chat events (`delta` then `done`) with automatic offline fallback."""
    docs = context_docs or []
    context_names = [str(d.get("name") or "") for d in docs if d.get("name")]
    runtime = await _resolve_ai_runtime()

    if runtime.get("mode") == "offline":
        reply = _generate_offline_chat_reply(messages, web_search, docs)
        chunk_size = 14
        for i in range(0, len(reply), chunk_size):
            yield {"type": "delta", "content": reply[i : i + chunk_size]}
            await asyncio.sleep(0.015)
        yield {
            "type": "done",
            "meta": {
                "web_search": web_search,
                "context_files": context_names,
                "offline_mode": True,
                "provider_label": runtime["label"],
            },
        }
        return

    system_prompt = _build_chat_system_prompt(docs, web_search)
    api_messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for msg in messages:
        role = str(msg.get("role") or "user")
        if role not in ("user", "assistant", "system"):
            role = "user"
        content = str(msg.get("content") or "")
        if content:
            api_messages.append({"role": role, "content": content})

    url = _build_chat_url(str(runtime["base_url"]))
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if runtime.get("api_key"):
        headers["Authorization"] = f"Bearer {runtime['api_key']}"

    payload: dict[str, Any] = {
        "model": runtime["model"],
        "messages": api_messages,
        "stream": True,
    }
    if web_search and runtime.get("web_search_param"):
        payload[str(runtime["web_search_param"])] = True

    rt_timeout = float(runtime.get("timeout", 45.0))
    if runtime.get("mode") == "free_public":
        client_timeout = httpx.Timeout(rt_timeout)
    else:
        client_timeout = httpx.Timeout(connect=15.0, read=max(rt_timeout, 60.0), write=15.0, pool=15.0)

    emitted_any = False
    raw_lines_buf: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=client_timeout) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as resp:
                resp.raise_for_status()
                async for raw_line in resp.aiter_lines():
                    line = raw_line.strip()
                    if not line:
                        continue
                    if not line.startswith("data:"):
                        if len(raw_lines_buf) < 200:
                            raw_lines_buf.append(line)
                        continue
                    data_str = line[5:].strip()
                    if data_str == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    text_part = delta.get("content")
                    if text_part is None:
                        text_part = (choices[0].get("message") or {}).get("content")
                    if text_part:
                        emitted_any = True
                        yield {"type": "delta", "content": str(text_part)}

        if not emitted_any and raw_lines_buf:
            # Handle gateways returning single JSON completion despite stream=True
            try:
                non_stream = json.loads("\n".join(raw_lines_buf))
                msg_content = str((((non_stream.get("choices") or [{}])[0].get("message") or {}).get("content")) or "")
                if msg_content:
                    emitted_any = True
                    for i in range(0, len(msg_content), 24):
                        yield {"type": "delta", "content": msg_content[i : i + 24]}
            except Exception:
                pass

        if not emitted_any:
            raise RuntimeError("Empty stream from remote API")
        yield {
            "type": "done",
            "meta": {
                "web_search": web_search,
                "context_files": context_names,
                "offline_mode": False,
                "provider_label": runtime["label"],
            },
        }
    except Exception:
        if emitted_any:
            yield {"type": "delta", "content": "\n\n*(远程连接中断，已切换本地兜底总结)*\n"}
        reply = _generate_offline_chat_reply(messages, web_search, docs)
        chunk_size = 16
        for i in range(0, len(reply), chunk_size):
            yield {"type": "delta", "content": reply[i : i + chunk_size]}
            await asyncio.sleep(0.015)
        yield {
            "type": "done",
            "meta": {
                "web_search": web_search,
                "context_files": context_names,
                "offline_mode": True,
                "provider_label": _OFFLINE_LABEL,
            },
        }


# ---------------------------------------------------------------------------
# 4. extract_table_rows
# ---------------------------------------------------------------------------

def _map_free_text_to_row(sentence: str, headers: list[str]) -> list[str]:
    clean = re.sub(r"^[-*•\d.)、\s]+", "", sentence).strip()
    today_str = datetime.now().strftime("%Y-%m-%d")
    num_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:道|题|页|个|小时|分钟|%|次|章)?", clean)
    num_val = num_match.group(1) if num_match else ""

    status_val = "已完成"
    if any(k in clean for k in ("进行中", "复习中", "未完成", "待")):
        status_val = "进行中"

    row: list[str] = []
    content_assigned = False
    for h in headers:
        hl = h.lower()
        if any(k in hl for k in ("日期", "时间", "date", "time")):
            row.append(today_str)
        elif any(k in hl for k in ("状态", "进度", "完成", "status", "progress")):
            row.append(status_val)
        elif any(k in hl for k in ("题数", "数量", "时长", "count", "num", "页数", "分数")):
            row.append(num_val or "1")
        elif any(k in hl for k in ("章节", "任务", "内容", "事项", "备注", "主题", "名称", "说明", "note", "task", "item")):
            row.append(clean if not content_assigned else "")
            content_assigned = True
        else:
            row.append(clean if not content_assigned else "")
            content_assigned = True

    if not content_assigned and row:
        row[-1] = clean
    return row


def _extract_table_rows_offline(text: str, headers: list[str]) -> list[list[str]]:
    cols = len(headers)
    if cols == 0:
        return []

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    rows: list[list[str]] = []

    # 1. Detect Markdown table rows
    md_rows: list[list[str]] = []
    for ln in lines:
        if "|" in ln:
            stripped = ln.strip("|")
            cells = [c.strip() for c in stripped.split("|")]
            # Skip markdown separator row (---)
            if all(re.match(r"^:?-{2,}:?$", c or "---") for c in cells):
                continue
            if len(cells) >= 2:
                md_rows.append(cells)

    if md_rows:
        # Drop header row if it mirrors target headers
        first_norm = [c.lower() for c in md_rows[0]]
        target_norm = [h.lower() for h in headers]
        start_idx = 1 if any(c in target_norm for c in first_norm) else 0
        for cells in md_rows[start_idx:]:
            padded = (cells + [""] * cols)[:cols]
            rows.append(padded)
        if rows:
            return rows

    # 2. Detect tab or comma separated rows
    for ln in lines:
        if "\t" in ln or ("," in ln and ln.count(",") >= max(1, cols - 2) and "，" not in ln):
            sep = "\t" if "\t" in ln else ","
            cells = [c.strip() for c in ln.split(sep)]
            if len(cells) >= 2:
                if any(c.lower() in [h.lower() for h in headers] for c in cells) and not rows:
                    continue
                rows.append((cells + [""] * cols)[:cols])
    if rows:
        return rows

    # 3. Multiple bulleted lines or single free-text completion sentence
    if len(lines) > 1:
        for ln in lines:
            if len(ln) >= 2:
                rows.append(_map_free_text_to_row(ln, headers))
        if rows:
            return rows

    return [_map_free_text_to_row(text, headers)]


async def extract_table_rows(text: str, headers: list[str]) -> dict[str, Any]:
    """Convert free text / AI message / focus-done note into 2D table rows matching `headers`."""
    clean_text = (text or "").strip()
    if not clean_text:
        raise ValueError("请输入要提取填表的文本内容")

    clean_headers = [str(h).strip() for h in (headers or []) if str(h).strip()]
    if not clean_headers:
        raise ValueError("目标表格表头不能为空")

    runtime = await _resolve_ai_runtime()
    if runtime.get("mode") == "offline":
        return {
            "headers": clean_headers,
            "rows": _extract_table_rows_offline(clean_text, clean_headers),
            "offline_mode": True,
            "provider_label": runtime["label"],
        }

    today_str = datetime.now().strftime("%Y-%m-%d")
    system_prompt = (
        "你是智能填表助手。请将用户输入精准拆分为匹配目标表头的二维数组，严格返回 JSON：\n"
        '{"rows": [["列1值", "列2值"]]}\n'
        f"要求：每行长度必须严格等于 {len(clean_headers)}；若表头包含日期且文本未指定日期，默认填 {today_str}；"
        "若表头包含状态且为完成汇报，默认填 已完成。"
    )
    user_prompt = (
        f"目标表头：{json.dumps(clean_headers, ensure_ascii=False)}\n"
        f"待转换内容：\n{_head_tail_truncate(clean_text, 3500)}"
    )

    try:
        parsed = await _call_chat_json(system_prompt, user_prompt, runtime=runtime, timeout=35.0)
        raw_rows = parsed.get("rows")
        if not isinstance(raw_rows, list) or not raw_rows:
            raise ValueError("Empty rows")
        cols = len(clean_headers)
        normalized_rows: list[list[str]] = []
        for r in raw_rows:
            if isinstance(r, list):
                cells = [("" if c is None else str(c).strip()) for c in r]
                normalized_rows.append((cells + [""] * cols)[:cols])
        if not normalized_rows:
            raise ValueError("No valid rows")
        return {
            "headers": clean_headers,
            "rows": normalized_rows,
            "offline_mode": False,
            "provider_label": runtime["label"],
        }
    except Exception:
        return {
            "headers": clean_headers,
            "rows": _extract_table_rows_offline(clean_text, clean_headers),
            "offline_mode": True,
            "provider_label": _OFFLINE_LABEL,
        }


# ---------------------------------------------------------------------------
# 5. classify_file
# ---------------------------------------------------------------------------

def _classify_offline(
    file_label: str,
    content_preview: str,
    nodes: list[dict[str, Any]],
    provider_label: str = _OFFLINE_LABEL,
) -> dict[str, Any]:
    sample = f"{file_label} {content_preview}".lower()
    if not nodes:
        suggested = "学习资料"
        for kw, cat in (
            ("高数", "高等数学"),
            ("数学", "高等数学"),
            ("英语", "英语复习"),
            ("工作", "办公文档"),
            ("报告", "工作报告"),
            ("计划", "任务规划"),
        ):
            if kw in sample:
                suggested = cat
                break
        return {
            "recommended_node_id": None,
            "recommended_node_name": suggested,
            "reason": "当前知识树尚无节点，建议新建该分类节点。",
            "offline_mode": True,
            "provider_label": provider_label,
        }

    best_node: dict[str, Any] | None = None
    best_score = -1
    for node in nodes:
        node_name = str(node.get("name") or "").strip()
        if not node_name:
            continue
        score = 0
        nl = node_name.lower()
        if nl in sample:
            score += 10
        for i in range(max(0, len(nl) - 1)):
            bg = nl[i : i + 2]
            if len(bg.strip()) == 2 and bg in sample:
                score += 2
        # Check bound file names for similarity
        for bf in node.get("files", []):
            if isinstance(bf, dict) and bf.get("path"):
                stem = Path(str(bf["path"])).stem.lower()
                if stem and stem in sample:
                    score += 3
        if score > best_score:
            best_score = score
            best_node = node

    if best_node and best_score > 0:
        return {
            "recommended_node_id": best_node.get("id"),
            "recommended_node_name": str(best_node.get("name") or ""),
            "reason": f"文件名或内容与现有节点「{best_node.get('name')}」语义关键词匹配。",
            "offline_mode": True,
            "provider_label": provider_label,
        }

    first = nodes[0]
    return {
        "recommended_node_id": first.get("id"),
        "recommended_node_name": str(first.get("name") or "默认分类"),
        "reason": "未命中特定关键词，默认推荐归入首个知识树节点。",
        "offline_mode": True,
        "provider_label": provider_label,
    }


async def classify_file(file_path: str | None = None, summary: str = "") -> dict[str, Any]:
    """Recommend the best matching knowledge-tree node for a file or summary."""
    file_label = ""
    preview = (summary or "").strip()

    if file_path:
        resolved, extracted = _extract_text_for_ai(file_path, max_chars=2500)
        file_label = resolved.name
        if not preview:
            preview = extracted.strip()

    if not file_label and not preview:
        raise ValueError("请提供文件路径或摘要文本用于知识树分类")

    nodes = _get_tree_nodes()
    runtime = await _resolve_ai_runtime()
    if runtime.get("mode") == "offline" or not nodes:
        return _classify_offline(file_label, preview, nodes, provider_label=_OFFLINE_LABEL)

    nodes_hint = [{"id": n.get("id"), "name": n.get("name")} for n in nodes]
    system_prompt = (
        "你是知识树分类助手。根据文件信息从现有节点列表选择最匹配的一个节点，返回严格 JSON：\n"
        '{"recommended_node_id": "节点id或null", "recommended_node_name": "节点名称", "reason": "简短中文理由"}'
    )
    user_prompt = (
        f"现有知识树节点：{json.dumps(nodes_hint, ensure_ascii=False)}\n"
        f"文件名：{file_label or '无'}\n"
        f"内容预览：{_head_tail_truncate(preview, 2000)}"
    )

    try:
        parsed = await _call_chat_json(system_prompt, user_prompt, runtime=runtime, timeout=30.0)
        rec_id = parsed.get("recommended_node_id")
        valid_ids = {str(n.get("id")): str(n.get("name") or "") for n in nodes if n.get("id")}
        if rec_id is not None and str(rec_id) in valid_ids:
            rec_id_str = str(rec_id)
            return {
                "recommended_node_id": rec_id_str,
                "recommended_node_name": str(parsed.get("recommended_node_name") or valid_ids[rec_id_str]),
                "reason": str(parsed.get("reason") or "由 AI 根据文档主题匹配推荐"),
                "offline_mode": False,
                "provider_label": runtime["label"],
            }
        rec_name = str(parsed.get("recommended_node_name") or "").strip()
        if rec_name:
            return {
                "recommended_node_id": None,
                "recommended_node_name": rec_name,
                "reason": str(parsed.get("reason") or "建议新建该知识树分类节点"),
                "offline_mode": False,
                "provider_label": runtime["label"],
            }
        raise ValueError("Invalid classification output")
    except Exception:
        return _classify_offline(file_label, preview, nodes, provider_label=_OFFLINE_LABEL)


# ---------------------------------------------------------------------------
# 6. semantic_rerank (for AI Semantic Description Search)
# ---------------------------------------------------------------------------

async def semantic_rerank(query: str, candidates: list[dict[str, Any]], limit: int = 8) -> dict[str, Any] | None:
    """Semantically rerank search candidates against a natural-language description."""
    clean_query = (query or "").strip()
    if not clean_query or not candidates:
        return None

    runtime = await _resolve_ai_runtime()
    if runtime.get("mode") == "offline":
        return None

    capped = [c for c in candidates[:24] if isinstance(c, dict)]
    if not capped:
        return None

    numbered_items: list[str] = []
    for idx, item in enumerate(capped):
        title = str(item.get("name") or item.get("title") or item.get("path") or f"候选{idx}").strip()
        raw_snip = item.get("snippet") or item.get("text") or item.get("preview") or item.get("content") or ""
        snippet = re.sub(r"\s+", " ", str(raw_snip)).strip()[:180]
        numbered_items.append(f"[{idx}] {title} | {snippet}")

    system_prompt = (
        "你是本地文档语义检索重排助手。根据用户描述从候选片段中筛选最语义相关的条目并打分(0-100)，"
        "严格返回 JSON：\n"
        '{"matches": [{"index": 0, "score": 92, "reason": "简短中文解释为什么语义匹配"}]}'
    )
    user_prompt = (
        f"用户描述：{clean_query}\n"
        f"最多返回 {max(1, int(limit))} 条。\n"
        "候选条目：\n" + "\n".join(numbered_items)
    )

    try:
        parsed = await _call_chat_json(system_prompt, user_prompt, runtime=runtime, timeout=float(runtime.get("timeout", 25.0)))
        raw_matches = parsed.get("matches")
        if not isinstance(raw_matches, list):
            return None

        normalized: list[dict[str, Any]] = []
        seen_idx: set[int] = set()
        for m in raw_matches:
            if not isinstance(m, dict):
                continue
            try:
                idx = int(m.get("index"))
            except (TypeError, ValueError):
                continue
            if idx < 0 or idx >= len(capped) or idx in seen_idx:
                continue
            try:
                score = int(round(float(m.get("score", 0))))
            except (TypeError, ValueError):
                score = 0
            score = max(0, min(100, score))
            reason = str(m.get("reason") or "语义相关").strip()[:80]
            seen_idx.add(idx)
            normalized.append({"index": idx, "score": score, "reason": reason})

        normalized.sort(key=lambda x: -x["score"])
        return {
            "matches": normalized[: max(1, int(limit))],
            "provider_label": runtime["label"],
        }
    except Exception:
        return None
