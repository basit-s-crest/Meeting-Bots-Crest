import os
from dotenv import load_dotenv

load_dotenv(override=True)


SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
MEMORY_SERVICE_PORT = int(os.getenv("MEMORY_SERVICE_PORT", "8001"))
