from supabase import create_client, Client

from app.config import SUPABASE_URL, SUPABASE_KEY

_client: Client | None = None


def init_supabase():
    global _client
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("[MemoryService] Warning: SUPABASE_URL or SUPABASE_KEY not set")
        _client = None
        return
    _client = create_client(SUPABASE_URL, SUPABASE_KEY)
    print("[MemoryService] Supabase client initialized")


def get_db() -> Client:
    if _client is None:
        raise RuntimeError("Supabase not initialized. Call init_supabase() first.")
    return _client
