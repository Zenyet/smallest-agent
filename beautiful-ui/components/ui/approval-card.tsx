"use client";

import { useState } from "react";

type Decision = "pending" | "approved" | "rejected";

const details = [
  { label: "action", value: "email.sendBatch" },
  { label: "recipients", value: "3 accounts in trial" },
  { label: "template", value: "trial-day-9-checkin" },
  { label: "scheduled", value: "today, 4:30 PM" },
];

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CrossIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path
        d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function UndoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path
        d="M5.5 4 2.5 7l3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 7h6.25A3.75 3.75 0 0 1 12.5 10.75V12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SparkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path
        d="M8 1.5 9.4 6 14 7.5 9.4 9 8 13.5 6.6 9 2 7.5 6.6 6z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ApprovalCardDemo() {
  const [decision, setDecision] = useState<Decision>("pending");

  const resolved = decision !== "pending";
  const approved = decision === "approved";

  return (
    <div className="w-full max-w-md">
      <div
        className={`rounded-2xl border bg-surface overflow-hidden transition-colors duration-300 ${
          approved
            ? "border-green/40"
            : decision === "rejected"
              ? "border-red/40"
              : "border-line"
        }`}
      >
        <div className="p-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-accent-tint text-accent">
              <SparkIcon className="size-3.5" />
            </span>
            <div className="min-w-0">
              <p className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
                Needs your approval
              </p>
              <h3 className="mt-1 text-[15px] font-semibold leading-snug text-ink">
                Send a follow-up email to 3 trial customers
              </h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
                They opened the pricing page twice this week but never started a
                workspace. Draft is written and ready to queue.
              </p>
            </div>
          </div>

          <dl className="mt-4 rounded-xl border border-line bg-field px-3.5 py-3 text-[12.5px]">
            {details.map((d, i) => (
              <div
                key={d.label}
                className={`flex items-baseline justify-between gap-4 ${
                  i > 0 ? "mt-2" : ""
                }`}
              >
                <dt className="font-mono text-ink-faint">{d.label}</dt>
                <dd className="truncate text-right text-ink">{d.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="border-t border-line px-5 py-3.5">
          {!resolved ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDecision("approved")}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white transition-opacity duration-200 hover:opacity-90"
              >
                <CheckIcon className="size-3.5" />
                Approve
              </button>
              <button
                type="button"
                onClick={() => setDecision("rejected")}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] font-medium text-ink-muted transition-colors duration-200 hover:border-red/40 hover:text-red"
              >
                <CrossIcon className="size-3.5" />
                Reject
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <span
                className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-medium ${
                  approved
                    ? "bg-green-tint text-green"
                    : "bg-red-tint text-red"
                }`}
              >
                {approved ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <CrossIcon className="size-3.5" />
                )}
                {approved ? "Approved — queued to send" : "Rejected — nothing sent"}
              </span>
              <button
                type="button"
                onClick={() => setDecision("pending")}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 font-mono text-[12px] text-ink-faint transition-colors duration-200 hover:text-accent"
              >
                <UndoIcon className="size-3.5" />
                Undo
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
