"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const RESPONSE =
  "Streaming keeps the wait honest. Instead of a blank panel and a spinner, the answer arrives at reading speed — a few words at a time, with a cursor marking where the model is right now. Pace matters more than raw speed: too fast and the text jitters, too slow and it feels stuck. This one lands around eighteen words a second — quick enough to feel alive, slow enough to read along with.";

const WORD_MS = 55;

export function StreamingTextDemo() {
  const words = useMemo(() => RESPONSE.split(" "), []);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (count >= words.length) return;
    const id = setTimeout(() => setCount((c) => c + 1), WORD_MS);
    return () => clearTimeout(id);
  }, [count, words.length]);

  const replay = useCallback(() => setCount(0), []);

  const streaming = count < words.length;
  const text = words.slice(0, count).join(" ");

  return (
    <div className="w-full max-w-xl">
      <style>{`
        @keyframes bui-stream-caret {
          0%, 45% { opacity: 1; }
          55%, 100% { opacity: 0.15; }
        }
        @keyframes bui-stream-dot {
          0%, 100% { opacity: 0.35; }
          50% { opacity: 1; }
        }
      `}</style>

      <div className="rounded-2xl border border-line bg-field/50 p-5">
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-tint">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
            assistant
          </span>
          {streaming && (
            <span
              className="font-mono text-[11px] text-accent"
              style={{ animation: "bui-stream-dot 1200ms ease-in-out infinite" }}
            >
              streaming
            </span>
          )}
        </div>

        <p
          className="min-h-32 text-[15px] leading-relaxed text-ink"
          aria-live="polite"
        >
          {text}
          {streaming && (
            <span
              className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.18em] rounded-full bg-accent align-baseline"
              style={{
                animation: "bui-stream-caret 1000ms steps(1, end) infinite",
              }}
              aria-hidden="true"
            />
          )}
        </p>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="font-mono text-[11px] text-ink-faint">
          {count} / {words.length} words
        </span>
        <button
          type="button"
          onClick={replay}
          disabled={streaming}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-muted"
        >
          <svg
            viewBox="0 0 16 16"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M13 8a5 5 0 1 1-1.6-3.7" />
            <path d="M13 2v3h-3" />
          </svg>
          Replay
        </button>
      </div>
    </div>
  );
}
