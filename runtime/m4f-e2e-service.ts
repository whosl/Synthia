#!/usr/bin/env bun
/**
 * Deterministic ordinary Runtime used only by the M4-F production-chain gate.
 *
 * It keeps the production RuntimeServer, Core HTTP clients, task callbacks,
 * project-fact reads, and task state machine. Only the conversational model is
 * replaced: it emits one fixed text response, never calls a tool, and leaves
 * every Core-owned free/side task in awaiting_user for the gate runner.
 */

import { readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  AgentMessage,
  AgentTool,
  ChatTurn,
  ConversationalModel,
} from "./agent-types.ts";
import {
  RuntimeServer,
  createEnvDepsFactory,
  createServerConfig,
  type DepsFactory,
} from "./server.ts";
import { CounterScriptedModel } from "./deps.ts";

export const M4F_RUNTIME_FIXTURE_ASSERTION =
  "I_ASSERT_M4F_DETERMINISTIC_RUNTIME_FIXTURE";

export interface M4fRuntimeFixtureConfig {
  readonly coreUrl: string;
  readonly runsDir: string;
  readonly port: number;
}

export class M4fAwaitingUserModel implements ConversationalModel {
  async chat(
    _messages: readonly AgentMessage[],
    _tools: readonly AgentTool[],
    _signal?: AbortSignal,
  ): Promise<ChatTurn> {
    return {
      kind: "text",
      content: "M4-F deterministic Runtime fixture is ready and awaits further user instruction.",
    };
  }
}

export function resolveM4fRuntimeFixtureConfig(
  env: Record<string, string | undefined> = process.env,
  repositoryRoot = resolve(import.meta.dir, ".."),
): M4fRuntimeFixtureConfig {
  if (
    env.SYNTHIA_M4F_E2E_DETERMINISTIC_RUNTIME
    !== M4F_RUNTIME_FIXTURE_ASSERTION
  ) {
    throw new Error(
      `SYNTHIA_M4F_E2E_DETERMINISTIC_RUNTIME must equal ${M4F_RUNTIME_FIXTURE_ASSERTION}`,
    );
  }
  if ((env.SYNTHIA_RUNTIME_MODE ?? "core") !== "core") {
    throw new Error("M4-F deterministic Runtime requires SYNTHIA_RUNTIME_MODE=core");
  }
  if (env.SYNTHIA_NO_GOVERNANCE === "1" || env.SYNTHIA_NO_GOVERNANCE === "true") {
    throw new Error("M4-F deterministic Runtime requires Core governance");
  }
  if (env.SYNTHIA_FEATURE_SELF_EVOLUTION !== "1") {
    throw new Error("M4-F deterministic Runtime requires SYNTHIA_FEATURE_SELF_EVOLUTION=1");
  }
  const ordinaryToken = required(env, "SYNTHIA_CORE_TOKEN");
  const taskToken = required(env, "SYNTHIA_TASK_RUNTIME_TOKEN");
  if (ordinaryToken === taskToken) {
    throw new Error("ordinary Core and task Runtime tokens must be distinct");
  }

  const url = new URL(required(env, "SYNTHIA_CORE_URL"));
  if (
    url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("SYNTHIA_CORE_URL must be an exact loopback HTTP origin");
  }

  const runsDir = resolve(required(env, "SYNTHIA_RUNS_DIR"));
  const fromRepository = relative(resolve(repositoryRoot), runsDir);
  if (
    !isAbsolute(runsDir)
    || fromRepository === ""
    || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))
  ) {
    throw new Error("SYNTHIA_RUNS_DIR must be a dedicated directory outside the repository");
  }
  const port = Number(env.SYNTHIA_RUNTIME_PORT ?? 8790);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SYNTHIA_RUNTIME_PORT must be an integer between 1 and 65535");
  }
  return {
    coreUrl: url.toString().replace(/\/$/u, ""),
    runsDir,
    port,
  };
}

export function createM4fRuntimeDepsFactory(
  env: Record<string, string | undefined> = process.env,
): DepsFactory {
  const coreFactory = createEnvDepsFactory({
    ...env,
    // createEnvDepsFactory constructs a LoopModel even for free projects.
    // These values are never contacted: the returned model is replaced below,
    // and any non-free project is rejected before task registration.
    SYNTHIA_MODEL_URL: "http://127.0.0.1:1",
    SYNTHIA_MODEL_KEY: "m4f-fixture-never-used",
    SYNTHIA_MODEL_NAME: "m4f-fixture-never-used",
  });
  return async (options) => {
    if (options.projectType !== undefined && options.projectType !== "free") {
      throw new Error("M4-F deterministic Runtime accepts only free projects");
    }
    const deps = await coreFactory(options);
    return { ...deps, model: new CounterScriptedModel() };
  };
}

async function assertFreshRunsDirectory(path: string): Promise<void> {
  try {
    if ((await readdir(path)).length !== 0) {
      throw new Error("SYNTHIA_RUNS_DIR must be empty before an M4-F gate run");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main(): Promise<void> {
  const fixture = resolveM4fRuntimeFixtureConfig();
  await assertFreshRunsDirectory(fixture.runsDir);
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) delete process.env[name];

  const server = new RuntimeServer(
    await createServerConfig(process.env),
    createM4fRuntimeDepsFactory(process.env),
    () => new M4fAwaitingUserModel(),
  );
  await server.start();
  process.stderr.write(
    `[m4f-runtime] deterministic ordinary Runtime ready at ${server.url}; Core=${fixture.coreUrl}\n`,
  );

  const shutdown = async (): Promise<void> => {
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.path === Bun.main) {
  main().catch((error) => {
    process.stderr.write(
      `[m4f-runtime] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
