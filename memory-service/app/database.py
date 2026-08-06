from fastapi import HTTPException
from supabase import create_client, Client

from app.config import SUPABASE_URL, SUPABASE_KEY

_client: Client | None = None


def init_supabase():
    global _client
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("[MemoryService] Warning: SUPABASE_URL or SUPABASE_KEY not set")
        _client = None
        return
    try:
        _client = create_client(SUPABASE_URL, SUPABASE_KEY)
        print("[MemoryService] Supabase client initialized")
    except Exception as e:
        print(f"[MemoryService] Error initializing Supabase client: {e}")
        _client = None


def is_db_connected() -> bool:
    return _client is not None


def get_db() -> Client:
    if _client is None:
        raise HTTPException(
            status_code=503,
            detail="Database service unavailable: Supabase client is not initialized. Please check SUPABASE_URL and SUPABASE_KEY."
        )
    return _client
