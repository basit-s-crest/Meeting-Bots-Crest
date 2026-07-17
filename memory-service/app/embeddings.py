from sentence_transformers import SentenceTransformer

_model: SentenceTransformer | None = None
_MODEL_NAME = "BAAI/bge-small-en-v1.5"


def init_embedder():
    global _model
    print(f"[MemoryService] Loading embedding model: {_MODEL_NAME}")
    _model = SentenceTransformer(_MODEL_NAME)
    print("[MemoryService] Embedding model loaded")


def embed(text: str) -> list[float]:
    if _model is None:
        raise RuntimeError("Embedder not initialized. Call init_embedder() first.")
    return _model.encode(text).tolist()


def embed_batch(texts: list[str]) -> list[list[float]]:
    if _model is None:
        raise RuntimeError("Embedder not initialized. Call init_embedder() first.")
    return _model.encode(texts).tolist()
