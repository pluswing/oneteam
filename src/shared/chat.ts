export type ChatSessionDto = {
  id: string; projectId: string; title: string; model: string | null; effort: string | null;
  threadId: string | null; status: "idle" | "running"; error: string | null;
  createdAt: string; updatedAt: string;
};
export type ChatMessageDto = {
  id: number; projectId: string; chatId: string; role: "user" | "assistant" | "tool";
  content: string; status: "running" | "completed" | "failed" | "canceled";
  metadata: Record<string, unknown> | null; createdAt: string;
};
export type ChatDetail = { chat: ChatSessionDto; messages: ChatMessageDto[] };
export type ModelPolicySettings = { model: string | null; effort: string | null; roles: Record<string, { model: string | null; effort: string | null }> };
export type ChatModelsResponse = {
  models: Array<{ model: string; displayName: string; listed: boolean; defaultReasoningEffort: string; supportedReasoningEfforts: Array<{ reasoningEffort: string }> }>;
  preferredModel: string; settings: ModelPolicySettings;
};
