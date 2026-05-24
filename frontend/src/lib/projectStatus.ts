import type { Project } from '../api/types'

export function isProjectArchived(project?: Project | null): boolean {
  if (!project) return false
  return project.status === 'archived' || Boolean(project.archived_at)
}

export function parseProjectGlobs(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return []
}

export function globsToText(globs?: string[] | null): string {
  return (globs ?? []).join(', ')
}

export function textToGlobs(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
