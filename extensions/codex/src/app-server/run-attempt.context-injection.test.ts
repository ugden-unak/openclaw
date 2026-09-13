import fs from "node:fs/promises";
import path from "node:path";
import * as agentHarnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import { registerMemoryCapability } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { describe, expect, it, vi } from "vitest";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { testing } from "./run-attempt.js";

const workspaceFiles = {
  "AGENTS.md": "synthetic-native-project-guidance",
  "TOOLS.md": "synthetic-inherited-tool-guidance",
  "SOUL.md": "synthetic-turn-soul-guidance",
  "IDENTITY.md": "synthetic-turn-identity-guidance",
  "USER.md": "synthetic-turn-user-guidance",
  "BOOTSTRAP.md": "synthetic-bootstrap-guidance",
  "MEMORY.md": "synthetic-memory-fallback",
  "HEARTBEAT.md": "synthetic-heartbeat-checklist",
};

const cases: Array<{
  name: string;
  defaultMode?: "always" | "never";
  agentMode?: "always" | "never" | "inherit";
  omitConfig?: boolean;
  heartbeat?: boolean;
  memoryTools?: boolean;
  inject: boolean;
}> = [
  { name: "missing configuration keeps default injection", omitConfig: true, inject: true },
  { name: "omitted policy keeps default injection", inject: true },
  { name: "explicit always keeps injection", defaultMode: "always", inject: true },
  { name: "default never skips injection", defaultMode: "never", inject: false },
  {
    name: "agent without a policy inherits never",
    defaultMode: "never",
    agentMode: "inherit",
    inject: false,
  },
  {
    name: "agent never overrides default always",
    defaultMode: "always",
    agentMode: "never",
    inject: false,
  },
  {
    name: "agent always overrides default never",
    defaultMode: "never",
    agentMode: "always",
    inject: true,
  },
  { name: "enabled heartbeat keeps its file pointer", heartbeat: true, inject: true },
  {
    name: "never also skips heartbeat file pointers",
    defaultMode: "never",
    heartbeat: true,
    inject: false,
  },
  {
    name: "default injection preserves enabled memory-tool policy",
    memoryTools: true,
    inject: true,
  },
  {
    name: "never preserves enabled memory-tool policy without loading workspace files",
    defaultMode: "never",
    memoryTools: true,
    inject: false,
  },
];

describe("Codex caller workspace context injection", () => {
  setupRunAttemptTestHooks();

  it.each(cases)(
    "$name",
    async ({ defaultMode, agentMode, omitConfig, heartbeat, memoryTools, inject }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      await Promise.all(
        Object.entries(workspaceFiles).map(([name, content]) =>
          fs.writeFile(path.join(workspaceDir, name), content),
        ),
      );
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      const onExecutionPhase = vi.fn();
      params.onExecutionPhase = onExecutionPhase;
      params.extraSystemPrompt = "synthetic-explicit-extra-instructions";
      params.skillsSnapshot = { prompt: "synthetic-explicit-skill-instructions", skills: [] };
      if (memoryTools) {
        params.disableTools = false;
        params.runtimePlan = createCodexRuntimePlanFixture();
        const normalizeTools = agentHarnessRuntime.normalizeAgentRuntimeTools;
        // Synthetic tools do not need provider discovery from the host installation.
        vi.spyOn(agentHarnessRuntime, "normalizeAgentRuntimeTools").mockImplementation((input) =>
          normalizeTools({ ...input, allowProviderRuntimePluginLoad: false }),
        );
        testing.setOpenClawCodingToolsFactoryForTests(() =>
          ["memory_search", "memory_get"].map(createRuntimeDynamicTool),
        );
        registerMemoryCapability("memory-core", {
          promptBuilder({ availableTools, citationsMode }) {
            return [
              `synthetic-recall-policy: ${[...availableTools].toSorted().join(",")}`,
              `synthetic-citation-policy: ${citationsMode}`,
            ];
          },
        });
      }
      if (!omitConfig) {
        params.config = {
          ...(memoryTools ? { memory: { citations: "on" } } : {}),
          agents: {
            defaults: { workspace: workspaceDir, contextInjection: defaultMode },
            ...(agentMode
              ? {
                  list: [
                    {
                      id: "main",
                      ...(agentMode === "inherit" ? {} : { contextInjection: agentMode }),
                    },
                  ],
                }
              : {}),
          },
        };
      }
      if (heartbeat) {
        params.trigger = "heartbeat";
        params.bootstrapContextMode = "lightweight";
        params.bootstrapContextRunKind = "heartbeat";
      }
      const loadBootstrap = vi.spyOn(agentHarnessRuntime, "resolveBootstrapFilesForRun");
      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      await Promise.race([
        harness.waitForMethod("turn/start", 10_000),
        run.then(() => {
          throw new Error("Attempt ended before turn/start");
        }),
      ]);
      await vi.waitFor(() =>
        expect(onExecutionPhase).toHaveBeenCalledWith(
          expect.objectContaining({ phase: "turn_accepted" }),
        ),
      );
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const result = await run;

      const thread = harness.requests.find((request) => request.method === "thread/start")
        ?.params as {
        developerInstructions?: string;
        config?: Record<string, unknown>;
        dynamicTools?: CodexDynamicToolSpec[];
      };
      const turn = harness.requests.find((request) => request.method === "turn/start")?.params as {
        input: Array<{ text?: string }>;
        collaborationMode?: { settings: { developer_instructions?: string | null } };
      };
      expect(thread).toBeDefined();
      expect(turn).toBeDefined();
      const payload = JSON.stringify([thread, turn]);
      const input = turn.input.map((item) => item.text ?? "").join("\n");
      const collaboration = turn.collaborationMode?.settings.developer_instructions ?? "";
      expect(input).toContain(params.prompt);
      expect(thread.developerInstructions).toContain(params.extraSystemPrompt);
      expect(collaboration).toContain(params.skillsSnapshot.prompt);
      // Native project-doc discovery remains Codex-owned; lightweight already disables it.
      expect(thread.config?.project_doc_max_bytes).toBe(heartbeat ? 0 : undefined);
      expect(payload).not.toContain(workspaceFiles["AGENTS.md"]);
      if (memoryTools) {
        expect(
          flattenCodexDynamicToolFunctions(thread.dynamicTools ?? []).map((tool) => tool.name),
        ).toEqual(expect.arrayContaining(["memory_search", "memory_get"]));
        expect(collaboration).toContain("synthetic-recall-policy: memory_get,memory_search");
        expect(collaboration).toContain("synthetic-citation-policy: on");
        expect(collaboration).toContain("use `tool_search` to load it, then call that memory tool");
        expect(payload).not.toContain(workspaceFiles["MEMORY.md"]);
      }

      if (!inject) {
        for (const content of Object.values(workspaceFiles)) {
          expect(payload).not.toContain(content);
        }
        expect(payload).not.toContain(path.join(workspaceDir, "HEARTBEAT.md"));
        expect(payload).not.toContain(path.join(workspaceDir, "MEMORY.md"));
        expect(result.systemPromptReport?.injectedWorkspaceFiles).toEqual([]);
        expect(loadBootstrap).not.toHaveBeenCalled();
      } else if (heartbeat) {
        expect(loadBootstrap).toHaveBeenCalled();
        expect(collaboration).toContain(path.join(workspaceDir, "HEARTBEAT.md"));
        expect(payload).not.toContain(workspaceFiles["HEARTBEAT.md"]);
      } else {
        expect(loadBootstrap).toHaveBeenCalled();
        expect(thread.developerInstructions).toContain(workspaceFiles["TOOLS.md"]);
        for (const name of ["SOUL.md", "IDENTITY.md", "USER.md"] as const) {
          expect(collaboration).toContain(workspaceFiles[name]);
        }
        expect(input).toContain(workspaceFiles["BOOTSTRAP.md"]);
        if (memoryTools) {
          expect(collaboration).toContain(path.join(workspaceDir, "MEMORY.md"));
        } else {
          expect(input).toContain(workspaceFiles["MEMORY.md"]);
        }
        expect(result.systemPromptReport?.injectedWorkspaceFiles.length).toBeGreaterThan(0);
      }
    },
  );
});
