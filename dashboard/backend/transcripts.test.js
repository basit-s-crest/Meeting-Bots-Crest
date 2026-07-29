import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { supabase } from './supabase-client.js';

// Set NODE_ENV to test to prevent auto-listening on port 3000
process.env.NODE_ENV = 'test';
const { app } = await import('./server.js');

describe('Transcripts projectId Filtering Unit Tests', () => {
  let server;
  let baseUrl;
  let projectA;
  let projectB;
  let sessionAId;
  let sessionBId;
  let token;
  let testUser;

  before(async () => {
    // Start server on an ephemeral port
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });

    // 0. Sign up a test user
    const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test User',
        email: `testuser_${Date.now()}_${Math.random().toString(36).substring(2, 6)}@example.com`,
        password: 'password123'
      })
    });
    const signupData = await signupRes.json();
    if (!signupRes.ok) {
      throw new Error(`Failed to sign up test user: ${signupData.error}`);
    }
    token = signupData.token;
    testUser = signupData.user;

    // 1. Create project A and project B linked to the test user
    const { data: projA, error: errA } = await supabase
      .from('projects')
      .insert({ name: 'UnitTest Project A ' + Date.now(), description: 'Test project A', user_id: testUser.id })
      .select()
      .single();
    if (errA) throw new Error(`Failed to create Project A: ${errA.message}`);
    projectA = projA;

    const { data: projB, error: errB } = await supabase
      .from('projects')
      .insert({ name: 'UnitTest Project B ' + Date.now(), description: 'Test project B', user_id: testUser.id })
      .select()
      .single();
    if (errB) throw new Error(`Failed to create Project B: ${errB.message}`);
    projectB = projB;

    // 2. Write a transcript session to each project
    sessionAId = 'test_sess_a_' + Date.now();
    sessionBId = 'test_sess_b_' + Date.now();

    const { error: sessErrA } = await supabase
      .from('meeting_sessions')
      .insert({
        session_id: sessionAId,
        bot_type: 'zoom',
        meeting_url: 'https://zoom.us/test-a',
        bot_name: 'Test Bot A',
        status: 'completed',
        project_id: projectA.id,
        transcript_file_url: 'https://example.com/test-a.jsonl'
      });
    if (sessErrA) throw new Error(`Failed to insert session A: ${sessErrA.message}`);

    const { error: sessErrB } = await supabase
      .from('meeting_sessions')
      .insert({
        session_id: sessionBId,
        bot_type: 'meet',
        meeting_url: 'https://meet.google.com/test-b',
        bot_name: 'Test Bot B',
        status: 'completed',
        project_id: projectB.id,
        transcript_file_url: 'https://example.com/test-b.jsonl'
      });
    if (sessErrB) throw new Error(`Failed to insert session B: ${sessErrB.message}`);
  });

  after(async () => {
    // Cleanup sessions, projects and users created during test
    if (sessionAId) {
      await supabase.from('meeting_sessions').delete().eq('session_id', sessionAId);
    }
    if (sessionBId) {
      await supabase.from('meeting_sessions').delete().eq('session_id', sessionBId);
    }
    if (projectA?.id) {
      await supabase.from('projects').delete().eq('id', projectA.id);
    }
    if (projectB?.id) {
      await supabase.from('projects').delete().eq('id', projectB.id);
    }
    if (testUser?.id) {
      await supabase.from('users').delete().eq('id', testUser.id);
    }

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    setTimeout(() => process.exit(0), 100);
  });

  it("asserts project A's read returns project A's transcript and NEVER project B's data", async () => {
    const res = await fetch(`${baseUrl}/api/transcripts?projectId=${projectA.id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const sessionIds = body.transcripts.map(t => t.sessionId);

    assert.ok(sessionIds.includes(sessionAId), "Project A's transcript should be present in Project A's read");
    assert.strictEqual(sessionIds.includes(sessionBId), false, "Project B's transcript must NEVER be returned in Project A's read");
  });

  it("asserts project B's read returns project B's transcript and NEVER project A's data", async () => {
    const res = await fetch(`${baseUrl}/api/transcripts?projectId=${projectB.id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const sessionIds = body.transcripts.map(t => t.sessionId);

    assert.ok(sessionIds.includes(sessionBId), "Project B's transcript should be present in Project B's read");
    assert.strictEqual(sessionIds.includes(sessionAId), false, "Project A's transcript must NEVER be returned in Project B's read");
  });

  it('handles empty string projectId ("") by falling back to unfiltered read without errors', async () => {
    const res = await fetch(`${baseUrl}/api/transcripts?projectId=`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const sessionIds = body.transcripts.map(t => t.sessionId);

    assert.ok(sessionIds.includes(sessionAId), "Empty string projectId should return all sessions (session A)");
    assert.ok(sessionIds.includes(sessionBId), "Empty string projectId should return all sessions (session B)");
  });

  it('handles whitespace projectId ("   ") without errors', async () => {
    const res = await fetch(`${baseUrl}/api/transcripts?projectId=%20%20%20`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const sessionIds = body.transcripts.map(t => t.sessionId);

    assert.ok(sessionIds.includes(sessionAId));
    assert.ok(sessionIds.includes(sessionBId));
  });

  it('handles multiple projectId values in query (array instead of string)', async () => {
    const res = await fetch(`${baseUrl}/api/transcripts?projectId=${projectA.id}&projectId=${projectB.id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const sessionIds = body.transcripts.map(t => t.sessionId);

    assert.ok(sessionIds.includes(sessionAId), "Array of projectIds should include project A's data");
    assert.ok(sessionIds.includes(sessionBId), "Array of projectIds should include project B's data");
  });
});
