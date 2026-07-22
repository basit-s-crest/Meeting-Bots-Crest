"""Groq client initialization and shared synthesis."""

from groq import Groq

from app.config import GROQ_API_KEY

_client: Groq | None = None
_SYNTHESIS_MODEL = "llama-3.3-70b-versatile"


def get_groq() -> Groq:
    global _client
    if _client is None:
        if not GROQ_API_KEY:
            raise RuntimeError("GROQ_API_KEY not set")
        _client = Groq(api_key=GROQ_API_KEY)
    return _client


def build_synthesis_prompt(question: str, context: list[str]) -> str:
    context_str = "\n".join(context) if context else "No relevant context found."
    return (
        "Answer the question based on the provided context below.\n"
        "Always cite the source meeting date and platform when context is available.\n"
        "If chat history is provided and contains the answer (e.g. a previous "
        'response in this session), use it. Otherwise say '
        '"I could not find that in past meetings."\n\n'
        "Context:\n"
        f"{context_str}\n\n"
        f"Question: {question}\n\n"
        'Return JSON: {{ "answer": string, "citations": [{{"meetingDate": string, '
        '"platform": string, "snippet": string}}] }}'
    )
