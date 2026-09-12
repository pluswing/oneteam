# Introduction-page screenshots

The `issue`, `pull-request`, `agent`, and `retrospective` images with `-en` / `-ja` suffixes are captured from the real Electron renderer. Each locale uses a fresh, isolated **Field Notes · Demo** workspace.

The scenario includes a completed empty-search improvement (Issue / Loop / PR #1), tag filtering in review (#2), and two queued follow-ups. Jobs, model selections, logs, and progress are illustrative sample data, not records of live LLM execution. The sample repository has real Git commits and a merge, and its 10 search tests actually run. The retrospective service saves the sample guidance and its before/after history to `.oneteam`.

- **Issue:** request, acceptance criteria, related PR, and current Loop progress.
- **Pull request:** the tag-filter implementation and its test changes.
- **Agent:** the actual model-history and activity section of the review job.
- **Retrospective:** the expanded Loop #1 card, including the applied `AGENTS.md` revision.

The last two images capture the relevant UI elements directly. Images are not composites or generated mockups. Captions on both introduction pages identify the sample data.

To recapture on macOS from a development checkout:

```sh
npm install
npm run docs:screenshots
```

The command builds OneTeam, creates temporary sample repositories, launches Electron with its worker disabled, captures eight PNGs, and removes its temporary workspaces. It does not run Codex tasks or modify the user's active workspace. A Codex connection label may reflect the local login status; sample model names do not assert account availability.

The older, unsuffixed images in this directory are retained for historical documentation and are not used by the current introduction pages.
