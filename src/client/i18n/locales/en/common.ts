export const en = {
  app: {
    name: "one team"
  },
  nav: {
    issues: "Issues",
    pullRequests: "Pull Requests",
    repository: "Repository",
    settings: "Settings"
  },
  actions: {
    create: "Create",
    cancel: "Cancel",
    save: "Save",
    refresh: "Refresh",
    detect: "Detect",
    delete: "Delete"
  },
  setup: {
    title: "Setup",
    repository: "Repository",
    mode: "Mode",
    importMode: "Import",
    createMode: "Create",
    name: "Name",
    path: "Path",
    defaultBranch: "Default branch",
    codex: "Codex CLI",
    command: "Command",
    model: "Model",
    fullAccess: "Full access",
    locale: "Locale",
    createProject: "Create project"
  },
  issues: {
    title: "Issues",
    newIssue: "New issue",
    titleField: "Title",
    bodyField: "Body",
    open: "Open",
    closed: "Closed",
    noIssues: "No issues",
    comments: "comments",
    conversation: "Conversation",
    activity: "Activity",
    status: "Status",
    addComment: "Add comment",
    noComments: "No comments yet",
    noActivity: "No activity yet",
    deleteConfirm: "Delete this issue?"
  },
  labels: {
    title: "Labels",
    save: "Save labels"
  },
  pullRequests: {
    title: "Pull Requests",
    noPullRequests: "No pull requests",
    newPullRequest: "New pull request",
    sourceBranch: "Source branch",
    targetBranch: "Target branch",
    linkedIssue: "Linked issue",
    filesChanged: "Files changed",
    files: "files",
    commits: "commits",
    commitsTab: "Commits",
    noFiles: "No changed files",
    noCommits: "No commits",
    conflictsDetected: "Merge conflicts detected",
    resolveConflicts: "Resolve conflicts",
    diffLines: "diff lines",
    showFullDiff: "Show full diff",
    collapseDiff: "Collapse diff",
    deleteConfirm: "Delete this pull request?"
  },
  repository: {
    title: "Repository",
    path: "Path",
    branch: "Default branch",
    currentBranch: "Current branch",
    workingTree: "Working tree",
    clean: "Clean",
    dirty: "Changed files",
    commands: "Commands",
    command: "Command",
    source: "Source",
    available: "Available",
    missing: "Missing"
  },
  settings: {
    title: "Settings",
    server: "Server",
    database: "Database",
    locale: "Locale",
    codexCommand: "Codex command",
    model: "Model",
    fullAccess: "Full access",
    saved: "Settings saved"
  },
  agents: {
    title: "Agent Jobs",
    noJobs: "No agent jobs",
    queueRequirements: "Queue requirements job",
    queueImplementation: "Queue implementation job",
    queueReview: "Queue review job",
    queueFix: "Queue fix job",
    queueQa: "Queue QA job",
    cancelJob: "Cancel job",
    retryJob: "Retry",
    attempt: "Attempt"
  },
  status: {
    open: "Open",
    closed: "Closed",
    ready: "Ready",
    running: "Running",
    waiting: "Waiting",
    failed: "Failed"
  },
  validation: {
    required: "Required"
  }
} as const;
