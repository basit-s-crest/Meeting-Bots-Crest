import asyncio
import json
import traceback

import redis.asyncio as redis
from fastapi import APIRouter, BackgroundTasks
from pydantic import BaseModel

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
    project_id: str | None = None
    speaker: str = "Unknown"
    text: str = ""
    start_ts: float = 0.0
    end_ts: float = 0.0
    is_final: bool = True


@router.post("/ingest")
async def ingest_segment(
    req: IngestRequest,
    background_tasks: BackgroundTasks = None,
):
    """Receive a transcript segment. Push to Redis, then async insert to Postgres."""

    # Auto-resolve project_id from meeting_sessions if not explicitly passed
    if not req.project_id and req.session_id:
        for resolve_attempt in range(1, 3):
            try:
                db = get_db()
                sess = db.table("meeting_sessions").select("project_id").eq("session_id", req.session_id).limit(1).execute()
                if sess.data and sess.data[0].get("project_id"):
                    req.project_id = sess.data[0]["project_id"]
                break
            except Exception as e:
                if resolve_attempt < 2:
                    await asyncio.sleep(0.3)
                else:
                    print(f"[Ingestion] Warning: Failed to auto-resolve project_id for session {req.session_id}: {e}")

    segment = {
        "session_id": req.session_id,
        "project_id": req.project_id,
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
    """Embed and persist a segment with retry & exponential backoff on transient failure."""
    max_retries = 3
    base_delay = 0.5

    for attempt in range(1, max_retries + 1):
        try:
            text = segment.get("text", "")
            if text.strip() and "embedding" not in segment:
                embedding = embed(text)
                segment["embedding"] = embedding
            await insert_segment(segment)
            print(f"[Ingestion] Segment stored successfully (attempt {attempt}): session={segment.get('session_id')} speaker={segment.get('speaker_label')}")
            return
        except Exception as e:
            if attempt < max_retries:
                delay = base_delay * (2 ** (attempt - 1))
                print(f"[Ingestion] Transient failure writing segment (attempt {attempt}/{max_retries}): {e}. Retrying in {delay}s...")
                await asyncio.sleep(delay)
            else:
                print(f"[Ingestion] CRITICAL ERROR: Segment write FAILED after {max_retries} attempts for session={segment.get('session_id')}, speaker={segment.get('speaker_label')}. Error: {e}")
                traceback.print_exc()
