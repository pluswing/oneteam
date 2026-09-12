import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffViewer } from "../client/components/DiffViewer";
import { setLocale } from "../client/i18n";

describe("DiffViewer component", () => {
  it("keeps its keyboard and ARIA contract in the rendered snapshot", () => {
    setLocale("en");
    const html = renderToStaticMarkup(
      <DiffViewer
        files={[
          { path: "src/first.ts", status: "M", additions: 2, deletions: 1 },
          { path: "src/second.ts", status: "A", additions: 4, deletions: 0 }
        ]}
        findings={[]}
        lineComments={[]}
        projectId="project-1"
        pullRequestId={7}
        sourceCommit="source"
        targetCommit="target"
      />
    );

    const snapshot = {
      changedFilesNavigation: html.includes('<nav aria-label="Files changed" class="diff-file-list">'),
      fileButtons: html.match(/data-file-index=/g)?.length ?? 0,
      selectedFile: html.includes('aria-current="true"'),
      singleTabStop: (html.match(/tabindex="0"/g)?.length ?? 0) === 1,
      splitPressed: html.includes('aria-pressed="false" class=""'),
      unifiedPressed: html.includes('aria-pressed="true" class="active"')
    };

    expect(snapshot).toMatchInlineSnapshot(`
      {
        "changedFilesNavigation": true,
        "fileButtons": 2,
        "selectedFile": true,
        "singleTabStop": true,
        "splitPressed": true,
        "unifiedPressed": true,
      }
    `);
  });
});
