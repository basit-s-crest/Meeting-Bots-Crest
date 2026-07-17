// HTTP client to the Python Memory Service.
// All memory/ML logic lives in the Python service — this is just a thin bridge.

const PYTHON_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://localhost:8001';

/**
 * Fire-and-forget: push a transcript segment to the memory service.
 * Called on every Deepgram final chunk during a live meeting.
 */
function ingestSegment(sessionId, { speaker, text, startTs, endTs, isFinal }) {
  fetch(`${PYTHON_SERVICE_URL}/api/memory/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      speaker,
      text,
      start_ts: startTs ?? 0,
      end_ts: endTs ?? 0,
      is_final: isFinal ?? true,
    }),
  }).catch(err => console.error('[MemoryClient] ingest failed:', err.message));
}

/**
 * Ask a natural language question. Returns { answer, citations }.
 */
async function queryMemory({ question, sessionId, projectId }) {
  const res = await fetch(`${PYTHON_SERVICE_URL}/api/memory/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question,
      session_id: sessionId,
      project_id: projectId,
    }),
  });
  if (!res.ok) throw new Error(`Memory query failed: ${res.status}`);
  return res.json();
}

/**
 * Fire-and-forget: trigger post-meeting extraction.
 * Called when a meeting ends.
 */
function processMeeting(sessionId) {
  fetch(`${PYTHON_SERVICE_URL}/api/memory/process-meeting`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  }).catch(err => console.error('[MemoryClient] process-meeting failed:', err.message));
}

/**
 * Fetch project memory rollup for the dashboard.
 */
async function getProjectMemory(projectId) {
  const res = await fetch(`${PYTHON_SERVICE_URL}/api/memory/projects/${projectId}`);
  if (!res.ok) return null;
  return res.json();
}

export { ingestSegment, queryMemory, processMeeting, getProjectMemory };
