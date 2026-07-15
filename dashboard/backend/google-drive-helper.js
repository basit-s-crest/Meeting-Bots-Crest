import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Readable } from 'stream';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

const TOKEN_PATH = path.join(process.cwd(), 'google_refresh_token.json');

export function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function saveRefreshToken(token) {
  try {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ refresh_token: token }), 'utf8');
    console.log('[Google Drive Helper] Refresh token saved successfully.');
  } catch (err) {
    console.error('[Google Drive Helper] Failed to save refresh token:', err.message);
  }
}

export function loadRefreshToken() {
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      return data.refresh_token || null;
    } catch (e) {
      console.error('[Google Drive Helper] Error reading refresh token file:', e.message);
      return null;
    }
  }
  return null;
}

export async function getDriveClient() {
  const refreshToken = loadRefreshToken();
  if (!refreshToken) {
    throw new Error('Google Drive not connected (no refresh token found)');
  }
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

function convertJsonlToReadable(jsonlPath) {
  try {
    if (!fs.existsSync(jsonlPath)) return '';
    const content = fs.readFileSync(jsonlPath, 'utf8').trim();
    if (!content) return '';
    const lines = content.split('\n');
    let readableText = '';
    for (const line of lines) {
      if (!line) continue;
      try {
        const data = JSON.parse(line);
        let timeStr = '';
        if (data.timestamp) {
          const date = new Date(data.timestamp);
          timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }
        readableText += `[${timeStr}] ${data.speaker || 'Unknown'}: ${data.text}\n`;
      } catch (err) {
        // Ignore single parse errors
      }
    }
    return readableText;
  } catch (err) {
    console.error('[Google Drive Helper] Failed to convert JSONL to readable text:', err.message);
    return '';
  }
}

export async function uploadTranscriptToGoogleDrive(sessionId, botType, folderId) {
  console.log(`[Google Drive Helper] Initiating Drive upload for session ${sessionId} to folder ${folderId}`);
  try {
    const transcriptFilename = `${botType}_${sessionId}.jsonl`;
    const localTranscriptPath = path.join(process.cwd(), 'transcripts', transcriptFilename);
    
    if (!fs.existsSync(localTranscriptPath)) {
      console.warn(`[Google Drive Helper] Local transcript file not found at: ${localTranscriptPath}`);
      return;
    }

    const drive = await getDriveClient();

    // 1. Upload raw .jsonl transcript
    console.log(`[Google Drive Helper] Uploading raw JSONL transcript file...`);
    const jsonlResponse = await drive.files.create({
      requestBody: {
        name: transcriptFilename,
        parents: [folderId],
      },
      media: {
        mimeType: 'text/plain',
        body: fs.createReadStream(localTranscriptPath),
      },
    });
    console.log(`[Google Drive Helper] Raw JSONL upload successful: fileId=${jsonlResponse.data.id}`);

    // 2. Convert and upload readable text transcript
    console.log(`[Google Drive Helper] Converting and uploading readable TXT transcript file...`);
    const readableContent = convertJsonlToReadable(localTranscriptPath);
    if (readableContent) {
      const txtResponse = await drive.files.create({
        requestBody: {
          name: `${botType}_${sessionId}_readable.txt`,
          parents: [folderId],
        },
        media: {
          mimeType: 'text/plain',
          body: Readable.from([readableContent]),
        },
      });
      console.log(`[Google Drive Helper] Readable TXT upload successful: fileId=${txtResponse.data.id}`);
    } else {
      console.log(`[Google Drive Helper] No readable content generated from JSONL transcript.`);
    }

  } catch (err) {
    console.error(`[Google Drive Helper] Failed to upload transcript to Google Drive:`, err.message);
  }
}

export async function uploadReportToGoogleDrive(filename, folderId) {
  console.log(`[Google Drive Helper] Initiating report upload for ${filename} to folder ${folderId}`);
  try {
    const drive = await getDriveClient();
    const transcriptsDir = path.join(process.cwd(), 'transcripts');

    // 1. Upload Markdown report
    const mdFilename = filename.replace('.jsonl', '_report.md');
    const localMdPath = path.join(transcriptsDir, mdFilename);
    if (fs.existsSync(localMdPath)) {
      console.log(`[Google Drive Helper] Uploading Markdown report file...`);
      const mdResponse = await drive.files.create({
        requestBody: {
          name: mdFilename,
          parents: [folderId],
        },
        media: {
          mimeType: 'text/markdown',
          body: fs.createReadStream(localMdPath),
        },
      });
      console.log(`[Google Drive Helper] Markdown report upload successful: fileId=${mdResponse.data.id}`);
    }

    // 2. Upload DOCX report
    const docxFilename = filename.replace('.jsonl', '_report.docx');
    const localDocxPath = path.join(transcriptsDir, docxFilename);
    if (fs.existsSync(localDocxPath)) {
      console.log(`[Google Drive Helper] Uploading DOCX report file...`);
      const docxResponse = await drive.files.create({
        requestBody: {
          name: docxFilename,
          parents: [folderId],
        },
        media: {
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          body: fs.createReadStream(localDocxPath),
        },
      });
      console.log(`[Google Drive Helper] DOCX report upload successful: fileId=${docxResponse.data.id}`);
    }
  } catch (err) {
    console.error('[Google Drive Helper] Failed to upload report files to Google Drive:', err.message);
  }
}

