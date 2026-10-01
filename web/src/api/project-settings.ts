import type { ApiClient } from "./client.ts";

export interface ConfigurationSnapshot {
  readonly epoch: number;
  readonly target_part: string | null;
  readonly target_frequency_mhz: number | null;
  readonly constraints: readonly { path: string; content: string }[];
  readonly created_at: string;
}

export interface ProjectSettings {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly config_epoch: number;
  readonly settings_revision: number;
  readonly verification_edit_supported: boolean;
  readonly configuration: ConfigurationSnapshot;
  readonly blockers: readonly { kind: string; id: string; state: string }[];
  readonly history: readonly Omit<ConfigurationSnapshot, "constraints">[];
}

export interface SettingsUpdate {
  expected_revision: number;
  name?: string;
  description?: string;
  target_part?: string;
  target_frequency_mhz?: number | null;
  constraints?: readonly { path: string; content: string }[];
}

export function getProjectSettings(client: ApiClient, projectId: string): Promise<ProjectSettings> {
  return client(`/api/v1/projects/${encodeURIComponent(projectId)}/settings`);
}

export function updateProjectSettings(client: ApiClient, projectId: string, update: SettingsUpdate): Promise<ProjectSettings> {
  return client(`/api/v1/projects/${encodeURIComponent(projectId)}/settings`, {
    method: "PATCH", body: update, headers: { "Idempotency-Key": crypto.randomUUID() },
  });
}
