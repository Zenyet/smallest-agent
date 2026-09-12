"use client";

import { useMemo, useState } from "react";

type Row = {
  id: string;
  name: string;
  region: string;
  status: "active" | "paused" | "churned";
  amount: number;
};

const rows: Row[] = [
  { id: "1", name: "Alder & Finch", region: "EMEA", status: "active", amount: 820 },
  { id: "2", name: "Brine Foods", region: "AMER", status: "paused", amount: 340 },
  { id: "3", name: "Corolla Freight", region: "APAC", status: "active", amount: 1520 },
  { id: "4", name: "Dunmore Labs", region: "EMEA", status: "churned", amount: 275 },
  { id: "5", name: "Everlane Metals", region: "AMER", status: "active", amount: 640 },
  { id: "6", name: "Foundry Nine", region: "APAC", status: "paused", amount: 990 },
  { id: "7", name: "Grayson Optics", region: "AMER", status: "active", amount: 410 },
];

type Chip =
  | { id: string; label: string; kind: "status"; value: Row["status"] }
  | { id: string; label: string; kind: "region"; value: string }
  | { id: string; label: string; kind: "amount"; op: ">" | "<"; value: number };

const suggestions = [
  "active accounts over 500",
  "paused in APAC",
  "under 400 in AMER",
];

/** Toy parser — matches a few known shapes so the demo feels alive. */
function parseQuery(input: string): Chip[] {
  const q = input.toLowerCase();
  const found: Chip[] = [];

  (["active", "paused", "churned"] as const).forEach((s) => {
    if (q.includes(s)) {
      found.push({ id: `status:${s}`, label: `status: ${s}`, kind: "status", value: s });
    }
  });

  ["emea", "amer", "apac"].forEach((r) => {
    if (q.includes(r)) {
      const value = r.toUpperCase();
      found.push({ id: `region:${value}`, label: `region: ${value}`, kind: "region", value });
    }
  });

  const over = q.match(/(?:over|above|more than|>)\s*\$?(\d+)/);
  if (over) {
    const n = Number(over[1]);
    found.push({ id: `amount>${n}`, label: `amount > ${n}`, kind: "amount", op: ">", value: n });
  }
  const under = q.match(/(?:under|below|less than|<)\s*\$?(\d+)/);
  if (under) {
    const n = Number(under[1]);
    found.push({ id: `amount<${n}`, label: `amount < ${n}`, kind: "amount", op: "<", value: n });
  }

  return found;
}

function matches(row: Row, chips: Chip[]) {
  return chips.every((c) => {
    if (c.kind === "status") return row.status === c.value;
    if (c.kind === "region") return row.region === c.value;
    return c.op === ">" ? row.amount > c.value : row.amount < c.value;
  });
}

const statusClass: Record<Row["status"], string> = {
  active: "bg-green-tint text-green",
  paused: "bg-amber-tint text-amber",
  churned: "bg-red-tint text-red",
};

function SparkIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0 text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.2 9.3 6 13 7.3 9.3 8.6 8 12.4 6.7 8.6 3 7.3 6.7 6z" />
    </svg>
  );
}

export function FilterTableDemo() {
  const [query, setQuery] = useState("");
  const [chips, setChips] = useState<Chip[]>([]);
  const [missed, setMissed] = useState(false);

  const apply = (text: string) => {
    const parsed = parseQuery(text);
    setMissed(text.trim().length > 0 && parsed.length === 0);
    if (parsed.length === 0) return;
    setChips((prev) => {
      const next = [...prev];
      parsed.forEach((c) => {
        if (!next.some((p) => p.id === c.id)) next.push(c);
      });
      return next;
    });
    setQuery("");
  };

  const visible = useMemo(() => rows.filter((r) => matches(r, chips)), [chips]);

  return (
    <div className="w-full max-w-xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply(query);
        }}
        className="flex items-center gap-2 rounded-xl border border-line bg-field px-3 py-2 transition-colors focus-within:border-accent"
      >
        <SparkIcon />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setMissed(false);
          }}
          placeholder="Describe what you want to see…"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="submit"
          className="rounded-lg border border-line bg-surface px-2 py-1 font-mono text-xs text-ink-muted transition-colors hover:border-accent hover:text-accent"
        >
          filter
        </button>
      </form>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {chips.length === 0 && !missed && (
          <>
            <span className="font-mono text-xs text-ink-faint">try:</span>
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => apply(s)}
                className="rounded-full border border-dashed border-line px-2 py-0.5 font-mono text-xs text-ink-faint transition-colors hover:border-accent hover:text-accent"
              >
                {s}
              </button>
            ))}
          </>
        )}
        {missed && (
          <span className="font-mono text-xs text-amber">
            no filters recognized — try a status, region, or amount
          </span>
        )}
        {chips.map((c) => (
          <span
            key={c.id}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-accent-tint px-2 py-0.5 font-mono text-xs text-accent-ink"
          >
            {c.label}
            <button
              type="button"
              aria-label={`Remove ${c.label}`}
              onClick={() => setChips((prev) => prev.filter((p) => p.id !== c.id))}
              className="text-accent-ink/70 transition-colors hover:text-red"
            >
              ×
            </button>
          </span>
        ))}
        {chips.length > 0 && (
          <button
            type="button"
            onClick={() => setChips([])}
            className="ml-1 font-mono text-xs text-ink-faint transition-colors hover:text-ink"
          >
            clear
          </button>
        )}
      </div>

      <div className="mt-3 overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[24rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-field/60">
              <th className="px-3 py-2 text-left font-mono text-xs font-normal text-ink-faint">
                account
              </th>
              <th className="px-3 py-2 text-left font-mono text-xs font-normal text-ink-faint">
                region
              </th>
              <th className="px-3 py-2 text-left font-mono text-xs font-normal text-ink-faint">
                status
              </th>
              <th className="px-3 py-2 text-right font-mono text-xs font-normal text-ink-faint">
                amount
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.id}
                className="border-b border-line last:border-b-0 transition-colors hover:bg-field/70"
              >
                <td className="px-3 py-2.5 whitespace-nowrap text-ink">{r.name}</td>
                <td className="px-3 py-2.5 font-mono text-xs text-ink-muted">
                  {r.region}
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={`rounded-md px-1.5 py-0.5 font-mono text-xs ${statusClass[r.status]}`}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-ink">
                  ${r.amount.toLocaleString()}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-8 text-center font-mono text-xs text-ink-faint"
                >
                  no rows match these filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 font-mono text-xs text-ink-faint">
        {visible.length} of {rows.length} rows
      </p>
    </div>
  );
}
