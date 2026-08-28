import type { AiProvider, AiSettingsDto } from "../../shared/ai-providers";
import { aiProviderLabel, normalizeAiSettings } from "../../shared/ai-providers";
import { CodexAdapter } from "./codex-adapter";
import { ClaudeCodeAdapter } from "./claude-code-adapter";
import { LmStudioAdapter } from "./lm-studio-adapter";
import type { AgentAdapter, AgentRunResult, ProviderCapacityProbeResult } from "./types";

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
    const model = input.job.aiModel;
    await input.onActivity?.({
      type: "system",
      title: "AI provider selected",
      body: model ? `${aiProviderLabel(provider)} · ${model}` : aiProviderLabel(provider),
      payload: {
        provider,
        model
      }
    });
    await this.options.ensureReady?.(provider, settings);
    return this.createAdapter(provider, settings, model).run(input);
  }

  async probeCapacity(
    input: Parameters<NonNullable<AgentAdapter["probeCapacity"]>>[0]
  ): Promise<ProviderCapacityProbeResult | null> {
    const settings = normalizeAiSettings(await this.options.loadSettings(), this.options.defaults);
    const provider = input.job.aiProvider ?? settings.provider;
    const adapter = this.createAdapter(provider, settings, input.job.aiModel);
    return adapter.probeCapacity?.(input) ?? null;
  }

  private createAdapter(provider: AiProvider, settings: AiSettingsDto, model: string | null): AgentAdapter {
    if (provider === "claude_code") {
      return new ClaudeCodeAdapter({
        command: settings.claudeCode.command,
        model,
        permissionMode: settings.claudeCode.permissionMode,
        maxTurns: settings.claudeCode.maxTurns
      });
    }

    if (provider === "lm_studio") {
      return new LmStudioAdapter({ ...settings.lmStudio, model });
    }

    return new CodexAdapter({
      command: settings.codex.command,
      model: model ?? undefined
    });
  }
}
