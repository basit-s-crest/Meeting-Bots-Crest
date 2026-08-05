import os
from pathlib import Path
from dotenv import load_dotenv

# Search for central root .env file first, then fallback to local memory-service/.env
root_env = Path(__file__).resolve().parent.parent.parent / ".env"
local_env = Path(__file__).resolve().parent.parent / ".env"

if root_env.exists():
    load_dotenv(dotenv_path=root_env, override=True)

if local_env.exists():
    load_dotenv(dotenv_path=local_env, override=False)

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
MEMORY_SERVICE_PORT = int(os.getenv("MEMORY_SERVICE_PORT", "8001"))
