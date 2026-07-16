import fs from 'fs/promises';
import path from 'path';
import Groq from 'groq-sdk';

/**
 * Calculates word counts and talk-time percentages from transcript lines.
 * Uses a timestamp-gap method with a word-count-based backup.
 * 
 * @param {Array} lines - Array of parsed transcript JSON objects.
 * @returns {Object} Calculated analytics metadata.
 */
export function calculateSpeakerStats(lines) {
  const speakerWords = {};
  const speakerDurations = {};
  let totalWords = 0;
  let totalDuration = 0;

  // 1. Gather all words per speaker and aggregate overall total
  for (const line of lines) {
    const speaker = line.speaker || 'Unknown';
    const text = line.text || '';
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    
    speakerWords[speaker] = (speakerWords[speaker] || 0) + words;
    totalWords += words;
  }

  // 2. Estimate duration using timestamp gaps
  // Sort lines by timestamp to ensure chronological order
  const sortedLines = [...lines].sort((a, b) => {
    return new Date(a.timestamp) - new Date(b.timestamp);
  });

  for (let i = 0; i < sortedLines.length; i++) {
    const line = sortedLines[i];
    const speaker = line.speaker || 'Unknown';
    const text = line.text || '';
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;

    let duration = 0;
    if (i < sortedLines.length - 1) {
      const currentMs = new Date(line.timestamp).getTime();
      const nextMs = new Date(sortedLines[i + 1].timestamp).getTime();
      const gap = nextMs - currentMs;

      // If gap is negative or extremely long (> 15s), assume silence/pause
      // and estimate turn duration based on word count (300ms per word, min 2s)
      if (gap <= 0 || gap > 15000) {
        duration = Math.max(2000, words * 300);
      } else {
        duration = gap;
      }
    } else {
      // Last turn duration estimate capped at 10s
      duration = Math.min(10000, Math.max(2000, words * 300));
    }

    speakerDurations[speaker] = (speakerDurations[speaker] || 0) + duration;
    totalDuration += duration;
  }

  // 3. Compute final analytics list
  // Determine if timestamps are unreliable (total duration is 0 or invalid)
  const useWordCountFallback = totalDuration <= 0;

  const analytics = Object.entries(speakerWords).map(([name, wordCount]) => {
    let percentage = 0;
    if (useWordCountFallback) {
      percentage = totalWords > 0 ? ((wordCount / totalWords) * 100).toFixed(1) : '0.0';
    } else {
      const speakerDur = speakerDurations[name] || 0;
      percentage = totalDuration > 0 ? ((speakerDur / totalDuration) * 100).toFixed(1) : '0.0';
    }

    return {
      name,
      wordCount,
      percentage: parseFloat(percentage)
    };
  }).sort((a, b) => b.wordCount - a.wordCount);

  return {
    analytics,
    totalWords,
    totalDurationMs: useWordCountFallback ? 0 : totalDuration
  };
}

/**
 * Generates the full Fireflies-style markdown report using Groq (Llama 3.3 70B).
 * 
 * @param {string} transcriptPath - File path to the source .jsonl file.
 * @returns {Promise<string>} The generated markdown content.
 */
export async function generateFirefliesReport(transcriptPath) {
  // Ensure GROQ_API_KEY is configured
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY not set in .env');
  }

  // Read and parse transcript file
  const fileContent = await fs.readFile(transcriptPath, 'utf8');
  const lines = fileContent.split('\n')
    .filter(line => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Failed to parse transcript line ${index + 1}: ${err.message}`);
      }
    });

  if (lines.length === 0) {
    throw new Error('Transcript file is empty. Cannot generate report.');
  }

  // Format the dialog for the LLM
  const formattedTranscript = lines.map(line => {
    const timeStr = new Date(line.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `[${timeStr}] ${line.speaker}: ${line.text}`;
  }).join('\n');

  // Extract reference date and time in the configured CALENDAR_TIMEZONE
  const tz = process.env.CALENDAR_TIMEZONE || 'Asia/Kolkata';
  let referenceDateStr = 'unknown';
  let referenceTimeStr = 'unknown';
  
  if (lines.length > 0 && lines[0].timestamp) {
    try {
      const firstTs = new Date(lines[0].timestamp);
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
      const parts = formatter.formatToParts(firstTs);
      const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
      referenceDateStr = `${p.year}-${p.month}-${p.day}`;
      referenceTimeStr = `${p.hour}:${p.minute}`;
    } catch (e) {
      console.warn('[Report Generator] Failed to parse reference date/time from transcript:', e.message);
    }
  }

  const systemPrompt = `You are a professional meeting assistant. Review the transcript of the meeting below and produce a structured, high-quality meeting report and detect any scheduling intent.

You MUST respond with a JSON object containing exactly the following keys:
{
  "summary": "The full Markdown report",
  "scheduling_detected": true or false,
  "scheduling": {
    "date": "YYYY-MM-DD",
    "time": "HH:MM",
    "timezone": "The reference meeting's timezone",
    "title": "Clean, best-guess title for the meeting",
    "raw_mention": "The exact sentence/phrase from the transcript that triggered this detection"
  }
}

Guidelines for "summary":
The report MUST include exactly the following sections in this exact order:
### Executive Summary
[Provide a clear 3-sentence summary of what the meeting was about, the main discussion, and the final outcomes.]

### Meeting Chapters & Outline
* **[StartTimestamp - EndTimestamp] Topic Title**: Concise description of what was discussed during this period and details from the conversation.

### Key Decisions
* **Decision 1**: Clear explanation of the decision.
(If no explicit decisions were made, state "No explicit decisions were finalized during this meeting.")

### Action Items Table
Include a markdown table representing tasks assigned during the meeting:
| Task Description | Assignee | Priority |
| :--- | :--- | :--- |
| [Detail of task] | [Full Name of Assignee] | [High/Medium/Low] |

Guidelines for "scheduling_detected" and "scheduling":
- Set "scheduling_detected" to true ONLY if there is an explicit request/mention in the transcript to schedule a future meeting or event.
- If "scheduling_detected" is true, populate the "scheduling" object. If false, set "scheduling" to null.
- "date": Resolve any relative dates (like "tomorrow", "next Tuesday", "July 20") to an absolute ISO date format (YYYY-MM-DD), using the Reference Date of the meeting as the base.
- "time": Resolve any times mentioned (like "at 5pm", "at 3") to HH:MM (24-hour format) in the meeting's local time. If no specific time is mentioned, set "time" to null.
- "timezone": Set this to the reference meeting's timezone.
- "title": Generate a clean, descriptive meeting title based on the context of the conversation. Do not include date/time in the title.
- "raw_mention": Extract the actual sentence/phrase from the transcript that triggered the scheduling detection.

Reference Date of the meeting (the date the meeting actually occurred in local time): ${referenceDateStr}
Reference Time of the meeting: ${referenceTimeStr}
Meeting Timezone: ${tz}`;

  // Call the Groq API
  let resultJson = {
    summary: '',
    scheduling_detected: false,
    scheduling: null
  };

  try {
    const groq = new Groq({ apiKey });
    
    // Retry logic — Groq intermittently returns 'organization_restricted' under load
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const completion = await groq.chat.completions.create({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Here is the meeting transcript to summarize:\n${formattedTranscript}` }
          ],
          model: 'llama-3.3-70b-versatile',
          response_format: { type: "json_object" },
          temperature: 0.4,
          max_tokens: 4096,
        });

        const rawContent = completion.choices[0]?.message?.content || '{}';
        resultJson = JSON.parse(rawContent);
        break; // Success — exit retry loop
      } catch (retryErr) {
        console.warn(`[ReportGenerator] Groq attempt ${attempt}/${maxRetries} failed: ${retryErr.message}`);
        if (attempt === maxRetries) {
          throw retryErr;
        }
        // Exponential backoff: 2s, 4s
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  } catch (err) {
    console.error(`[ReportGenerator] Failed to call Groq or parse response: ${err.message}`);
    // Default scheduling_detected to false on error/timeout as per requirement
    resultJson = {
      summary: `Failed to generate AI insights due to an error: ${err.message}`,
      scheduling_detected: false,
      scheduling: null
    };
  }

  // Compile final markdown report with Speaker Analytics header
  const stats = calculateSpeakerStats(lines);
  
  let finalReport = `# Meeting Report & Analysis\n\n`;
  finalReport += `## Speaker Analytics\n`;
  stats.analytics.forEach(speaker => {
    const timeInfo = stats.totalDurationMs > 0 
      ? ` (${speaker.percentage}% talk-time)` 
      : ` (${speaker.percentage}% of words spoken)`;
    finalReport += `* **${speaker.name}**: Spoke ${speaker.wordCount} words${timeInfo}\n`;
  });
  
  finalReport += `\n---\n\n## AI Insights\n\n${resultJson.summary || ''}`;

  return {
    markdown: finalReport,
    scheduling: {
      scheduling_detected: resultJson.scheduling_detected || false,
      scheduling: resultJson.scheduling || null
    }
  };
}
