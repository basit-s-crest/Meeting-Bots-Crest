"""Voice Recognition & Neural Embedding Router."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from app.voice_encoder import encode_audio_waveform, compute_voice_similarity
from app.database import get_db

router = APIRouter(tags=["voice"])


class EncodeVoiceRequest(BaseModel):
    samples: Optional[List[float]] = None
    rms: Optional[float] = None
    stddev: Optional[float] = None
    sample_rate: int = 16000


class IdentifyVoiceRequest(BaseModel):
    embedding: List[float]
    threshold: float = 0.65


@router.post("/voice/encode")
async def encode_voice_endpoint(req: EncodeVoiceRequest):
    """Encodes raw audio samples into a 192-dimensional SpeechBrain neural embedding."""
    try:
        samples = req.samples or []
        if not samples and (req.rms is not None or req.stddev is not None):
            from app.voice_encoder import _generate_fallback_embedding
            vec = _generate_fallback_embedding(req.rms or 0.045, req.stddev or 0.015)
        else:
            vec = encode_audio_waveform(samples, sample_rate=req.sample_rate)
        return {"embedding": vec, "dimensions": len(vec)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Voice encoding failed: {str(e)}")


@router.post("/voice/identify")
async def identify_voice_endpoint(req: IdentifyVoiceRequest):
    """
    Compares an incoming 192-dimensional voice embedding against stored user_voice_profiles
    using cosine similarity to identify the speaker biometrically.
    """
    if not req.embedding or len(req.embedding) != 192:
        raise HTTPException(status_code=400, detail="A valid 192-dimensional embedding vector is required.")

    db = get_db()
    try:
        profiles_res = db.table("user_voice_profiles").select("user_id, voice_embedding").execute()
        profiles = profiles_res.data or []

        best_match = None
        highest_similarity = 0.0

        for p in profiles:
            saved_vec = p.get("voice_embedding")
            if saved_vec:
                sim = compute_voice_similarity(req.embedding, saved_vec)
                if sim > highest_similarity:
                    highest_similarity = sim
                    best_match = p.get("user_id")

        if best_match and highest_similarity >= req.threshold:
            return {
                "matched_user_id": best_match,
                "confidence": round(highest_similarity, 4),
                "verified": True
            }

        return {
            "matched_user_id": None,
            "confidence": round(highest_similarity, 4),
            "verified": False
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Voice identification query failed: {str(e)}")
