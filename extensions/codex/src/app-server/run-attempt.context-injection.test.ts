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
  threadStartResult,
  turnStartResult,
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

  it.each(["replacement", "deletion", "recreation"] as const)(
    "refreshes current-turn workspace files after %s in the same native session",
    async (operation) => {
      const workspaceDir = await fs.realpath(await fs.mkdtemp(path.join(tempDir, "refresh-")));
      const sessionFile = path.join(tempDir, "refresh-session.jsonl");
      const refreshedNames = ["SOUL.md", "USER.md", "MEMORY.md"] as const;
      const fileContent = (name: string, version: string) =>
        `synthetic-${name}-revision-${version}`;
      const fixedTime = new Date("2020-01-01T00:00:00.000Z");
      await Promise.all(
        Object.entries(workspaceFiles).map(([name, content]) =>
          fs.writeFile(path.join(workspaceDir, name), content),
        ),
      );
      for (const name of refreshedNames) {
        const file = path.join(workspaceDir, name);
        await fs.writeFile(file, fileContent(name, "v1"));
        await fs.utimes(file, fixedTime, fixedTime);
      }
      const loadBootstrap = vi.spyOn(agentHarnessRuntime, "resolveBootstrapFilesForRun");
      let turnNumber = 0;
      const runTurn = async (version?: string) => {
        turnNumber += 1;
        const turnId = `turn-${turnNumber}`;
        const harness = createStartedThreadHarness(async (method) => {
          if (method === "thread/resume") {
            return threadStartResult("thread-1");
          }
          if (method === "turn/start") {
            return turnStartResult(turnId);
          }
          return undefined;
        });
        const params = createParams(sessionFile, workspaceDir);
        params.runId = `refresh-run-${turnNumber}`;
        params.prompt = `synthetic-current-request-${turnNumber}`;
        const onExecutionPhase = vi.fn();
        params.onExecutionPhase = onExecutionPhase;
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
        await harness.completeTurn({ threadId: "thread-1", turnId });
        const result = await run;

        const threadRequests = harness.requests.filter(
          ({ method }) => method === "thread/start" || method === "thread/resume",
        );
        expect(threadRequests).toHaveLength(1);
        expect(threadRequests[0].method).toBe(turnNumber === 1 ? "thread/start" : "thread/resume");
        if (turnNumber === 1) {
          const thread = threadRequests[0].params as { developerInstructions?: string };
          expect(thread.developerInstructions).toContain(workspaceFiles["TOOLS.md"]);
        } else {
          expect(threadRequests[0].params).toMatchObject({ threadId: "thread-1" });
        }
        const turn = harness.requests.find(({ method }) => method === "turn/start")?.params as {
          threadId: string;
          input: Array<{ text?: string }>;
          collaborationMode?: { settings: { developer_instructions?: string | null } };
        };
        expect(turn.threadId).toBe("thread-1");
        const input = turn.input.map((item) => item.text ?? "").join("\n");
        const collaboration = turn.collaborationMode?.settings.developer_instructions ?? "";
        const fileStats = new Map(
          result.systemPromptReport?.injectedWorkspaceFiles.map((file) => [file.name, file]),
        );
        expect(input).toContain(params.prompt);
        // Only new turn fields refresh here; native thread instructions and history
        // have separate lifecycles and are not erased by a workspace edit.
        for (const name of refreshedNames) {
          const destination = name === "MEMORY.md" ? input : collaboration;
          if (version) {
            expect(destination).toContain(fileContent(name, version));
            expect(fileStats.get(name)).toMatchObject({
              missing: false,
              rawChars: fileContent(name, version).length,
            });
          } else if (name === "MEMORY.md") {
            expect(fileStats.has(name)).toBe(false);
          } else {
            expect(fileStats.get(name)).toMatchObject({ missing: true, rawChars: 0 });
          }
          for (const oldVersion of ["v1", "v2", "v3"].filter((v) => v !== version)) {
            expect(input + collaboration).not.toContain(fileContent(name, oldVersion));
          }
        }
        expect(loadBootstrap).toHaveBeenCalledTimes(turnNumber);
        expect(loadBootstrap).toHaveBeenLastCalledWith(
          expect.objectContaining({ workspaceDir, sessionKey: params.sessionKey }),
        );
      };

      await runTurn("v1");
      if (operation === "replacement") {
        await runTurn("v1"); // Unchanged-file control before replacing a warm snapshot.
        for (const name of refreshedNames) {
          const replacement = path.join(workspaceDir, `${name}.replacement`);
          await fs.writeFile(replacement, fileContent(name, "v2"));
          // Equal length and timestamp keep the atomic replacement's new inode
          // relevant to the guarded reader, without sleeps or host-file access.
          await fs.utimes(replacement, fixedTime, fixedTime);
          await fs.rename(replacement, path.join(workspaceDir, name));
        }
        await runTurn("v2");
      } else {
        await Promise.all(refreshedNames.map((name) => fs.unlink(path.join(workspaceDir, name))));
        await runTurn();
        if (operation === "recreation") {
          await Promise.all(
            refreshedNames.map((name) =>
              fs.writeFile(path.join(workspaceDir, name), fileContent(name, "v3")),
            ),
          );
          await runTurn("v3");
        }
      }
    },
  );
});
