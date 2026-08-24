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
 * @param {string} projectId
 * @param {Array<string>} [attendeeEmails]
 */
export async function saveSessionStart(sessionId, botType, meetingUrl, botName, projectId, attendeeEmails = []) {
  try {
    const insertData = {
      session_id: sessionId,
      bot_type: botType,
      meeting_url: meetingUrl,
      bot_name: botName || 'Meeting Bot',
      status: 'capturing',
      project_id: projectId
    };

    if (Array.isArray(attendeeEmails) && attendeeEmails.length > 0) {
      insertData.attendee_emails = attendeeEmails;
    }

    const { error } = await supabase
      .from('meeting_sessions')
      .insert(insertData);

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
export async function saveSessionEnd(sessionId, botType, exitReason = 'unknown') {
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
      transcript_file_url: publicUrl || null,
      exit_reason: exitReason || 'unknown'
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

/**
 * Fetches attendee emails stored for a given session.
 * 
 * @param {string} sessionId 
 * @returns {Promise<Array<string>>}
 */
export async function getAttendeeEmailsForSession(sessionId) {
  try {
    const { data, error } = await supabase
      .from('meeting_sessions')
      .select('attendee_emails')
      .eq('session_id', sessionId)
      .single();

    if (error || !data) return [];
    return data.attendee_emails || [];
  } catch (err) {
    console.error(`[Supabase] Failed to fetch attendee emails for ${sessionId}:`, err.message);
    return [];
  }
}

/**
 * Saves audio profile JSON for a meeting session.
 */
export async function saveAudioProfile(sessionId, audioProfile) {
  try {
    const { error } = await supabase
      .from('meeting_sessions')
      .update({ audio_profile: audioProfile })
      .eq('session_id', sessionId);

    if (error) throw error;
    console.log(`[Supabase] Saved audio profile for session: ${sessionId}`);
    return true;
  } catch (err) {
    console.error(`[Supabase] Failed to save audio profile for ${sessionId}:`, err.message);
    return false;
  }
}

/**
 * Seeds a user's display name fingerprint and initial voice profile from a confirmed meeting.
 */
export async function seedUserFingerprint(userId, displayName, sessionId, voiceProfile = null) {
  try {
    if (!displayName || !userId) {
      throw new Error('userId and displayName are required');
    }

    const normalized = displayName.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

    // 1. Upsert into user_speaker_fingerprints
    const { data: fpData, error: fpError } = await supabase
      .from('user_speaker_fingerprints')
      .upsert({
        user_id: userId,
        display_name: displayName,
        display_name_normalized: normalized,
        source_session_id: sessionId,
        last_seen_at: new Date().toISOString()
      }, { onConflict: 'user_id,display_name_normalized' })
      .select();

    if (fpError) throw fpError;

    // 2. Upsert voice profile (using provided profile or fetch from session audio_profile or initialize baseline)
    let avgRms = voiceProfile?.avg_rms ?? 0.045;
    let rmsStddev = voiceProfile?.rms_stddev ?? 0.015;
    let sampleCount = voiceProfile?.samples ?? 100;

    if (sessionId && !voiceProfile) {
      try {
        const { data: sessionData } = await supabase
          .from('meeting_sessions')
          .select('audio_profile')
          .eq('session_id', sessionId)
          .maybeSingle();

        if (sessionData?.audio_profile?.channels) {
          const match = sessionData.audio_profile.channels.find(
            (c) => c.name && c.name.toLowerCase().includes(normalized)
          );
          if (match) {
            avgRms = match.rms_mean || avgRms;
            rmsStddev = match.rms_stddev || rmsStddev;
            sampleCount = match.samples || sampleCount;
          }
        }
      } catch (err) {
        console.warn(`[Supabase] Could not fetch session audio profile for ${sessionId}:`, err.message);
      }
    }

    // Generate normalized 192-dimensional acoustic embedding vector for pgvector
    const generateAcousticVector = (rms, stddev) => {
      const vec = new Array(192);
      const b1 = Math.min(Math.max(rms, 0.001), 1.0);
      const b2 = Math.min(Math.max(stddev, 0.001), 1.0);
      for (let i = 0; i < 192; i++) {
        const angle = (i * Math.PI) / 96;
        vec[i] = b1 * Math.cos(angle) + b2 * Math.sin(angle) * ((i % 5) + 1) * 0.1;
      }
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
      return vec.map((v) => parseFloat((v / norm).toFixed(6)));
    };

    let embeddingVector = voiceProfile?.voice_embedding;
    if (!embeddingVector) {
      try {
        const memPort = process.env.MEMORY_SERVICE_PORT || 8001;
        const memRes = await fetch(`http://127.0.0.1:${memPort}/api/memory/voice/encode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rms: avgRms, stddev: rmsStddev })
        });
        if (memRes.ok) {
          const memData = await memRes.json();
          if (memData.embedding && memData.embedding.length === 192) {
            embeddingVector = memData.embedding;
          }
        }
      } catch (err) {
        console.warn(`[Supabase] Could not encode neural voice vector via memory-service:`, err.message);
      }
    }

    if (!embeddingVector) {
      embeddingVector = generateAcousticVector(avgRms, rmsStddev);
    }

    await supabase
      .from('user_voice_profiles')
      .upsert({
        user_id: userId,
        avg_rms: avgRms,
        rms_stddev: rmsStddev,
        voice_embedding: embeddingVector,
        sample_count: sampleCount,
        last_updated: new Date().toISOString()
      }, { onConflict: 'user_id' });

    // 3. Re-assign any existing unconfirmed action items in this session with matching name
    if (sessionId) {
      await supabase
        .from('meeting_events')
        .update({
          assignee_user_id: userId,
          assignee_confirmed: true,
          assignee_confidence: 1.0
        })
        .eq('session_id', sessionId)
        .ilike('assignee', `%${displayName}%`);
    }

    console.log(`[Supabase] Successfully seeded fingerprint for user ${userId} -> "${displayName}"`);
    return { success: true, fingerprint: fpData };
  } catch (err) {
    console.error(`[Supabase] Failed to seed fingerprint for user ${userId}:`, err.message);
    throw err;
  }
}

/**
 * Gets all speaker fingerprints for a user.
 */
export async function getUserFingerprints(userId) {
  try {
    const { data, error } = await supabase
      .from('user_speaker_fingerprints')
      .select('*')
      .eq('user_id', userId);

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error(`[Supabase] Failed to get fingerprints for user ${userId}:`, err.message);
    return [];
  }
}

/**
 * Gets all action items assigned to a user (across all projects or for a specific project).
 */
export async function getUserAssignedTasks(userId, projectId = null) {
  try {
    let query = supabase
      .from('meeting_events')
      .select(`
        id,
        session_id,
        project_id,
        category,
        description,
        detail,
        assignee,
        assignee_user_id,
        assignee_confidence,
        assignee_confirmed,
        deadline,
        priority,
        meeting_date,
        completed,
        created_at,
        projects:project_id (
          id,
          name
        )
      `)
      .eq('assignee_user_id', userId)
      .eq('category', 'ACTION_ITEM')
      .order('created_at', { ascending: false });

    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error(`[Supabase] Failed to get assigned tasks for user ${userId}:`, err.message);
    return [];
  }
}

/**
 * Updates an event's assignment, confirmation, or completion status.
 */
export async function updateEventAssignee(eventId, { assigneeUserId, confirmed, completed }) {
  try {
    const updates = {};
    if (assigneeUserId !== undefined) updates.assignee_user_id = assigneeUserId;
    if (confirmed !== undefined) updates.assignee_confirmed = confirmed;
    if (completed !== undefined) {
      updates.completed = completed;
      updates.completed_at = completed ? new Date().toISOString() : null;
    }

    const { data, error } = await supabase
      .from('meeting_events')
      .update(updates)
      .eq('id', eventId)
      .select();

    if (error) throw error;
    return data && data[0];
  } catch (err) {
    console.error(`[Supabase] Failed to update event assignee for ${eventId}:`, err.message);
    throw err;
  }
}

/**
 * Helper to normalize vector embeddings from Supabase pgvector (handles arrays and string formats like "[0.1, 0.2, ...]")
 */
function parseEmbeddingVector(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      const cleaned = raw.replace(/[\[\]\{\}]/g, '').trim();
      if (!cleaned) return null;
      const arr = cleaned.split(',').map((x) => parseFloat(x.trim())).filter((x) => !isNaN(x));
      if (arr.length > 0) return arr;
    }
  }
  return null;
}

/**
 * Gets a user's voice profile.
 */
export async function getUserVoiceProfile(userId) {
  try {
    const { data: profile, error } = await supabase
      .from('user_voice_profiles')
      .select('user_id, avg_rms, rms_stddev, sample_count, last_updated, voice_embedding')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;

    const parsedVector = profile ? parseEmbeddingVector(profile.voice_embedding) : null;
    const isEnrolled = !!(parsedVector && parsedVector.length === 192);
    const fingerprints = await getUserFingerprints(userId);

    return {
      enrolled: isEnrolled,
      profile: profile ? {
        avgRms: profile.avg_rms,
        rmsStddev: profile.rms_stddev,
        sampleCount: profile.sample_count,
        lastUpdated: profile.last_updated,
        embeddingDimensions: parsedVector ? parsedVector.length : 0,
      } : null,
      fingerprints: fingerprints || []
    };
  } catch (err) {
    console.error(`[Supabase] Failed to get voice profile for user ${userId}:`, err.message);
    throw err;
  }
}

/**
 * Enrolls a user's voice profile from direct audio samples or metrics.
 */
export async function enrollUserVoiceProfile(userId, { samples = [], sampleRate = 16000, rms = null, stddev = null, displayName = null }) {
  try {
    const memPort = process.env.MEMORY_SERVICE_PORT || 8001;
    let embedding = null;

    // 1. Call memory service to compute 192-d SpeechBrain ECAPA-TDNN embedding
    try {
      const memRes = await fetch(`http://127.0.0.1:${memPort}/api/memory/voice/encode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          samples: samples && samples.length > 0 ? samples : null,
          sample_rate: sampleRate,
          rms: rms,
          stddev: stddev
        })
      });

      if (memRes.ok) {
        const memData = await memRes.json();
        if (memData.embedding && memData.embedding.length === 192) {
          embedding = memData.embedding;
        }
      }
    } catch (err) {
      console.warn(`[Supabase] Memory service voice encode error:`, err.message);
    }

    // Fallback if memory service not reachable
    if (!embedding) {
      const calcRms = rms ?? (samples.length > 0 ? Math.sqrt(samples.reduce((acc, s) => acc + s * s, 0) / samples.length) : 0.045);
      const calcStd = stddev ?? 0.015;
      const vec = new Array(192);
      const b1 = Math.min(Math.max(calcRms, 0.001), 1.0);
      const b2 = Math.min(Math.max(calcStd, 0.001), 1.0);
      for (let i = 0; i < 192; i++) {
        const angle = (i * Math.PI) / 96;
        vec[i] = b1 * Math.cos(angle) + b2 * Math.sin(angle) * ((i % 5) + 1) * 0.1;
      }
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
      embedding = vec.map((v) => parseFloat((v / norm).toFixed(6)));
    }

    const calculatedRms = rms ?? (samples.length > 0 ? Math.sqrt(samples.reduce((acc, s) => acc + s * s, 0) / samples.length) : 0.045);
    const calculatedStddev = stddev ?? 0.015;

    // 2. Upsert user_voice_profiles
    const { data: vpData, error: vpError } = await supabase
      .from('user_voice_profiles')
      .upsert({
        user_id: userId,
        avg_rms: calculatedRms,
        rms_stddev: calculatedStddev,
        voice_embedding: embedding,
        sample_count: samples.length || 16000,
        last_updated: new Date().toISOString()
      }, { onConflict: 'user_id' })
      .select();

    if (vpError) throw vpError;

    // 3. If displayName provided, also ensure a fingerprint exists
    if (displayName && displayName.trim()) {
      const normalized = displayName.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
      await supabase
        .from('user_speaker_fingerprints')
        .upsert({
          user_id: userId,
          display_name: displayName.trim(),
          display_name_normalized: normalized,
          last_seen_at: new Date().toISOString()
        }, { onConflict: 'user_id,display_name_normalized' });
    }

    return {
      success: true,
      dimensions: embedding.length,
      sampleCount: samples.length,
      lastUpdated: new Date().toISOString()
    };
  } catch (err) {
    console.error(`[Supabase] Failed to enroll voice profile for user ${userId}:`, err.message);
    throw err;
  }
}

/**
 * Tests live voice audio against stored user voice profile.
 */
export async function testUserVoiceMatch(userId, { samples = [], sampleRate = 16000, rms = null, stddev = null }) {
  try {
    const { data: profile, error } = await supabase
      .from('user_voice_profiles')
      .select('voice_embedding')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    const storedVector = profile ? parseEmbeddingVector(profile.voice_embedding) : null;
    if (!storedVector || storedVector.length !== 192) {
      return {
        enrolled: false,
        matched: false,
        confidence: 0,
        message: 'No valid 192D voice profile found for this user. Please calibrate your voice first.'
      };
    }

    const memPort = process.env.MEMORY_SERVICE_PORT || 8001;
    let testEmbedding = null;

    try {
      const memRes = await fetch(`http://127.0.0.1:${memPort}/api/memory/voice/encode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          samples: samples && samples.length > 0 ? samples : null,
          sample_rate: sampleRate,
          rms: rms,
          stddev: stddev
        })
      });

      if (memRes.ok) {
        const memData = await memRes.json();
        if (memData.embedding && memData.embedding.length === 192) {
          testEmbedding = memData.embedding;
        }
      }
    } catch (err) {
      console.warn(`[Supabase] Memory service test encode error:`, err.message);
    }

    if (!testEmbedding) {
      return {
        enrolled: true,
        matched: false,
        confidence: 0,
        message: 'Could not process audio sample.'
      };
    }

    // Cosine similarity
    const vecA = storedVector;
    const vecB = testEmbedding;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < 192; i++) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    const similarity = (normA > 0 && normB > 0) ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
    const roundedSim = Math.round(similarity * 10000) / 10000;
    const isMatch = roundedSim >= 0.62;

    // Biometric confidence scaling (ECAPA-TDNN):
    // Different speakers: 0.05 - 0.40 -> < 50%
    // Same speaker, different sentence: 0.62 - 0.80 -> 80% - 95%
    // High match: > 0.80 -> 96% - 100%
    let calibratedPct = 0;
    if (roundedSim >= 0.60) {
      calibratedPct = Math.round(75 + ((roundedSim - 0.60) / 0.25) * 24);
    } else if (roundedSim >= 0.40) {
      calibratedPct = Math.round(45 + ((roundedSim - 0.40) / 0.20) * 30);
    } else {
      calibratedPct = Math.round(Math.max(0, (roundedSim / 0.40) * 45));
    }
    calibratedPct = Math.min(100, Math.max(0, calibratedPct));

    return {
      enrolled: true,
      matched: isMatch,
      confidence: Math.max(0, Math.min(1, roundedSim)),
      percentage: calibratedPct,
      cosineSimilarity: roundedSim
    };
  } catch (err) {
    console.error(`[Supabase] Failed to test voice match for user ${userId}:`, err.message);
    throw err;
  }
}

/**
 * Deletes / resets a user's voice profile.
 */
export async function deleteUserVoiceProfile(userId) {
  try {
    const { error } = await supabase
      .from('user_voice_profiles')
      .delete()
      .eq('user_id', userId);

    if (error) throw error;
    return { success: true };
  } catch (err) {
    console.error(`[Supabase] Failed to delete voice profile for user ${userId}:`, err.message);
    throw err;
  }
}

/**
 * Adds an alias / display name to user_speaker_fingerprints.
 */
export async function addUserFingerprintAlias(userId, displayName) {
  try {
    if (!displayName || !displayName.trim()) throw new Error('displayName is required');
    const cleanName = displayName.trim();
    const normalized = cleanName.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

    const { data, error } = await supabase
      .from('user_speaker_fingerprints')
      .upsert({
        user_id: userId,
        display_name: cleanName,
        display_name_normalized: normalized,
        last_seen_at: new Date().toISOString()
      }, { onConflict: 'user_id,display_name_normalized' })
      .select();

    if (error) throw error;
    return data && data[0];
  } catch (err) {
    console.error(`[Supabase] Failed to add fingerprint alias for user ${userId}:`, err.message);
    throw err;
  }
}

/**
 * Deletes a speaker fingerprint alias.
 */
export async function deleteUserFingerprint(userId, fingerprintId) {
  try {
    const { error } = await supabase
      .from('user_speaker_fingerprints')
      .delete()
      .eq('id', fingerprintId)
      .eq('user_id', userId);

    if (error) throw error;
    return { success: true };
  } catch (err) {
    console.error(`[Supabase] Failed to delete fingerprint alias ${fingerprintId}:`, err.message);
    throw err;
  }
}

