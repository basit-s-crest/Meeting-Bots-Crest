const PYTHON_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://127.0.0.1:8001';

/**
 * Fire-and-forget: push a transcript segment to the memory service.
 * Called on every Deepgram final chunk during a live meeting.
 */
function ingestSegment(sessionId, { speaker, text, startTs, endTs, isFinal, projectId }) {
  const urls = [PYTHON_SERVICE_URL, 'http://127.0.0.1:8000'];
  for (const url of urls) {
    fetch(`${url}/api/memory/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        project_id: projectId ?? null,
        speaker,
        text,
        start_ts: startTs ?? 0,
        end_ts: endTs ?? 0,
        is_final: isFinal ?? true,
      }),
    })
    .then(() => {})
    .catch(() => {});
  }
}

/**
 * Ask a natural language question. Returns { answer, citations }.
 */
async function queryMemory({ question, sessionId, projectId, project_id }) {
  const pid = projectId || project_id; // accept both camelCase and snake_case
  const serviceUrls = [PYTHON_SERVICE_URL, 'http://127.0.0.1:8001', 'http://127.0.0.1:8000'];
  const uniqueUrls = [...new Set(serviceUrls.filter(Boolean))];

  for (const url of uniqueUrls) {
    try {
      const res = await fetch(`${url}/api/memory/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          session_id: sessionId,
          project_id: pid,
        }),
      });
      if (res.ok) {
        return await res.json();
      }
    } catch (err) {
      // Continue to next URL
    }
  }

  console.warn('[MemoryClient] Python memory service unreachable.');
  return {
    answer: "The AI Memory Service is currently unavailable. Please ensure the memory service is running.",
    citations: []
  };
}

/**
 * Fire-and-forget: trigger post-meeting extraction.
 * Called when a meeting ends.
 */
function processMeeting(sessionId) {
  const urls = [PYTHON_SERVICE_URL, 'http://127.0.0.1:8000'];
  console.log(`[MemoryClient] Triggering processMeeting for session ${sessionId}...`);
  for (const url of urls) {
    fetch(`${url}/api/memory/process-meeting`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    })
    .then(res => {
      if (res.ok) console.log(`[MemoryClient] processMeeting sent to ${url} — ${res.status}`);
      else console.warn(`[MemoryClient] processMeeting failed at ${url} — ${res.status}`);
    })
    .catch(err => console.warn(`[MemoryClient] processMeeting error at ${url}: ${err.message}`));
  }
}

/**
 * Fetch project memory rollup for the dashboard.
 */
async function getProjectMemory(projectId) {
  const serviceUrls = [PYTHON_SERVICE_URL, 'http://127.0.0.1:8001', 'http://127.0.0.1:8000'];
  for (const url of serviceUrls) {
    try {
      const res = await fetch(`${url}/api/memory/projects/${projectId}`);
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

/**
 * Meeting CRUD client helpers targeting Python memory service
 */
async function createMeeting(data) {
  const serviceUrls = [PYTHON_SERVICE_URL, 'http://127.0.0.1:8001', 'http://127.0.0.1:8000'];
  for (const url of serviceUrls) {
    try {
      const res = await fetch(`${url}/api/memory/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

async function listMeetings(projectId, includeArchived = true) {
  const serviceUrls = [PYTHON_SERVICE_URL, 'http://127.0.0.1:8001', 'http://127.0.0.1:8000'];
  for (const url of serviceUrls) {
    try {
      const q = new URLSearchParams();
      if (projectId) q.append('project_id', projectId);
      q.append('include_archived', includeArchived);
      const res = await fetch(`${url}/api/memory/meetings?${q.toString()}`);
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

async function getMeeting(sessionId) {
  const serviceUrls = [PYTHON_SERVICE_URL, 'http://127.0.0.1:8001', 'http://127.0.0.1:8000'];
  for (const url of serviceUrls) {
    try {
      const res = await fetch(`${url}/api/memory/meetings/${sessionId}`);
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

async function updateMeeting(sessionId, updateData) {
  const serviceUrls = [PYTHON_SERVICE_URL, 'http://127.0.0.1:8001', 'http://127.0.0.1:8000'];
  for (const url of serviceUrls) {
    try {
      const res = await fetch(`${url}/api/memory/meetings/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
      });
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

async function deleteMeeting(sessionId) {
  const serviceUrls = [PYTHON_SERVICE_URL, 'http://127.0.0.1:8001', 'http://127.0.0.1:8000'];
  for (const url of serviceUrls) {
    try {
      const res = await fetch(`${url}/api/memory/meetings/${sessionId}`, {
        method: 'DELETE'
      });
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

export {
  ingestSegment,
  queryMemory,
  processMeeting,
  getProjectMemory,
  createMeeting,
  listMeetings,
  getMeeting,
  updateMeeting,
  deleteMeeting
};
