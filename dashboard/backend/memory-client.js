const PYTHON_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://127.0.0.1:8001';

// Helper to get service URLs (primary configured URL + default local ports)
function getServiceUrls() {
  return [...new Set([PYTHON_SERVICE_URL, 'http://127.0.0.1:8001', 'http://127.0.0.1:8000'].filter(Boolean))];
}

/**
 * Fire-and-forget: push a transcript segment to the memory service.
 * Called on every Deepgram final chunk during a live meeting.
 */
function ingestSegment(sessionId, { speaker, text, startTs, endTs, isFinal, projectId, project_id }) {
  const pid = projectId || project_id || null;
  const sid = sessionId;
  for (const url of getServiceUrls()) {
    fetch(`${url}/api/memory/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sid,
        project_id: pid,
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
async function queryMemory({ question, sessionId, session_id, projectId, project_id }) {
  const pid = projectId || project_id; // accept both camelCase and snake_case
  const sid = sessionId || session_id;

  for (const url of getServiceUrls()) {
    try {
      const res = await fetch(`${url}/api/memory/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          session_id: sid,
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

  console.warn('[MemoryClient] Python memory service is unreachable.');
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
  console.log(`[MemoryClient] Triggering processMeeting for session ${sessionId}...`);
  for (const url of getServiceUrls()) {
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
  for (const url of getServiceUrls()) {
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
  for (const url of getServiceUrls()) {
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
  for (const url of getServiceUrls()) {
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
  for (const url of getServiceUrls()) {
    try {
      const res = await fetch(`${url}/api/memory/meetings/${sessionId}`);
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

async function updateMeeting(sessionId, updateData) {
  for (const url of getServiceUrls()) {
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
  for (const url of getServiceUrls()) {
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
