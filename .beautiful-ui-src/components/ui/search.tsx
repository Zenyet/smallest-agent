"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type ResultKind = "action" | "document" | "recent";

type Result = {
  id: string;
  label: string;
  detail: string;
  kind: ResultKind;
  shortcut?: string;
};

const allResults: Result[] = [
  {
    id: "a1",
    label: "Start a new thread",
    detail: "Blank conversation",
    kind: "action",
    shortcut: "N",
  },
  {
    id: "a2",
    label: "Invite a teammate",
    detail: "Send workspace invite",
    kind: "action",
    shortcut: "I",
  },
  {
    id: "a3",
    label: "Export transcript as Markdown",
    detail: "Current thread",
    kind: "action",
  },
  {
    id: "d1",
    label: "Retention playbook 2026",
    detail: "Growth · edited 3 days ago",
    kind: "document",
  },
  {
    id: "d2",
    label: "Webhook retry semantics",
    detail: "Engineering · edited last week",
    kind: "document",
  },
  {
    id: "d3",
    label: "Support tone guidelines",
    detail: "Customer Ops · edited in May",
    kind: "document",
  },
  {
    id: "r1",
    label: "Rewrite the pricing FAQ",
    detail: "Opened 12 minutes ago",
    kind: "recent",
  },
  {
    id: "r2",
    label: "Trace the failing nightly job",
    detail: "Opened yesterday",
    kind: "recent",
  },
];

const groupOrder: { kind: ResultKind; title: string }[] = [
  { kind: "action", title: "Actions" },
  { kind: "document", title: "Documents" },
  { kind: "recent", title: "Recent" },
];

function KindIcon({ kind }: { kind: ResultKind }) {
  if (kind === "action") {
    return (
      <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
        <path
          d="M8.6 2L3.8 9h3.2l-.6 5 4.8-7H8l.6-5z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === "document") {
    return (
      <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
        <path
          d="M4 2.5h5l3 3v8H4v-11z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path d="M6 8.5h4M6 10.8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
      <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 5v3.2l2 1.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-accent-tint px-0.5 text-accent-ink">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

export function SearchDemo() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [launched, setLaunched] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allResults;
    return allResults.filter(
      (r) =>
        r.label.toLowerCase().includes(q) || r.detail.toLowerCase().includes(q),
    );
  }, [query]);

  const groups = useMemo(
    () =>
      groupOrder
        .map((g) => ({ ...g, items: matches.filter((m) => m.kind === g.kind) }))
        .filter((g) => g.items.length > 0),
    [matches],
  );

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      '[data-selected="true"]',
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [selected, query]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (flat.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      setLaunched(flat[selected]?.label ?? null);
    }
  }

  return (
    <div className="w-full max-w-xl">
      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
        {/* Input row */}
        <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
          <svg
            viewBox="0 0 18 18"
            fill="none"
            className="h-4 w-4 shrink-0 text-ink-faint"
          >
            <circle cx="8" cy="8" r="4.8" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M11.6 11.6L15 15"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search actions, docs, and history…"
            aria-label="Search"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          <kbd className="rounded-md border border-line bg-field px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
            ⌘K
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-72 overflow-y-auto p-1.5">
          {flat.length === 0 ? (
            <div className="px-3 py-10 text-center">
              <p className="text-sm text-ink-muted">
                Nothing matches “{query.trim()}”
              </p>
              <p className="mt-1 font-mono text-[11px] text-ink-faint">
                Try a shorter phrase
              </p>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.kind} className="mb-1 last:mb-0">
                <p className="px-2.5 pt-2 pb-1 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                  {group.title}
                </p>
                {group.items.map((item) => {
                  const index = flat.findIndex((f) => f.id === item.id);
                  const isSelected = index === selected;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-selected={isSelected}
                      onMouseEnter={() => setSelected(index)}
                      onClick={() => setLaunched(item.label)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                        isSelected ? "bg-field" : "bg-transparent"
                      }`}
                    >
                      <span
                        className={`grid h-6 w-6 shrink-0 place-items-center rounded-md border border-line ${
                          isSelected
                            ? "border-transparent bg-accent-tint text-accent"
                            : "text-ink-faint"
                        }`}
                      >
                        <KindIcon kind={item.kind} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-ink">
                          <Highlight text={item.label} query={query} />
                        </span>
                        <span className="block truncate text-[11px] text-ink-faint">
                          <Highlight text={item.detail} query={query} />
                        </span>
                      </span>
                      {item.shortcut && (
                        <kbd className="shrink-0 rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
                          {item.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-line bg-field/60 px-3.5 py-2">
          <p className="truncate font-mono text-[10px] text-ink-faint">
            {launched ? `Ran: ${launched}` : `${flat.length} results`}
          </p>
          <p className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-ink-faint">
            <span className="rounded border border-line px-1 py-0.5">↑↓</span>
            navigate
            <span className="rounded border border-line px-1 py-0.5">↵</span>
            open
          </p>
        </div>
      </div>
    </div>
  );
}
