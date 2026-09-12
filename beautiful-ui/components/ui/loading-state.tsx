"use client";

import { useEffect, useState } from "react";

const PHASES = [
  "Preparing response…",
  "Gathering context…",
  "Drafting an answer…",
];

const LINES = [
  { width: "100%", delay: "0ms" },
  { width: "92%", delay: "120ms" },
  { width: "78%", delay: "240ms" },
  { width: "56%", delay: "360ms" },
];

export function LoadingStateDemo() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setPhase((p) => (p + 1) % PHASES.length);
    }, 2200);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="w-full max-w-xl">
      <style>{`
        @keyframes bui-loading-sweep {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes bui-loading-orbit {
          to { transform: rotate(360deg); }
        }
        @keyframes bui-loading-fade {
          from { opacity: 0; transform: translateY(3px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div className="rounded-2xl border border-line bg-field/60 p-5">
        <div className="flex items-center gap-3 mb-5">
          <span className="relative flex h-5 w-5 items-center justify-center">
            <span
              className="absolute inset-0 rounded-full border-2 border-line border-t-accent"
              style={{
                animation: "bui-loading-orbit 900ms linear infinite",
              }}
            />
          </span>
          <p
            key={phase}
            className="font-mono text-xs text-ink-muted"
            style={{
              animation: "bui-loading-fade 400ms var(--ease-out-strong) both",
            }}
          >
            {PHASES[phase]}
          </p>
        </div>

        <div className="space-y-3" aria-hidden="true">
          {LINES.map((line) => (
            <div
              key={line.width}
              className="relative h-3 overflow-hidden rounded-full bg-line/70"
              style={{ width: line.width }}
            >
              <div
                className="absolute inset-y-0 w-full bg-gradient-to-r from-transparent via-surface to-transparent opacity-80"
                style={{
                  animation: `bui-loading-sweep 1600ms ease-in-out ${line.delay} infinite`,
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <p className="mt-4 text-center text-xs text-ink-faint">
        Layout stays put while the model spins up.
      </p>

      <span className="sr-only" role="status">
        Loading response
      </span>
    </div>
  );
}
