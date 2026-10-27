import { BookOpen, Bot, CheckCircle2, CircleAlert, FolderOpen, GitPullRequest, ListTodo, MessageCircle, RotateCcw, ShieldCheck, Terminal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AgentHeaderState } from "../agent-status";
import logoMarkUrl from "../assets/logo.svg";
import { t } from "../i18n";
import { routeToPath, type AppRoute, type View } from "../routes";
import { AgentLogDisplayProvider } from "./AgentLogDisplay";

export function AppShell(props: {
  view: View;
  navigationKey: string;
  onViewChange: (view: View) => void;
  onNavigate: (route: AppRoute) => void;
  onOpenFolder: () => void;
  agentState: AgentHeaderState;
  projectName: string;
  repositoryPath: string;
  children: React.ReactNode;
}) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const [codexStatus, setCodexStatus] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => { void api.codexStatus().then((value) => { if (!disposed) setCodexStatus(value.status); }).catch(() => { if (!disposed) setCodexStatus(null); }); };
    refresh(); const timer = window.setInterval(refresh, 30_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  const previousNavigationKey = useRef(props.navigationKey);
  const nav = [
    { view: "chats" as const, label: t("nav.chats"), icon: MessageCircle },
    { view: "issues" as const, label: t("nav.issues"), icon: ListTodo },
    { view: "pullRequests" as const, label: t("nav.pullRequests"), icon: GitPullRequest },
    { view: "vulnerabilities" as const, label: t("nav.vulnerabilities"), icon: ShieldCheck },
    { view: "agentJobs" as const, label: t("nav.agentRuns"), icon: Bot },
    { view: "repository" as const, label: t("nav.repository"), icon: Terminal }
  ];

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const updateHeight = () => {
      document.documentElement.style.setProperty("--app-header-height", `${header.getBoundingClientRect().height}px`);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(header);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--app-header-height");
    };
  }, []);

  useEffect(() => {
    if (previousNavigationKey.current === props.navigationKey) return;
    previousNavigationKey.current = props.navigationKey;
    mainRef.current?.focus({ preventScroll: true });
  }, [props.navigationKey]);

  const agentStateContent = <>
    {props.agentState.status === "ready" ? <CheckCircle2 aria-hidden="true" size={16} /> : null}
    {props.agentState.status === "running" ? <RotateCcw aria-hidden="true" size={16} /> : null}
    {props.agentState.status === "queued" ? <Bot aria-hidden="true" size={16} /> : null}
    {props.agentState.status === "waiting" || props.agentState.status === "failed" ? <CircleAlert aria-hidden="true" size={16} /> : null}
    {props.agentState.label}
  </>;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t("nav.skipToContent")}</a>
      <div className="app-header" ref={headerRef}>
        <header className="topbar">
          <div className="header-brand" aria-label={t("app.name")}>
            <div className="header-logo" aria-hidden="true">
              <img src={logoMarkUrl} alt="" />
            </div>
            <span>{t("app.name")}</span>
          </div>
          <div className="topbar-spacer" />
          <span className="codex-connection" title={codexStatus === "login_required" ? t("development.loginHint") : "Codex"}>
            {codexStatus ? t(`development.codex_${codexStatus}`) : "Codex"}
          </span>
          {props.agentState.targetRoute ? (
            <a
              aria-label={`${props.agentState.label}: ${t("nav.openCurrentTask")}`}
              className={`agent-state agent-state-${props.agentState.status}`}
              href={routeToPath(props.agentState.targetRoute)}
              title={`${props.agentState.title} · ${t("nav.openCurrentTask")}`}
              onClick={(event) => {
                const target = props.agentState.targetRoute;
                if (!target || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                props.onNavigate(target);
                window.scrollTo({ top: 0 });
              }}
            >{agentStateContent}</a>
          ) : <span className={`agent-state agent-state-${props.agentState.status}`} title={props.agentState.title}>{agentStateContent}</span>}
          <button
            aria-label={t("nav.openFolder")}
            className="open-folder-button"
            onClick={props.onOpenFolder}
            title={t("nav.openFolder")}
            type="button"
          >
            <FolderOpen aria-hidden="true" size={18} />
          </button>
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
      </div>
      <main className="main" id="main-content" ref={mainRef} tabIndex={-1}>
        <AgentLogDisplayProvider>{props.children}</AgentLogDisplayProvider>
      </main>
    </div>
  );
}
