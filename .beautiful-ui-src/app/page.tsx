import { Section } from "@/components/showcase/Section";
import { sections } from "@/components/showcase/sections";
import { LoadingStateDemo } from "@/components/ui/loading-state";
import { ThinkingStateDemo } from "@/components/ui/thinking-state";
import { StreamingTextDemo } from "@/components/ui/streaming-text";
import { ChatComposerDemo } from "@/components/ui/chat-composer";
import { PromptBarDemo } from "@/components/ui/prompt-bar";
import { DiffTableDemo } from "@/components/ui/diff-table";
import { RecordsTableDemo } from "@/components/ui/records-table";
import { FilterTableDemo } from "@/components/ui/filter-table";
import { ContextCardsDemo } from "@/components/ui/context-cards";
import { RecommendationCardDemo } from "@/components/ui/recommendation-card";
import { ApprovalCardDemo } from "@/components/ui/approval-card";
import { ToolChipsDemo } from "@/components/ui/tool-chips";
import { TaskRowsDemo } from "@/components/ui/task-rows";
import { SelectionActionsDemo } from "@/components/ui/selection-actions";
import { FineTuneCardDemo } from "@/components/ui/fine-tune-card";
import { SidebarNavDemo } from "@/components/ui/sidebar-nav";
import { SearchDemo } from "@/components/ui/search";
import { InsightCardsDemo } from "@/components/ui/insight-cards";
import { CodeBlockDemo } from "@/components/ui/code-block";

function Placeholder() {
  return (
    <p className="text-sm text-ink-faint font-mono">Component coming soon</p>
  );
}

const demos: Record<string, React.ComponentType> = {
  "loading-state": LoadingStateDemo,
  "thinking-state": ThinkingStateDemo,
  "streaming-text": StreamingTextDemo,
  "chat-composer": ChatComposerDemo,
  "prompt-bar": PromptBarDemo,
  "diff-table": DiffTableDemo,
  "records-table": RecordsTableDemo,
  "filter-table": FilterTableDemo,
  "context-cards": ContextCardsDemo,
  "recommendation-card": RecommendationCardDemo,
  "approval-card": ApprovalCardDemo,
  "tool-chips": ToolChipsDemo,
  "task-rows": TaskRowsDemo,
  "selection-actions": SelectionActionsDemo,
  "fine-tune-card": FineTuneCardDemo,
  "sidebar-nav": SidebarNavDemo,
  "search": SearchDemo,
  "insight-cards": InsightCardsDemo,
  "code-block": CodeBlockDemo,
};

export default function Home() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <header className="pt-20 pb-14">
        <p className="font-mono text-xs text-accent mb-4">beautiful-ui</p>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight mb-4">
          Components for AI-native interfaces
        </h1>
        <p className="text-ink-muted leading-relaxed max-w-lg mb-8">
          Nineteen open-source component patterns for AI-powered products —
          loading, streaming, approvals, tables, and more. Built with Next.js
          and Tailwind CSS.
        </p>
        <nav className="flex flex-wrap gap-x-4 gap-y-2">
          {sections.map((s, i) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="font-mono text-xs text-ink-muted hover:text-accent transition-colors"
            >
              {String(i + 1).padStart(2, "0")} {s.title}
            </a>
          ))}
        </nav>
      </header>

      <main>
        {sections.map((s, i) => {
          const Demo = demos[s.id] ?? Placeholder;
          return (
            <Section
              key={s.id}
              index={i + 1}
              id={s.id}
              title={s.title}
              description={s.description}
            >
              <Demo />
            </Section>
          );
        })}
      </main>

      <footer className="py-14 border-t border-line text-sm text-ink-faint">
        <p>
          Open source under the MIT license. Component patterns inspired by
          Beautiful UI by Turbo Design Studio; all code and copy here are
          original.
        </p>
      </footer>
    </div>
  );
}
