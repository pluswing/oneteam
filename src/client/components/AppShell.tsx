import { Bot, CheckCircle2, CircleAlert, GitPullRequest, ListTodo, RotateCcw, Settings, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentHeaderState } from "../agent-status";
import logoMarkUrl from "../assets/logo.svg";
import { t } from "../i18n";
import type { View } from "../routes";

export function AppShell(props: {
  view: View;
  onViewChange: (view: View) => void;
  agentState: AgentHeaderState;
  children: React.ReactNode;
}) {
  const [isSettingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement | null>(null);
  const nav = [
    { view: "issues" as const, label: t("nav.issues"), icon: ListTodo },
    { view: "pullRequests" as const, label: t("nav.pullRequests"), icon: GitPullRequest },
    { view: "agentJobs" as const, label: t("nav.agentJobs"), icon: Bot }
  ];
  const settingsNav = [
    { view: "repository" as const, label: t("nav.repository"), icon: Terminal },
    { view: "settings" as const, label: t("nav.settings"), icon: Settings }
  ];

  useEffect(() => {
    if (!isSettingsMenuOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && settingsMenuRef.current?.contains(target)) {
        return;
      }
      setSettingsMenuOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isSettingsMenuOpen]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="header-logo" aria-hidden="true">
          <img src={logoMarkUrl} alt="" />
        </div>
        <nav className="nav-tabs" aria-label="Primary">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={props.view === item.view ? "nav-tab active" : "nav-tab"}
                key={item.view}
                onClick={() => props.onViewChange(item.view)}
                type="button"
              >
                <Icon size={16} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className={`agent-state agent-state-${props.agentState.status}`} title={props.agentState.title}>
          {props.agentState.status === "ready" ? <CheckCircle2 size={16} /> : null}
          {props.agentState.status === "running" ? <RotateCcw size={16} /> : null}
          {props.agentState.status === "queued" ? <Bot size={16} /> : null}
          {props.agentState.status === "waiting" || props.agentState.status === "failed" ? <CircleAlert size={16} /> : null}
          {props.agentState.label}
        </div>
        <div className="settings-menu" ref={settingsMenuRef}>
          <button
            aria-expanded={isSettingsMenuOpen}
            aria-haspopup="menu"
            aria-label={t("nav.tools")}
            className={props.view === "repository" || props.view === "settings" ? "settings-menu-button active" : "settings-menu-button"}
            onClick={() => setSettingsMenuOpen((current) => !current)}
            type="button"
          >
            <Settings size={18} />
          </button>
          {isSettingsMenuOpen ? (
            <div className="settings-menu-popover" role="menu">
              {settingsNav.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    className={props.view === item.view ? "settings-menu-item active" : "settings-menu-item"}
                    key={item.view}
                    onClick={() => {
                      props.onViewChange(item.view);
                      setSettingsMenuOpen(false);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <Icon size={16} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </header>
      <main className="main">{props.children}</main>
    </div>
  );
}
