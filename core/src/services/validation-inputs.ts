import { canonicalRequestHash } from "../hashing.ts";

type Source = { path: string; content: string };
const TEST_PATH = /(^|\/)(?:(?:tb|test|tests|testbench)(?:\/|$)|(?:tb(?:[_-].*)?|.*[_-]tb|testbench)\.(?:v|sv)$)/i;
const clean = (content: string): string => content.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ").replace(/"(?:\\.|[^"\\])*"/g, " ");
const names = (content: string): string[] => [...clean(content).matchAll(/\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)\b/g)].map(match => match[1]!);
const instantiated = (name: string, content: string): boolean => new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b\\s*(?:#\\s*\\([^;]*?\\))?\\s*[A-Za-z_][A-Za-z0-9_$]*\\s*\\(`).test(clean(content));

/** Normalize the design identity while retaining the exact test inputs apart.
 * Only recognizable, unreferenced testbench modules can be omitted from the
 * design fingerprint. Headers, packages and uncertain files stay included.
 */
export function validationInputs(sources: readonly Source[], top: string | null): { design: Source[]; tests: Source[]; top: string | null; testHash: string } {
  const ordinary = sources.filter(source => !TEST_PATH.test(source.path));
  const tests = sources.filter(source => TEST_PATH.test(source.path) && names(source.content).length > 0
    && /\binitial\b|\$finish\b|\$fatal\b/.test(clean(source.content))
    && names(source.content).every(name => !ordinary.some(file => instantiated(name, file.content))));
  const testPaths = new Set(tests.map(source => source.path));
  const normalize = (files: readonly Source[]): Source[] => files.map(({ path, content }) => ({ path, content })).sort((a, b) => a.path.localeCompare(b.path));
  const design = normalize(sources.filter(source => !testPaths.has(source.path)));
  const declared = [...new Set(design.flatMap(source => names(source.content)))];
  const roots = declared.filter(name => !design.some(source => instantiated(name, source.content)));
  return { design, tests: normalize(tests), top: top ?? (roots.length === 1 ? roots[0]! : null), testHash: canonicalRequestHash(normalize(tests)) };
}
