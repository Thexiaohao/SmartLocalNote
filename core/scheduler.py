"""Background APScheduler reminders, winotify notifications, and thread-safe SSE broadcaster."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
import json
import sys
import threading
from typing import Any, AsyncIterator
import uuid

from apscheduler.schedulers.background import BackgroundScheduler

from config import TASKS_FILE, atomic_write_json, ensure_data_dirs
from core import safe_io

_LOCK = threading.RLock()
_SCHEDULER: BackgroundScheduler | None = None

_SSE_LOCK = threading.Lock()
_EVENT_LOOP: asyncio.AbstractEventLoop | None = None
_SUBSCRIBERS: set[asyncio.Queue[tuple[str, dict[str, Any]]]] = set()


def register_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Register the main FastAPI asyncio event loop for thread-safe SSE fan-out."""
    global _EVENT_LOOP
    with _SSE_LOCK:
        _EVENT_LOOP = loop


def publish_event(event_type: str, payload: dict[str, Any]) -> None:
    """Thread-safely push an SSE event to all active connected client queues."""
    clean_type = str(event_type or "message").strip() or "message"
    data_copy = dict(payload) if isinstance(payload, dict) else {"value": payload}

    with _SSE_LOCK:
        loop = _EVENT_LOOP
        subscribers = list(_SUBSCRIBERS)

    if not subscribers:
        return

    def _dispatch() -> None:
        for queue in subscribers:
            try:
                queue.put_nowait((clean_type, data_copy))
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                    queue.put_nowait((clean_type, data_copy))
                except Exception:
                    pass
            except Exception:
                pass

    if loop is not None and not loop.is_closed():
        try:
            running_loop = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None

        if running_loop is loop:
            _dispatch()
        else:
            try:
                loop.call_soon_threadsafe(_dispatch)
            except RuntimeError:
                pass
    else:
        _dispatch()


async def sse_event_generator() -> AsyncIterator[str]:
    """Async generator yielding SSE frames with 20-second keep-alive pings."""
    loop = asyncio.get_running_loop()
    register_event_loop(loop)

    queue: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue(maxsize=128)
    with _SSE_LOCK:
        _SUBSCRIBERS.add(queue)

    try:
        # Initial handshake comment so clients receive headers immediately
        yield ": connected\n\n"
        while True:
            try:
                event_type, payload = await asyncio.wait_for(queue.get(), timeout=20.0)
                serialized = json.dumps(payload, ensure_ascii=False)
                yield f"event: {event_type}\ndata: {serialized}\n\n"
            except asyncio.TimeoutError:
                yield ": ping\n\n"
    finally:
        with _SSE_LOCK:
            _SUBSCRIBERS.discard(queue)


def _load_tasks_data() -> dict[str, list[dict[str, Any]]]:
    ensure_data_dirs()
    try:
        with open(TASKS_FILE, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            return {"tasks": []}
        tasks = [item for item in raw.get("tasks", []) if isinstance(item, dict)]
        return {"tasks": tasks}
    except (OSError, json.JSONDecodeError):
        return {"tasks": []}


def _save_tasks_data(data: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    ensure_data_dirs()
    payload = {"tasks": list(data.get("tasks", []))}
    atomic_write_json(TASKS_FILE, payload)
    return payload


def _parse_iso_datetime(value: str) -> datetime:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("提醒时间不能为空")
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    dt = datetime.fromisoformat(raw)
    # Normalize timezone-aware timestamps to local naive datetime for APScheduler consistency
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt


def _notify_windows(title: str) -> None:
    """Best-effort Windows toast notification via winotify (silently degrades elsewhere)."""
    if sys.platform != "win32":
        return
    try:
        from winotify import Notification  # type: ignore

        toast = Notification(
            app_id="SmartLocalNote",
            title="SmartLocalNote 提醒",
            msg=str(title or "待办提醒时间到"),
        )
        toast.show()
    except Exception:
        pass


def _fire_reminder_job(reminder_id: str) -> None:
    """APScheduler job callback when a scheduled reminder reaches its trigger time."""
    fired_item: dict[str, Any] | None = None
    with _LOCK:
        data = _load_tasks_data()
        for task in data["tasks"]:
            if task.get("id") == reminder_id:
                task["status"] = "fired"
                task["fired_at"] = datetime.now().isoformat(timespec="seconds")
                fired_item = dict(task)
                break
        if fired_item is not None:
            _save_tasks_data(data)

    if fired_item is None:
        return

    _notify_windows(str(fired_item.get("title") or ""))
    publish_event("reminder:fired", fired_item)


def _schedule_job(reminder: dict[str, Any]) -> None:
    if _SCHEDULER is None or not _SCHEDULER.running:
        return
    reminder_id = str(reminder.get("id") or "")
    trigger_raw = str(reminder.get("trigger_at") or "")
    if not reminder_id or not trigger_raw:
        return
    try:
        run_dt = _parse_iso_datetime(trigger_raw)
    except ValueError:
        return

    _SCHEDULER.add_job(
        _fire_reminder_job,
        trigger="date",
        run_date=run_dt,
        args=[reminder_id],
        id=reminder_id,
        replace_existing=True,
        misfire_grace_time=300,
    )


def start_scheduler() -> None:
    """Start the background APScheduler, restore pending reminders, and bind snapshot SSE hook."""
    global _SCHEDULER
    try:
        loop = asyncio.get_running_loop()
        register_event_loop(loop)
    except RuntimeError:
        pass

    safe_io.set_snapshot_hook(lambda info: publish_event("snapshot:created", info))

    with _LOCK:
        if _SCHEDULER is None:
            _SCHEDULER = BackgroundScheduler()
        if not _SCHEDULER.running:
            _SCHEDULER.start()

        now = datetime.now()
        data = _load_tasks_data()
        for task in data["tasks"]:
            if task.get("status") != "pending":
                continue
            trigger_raw = str(task.get("trigger_at") or "")
            try:
                run_dt = _parse_iso_datetime(trigger_raw)
            except ValueError:
                continue
            # Schedule pending tasks (including slightly overdue ones within misfire window)
            if run_dt <= now:
                task["trigger_at"] = (now + timedelta(seconds=1)).isoformat(timespec="seconds")
                _save_tasks_data(data)
            _schedule_job(task)


def stop_scheduler() -> None:
    """Shut down the background APScheduler cleanly and clear snapshot hook."""
    global _SCHEDULER
    safe_io.set_snapshot_hook(None)
    with _LOCK:
        if _SCHEDULER is not None:
            try:
                if _SCHEDULER.running:
                    _SCHEDULER.shutdown(wait=False)
            except Exception:
                pass
            _SCHEDULER = None


def list_reminders() -> list[dict[str, Any]]:
    """Return all saved reminders ordered by creation/trigger time."""
    with _LOCK:
        return _load_tasks_data()["tasks"]


def create_reminder(
    title: str,
    trigger_at: str | None = None,
    delay_seconds: int | None = None,
    app_ids: list[str] | None = None,
    file_paths: list[str] | None = None,
) -> dict[str, Any]:
    """Create and schedule a one-shot reminder using either ISO8601 `trigger_at` or `delay_seconds`."""
    clean_title = str(title or "").strip()
    if not clean_title:
        raise ValueError("提醒内容不能为空")

    now = datetime.now()
    if delay_seconds is not None:
        try:
            delay = int(delay_seconds)
        except (TypeError, ValueError) as exc:
            raise ValueError("delay_seconds 必须为整数") from exc
        if delay < 1:
            raise ValueError("delay_seconds 必须大于等于 1 秒")
        run_dt = now + timedelta(seconds=delay)
    elif trigger_at is not None and str(trigger_at).strip():
        run_dt = _parse_iso_datetime(trigger_at)
    else:
        raise ValueError("请提供 trigger_at 或 delay_seconds")

    clean_app_ids = [str(a).strip() for a in (app_ids or []) if str(a).strip()]
    clean_file_paths = [str(p).strip() for p in (file_paths or []) if str(p).strip()]

    reminder = {
        "id": f"rem_{uuid.uuid4().hex[:8]}",
        "title": clean_title,
        "trigger_at": run_dt.isoformat(timespec="seconds"),
        "status": "pending",
        "app_ids": clean_app_ids,
        "file_paths": clean_file_paths,
        "created_at": now.isoformat(timespec="seconds"),
    }

    with _LOCK:
        if _SCHEDULER is None or not _SCHEDULER.running:
            start_scheduler()
        data = _load_tasks_data()
        data["tasks"].append(reminder)
        _save_tasks_data(data)
        _schedule_job(reminder)

    return dict(reminder)


def delete_reminder(reminder_id: str) -> dict[str, Any]:
    """Cancel any pending APScheduler job and remove the reminder from `tasks.json`."""
    target_id = str(reminder_id or "").strip()
    if not target_id:
        raise ValueError("reminder_id 不能为空")

    with _LOCK:
        if _SCHEDULER is not None and _SCHEDULER.running:
            try:
                _SCHEDULER.remove_job(target_id)
            except Exception:
                pass

        data = _load_tasks_data()
        remaining = [t for t in data["tasks"] if t.get("id") != target_id]
        if len(remaining) == len(data["tasks"]):
            raise FileNotFoundError(f"未找到提醒任务：{target_id}")
        data["tasks"] = remaining
        _save_tasks_data(data)

    return {"id": target_id, "deleted": True}
