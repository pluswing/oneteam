import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { t } from "../i18n";

const AgentLogDisplayContext = createContext<{ showDetails: boolean; setShowDetails: (show: boolean) => void } | null>(null);

export function AgentLogDisplayProvider({ children }: { children: ReactNode }) {
  const [showDetails, setShowDetails] = useState(false);
  const value = useMemo(() => ({ showDetails, setShowDetails }), [showDetails]);
  return <AgentLogDisplayContext.Provider value={value}>{children}</AgentLogDisplayContext.Provider>;
}

export function useAgentLogDisplay() {
  const value = useContext(AgentLogDisplayContext);
  if (!value) throw new Error("Agent log display requires its provider.");
  return value;
}

export function AgentLogToggle() {
  const { showDetails, setShowDetails } = useAgentLogDisplay();
  return <label className="agent-log-toggle">
    <input type="checkbox" checked={showDetails} onChange={(event) => setShowDetails(event.target.checked)} />
    <span>{t("agents.showDetailedLogs")}</span>
  </label>;
}
