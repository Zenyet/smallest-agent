"use client";

import { useEffect, useState } from "react";

const tasks = [
  { title: "Pull last 90 days of churn events", meta: "warehouse" },
  { title: "Cluster cancellation reasons", meta: "analysis" },
  { title: "Cross-check against support tickets", meta: "zendesk" },
  { title: "Draft a one-page summary", meta: "writing" },
];

const STEP_MS = 1100;

function PendingIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 text-ink-faint" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeDasharray="2.2 2.4"
      />
    </svg>
  );
}

function RunningIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 animate-spin text-accent" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.25" />
      <path
        d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DoneIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 text-green" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="currentColor" opacity="0.16" />
      <path
        d="M5.2 8.2 7.1 10.1 10.9 6.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ReplayIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
      <path
        d="M13 8a5 5 0 1 1-1.7-3.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M13.2 2.4v2.9h-2.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TaskRowsDemo() {
  // `progress` = number of completed tasks; the task at index `progress` is running.
  const [progress, setProgress] = useState(0);
  const [run, setRun] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setProgress((p) => {
        if (p >= tasks.length) {
          clearInterval(id);
          return p;
        }
        return p + 1;
      });
    }, STEP_MS);
    return () => clearInterval(id);
  }, [run]);

  const allDone = progress >= tasks.length;

  return (
    <div className="w-full max-w-lg">
      <div className="rounded-2xl border border-line bg-surface">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
              Plan
            </span>
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-[11px] transition-colors duration-300 ${
                allDone ? "bg-green-tint text-green" : "bg-accent-tint text-accent-ink"
              }`}
            >
              {allDone ? "done" : `${progress}/${tasks.length}`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setProgress(0);
              setRun((r) => r + 1);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 font-mono text-[11.5px] text-ink-muted transition-colors duration-200 hover:border-ink-faint/50 hover:text-ink"
          >
            <ReplayIcon />
            Replay
          </button>
        </div>

        <ul className="divide-y divide-line">
          {tasks.map((task, i) => {
            const state =
              i < progress ? "completed" : i === progress ? "running" : "pending";
            return (
              <li
                key={task.title}
                className={`flex items-center gap-3 px-4 py-3 transition-colors duration-500 ${
                  state === "running" ? "bg-accent-tint/40" : ""
                }`}
              >
                <span className="grid size-4 shrink-0 place-items-center">
                  {state === "completed" ? (
                    <DoneIcon />
                  ) : state === "running" ? (
                    <RunningIcon />
                  ) : (
                    <PendingIcon />
                  )}
                </span>
                <span
                  className={`flex-1 text-[13.5px] transition-all duration-500 ${
                    state === "pending"
                      ? "text-ink-faint"
                      : state === "running"
                        ? "font-medium text-ink"
                        : "text-ink-muted"
                  }`}
                >
                  {task.title}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                  {state === "running" ? (
                    <span className="text-accent">working…</span>
                  ) : (
                    task.meta
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <p className="mt-3 text-[12.5px] text-ink-faint">
        {allDone
          ? "All steps finished — replay to watch the run again."
          : "The agent updates each row as it moves through the plan."}
      </p>
    </div>
  );
}
