"""Speaker & Assignee Resolver.

Resolves meeting action item assignees to platform user IDs using:
1. Normalized display-name fingerprint matching (user_speaker_fingerprints)
2. In-session audio profile & voice-energy comparisons (user_voice_profiles)
3. Project ownership context
"""

import re
from typing import Optional, List
from app.database import get_db
from app.voice_encoder import compute_voice_similarity


def normalize_name(name: str) -> str:
    """Normalize a display name: lowercase, strip punctuation, trim whitespace."""
    if not name:
        return ""
    # Strip common prefixes/suffixes and punctuation
    cleaned = re.sub(r"[^\w\s]", "", name.lower())
    return re.sub(r"\s+", " ", cleaned).strip()


async def resolve_assignee(
    assignee_str: Optional[str],
    session_id: str,
    project_id: Optional[str] = None,
    voice_embedding: Optional[List[float]] = None,
) -> dict:
    """
    Resolve an assignee name to a platform user_id and confidence score.

    Returns:
        dict: {
            "assignee_user_id": str | None,
            "assignee_confidence": float,
            "assignee_confirmed": bool,
            "reason": str
        }
    """
    if not assignee_str or not assignee_str.strip():
        return {
            "assignee_user_id": None,
            "assignee_confidence": 0.0,
            "assignee_confirmed": False,
            "reason": "no_assignee_provided"
        }

    norm_assignee = normalize_name(assignee_str)
    if not norm_assignee or norm_assignee in ("unassigned", "anyone", "team", "tbd", "everyone"):
        return {
            "assignee_user_id": None,
            "assignee_confidence": 0.0,
            "assignee_confirmed": False,
            "reason": "generic_assignee"
        }

    db = get_db()

    # 1. Fetch project owner user_id if project_id exists
    project_user_id = None
    project_owner_name = None
    if project_id:
        try:
            proj_res = db.table("projects").select("user_id").eq("id", project_id).execute()
            if proj_res.data and len(proj_res.data) > 0:
                project_user_id = proj_res.data[0].get("user_id")
                if project_user_id:
                    user_res = db.table("users").select("name").eq("id", project_user_id).execute()
                    if user_res.data and len(user_res.data) > 0:
                        project_owner_name = user_res.data[0].get("name")
        except Exception as e:
            print(f"[Resolver] Error fetching project owner: {e}")

    # 1.5. If voice_embedding is provided, perform biometric vector matching
    if voice_embedding:
        try:
            vp_res = db.table("user_voice_profiles").select("user_id, voice_embedding").execute()
            for vp in (vp_res.data or []):
                saved_vec = vp.get("voice_embedding")
                sim = compute_voice_similarity(voice_embedding, saved_vec)
                if sim >= 0.65:
                    matched_user_id = vp.get("user_id")
                    # Scale 0.65 -> 0.85, 0.80+ -> 0.98
                    scaled_conf = min(1.0, max(0.60, round((sim - 0.3) / 0.55, 4)))
                    return {
                        "assignee_user_id": matched_user_id,
                        "assignee_confidence": scaled_conf,
                        "assignee_confirmed": True,
                        "reason": f"neural_voice_biometric_match (cos_sim={round(sim, 3)}, conf={round(scaled_conf, 2)})"
                    }
        except Exception as e:
            print(f"[Resolver] Error in voice biometric matching: {e}")

    # 2. Look up user_speaker_fingerprints for exact normalized match
    try:
        fp_res = db.table("user_speaker_fingerprints").select(
            "user_id, display_name, display_name_normalized"
        ).eq("display_name_normalized", norm_assignee).execute()

        candidates = fp_res.data or []

        # If exact match found for single user
        if len(candidates) == 1:
            matched_user_id = candidates[0]["user_id"]
            return {
                "assignee_user_id": matched_user_id,
                "assignee_confidence": 0.95,
                "assignee_confirmed": (matched_user_id == project_user_id),
                "reason": "exact_fingerprint_match"
            }

        # If multiple users share the exact name, prioritize project owner
        if len(candidates) > 1:
            if project_user_id and any(c["user_id"] == project_user_id for c in candidates):
                return {
                    "assignee_user_id": project_user_id,
                    "assignee_confidence": 0.80,
                    "assignee_confirmed": False,
                    "reason": "multi_match_project_owner_priority"
                }

        # 3. Fuzzy / Partial matching on fingerprints (e.g. "Basit" matches "Basit Sachinwala")
        all_fps = db.table("user_speaker_fingerprints").select(
            "user_id, display_name, display_name_normalized"
        ).execute()

        partial_matches = []
        for fp in (all_fps.data or []):
            fp_norm = fp.get("display_name_normalized", "")
            if norm_assignee in fp_norm.split() or fp_norm in norm_assignee.split():
                partial_matches.append(fp)

        if len(partial_matches) == 1:
            matched_user_id = partial_matches[0]["user_id"]
            return {
                "assignee_user_id": matched_user_id,
                "assignee_confidence": 0.85,
                "assignee_confirmed": (matched_user_id == project_user_id),
                "reason": "partial_fingerprint_match"
            }
        elif len(partial_matches) > 1:
            if project_user_id and any(c["user_id"] == project_user_id for c in partial_matches):
                return {
                    "assignee_user_id": project_user_id,
                    "assignee_confidence": 0.75,
                    "assignee_confirmed": False,
                    "reason": "partial_match_project_owner_priority"
                }

        # 4. Fallback to Project Owner Name if no fingerprint exists yet
        if project_user_id and project_owner_name:
            owner_norm = normalize_name(project_owner_name)
            if norm_assignee == owner_norm or norm_assignee in owner_norm.split() or owner_norm in norm_assignee.split():
                return {
                    "assignee_user_id": project_user_id,
                    "assignee_confidence": 0.70,
                    "assignee_confirmed": False,
                    "reason": "project_owner_name_match"
                }

    except Exception as e:
        print(f"[Resolver] Fingerprint query failed: {e}")

    # No confident match
    return {
        "assignee_user_id": None,
        "assignee_confidence": 0.0,
        "assignee_confirmed": False,
        "reason": "unmatched_speaker"
    }
