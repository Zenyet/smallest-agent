"use client";

import { useState } from "react";

type SourceKind = "file" | "page" | "record";

type Source = {
  id: string;
  kind: SourceKind;
  title: string;
  meta: string;
  snippet: string;
  detail: string;
  relevance: number;
};

const sources: Source[] = [
  {
    id: "s1",
    kind: "file",
    title: "q3-pricing-notes.md",
    meta: "shared drive · edited 6d ago",
    snippet:
      "Tiered pricing was revised so the mid tier absorbs overage instead of billing it separately.",
    detail:
      "The mid tier now bundles 50k events per month. Overage above that is invoiced quarterly rather than at the moment of use, which is what changed the renewal math for the accounts flagged last week.",
    relevance: 0.93,
  },
  {
    id: "s2",
    kind: "page",
    title: "Changelog — Metering v2",
    meta: "docs.internal · fetched today",
    snippet:
      "Event metering moved from hourly batches to a streaming counter with a five minute settle window.",
    detail:
      "Counters settle five minutes after the event window closes. Anything read before settlement can undercount, which explains the gaps that appeared in the mid-month usage report.",
    relevance: 0.78,
  },
  {
    id: "s3",
    kind: "record",
    title: "account_4821",
    meta: "postgres · accounts table",
    snippet:
      "plan=growth · seats=28 · metering_mode=stream · last_invoice=2026-07-02",
    detail:
      "This record was migrated to streaming metering on 2026-06-18. The first invoice after migration is the one showing the discrepancy, so it is the best example to reason from.",
    relevance: 0.64,
  },
];

function KindIcon({ kind }: { kind: SourceKind }) {
  const common = {
    viewBox: "0 0 16 16",
    className: "h-3.5 w-3.5",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "file") {
    return (
      <svg {...common}>
        <path d="M4 2h5l3 3v9H4z" />
        <path d="M9 2v3h3" />
      </svg>
    );
  }
  if (kind === "page") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6" />
        <path d="M2.4 8h11.2M8 2.2c1.6 1.7 2.4 3.7 2.4 5.8S9.6 12.1 8 13.8C6.4 12.1 5.6 10.1 5.6 8s.8-4.1 2.4-5.8z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
      <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </svg>
  );
}

const kindLabel: Record<SourceKind, string> = {
  file: "file",
  page: "webpage",
  record: "db record",
};

function Relevance({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-1 w-12 overflow-hidden rounded-full bg-line">
        <span
          className="block h-full rounded-full bg-accent transition-all duration-500 ease-out"
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </span>
      <span className="font-mono text-xs text-ink-faint tabular-nums">
        {Math.round(value * 100)}%
      </span>
    </span>
  );
}

export function ContextCardsDemo() {
  const [expanded, setExpanded] = useState<string | null>("s1");

  return (
    <div className="w-full max-w-xl">
      <p className="mb-3 font-mono text-xs text-ink-faint">
        drawing from {sources.length} sources
      </p>
      <div className="flex flex-col gap-2">
        {sources.map((s) => {
          const open = expanded === s.id;
          return (
            <div
              key={s.id}
              className={`rounded-xl border bg-surface transition-colors ${
                open ? "border-accent/50" : "border-line hover:border-ink-faint/50"
              }`}
            >
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setExpanded(open ? null : s.id)}
                className="w-full px-3.5 py-3 text-left"
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
                      open
                        ? "bg-accent-tint text-accent"
                        : "bg-field text-ink-muted"
                    }`}
                  >
                    <KindIcon kind={s.kind} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="truncate text-sm font-medium text-ink">
                        {s.title}
                      </span>
                      <span className="font-mono text-xs text-ink-faint">
                        {kindLabel[s.kind]}
                      </span>
                    </span>
                    <span className="mt-0.5 block font-mono text-xs text-ink-faint">
                      {s.meta}
                    </span>
                    <span
                      className={`mt-1.5 block text-xs leading-relaxed text-ink-muted ${
                        open ? "" : "line-clamp-2"
                      }`}
                    >
                      {s.snippet}
                    </span>
                  </span>
                </div>
              </button>

              <div
                className={`grid transition-all duration-300 ease-out ${
                  open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                }`}
              >
                <div className="overflow-hidden">
                  <div className="mx-3.5 mb-3 rounded-lg border-l-2 border-accent bg-field px-3 py-2">
                    <p className="text-xs leading-relaxed text-ink-muted">
                      {s.detail}
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-line px-3.5 py-2">
                <span className="font-mono text-xs text-ink-faint">
                  relevance
                </span>
                <Relevance value={s.relevance} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
