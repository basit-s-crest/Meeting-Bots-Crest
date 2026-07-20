# Speaker Attribution Lag Fix — Implementation Document

## 1. Problem Statement

The meeting bot transcribes a meeting using two independent data streams that
run at **different latencies**:

| Stream | Source | Latency |
|--------|--------|---------|
| Speaker name | Playwright bot scrapes the `KUNJSe` active-speaker class from Google Meet's DOM and emits a `speaker_event` | ~instant |
| Speech text | Raw mixed audio → Deepgram STT → transcript with `start` timestamp | **1–3 seconds** |

Because Deepgram lags 1–3s behind the audio it transcribes, a transcript
result for Person A's last sentence can arrive **after** Person B has already
started talking and been flagged as the active speaker by the `KUNJSe` scrape.

### Symptom observed

The frontend showed every utterance attributed to a bare `speaker_1`,
`speaker_2`, … `speaker_N` with an "identifying…" tag, and the *previous*
speaker's final words leaked into the *next* speaker's block.

---

## 2. Root Cause — the original `mapTimeToSpeaker`

The original backend did a **point-in-window lookup** plus a bias that
**preferred the upcoming speaker** when a transcript timestamp fell in a gap:

```js
// OLD CODE (deepgram-proxy.js) — removed
mapTimeToSpeaker(sessionId, relativeTimeSec) {
  const absoluteTimeSec = proxy.firstChunkTs + relativeTimeSec;
  const history = proxy.chunkHistory;
  // 1. Exact window match
  for (let i = history.length - 1; i >= 0; i--) {
    const c = history[i];
    if (c.speaker && absoluteTimeSec >= c.start_ts && absoluteTimeSec <= c.end_ts) {
      return c.speaker;
    }
  }
  // 2a. Look for a chunk that starts soon AFTER the transcript time
  //     (upcoming speaker) — THIS IS THE BUG
  let upcomingChunk = null, upcomingDist = Infinity;
  for (let i = 0; i < history.length; i++) {
    const c = history[i];
    if (c.speaker && c.start_ts >= absoluteTimeSec) {
      const dist = c.start_ts - absoluteTimeSec;
      if (dist < upcomingDist && dist <= TRANSITION_TOLERANCE_SEC) {
        upcomingChunk = c;
      }
    }
  }
  if (upcomingChunk) return upcomingChunk.speaker; // wrong: attributes A's tail to B
  // ...
}
```

**Why this is backwards:** when A finishes and B starts, Deepgram is still
processing A's final words. The result's `start` lands *just after* the A→B
boundary. The point-lookup + "prefer upcoming" rule then attributes A's last
words to **B**. A 1-chunk lag cascaded into a 3–5 chunk lag.

---

## 3. Reference — Vexa `ClusterNameBinder`

The fix is modeled on Vexa's open-source `mixed-pipeline`
(`core/meetings/modules/mixed-pipeline/src/cluster-name-binder.ts`). Vexa's
architecture is structurally identical to ours:

- one **mixed** audio stream,
- a platform UI hint stream (our `KUNJSe` scrape ≈ Vexa's `dom-active` hint),
- an STT engine with processing latency.

Vexa's `ClusterNameBinder` resolves attribution with:

1. **Per-kind lag correction** — shift each hint timestamp *back* by its known
   latency before matching.
2. **Overlap-window match** — find the speaker whose hint *turn* overlaps the
   transcript's audio span the most (not a single point).
3. **Recency tie-breaker** — on a near-tie, the **more recent** hint wins.
4. **Flicker debounce + hysteresis** — ignore transient UI blips.
5. **Min coverage / support gates** — a stale hint near a boundary can't win
   just because it was the only one present.
6. **Provisional publish + in-place repaint** — a turn with no confident name
   publishes under a provisional id; when a later commit resolves it, the
   caller repaints (stable segment id + upsert) so a wrong attribution
   self-corrects instead of being permanent.

---

## 4. The Fix — `SpeakerBinder` (stateful, Vexa-style)

### 4.1 Constants (epoch **seconds**, shared timebase)

```js
// deepgram-proxy.js
const HINT_LAG_S = 0.25;           // KUNJSe/DOM active-speaker hint ≈ dom-active
const RECENCY_TIE_S = 1.0;         // near-tie → more recent hint wins
const FLICKER_MIN_S = 1.0;         // ignore hint turns shorter than this
const OPEN_TURN_GRACE_S = 4.0;      // open turn decays so new speaker wins
const HINT_SUPPORT_SLACK_S = 0.5;  // slack added when measuring support
const MIN_MATCH_COVERAGE = 0.35;    // hint must cover ≥35% of commit span
const MIN_MATCH_SUPPORT_S = 0.45;   // and ≥0.45s of support to name a turn
const MIN_MATCH_CONFIDENCE = 0.6;   // and ≥0.6 overlap-share confidence
const HINT_LOG_LIMIT = 2000;        // max retained hint turns
```

### 4.2 The binder

```js
class SpeakerBinder {
  constructor() {
    this.turns = [];          // [{ name, tStartSec, tEndSec? }]
    this.firstChunkTs = null; // anchored to first audio chunk (bot epoch sec)
  }

  // Record a speaker-boundary hint from the bot's speaker_event.
  // Lag-correct the timestamp back to the actual audio moment, then close this
  // speaker's previously-open turn and open a fresh one.
  recordHint(speaker, tSec) {
    const t = tSec - HINT_LAG_S;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i];
      if (turn.name === speaker && turn.tEndSec === undefined) {
        turn.tEndSec = t;
        break;
      }
    }
    this.turns.push({ name: speaker, tStartSec: t });
    if (this.turns.length > HINT_LOG_LIMIT) {
      this.turns.splice(0, this.turns.length - HINT_LOG_LIMIT);
    }
  }

  // Resolve a Deepgram result to a speaker name.
  // absoluteStartSec / absoluteEndSec = firstChunkTs + response.start/end
  resolve(absoluteStartSec, absoluteEndSec) {
    if (this.firstChunkTs === null || this.turns.length === 0) {
      return { name: null, confidence: 0 };
    }

    const windowStart = absoluteStartSec;
    const windowEnd = absoluteEndSec;
    const supportStart = absoluteStartSec - HINT_SUPPORT_SLACK_S;
    const supportEnd = absoluteEndSec + HINT_SUPPORT_SLACK_S;
    const commitDur = Math.max(0.001, absoluteEndSec - absoluteStartSec);

    const agg = new Map();   // name -> { ms, supportMs, lastStart }
    let totalSupportSec = 0;

    for (const turn of this.turns) {
      // FLICKER DEBOUNCE: skip closed turns shorter than FLICKER_MIN_S.
      if (turn.tEndSec !== undefined && turn.tEndSec - turn.tStartSec < FLICKER_MIN_S) continue;
      const turnEnd = turn.tEndSec !== undefined ? turn.tEndSec : turn.tStartSec + OPEN_TURN_GRACE_S;

      // OVERLAP-WINDOW MATCH (not point lookup)
      const overlap = Math.max(0, Math.min(turnEnd, windowEnd) - Math.max(turn.tStartSec, windowStart));
      if (overlap <= 0) continue;
      const support = Math.max(0, Math.min(turnEnd, supportEnd) - Math.max(turn.tStartSec, supportStart));
      if (support <= 0) continue;

      totalSupportSec += support;
      const a = agg.get(turn.name) ?? { ms: 0, supportMs: 0, lastStart: -Infinity };
      a.ms += overlap;
      a.supportMs += support;
      a.lastStart = Math.max(a.lastStart, turn.tStartSec);
      agg.set(turn.name, a);
    }

    if (agg.size === 0) return { name: null, confidence: 0 };

    // RECENCY TIE-BREAKER — the core bug fix (inverse of old "prefer upcoming").
    let best = null;
    for (const [name, a] of agg) {
      if (!best) { best = { name, ...a }; continue; }
      if (a.supportMs > best.supportMs + RECENCY_TIE_S) best = { name, ...a };
      else if (a.supportMs >= best.supportMs - RECENCY_TIE_S && a.lastStart > best.lastStart) best = { name, ...a };
    }
    if (!best) return { name: null, confidence: 0 };

    const coverage = Math.min(1, best.supportMs / commitDur);
    const confidence = totalSupportSec > 0 ? best.supportMs / totalSupportSec : 0;
    const requiredSupport = Math.min(MIN_MATCH_SUPPORT_S, commitDur * 0.8);

    // MIN COVERAGE / SUPPORT / CONFIDENCE GATES
    if (best.supportMs < requiredSupport) return { name: null, confidence: 0 };
    if (coverage < MIN_MATCH_COVERAGE) return { name: null, confidence: 0 };
    if (confidence < MIN_MATCH_CONFIDENCE) return { name: null, confidence: 0 };

    return { name: best.name, confidence: Math.min(coverage, confidence) };
  }
}
```

### 4.3 Wiring — anchor, resolve, and emit stable segment IDs

```js
// deepgram-proxy.js — inside initializeSession()
const proxyState = {
  wsConnection: dgSocket,
  binder: new SpeakerBinder(),
  segmentId: 0,
  currentSegment: null,            // { segmentId, isFinal, lastSpeaker }
  lastResolvedSpeaker: null,       // continuity fallback for provisional segments
  keepAliveInterval: null,
  onTranscript,
  onError
};

// On each Deepgram message:
const binder = proxyState.binder;
const absoluteStartSec = binder.firstChunkTs + relativeStart; // both bot epoch sec
const absoluteEndSec   = binder.firstChunkTs + relativeEnd   + endPadSec;

const resolved = binder.resolve(absoluteStartSec, absoluteEndSec);
const resolvedName = resolved.name; // null until confidently matched

// Continuity fallback: inherit last resolved name during brief hint gaps
// instead of emitting a bare "speaker_N".
const speakerName = resolvedName || proxyState.lastResolvedSpeaker;
const provisional = resolvedName === null && proxyState.lastResolvedSpeaker === null;
if (resolvedName) proxyState.lastResolvedSpeaker = resolvedName;

// One stable segmentId per finalized utterance; interim results reuse it.
let seg = proxyState.currentSegment;
if (!seg || seg.isFinal) {
  const segmentId = ++proxyState.segmentId;
  seg = { segmentId, isFinal: false, lastSpeaker: null };
  proxyState.currentSegment = seg;
}
seg.isFinal = isFinal;

const speaker = speakerName || `speaker_${seg.segmentId}`;

onTranscript({
  segmentId: seg.segmentId,   // stable — enables frontend in-place repaint
  speaker,
  provisional,                // true until a confident name resolves
  text: transcript.trim(),
  timestamp: new Date().toISOString(),
  isFinal
});
```

### 4.4 Anchor the timeline to the first audio chunk (critical)

The anchor must be the **first audio chunk's `start_ts`** — bot epoch seconds
at stream start — NOT the first `speaker_event` (which can arrive many seconds
in). Both `firstChunkTs + response.start` and the hint turns then share one
timebase, so they actually overlap.

```js
// server.js — on each audio_chunk from the bot
if (typeof chunk.start_ts === 'number') {
  deepgramProxy.logStreamStart(sessionId, chunk.start_ts);
}

// deepgram-proxy.js
logStreamStart(sessionId, startTsSec) {
  const proxy = this.activeProxies.get(sessionId);
  if (!proxy) return;
  const binder = proxy.binder;
  if (binder.firstChunkTs === null) {
    binder.firstChunkTs = startTsSec; // bot epoch seconds at stream start
  }
}

logSpeakerBoundary(sessionId, { timestamp, speaker }) {
  const proxy = this.activeProxies.get(sessionId);
  if (!proxy) return;
  const binder = proxy.binder;
  if (binder.firstChunkTs === null) binder.firstChunkTs = timestamp; // fallback only
  if (speaker) binder.recordHint(speaker, timestamp);
}
```

### 4.5 Frontend — in-place repaint (self-correction)

The frontend keys blocks by `segmentId` and repaints in place when a
provisional segment later resolves, so a wrong attribution is corrected
without a duplicate block:

```tsx
// meeting/page.tsx — inside the transcript WebSocket handler
setLiveLines(prev => {
  const idx = segmentId != null ? prev.findIndex(l => l.segmentId === segmentId) : -1;
  if (idx !== -1) {
    // Repaint in place: provisional → resolved name mutates the same block
    const updated = [...prev];
    const currentBlock = { ...updated[idx] };
    currentBlock.speaker = speaker;
    currentBlock.provisional = provisional;
    currentBlock.isFinal = isFinal;
    currentBlock.text = text;
    currentBlock.committedText = isFinal ? text : (currentBlock.committedText || "");
    currentBlock.interimText = isFinal ? "" : text;
    updated[idx] = currentBlock;
    return updated;
  }
  // New segment → new block with stable id
  const newBlock: TranscriptLine = {
    segmentId: segmentId ?? prev.length,
    speaker, committedText: isFinal ? text : "",
    interimText: isFinal ? "" : text, text, isFinal, provisional,
    timestamp: new Date().toISOString()
  };
  return [...prev, newBlock];
});
```

---

## 5. Why the OLD "grace period" idea was rejected

A naive `SPEAKER_GRACE_PERIOD_SEC = 2.0` + "prefer previous speaker" would only
*halve* the lag, because it has (a) no per-source lag model, (b) a point lookup
that still mishandles a transcript whose `start` straddles a boundary, and
(c) no self-correction — a single early mistake persists. We adopted Vexa's
stateful binder instead.

---

## 6. Files Changed

| File | Change |
|------|--------|
| `dashboard/backend/deepgram-proxy.js` | Replaced `mapTimeToSpeaker` + `chunkHistory` with stateful `SpeakerBinder`; stable `segmentId` + `provisional` flag; `logStreamStart` anchor. |
| `dashboard/backend/server.js` | Feed audio chunk `start_ts` to `logStreamStart`; removed obsolete `logChunkMetadata` fallback. |
| `dashboard/frontend/src/app/(app)/projects/[projectId]/meeting/page.tsx` | Key blocks by `segmentId`; repaint in place on resolve. |

---

## 7. Verification

1. **Lag measurement (sets `HINT_LAG_S`):** in a test Meet, note the wall-clock
   time the `KUNJSe` tile lights vs. when the corresponding Deepgram final
   arrives. The delta is the real lag (baseline 0.25s — measure live).
2. **Attribution correctness:** A speaks a full sentence, then B responds
   immediately → A's last words stay in A's block (recency tie-break + lag
   correction), B's first words appear in B's own block.
3. **Flicker:** a brief `KUNJSe` blip on a third tile must NOT steal an
   in-progress turn (flicker debounce).
4. **Self-correction:** a provisional attribution repaints in place (no
   duplicate block, no permanent wrong name) when a late hint resolves.
5. **Regression:** long silence → previous speaker's hint decays
   (`OPEN_TURN_GRACE_S`) so the new speaker wins; single speaker talking
   continuously → attribution stays stable (no A→B→A thrash).
