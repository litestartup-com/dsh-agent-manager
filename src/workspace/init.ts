import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

/**
 * Scaffolds an agent workspace from a preset template.
 *
 * Existing files are never touched. Initialising is something a user may run
 * against a directory they already keep notes in, and against one manager has
 * already set up; in both cases quietly replacing their content would be the
 * worst thing this command could do. Only missing files are added.
 */

const here = dirname(fileURLToPath(import.meta.url))
export const TEMPLATES_DIR = resolve(here, '..', '..', 'templates')

export const listPresets = (): string[] => {
  if (!existsSync(TEMPLATES_DIR)) return []
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

export interface InitResult {
  workspacePath: string
  preset: string
  /** Paths written, relative to the workspace. */
  created: string[]
  /** Paths left alone because something was already there. */
  skipped: string[]
  gitInitialised: boolean
  committed: string | null
  warnings: string[]
}

/** Every file in the template, as workspace-relative paths. */
const templateFiles = (root: string): string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(relative(root, full))
    }
  }
  walk(root)
  return out.sort()
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const isGitRepo = (dir: string): boolean => {
  try {
    // `--is-inside-work-tree` also answers yes from a subdirectory of a repo,
    // which is exactly the case we must not initialise a nested repo into.
    return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true'
  } catch {
    return false
  }
}

/**
 * Writes a `.gitignore` if the workspace has none.
 *
 * Deliberately short: this is a notes repository, so the default is that
 * everything is tracked. Only editor and OS litter is excluded.
 */
const writeGitignore = (workspacePath: string): boolean => {
  const path = join(workspacePath, '.gitignore')
  if (existsSync(path)) return false
  writeFileSync(path, ['.DS_Store', 'Thumbs.db', '*.tmp', '.obsidian/workspace*.json', ''].join('\n'), 'utf8')
  return true
}

export interface InitOptions {
  workspacePath: string
  preset: string
  /** Set false to scaffold files without touching git at all. */
  useGit?: boolean
}

export const initWorkspace = ({ workspacePath, preset, useGit = true }: InitOptions): InitResult => {
  const templateRoot = join(TEMPLATES_DIR, preset)
  if (!existsSync(templateRoot) || !statSync(templateRoot).isDirectory()) {
    throw new Error(`unknown preset "${preset}"; available: ${listPresets().join(', ') || '(none)'}`)
  }

  const root = resolve(workspacePath)
  const warnings: string[] = []
  mkdirSync(root, { recursive: true })

  const created: string[] = []
  const skipped: string[] = []

  for (const rel of templateFiles(templateRoot)) {
    const target = join(root, rel)
    if (existsSync(target)) {
      skipped.push(rel)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(templateRoot, rel), target)
    created.push(rel)
  }

  // ---- git ---------------------------------------------------------------
  let gitInitialised = false
  let committed: string | null = null

  if (!useGit) return { workspacePath: root, preset, created, skipped, gitInitialised, committed, warnings }

  // Written before the commit, not after. Creating it afterwards left every
  // freshly initialised workspace with an untracked file, so `git status` was
  // dirty the moment init finished.
  if (writeGitignore(root)) created.push('.gitignore')

  try {
    if (!isGitRepo(root)) {
      git(root, ['init'])
      gitInitialised = true
      // Without this a workspace inherits whatever the machine's global config
      // says, and on a fresh box there may be nothing at all, which makes the
      // very first commit fail.
      try {
        git(root, ['config', 'user.name'])
      } catch {
        git(root, ['config', 'user.name', 'dsh-agent-manager'])
        git(root, ['config', 'user.email', 'agent@localhost'])
      }
    }

    if (created.length > 0) {
      // git pathspecs are always forward-slashed, including on Windows.
      git(root, ['add', '--', ...created.map((p) => p.split(sep).join('/'))])
      // Nothing staged means the files were already tracked and identical.
      const staged = git(root, ['diff', '--cached', '--name-only'])
      if (staged !== '') {
        git(root, ['commit', '-m', `chore: 初始化 ${preset} 工作区模板`])
        committed = git(root, ['rev-parse', 'HEAD'])
      }
    }
  } catch (error) {
    // The files are on disk and usable; only version control is missing. That
    // is worth reporting but not worth discarding the scaffold over.
    warnings.push(`工作区已生成，但 git 操作失败：${(error as Error).message.split('\n')[0]}`)
  }

  return { workspacePath: root, preset, created, skipped, gitInitialised, committed, warnings }
}
