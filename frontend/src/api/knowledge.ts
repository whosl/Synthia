export interface KnowledgeSource {
  id: string
  title: string
  scope: 'global' | 'project'
  source_type: string
  indexed_at?: number
  trust_score?: number
}

export const knowledgeSources: KnowledgeSource[] = [
  { id: 'spec', title: 'SPEC.md', scope: 'global', source_type: 'spec', trust_score: 0.9 },
  { id: 'vivado-commands', title: 'VIVADO_COMMANDS.md', scope: 'global', source_type: 'doc', trust_score: 0.85 },
]
