import type { ReactNode } from "react";

type SectionProps = {
  index: number;
  id: string;
  title: string;
  description: string;
  children: ReactNode;
};

export function Section({ index, id, title, description, children }: SectionProps) {
  return (
    <section id={id} className="scroll-mt-24 py-14 border-t border-line first:border-t-0">
      <div className="mb-8 max-w-xl">
        <p className="font-mono text-xs text-ink-faint mb-2">
          {String(index).padStart(2, "0")}
        </p>
        <h2 className="text-xl font-semibold tracking-tight mb-2">{title}</h2>
        <p className="text-sm text-ink-muted leading-relaxed">{description}</p>
      </div>
      <div className="rounded-2xl border border-line bg-surface p-6 sm:p-10 flex items-center justify-center min-h-64">
        {children}
      </div>
    </section>
  );
}
