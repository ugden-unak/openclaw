// Memory Core tests cover index plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type {
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMemoryFlushPlan,
  DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
  DEFAULT_MEMORY_FLUSH_PROMPT,
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
} from "./src/flush-plan.js";
import {
  getMemorySearchManagerMockCalls,
  getReadAgentMemoryFileMockCalls,
  resetMemoryToolMockState,
} from "./src/memory-tool-manager.test-mocks.js";
import { buildPromptSection } from "./src/prompt-section.js";

const closeMemorySearchManagerMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./src/runtime-provider.js", () => ({
  memoryRuntime: {
    closeAllMemorySearchManagers: vi.fn(async () => {}),
    closeMemorySearchManager: closeMemorySearchManagerMock,
    getMemorySearchManager: vi.fn(async () => null),
  },
}));

import plugin from "./index.js";

function registerMemoryCoreRuntime(): MemoryPluginRuntime {
  let runtime: MemoryPluginRuntime | undefined;
  plugin.register(
    createTestPluginApi({
      registerMemoryCapability(capability) {
        runtime = capability.runtime;
      },
    }),
  );
  if (!runtime) {
    throw new Error("expected memory-core to register a memory runtime");
  }
  return runtime;
}

function createRegisteredMemoryTool(name: string, context: OpenClawPluginToolContext) {
  let factory: OpenClawPluginToolFactory | undefined;
  plugin.register(
    createTestPluginApi({
      registerTool(tool, options) {
        if (options?.names?.includes(name) && typeof tool === "function") {
          factory = tool;
        }
      },
    }),
  );
  const tool = factory?.(context);
  if (!tool || Array.isArray(tool)) {
    throw new Error(`expected a registered ${name} tool`);
  }
  return tool;
}

describe("buildPromptSection", () => {
  it("returns empty when no memory tools are available", () => {
    expect(buildPromptSection({ availableTools: new Set() })).toStrictEqual([]);
  });

  it("describes the two-step flow when both memory tools are available", () => {
    const result = buildPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
    });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_search");
    expect(result[1]).toContain("then use memory_get");
    expect(result[1]).toContain("indexed session transcripts");
    expect(result).toContain(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
    expect(result.at(-1)).toBe("");
  });

  it("limits the guidance to memory_search when only search is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_search"]) });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_search");
    expect(result[1]).toContain("indexed session transcripts");
    expect(result[1]).not.toContain("then use memory_get");
  });

  it("limits the guidance to memory_get when only get is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_get"]) });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_get");
    expect(result[1]).not.toContain("run memory_search");
  });

  it("includes citations-off instruction when citationsMode is off", () => {
    const result = buildPromptSection({
      availableTools: new Set(["memory_search"]),
      citationsMode: "off",
    });
    expect(result).toContain(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  });
});

describe("memory-core plugin runtime registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the dreaming runtime slash command", () => {
    let command: OpenClawPluginCommandDefinition | undefined;
    plugin.register(
      createTestPluginApi({
        registerCommand(definition) {
          command = definition;
        },
      }),
    );

    expect(command?.name).toBe("dreaming");
    expect(command?.acceptsArgs).toBe(true);
    expect(command?.exposeSenderIsOwner).toBe(true);
    expect(command?.description).toContain("Enable or disable");
  });

  it("wires scoped memory search cleanup through the lazy runtime", async () => {
    const runtime = registerMemoryCoreRuntime();
    const cfg = {} as OpenClawConfig;

    await runtime.closeMemorySearchManager?.({ cfg, agentId: "main" });

    expect(closeMemorySearchManagerMock).toHaveBeenCalledWith({ cfg, agentId: "main" });
  });
});

describe.each([
  { name: "memory_search", params: { query: "synthetic note", corpus: "memory" } },
  { name: "memory_get", params: { path: "MEMORY.md", corpus: "memory" } },
])("registered $name current configuration", ({ name, params }) => {
  const enabledConfig: OpenClawConfig = {
    agents: { defaults: { memorySearch: { enabled: true, provider: "none" } } },
  };
  const disabledConfig: OpenClawConfig = {
    agents: { defaults: { memorySearch: { enabled: false } } },
  };

  beforeEach(() => {
    resetMemoryToolMockState({
      searchImpl: async () => [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Synthetic memory note.",
          source: "memory",
        },
      ],
      readFileImpl: async ({ relPath }) => ({ path: relPath, text: "Synthetic memory note." }),
    });
  });

  function readCounts() {
    return [getMemorySearchManagerMockCalls(), getReadAgentMemoryFileMockCalls()];
  }

  it("stops an already-loaded lazy tool when runtime config disables memory", async () => {
    let liveConfig = enabledConfig;
    const tool = createRegisteredMemoryTool(name, {
      config: enabledConfig,
      runtimeConfig: enabledConfig,
      getRuntimeConfig: () => liveConfig,
      agentId: "main",
    });
    const first = await tool.execute("enabled-first-load", params);
    expect(first.details).not.toHaveProperty("disabled", true);
    const firstReadCounts = readCounts();
    expect(firstReadCounts).toEqual(name === "memory_search" ? [1, 0] : [0, 1]);

    liveConfig = disabledConfig;
    const disabled = await tool.execute("disabled-loaded-tool", params);
    expect(disabled.details).toMatchObject({ disabled: true, unavailable: true });
    expect(readCounts()).toEqual(firstReadCounts);

    liveConfig = enabledConfig;
    const resumed = await tool.execute("re-enabled-loaded-tool", params);
    expect(resumed.details).not.toHaveProperty("disabled", true);
    expect(readCounts()).toEqual(firstReadCounts.map((count) => count * 2));
  });

  it("keeps disablement before the first lazy load unavailable", async () => {
    let liveConfig = enabledConfig;
    const tool = createRegisteredMemoryTool(name, {
      config: enabledConfig,
      getRuntimeConfig: () => liveConfig,
      agentId: "main",
    });
    liveConfig = disabledConfig;

    const result = await tool.execute("disabled-before-load", params);

    expect(result.details).toMatchObject({ disabled: true, unavailable: true });
    expect(readCounts()).toEqual([0, 0]);
  });
});

describe("buildMemoryFlushPlan", () => {
  const cfg = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
        timeFormat: "12",
      },
    },
  } as OpenClawConfig;

  it("replaces YYYY-MM-DD using user timezone and appends current time", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            compaction: {
              memoryFlush: {
                prompt: "Store durable notes in memory/YYYY-MM-DD.md",
              },
            },
          },
        },
      },
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(plan?.prompt).toContain("memory/2026-02-16.md");
    expect(plan?.prompt).toContain(
      "Current time: Monday, February 16th, 2026 - 10:00 AM (America/New_York)",
    );
    expect(plan?.prompt).toContain("Reference UTC: 2026-02-16 15:00 UTC");
    expect(plan?.relativePath).toBe("memory/2026-02-16.md");
  });

  it("does not append a duplicate current time line", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            compaction: {
              memoryFlush: {
                prompt: "Store notes.\nCurrent time: already present",
              },
            },
          },
        },
      },
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(plan?.prompt).toContain("Current time: already present");
    expect((plan?.prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });

  it("defaults to safe prompts and gating values", () => {
    const plan = buildMemoryFlushPlan();
    expect(plan?.softThresholdTokens).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);
    expect(plan?.forceFlushTranscriptBytes).toBe(DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES);
    expect(plan?.prompt).toContain("memory/");
    expect(plan?.prompt).toContain("MEMORY.md");
    expect(plan?.systemPrompt).toContain("MEMORY.md");
  });

  it("respects disable flag", () => {
    expect(
      buildMemoryFlushPlan({
        cfg: {
          agents: {
            defaults: { compaction: { memoryFlush: { enabled: false } } },
          },
        },
      }),
    ).toBeNull();
  });

  it("carries configured memory flush model override", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                model: "ollama/qwen3:8b",
              },
            },
          },
        },
      },
    });

    expect(plan?.model).toBe("ollama/qwen3:8b");
  });

  it("falls back to defaults when numeric values are invalid", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: Number.NaN,
              memoryFlush: {
                softThresholdTokens: -100,
              },
            },
          },
        },
      },
    });

    expect(plan?.softThresholdTokens).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);
    expect(plan?.forceFlushTranscriptBytes).toBe(DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES);
    expect(plan?.reserveTokensFloor).toBe(20_000);
  });

  it("parses forceFlushTranscriptBytes from byte-size strings", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                forceFlushTranscriptBytes: "3mb",
              },
            },
          },
        },
      },
    });

    expect(plan?.forceFlushTranscriptBytes).toBe(3 * 1024 * 1024);
  });

  it("keeps overwrite guards in the default prompt", () => {
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toMatch(/APPEND/i);
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("do not overwrite");
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("timestamped variant");
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("YYYY-MM-DD.md");
  });
});
