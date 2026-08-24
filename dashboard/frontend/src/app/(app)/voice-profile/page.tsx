"use client";

import { useState, useEffect, useRef } from "react";
import {
  Mic,
  MicOff,
  Volume2,
  Sparkles,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  Play,
  Square,
  Plus,
  Trash2,
  Cpu,
  Fingerprint,
  Radio,
  Loader2,
  Info,
  Check
} from "lucide-react";
import { Container } from "@/components/ui/Container";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { apiFetch, BACKEND_URL, useAuth } from "@/context/AuthContext";

const SAMPLE_PROMPTS = [
  {
    id: "standard",
    title: "Standard Calibration (Recommended)",
    duration: "~15s",
    text: "Welcome to Crest Meeting Intelligence. I am calibrating my voice profile today so the meeting bot can accurately recognize my speech, summarize my contributions, and assign all my action items directly to my dashboard."
  },
  {
    id: "business",
    title: "Project & Task Focused",
    duration: "~12s",
    text: "I will take responsibility for reviewing the project milestones, coordinating with engineering, and delivering the finalized quarterly roadmap ahead of our sprint deadline."
  },
  {
    id: "technical",
    title: "Engineering & Architecture",
    duration: "~15s",
    text: "The distributed memory service uses high-dimensional vector embeddings to index transcription events in real time, ensuring deterministic speaker resolution across all audio channels."
  }
];

interface ProfileData {
  enrolled: boolean;
  profile: {
    avgRms: number;
    rmsStddev: number;
    sampleCount: number;
    lastUpdated: string;
    embeddingDimensions: number;
  } | null;
  fingerprints: Array<{
    id: string;
    display_name: string;
    display_name_normalized: string;
    last_seen_at?: string;
  }>;
}

export default function VoiceProfilePage() {
  const { user } = useAuth();

  // Profile status
  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);

  // Selected reading prompt
  const [selectedPromptId, setSelectedPromptId] = useState("standard");
  const currentPrompt = SAMPLE_PROMPTS.find(p => p.id === selectedPromptId) || SAMPLE_PROMPTS[0];

  // Calibration Recording State
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioSamples, setAudioSamples] = useState<number[]>([]);
  const [savingEnrollment, setSavingEnrollment] = useState(false);
  const [enrollSuccess, setEnrollSuccess] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);

  // Live Visualizer
  const [audioLevel, setAudioLevel] = useState(0);
  const [frequencyData, setFrequencyData] = useState<number[]>(new Array(24).fill(10));
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const capturedSamplesRef = useRef<number[]>([]);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Testing Studio State
  const [isTesting, setIsTesting] = useState(false);
  const [testSeconds, setTestSeconds] = useState(0);
  const [testResult, setTestResult] = useState<{
    tested: boolean;
    matched: boolean;
    confidence: number;
    percentage: number;
    message?: string;
  } | null>(null);
  const [evaluatingTest, setEvaluatingTest] = useState(false);
  const testTimerRef = useRef<NodeJS.Timeout | null>(null);
  const testSamplesRef = useRef<number[]>([]);

  // Alias Management State
  const [newAlias, setNewAlias] = useState("");
  const [addingAlias, setAddingAlias] = useState(false);

  // Fetch Voice Profile on Mount
  const fetchProfile = async () => {
    try {
      setLoadingProfile(true);
      const res = await apiFetch(`${BACKEND_URL}/api/voice/profile`);
      if (res.ok) {
        const data = await res.json();
        setProfileData(data);
      }
    } catch (err) {
      console.error("Failed to fetch voice profile:", err);
    } finally {
      setLoadingProfile(false);
    }
  };

  useEffect(() => {
    fetchProfile();
  }, []);

  // Cleanup Web Audio & streams on unmount
  useEffect(() => {
    return () => {
      stopAudioStreams();
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const stopAudioStreams = () => {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    if (testTimerRef.current) clearInterval(testTimerRef.current);

    if (scriptProcessorRef.current) {
      try {
        scriptProcessorRef.current.disconnect();
      } catch {}
      scriptProcessorRef.current = null;
    }

    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {}
      analyserRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      try {
        audioContextRef.current.close();
      } catch {}
      audioContextRef.current = null;
    }
  };

  // Resample float buffer to 16kHz mono
  const downsampleTo16k = (audioBuffer: Float32Array, sampleRate: number): number[] => {
    if (sampleRate === 16000) {
      return Array.from(audioBuffer).map((v) => Math.round(v * 10000) / 10000);
    }
    const ratio = sampleRate / 16000;
    const newLength = Math.round(audioBuffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < audioBuffer.length; i++) {
        accum += audioBuffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : audioBuffer[offsetBuffer] || 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return Array.from(result).map((v) => Math.round(v * 10000) / 10000);
  };

  // Convert raw Float32 samples to playable WAV Blob
  const createWavBlob = (samples: number[], sampleRate: number): Blob => {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return new Blob([view], { type: "audio/wav" });
  };

  // Start Calibration Recording
  const startRecording = async () => {
    setEnrollError(null);
    setEnrollSuccess(false);
    setAudioBlob(null);
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    setAudioSamples([]);
    capturedSamplesRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      mediaStreamRef.current = stream;

      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioContextClass();
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyserRef.current = analyser;

      // Script processor to capture PCM samples
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        for (let i = 0; i < inputData.length; i++) {
          capturedSamplesRef.current.push(inputData[i]);
        }
      };

      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(audioCtx.destination);

      // Visualizer loop
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateVisualizer = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        const bars: number[] = [];
        const step = Math.floor(dataArray.length / 24);
        for (let i = 0; i < 24; i++) {
          const val = dataArray[i * step] || 0;
          sum += val;
          bars.push(Math.max(8, Math.min(100, Math.round((val / 255) * 100))));
        }
        setFrequencyData(bars);
        setAudioLevel(Math.min(100, Math.round((sum / (dataArray.length * 255)) * 100 * 1.5)));

        animationFrameRef.current = requestAnimationFrame(updateVisualizer);
      };
      updateVisualizer();

      setIsRecording(true);
      setRecordingSeconds(0);
      timerIntervalRef.current = setInterval(() => {
        setRecordingSeconds((prev) => {
          if (prev >= 25) {
            stopRecording();
            return prev;
          }
          return prev + 1;
        });
      }, 1000);
    } catch (err: any) {
      console.error("Microphone access failed:", err);
      setEnrollError(err.message || "Failed to access microphone. Please check browser permissions.");
    }
  };

  // Stop Calibration Recording
  const stopRecording = () => {
    if (!isRecording) return;
    setIsRecording(false);
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    setFrequencyData(new Array(24).fill(10));
    setAudioLevel(0);

    const rawSamples = capturedSamplesRef.current;
    const currentCtx = audioContextRef.current;
    const sampleRate = currentCtx ? currentCtx.sampleRate : 44100;

    stopAudioStreams();

    if (rawSamples.length < sampleRate * 3) {
      setEnrollError("Recording was too short. Please read for at least 5–10 seconds for an accurate profile.");
      return;
    }

    // Downsample to 16kHz for SpeechBrain ECAPA-TDNN model
    const samples16k = downsampleTo16k(new Float32Array(rawSamples), sampleRate);
    setAudioSamples(samples16k);

    const blob = createWavBlob(samples16k, 16000);
    setAudioBlob(blob);
    setAudioUrl(URL.createObjectURL(blob));
  };

  // Submit Enrollment
  const handleSaveProfile = async () => {
    if (audioSamples.length === 0) return;
    setSavingEnrollment(true);
    setEnrollError(null);

    try {
      const res = await apiFetch(`${BACKEND_URL}/api/voice/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          samples: audioSamples,
          sampleRate: 16000,
          displayName: user?.name
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to calibrate voice profile.");
      }

      setEnrollSuccess(true);
      await fetchProfile();
    } catch (err: any) {
      setEnrollError(err.message || "Voice enrollment failed.");
    } finally {
      setSavingEnrollment(false);
    }
  };

  // Start Live Voice Test
  const startTesting = async () => {
    setTestResult(null);
    testSamplesRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      mediaStreamRef.current = stream;

      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioContextClass();
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        for (let i = 0; i < inputData.length; i++) {
          testSamplesRef.current.push(inputData[i]);
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      setIsTesting(true);
      setTestSeconds(0);

      testTimerRef.current = setInterval(() => {
        setTestSeconds((prev) => {
          if (prev >= 6) {
            stopTestingAndEvaluate();
            return prev;
          }
          return prev + 1;
        });
      }, 1000);
    } catch (err: any) {
      setTestResult({
        tested: true,
        matched: false,
        confidence: 0,
        percentage: 0,
        message: err.message || "Could not access microphone for test."
      });
    }
  };

  // Stop & Evaluate Voice Test
  const stopTestingAndEvaluate = async () => {
    if (testTimerRef.current) clearInterval(testTimerRef.current);
    setIsTesting(false);

    const rawSamples = testSamplesRef.current;
    const currentCtx = audioContextRef.current;
    const sampleRate = currentCtx ? currentCtx.sampleRate : 44100;

    stopAudioStreams();

    if (rawSamples.length < 8000) {
      setTestResult({
        tested: true,
        matched: false,
        confidence: 0,
        percentage: 0,
        message: "Audio clip was too short. Speak a full sentence to test."
      });
      return;
    }

    setEvaluatingTest(true);
    try {
      const samples16k = downsampleTo16k(new Float32Array(rawSamples), sampleRate);
      const res = await apiFetch(`${BACKEND_URL}/api/voice/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          samples: samples16k,
          sampleRate: 16000
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Evaluation failed.");
      }

      const resultData = await res.json();
      setTestResult({
        tested: true,
        matched: resultData.matched,
        confidence: resultData.confidence,
        percentage: resultData.percentage,
        message: resultData.message
      });
    } catch (err: any) {
      setTestResult({
        tested: true,
        matched: false,
        confidence: 0,
        percentage: 0,
        message: err.message || "Voice comparison failed."
      });
    } finally {
      setEvaluatingTest(false);
    }
  };

  // Reset Voice Profile
  const handleResetProfile = async () => {
    if (!confirm("Are you sure you want to clear your biometric voice profile? You will need to re-calibrate.")) return;
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/voice/profile`, { method: "DELETE" });
      if (res.ok) {
        setProfileData(null);
        setAudioBlob(null);
        setAudioUrl(null);
        setAudioSamples([]);
        setEnrollSuccess(false);
        setTestResult(null);
        await fetchProfile();
      }
    } catch (err) {
      console.error("Failed to reset voice profile:", err);
    }
  };

  // Add Alias
  const handleAddAlias = async () => {
    if (!newAlias.trim()) return;
    setAddingAlias(true);
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/voice/aliases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: newAlias.trim() })
      });
      if (res.ok) {
        setNewAlias("");
        await fetchProfile();
      }
    } catch (err) {
      console.error("Failed to add alias:", err);
    } finally {
      setAddingAlias(false);
    }
  };

  // Delete Alias
  const handleDeleteAlias = async (id: string) => {
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/voice/aliases/${id}`, { method: "DELETE" });
      if (res.ok) {
        await fetchProfile();
      }
    } catch (err) {
      console.error("Failed to delete alias:", err);
    }
  };

  return (
    <Container className="max-w-[1280px] py-8 px-4 sm:px-6 lg:px-8 space-y-8">
      {/* Header Banner */}
      <div className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-brand-600">
              <Fingerprint className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-ink">Voice Profile & Biometric ID</h1>
              <p className="text-sm text-ink-mute">
                Calibrate your voice once so Crest automatically recognizes you in meetings and assigns action items to your dashboard.
              </p>
            </div>
          </div>
        </div>

        {/* Live Status Badge Card */}
        <div className="flex items-center gap-3">
          {loadingProfile ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-surface text-xs text-ink-mute">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Checking profile...</span>
            </div>
          ) : profileData?.enrolled ? (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl border border-success/30 bg-success/10 text-success text-xs font-semibold">
                <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
                <span>Voice Profile Active (192D)</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetProfile}
                className="text-xs text-danger hover:bg-danger/10 hover:text-danger"
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1" />
                Reset
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl border border-warning/30 bg-warning/10 text-warning text-xs font-semibold">
              <span className="w-2 h-2 rounded-full bg-warning" />
              <span>Calibration Needed</span>
            </div>
          )}
        </div>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5 border-border bg-surface space-y-2">
          <div className="flex items-center justify-between text-xs text-ink-mute font-medium">
            <span>Neural Embedding Engine</span>
            <Cpu className="w-4 h-4 text-brand-500" />
          </div>
          <div className="text-lg font-bold text-ink">SpeechBrain ECAPA-TDNN</div>
          <p className="text-xs text-ink-soft">
            Extracts deep 192-dimensional d-vectors invariant to acoustic & microphone shifts.
          </p>
        </Card>

        <Card className="p-5 border-border bg-surface space-y-2">
          <div className="flex items-center justify-between text-xs text-ink-mute font-medium">
            <span>Biometric Resolution</span>
            <ShieldCheck className="w-4 h-4 text-success" />
          </div>
          <div className="text-lg font-bold text-ink">
            {profileData?.enrolled ? "Cosine Similarity (0.80+ Threshold)" : "Not Enrolled"}
          </div>
          <p className="text-xs text-ink-soft">
            Matches real-time meeting utterances against your unique stored vocal geometry.
          </p>
        </Card>

        <Card className="p-5 border-border bg-surface space-y-2">
          <div className="flex items-center justify-between text-xs text-ink-mute font-medium">
            <span>Last Calibration</span>
            <Radio className="w-4 h-4 text-brand-500" />
          </div>
          <div className="text-lg font-bold text-ink">
            {profileData?.profile?.lastUpdated
              ? new Date(profileData.profile.lastUpdated).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric"
                })
              : "Never"}
          </div>
          <p className="text-xs text-ink-soft">
            {profileData?.profile?.sampleCount
              ? `Calibrated from ${(profileData.profile.sampleCount / 16000).toFixed(1)}s sample`
              : "Read the prompt below to enroll."}
          </p>
        </Card>
      </div>

      {/* Main Studio Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column: Calibration Studio (8 cols) */}
        <div className="lg:col-span-8 space-y-6">
          <Card className="p-6 border-border bg-surface shadow-sm space-y-6">
            <div className="flex items-center justify-between border-b border-border pb-4">
              <div>
                <h2 className="text-lg font-semibold text-ink flex items-center gap-2">
                  <Mic className="w-5 h-5 text-brand-500" />
                  Voice Enrollment Studio
                </h2>
                <p className="text-xs text-ink-mute">
                  Select a passage and read it aloud naturally. 10 to 15 seconds is optimal.
                </p>
              </div>

              {/* Prompt selection pills */}
              <div className="flex items-center gap-1.5 bg-surface-2 p-1 rounded-lg border border-border">
                {SAMPLE_PROMPTS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedPromptId(p.id)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-md transition ${
                      selectedPromptId === p.id
                        ? "bg-white dark:bg-surface text-ink shadow-sm"
                        : "text-ink-mute hover:text-ink"
                    }`}
                  >
                    {p.title.split(" ")[0]}
                  </button>
                ))}
              </div>
            </div>

            {/* Prompt Reading Card */}
            <div className="p-5 rounded-2xl bg-surface-2/70 border border-border/80 relative overflow-hidden group">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-brand-600 uppercase tracking-wider">
                  {currentPrompt.title}
                </span>
                <span className="text-xs text-ink-mute font-medium">{currentPrompt.duration}</span>
              </div>
              <p className="text-base text-ink leading-relaxed font-medium">
                "{currentPrompt.text}"
              </p>
            </div>

            {/* Live Audio Visualizer & Waveform */}
            <div className="p-5 rounded-2xl border border-border bg-surface-2/40 flex flex-col items-center justify-center gap-4">
              {/* Dynamic Waveform Bars */}
              <div className="flex items-center justify-center gap-1.5 h-16 w-full max-w-md">
                {frequencyData.map((height, i) => (
                  <div
                    key={i}
                    style={{ height: `${isRecording ? height : 8}%` }}
                    className={`w-2.5 rounded-full transition-all duration-75 ${
                      isRecording
                        ? "bg-brand-500 shadow-sm shadow-brand-500/30"
                        : "bg-border-strong/60"
                    }`}
                  />
                ))}
              </div>

              {/* Status / Timer Indicator */}
              <div className="flex items-center gap-3">
                {isRecording ? (
                  <div className="flex items-center gap-2 text-danger font-semibold text-sm">
                    <span className="w-2.5 h-2.5 rounded-full bg-danger animate-ping" />
                    <span>Recording: {recordingSeconds}s / 25s max</span>
                  </div>
                ) : audioBlob ? (
                  <div className="flex items-center gap-2 text-success font-semibold text-sm">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Sample captured ({(audioSamples.length / 16000).toFixed(1)}s audio)</span>
                  </div>
                ) : (
                  <div className="text-xs text-ink-mute">
                    Click Start Recording and read the text aloud
                  </div>
                )}
              </div>

              {/* Playback preview if recorded */}
              {audioUrl && !isRecording && (
                <div className="w-full max-w-sm mt-2 flex items-center justify-center">
                  <audio src={audioUrl} controls className="w-full h-9 rounded-lg" />
                </div>
              )}
            </div>

            {/* Error / Success Notifications */}
            {enrollError && (
              <div className="flex items-center gap-2 p-3.5 rounded-xl bg-danger/10 border border-danger/20 text-danger text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{enrollError}</span>
              </div>
            )}

            {enrollSuccess && (
              <div className="flex items-center gap-2 p-3.5 rounded-xl bg-success/10 border border-success/20 text-success text-sm">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>Voice profile calibrated successfully! SpeechBrain 192D signature saved.</span>
              </div>
            )}

            {/* Actions Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-2">
                {!isRecording ? (
                  <Button
                    variant="primary"
                    onClick={startRecording}
                    className="gap-2 bg-brand-600 hover:bg-brand-700 text-white shadow-md"
                  >
                    <Mic className="w-4 h-4" />
                    {audioBlob ? "Re-record Voice" : "Start Calibration Recording"}
                  </Button>
                ) : (
                  <Button
                    variant="danger"
                    onClick={stopRecording}
                    className="gap-2 shadow-md animate-pulse"
                  >
                    <Square className="w-4 h-4" />
                    Finish Recording ({recordingSeconds}s)
                  </Button>
                )}

                {audioBlob && !isRecording && (
                  <Button
                    variant="ghost"
                    size="md"
                    onClick={() => {
                      setAudioBlob(null);
                      if (audioUrl) URL.revokeObjectURL(audioUrl);
                      setAudioUrl(null);
                      setAudioSamples([]);
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>

              {audioBlob && !isRecording && (
                <Button
                  variant="primary"
                  onClick={handleSaveProfile}
                  disabled={savingEnrollment}
                  className="gap-2 bg-success hover:bg-success/90 text-white"
                >
                  {savingEnrollment ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Computing 192D Vector...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      Save & Enroll Voice Profile
                    </>
                  )}
                </Button>
              )}
            </div>
          </Card>

          {/* How It Works Card */}
          <Card className="p-6 border-border bg-surface shadow-sm space-y-4">
            <h3 className="text-sm font-bold text-ink flex items-center gap-2">
              <Info className="w-4 h-4 text-brand-500" />
              How Biometric Voice Attribution Works
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-ink-mute">
              <div className="space-y-1.5 p-3 rounded-xl bg-surface-2/60 border border-border">
                <span className="font-bold text-ink">1. Clean Enrollment</span>
                <p>Reading the phonetically balanced text builds a pristine 192D mathematical voice signature.</p>
              </div>
              <div className="space-y-1.5 p-3 rounded-xl bg-surface-2/60 border border-border">
                <span className="font-bold text-ink">2. Live Meeting Match</span>
                <p>During calls, each audio segment is biometrically compared to stored team voice vectors.</p>
              </div>
              <div className="space-y-1.5 p-3 rounded-xl bg-surface-2/60 border border-border">
                <span className="font-bold text-ink">3. Auto Task Assignment</span>
                <p>Spoken commitments like "I will finalize the deck" are instantly routed to your tasks.</p>
              </div>
            </div>
          </Card>
        </div>

        {/* Right Column: Testing & Display Names (4 cols) */}
        <div className="lg:col-span-4 space-y-6">
          {/* Live Voice Match Tester */}
          <Card className="p-6 border-border bg-surface shadow-sm space-y-5">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-ink flex items-center gap-2">
                <Radio className="w-4 h-4 text-brand-500" />
                Live Recognition Test
              </h2>
              <p className="text-xs text-ink-mute">
                Speak a random sentence to verify your biometric match confidence.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-surface-2/50 border border-border flex flex-col items-center justify-center gap-3 text-center">
              {evaluatingTest ? (
                <div className="py-4 flex flex-col items-center gap-2">
                  <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
                  <span className="text-xs text-ink-mute font-medium">Matching against 192D vector...</span>
                </div>
              ) : testResult ? (
                <div className="py-2 space-y-2 w-full">
                  <div className="flex items-center justify-center gap-2">
                    {testResult.matched ? (
                      <Badge tone="success" className="px-3 py-1 text-sm gap-1.5">
                        <CheckCircle2 className="w-4 h-4" />
                        Match Verified ({testResult.percentage}%)
                      </Badge>
                    ) : (
                      <Badge tone="danger" className="px-3 py-1 text-sm gap-1.5">
                        <AlertCircle className="w-4 h-4" />
                        Low Match ({testResult.percentage}%)
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-ink-soft">
                    {testResult.matched
                      ? "High biometric confidence. The meeting bot will reliably recognize your voice."
                      : testResult.message || "Confidence fell below threshold. Try re-recording calibration."}
                  </p>
                </div>
              ) : (
                <div className="py-4 text-xs text-ink-mute">
                  {profileData?.enrolled
                    ? "Click 'Test Voice' and say anything for 3-5 seconds."
                    : "Complete calibration first to test recognition."}
                </div>
              )}

              {/* Action Button */}
              {!isTesting ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={startTesting}
                  disabled={!profileData?.enrolled || evaluatingTest}
                  className="w-full gap-2 text-xs font-semibold"
                >
                  <Mic className="w-3.5 h-3.5" />
                  Test Voice Recognition
                </Button>
              ) : (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={stopTestingAndEvaluate}
                  className="w-full gap-2 text-xs font-semibold animate-pulse"
                >
                  <Square className="w-3.5 h-3.5" />
                  Stop & Evaluate ({testSeconds}s / 6s)
                </Button>
              )}
            </div>
          </Card>

          {/* Meeting Aliases Card */}
          <Card className="p-6 border-border bg-surface shadow-sm space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-ink flex items-center gap-2">
                <Fingerprint className="w-4 h-4 text-brand-500" />
                Meeting Aliases & Names
              </h2>
              <p className="text-xs text-ink-mute">
                Aliases linked to your account when joining Meet or Zoom calls.
              </p>
            </div>

            {/* Alias List */}
            <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
              {profileData?.fingerprints && profileData.fingerprints.length > 0 ? (
                profileData.fingerprints.map((fp) => (
                  <div
                    key={fp.id}
                    className="flex items-center justify-between p-2.5 rounded-lg border border-border bg-surface-2/40 text-xs text-ink"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{fp.display_name}</span>
                      <span className="text-[10px] text-ink-mute">({fp.display_name_normalized})</span>
                    </div>
                    <button
                      onClick={() => handleDeleteAlias(fp.id)}
                      className="p-1 rounded text-ink-mute hover:text-danger hover:bg-surface transition"
                      title="Remove alias"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              ) : (
                <div className="text-xs text-ink-mute italic p-2 text-center">
                  No aliases registered yet.
                </div>
              )}
            </div>

            {/* Add Alias Input */}
            <div className="flex items-center gap-2 pt-2 border-t border-border">
              <input
                type="text"
                value={newAlias}
                onChange={(e) => setNewAlias(e.target.value)}
                placeholder="e.g. Basit Sachinwala"
                className="flex-1 px-3 py-1.5 rounded-lg border border-border bg-surface text-ink text-xs focus:outline-none focus:border-brand-500"
                onKeyDown={(e) => e.key === "Enter" && handleAddAlias()}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleAddAlias}
                disabled={addingAlias || !newAlias.trim()}
                className="text-xs px-2.5 py-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </Container>
  );
}
