import { ArrowLeft, Save } from "lucide-react";
import { FormEvent, useState } from "react";
import type { AiProvider } from "../../shared/ai-providers";
import { aiProviderLabel, aiProviders } from "../../shared/ai-providers";
import type { SupportedLocale } from "../../shared/locales";
import { localeLabel, supportedLocales } from "../../shared/locales";
import type { ProjectDto } from "../../shared/types";
import { api } from "../api";
import logoMarkUrl from "../assets/logo.svg";
import { getLocale, setLocale as setUiLocale, t } from "../i18n";

export function SetupWizard(props: { onCancel?: () => void; onCreated: (project: ProjectDto) => void }) {
  const [mode, setMode] = useState<"import" | "create">("import");
  const [name, setName] = useState("OneTeam");
  const [repoPath, setRepoPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [locale, setLocale] = useState<SupportedLocale>(getLocale());
  const [aiProvider, setAiProvider] = useState<AiProvider>("codex");
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
        locale,
        aiProvider
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
          <img src={logoMarkUrl} alt="" />
          <span>{t("app.name")}</span>
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
          <label>
            {t("setup.locale")}
            <select
              value={locale}
              onChange={(event) => {
                const nextLocale = event.target.value as SupportedLocale;
                setLocale(nextLocale);
                setUiLocale(nextLocale);
              }}
            >
              {supportedLocales.map((item) => (
                <option key={item} value={item}>
                  {localeLabel(item)}
                </option>
              ))}
            </select>
          </label>
        </section>
        <section className="form-section">
          <h2>{t("setup.aiTool")}</h2>
          <label>
            {t("setup.provider")}
            <select value={aiProvider} onChange={(event) => setAiProvider(event.target.value as AiProvider)}>
              {aiProviders.map((provider) => (
                <option key={provider} value={provider}>
                  {aiProviderLabel(provider)}
                </option>
              ))}
            </select>
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
