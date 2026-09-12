"use client";

import { useEffect, useState } from "react";

type TokenKind =
  | "plain"
  | "keyword"
  | "type"
  | "fn"
  | "num"
  | "str"
  | "punct"
  | "comment";

type Token = [TokenKind, string];

const tokenClass: Record<TokenKind, string> = {
  plain: "text-ink",
  keyword: "text-accent",
  type: "text-green",
  fn: "text-ink font-medium",
  num: "text-amber",
  str: "text-amber",
  punct: "text-ink-muted",
  comment: "text-ink-faint italic",
};

// Hand-tokenized so the demo needs no highlighting library.
const lines: Token[][] = [
  [
    ["keyword", "type"],
    ["plain", " "],
    ["type", "Budget"],
    ["punct", " = { "],
    ["plain", "spent"],
    ["punct", ": "],
    ["type", "number"],
    ["punct", "; "],
    ["plain", "cap"],
    ["punct", ": "],
    ["type", "number"],
    ["punct", " };"],
  ],
  [],
  [
    ["comment", "// Back off exponentially, but never past the budget."],
  ],
  [
    ["keyword", "export function"],
    ["plain", " "],
    ["fn", "nextDelay"],
    ["punct", "("],
    ["plain", "attempt"],
    ["punct", ": "],
    ["type", "number"],
    ["punct", ", "],
    ["plain", "budget"],
    ["punct", ": "],
    ["type", "Budget"],
    ["punct", ") {"],
  ],
  [
    ["punct", "  "],
    ["keyword", "const"],
    ["plain", " wait "],
    ["punct", "= "],
    ["type", "Math"],
    ["punct", "."],
    ["fn", "min"],
    ["punct", "("],
    ["num", "2"],
    ["punct", " ** "],
    ["plain", "attempt"],
    ["punct", " * "],
    ["num", "250"],
    ["punct", ", "],
    ["num", "8_000"],
    ["punct", ");"],
  ],
  [
    ["punct", "  "],
    ["keyword", "if"],
    ["punct", " ("],
    ["plain", "budget"],
    ["punct", "."],
    ["plain", "spent"],
    ["punct", " + "],
    ["plain", "wait"],
    ["punct", " > "],
    ["plain", "budget"],
    ["punct", "."],
    ["plain", "cap"],
    ["punct", ") "],
    ["keyword", "return"],
    ["plain", " "],
    ["keyword", "null"],
    ["punct", ";"],
  ],
  [
    ["punct", "  "],
    ["keyword", "return"],
    ["plain", " wait"],
    ["punct", ";"],
  ],
  [["punct", "}"]],
];

const highlightedLine = 5; // 1-based

const codeText = lines
  .map((line) => line.map(([, text]) => text).join(""))
  .join("\n");

export function CodeBlockDemo() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codeText);
    } catch {
      // Clipboard may be unavailable; still show feedback.
    }
    setCopied(true);
  }

  return (
    <div className="w-full max-w-xl">
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {/* Header bar */}
        <div className="flex items-center gap-2.5 border-b border-line bg-field/60 px-3 py-2">
          <span className="rounded-md bg-accent-tint px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-accent-ink uppercase">
            ts
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
            lib/retry/next-delay.ts
          </span>
          <button
            type="button"
            onClick={copy}
            aria-label="Copy code"
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[10px] text-ink-muted transition-colors hover:text-ink"
          >
            {copied ? (
              <svg viewBox="0 0 14 14" fill="none" className="h-3 w-3 text-green">
                <path
                  d="M3 7.4l2.6 2.6L11 4.6"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 14 14" fill="none" className="h-3 w-3">
                <rect
                  x="5"
                  y="5"
                  width="7"
                  height="7"
                  rx="1.6"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <path
                  d="M9 4.2V3.6A1.6 1.6 0 007.4 2H3.6A1.6 1.6 0 002 3.6v3.8A1.6 1.6 0 003.6 9h.6"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        {/* Code */}
        <div className="overflow-x-auto py-2">
          <pre className="font-mono text-[12px] leading-[1.65]">
            <code>
              {lines.map((tokens, i) => {
                const lineNo = i + 1;
                const isHot = lineNo === highlightedLine;
                return (
                  <div
                    key={lineNo}
                    className={`flex min-w-max items-start ${
                      isHot
                        ? "border-l-2 border-accent bg-accent-tint"
                        : "border-l-2 border-transparent"
                    }`}
                  >
                    <span className="w-9 shrink-0 pr-3 text-right text-ink-faint select-none">
                      {lineNo}
                    </span>
                    <span className="pr-4 whitespace-pre">
                      {tokens.length === 0
                        ? " "
                        : tokens.map(([kind, text], j) => (
                            <span key={j} className={tokenClass[kind]}>
                              {text}
                            </span>
                          ))}
                    </span>
                  </div>
                );
              })}
            </code>
          </pre>
        </div>

        {/* Footer note */}
        <div className="flex items-center gap-2 border-t border-line px-3 py-2">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          <p className="font-mono text-[10px] text-ink-faint">
            Line {highlightedLine} — caps the wait at 8s before spending budget
          </p>
        </div>
      </div>
    </div>
  );
}
