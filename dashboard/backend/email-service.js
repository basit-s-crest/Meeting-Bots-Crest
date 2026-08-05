import nodemailer from 'nodemailer';
import fs from 'fs/promises';
import path from 'path';
import { convertMarkdownToDocx } from './docx-generator.js';

/**
 * Creates a nodemailer SMTP transport configured for Gmail.
 */
function createTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    console.warn('[EmailService] GMAIL_USER or GMAIL_APP_PASSWORD not set in environment. Email sending will be skipped.');
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user,
      pass
    }
  });
}

/**
 * Sends a meeting report email to a list of attendee email addresses.
 * Note: Gmail SMTP has a limit of ~500 emails/day.
 * 
 * @param {Object} params
 * @param {string} params.sessionId - The meeting session ID
 * @param {string} [params.meetingTitle] - Display title for the meeting
 * @param {string} [params.reportMarkdown] - Full markdown text of the report
 * @param {string} [params.reportUrl] - Supabase public URL for the report
 * @param {Array<string>} params.attendeeEmails - Array of recipient email addresses
 * @param {string} [params.localReportPath] - Path to local .md file to attach if available
 */
export async function sendReportEmailToAttendees({
  sessionId,
  meetingTitle,
  reportMarkdown = '',
  reportUrl = '',
  attendeeEmails = [],
  localReportPath = null
}) {
  if (!attendeeEmails || !Array.isArray(attendeeEmails) || attendeeEmails.length === 0) {
    console.log(`[EmailService] No attendee emails provided for session ${sessionId}. Skipping report email distribution.`);
    return { success: true, count: 0, results: [] };
  }

  const transporter = createTransporter();
  if (!transporter) {
    console.warn(`[EmailService] Transporter unavailable. Cannot send report emails for session ${sessionId}.`);
    return { success: false, error: 'Gmail credentials not configured' };
  }

  const senderEmail = process.env.GMAIL_USER;
  const fromName = 'Meeting Bot Reports';
  const fromAddress = `"${fromName}" <${senderEmail}>`;
  const displayTitle = meetingTitle || `Meeting Report (${sessionId})`;
  const currentDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Prepare email attachments (Word Document .docx format)
  const attachments = [];
  try {
    let docxBuffer = null;
    if (reportMarkdown) {
      docxBuffer = await convertMarkdownToDocx(reportMarkdown);
    } else if (localReportPath) {
      const mdContent = await fs.readFile(localReportPath, 'utf8');
      docxBuffer = await convertMarkdownToDocx(mdContent);
    }

    if (docxBuffer) {
      attachments.push({
        filename: `${sessionId}_meeting_report.docx`,
        content: docxBuffer,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });
    }
  } catch (docxErr) {
    console.warn(`[EmailService] Failed to generate DOCX attachment, falling back to markdown: ${docxErr.message}`);
    if (reportMarkdown) {
      attachments.push({
        filename: `${sessionId}_meeting_report.md`,
        content: reportMarkdown,
        contentType: 'text/markdown'
      });
    }
  }

  // Extract a preview/summary section from markdown if present
  let summarySnippet = 'The meeting report has been generated.';
  if (reportMarkdown) {
    const summaryMatch = reportMarkdown.match(/## Summary\s+([\s\S]*?)(?=\n## |$)/);
    if (summaryMatch && summaryMatch[1]) {
      summarySnippet = summaryMatch[1].trim();
    }
  }

  // HTML template
  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; background-color: #f8fafc; padding: 20px; line-height: 1.5; }
        .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
        .header { border-bottom: 1px solid #e2e8f0; padding-bottom: 16px; margin-bottom: 24px; }
        .title { font-size: 20px; font-weight: 700; color: #0f172a; margin: 0 0 4px 0; }
        .date { font-size: 13px; color: #64748b; margin: 0; }
        .badge { display: inline-block; background-color: #e0e7ff; color: #3730a3; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 9999px; margin-bottom: 16px; }
        .summary-box { background-color: #f1f5f9; border-left: 4px solid #4f46e5; padding: 16px; border-radius: 4px; font-size: 14px; color: #334155; margin-bottom: 24px; white-space: pre-wrap; }
        .btn { display: inline-block; background-color: #4f46e5; color: #ffffff !important; text-decoration: none; font-weight: 600; font-size: 14px; padding: 10px 20px; border-radius: 8px; margin-top: 8px; }
        .footer { margin-top: 32px; font-size: 12px; color: #94a3b8; text-align: center; border-top: 1px solid #f1f5f9; padding-top: 16px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <span class="badge">Meeting Summary & Report</span>
          <h1 class="title">${escapeHtml(displayTitle)}</h1>
          <p class="date">${currentDate} &bull; Session: ${sessionId}</p>
        </div>

        <p style="font-size: 15px; color: #334155;">Hello,</p>
        <p style="font-size: 14px; color: #334155;">Your meeting report is ready. Here is a summary of the discussion:</p>

        <div class="summary-box">
          ${escapeHtml(summarySnippet)}
        </div>

        ${reportUrl ? `<p style="margin-bottom: 24px;"><a href="${reportUrl}" class="btn" target="_blank">View Full Online Report &rarr;</a></p>` : ''}

        <p style="font-size: 13px; color: #64748b;">The complete meeting transcript and structured report are attached to this email as a Word document (<code>.docx</code>).</p>

        <div class="footer">
          Sent automatically by Meeting Bot Orchestrator &bull; Confidential
        </div>
      </div>
    </body>
    </html>
  `;

  const textBody = `
${displayTitle}
Date: ${currentDate}
Session ID: ${sessionId}

Summary:
${summarySnippet}

${reportUrl ? `View Full Online Report: ${reportUrl}\n` : ''}
The full report is attached to this email as a Word document (.docx).
`;

  console.log(`[EmailService] Beginning bulk report distribution for session ${sessionId} to ${attendeeEmails.length} recipient(s)...`);

  // Bulk send using Promise.allSettled for individual recipient error isolation
  const sendPromises = attendeeEmails.map(async (recipientEmail) => {
    const target = recipientEmail.trim();
    if (!target) return { recipient: target, success: false, error: 'Empty email address' };

    try {
      const info = await transporter.sendMail({
        from: fromAddress,
        to: target,
        subject: `[Meeting Report] ${displayTitle}`,
        text: textBody,
        html: htmlBody,
        attachments
      });

      console.log(`[EmailService] Successfully sent report email to ${target} (MessageID: ${info.messageId})`);
      return { recipient: target, success: true, messageId: info.messageId };
    } catch (err) {
      console.error(`[EmailService] Failed to send report email to ${target}:`, err.message);
      return { recipient: target, success: false, error: err.message };
    }
  });

  const results = await Promise.allSettled(sendPromises);
  const detailedResults = results.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: r.reason });

  const successCount = detailedResults.filter(r => r.success).length;
  const failureCount = detailedResults.length - successCount;

  console.log(`[EmailService] Bulk report send complete for session ${sessionId}: ${successCount} succeeded, ${failureCount} failed out of ${detailedResults.length} total.`);

  return {
    success: successCount > 0 || detailedResults.length === 0,
    total: detailedResults.length,
    successCount,
    failureCount,
    results: detailedResults
  };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
