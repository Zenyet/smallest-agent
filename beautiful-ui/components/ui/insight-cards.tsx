"use client";

import { useState } from "react";

type Insight = {
  id: string;
  label: string;
  value: string;
  change: number;
  positiveIsGood: boolean;
  series: number[];
  summary: string;
  window: string;
};

const insights: Insight[] = [
  {
    id: "resolution",
    label: "Auto-resolved tickets",
    value: "1,284",
    change: 18.4,
    positiveIsGood: true,
    series: [42, 48, 45, 57, 61, 59, 72, 78, 74, 88, 96, 104],
    summary:
      "Resolution volume climbed after the refund playbook shipped — most of the lift comes from billing questions.",
    window: "Last 12 weeks",
  },
  {
    id: "handoff",
    label: "Handoffs to a human",
    value: "9.2%",
    change: -4.1,
    positiveIsGood: false,
    series: [17, 16, 16, 14, 15, 13, 12, 12, 11, 10, 10, 9],
    summary:
      "Escalations keep falling, though shipping-status questions still hand off twice as often as anything else.",
    window: "Last 12 weeks",
  },
  {
    id: "latency",
    label: "Median first response",
    value: "3.4s",
    change: 12.7,
    positiveIsGood: false,
    series: [2.4, 2.5, 2.4, 2.6, 2.9, 2.8, 3.0, 3.3, 3.1, 3.5, 3.4, 3.6],
    summary:
      "Responses slowed once retrieval was added to the default route; the tail is worst during weekday mornings.",
    window: "Last 12 weeks",
  },
];

function Sparkline({ series }: { series: number[] }) {
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const w = 100;
  const h = 32;
  const points = series.map((v, i) => {
    const x = (i / (series.length - 1)) * w;
    const y = h - ((v - min) / span) * (h - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const last = points[points.length - 1].split(",");

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-8 w-full"
      aria-hidden="true"
    >
      <polyline
        points={`0,${h} ${points.join(" ")} ${w},${h}`}
        fill="currentColor"
        opacity="0.12"
        stroke="none"
      />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last[0]} cy={last[1]} r="2" fill="currentColor" />
    </svg>
  );
}

function TrendArrow({ up }: { up: boolean }) {
  return (
    <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3">
      <path
        d={up ? "M6 9.5V2.8M3.2 5.6L6 2.6l2.8 3" : "M6 2.5v6.7M3.2 6.4L6 9.4l2.8-3"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function InsightCardsDemo() {
  const [expanded, setExpanded] = useState<string | null>("resolution");

  return (
    <div className="flex w-full max-w-xl flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
          <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3 text-accent">
            <path
              d="M6 1.6l1 2.9 2.9 1-2.9 1-1 2.9-1-2.9-2.9-1 2.9-1 1-2.9z"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinejoin="round"
            />
          </svg>
          Generated insights
        </p>
        <p className="font-mono text-[10px] text-ink-faint">Updated 06:00</p>
      </div>

      {insights.map((insight) => {
        const up = insight.change > 0;
        const good = up === insight.positiveIsGood;
        const tone = good ? "text-green" : "text-red";
        const toneBg = good
          ? "bg-green-tint text-green"
          : "bg-red-tint text-red";
        const isOpen = expanded === insight.id;

        return (
          <button
            key={insight.id}
            type="button"
            onClick={() => setExpanded(isOpen ? null : insight.id)}
            aria-expanded={isOpen}
            className="rounded-xl border border-line bg-surface p-4 text-left transition-colors hover:border-ink-faint/40"
          >
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <p className="mb-1 truncate text-[11px] text-ink-muted">
                  {insight.label}
                </p>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-semibold tracking-tight text-ink tabular-nums">
                    {insight.value}
                  </span>
                  <span
                    className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-mono text-[10px] ${toneBg}`}
                  >
                    <TrendArrow up={up} />
                    {up ? "+" : "−"}
                    {Math.abs(insight.change).toFixed(1)}%
                  </span>
                </div>
              </div>
              <div className={`w-28 shrink-0 ${tone}`}>
                <Sparkline series={insight.series} />
                <p className="mt-1 text-right font-mono text-[9px] text-ink-faint">
                  {insight.window}
                </p>
              </div>
            </div>

            <div
              className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out-strong ${
                isOpen
                  ? "grid-rows-[1fr] opacity-100"
                  : "grid-rows-[0fr] opacity-0"
              }`}
            >
              <div className="overflow-hidden">
                <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-muted">
                  {insight.summary}
                </p>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
