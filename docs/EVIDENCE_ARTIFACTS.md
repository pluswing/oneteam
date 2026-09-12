# Evidence artifacts

Agent evidence may attach a screenshot with this payload:

```json
{
  "type": "screenshot",
  "title": "Dashboard visual check",
  "summary": "The responsive layout passed visual QA.",
  "payload": {
    "artifact": {
      "kind": "image",
      "path": ".oneteam/artifacts/dashboard.png",
      "caption": "Dashboard at desktop width"
    }
  }
}
```

The path is resolved inside the Agent's current workspace. Screenshots should be written under the ignored `.oneteam/artifacts/` directory so they are not included in the implementation commit. Before a temporary worktree is removed, OneTeam validates the real path, file size, extension, and image signature, then copies the image to `.oneteam/data/artifacts/job-<id>/`. Agent-provided paths are replaced with a normalized same-origin API URL; local absolute paths are never persisted in job output.

PNG, JPEG, GIF, and WebP files up to 10 MB are accepted. SVG, remote URLs, data URLs, files outside the workspace, mismatched extensions, and symbolic-link escapes are recorded as unavailable evidence with a user-visible reason. Artifact responses use an explicit image content type, `nosniff`, immutable private caching, and remain scoped to an existing project and Agent Job.
