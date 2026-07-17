"""CRUD operations for meeting_events table."""

from app.database import get_db


async def insert_event(event: dict):
    db = get_db()
    db.table("meeting_events").insert(event).execute()


async def get_events_by_project(project_id: str, category: str | None = None, limit: int = 10) -> list[dict]:
    db = get_db()
    query = (
        db.table("meeting_events")
        .select("*")
        .eq("project_id", project_id)
        .order("meeting_date", desc=True)
    )
    if category:
        query = query.eq("category", category)
    result = query.limit(limit).execute()
    return result.data
