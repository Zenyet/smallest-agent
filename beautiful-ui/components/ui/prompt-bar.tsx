"use client";

import { useRef, useState } from "react";

const SUGGESTIONS = [
  "Summarize this week's changelog",
  "Draft a migration plan",
  "Explain this error trace",
  "Find slow database queries",
];

export function PromptBarDemo() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const canSubmit = value.trim().length > 0;

  const fill = (prompt: string) => {
    setValue(prompt);
    inputRef.current?.focus();
  };

  return (
    <div className="w-full max-w-xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) setValue("");
        }}
        className="flex items-center gap-2 rounded-xl border border-line bg-field/60 px-3 py-2 transition-colors focus-within:border-accent/60"
      >
        <svg
          viewBox="0 0 20 20"
          className="h-4 w-4 shrink-0 text-ink-faint"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10 3.2 11.4 7l3.8 1.4-3.8 1.4L10 13.6 8.6 9.8 4.8 8.4 8.6 7z" />
          <path d="M15.6 13.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
        </svg>

        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="What should we work on?"
          aria-label="Prompt"
          className="min-w-0 flex-1 bg-transparent py-1 text-[15px] text-ink placeholder:text-ink-faint focus:outline-none"
        />

        {value && (
          <button
            type="button"
            onClick={() => {
              setValue("");
              inputRef.current?.focus();
            }}
            aria-label="Clear prompt"
            className="shrink-0 text-ink-faint transition-colors hover:text-ink"
          >
            <svg
              viewBox="0 0 16 16"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
            </svg>
          </button>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className={`shrink-0 rounded-lg px-3 py-1.5 font-mono text-[11px] transition-all duration-200 ${
            canSubmit
              ? "bg-accent text-canvas hover:opacity-90"
              : "cursor-not-allowed bg-line text-ink-faint"
          }`}
        >
          Run
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => {
          const active = s === value;
          return (
            <button
              key={s}
              type="button"
              onClick={() => fill(s)}
              className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                active
                  ? "border-accent/40 bg-accent-tint text-accent-ink"
                  : "border-line bg-surface text-ink-muted hover:border-accent/40 hover:text-accent"
              }`}
            >
              {s}
            </button>
          );
        })}
      </div>
    </div>
  );
}
