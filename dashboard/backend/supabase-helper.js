import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from './supabase-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TRANSCRIPTS_DIR = path.resolve(__dirname, 'transcripts');

/**
 * Inserts a new active session into the database.
 * 
 * @param {string} sessionId 
 * @param {string} botType 
 * @param {string} meetingUrl 
 * @param {string} botName 
 */
export async function saveSessionStart(sessionId, botType, meetingUrl, botName, projectId) {
  try {
    const { error } = await supabase
      .from('meeting_sessions')
      .insert({
        session_id: sessionId,
        bot_type: botType,
        meeting_url: meetingUrl,
        bot_name: botName || 'Meeting Bot',
        status: 'capturing',
        project_id: projectId
      });

    if (error) throw error;
    console.log(`[Supabase] Logged session start: ${sessionId}`);
  } catch (err) {
    console.error(`[Supabase] Failed to log session start for ${sessionId}:`, err.message);
  }
}

/**
 * Uploads a local file to Supabase Storage and returns the public URL.
 * 
 * @param {string} localPath 
 * @param {string} storageName 
 * @returns {Promise<string|null>} The public URL or null.
 */
async function uploadToStorage(localPath, storageName) {
  try {
    const fileBuffer = await fs.readFile(localPath);
    
    // Determine mime-type based on extension
    const ext = path.extname(localPath);
    let contentType = 'text/plain';
    if (ext === '.jsonl') {
      contentType = 'application/json';
    } else if (ext === '.md') {
      contentType = 'text/markdown';
    } else if (ext === '.docx') {
      contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }

    // Upload to bucket (using upsert: true to overwrite if it already exists)
    const { data, error } = await supabase.storage
      .from('transcripts')
      .upload(storageName, fileBuffer, {
        contentType,
        upsert: true
      });

    if (error) throw error;

    // Get public URL (synchronous call returning { data })
    const { data: publicUrlData } = supabase.storage
      .from('transcripts')
      .getPublicUrl(storageName);

    return publicUrlData.publicUrl;
  } catch (err) {
    console.error(`[Supabase] Storage upload failed for ${storageName}:`, err.message);
    return null;
  }
}

/**
 * Downloads file text content from Supabase Storage safely (works for public and private buckets).
 * Accepts either a full URL or a relative storage path (e.g. sessions/:id/transcript.jsonl).
 *
 * @param {string} urlOrPath 
 * @returns {Promise<string>} File content text
 */
export async function downloadStorageFile(urlOrPath) {
  if (!urlOrPath) throw new Error('No URL or path provided to downloadStorageFile');

  // Try to parse relative storage path from full Supabase URL if provided
  let storagePath = urlOrPath;
  const match = urlOrPath.match(/\/storage\/v1\/object\/(?:public|authenticated)\/transcripts\/(.+)$/);
  if (match) {
    storagePath = decodeURIComponent(match[1]);
  }

  // 1. Try downloading directly via authenticated Supabase Storage SDK (works for private & public buckets)
  try {
    const { data, error } = await supabase.storage
      .from('transcripts')
      .download(storagePath);
    if (!error && data) {
      return await data.text();
    }
  } catch (sdkErr) {
    console.warn(`[Supabase] SDK download failed for ${storagePath}, attempting direct HTTP fetch...`, sdkErr.message);
  }

  // 2. Fallback to raw HTTP fetch if URL is a valid web link
  if (urlOrPath.startsWith('http')) {
    const fetchRes = await fetch(urlOrPath);
    if (fetchRes.ok) {
      return await fetchRes.text();
    }
    throw new Error(`HTTP fetch failed with status ${fetchRes.status}`);
  }

  throw new Error(`Could not download storage file: ${urlOrPath}`);
}

/**
 * Uploads the transcript file and marks the session as completed in database.
 * 
 * @param {string} sessionId 
 * @param {string} botType 
 */
export async function saveSessionEnd(sessionId, botType) {
  try {
    const transcriptFilename = `${botType}_${sessionId}.jsonl`;
    const localTranscriptPath = path.join(TRANSCRIPTS_DIR, transcriptFilename);
    
    let publicUrl = null;
    try {
      const stats = await fs.stat(localTranscriptPath);
      if (stats.isFile() && stats.size > 0) {
        const storagePath = `sessions/${sessionId}/transcript.jsonl`;
        console.log(`[Supabase] Uploading transcript file to cloud: ${storagePath}`);
        publicUrl = await uploadToStorage(localTranscriptPath, storagePath);
      } else {
        console.warn(`[Supabase] Transcript file is empty (0 bytes) for session ${sessionId}. Skipping storage upload.`);
      }
    } catch (e) {
      console.warn(`[Supabase] Local transcript file not found for upload: ${transcriptFilename}`);
    }

    const updateData = { 
      status: 'completed',
      transcript_file_url: publicUrl || null
    };

    const { error } = await supabase
      .from('meeting_sessions')
      .update(updateData)
      .eq('session_id', sessionId);

    if (error) throw error;
    console.log(`[Supabase] Logged session end for: ${sessionId} (status: ${updateData.status})`);
  } catch (err) {
    console.error(`[Supabase] Failed to log session end for ${sessionId}:`, err.message);
  }
}

/**
 * Uploads the generated report file and updates database URL reference.
 * 
 * @param {string} sessionId 
 * @param {string} botType 
 * @returns {Promise<string|null>} The public URL or null.
 */
export async function uploadReport(sessionId, botType) {
  try {
    const reportFilename = `${botType}_${sessionId}_report.md`;
    const localReportPath = path.join(TRANSCRIPTS_DIR, reportFilename);
    
    let publicUrl = null;
    try {
      const stats = await fs.stat(localReportPath);
      if (stats.isFile() && stats.size > 0) {
        const storagePath = `sessions/${sessionId}/report.md`;
        console.log(`[Supabase] Uploading report file to cloud: ${storagePath}`);
        publicUrl = await uploadToStorage(localReportPath, storagePath);
      } else {
        console.warn(`[Supabase] Report file is empty (0 bytes) for session ${sessionId}. Skipping upload.`);
        return null;
      }
    } catch (e) {
      console.warn(`[Supabase] Local report file not found for upload: ${reportFilename}`);
      return null;
    }

    if (publicUrl) {
      // Upload scheduling data companion JSON if it exists
      const schedulingFilename = `${botType}_${sessionId}_report_scheduling.json`;
      const localSchedulingPath = path.join(TRANSCRIPTS_DIR, schedulingFilename);
      try {
        const statsSched = await fs.stat(localSchedulingPath);
        if (statsSched.isFile() && statsSched.size > 0) {
          const schedStoragePath = `sessions/${sessionId}/scheduling.json`;
          console.log(`[Supabase] Uploading scheduling companion to cloud: ${schedStoragePath}`);
          await uploadToStorage(localSchedulingPath, schedStoragePath);
        }
      } catch (e) {
        console.log(`[Supabase] Local scheduling file not found or empty: ${schedulingFilename}`);
      }

      const { error } = await supabase
        .from('meeting_sessions')
        .update({ report_file_url: publicUrl })
        .eq('session_id', sessionId);

      if (error) throw error;
      console.log(`[Supabase] Report URL updated in DB for session: ${sessionId}`);
    }
    return publicUrl;
  } catch (err) {
    console.error(`[Supabase] Failed to upload report for ${sessionId}:`, err.message);
    return null;
  }
}
