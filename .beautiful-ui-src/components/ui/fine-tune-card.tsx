"use client";

import { useState } from "react";

type Settings = {
  temperature: number;
  verbosity: number;
  citations: number;
};

type PresetId = "precise" | "balanced" | "creative";

const presets: { id: PresetId; label: string; values: Settings }[] = [
  { id: "precise", label: "Precise", values: { temperature: 12, verbosity: 25, citations: 90 } },
  { id: "balanced", label: "Balanced", values: { temperature: 45, verbosity: 55, citations: 60 } },
  { id: "creative", label: "Creative", values: { temperature: 88, verbosity: 78, citations: 25 } },
];

const controls: {
  key: keyof Settings;
  label: string;
  low: string;
  high: string;
  format: (v: number) => string;
}[] = [
  {
    key: "temperature",
    label: "Temperature",
    low: "literal",
    high: "inventive",
    format: (v) => (v / 100).toFixed(2),
  },
  {
    key: "verbosity",
    label: "Verbosity",
    low: "terse",
    high: "expansive",
    format: (v) => (v < 34 ? "short" : v < 67 ? "medium" : "long"),
  },
  {
    key: "citations",
    label: "Source strictness",
    low: "loose",
    high: "every claim",
    format: (v) => `${v}%`,
  },
];

function DialIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
      <path d="M3 5.5h4.2M10.8 5.5H13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3 10.5h2.2M8.8 10.5H13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="9" cy="5.5" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7" cy="10.5" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function FineTuneCardDemo() {
  const [settings, setSettings] = useState<Settings>(presets[1].values);

  const activePreset = presets.find(
    (p) =>
      p.values.temperature === settings.temperature &&
      p.values.verbosity === settings.verbosity &&
      p.values.citations === settings.citations,
  );

  return (
    <div className="w-full max-w-md">
      <div className="rounded-2xl border border-line bg-surface">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="flex items-center gap-2 text-ink-muted">
            <DialIcon />
            <span className="text-[13.5px] font-medium text-ink">
              Response tuning
            </span>
          </div>
          <span className="font-mono text-[11px] text-ink-faint">
            {activePreset ? activePreset.label.toLowerCase() : "custom"}
          </span>
        </div>

        <div className="px-5 py-4">
          <div className="flex gap-1.5">
            {presets.map((preset) => {
              const isActive = activePreset?.id === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setSettings(preset.values)}
                  className={`flex-1 rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-200 ${
                    isActive
                      ? "border-accent/50 bg-accent-tint text-accent-ink"
                      : "border-line bg-field text-ink-muted hover:text-ink"
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          <div className="mt-5 space-y-5">
            {controls.map((control) => {
              const value = settings[control.key];
              return (
                <div key={control.key}>
                  <div className="flex items-baseline justify-between gap-3">
                    <label
                      htmlFor={`tune-${control.key}`}
                      className="text-[13px] font-medium text-ink"
                    >
                      {control.label}
                    </label>
                    <span className="font-mono text-[12px] text-accent transition-colors duration-200">
                      {control.format(value)}
                    </span>
                  </div>
                  <input
                    id={`tune-${control.key}`}
                    type="range"
                    min={0}
                    max={100}
                    value={value}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        [control.key]: Number(e.target.value),
                      }))
                    }
                    className="mt-2 w-full cursor-pointer accent-accent outline-none"
                  />
                  <div className="mt-1.5 flex justify-between font-mono text-[10.5px] uppercase tracking-wide text-ink-faint">
                    <span>{control.low}</span>
                    <span>{control.high}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="border-t border-line px-5 py-3 text-[12.5px] text-ink-muted">
          Preview:{" "}
          <span className="text-ink">
            {settings.temperature > 70
              ? "loose, idea-first answers"
              : settings.temperature < 25
                ? "tight, deterministic answers"
                : "steady answers with a little range"}
            {settings.citations > 70 ? ", every claim sourced" : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
