/**
 * Real-footprint self-evolution scenario driver (golden stack).
 *
 * Drives REAL user messages through Core's project-agent path (the same one
 * the web UI uses): create project -> create task -> start -> poll -> optional
 * follow-up messages. The GLM runtime does the work; Vivado validate/simulate
 * run on the production 8443 connector; runtime seals learning episodes at
 * turn boundaries; distiller/curator (run-evolution-workers.ts) consume them.
 *
 * Env:
 *   SYNTHIA_CORE_URL    default http://127.0.0.1:5130
 *   SYNTHIA_ADMIN_TOKEN human admin token (core:admin)
 *   SCENARIO            acquire | correct | degrade | inconclusive
 *   SCENARIO_TASK_ID    optional stable task id (default selfevo-<scenario>-<ts>)
 *
 * Usage: bun run scripts/selfevo-real-scenario.ts
 */
import { readFileSync } from "node:fs";

const coreUrl = process.env.SYNTHIA_CORE_URL ?? "http://127.0.0.1:5130";
const adminToken = required("SYNTHIA_ADMIN_TOKEN");
const scenario = process.env.SCENARIO ?? "acquire";
const taskId = process.env.SCENARIO_TASK_ID ?? `selfevo-${scenario}-${Date.now()}`;
const GOLDEN = "/data3/dev/synthia-golden/golden";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function read(path: string): string {
  return readFileSync(`${GOLDEN}/${path}`, "utf8");
}

const AUTHORIZATION_SCOPE = {
  schema: "task-scope.v1",
  workspace: "project",
  read_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
  write_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
  run_classes: ["exploratory", "gate_check", "formal"],
  can_submit_gates: true,
  can_create_milestones: true,
  can_start_formal_runs: true,
};

interface ScenarioSpec {
  readonly name: string;
  readonly task: string;
  readonly followUps: readonly string[];
}

function scenarios(): Record<string, ScenarioSpec> {
  const uartTx = read("uart/rtl/uart_tx.v");
  const baudGen = read("uart/rtl/baud_gen.v");
  const broken = uartTx.replace("parameter DATA_WIDTH = 8", "parameter DATA_WIDTH = 5");
  return {
    // S1: repeat the same method 3x so the distiller sees a consistent pattern.
    acquire: {
      name: "selfevo-s1-acquire",
      task: [
        "请对下面的 Verilog 源码做 Vivado validate_sources 检查，修复所有语法/综合问题，",
        "然后简要回报修复点和最终检查结果。要求：不要改变模块接口，逐项说明修改理由。\n\n",
        "文件 rtl/uart_tx.v：\n```verilog\n", uartTx, "\n```\n",
        "文件 rtl/baud_gen.v：\n```verilog\n", baudGen, "\n```",
      ].join(""),
      followUps: [],
    },
    // S2: deterministic failure first, then an explicit human correction.
    correct: {
      name: "selfevo-s2-correct",
      task: [
        "请对下面的 Verilog 源码做 Vivado validate_sources 检查并按报错修复。源码：\n",
        "```verilog\n", broken, "\n```",
      ].join(""),
      followUps: [
        "人工修正指示：把 DATA_WIDTH 恢复为 8，并检查所有按 DATA_WIDTH 生成的循环/位宽是否一致，再跑一次 validate 确认干净。",
      ],
    },
    // S3: the skill method applied where the tool must genuinely fail.
    degrade: {
      name: "selfevo-s3-degrade",
      task: [
        "请对下面的 Verilog 源码做 Vivado validate_sources 检查并修复：\n",
        "```verilog\n", broken, "\n```\n",
        "注意：如果 validate 报错，只回报错误本身，不要修改源码。",
      ].join(""),
      followUps: [],
    },
    // S4: aborted mid-run so evaluation evidence stays inconclusive.
    inconclusive: {
      name: "selfevo-s4-inconclusive",
      task: [
        "请对下面的 Verilog 源码做 Vivado validate_sources 检查并修复：\n",
        "```verilog\n", uartTx, "\n```",
      ].join(""),
      followUps: [],
    },
  };
}

async function api(path: string, method: string, body?: unknown, idem?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  };
  if (idem) headers["idempotency-key"] = idem;
  const res = await fetch(`${coreUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function waitTerminal(projectId: string, id: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "unknown";
  while (Date.now() < deadline) {
    const r = await api(`/api/v1/projects/${projectId}/tasks/${id}`, "GET");
    const data = (r.json.data ?? r.json) as Record<string, unknown>;
    last = String(data.status ?? last);
    if (["awaiting_user", "succeeded", "failed", "cancelled", "fail_closed"].includes(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return `timeout:${last}`;
}

async function main(): Promise<void> {
  const spec = scenarios()[scenario];
  if (!spec) throw new Error(`unknown scenario ${scenario}`);
  process.stdout.write(`[scenario:${scenario}] project=${spec.name} task=${taskId}\n`);

  const created = await api("/api/v1/projects", "POST", {
    id: spec.name,
    name: spec.name,
    project_type: "free",
    target_part: "xc7k70tfbv676-1",
    description: `self-evolution real footprint scenario ${scenario}`,
  }, `selfevo-${scenario}-project`);
  if (created.status !== 201 && created.status !== 200 && created.status !== 409) {
    throw new Error(`project create failed: ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`);
  }
  const projectId = spec.name;
  process.stdout.write(`[scenario:${scenario}] project=${projectId} (${created.status})\n`);

  const task = await api(`/api/v1/projects/${projectId}/tasks`, "POST", {
    task: spec.task,
    kind: "main",
    execution_intent: "project_agent",
    authorization_scope: AUTHORIZATION_SCOPE,
    task_id: taskId,
  }, `selfevo-${scenario}-task-${taskId}`);
  process.stdout.write(`[scenario:${scenario}] task create (auto register/bind/start): ${task.status} ${JSON.stringify(task.json).slice(0, 160)}\n`);

  const status = await waitTerminal(projectId, taskId, scenario === "inconclusive" ? 120_000 : 900_000);
  process.stdout.write(`[scenario:${scenario}] status=${status}\n`);

  for (const [i, text] of spec.followUps.entries()) {
    if (!status.includes("awaiting_user")) break;
    const sent = await api(`/api/v1/projects/${projectId}/tasks/${taskId}/message`, "POST", { text }, `selfevo-${scenario}-msg-${taskId}-${i}`);
    process.stdout.write(`[scenario:${scenario}] follow-up ${i}: ${sent.status}\n`);
    const next = await waitTerminal(projectId, taskId, 900_000);
    process.stdout.write(`[scenario:${scenario}] status after follow-up ${i}: ${next}\n`);
  }

  if (scenario === "inconclusive") {
    await api(`/api/v1/projects/${projectId}/tasks/${taskId}/abort`, "POST", undefined, `selfevo-${scenario}-abort`);
    process.stdout.write(`[scenario:${scenario}] aborted for inconclusive evidence\n`);
  }

  process.stdout.write(`[scenario:${scenario}] done. project=${projectId} task=${taskId}\n`);
}

void main();
