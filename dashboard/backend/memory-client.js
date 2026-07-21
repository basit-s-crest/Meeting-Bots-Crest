import { Groq } from 'groq-sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PYTHON_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://127.0.0.1:8001';

/**
 * Fallback to direct LLM query when Python memory service is offline
 */
async function fallbackGroqQuery({ question, projectId }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      answer: "The AI memory service is offline and GROQ_API_KEY is missing from .env. Please start the memory service or configure GROQ_API_KEY.",
      citations: [],
      usedFallback: true
    };
  }

  try {
    const groq = new Groq({ apiKey });

    // Read recent transcripts for context
    const transcriptsDir = path.join(__dirname, 'transcripts');
    let contextText = '';
    if (fs.existsSync(transcriptsDir)) {
      const files = fs.readdirSync(transcriptsDir).filter(f => f.endsWith('.jsonl'));
      for (const f of files.slice(-5)) {
        try {
          const content = fs.readFileSync(path.join(transcriptsDir, f), 'utf8');
          const lines = content.split('\n').filter(Boolean).slice(-60).map(l => {
            try {
              const obj = JSON.parse(l);
              return `${obj.speaker || 'Speaker'}: ${obj.text}`;
            } catch {
              return '';
            }
          }).filter(Boolean).join('\n');
          if (lines) {
            contextText += `\n--- Meeting Transcript (${f}) ---\n${lines}\n`;
          }
        } catch {}
      }
    }

    const prompt = `You are a helpful AI Meeting Knowledge Assistant for workspace/project "${projectId || 'General'}".
Answer the user's question naturally and accurately based on the project meeting transcripts provided below. If context is empty or missing details, answer politely and offer guidance.

Meeting Transcripts Context:
${contextText.slice(0, 4000) || 'No transcripts recorded in workspace yet.'}

User Question: ${question}`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 1024,
    });

    const answer = completion.choices[0]?.message?.content || "No response generated.";
    return { answer, citations: [], usedFallback: true };
  } catch (err) {
    console.error('[MemoryClient] Groq fallback query failed:', err.message);
    return { answer: `Error processing question: ${err.message}`, citations: [], usedFallback: true };
  }
}

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

  // Fallback to direct Groq query if Python memory service is offline
  console.log('[MemoryClient] Python memory service unreachable, using direct Groq LLM fallback...');
  const fallbackResult = await fallbackGroqQuery({ question, projectId: pid });
  return { ...fallbackResult, usedFallback: true };
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

export { ingestSegment, queryMemory, processMeeting, getProjectMemory };
