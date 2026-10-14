import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

// The keeper Dockerfiles COPY an explicit file list (no src/ dir). A new local
// import that isn't added there builds fine and then crashes on boot with
// MODULE_NOT_FOUND (2026-10-14: chains.ts). Check every entrypoint's transitive
// local imports are copied into its image.
const ROOT = join(__dirname, '..')
const SERVICES = ['funding-keeper', 'liquidation-keeper', 'liquidator-bot']

function localImports(file: string): string[] {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const out = new Set<string>()
  for (const m of src.matchAll(/(?:from|require\()\s*['"]\.\/([\w.-]+)['"]/g)) {
    out.add(m[1].endsWith('.ts') ? m[1] : `${m[1]}.ts`)
  }
  return [...out]
}

function transitiveImports(entry: string): Set<string> {
  const seen = new Set<string>([entry])
  const stack = [entry]
  while (stack.length) {
    for (const dep of localImports(stack.pop()!)) {
      if (!seen.has(dep) && existsSync(join(ROOT, dep))) {
        seen.add(dep)
        stack.push(dep)
      }
    }
  }
  return seen
}

function copiedTsFiles(dockerfile: string): Set<string> {
  const src = readFileSync(join(ROOT, dockerfile), 'utf8')
  const files = new Set<string>()
  for (const line of src.split('\n')) {
    if (!/^COPY\s/.test(line) || line.includes('--from')) continue
    for (const tok of line.trim().split(/\s+/).slice(1, -1)) {
      if (tok.endsWith('.ts')) files.add(tok)
    }
  }
  return files
}

describe('keeper Dockerfiles copy every local module their entrypoint needs', () => {
  for (const svc of SERVICES) {
    it(svc, () => {
      const copied = copiedTsFiles(`Dockerfile.${svc}`)
      const missing = [...transitiveImports(`${svc}.ts`)].filter((f) => !copied.has(f))
      expect(missing, `add to Dockerfile.${svc} COPY`).toEqual([])
    })
  }
})
