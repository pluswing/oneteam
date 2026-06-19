import type { AiProvider, AiSettingsDto } from "../../shared/ai-providers";
import { aiProviderLabel, normalizeAiSettings } from "../../shared/ai-providers";
import { CodexAdapter } from "./codex-adapter";
import { ClaudeCodeAdapter } from "./claude-code-adapter";
import { LmStudioAdapter } from "./lm-studio-adapter";
import type { AgentAdapter, AgentRunResult } from "./types";

export type ProviderRoutingAdapterOptions = {
  defaults: AiSettingsDto;
  loadSettings: () => Promise<unknown>;
  ensureReady?: (provider: AiProvider, settings: AiSettingsDto) => Promise<void>;
};

export class ProviderRoutingAdapter implements AgentAdapter {
  constructor(private readonly options: ProviderRoutingAdapterOptions) {}

  async run(input: Parameters<AgentAdapter["run"]>[0]): Promise<AgentRunResult> {
    const settings = normalizeAiSettings(await this.options.loadSettings(), this.options.defaults);
    const provider = input.job.aiProvider ?? settings.provider;
    await input.onActivity?.({
      type: "system",
      title: "AI provider selected",
      body: aiProviderLabel(provider),
      payload: {
        provider
      }
    });
    await this.options.ensureReady?.(provider, settings);
    return this.createAdapter(provider, settings).run(input);
  }

  private createAdapter(provider: AiProvider, settings: AiSettingsDto): AgentAdapter {
    if (provider === "claude_code") {
      return new ClaudeCodeAdapter({
        command: settings.claudeCode.command,
        model: settings.claudeCode.model,
        permissionMode: settings.claudeCode.permissionMode,
        maxTurns: settings.claudeCode.maxTurns
      });
    }

    if (provider === "lm_studio") {
      return new LmStudioAdapter(settings.lmStudio);
    }

    return new CodexAdapter({
      command: settings.codex.command,
      model: settings.codex.model ?? undefined
    });
  }
}
