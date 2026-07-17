"""CRUD operations for project_memory table."""

from app.database import get_db


async def get_project_memory(project_id: str) -> dict | None:
    db = get_db()
    result = (
        db.table("project_memory")
        .select("*")
        .eq("project_id", project_id)
        .single()
        .execute()
    )
    return result.data if result.data else None


async def upsert_project_memory(record: dict):
    db = get_db()
    db.table("project_memory").upsert(record, on_conflict="project_id").execute()
