// Inline distiller debug: claim one queued run and surface the exact failure.
import { createRuntimeModelFromEnv } from "../runtime/pi-responses-model.ts";
import { EvolutionModelAdapter } from "../runtime/evolution-model-adapter.ts";
import { CoreDistillerEvolutionClient } from "../runtime/evolution-worker-client.ts";
import { DistillerWorker } from "../runtime/evolution-workers.ts";

const coreUrl = process.env.SYNTHIA_CORE_URL ?? "http://127.0.0.1:5130";
const distillerToken = required("SYNTHIA_EVOLUTION_DISTILLER_TOKEN");
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// Intercept the adapter so we see the raw model output.
class LoggingAdapter extends EvolutionModelAdapter {
  override async generateJson(request: unknown, signal?: AbortSignal): Promise<unknown> {
    try {
      const result = await super.generateJson(request as never, signal);
      const serialized = JSON.stringify(result);
      await Bun.write("/tmp/distill-model-output.json", serialized);
      process.stdout.write(`[model output] ${serialized.slice(0, 500)}\n`);
      return result;
    } catch (error) {
      process.stdout.write(`[adapter error] ${String(error instanceof Error ? error.message : error).slice(0, 500)}\n`);
      throw error;
    }
  }
}

const model = new LoggingAdapter(createRuntimeModelFromEnv(), process.env.SYNTHIA_MODEL_NAME ?? "glm");
const distiller = new DistillerWorker(new CoreDistillerEvolutionClient({
  baseUrl: coreUrl,
  distillerToken,
}), model, { workerId: "debug-distiller", leaseSeconds: 120 });

const result = await distiller.runOnce();
console.log("[result]", JSON.stringify(result, null, 1).slice(0, 800));
process.exit(0);
