import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  M4F_RUNTIME_FIXTURE_ASSERTION,
  M4fAwaitingUserModel,
  resolveM4fRuntimeFixtureConfig,
} from "./m4f-e2e-service.ts";

const BASE_ENV = {
  SYNTHIA_M4F_E2E_DETERMINISTIC_RUNTIME: M4F_RUNTIME_FIXTURE_ASSERTION,
  SYNTHIA_RUNTIME_MODE: "core",
  SYNTHIA_FEATURE_SELF_EVOLUTION: "1",
  SYNTHIA_CORE_URL: "http://127.0.0.1:8787",
  SYNTHIA_CORE_TOKEN: "ordinary-core-token",
  SYNTHIA_TASK_RUNTIME_TOKEN: "task-runtime-token",
  SYNTHIA_RUNS_DIR: "/tmp/synthia-m4f-runtime-test",
  SYNTHIA_RUNTIME_PORT: "8790",
} as const;

describe("M4-F deterministic ordinary Runtime", () => {
  test("requires explicit authorization, Core governance, distinct identities, and loopback Core", () => {
    expect(resolveM4fRuntimeFixtureConfig(BASE_ENV, "/repo/synthia")).toEqual({
      coreUrl: "http://127.0.0.1:8787",
      runsDir: "/tmp/synthia-m4f-runtime-test",
      port: 8790,
    });
    expect(() => resolveM4fRuntimeFixtureConfig({
      ...BASE_ENV,
      SYNTHIA_M4F_E2E_DETERMINISTIC_RUNTIME: "",
    }, "/repo/synthia")).toThrow("I_ASSERT_M4F_DETERMINISTIC_RUNTIME_FIXTURE");
    expect(() => resolveM4fRuntimeFixtureConfig({
      ...BASE_ENV,
      SYNTHIA_NO_GOVERNANCE: "1",
    }, "/repo/synthia")).toThrow("Core governance");
    expect(() => resolveM4fRuntimeFixtureConfig({
      ...BASE_ENV,
      SYNTHIA_TASK_RUNTIME_TOKEN: BASE_ENV.SYNTHIA_CORE_TOKEN,
    }, "/repo/synthia")).toThrow("must be distinct");
    expect(() => resolveM4fRuntimeFixtureConfig({
      ...BASE_ENV,
      SYNTHIA_CORE_URL: "https://connect.wenzhuolin.xyz",
    }, "/repo/synthia")).toThrow("loopback HTTP origin");
    expect(() => resolveM4fRuntimeFixtureConfig({
      ...BASE_ENV,
      SYNTHIA_RUNS_DIR: "/repo/synthia/.runs",
    }, "/repo/synthia")).toThrow("outside the repository");
  });

  test("fixed model emits text and cannot request a tool", async () => {
    const turn = await new M4fAwaitingUserModel().chat([], []);
    expect(turn).toEqual({
      kind: "text",
      content: "M4-F deterministic Runtime fixture is ready and awaits further user instruction.",
    });
  });

  test("service keeps RuntimeServer and Core deps but installs no production conversational model", async () => {
    const source = await readFile(new URL("./m4f-e2e-service.ts", import.meta.url), "utf8");
    expect(source).toContain("new RuntimeServer(");
    expect(source).toContain("createEnvDepsFactory(");
    expect(source).toContain("createM4fRuntimeDepsFactory(process.env)");
    expect(source).toContain("new M4fAwaitingUserModel()");
    expect(source).not.toContain("modelConfigFromEnv");
  });
});
