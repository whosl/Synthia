import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  SELF_EVOLUTION_GATE_IDENTITIES,
  gateDatabaseName,
  provisionSelfEvolutionGateIdentities,
} from "../scripts/bootstrap-self-evolution-gate.ts";

describe("Self-Evolution gate bootstrap", () => {
  test("accepts only a dedicated PostgreSQL gate database", () => {
    expect(gateDatabaseName(
      "postgres://operator@127.0.0.1:5432/synthia-selfevo-gate-success",
    )).toBe("synthia-selfevo-gate-success");
    expect(gateDatabaseName(
      "postgresql://operator@127.0.0.1:5432/synthia-selfevo-gate-failure",
    )).toBe("synthia-selfevo-gate-failure");
    expect(() => gateDatabaseName("postgres://operator@127.0.0.1:5432/synthia"))
      .toThrow(/dedicated/);
    expect(() => gateDatabaseName("https://127.0.0.1/synthia-selfevo-gate-success"))
      .toThrow(/postgres/);
  });

  test("defines distinct service identities with exact singleton capability scopes", () => {
    const services = SELF_EVOLUTION_GATE_IDENTITIES.filter(
      (identity) => identity.actorType === "service",
    );
    expect(services.map((identity) => identity.uid)).toEqual([
      "synthia-service",
      "synthia-runtime",
      "synthia-evolution-distiller",
      "synthia-evolution-curator",
      "synthia-evolution-evaluator",
    ]);
    expect(services.map((identity) => identity.scopes)).toEqual([
      ["core:write", "core:read"],
      ["core:task-runtime"],
      ["core:evolution-distiller"],
      ["core:evolution-curator"],
      ["core:evolution-eval"],
    ]);
    expect(new Set(services.map((identity) => identity.uid)).size).toBe(5);
  });

  test("revokes earlier credentials and persists hashes instead of plaintext", async () => {
    const queries: { text: string; values: readonly unknown[] }[] = [];
    let identityIndex = 0;
    const client = {
      async query<T>(text: string, values: readonly unknown[] = []) {
        queries.push({ text, values });
        if (text.startsWith("INSERT INTO user_account")) {
          const spec = SELF_EVOLUTION_GATE_IDENTITIES[identityIndex++]!;
          return {
            rows: [{ id: `usr-${identityIndex}`, actor_type: spec.actorType }] as T[],
          };
        }
        return { rows: [] as T[] };
      },
    };
    let tokenIndex = 0;
    const plaintexts = SELF_EVOLUTION_GATE_IDENTITIES.map(
      () => `syn_${String(++tokenIndex).padStart(64, "0")}`,
    );
    tokenIndex = 0;
    const provisioned = await provisionSelfEvolutionGateIdentities(
      client,
      () => plaintexts[tokenIndex++]!,
    );

    expect(provisioned.map((item) => item.envVar)).toEqual(
      SELF_EVOLUTION_GATE_IDENTITIES.map((identity) => identity.envVar),
    );
    expect(queries.filter((query) => query.text.startsWith("UPDATE auth_token")))
      .toHaveLength(6);
    const inserts = queries.filter((query) => query.text.startsWith("INSERT INTO auth_token"));
    expect(inserts).toHaveLength(6);
    for (const [index, insert] of inserts.entries()) {
      expect(insert.values[0]).toBe(
        createHash("sha256").update(plaintexts[index]!).digest("hex"),
      );
      expect(insert.values).not.toContain(plaintexts[index]);
      expect(insert.values[2]).toEqual(SELF_EVOLUTION_GATE_IDENTITIES[index]!.scopes);
    }
  });

  test("fails closed when an existing uid has the wrong actor type", async () => {
    const client = {
      async query<T>(text: string) {
        if (text.startsWith("INSERT INTO user_account")) {
          return { rows: [{ id: "usr-conflict", actor_type: "service" }] as T[] };
        }
        return { rows: [] as T[] };
      },
    };
    await expect(provisionSelfEvolutionGateIdentities(client))
      .rejects.toThrow(/incompatible actor type/);
  });
});
