import os
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

print("=== STARTING BACKFILL OF TRANSCRIPT_SEGMENTS.PROJECT_ID ===")

# 1. Map session_id to project_id from meeting_sessions
sess_res = client.table("meeting_sessions").select("session_id, project_id").not_.is_("project_id", "null").execute()
session_project_map = {s["session_id"]: s["project_id"] for s in sess_res.data if s.get("session_id") and s.get("project_id")}

print(f"Mapped {len(session_project_map)} meeting sessions to their project_id.")

# 2. Iterate through sessions and bulk-update transcript_segments
updated_segments_count = 0

for sid, pid in session_project_map.items():
    try:
        upd_res = client.table("transcript_segments").update({"project_id": pid}).eq("session_id", sid).execute()
        count = len(upd_res.data) if upd_res.data else 0
        if count > 0:
            updated_segments_count += count
            print(f"  Session '{sid}' -> Updated {count} segments to project '{pid}'")
    except Exception as e:
        print(f"  Error updating session {sid}: {e}")

print(f"\n=== BACKFILL COMPLETE ===")
print(f"Total transcript_segments updated with project_id: {updated_segments_count}")

# 3. Verification check
verify_res = client.table("transcript_segments").select("id, project_id").not_.is_("project_id", "null").execute()
print(f"Verification query: {len(verify_res.data)} transcript_segments now have non-null project_id!")
