// Inspect what the distiller actually receives for a queued episode.
// Fails the claim with a retryable error afterwards so the run requeues.
import { CoreDistillerEvolutionClient } from "../runtime/evolution-worker-client.ts";

const coreUrl = process.env.SYNTHIA_CORE_URL ?? "http://127.0.0.1:5130";
const token = required("SYNTHIA_EVOLUTION_DISTILLER_TOKEN");
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const client = new CoreDistillerEvolutionClient({ baseUrl: coreUrl, distillerToken: token });
const claim = await client.claim({
  schema: "distillation-claim-request.v1",
  worker_id: "inspect-only",
  lease_seconds: 30,
});
console.log("claim state:", (claim as Record<string, unknown>).state ?? claim);
const row = claim as unknown as Record<string, unknown>;
for (const key of Object.keys(row)) {
  const value = JSON.stringify(row[key]);
  console.log(`--- ${key} (${value.length} bytes): ${value.slice(0, 400)}`);
}
