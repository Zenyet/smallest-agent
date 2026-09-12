"use client";

import { useState } from "react";

type NavItem = {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: string;
};

function IconSpark() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 shrink-0">
      <path
        d="M10 3.5l1.5 3.9 3.9 1.5-3.9 1.5L10 14.3 8.5 10.4 4.6 8.9l3.9-1.5L10 3.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconLayers() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 shrink-0">
      <path
        d="M10 3.2l6 3.1-6 3.1-6-3.1 6-3.1z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M4 11l6 3.1 6-3.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconInbox() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 shrink-0">
      <rect
        x="3.2"
        y="4.4"
        width="13.6"
        height="11.2"
        rx="2.2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M3.4 11.2h3.2l1 1.8h4.8l1-1.8h3.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconGauge() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 shrink-0">
      <path
        d="M4 14a6.6 6.6 0 1112 0"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M10 13.4l3-3.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconTools() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 shrink-0">
      <path
        d="M12.6 4.3a3.4 3.4 0 00-4.2 4.3l-4 4a1.6 1.6 0 002.2 2.2l4-4a3.4 3.4 0 004.3-4.2l-2 2-1.9-.4-.4-1.9 2-2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const navItems: NavItem[] = [
  { id: "threads", label: "Threads", icon: <IconSpark /> },
  { id: "library", label: "Library", icon: <IconLayers />, badge: "12" },
  { id: "inbox", label: "Review queue", icon: <IconInbox />, badge: "3" },
  { id: "usage", label: "Usage", icon: <IconGauge /> },
  { id: "tools", label: "Tools", icon: <IconTools /> },
];

const recentChats = [
  { id: "r1", title: "Migrate billing webhooks", when: "2m" },
  { id: "r2", title: "Draft onboarding email", when: "1h" },
  { id: "r3", title: "Why is p95 latency spiking?", when: "Yesterday" },
  { id: "r4", title: "Summarize Q3 support tickets", when: "Tue" },
];

const workspaces = [
  { id: "w1", name: "Kestrel Labs", plan: "Team" },
  { id: "w2", name: "Personal", plan: "Free" },
  { id: "w3", name: "Northwind Ops", plan: "Enterprise" },
];

export function SidebarNavDemo() {
  const [collapsed, setCollapsed] = useState(false);
  const [active, setActive] = useState("threads");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspace, setWorkspace] = useState(workspaces[0]);

  return (
    <div className="w-full max-w-xl">
      <div className="flex h-[26rem] overflow-hidden rounded-xl border border-line bg-canvas">
        {/* Sidebar */}
        <aside
          className={`relative flex shrink-0 flex-col overflow-hidden border-r border-line bg-surface transition-[width] duration-300 ease-out-strong ${
            collapsed ? "w-[3.75rem]" : "w-56"
          }`}
        >
          {/* Workspace switcher */}
          <div className="relative p-2">
            <button
              type="button"
              onClick={() => !collapsed && setWorkspaceOpen((v) => !v)}
              aria-expanded={workspaceOpen}
              className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left transition-colors hover:bg-field"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-[11px] font-semibold text-white">
                {workspace.name.slice(0, 2).toUpperCase()}
              </span>
              <span
                className={`min-w-0 flex-1 transition-opacity duration-200 ${
                  collapsed ? "pointer-events-none opacity-0" : "opacity-100"
                }`}
              >
                <span className="block truncate text-[13px] font-medium whitespace-nowrap text-ink">
                  {workspace.name}
                </span>
                <span className="block font-mono text-[10px] whitespace-nowrap text-ink-faint">
                  {workspace.plan}
                </span>
              </span>
              <svg
                viewBox="0 0 16 16"
                fill="none"
                className={`h-3.5 w-3.5 shrink-0 text-ink-faint transition-opacity duration-200 ${
                  collapsed ? "opacity-0" : "opacity-100"
                }`}
              >
                <path
                  d="M5.5 6.8L8 4.5l2.5 2.3M5.5 9.2L8 11.5l2.5-2.3"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {workspaceOpen && !collapsed && (
              <div className="absolute inset-x-2 top-full z-10 mt-1 overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
                {workspaces.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => {
                      setWorkspace(w);
                      setWorkspaceOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-[12px] transition-colors hover:bg-field ${
                      w.id === workspace.id ? "text-accent" : "text-ink"
                    }`}
                  >
                    <span className="truncate">{w.name}</span>
                    <span className="font-mono text-[10px] text-ink-faint">
                      {w.plan}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mx-2 border-t border-line" />

          {/* Nav items */}
          <nav className="flex flex-col gap-0.5 p-2">
            {navItems.map((item) => {
              const isActive = item.id === active;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActive(item.id)}
                  title={collapsed ? item.label : undefined}
                  className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors ${
                    isActive
                      ? "bg-accent-tint text-accent-ink"
                      : "text-ink-muted hover:bg-field hover:text-ink"
                  }`}
                >
                  <span className="grid w-5 shrink-0 place-items-center">
                    {item.icon}
                  </span>
                  <span
                    className={`flex-1 truncate text-left whitespace-nowrap transition-opacity duration-200 ${
                      collapsed ? "pointer-events-none opacity-0" : "opacity-100"
                    }`}
                  >
                    {item.label}
                  </span>
                  {item.badge && (
                    <span
                      className={`rounded-full bg-field px-1.5 font-mono text-[10px] text-ink-faint transition-opacity duration-200 ${
                        collapsed ? "opacity-0" : "opacity-100"
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Recent chats */}
          <div
            className={`min-h-0 flex-1 overflow-hidden px-2 transition-opacity duration-200 ${
              collapsed ? "pointer-events-none opacity-0" : "opacity-100"
            }`}
          >
            <p className="px-2 pt-2 pb-1 font-mono text-[10px] tracking-wide whitespace-nowrap text-ink-faint uppercase">
              Recent chats
            </p>
            <div className="flex flex-col gap-0.5">
              {recentChats.map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-field"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-line transition-colors group-hover:bg-accent" />
                  <span className="min-w-0 flex-1 truncate text-[12px] whitespace-nowrap text-ink-muted group-hover:text-ink">
                    {chat.title}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                    {chat.when}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Collapse toggle */}
          <div className="border-t border-line p-2">
            <button
              type="button"
              onClick={() => {
                setCollapsed((v) => !v);
                setWorkspaceOpen(false);
              }}
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-ink-faint transition-colors hover:bg-field hover:text-ink"
            >
              <span className="grid w-5 shrink-0 place-items-center">
                <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
                  <rect
                    x="3"
                    y="4.4"
                    width="14"
                    height="11.2"
                    rx="2.2"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                  <path
                    d="M8 4.6v10.8"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                  <path
                    d={collapsed ? "M11.4 8.3L13.2 10l-1.8 1.7" : "M13.2 8.3L11.4 10l1.8 1.7"}
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span
                className={`text-[12px] whitespace-nowrap transition-opacity duration-200 ${
                  collapsed ? "pointer-events-none opacity-0" : "opacity-100"
                }`}
              >
                Collapse
              </span>
            </button>
          </div>
        </aside>

        {/* Mock content pane */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <span className="text-[13px] font-medium text-ink">
              {navItems.find((n) => n.id === active)?.label}
            </span>
            <span className="rounded-full bg-field px-2 py-0.5 font-mono text-[10px] text-ink-faint">
              {workspace.name}
            </span>
          </div>
          <div className="flex-1 space-y-3 p-4">
            <div className="h-2.5 w-3/4 rounded-full bg-line/70" />
            <div className="h-2.5 w-1/2 rounded-full bg-line/70" />
            <div className="rounded-lg border border-line bg-surface p-3">
              <div className="mb-2 h-2.5 w-2/3 rounded-full bg-line/70" />
              <div className="h-2.5 w-1/3 rounded-full bg-line/70" />
            </div>
            <div className="h-2.5 w-5/6 rounded-full bg-line/70" />
            <div className="h-2.5 w-2/5 rounded-full bg-line/70" />
          </div>
        </div>
      </div>
    </div>
  );
}
