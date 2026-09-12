"use client";

import { useEffect, useRef, useState } from "react";

type Model = {
  id: string;
  name: string;
  blurb: string;
};

const MODELS: Model[] = [
  { id: "swift", name: "Swift", blurb: "Fast replies, everyday tasks" },
  { id: "balanced", name: "Balanced", blurb: "The default for most work" },
  { id: "deep", name: "Deep", blurb: "Slower, for hard reasoning" },
];

const MAX_HEIGHT = 160;

export function ChatComposerDemo() {
  const [value, setValue] = useState("");
  const [model, setModel] = useState(MODELS[1]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [sent, setSent] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const canSend = value.trim().length > 0;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!sent) return;
    const id = setTimeout(() => setSent(false), 1800);
    return () => clearTimeout(id);
  }, [sent]);

  const send = () => {
    if (!canSend) return;
    setValue("");
    setAttachments([]);
    setSent(true);
    textareaRef.current?.focus();
  };

  const attach = () => {
    const names = ["quarterly-notes.md", "chart.png", "schema.sql"];
    setAttachments((prev) =>
      prev.length >= names.length ? prev : [...prev, names[prev.length]],
    );
  };

  return (
    <div ref={wrapperRef} className="w-full max-w-xl">
      <div className="rounded-2xl border border-line bg-field/60 p-2.5 transition-colors focus-within:border-accent/60">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5 px-1">
            {attachments.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink-muted"
              >
                {name}
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() =>
                    setAttachments((prev) => prev.filter((n) => n !== name))
                  }
                  className="text-ink-faint transition-colors hover:text-red"
                >
                  <svg
                    viewBox="0 0 16 16"
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask anything, or paste something to work on…"
          aria-label="Message"
          className="block w-full resize-none bg-transparent px-2 py-2 text-[15px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
        />

        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            onClick={attach}
            aria-label="Add attachment"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
          >
            <svg
              viewBox="0 0 20 20"
              className="h-[18px] w-[18px]"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M14 6.5 8 12.5a2.1 2.1 0 0 0 3 3l6-6a4 4 0 0 0-5.7-5.7l-6.2 6.3a6 6 0 0 0 8.5 8.5l1.9-2" />
            </svg>
          </button>

          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-haspopup="listbox"
              className="flex h-8 items-center gap-1.5 rounded-lg px-2 font-mono text-[11px] text-ink-muted transition-colors hover:bg-surface hover:text-ink"
            >
              {model.name}
              <svg
                viewBox="0 0 16 16"
                className={`h-3 w-3 transition-transform duration-200 ${
                  menuOpen ? "rotate-180" : ""
                }`}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 6.5 8 10.5l4-4" />
              </svg>
            </button>

            {menuOpen && (
              <div
                role="listbox"
                className="absolute bottom-full left-0 z-10 mb-2 w-56 overflow-hidden rounded-xl border border-line bg-surface shadow-lg shadow-black/5"
              >
                {MODELS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={m.id === model.id}
                    onClick={() => {
                      setModel(m);
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-field"
                  >
                    <span className="mt-1 flex h-3 w-3 shrink-0 items-center justify-center">
                      {m.id === model.id && (
                        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm text-ink">{m.name}</span>
                      <span className="block text-xs text-ink-faint">
                        {m.blurb}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className="ml-auto font-mono text-[11px] text-ink-faint">
            {sent ? "Sent" : "⏎ to send"}
          </span>

          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            aria-label="Send message"
            className={`flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-200 ${
              canSend
                ? "bg-accent text-canvas hover:opacity-90"
                : "cursor-not-allowed bg-line text-ink-faint"
            }`}
          >
            <svg
              viewBox="0 0 16 16"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 13V3.5M4 7.5 8 3.5l4 4" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
