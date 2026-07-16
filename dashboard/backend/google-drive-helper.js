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

function getFormattedMeetingName(transcriptPath) {
  let dateObj = new Date(); // Fallback to current time
  try {
    if (fs.existsSync(transcriptPath)) {
      const content = fs.readFileSync(transcriptPath, 'utf8').trim();
      if (content) {
        const firstLine = content.split('\n')[0];
        if (firstLine) {
          const data = JSON.parse(firstLine);
          if (data.timestamp) {
            dateObj = new Date(data.timestamp);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Google Drive Helper] Failed to read meeting start timestamp, using current time:', err.message);
  }

  // Format date parts: YYYY/MM/DD HH:MM TZ
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  const hours = String(dateObj.getHours()).padStart(2, '0');
  const minutes = String(dateObj.getMinutes()).padStart(2, '0');

  let tz = 'IST'; // default fallback
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(dateObj);
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    if (tzPart) {
      tz = tzPart.value;
    }
  } catch (tzErr) {
    // Ignore timezone formatting errors
  }

  return `Meeting started ${year}/${month}/${day} ${hours}:${minutes} ${tz}`;
}

export async function getDocsClient() {
  const refreshToken = loadRefreshToken();
  if (!refreshToken) {
    throw new Error('Google Docs not connected (no refresh token found)');
  }
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.docs({ version: 'v1', auth: oauth2Client });
}

function parseMarkdownToStructure(markdownContent) {
  const lines = markdownContent.split('\n');
  let title = '';
  
  const introSection = {
    title: '',
    paragraphs: [],
    listItems: [],
    tableRows: []
  };
  let currentSection = introSection;
  const sections = [introSection];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    if (line.startsWith('# ')) {
      title = line.substring(2).trim();
      continue;
    }

    if (line.startsWith('## ')) {
      const secTitle = line.substring(3).trim();
      currentSection = {
        title: secTitle,
        paragraphs: [],
        listItems: [],
        tableRows: []
      };
      sections.push(currentSection);
      continue;
    }

    if (currentSection) {
      if (line.startsWith('* ') || line.startsWith('- ')) {
        // Bullet list item
        currentSection.listItems.push(line.substring(2).trim());
      } else if (line.startsWith('|')) {
        // Table row
        if (!line.includes('---')) {
          const cells = line.split('|').slice(1, -1).map(c => c.trim());
          currentSection.tableRows.push(cells);
        }
      } else {
        // Regular paragraph
        currentSection.paragraphs.push(line);
      }
    }
  }

  return { title, sections };
}

export async function populateGoogleDocTabs(docs, drive, newDocId, filename, reportMarkdown) {
  try {
    // 1. Get doc metadata to find tab IDs
    console.log(`[Google Drive Helper] Fetching tab metadata for document: ${newDocId}`);
    const docMeta = await docs.documents.get({
      documentId: newDocId,
      includeTabsContent: true
    });
    
    const tabs = docMeta.data.tabs || [];
    let notesTabId = null;
    let transcriptTabId = null;

    for (const tab of tabs) {
      const title = tab.tabProperties?.title || '';
      const id = tab.tabProperties?.tabId;
      if (title.toLowerCase().includes('notes') || title.toLowerCase().includes('summary') || !notesTabId) {
        if (!notesTabId) notesTabId = id;
      }
      if (title.toLowerCase().includes('transcript')) {
        transcriptTabId = id;
      }
    }

    if (!notesTabId && tabs[0]) notesTabId = tabs[0].tabProperties?.tabId;
    if (!transcriptTabId && tabs[1]) transcriptTabId = tabs[1].tabProperties?.tabId;

    if (!notesTabId || !transcriptTabId) {
      throw new Error(`Failed to find Notes and/or Transcript tabs in the copied template. Found tabs: ${JSON.stringify(tabs.map(t => t.tabProperties?.title))}`);
    }

    console.log(`[Google Drive Helper] Using Tab IDs - Notes: ${notesTabId}, Transcript: ${transcriptTabId}`);

    // 2. Clear default text in both tabs
    const clearRequests = [];
    for (const tab of tabs) {
      const tabId = tab.tabProperties.tabId;
      const tabContent = tab.documentTab;
      const bodyContent = tabContent?.body?.content || [];
      if (bodyContent.length > 0) {
        const lastElement = bodyContent[bodyContent.length - 1];
        const endIndex = lastElement.endIndex;
        if (endIndex > 2) {
          clearRequests.push({
            deleteContentRange: {
              range: {
                startIndex: 1,
                endIndex: endIndex - 1,
                tabId: tabId
              }
            }
          });
        }
      }
    }

    if (clearRequests.length > 0) {
      console.log(`[Google Drive Helper] Clearing default placeholder text in tabs...`);
      await docs.documents.batchUpdate({
        documentId: newDocId,
        requestBody: { requests: clearRequests }
      });
    }

    // 3. Split the report markdown into Notes (Part 0) and Transcript (Part 1)
    const parts = reportMarkdown.split('---');
    const notesMarkdown = parts[0] || '';

    // 4. Parse Notes Markdown into paragraphs, lists, and tables
    const parsedNotes = parseMarkdownToStructure(notesMarkdown);

    // 5. Construct notes text block
    let notesText = '';
    if (parsedNotes.title) {
      notesText += parsedNotes.title + '\n\n';
    }

    // Capture the paragraphs and format list items
    for (const sec of parsedNotes.sections) {
      if (sec.title) {
        notesText += sec.title + '\n\n';
      }
      for (const p of sec.paragraphs) {
        notesText += p + '\n\n';
      }
      for (const item of sec.listItems) {
        notesText += item + '\n';
      }
      if (sec.listItems.length > 0) {
        notesText += '\n';
      }
    }

    // Insert notes text block into Notes Tab
    const insertNotesRequest = [
      {
        insertText: {
          text: notesText,
          location: {
            index: 1,
            tabId: notesTabId
          }
        }
      }
    ];

    console.log(`[Google Drive Helper] Inserting notes text block...`);
    await docs.documents.batchUpdate({
      documentId: newDocId,
      requestBody: { requests: insertNotesRequest }
    });

    // 6. Format Notes Tab Content
    const formatRequests = [];

    // Title formatting
    if (parsedNotes.title) {
      formatRequests.push(
        {
          updateParagraphStyle: {
            paragraphStyle: {
              namedStyleType: 'TITLE',
              spaceAfter: { magnitude: 12, unit: 'PT' }
            },
            fields: 'namedStyleType,spaceAfter',
            range: {
              startIndex: 1,
              endIndex: parsedNotes.title.length + 1,
              tabId: notesTabId
            }
          }
        },
        {
          updateTextStyle: {
            textStyle: {
              bold: true,
              fontSize: { size: 22, unit: 'PT' },
              foregroundColor: { color: { rgbColor: { red: 0.12, green: 0.23, blue: 0.54 } } } // 1E3A8A
            },
            fields: 'bold,fontSize,foregroundColor',
            range: {
              startIndex: 1,
              endIndex: parsedNotes.title.length + 1,
              tabId: notesTabId
            }
          }
        }
      );
    }

    // Section Headings and Lists formatting
    for (const sec of parsedNotes.sections) {
      if (sec.title) {
        const secStartIdx = notesText.indexOf(sec.title);
        if (secStartIdx !== -1) {
          formatRequests.push(
            {
              updateParagraphStyle: {
                paragraphStyle: {
                  namedStyleType: 'HEADING_2',
                  spaceBefore: { magnitude: 18, unit: 'PT' },
                  spaceAfter: { magnitude: 6, unit: 'PT' }
                },
                fields: 'namedStyleType,spaceBefore,spaceAfter',
                range: {
                  startIndex: secStartIdx + 1,
                  endIndex: secStartIdx + sec.title.length + 1,
                  tabId: notesTabId
                }
              }
            },
            {
              updateTextStyle: {
                textStyle: {
                  bold: true,
                  fontSize: { size: 14, unit: 'PT' },
                  foregroundColor: { color: { rgbColor: { red: 0.15, green: 0.39, blue: 0.92 } } } // 2563EB
                },
                fields: 'bold,fontSize,foregroundColor',
                range: {
                  startIndex: secStartIdx + 1,
                  endIndex: secStartIdx + sec.title.length + 1,
                  tabId: notesTabId
                }
              }
            }
          );
        }
      }

      // Format lists as bullet points
      if (sec.listItems.length > 0) {
        const firstItem = sec.listItems[0];
        const lastItem = sec.listItems[sec.listItems.length - 1];
        const startIdx = notesText.indexOf(firstItem);
        const endIdx = notesText.indexOf(lastItem) + lastItem.length;

        if (startIdx !== -1 && endIdx !== -1) {
          formatRequests.push({
            createParagraphBullets: {
              bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
              range: {
                startIndex: startIdx + 1,
                endIndex: endIdx + 1,
                tabId: notesTabId
              }
            }
          });
        }
      }
    }

    if (formatRequests.length > 0) {
      console.log(`[Google Drive Helper] Formatting notes layout...`);
      await docs.documents.batchUpdate({
        documentId: newDocId,
        requestBody: { requests: formatRequests }
      });
    }

    // 7. Insert and Populate Action Items Table
    const tableSection = parsedNotes.sections.find(s => s.title.toLowerCase().includes('action') || s.tableRows.length > 0);
    if (tableSection && tableSection.tableRows.length > 0) {
      const tableRows = tableSection.tableRows;
      
      const updatedMeta = await docs.documents.get({
        documentId: newDocId,
        includeTabsContent: true
      });
      const updatedNotesTab = updatedMeta.data.tabs.find(t => t.tabProperties.tabId === notesTabId);
      const elements = updatedNotesTab?.documentTab?.body?.content || [];
      const endOfDocElement = elements[elements.length - 1];
      const tableInsertIndex = Math.max(1, endOfDocElement.endIndex - 1);

      console.log(`[Google Drive Helper] Inserting Action Items table at index: ${tableInsertIndex}`);
      await docs.documents.batchUpdate({
        documentId: newDocId,
        requestBody: {
          requests: [
            {
              insertTable: {
                rows: tableRows.length,
                columns: 3,
                location: {
                  index: tableInsertIndex,
                  tabId: notesTabId
                }
              }
            }
          ]
        }
      });

      const finalDocMeta = await docs.documents.get({
        documentId: newDocId,
        includeTabsContent: true
      });
      const finalNotesTab = finalDocMeta.data.tabs.find(t => t.tabProperties.tabId === notesTabId);
      const finalElements = finalNotesTab?.documentTab?.body?.content || [];
      
      let insertedTable = null;
      for (let i = finalElements.length - 1; i >= 0; i--) {
        if (finalElements[i].table) {
          insertedTable = finalElements[i].table;
          break;
        }
      }

      if (insertedTable) {
        console.log(`[Google Drive Helper] Populating Action Items table cells...`);
        const cellPopulateRequests = [];
        
        for (let rIdx = insertedTable.tableRows.length - 1; rIdx >= 0; rIdx--) {
          const row = insertedTable.tableRows[rIdx];
          const rowData = tableRows[rIdx] || [];
          
          for (let cIdx = row.tableCells.length - 1; cIdx >= 0; cIdx--) {
            const cell = row.tableCells[cIdx];
            const text = rowData[cIdx] || '';
            const cellStartIdx = cell.content[0]?.startIndex;
            
            if (cellStartIdx !== undefined) {
              cellPopulateRequests.push({
                insertText: {
                  text: text,
                  location: {
                    index: cellStartIdx,
                    tabId: notesTabId
                  }
                }
              });

              if (rIdx === 0 && text) {
                cellPopulateRequests.push({
                  updateTextStyle: {
                    textStyle: { bold: true },
                    fields: 'bold',
                    range: {
                      startIndex: cellStartIdx,
                      endIndex: cellStartIdx + text.length,
                      tabId: notesTabId
                    }
                  }
                });
              }
            }
          }
        }

        if (cellPopulateRequests.length > 0) {
          await docs.documents.batchUpdate({
            documentId: newDocId,
            requestBody: { requests: cellPopulateRequests }
          });
        }
      }
    }

    // 8. Populate Transcript Tab
    const transcriptsDir = path.join(process.cwd(), 'transcripts');
    const localTranscriptPath = path.join(transcriptsDir, filename);
    let transcriptText = 'Transcript\n\n';
    try {
      if (fs.existsSync(localTranscriptPath)) {
        const fileContent = fs.readFileSync(localTranscriptPath, 'utf8').trim();
        if (fileContent) {
          const lines = fileContent.split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const data = JSON.parse(line);
              transcriptText += `${data.speaker || 'Unknown'}: ${data.text || ''}\n\n`;
            } catch {}
          }
        }
      }
    } catch (err) {
      console.warn(`[Google Drive Helper] Failed to format transcript for second tab: ${err.message}`);
    }

    console.log(`[Google Drive Helper] Populating Transcript tab...`);
    await docs.documents.batchUpdate({
      documentId: newDocId,
      requestBody: {
        requests: [
          {
            insertText: {
              text: transcriptText,
              location: {
                index: 1,
                tabId: transcriptTabId
              }
            }
          },
          {
            updateParagraphStyle: {
              paragraphStyle: {
                namedStyleType: 'HEADING_1',
                spaceAfter: { magnitude: 12, unit: 'PT' }
              },
              fields: 'namedStyleType,spaceAfter',
              range: {
                startIndex: 1,
                endIndex: 'Transcript'.length + 1,
                tabId: transcriptTabId
              }
            }
          },
          {
            updateTextStyle: {
              textStyle: {
                bold: true,
                fontSize: { size: 20, unit: 'PT' },
                foregroundColor: { color: { rgbColor: { red: 0.12, green: 0.23, blue: 0.54 } } }
              },
              fields: 'bold,fontSize,foregroundColor',
              range: {
                startIndex: 1,
                endIndex: 'Transcript'.length + 1,
                tabId: transcriptTabId
              }
            }
          }
        ]
      }
    });

    console.log(`[Google Drive Helper] Multi-tab document population complete!`);

  } catch (err) {
    console.error(`[Google Drive Helper] Failed to populate Google Doc tabs:`, err.message);
  }
}

export async function uploadReportToGoogleDrive(filename, folderId) {
  console.log(`[Google Drive Helper] Initiating report upload for ${filename} to folder ${folderId}`);
  try {
    const drive = await getDriveClient();
    const transcriptsDir = path.join(process.cwd(), 'transcripts');
    const transcriptPath = path.join(transcriptsDir, filename);

    // Get the dynamic meeting name
    const meetingName = getFormattedMeetingName(transcriptPath);
    console.log(`[Google Drive Helper] Target Google Doc name: "${meetingName}"`);

    const templateId = process.env.GOOGLE_DOC_TEMPLATE_ID;

    if (templateId) {
      try {
        console.log(`[Google Drive Helper] Template ID configured: ${templateId}. Copying template...`);
        // 1. Copy the template Google Doc
        const copyResponse = await drive.files.copy({
          fileId: templateId,
          requestBody: {
            name: meetingName,
            parents: [folderId]
          }
        });
        const newDocId = copyResponse.data.id;
        console.log(`[Google Drive Helper] Copied template successfully. New Doc ID: ${newDocId}`);

        // 2. Read local report markdown content
        const reportFilename = filename.replace('.jsonl', '_report.md');
        const reportPath = path.join(transcriptsDir, reportFilename);
        if (!fs.existsSync(reportPath)) {
          throw new Error(`Report Markdown file not found: ${reportPath}`);
        }
        const reportMarkdown = fs.readFileSync(reportPath, 'utf8');

        // 3. Populate copied document tabs
        const docs = await getDocsClient();
        await populateGoogleDocTabs(docs, drive, newDocId, filename, reportMarkdown);
        return; // Success, exit
      } catch (templateErr) {
        console.warn(`[Google Drive Helper] Template copy/populate failed: ${templateErr.message}. Falling back to DOCX upload...`);
      }
    }

    console.log(`[Google Drive Helper] Performing fallback DOCX upload...`);
    const docxFilename = filename.replace('.jsonl', '_report.docx');
    const localDocxPath = path.join(transcriptsDir, docxFilename);
    
    if (fs.existsSync(localDocxPath)) {
      await drive.files.create({
        requestBody: {
          name: meetingName,
          mimeType: 'application/vnd.google-apps.document',
          parents: [folderId]
        },
        media: {
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          body: fs.createReadStream(localDocxPath)
        }
      });
      console.log(`[Google Drive Helper] Fallback Google Doc upload successful.`);
    } else {
      console.warn(`[Google Drive Helper] DOCX file not found at: ${localDocxPath}`);
    }
  } catch (err) {
    console.error('[Google Drive Helper] Failed to upload report to Google Drive:', err.message);
  }
}
