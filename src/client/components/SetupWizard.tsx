import { FolderOpen, LoaderCircle } from "lucide-react";
import { type DragEvent, type FormEvent, useState } from "react";
import { api, type ProjectOpenResult } from "../api";
import logoMarkUrl from "../assets/logo.svg";
import { getLocale, t } from "../i18n";

export function SetupWizard(props: { onOpened: (result: ProjectOpenResult) => void }) {
  const [repoPath, setRepoPath] = useState("");
  const [isDragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);

  async function openRepository(path: string): Promise<void> {
    const normalizedPath = path.trim();
    if (!normalizedPath || isSubmitting) return;
    setError(null);
    setSubmitting(true);
    try {
      props.onOpened(await api.createProject({ repoPath: normalizedPath, locale: getLocale() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setup.openFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function chooseDirectory(): Promise<void> {
    if (!window.oneTeamDesktop || isSubmitting) return;
    const path = await window.oneTeamDesktop.chooseDirectory();
    if (path) {
      setRepoPath(path);
      await openRepository(path);
    }
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (!file) {
      setError(t("setup.dropError"));
      return;
    }
    const entry = event.dataTransfer.items[0]?.webkitGetAsEntry?.();
    if (entry && !entry.isDirectory) {
      setError(t("setup.folderOnly"));
      return;
    }
    const path = window.oneTeamDesktop?.getDroppedPath(file) ?? "";
    if (!path) {
      setError(t("setup.browserDropUnsupported"));
      return;
    }
    setRepoPath(path);
    await openRepository(path);
  }

  function handleManualSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void openRepository(repoPath);
  }

  return (
    <main className="setup-screen">
      <section className="setup-panel folder-setup-panel">
        <div className="setup-logo">
          <img src={logoMarkUrl} alt="" />
          <span>{t("app.name")}</span>
        </div>
        <h1>{t("setup.title")}</h1>
        <p className="setup-description">{t("setup.description")}</p>
        <div
          aria-label={t("setup.dropZoneLabel")}
          className={`folder-drop-zone${isDragging ? " dragging" : ""}${isSubmitting ? " submitting" : ""}`}
          onClick={() => void chooseDirectory()}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(event) => void handleDrop(event)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void chooseDirectory();
            }
          }}
          role="button"
          tabIndex={0}
        >
          {isSubmitting ? <LoaderCircle className="spin-icon" size={44} /> : <FolderOpen size={44} />}
          <strong>{isSubmitting ? t("setup.importing") : t("setup.dropFolder")}</strong>
          <span>{window.oneTeamDesktop ? t("setup.orChooseFolder") : t("setup.desktopDropHint")}</span>
          {repoPath ? <code>{repoPath}</code> : null}
        </div>
        {!window.oneTeamDesktop ? (
          <details className="browser-path-fallback">
            <summary>{t("setup.browserFallback")}</summary>
            <form onSubmit={handleManualSubmit}>
              <label>
                {t("setup.path")}
                <input
                  disabled={isSubmitting}
                  onChange={(event) => setRepoPath(event.target.value)}
                  placeholder={t("setup.pathPlaceholder")}
                  required
                  value={repoPath}
                />
              </label>
              <button className="primary-button" disabled={isSubmitting} type="submit">
                <FolderOpen size={16} />
                {t("setup.openFolder")}
              </button>
            </form>
          </details>
        ) : null}
        {error ? <div className="error-banner">{error}</div> : null}
        <p className="setup-defaults-note">{t("setup.defaultsNote")}</p>
      </section>
    </main>
  );
}
