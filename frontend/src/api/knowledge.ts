import { request } from './client'

export interface KnowledgeSource {
  id: string
  title: string
  scope: 'global' | 'project'
  source_type: string
  indexed_at?: number
  trust_score?: number
}

export interface KnowledgeSearchHit {
  source_type: string
  source_id: string
  chunk_id: string
  title: string
  excerpt: string
  score: number
  authority_score?: number
  trust_score?: number
}

export function reindexKnowledge() {
  return request<{ indexed_sources: number; chunks: number; root: string }>('/knowledge/reindex', { method: 'POST' })
}

export function searchKnowledge(query: string, topK = 12) {
  return request<{ query: string; results: KnowledgeSearchHit[]; formatted: string }>('/knowledge/search', {
    method: 'POST',
    body: JSON.stringify({ query, top_k: topK }),
    headers: { 'Content-Type': 'application/json' },
  })
}
