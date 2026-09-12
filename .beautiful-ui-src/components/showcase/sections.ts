export type SectionMeta = {
  id: string;
  title: string;
  description: string;
};

export const sections: SectionMeta[] = [
  {
    id: "loading-state",
    title: "Loading State",
    description:
      "A calm placeholder shown while the model spins up — keeps layout stable and signals progress without stealing attention.",
  },
  {
    id: "thinking-state",
    title: "Thinking",
    description:
      "Reveals the assistant's intermediate reasoning steps as a collapsible timeline, so users can see work happening in real time.",
  },
  {
    id: "streaming-text",
    title: "Streaming Text",
    description:
      "Token-by-token response rendering with a soft cursor, tuned so text stays readable while it arrives.",
  },
  {
    id: "approval-card",
    title: "Approval Card",
    description:
      "A human-in-the-loop checkpoint: the agent proposes an action and the user approves, edits, or rejects it before anything runs.",
  },
  {
    id: "tool-chips",
    title: "Tool Chips",
    description:
      "Compact chips that show which tools the agent invoked, with status and expandable detail per call.",
  },
  {
    id: "task-rows",
    title: "Task Rows",
    description:
      "A live task list the agent updates as it works — pending, running, and completed states at a glance.",
  },
  {
    id: "chat-composer",
    title: "Chat Composer",
    description:
      "A multiline message input with attachments, model picker, and send affordances that grow with the draft.",
  },
  {
    id: "prompt-bar",
    title: "Prompt Bar",
    description:
      "A single-line command surface with suggested prompts, ideal as the entry point to an AI feature.",
  },
  {
    id: "recommendation-card",
    title: "Recommendation Card",
    description:
      "Surfaces a model-generated suggestion with the reasoning behind it and one-tap accept or dismiss.",
  },
  {
    id: "context-cards",
    title: "Context Cards",
    description:
      "Shows the sources the assistant is drawing from — files, pages, and records — so answers stay traceable.",
  },
  {
    id: "diff-table",
    title: "Diff Table",
    description:
      "Before-and-after comparison of values the agent wants to change, with per-row accept controls.",
  },
  {
    id: "records-table",
    title: "Records Table",
    description:
      "A dense data table with AI-enriched cells, inline confidence hints, and row-level actions.",
  },
  {
    id: "filter-table",
    title: "Filter Table",
    description:
      "Natural-language filtering translated into visible filter chips above a live-updating table.",
  },
  {
    id: "sidebar-nav",
    title: "Sidebar Nav",
    description:
      "A collapsible navigation rail with conversation history, pinned items, and workspace switching.",
  },
  {
    id: "search",
    title: "Search",
    description:
      "A command-palette style search that blends keyword matches with semantic results and recent activity.",
  },
  {
    id: "insight-cards",
    title: "Insight Cards",
    description:
      "Auto-generated insights with trend indicators and sparkline context, ready to drop into a dashboard.",
  },
  {
    id: "code-block",
    title: "Code Block",
    description:
      "Syntax-aware code output with copy, language label, and line highlighting for agent-generated code.",
  },
  {
    id: "fine-tune-card",
    title: "Fine-tune Card",
    description:
      "Tune model behavior with labeled sliders and presets — temperature, verbosity, and tone in one card.",
  },
  {
    id: "selection-actions",
    title: "Selection Actions",
    description:
      "A floating toolbar that appears on text selection, offering AI actions like rewrite, summarize, and explain.",
  },
];
