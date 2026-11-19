"""System configuration, path picker, health info, and SSE event stream routes."""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Any, Literal

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api import ok
from config import get_local_ip, load_config, update_config
from core import app_launcher, scheduler

router = APIRouter(prefix="/api", tags=["system"])

_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


class ConfigPatch(BaseModel):
    port: int | None = None
    theme: str | None = None
    ai: dict[str, Any] | None = None
    whitelist_dirs: list[str] | None = None
    private_files: list[str] | None = None
    default_notes_dir: str | None = None
    default_progress_excel: str | None = None


class PickPathBody(BaseModel):
    mode: Literal["file", "folder", "app"] = "file"


@router.get("/system/info")
def get_system_info() -> dict:
    cfg = load_config()
    active_port = int(os.environ.get("SMARTLOCALNOTE_ACTIVE_PORT") or cfg["port"])
    return ok({
        "ip": get_local_ip(),
        "port": active_port,
        "platform": sys.platform,
        "ai_configured": bool(str(cfg["ai"].get("api_key", "")).strip()),
        "default_progress_excel": cfg.get("default_progress_excel", ""),
    })


@router.get("/system/config")
def get_system_config() -> dict:
    return ok(load_config())


@router.put("/system/config")
def put_system_config(payload: ConfigPatch) -> dict:
    updated = update_config(payload.model_dump(exclude_none=True))
    return ok(updated, message="配置已更新")


@router.post("/system/pick-path")
def pick_path(payload: PickPathBody) -> dict:
    return ok(app_launcher.pick_local_path(payload.mode))


@router.get("/events")
async def stream_events() -> StreamingResponse:
    scheduler.register_event_loop(asyncio.get_running_loop())
    return StreamingResponse(
        scheduler.sse_event_generator(),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )
