# Google Meet Bot — Complete Development Plan

**Scope of this phase:** Get real-time audio out of a Google Meet call, chunked, with each chunk tagged with *who* is speaking. Downstream processing (STT, summarization, storage, search) is explicitly out of scope for this phase — this plan stops at producing a clean, speaker-tagged audio stream that any downstream consumer can plug into.

---

## 1. Motive

Capture live Google Meet audio through an automated bot participant, and attach speaker identity to every segment of audio in real time — without waiting for or depending on any downstream transcription/processing step. The deliverable of this phase is a stream (or sequence) of audio chunks, each one labeled with the speaker's name/ID and a timestamp, ready to be handed to whatever processing layer comes next.

## 2. Why Google Meet is architecturally different

Google does not provide a bot SDK or server-side media API in the way Zoom and Teams do. There are two real paths in, with very different maturity levels:

| Path | Access model | Maturity | Per-speaker audio |
|---|---|---|---|
| **A — Browser automation** | Headless/virtual-display Chrome joins as a guest participant | Mature, unofficial, works today | Not native — must be reconstructed |
| **B — Google Meet Media API** | Official WebRTC-based API, CSRC-tagged virtual audio streams | Developer Preview, access-gated | Native, protocol-level, exact |

**This plan builds Path A as the primary, working system**, and documents Path B as the upgrade path once/if Developer Preview access becomes viable for your use case (currently requires every participant in the meeting to also be enrolled in the preview program, which isn't practical for arbitrary external meetings).

---

## 3. Full architecture (Path A)

```
Meeting URL
   │
   ▼
[Orchestrator] — spins up one isolated bot container per meeting
   │
   ▼
[Headless Chrome, driven by Playwright]
   │
   ├─► Join automation (lobby → name entry → join)
   │
   ├─► Audio capture (MediaStreamTrackProcessor on the mixed WebRTC track)
   │
   └─► Active-speaker DOM watcher (MutationObserver on participant tiles)
              │                                   │
              ▼                                   ▼
      Raw PCM audio frames              Timestamped "who's speaking now" events
              │                                   │
              └────────────┬──────────────────────┘
                            ▼
                 [Chunk + Tag Assembler]
                 (buffers audio, attaches speaker
                  label to each chunk by aligning
                  timestamps)
                            │
                            ▼
                 Speaker-tagged audio chunks
                 (output of this phase — handed
                  off to STT/processing later)
```

---

## 4. Step-by-step development plan

### Step 1 — Environment and bot shell
- Containerize with Docker; one container = one bot = one meeting.
- Install Playwright + Chromium.
- Run under a virtual display (`Xvfb`) rather than pure headless — Meet's WebRTC negotiation and some UI behaviors are more reliable this way.
- Launch flags:
  - `--use-fake-ui-for-media-stream` (auto-accept mic/cam prompts)
  - `--use-fake-device-for-media-stream`
  - `--disable-blink-features=AutomationControlled`
  - A current, realistic `--user-agent`
- Turn the bot's own camera **off** and mic **off** on join — it only needs to *receive* audio, not send any, and this also meaningfully reduces the bot's compute footprint.

### Step 2 — Join automation
- Navigate to the meeting URL.
- Handle both branches: signed-in join vs. "join anonymously as guest" with a display name (e.g. a configurable bot name).
- Click through the pre-join screen (mic/cam toggles off) and submit "Ask to join."
- Poll until the bot is confirmed inside the call (not stuck in a host-approval waiting room).
- Explicitly handle:
  - Waiting-room delay or denial
  - Bot being removed mid-call
  - Meeting ending / host leaving
- Keep all DOM selectors in one config module — this is the piece most likely to need updates when Google changes the Meet UI.

### Step 3 — Audio capture
- Locate the call's `RTCPeerConnection` and its remote audio `MediaStreamTrack` (Meet delivers this as a single mixed/composite stream, not separated per participant, in the browser-automation path).
- Use `MediaStreamTrackProcessor` to read raw `AudioData` frames directly in the page's JS context.
- Stream frames out of the page via `page.exposeFunction` / CDP bindings into the Node.js host process driving the automation.

### Step 4 — Active-speaker signal capture (this is the key step for your requirement)
This is what lets us tag chunks by speaker without needing the official Media API:
- Attach a `MutationObserver` to Meet's participant grid/tile container in the DOM.
- Meet visually marks whichever participant is currently speaking (a highlighted border / speaking indicator on their tile). Detect when this marker moves from one tile to another.
- On each change, read the participant's display name off that tile, and emit a timestamped event: `{ speaker: "Alice", started_at: <timestamp> }`.
- This gives a continuous, real-time "who is talking right now" signal, independent of the audio pipeline, that we can align against the audio timeline.

### Step 5 — Chunk + tag assembly (the core deliverable)
- Buffer incoming raw audio frames into consistent windows (recommend 250–500ms per chunk — small enough to feel real-time, large enough to be a meaningful unit).
- For each chunk, look up which speaker was "active" (from Step 4's event stream) during that chunk's time window, and attach that as the chunk's speaker tag.
- Output one record per chunk, for example:
  ```json
  {
    "chunk_id": "c00123",
    "meeting_id": "abc-defg-hij",
    "start_ts": 1730822401.250,
    "end_ts": 1730822401.500,
    "speaker": "Alice",
    "speaker_confidence": "high",
    "sample_rate": 16000,
    "channels": 1,
    "format": "pcm_s16le",
    "audio_ref": "<inline buffer or pointer to stored chunk>"
  }
  ```
- **Edge case handling built in from the start:**
  - *No one clearly speaking* (silence, background noise): tag as `speaker: null` or `"silence"`.
  - *Speaker changes mid-chunk*: either shrink the chunk boundary to the speaker-change point, or tag the chunk with whichever speaker was active for the majority of the window — pick one rule and apply it consistently.
  - *Overlapping speech* (two people talking at once): Meet's UI typically only highlights one active speaker at a time, so this will under-represent simultaneous talkers in v1. Flag this as a known limitation (see Step 6).

### Step 6 — Optional accuracy upgrade: diarization on top
The DOM-signal approach above is lightweight and requires no ML, but it inherits Meet's own single-active-speaker UI limitation. If overlapping speech turns out to matter for your use case, add a diarization pass (e.g. pyannote) on the mixed audio to detect distinct voice segments independently, then use the DOM name signal only to *label* each diarized segment rather than to *detect* segment boundaries. This is a strict upgrade, not a replacement — plan it as a v2 addition once v1 (DOM-only tagging) is validated.

### Step 7 — Output interface
- Since downstream processing is deliberately out of scope for now, expose the speaker-tagged chunks through a simple, swappable interface rather than hardcoding a consumer:
  - A local queue/callback (`onChunk(chunk)`) for in-process consumption, and/or
  - A WebSocket emit per chunk for a networked consumer, and/or
  - Write-to-disk/object storage with a manifest file, if batch-style post-processing is preferred.
- Whichever you pick, keep the chunk schema (Step 5) as the stable contract — that's what lets you swap in STT, storage, or analytics later without touching the capture pipeline.

### Step 8 — Bot lifecycle
- Orchestrator tracks state: `joining → in_call → capturing → left/ended → cleaned_up`.
- On meeting end or bot removal: flush any partially-filled chunk, emit a final "session ended" marker, close all connections, tear down the container.
- On unexpected disconnect: decide policy — auto-rejoin once, or fail and alert; don't loop indefinitely.

---

## 5. Tech stack

| Layer | Choice |
|---|---|
| Browser automation | Playwright + Chromium |
| Display | Xvfb virtual display |
| Runtime | Node.js (automation driver, audio relay, chunk assembly) |
| Containerization | Docker, one instance per meeting |
| Audio capture | `MediaStreamTrackProcessor` (WebRTC, in-page) |
| Speaker signal | `MutationObserver` on Meet's DOM (in-page) |
| Optional diarization (v2) | pyannote or equivalent speaker-embedding model |
| Chunk output | WebSocket emit / local callback / object storage — pick per integration need |

## 6. Infrastructure sizing (avoiding the latency/jitter trap)

Covered in detail earlier, restated as build requirements:
- Disable video rendering entirely — audio-only, camera off, don't render remote tiles.
- Give each bot container real, non-oversubscribed CPU — headless Chrome is heavier than a native SDK client and under-provisioning shows up as dropped frames/jitter, not just slowness.
- Keep chunk windows in the 250–500ms range: small enough for "live" feel, large enough to avoid excessive per-chunk overhead.
- Monitor buffer underruns/dropped-frame counts specifically, as the leading indicator of resource starvation before it's audible.

## 7. Known limitations of this plan (be upfront about these)

| Limitation | Cause | Mitigation |
|---|---|---|
| No true overlapping-speech separation | Meet UI highlights one active speaker at a time | Add diarization pass (Step 6) if this matters for your use case |
| Speaker tagging depends on Meet's DOM structure | Unofficial integration path | Centralize selectors, add a daily automated join-test to catch breakage early |
| Bot detection / automation fingerprinting risk | Real browser being automated | Stealth launch flags, avoid pure headless mode |
| Heavier compute per bot than native SDKs | Full browser vs. lightweight client | Camera off, tight container sizing, monitor CPU headroom |
| No official support path | No Meet bot SDK exists | Media API (Path B) is the long-term fix once access opens up |

## 8. Rollout plan

1. **Spike**: single bot, one test meeting, console-log both the raw audio stream and the DOM speaker-change events separately — confirm both work in isolation before combining them.
2. **Chunk assembly**: build the Step 5 logic that aligns speaker events to audio time windows; validate against a scripted test call with 2–3 people taking turns speaking.
3. **Edge cases**: test silence handling, speaker-change-mid-chunk, and a deliberate overlapping-speech scenario to see how badly v1 mishandles it.
4. **Lifecycle hardening**: waiting room, bot removal, meeting-end handling, reconnect policy.
5. **Output interface**: wire chunks to whatever your first real consumer is (even just writing to disk for a manual STT test).
6. **Load test**: run several concurrent bots, confirm no CPU-starvation-driven jitter under realistic concurrency.
7. **(Later) v2**: layer in diarization for overlapping speech, and evaluate Media API (Path B) access if it becomes practical.

## 9. Open questions to lock down before coding starts

- Chunk size: is 250–500ms the right window, or does your downstream STT choice prefer a different granularity (e.g. STT-driven utterance boundaries instead of fixed windows)?
- Silence chunks: emit them (tagged `null`), or drop them entirely and only emit chunks with an identified speaker?
- Output transport: WebSocket push, local callback, or disk-based — which fits your actual next consumer?
- Bot visibility: does it need to appear as a named participant in the call, or should it be as invisible as Meet allows?
- Acceptable tolerance for the "one active speaker at a time" limitation in v1 — is that fine to ship, or is overlapping-speech handling a launch blocker?
