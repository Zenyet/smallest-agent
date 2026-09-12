"use client";

import { useEffect, useState } from "react";

type Step = {
  label: string;
  detail: string;
};

const STEPS: Step[] = [
  {
    label: "Reading the request",
    detail: "User wants last quarter's refund totals broken out by region.",
  },
  {
    label: "Checking available data",
    detail: "Found two tables: orders_2026 and refunds_ledger. Both current.",
  },
  {
    label: "Choosing an approach",
    detail: "Join on order_id, group by region, filter to Q1 close date.",
  },
  {
    label: "Sanity-checking the numbers",
    detail: "Row counts line up with the monthly summary. No duplicates.",
  },
  {
    label: "Writing the answer",
    detail: "Lead with the totals, then note the one region that moved.",
  },
];

const STEP_MS = 1500;

export function ThinkingStateDemo() {
  const [revealed, setRevealed] = useState(1);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (revealed >= STEPS.length) return;
    const id = setTimeout(() => setRevealed((n) => n + 1), STEP_MS);
    return () => clearTimeout(id);
  }, [revealed]);

  const done = revealed >= STEPS.length;
  const activeIndex = done ? -1 : revealed - 1;

  const replay = () => setRevealed(1);

  return (
    <div className="w-full max-w-xl">
      <style>{`
        @keyframes bui-thinking-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes bui-thinking-shimmer {
          0%, 100% { opacity: 0.45; }
          50% { opacity: 1; }
        }
        @keyframes bui-thinking-ring {
          0% { transform: scale(1); opacity: 0.5; }
          100% { transform: scale(2.4); opacity: 0; }
        }
      `}</style>

      <div className="rounded-2xl border border-line bg-field/50 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex flex-1 items-center gap-2.5 text-left"
          >
            <svg
              viewBox="0 0 16 16"
              className={`h-3.5 w-3.5 text-ink-faint transition-transform duration-300 ease-[var(--ease-out-strong)] ${
                open ? "rotate-90" : ""
              }`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 3.5 10.5 8 6 12.5" />
            </svg>
            <span
              className="font-mono text-xs text-ink-muted"
              style={
                done
                  ? undefined
                  : {
                      animation:
                        "bui-thinking-shimmer 1600ms ease-in-out infinite",
                    }
              }
            >
              {done ? "Thought for 6 seconds" : "Thinking"}
            </span>
            <span className="font-mono text-[11px] text-ink-faint">
              {revealed}/{STEPS.length}
            </span>
          </button>

          {done && (
            <button
              type="button"
              onClick={replay}
              className="font-mono text-[11px] text-ink-faint hover:text-accent transition-colors"
            >
              replay
            </button>
          )}
        </div>

        <div
          className="grid transition-[grid-template-rows] duration-400 ease-[var(--ease-out-strong)]"
          style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        >
          <div className="overflow-hidden">
            <ol className="px-4 pb-4 pt-1">
              {STEPS.slice(0, revealed).map((step, i) => {
                const isActive = i === activeIndex;
                return (
                  <li
                    key={step.label}
                    className="relative flex gap-3 pb-4 last:pb-0"
                    style={{
                      animation:
                        "bui-thinking-in 400ms var(--ease-out-strong) both",
                    }}
                  >
                    {i < revealed - 1 && (
                      <span
                        className="absolute left-[5px] top-4 bottom-0 w-px bg-line"
                        aria-hidden="true"
                      />
                    )}
                    <span className="relative mt-1.5 flex h-2.5 w-2.5 shrink-0">
                      {isActive && (
                        <span
                          className="absolute inset-0 rounded-full bg-accent"
                          style={{
                            animation:
                              "bui-thinking-ring 1400ms ease-out infinite",
                          }}
                          aria-hidden="true"
                        />
                      )}
                      <span
                        className={`relative h-2.5 w-2.5 rounded-full ${
                          isActive ? "bg-accent" : "bg-line"
                        }`}
                      />
                    </span>
                    <div className="min-w-0">
                      <p
                        className={`text-sm leading-snug ${
                          isActive ? "text-ink" : "text-ink-muted"
                        }`}
                        style={
                          isActive
                            ? {
                                animation:
                                  "bui-thinking-shimmer 1600ms ease-in-out infinite",
                              }
                            : undefined
                        }
                      >
                        {step.label}
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">
                        {step.detail}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
