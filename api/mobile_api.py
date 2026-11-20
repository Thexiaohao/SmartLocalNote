"""Thin FastAPI routes for Android LAN direct bridge, pairing, quick push & sync manifest."""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

from api import err, ok
from core import mobile_bridge

router = APIRouter(prefix="/api/mobile", tags=["mobile"])


class PairBody(BaseModel):
    pin: str
    device_name: str = "Android 手机"


class QuickStickyBody(BaseModel):
    text: str
    color: str = "yellow"
    device_name: str = "Android"
    token: str = ""


class ClipboardBody(BaseModel):
    text: str
    device_name: str = "Android"
    token: str = ""


class UploadBody(BaseModel):
    filename: str
    content_base64: str
    target_dir: str = "手机直传"
    add_to_shelf: bool = True
    note_append: bool = False
    token: str = ""


def _check_auth(request: Request, token_field: str = "") -> None:
    client_host = request.client.host if request.client else ""
    token = (
        request.headers.get("X-SLN-Token")
        or request.query_params.get("token")
        or token_field
        or ""
    )
    if not mobile_bridge.verify_token(token, client_host=client_host):
        raise PermissionError("未授权的移动端请求，请先扫码或输入配对码完成配对")


@router.get("/ping")
def mobile_ping() -> dict:
    return ok(mobile_bridge.get_ping_info())


@router.get("/pair-info")
def mobile_pair_info(request: Request) -> dict:
    _check_auth(request)
    return ok(mobile_bridge.get_pairing_info())


@router.post("/pair")
def mobile_pair(payload: PairBody):
    result = mobile_bridge.verify_pair_pin(payload.pin, payload.device_name)
    if not result.get("ok"):
        return err(str(result.get("error") or "配对码不正确"), status_code=401)
    return ok(result, message="配对成功")


@router.post("/rotate-pin")
def mobile_rotate_pin(request: Request) -> dict:
    _check_auth(request)
    return ok(mobile_bridge.rotate_pin(), message="配对码已刷新")


@router.post("/quick-sticky")
def mobile_quick_sticky(payload: QuickStickyBody, request: Request) -> dict:
    _check_auth(request, payload.token)
    res = mobile_bridge.receive_quick_sticky(payload.text, payload.color, payload.device_name)
    return ok(res, message="已发送闪念到桌面端")


@router.post("/clipboard")
def mobile_clipboard(payload: ClipboardBody, request: Request) -> dict:
    _check_auth(request, payload.token)
    res = mobile_bridge.receive_mobile_clipboard(payload.text, payload.device_name)
    return ok(res, message="已推送到桌面端剪贴板")


@router.post("/upload")
def mobile_upload(payload: UploadBody, request: Request) -> dict:
    _check_auth(request, payload.token)
    res = mobile_bridge.receive_mobile_upload_base64(
        payload.filename,
        payload.content_base64,
        payload.target_dir,
        payload.add_to_shelf,
        payload.note_append,
    )
    return ok(res, message="文件已直传至本地笔记目录")


@router.get("/sync-manifest")
def mobile_sync_manifest(request: Request) -> dict:
    _check_auth(request)
    return ok(mobile_bridge.get_sync_manifest())
