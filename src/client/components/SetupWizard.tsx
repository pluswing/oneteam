import { ArrowLeft, Save } from "lucide-react";
import { FormEvent, useState } from "react";
import type { ProjectDto } from "../../shared/types";
import { api } from "../api";
import oneTeamLogoUrl from "../assets/oneteam.svg";
import { t } from "../i18n";

export function SetupWizard(props: { onCancel?: () => void; onCreated: (project: ProjectDto) => void }) {
  const [mode, setMode] = useState<"import" | "create">("import");
  const [name, setName] = useState("one team");
  const [repoPath, setRepoPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
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
        locale: "en"
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

        {error ? <div className="error-banner">{error}</div> : null}
        <div className="action-row">
          {props.onCancel ? (
            <button className="secondary-button" disabled={isSubmitting} onClick={props.onCancel} type="button">
              <ArrowLeft size={16} />
              {t("actions.cancel")}
            </button>
          ) : null}
          <button className="primary-button" disabled={isSubmitting} type="submit">
            <Save size={16} />
            {t("setup.createProject")}
          </button>
        </div>
      </form>
    </main>
  );
}
