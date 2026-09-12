"use client";

import { useState } from "react";

const reasons = [
  "Renewal sits 21 days out and no owner has touched the account this quarter.",
  "Usage climbed 38% since the plan was last adjusted, so the current tier will overage.",
  "Two similar accounts upgraded after the same signal and neither churned.",
];

type Status = "idle" | "accepted" | "dismissed";

function BulbIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.8a4.2 4.2 0 0 0-2.5 7.6c.4.3.6.8.6 1.3v.3h3.8v-.3c0-.5.2-1 .6-1.3A4.2 4.2 0 0 0 8 1.8z" />
      <path d="M6.4 13.4h3.2M7 15h2" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3 w-3 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

export function RecommendationCardDemo() {
  const [status, setStatus] = useState<Status>("idle");
  const [showReasoning, setShowReasoning] = useState(false);

  return (
    <div className="w-full max-w-md">
      <div
        className={`rounded-2xl border bg-surface p-4 transition-colors duration-300 ${
          status === "accepted"
            ? "border-green/50"
            : status === "dismissed"
              ? "border-line opacity-70"
              : "border-line"
        }`}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-tint text-accent">
            <BulbIcon />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs text-accent">suggested action</p>
            <h3 className="mt-1 text-sm font-medium leading-snug text-ink">
              Move Kestrel Apparel to the Growth tier before renewal
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
              Locks in annual pricing and removes the overage they would hit in
              the next billing cycle.
            </p>
          </div>
        </div>

        <button
          type="button"
          aria-expanded={showReasoning}
          onClick={() => setShowReasoning((v) => !v)}
          className="mt-3 inline-flex items-center gap-1.5 font-mono text-xs text-ink-muted transition-colors hover:text-accent"
        >
          <Chevron open={showReasoning} />
          why this
        </button>

        <div
          className={`grid transition-all duration-300 ease-out ${
            showReasoning ? "mt-2 grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <div className="overflow-hidden">
            <ul className="rounded-xl border border-line bg-field px-3 py-2.5">
              {reasons.map((r) => (
                <li
                  key={r}
                  className="flex gap-2 py-1 text-xs leading-relaxed text-ink-muted"
                >
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-4 border-t border-line pt-3">
          {status === "idle" ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStatus("accepted")}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => setStatus("dismissed")}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
              >
                Dismiss
              </button>
              <span className="ml-auto font-mono text-xs text-ink-faint">
                confidence 0.82
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-xs ${
                  status === "accepted"
                    ? "bg-green-tint text-green"
                    : "bg-field text-ink-muted"
                }`}
              >
                {status === "accepted"
                  ? "✓ queued for the next sync"
                  : "dismissed — won't suggest again"}
              </span>
              <button
                type="button"
                onClick={() => setStatus("idle")}
                className="ml-auto font-mono text-xs text-ink-faint underline-offset-4 transition-colors hover:text-accent hover:underline"
              >
                undo
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
