import os
import requests
from supabase import create_client

env_path = r"c:\Users\IshitaBhojani\Meeting-Bots-Crest\.env"
url = ""
key = ""

with open(env_path, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k == "SUPABASE_URL":
                url = v
            elif k in ("SUPABASE_ANON_KEY", "SUPABASE_KEY"):
                key = v

client = create_client(url, key)

# Test if we can update or insert column
print("Testing column existence on transcript_segments...")
try:
    res = client.table("transcript_segments").select("id, session_id, project_id").limit(1).execute()
    print("Column project_id exists!", res.data)
except Exception as e:
    print("Column check result:", e)
