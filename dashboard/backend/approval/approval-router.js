import express from 'express';
import crypto from 'crypto';
import { supabase } from '../supabase-client.js';
import { processManager } from '../process-manager.js';
import { getSessionRoster } from '../live-scheduling.js';

export const approvalRouter = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function normalizeName(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getApprovalState(proposal) {
  const approvals = Array.isArray(proposal.approvals) ? proposal.approvals : [];
  const roster = getSessionRoster(proposal.session_id)
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  const approvedNames = new Set(approvals.map((approval) => normalizeName(approval.name)));
  const availableRoster = roster.filter((entry) => !approvedNames.has(normalizeName(entry)));
  const votingComplete = roster.length > 0 && availableRoster.length === 0;

  return { approvals, roster, availableRoster, votingComplete };
}

function getPublicProposal(proposal, includeApprovals = false) {
  const { approvals, roster, availableRoster, votingComplete } = getApprovalState(proposal);
  return {
    id: proposal.id,
    token: proposal.token,
    title: proposal.title,
    date: proposal.date,
    time: proposal.time,
    timezone: proposal.timezone,
    raw_mention: proposal.raw_mention,
    status: proposal.status,
    roster,
    available_roster: availableRoster,
    voting_complete: votingComplete,
    ...(includeApprovals ? { approvals } : {})
  };
}

/**
 * Builds the public approval page URL for a proposal token.
 */
function buildApprovalPageUrl(token) {
  return `${FRONTEND_URL.replace(/\/$/, '')}/approve?token=${encodeURIComponent(token)}`;
}

/**
 * Loads a scheduling proposal row by token.
 */
async function getProposalByToken(token) {
  if (!token || typeof token !== 'string') return null;
  const { data, error } = await supabase
    .from('scheduling_approvals')
    .select('*')
    .eq('token', token)
    .maybeSingle();
  if (error) {
    console.error('[ApprovalRouter] getProposalByToken error:', error.message);
    return null;
  }
  return data;
}

/**
 * Loads the current proposal for a live session (pending or organizer-approved).
 */
async function getLiveProposal(sessionId) {
  if (!sessionId) return null;
  // Multiple proposals can exist for a session (e.g. re-detection or manual tests).
  // Return the most recent one instead of erroring out on duplicates.
  const { data, error } = await supabase
    .from('scheduling_approvals')
    .select('*')
    .eq('session_id', sessionId)
    .in('status', ['pending_organizer', 'approved_by_organizer'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[ApprovalRouter] getLiveProposal error:', error.message);
    return null;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Organizer-side routes (authenticated)
// ---------------------------------------------------------------------------

/**
 * Posts a proposal message into the live Google Meet chat (if the bot is up).
 * Shared by the organizer-approve flow and the manual test trigger.
 */
function postProposalToMeetChat(proposal) {
  const approvalUrl = buildApprovalPageUrl(proposal.token);
  const sessionInfo = processManager.getSession(proposal.session_id);
  if (sessionInfo && sessionInfo.childProcess && sessionInfo.childProcess.stdin?.writable) {
    const chatMessage = JSON.stringify({
      kind: 'scheduling_proposal',
      title: proposal.title,
      date: proposal.date,
      time: proposal.time,
      timezone: proposal.timezone || '',
      approvalUrl,
      rawMention: proposal.raw_mention || ''
    });
    sessionInfo.childProcess.stdin.write(`chat:${chatMessage}\n`);
    console.log(`[ApprovalRouter] Posted scheduling proposal to Meet chat for session ${proposal.session_id}`);
    return true;
  }
  console.warn(`[ApprovalRouter] No live bot process for session ${proposal.session_id}; chat message skipped.`);
  return false;
}

/**
 * POST /api/approvals/organizer/approve
 * Stage 1: The organizer (calendar owner) approves the detected proposal on CrestMeet.
 * Marks it approved_by_organizer and (if the bot is live) posts the proposal
 * message into the Google Meet central chat.
 */
approvalRouter.post('/organizer/approve', async (req, res) => {
  const { sessionId, token, date, time } = req.body;
  if (!sessionId && !token) {
    return res.status(400).json({ error: 'Missing sessionId or token' });
  }

  const proposal = token ? await getProposalByToken(token) : await getLiveProposal(sessionId);
  if (!proposal) {
    return res.status(404).json({ error: 'Scheduling proposal not found' });
  }

  // Already past the organizer stage — treat as success (idempotent).
  if (proposal.status !== 'pending_organizer') {
    return res.json({ success: true, proposal });
  }

  // Allow the organizer to correct/fill in the date & time before it goes to chat.
  const updateData = {
    status: 'approved_by_organizer',
    approved_by: req.user?.email || req.user?.id || null
  };
  if (date !== undefined) updateData.date = date || null;
  if (time !== undefined) updateData.time = time || null;

  const sessionIdValue = proposal.session_id;
  const { data, error } = await supabase
    .from('scheduling_approvals')
    .update(updateData)
    .eq('id', proposal.id)
    .select()
    .single();

  if (error) {
    console.error('[ApprovalRouter] Organizer approve update failed:', error.message);
    return res.status(500).json({ error: 'Failed to record organizer approval' });
  }

  console.log(`[ApprovalRouter] Organizer approved proposal ${proposal.id} for session ${sessionIdValue}`);

  // Stage 1 done -> post the proposal message into the live Meet chat.
  postProposalToMeetChat(data);

  return res.json({ success: true, proposal: data });
});

/**
 * POST /api/approvals/organizer/reject
 * Stage 1 rejection: dismiss the proposal without scheduling anything.
 */
approvalRouter.post('/organizer/reject', async (req, res) => {
  const { sessionId, token } = req.body;
  if (!sessionId && !token) {
    return res.status(400).json({ error: 'Missing sessionId or token' });
  }

  const proposal = token ? await getProposalByToken(token) : await getLiveProposal(sessionId);
  if (!proposal) {
    return res.status(404).json({ error: 'Scheduling proposal not found' });
  }

  if (proposal.status === 'rejected_by_organizer' || proposal.status === 'scheduled') {
    return res.json({ success: true, proposal });
  }

  const { data, error } = await supabase
    .from('scheduling_approvals')
    .update({ status: 'rejected_by_organizer' })
    .eq('id', proposal.id)
    .select()
    .single();

  if (error) {
    console.error('[ApprovalRouter] Organizer reject update failed:', error.message);
    return res.status(500).json({ error: 'Failed to reject proposal' });
  }

  return res.json({ success: true, proposal: data });
});

/**
 * GET /api/approvals/live?sessionId=...
 * Returns the pending/approved proposal for a live session (dashboard banner).
 */
approvalRouter.get('/live', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const proposal = await getLiveProposal(sessionId);
  if (!proposal) return res.json({ success: true, proposal: null });

  // Build the organizer approval URL from the token.
  res.json({
    success: true,
    proposal: {
      ...proposal,
      roster: getSessionRoster(sessionId),
      organizer_approval_url: proposal.status === 'pending_organizer'
        ? buildApprovalPageUrl(proposal.token)
        : null
    }
  });
});

// ---------------------------------------------------------------------------
// Public routes (unauthenticated — accessed from the link in Meet chat)
// ---------------------------------------------------------------------------

/**
 * GET /api/approvals/public/:token
 * Public snapshot of a proposal for the approval page (no organizer polling UI).
 */
approvalRouter.get('/public/:token', async (req, res) => {
  const proposal = await getProposalByToken(req.params.token);
  if (!proposal) return res.status(404).json({ error: 'Approval link is invalid or expired' });
  if (proposal.status === 'pending_organizer') {
    return res.status(425).json({ error: 'This meeting has not been approved by the organizer yet.' });
  }
  if (proposal.status === 'rejected_by_organizer') {
    return res.status(409).json({ error: 'This meeting proposal was rejected by the organizer.' });
  }
  if (proposal.status === 'scheduled') {
    return res.status(410).json({ error: 'This meeting has already been scheduled.' });
  }

  // Approved by organizer — anyone with the link can cast an approval.
  res.json({
    success: true,
    proposal: getPublicProposal(proposal, true)
  });
});

/**
 * POST /api/approvals/public/:token/vote
 * Records one attendee's approval (name + email) for the proposal.
 * Dedupes by email. Does NOT require auth — the link itself is the bearer credential.
 */
approvalRouter.post('/public/:token/vote', async (req, res) => {
  const { name, email } = req.body;
  const cleanName = String(name || '').trim();
  const cleanEmail = normalizeEmail(email);

  if (!cleanName) return res.status(400).json({ error: 'Please provide your name' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Please provide a valid email address' });
  }

  const proposal = await getProposalByToken(req.params.token);
  if (!proposal) return res.status(404).json({ error: 'Approval link is invalid or expired' });
  if (proposal.status !== 'approved_by_organizer') {
    return res.status(409).json({ error: 'This meeting is not open for approval yet.' });
  }

  // Dedupe by email.
  const { data: existing } = await supabase
    .from('scheduling_approvals')
    .select('approvals')
    .eq('id', proposal.id)
    .maybeSingle();

  const approvals = Array.isArray(existing?.approvals) ? existing.approvals : [];
  const alreadyIndex = approvals.findIndex((a) => normalizeEmail(a.email) === cleanEmail);
  if (alreadyIndex >= 0) {
    // Update the existing entry (name may have changed).
    approvals[alreadyIndex] = {
      name: cleanName,
      email: cleanEmail,
      approved_at: new Date().toISOString()
    };
  } else {
    approvals.push({
      name: cleanName,
      email: cleanEmail,
      approved_at: new Date().toISOString()
    });
  }

  const { data, error } = await supabase
    .from('scheduling_approvals')
    .update({ approvals })
    .eq('id', proposal.id)
    .select()
    .single();

  if (error) {
    console.error('[ApprovalRouter] Vote update failed:', error.message);
    return res.status(500).json({ error: 'Failed to record your approval' });
  }

  console.log(`[ApprovalRouter] Approval recorded for proposal ${proposal.id}: ${cleanName} <${cleanEmail}>`);

  res.json({
    success: true,
    proposal: getPublicProposal(data, true)
  });
});

/**
 * POST /api/approvals/:token/finalize
 * Stage 2 completion: after attendees approve, the organizer (or authorized user)
 * finalizes — creates the Google Calendar event and notifies attendees.
 */
approvalRouter.post('/:token/finalize', async (req, res) => {
  const proposal = await getProposalByToken(req.params.token);
  if (!proposal) return res.status(404).json({ error: 'Approval link is invalid or expired' });

  if (proposal.status === 'scheduled') {
    return res.json({ success: true, alreadyScheduled: true, proposal });
  }
  if (proposal.status !== 'approved_by_organizer') {
    return res.status(409).json({ error: 'Meeting cannot be scheduled yet (organizer approval pending).' });
  }

  // Build the event in the organizer's calendar via the existing calendar service.
  const { createCalendarEvent, getDefaultDurationMinutes } = await import('../calendar/calendar-service.js');
  const tz = proposal.timezone || process.env.CALENDAR_TIMEZONE || 'Asia/Kolkata';
  const duration = getDefaultDurationMinutes();

  const approvals = Array.isArray(proposal.approvals) ? proposal.approvals : [];
  const attendees = approvals.map((approval) => ({
    email: normalizeEmail(approval.email),
    displayName: String(approval.name || '').trim()
  }));

  const [y, m, d] = String(proposal.date).split('-').map(Number);
  const [h, min] = String(proposal.time).split(':').map(Number);
  const pad = (num) => String(num).padStart(2, '0');
  const startIsoStr = `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:00`;
  const localStart = new Date(Date.UTC(y, m - 1, d, h, min, 0));
  const localEnd = new Date(localStart.getTime() + duration * 60 * 1000);
  const endIsoStr = `${localEnd.getUTCFullYear()}-${pad(localEnd.getUTCMonth() + 1)}-${pad(localEnd.getUTCDate())}T${pad(localEnd.getUTCHours())}:${pad(localEnd.getUTCMinutes())}:${pad(localEnd.getUTCSeconds())}`;

  let event;
  try {
    event = await createCalendarEvent(
      proposal.title,
      startIsoStr,
      endIsoStr,
      tz,
      null,
      null,
      { attendees, sendUpdates: 'all' }
    );
  } catch (err) {
    const { handleGoogleApiError } = await import('../calendar/calendar-service.js');
    const normErr = handleGoogleApiError(err);
    console.error('[ApprovalRouter] Event creation failed:', normErr.error);
    return res.status(normErr.status).json({ error: normErr.error });
  }

  // Persist scheduled state + event details.
  const { data, error } = await supabase
    .from('scheduling_approvals')
    .update({
      status: 'scheduled',
      event_id: event.id,
      html_link: event.htmlLink || null,
      finalized_by: req.user?.email || req.user?.id || null,
      finalized_at: new Date().toISOString()
    })
    .eq('id', proposal.id)
    .select()
    .single();

  if (error) {
    console.error('[ApprovalRouter] Finalize update failed:', error.message);
    return res.status(500).json({ error: 'Event created but failed to update approval state' });
  }

  // Notify attendees (best-effort). Google Calendar also sends native invitations.
  const finalizedApprovals = Array.isArray(data.approvals) ? data.approvals : [];
  const emails = [...new Set(finalizedApprovals.map((a) => normalizeEmail(a.email)).filter(Boolean))];
  if (emails.length > 0) {
    try {
      const { sendSchedulingNotification } = await import('../email-service.js');
      await sendSchedulingNotification({
        sessionId: proposal.session_id,
        meetingTitle: proposal.title,
        startDate: proposal.date,
        startTime: proposal.time,
        timezone: tz,
        attendeeEmails: emails,
        eventHtmlLink: event.htmlLink || null
      });
    } catch (emailErr) {
      console.error('[ApprovalRouter] Failed to send scheduling notifications:', emailErr.message);
    }
  }

  console.log(`[ApprovalRouter] Finalized proposal ${proposal.id} -> event ${event.id}`);

  res.json({
    success: true,
    id: event.id,
    htmlLink: event.htmlLink,
    proposal: data
  });
});

export default approvalRouter;
