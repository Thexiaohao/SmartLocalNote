"""Thin FastAPI search route exposing dual-mode local search (`/api/search`)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from api import ok
from core import search_engine

router = APIRouter(prefix="/api", tags=["search"])


class SearchBody(BaseModel):
    query: str
    mode: Literal["keyword", "semantic"] = "keyword"
    limit: int = Field(default=15, ge=1, le=50)


@router.post("/search")
async def run_search(body: SearchBody) -> dict:
    return ok(await search_engine.search_workspace(body.query, body.mode, body.limit))
