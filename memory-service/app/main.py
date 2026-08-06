from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI

from app.config import MEMORY_SERVICE_PORT
from app.database import init_supabase, is_db_connected
from app.embeddings import init_embedder
from app.ingestion import router as ingestion_router
from app.query_router import router as query_router
from app.post_meeting import router as post_meeting_router
from app.meetings_router import router as meetings_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_supabase()
    init_embedder()
    yield


app = FastAPI(title="Meeting Memory Service", lifespan=lifespan)


@app.get("/health")
async def health():
    db_connected = is_db_connected()
    return {
        "status": "ok" if db_connected else "degraded",
        "service": "meeting-memory-service",
        "database_connected": db_connected
    }


app.include_router(ingestion_router, prefix="/api/memory")
app.include_router(query_router, prefix="/api/memory")
app.include_router(post_meeting_router, prefix="/api/memory")
app.include_router(meetings_router, prefix="/api/memory")


def start():
    uvicorn.run("app.main:app", host="0.0.0.0", port=MEMORY_SERVICE_PORT, reload=True)
