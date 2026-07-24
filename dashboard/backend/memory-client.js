import { Groq } from 'groq-sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from './supabase-client.js';
import { downloadStorageFile } from './supabase-helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PYTHON_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://127.0.0.1:8001';

/**
 * Fallback to direct LLM query when Python memory service is offline
 */
async function fallbackGroqQuery({ question, projectId, project_id }) {
  const targetProjectId = projectId || project_id;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      answer: "The AI memory service is offline and GROQ_API_KEY is missing from .env. Please start the memory service or configure GROQ_API_KEY.",
      citations: [],
      usedFallback: true,
      answeredVia: "project_transcript_fallback"
    };
  }

  try {
    const greetings = ["hi", "hello", "hey", "greetings", "good morning", "good afternoon", "good evening", "who are you", "help"];
    if (greetings.includes(question.toLowerCase().trim().replace(/[.!?]/g, ''))) {
      return {
        answer: "Hello! I am your AI Meeting Assistant. Ask me anything about your project's meeting transcripts, key decisions, or action items!",
        citations: [],
        usedFallback: true,
        answeredVia: "greeting_handler"
      };
    }

    const groq = new Groq({ apiKey });

    // 1. Fetch meeting_sessions matching targetProjectId from Supabase
    let contextText = '';
    let citations = [];

    if (targetProjectId) {
      try {
        const { data: dbSessions } = await supabase
          .from('meeting_sessions')
          .select('session_id, bot_type, created_at, transcript_file_url')
          .eq('project_id', targetProjectId)
          .order('created_at', { ascending: false });

        if (dbSessions && dbSessions.length > 0) {
          const sessionIds = dbSessions.map(s => s.session_id);

          // 2. Fetch DB transcript_segments for these project sessions
          const { data: segments } = await supabase
            .from('transcript_segments')
            .select('session_id, speaker_label, text, created_at')
            .in('session_id', sessionIds)
            .order('created_at', { ascending: false })
            .limit(100);

          if (segments && segments.length > 0) {
            contextText += segments.map(s => `[${s.created_at || 'Meeting'} | ${s.speaker_label}]: ${s.text}`).join('\n');
            dbSessions.slice(0, 3).forEach(s => {
              citations.push({ sessionId: s.session_id, meetingDate: s.created_at, platform: s.bot_type });
            });
          }

          // 3. Always include storage/local transcript contents for sessions (e.g. mruemenkkdg1)
          const transcriptsDir = path.join(__dirname, 'transcripts');
          for (const s of dbSessions.slice(0, 5)) {
            let content = null;
            if (s.transcript_file_url) {
              try {
                content = await downloadStorageFile(s.transcript_file_url);
              } catch (e) {}
            }
            if (!content) {
              const f = `${s.bot_type}_${s.session_id}.jsonl`;
              const fp = path.join(transcriptsDir, f);
              if (fs.existsSync(fp)) {
                try { content = fs.readFileSync(fp, 'utf8'); } catch (e) {}
              }
            }
            if (content) {
              const lines = content.split('\n').filter(Boolean).slice(-40).map(l => {
                try {
                  const obj = JSON.parse(l);
                  return `${obj.speaker || 'Speaker'}: ${obj.text}`;
                } catch { return ''; }
              }).filter(Boolean).join('\n');
              if (lines && !contextText.includes(lines.slice(0, 25))) {
                contextText += `\n--- Session (${s.session_id} | ${s.bot_type}) ---\n${lines}\n`;
                citations.push({ sessionId: s.session_id, meetingDate: s.created_at, platform: s.bot_type });
              }
            }
          }
        }
      } catch (dbErr) {
        console.warn('[MemoryClient] Supabase query in fallback failed:', dbErr.message);
      }
    }

    if (!contextText) {
      return {
        answer: `No meeting transcripts recorded yet for project "${targetProjectId || 'General'}".`,
        citations: [],
        usedFallback: true,
        answeredVia: "project_transcript_fallback"
      };
    }

    const prompt = `You are a helpful AI Meeting Knowledge Assistant for workspace/project "${targetProjectId || 'General'}".
Answer the user's question naturally and accurately based on the project meeting transcripts provided below.

Meeting Transcripts Context:
${contextText.slice(0, 4000)}

User Question: ${question}`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 1024,
    });

    const answer = completion.choices[0]?.message?.content || "No response generated.";
    return { answer, citations, usedFallback: true, answeredVia: "project_transcript_fallback" };
  } catch (err) {
    console.error('[MemoryClient] Groq fallback query failed:', err.message);
    return { answer: `Error processing question: ${err.message}`, citations: [], usedFallback: true, answeredVia: "project_transcript_fallback" };
  }
}

/**
 * Fire-and-forget: push a transcript segment to the memory service.
 * Called on every Deepgram final chunk during a live meeting.
 */
function ingestSegment(sessionId, { speaker, text, startTs, endTs, isFinal, projectId }) {
  const urls = [PYTHON_SERVICE_URL, 'http://127.0.0.1:8001'];
  for (const url of urls) {
    fetch(`${url}/api/memory/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        project_id: projectId || null,
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
  const finalSessionId = sessionId || session_id;
  const finalProjectId = projectId || project_id;

  const serviceUrls = [PYTHON_SERVICE_URL, 'http://127.0.0.1:8001', 'http://127.0.0.1:8000'];
  const uniqueUrls = [...new Set(serviceUrls.filter(Boolean))];

  for (const url of uniqueUrls) {
    try {
      const res = await fetch(`${url}/api/memory/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          session_id: finalSessionId,
          project_id: finalProjectId,
        }),
      });
      if (res.ok) {
        return await res.json();
      }
    } catch (err) {
      // Continue to next URL
    }
  }

  // Fallback to direct Groq query if Python memory service is offline
  console.log('[MemoryClient] Python memory service unreachable, using direct Groq LLM fallback...');
  const fallbackResult = await fallbackGroqQuery({ question, projectId: finalProjectId });
  return { ...fallbackResult, usedFallback: true };
}

/**
 * Fire-and-forget: trigger post-meeting extraction.
 * Called when a meeting ends.
 */
function processMeeting(sessionId) {
  const urls = [PYTHON_SERVICE_URL, 'http://127.0.0.1:8005', 'http://127.0.0.1:8001', 'http://127.0.0.1:8000'];
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
  const serviceUrls = [PYTHON_SERVICE_URL, 'http://127.0.0.1:8005', 'http://127.0.0.1:8001', 'http://127.0.0.1:8000'];
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
