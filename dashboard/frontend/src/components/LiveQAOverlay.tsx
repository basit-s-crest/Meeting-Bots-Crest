"use client";

import React, { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/cn";
import { Sparkles, Send, MessageSquare, Loader2, AlertCircle, MapPin } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

export interface Citation {
  lineId: string;
  speaker: string;
  timestamp: string;
}

export interface QAPair {
  id: string;
  question: string;
  answer: string;
  isStreaming: boolean;
  error?: string;
  timestamp?: string;
  citations?: Citation[];
}

interface LiveQAOverlayProps {
  qaHistory: QAPair[];
  onSendQuestion: (question: string) => void;
  onCitationClick?: (lineId: string) => void;
  disabled?: boolean;
  className?: string;
}

export function LiveQAOverlay({
  qaHistory,
  onSendQuestion,
  onCitationClick,
  disabled = false,
  className,
}: LiveQAOverlayProps) {
  const [questionInput, setQuestionInput] = useState("");
  const qaEndRef = useRef<HTMLDivElement | null>(null);

  // Check if any question is currently streaming an answer
  const isQuestionInFlight = qaHistory.some((item) => item.isStreaming);
  const isInputDisabled = disabled || isQuestionInFlight;

  // Auto-scroll to bottom of Q&A list on updates
  useEffect(() => {
    if (qaEndRef.current) {
      qaEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [qaHistory]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!questionInput.trim() || isInputDisabled) return;
    onSendQuestion(questionInput.trim());
    setQuestionInput("");
  };

  return (
    <Card className={cn("flex flex-col p-6 shadow-sm border border-border bg-surface", className)}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-ink">
          <Sparkles className="h-5 w-5 text-brand-600" />
          Live Q&A
        </h3>
        <span className="text-xs text-ink-mute">
          Grounded in live transcript
        </span>
      </div>

      {/* Q&A Conversation History */}
      <div className="mb-4 flex-1 min-h-[160px] space-y-4 overflow-y-auto pr-1">
        {qaHistory.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center border border-dashed border-border rounded-xl bg-surface-2/30">
            <MessageSquare className="h-8 w-8 text-ink-faint" />
            <p className="text-sm font-medium text-ink-mute">
              Ask any question about what has been discussed so far.
            </p>
            <p className="text-xs text-ink-faint">
              Answers are generated in real-time from the live speech stream.
            </p>
          </div>
        ) : (
          qaHistory.map((item) => (
            <div
              key={item.id}
              className="space-y-2 rounded-xl border border-border bg-surface-2/40 p-4 transition-all duration-200"
            >
              {/* Question */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 rounded bg-brand-100 px-2 py-0.5 text-xs font-bold text-brand-700">
                    Q
                  </span>
                  <p className="text-sm font-semibold text-ink">
                    {item.question}
                  </p>
                </div>
                {item.timestamp && (
                  <span className="text-[10px] text-ink-faint">
                    {item.timestamp}
                  </span>
                )}
              </div>

              {/* Answer / Error */}
              <div className="pl-7">
                {item.error ? (
                  <div className="flex items-center gap-2 text-xs text-danger font-medium">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{item.error}</span>
                  </div>
                ) : (
                  <div>
                    <div className="text-sm leading-relaxed text-ink-soft">
                      {item.answer ? (
                        <span>{item.answer}</span>
                      ) : item.isStreaming ? (
                        <span className="text-xs italic text-ink-mute flex items-center gap-1.5">
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-600" />
                          Analyzing transcript...
                        </span>
                      ) : null}

                      {item.isStreaming && item.answer && (
                        <span className="inline-block w-1.5 h-4 ml-1 bg-brand-600 animate-pulse align-middle" />
                      )}
                    </div>

                    {/* Citation Chips */}
                    {item.citations && item.citations.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pt-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-mute">
                          Sources:
                        </span>
                        {item.citations.map((cite, cIdx) => (
                          <button
                            key={`${cite.lineId}-${cIdx}`}
                            type="button"
                            onClick={() => onCitationClick?.(cite.lineId)}
                            className="inline-flex items-center gap-1.5 rounded-md border border-brand-200 bg-brand-50/80 px-2 py-0.5 text-xs font-semibold text-brand-700 hover:bg-brand-100 hover:border-brand-300 transition-all cursor-pointer shadow-2xs"
                            title={`Jump to line by ${cite.speaker} at ${cite.timestamp}`}
                          >
                            <MapPin className="h-3 w-3 text-brand-600" />
                            <span>{cite.speaker} ({cite.timestamp})</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        <div ref={qaEndRef} />
      </div>

      {/* Question Input Form */}
      <form onSubmit={handleSubmit} className="mt-auto flex gap-2">
        <input
          type="text"
          value={questionInput}
          onChange={(e) => setQuestionInput(e.target.value)}
          placeholder={
            disabled
              ? "Start a bot session to ask questions..."
              : isQuestionInFlight
              ? "Streaming answer..."
              : "Ask a question about the meeting context..."
          }
          disabled={isInputDisabled}
          className="flex-1 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button
          type="submit"
          disabled={isInputDisabled || !questionInput.trim()}
          variant="primary"
          size="md"
        >
          {isQuestionInFlight ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          <span>Ask</span>
        </Button>
      </form>
    </Card>
  );
}
