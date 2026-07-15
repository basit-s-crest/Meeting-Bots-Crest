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
export async function saveSessionStart(sessionId, botType, meetingUrl, botName) {
  try {
    const { error } = await supabase
      .from('meeting_sessions')
      .insert({
        session_id: sessionId,
        bot_type: botType,
        meeting_url: meetingUrl,
        bot_name: botName || 'Meeting Bot',
        status: 'capturing'
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
      if (stats.isFile()) {
        console.log(`[Supabase] Uploading transcript file to cloud: ${transcriptFilename}`);
        publicUrl = await uploadToStorage(localTranscriptPath, transcriptFilename);
      }
    } catch (e) {
      console.warn(`[Supabase] Local transcript file not found for upload: ${transcriptFilename}`);
    }

    const updateData = { status: 'completed' };
    if (publicUrl) {
      updateData.transcript_file_url = publicUrl;
    }

    const { error } = await supabase
      .from('meeting_sessions')
      .update(updateData)
      .eq('session_id', sessionId);

    if (error) throw error;
    console.log(`[Supabase] Logged session end and uploaded transcripts for: ${sessionId}`);
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
      if (stats.isFile()) {
        console.log(`[Supabase] Uploading report file to cloud: ${reportFilename}`);
        publicUrl = await uploadToStorage(localReportPath, reportFilename);
      }
    } catch (e) {
      console.warn(`[Supabase] Local report file not found for upload: ${reportFilename}`);
      return null;
    }

    // Upload the docx report as well if it exists
    const docxFilename = `${botType}_${sessionId}_report.docx`;
    const localDocxPath = path.join(TRANSCRIPTS_DIR, docxFilename);
    try {
      const statsDocx = await fs.stat(localDocxPath);
      if (statsDocx.isFile()) {
        console.log(`[Supabase] Uploading docx report file to cloud: ${docxFilename}`);
        await uploadToStorage(localDocxPath, docxFilename);
      }
    } catch (e) {
      console.log(`[Supabase] Local docx report file not found or not created: ${docxFilename}`);
    }

    if (publicUrl) {
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
