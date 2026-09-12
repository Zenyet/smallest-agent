"use client";

import { useState } from "react";

type Change = {
  id: string;
  field: string;
  current: string;
  proposed: string;
};

const changes: Change[] = [
  {
    id: "plan",
    field: "billing_plan",
    current: "Starter",
    proposed: "Growth (annual)",
  },
  {
    id: "seats",
    field: "seat_count",
    current: "12",
    proposed: "28",
  },
  {
    id: "owner",
    field: "account_owner",
    current: "unassigned",
    proposed: "Nadia Roque",
  },
  {
    id: "renewal",
    field: "renewal_date",
    current: "2026-03-14",
    proposed: "2027-03-14",
  },
];

type Decision = "pending" | "accepted" | "skipped";

function ArrowGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0 text-ink-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8h10" />
      <path d="M9.5 4.5 13 8l-3.5 3.5" />
    </svg>
  );
}

export function DiffTableDemo() {
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() =>
    Object.fromEntries(changes.map((c) => [c.id, "pending" as Decision])),
  );

  const set = (id: string, next: Decision) =>
    setDecisions((prev) => ({
      ...prev,
      [id]: prev[id] === next ? "pending" : next,
    }));

  const acceptAll = () =>
    setDecisions(
      Object.fromEntries(changes.map((c) => [c.id, "accepted" as Decision])),
    );

  const acceptedCount = Object.values(decisions).filter(
    (d) => d === "accepted",
  ).length;
  const allAccepted = acceptedCount === changes.length;

  return (
    <div className="w-full max-w-xl">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="font-mono text-xs text-ink-faint">
          {acceptedCount} of {changes.length} accepted
        </p>
        <button
          type="button"
          onClick={acceptAll}
          disabled={allAccepted}
          className="rounded-lg border border-line px-2.5 py-1 font-mono text-xs text-ink-muted transition-colors hover:border-accent hover:text-accent disabled:cursor-default disabled:border-line disabled:text-ink-faint disabled:hover:text-ink-faint"
        >
          {allAccepted ? "all accepted" : "accept all"}
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[26rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-field/60">
              <th className="px-3 py-2 text-left font-mono text-xs font-normal text-ink-faint">
                field
              </th>
              <th className="px-3 py-2 text-left font-mono text-xs font-normal text-ink-faint">
                change
              </th>
              <th className="px-3 py-2 text-right font-mono text-xs font-normal text-ink-faint">
                decision
              </th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => {
              const state = decisions[c.id];
              return (
                <tr
                  key={c.id}
                  className="border-b border-line last:border-b-0 transition-colors"
                >
                  <td className="px-3 py-3 align-top font-mono text-xs text-ink-muted">
                    {c.field}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-md bg-red-tint px-1.5 py-0.5 font-mono text-xs text-red transition-opacity ${
                          state === "skipped" ? "opacity-100" : "line-through"
                        } ${state === "accepted" ? "opacity-45" : ""}`}
                      >
                        {c.current}
                      </span>
                      <ArrowGlyph />
                      <span
                        className={`rounded-md bg-green-tint px-1.5 py-0.5 font-mono text-xs text-green transition-opacity ${
                          state === "skipped"
                            ? "line-through opacity-45"
                            : "opacity-100"
                        }`}
                      >
                        {c.proposed}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => set(c.id, "accepted")}
                        aria-pressed={state === "accepted"}
                        className={`rounded-lg border px-2 py-1 font-mono text-xs transition-colors ${
                          state === "accepted"
                            ? "border-green bg-green-tint text-green"
                            : "border-line text-ink-muted hover:border-green hover:text-green"
                        }`}
                      >
                        accept
                      </button>
                      <button
                        type="button"
                        onClick={() => set(c.id, "skipped")}
                        aria-pressed={state === "skipped"}
                        className={`rounded-lg border px-2 py-1 font-mono text-xs transition-colors ${
                          state === "skipped"
                            ? "border-red bg-red-tint text-red"
                            : "border-line text-ink-muted hover:border-red hover:text-red"
                        }`}
                      >
                        skip
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
