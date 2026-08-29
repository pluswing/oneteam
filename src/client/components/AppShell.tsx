import { BookOpen, Bot, CheckCircle2, CircleAlert, FolderOpen, GitPullRequest, ListTodo, RotateCcw, Settings, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentHeaderState } from "../agent-status";
import logoMarkUrl from "../assets/logo.svg";
import { t } from "../i18n";
import type { View } from "../routes";

export function AppShell(props: {
  view: View;
  navigationKey: string;
  onViewChange: (view: View) => void;
  onSwitchProject: () => void;
  agentState: AgentHeaderState;
  projectName: string;
  repositoryPath: string;
  children: React.ReactNode;
}) {
  const [isSettingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement | null>(null);
  const settingsMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const previousNavigationKey = useRef(props.navigationKey);
  const nav = [
    { view: "issues" as const, label: t("nav.issues"), icon: ListTodo },
    { view: "pullRequests" as const, label: t("nav.pullRequests"), icon: GitPullRequest },
    { view: "agentJobs" as const, label: t("nav.agentRuns"), icon: Bot },
    { view: "repository" as const, label: t("nav.repository"), icon: Terminal }
  ];
  const settingsNav = [
    { view: "loops" as const, label: t("nav.loops"), icon: RotateCcw },
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

  useEffect(() => {
    if (!isSettingsMenuOpen) return;
    settingsMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [isSettingsMenuOpen]);

  useEffect(() => {
    if (previousNavigationKey.current === props.navigationKey) return;
    previousNavigationKey.current = props.navigationKey;
    mainRef.current?.focus({ preventScroll: true });
  }, [props.navigationKey]);

  function handleSettingsMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setSettingsMenuOpen(false);
      settingsMenuButtonRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(settingsMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t("nav.skipToContent")}</a>
      <header className="topbar">
        <div className="header-brand" aria-label={t("app.name")}>
          <div className="header-logo" aria-hidden="true">
            <img src={logoMarkUrl} alt="" />
          </div>
          <span>{t("app.name")}</span>
        </div>
        <div className="topbar-spacer" />
        <div className={`agent-state agent-state-${props.agentState.status}`} title={props.agentState.title}>
          {props.agentState.status === "ready" ? <CheckCircle2 aria-hidden="true" size={16} /> : null}
          {props.agentState.status === "running" ? <RotateCcw aria-hidden="true" size={16} /> : null}
          {props.agentState.status === "queued" ? <Bot aria-hidden="true" size={16} /> : null}
          {props.agentState.status === "waiting" || props.agentState.status === "failed" ? <CircleAlert aria-hidden="true" size={16} /> : null}
          {props.agentState.label}
        </div>
        <div className="settings-menu" ref={settingsMenuRef}>
          <button
            aria-expanded={isSettingsMenuOpen}
            aria-haspopup="menu"
            aria-label={t("nav.tools")}
            className={props.view === "settings" ? "settings-menu-button active" : "settings-menu-button"}
            onClick={() => setSettingsMenuOpen((current) => !current)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSettingsMenuOpen(true);
              }
            }}
            ref={settingsMenuButtonRef}
            type="button"
          >
            <Settings aria-hidden="true" size={18} />
          </button>
          {isSettingsMenuOpen ? (
            <div className="settings-menu-popover" onKeyDown={handleSettingsMenuKeyDown} role="menu">
              <button
                className="settings-menu-item"
                onClick={() => {
                  props.onSwitchProject();
                  setSettingsMenuOpen(false);
                }}
                role="menuitem"
                type="button"
              >
                <FolderOpen aria-hidden="true" size={16} />
                <span>{t("nav.projects")}</span>
              </button>
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
                    <Icon aria-hidden="true" size={16} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </header>
      <header className="repository-header">
        <div className="repository-identity" title={props.repositoryPath}>
          <BookOpen aria-hidden="true" size={18} />
          <strong>{props.projectName}</strong>
          <span className="repository-visibility">{t("nav.localRepository")}</span>
          <span className="repository-path">{props.repositoryPath}</span>
        </div>
        <nav className="nav-tabs" aria-label={t("nav.repositoryNavigation")}>
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <button
                aria-current={props.view === item.view ? "page" : undefined}
                className={props.view === item.view ? "nav-tab active" : "nav-tab"}
                key={item.view}
                onClick={() => props.onViewChange(item.view)}
                type="button"
              >
                <Icon aria-hidden="true" size={16} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </header>
      <main className="main" id="main-content" ref={mainRef} tabIndex={-1}>{props.children}</main>
    </div>
  );
}
