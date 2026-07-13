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

  const systemPrompt = `You are a professional meeting assistant. Review the transcript of the meeting below and produce a structured, high-quality meeting report in markdown format.

The report MUST include exactly the following sections in this exact order:

### Executive Summary
[Provide a clear 3-sentence summary of what the meeting was about, the main discussion, and the final outcomes.]

### Meeting Chapters & Outline
* **[StartTimestamp - EndTimestamp] Topic Title**: Concise description of what was discussed during this period and details from the conversation.
* **[StartTimestamp - EndTimestamp] Topic Title**: Concise description of what was discussed during this period and details from the conversation.

### Key Decisions
* **Decision 1**: Clear explanation of the decision.
* **Decision 2**: Clear explanation of the decision.
(If no explicit decisions were made, state "No explicit decisions were finalized during this meeting.")

### Action Items Table
Include a markdown table representing tasks assigned during the meeting:
| Task Description | Assignee | Priority |
| :--- | :--- | :--- |
| [Detail of task] | [Full Name of Assignee] | [High/Medium/Low] |
(If no tasks or action items were assigned, state "No action items were assigned.")`;

  // Call the Groq API
  let aiTextResponse = '';
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
          temperature: 0.4,
          max_tokens: 4096,
        });

        aiTextResponse = completion.choices[0]?.message?.content || '';
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
    throw new Error(`Groq API Error: ${err.message}`);
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
  
  finalReport += `\n---\n\n## AI Insights\n\n${aiTextResponse}`;

  return finalReport;
}
