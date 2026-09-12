"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ActionId = "rewrite" | "summarize" | "explain";

const actions: { id: ActionId; label: string }[] = [
  { id: "rewrite", label: "Rewrite" },
  { id: "summarize", label: "Summarize" },
  { id: "explain", label: "Explain" },
];

const results: Record<ActionId, string> = {
  rewrite: "Rewritten in a plainer register — two clauses trimmed, passive voice removed.",
  summarize: "In short: the fleet ran overnight, and only the pricing job needed a human.",
  explain: "This describes how nightly agent runs are checkpointed so a failure never replays work.",
};

type Toolbar = { left: number; top: number; bottom: number; text: string };

export function SelectionActionsDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [toolbar, setToolbar] = useState<Toolbar | null>(null);
  const [active, setActive] = useState<ActionId | null>(null);

  const syncSelection = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setToolbar(null);
      setActive(null);
      return;
    }

    const range = selection.getRangeAt(0);
    if (
      !container.contains(range.startContainer) ||
      !container.contains(range.endContainer)
    ) {
      setToolbar(null);
      setActive(null);
      return;
    }

    const text = selection.toString().trim();
    if (!text) {
      setToolbar(null);
      setActive(null);
      return;
    }

    const rect = range.getBoundingClientRect();
    const base = container.getBoundingClientRect();
    const center = rect.left - base.left + rect.width / 2;
    const margin = Math.min(132, base.width / 2);
    setToolbar({
      left: Math.min(Math.max(center, margin), Math.max(base.width - margin, margin)),
      top: rect.top - base.top,
      bottom: rect.bottom - base.top,
      text,
    });
    setActive(null);
  }, []);

  useEffect(() => {
    const onUp = (event: Event) => {
      // Clicks on the floating UI must not be treated as a selection change.
      if (
        event.target instanceof Element &&
        event.target.closest("[data-selection-float]")
      ) {
        return;
      }
      window.setTimeout(syncSelection, 0);
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
    };
  }, [syncSelection]);

  return (
    <div className="w-full max-w-lg">
      <div ref={containerRef} className="relative">
        <div className="rounded-2xl border border-line bg-field p-5">
          <p className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
            Run log · nightly
          </p>
          <p className="mt-2 select-text text-[14px] leading-[1.75] text-ink">
            The overnight fleet finished eleven of twelve jobs without
            intervention. Each run checkpoints after every tool call, so when the
            pricing importer hit a schema change at 03:12 it resumed from the last
            good batch instead of starting over. The only item still waiting on a
            person is a currency mapping the model refused to guess.
          </p>
          <p className="mt-3 text-[12.5px] text-ink-faint">
            Select any part of this text to see the actions.
          </p>
        </div>

        {toolbar && (
          <div
            data-selection-float
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full pb-2"
            style={{ left: toolbar.left, top: toolbar.top }}
          >
            <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-line bg-surface p-1 shadow-lg shadow-black/5">
              {actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setActive(action.id)}
                  className={`rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition-colors duration-150 ${
                    active === action.id
                      ? "bg-accent-tint text-accent-ink"
                      : "text-ink-muted hover:bg-field hover:text-ink"
                  }`}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {toolbar && active && (
          <div
            data-selection-float
            className="absolute z-10 w-64 -translate-x-1/2 rounded-xl border border-line bg-surface p-3 shadow-lg shadow-black/5"
            style={{ left: toolbar.left, top: toolbar.bottom + 8 }}
          >
            <p className="font-mono text-[11px] uppercase tracking-wider text-accent">
              {active}
            </p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink">
              {results[active]}
            </p>
            <p className="mt-2 truncate font-mono text-[11px] text-ink-faint">
              “{toolbar.text}”
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
