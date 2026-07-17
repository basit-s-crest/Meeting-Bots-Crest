"""CRUD operations for transcript_segments table."""

from app.database import get_db


async def get_segments(session_id: str) -> list[dict]:
    db = get_db()
    result = (
        db.table("transcript_segments")
        .select("*")
        .eq("session_id", session_id)
        .order("start_ts")
        .execute()
    )
    return result.data


async def insert_segment(segment: dict):
    db = get_db()
    db.table("transcript_segments").insert(segment).execute()
