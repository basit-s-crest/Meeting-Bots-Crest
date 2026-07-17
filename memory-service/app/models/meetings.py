"""CRUD operations for meeting_sessions table."""

from app.database import get_db


async def get_meeting(session_id: str) -> dict | None:
    db = get_db()
    result = (
        db.table("meeting_sessions")
        .select("*")
        .eq("session_id", session_id)
        .single()
        .execute()
    )
    return result.data if result.data else None


async def mark_meeting_completed(session_id: str):
    db = get_db()
    db.table("meeting_sessions").update(
        {"status": "completed"}
    ).eq("session_id", session_id).execute()
