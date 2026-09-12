"use client";

import { useState } from "react";

type Tone = "positive" | "neutral" | "at risk";

type Record_ = {
  id: string;
  invoice: string;
  customer: string;
  amount: string;
  tone: Tone;
  confidence: number;
};

const records: Record_[] = [
  {
    id: "r1",
    invoice: "INV-4021",
    customer: "Harborline Coffee",
    amount: "$1,280.00",
    tone: "positive",
    confidence: 0.94,
  },
  {
    id: "r2",
    invoice: "INV-4022",
    customer: "Petra Logistics",
    amount: "$640.50",
    tone: "neutral",
    confidence: 0.71,
  },
  {
    id: "r3",
    invoice: "INV-4023",
    customer: "Vellum Studio",
    amount: "$3,900.00",
    tone: "at risk",
    confidence: 0.88,
  },
  {
    id: "r4",
    invoice: "INV-4024",
    customer: "Nordwell Dairy",
    amount: "$212.75",
    tone: "positive",
    confidence: 0.62,
  },
  {
    id: "r5",
    invoice: "INV-4025",
    customer: "Cascade Tooling",
    amount: "$1,045.00",
    tone: "neutral",
    confidence: 0.83,
  },
  {
    id: "r6",
    invoice: "INV-4026",
    customer: "Kestrel Apparel",
    amount: "$7,320.00",
    tone: "at risk",
    confidence: 0.57,
  },
];

const toneClass: Record<Tone, string> = {
  positive: "bg-green-tint text-green",
  neutral: "bg-accent-tint text-accent-ink",
  "at risk": "bg-amber-tint text-amber",
};

function ConfidenceDots({ value }: { value: number }) {
  const filled = value >= 0.85 ? 3 : value >= 0.7 ? 2 : 1;
  return (
    <span
      className="ml-1.5 inline-flex items-center gap-0.5 align-middle"
      title={`model confidence ${Math.round(value * 100)}%`}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`h-1 w-1 rounded-full ${
            i < filled ? "bg-ink-muted" : "bg-line"
          }`}
        />
      ))}
    </span>
  );
}

function DotsIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="8" cy="3.5" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="8" cy="12.5" r="1.2" />
    </svg>
  );
}

export function RecordsTableDemo() {
  const [openRow, setOpenRow] = useState<string | null>(null);

  return (
    <div className="w-full max-w-xl">
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[30rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-field/60">
              <th className="px-3 py-2 text-left font-mono text-xs font-normal text-ink-faint">
                invoice
              </th>
              <th className="px-3 py-2 text-left font-mono text-xs font-normal text-ink-faint">
                customer
              </th>
              <th className="px-3 py-2 text-right font-mono text-xs font-normal text-ink-faint">
                amount
              </th>
              <th className="px-3 py-2 text-left font-mono text-xs font-normal text-ink-faint">
                <span className="text-accent">✦</span> sentiment
              </th>
              <th className="w-10 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {records.map((r, i) => (
              <tr
                key={r.id}
                className="group border-b border-line last:border-b-0 transition-colors hover:bg-field/70"
              >
                <td className="px-3 py-2.5 font-mono text-xs text-ink-muted">
                  {r.invoice}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-ink">
                  {r.customer}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs text-ink tabular-nums">
                  {r.amount}
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-xs ${toneClass[r.tone]}`}
                  >
                    {r.tone}
                    <ConfidenceDots value={r.confidence} />
                  </span>
                </td>
                <td className="relative px-3 py-2.5 text-right">
                  <button
                    type="button"
                    aria-label={`Actions for ${r.invoice}`}
                    onClick={() =>
                      setOpenRow((prev) => (prev === r.id ? null : r.id))
                    }
                    className={`rounded-md p-1 text-ink-faint transition-all hover:bg-line hover:text-ink ${
                      openRow === r.id
                        ? "bg-line text-ink opacity-100"
                        : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    }`}
                  >
                    <DotsIcon />
                  </button>
                  {openRow === r.id && (
                    <div
                      className={`absolute right-2 z-10 w-36 ${
                        i >= records.length - 2 ? "bottom-9" : "top-9"
                      } overflow-hidden rounded-xl border border-line bg-surface py-1 text-left shadow-lg`}
                    >
                      {["Open record", "Re-run enrichment", "Flag for review"].map(
                        (label) => (
                          <button
                            key={label}
                            type="button"
                            onClick={() => setOpenRow(null)}
                            className="block w-full px-3 py-1.5 text-left text-xs text-ink-muted transition-colors hover:bg-field hover:text-ink"
                          >
                            {label}
                          </button>
                        ),
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 font-mono text-xs text-ink-faint">
        dots indicate model confidence in the enriched column
      </p>
    </div>
  );
}
