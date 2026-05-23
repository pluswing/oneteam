import { Save } from "lucide-react";
import { FormEvent, useState } from "react";
import type { ProjectDto } from "../../shared/types";
import { defaultCodexCommand } from "../../shared/codex";
import { api } from "../api";
import oneTeamLogoUrl from "../assets/oneteam.svg";
import { t } from "../i18n";

export function SetupWizard(props: { onCreated: (project: ProjectDto) => void }) {
  const [mode, setMode] = useState<"import" | "create">("import");
  const [name, setName] = useState("one team");
  const [repoPath, setRepoPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [codexCommand, setCodexCommand] = useState(defaultCodexCommand);
  const [codexModel, setCodexModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const project = await api.createProject({
        mode,
        name,
        repoPath,
        defaultBranch,
        locale: "en",
        codex: {
          command: codexCommand,
          model: codexModel || undefined,
          fullAccess: true
        }
      });
      props.onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="setup-screen">
      <form className="setup-panel" onSubmit={handleSubmit}>
        <div className="setup-logo">
          <img src={oneTeamLogoUrl} alt={t("app.name")} />
        </div>
        <h1>{t("setup.title")}</h1>
        <section className="form-section">
          <h2>{t("setup.repository")}</h2>
          <label>
            {t("setup.mode")}
            <select value={mode} onChange={(event) => setMode(event.target.value as "import" | "create")}>
              <option value="import">{t("setup.importMode")}</option>
              <option value="create">{t("setup.createMode")}</option>
            </select>
          </label>
          <label>
            {t("setup.name")}
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            {t("setup.path")}
            <input value={repoPath} onChange={(event) => setRepoPath(event.target.value)} required />
          </label>
          <label>
            {t("setup.defaultBranch")}
            <input value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} required />
          </label>
        </section>

        <section className="form-section">
          <h2>{t("setup.codex")}</h2>
          <label>
            {t("setup.command")}
            <input value={codexCommand} onChange={(event) => setCodexCommand(event.target.value)} required />
          </label>
          <label>
            {t("setup.model")}
            <input value={codexModel} onChange={(event) => setCodexModel(event.target.value)} />
          </label>
          <label className="checkbox-label">
            <input checked readOnly type="checkbox" />
            {t("setup.fullAccess")}
          </label>
        </section>

        {error ? <div className="error-banner">{error}</div> : null}
        <button className="primary-button" disabled={isSubmitting} type="submit">
          <Save size={16} />
          {t("setup.createProject")}
        </button>
      </form>
    </main>
  );
}
