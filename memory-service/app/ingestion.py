import json

import redis.asyncio as redis
from fastapi import APIRouter, BackgroundTasks, Body
from fastapi import APIRouter, BackgroundTasks
from pydantic import BaseModel, Field

from app.config import REDIS_URL
from app.database import get_db
from app.embeddings import embed
from app.models.segments import insert_segment

router = APIRouter()

_redis_client: redis.Redis | None = None


def get_redis() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(REDIS_URL, decode_responses=True)
    return _redis_client


class IngestRequest(BaseModel):
    session_id: str
    speaker: str = "Unknown"
    text: str = ""
    start_ts: float = 0.0
    end_ts: float = 0.0
    is_final: bool = True


@router.post("/ingest")
async def ingest_segment(
    session_id: str = Body(...),
    speaker: str = Body(...),
    text: str = Body(...),
    start_ts: float = Body(0.0),
    end_ts: float = Body(0.0),
    is_final: bool = Body(True),
    req: IngestRequest,
    background_tasks: BackgroundTasks = None,
):
    """Receive a transcript segment. Push to Redis, then async insert to Postgres."""

    segment = {
        "session_id": req.session_id,
        "speaker_label": req.speaker,
        "text": req.text,
        "start_ts": req.start_ts,
        "end_ts": req.end_ts,
        "is_final": req.is_final,
    }

    # Hot path: push to Redis immediately (sub-second retrieval for live queries)
    try:
        r = get_redis()
        await r.rpush(f"session:{req.session_id}:segments", json.dumps(segment))
        await r.expire(f"session:{req.session_id}:segments", 21600)  # 6h TTL
    except Exception as e:
        print(f"[Ingestion] Redis unavailable (non-fatal): {e}")

    # Cold path: embed + store to Postgres in background task
    if background_tasks:
        background_tasks.add_task(_store_segment, segment)

    return {"status": "accepted"}


async def _store_segment(segment: dict):
    """Embed and persist a segment. Runs in background — doesn't block the caller."""
    try:
        text = segment.get("text", "")
        if text.strip():
            embedding = embed(text)
            segment["embedding"] = embedding
        await insert_segment(segment)
    except Exception as e:
        print(f"[Ingestion] Background store failed: {e}")
