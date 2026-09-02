import { loadConfig } from '../config.js'
import { initWorkspace, listPresets } from '../workspace/init.js'

/**
 * `npm run init -- <agent> [--preset x] [--no-git]`
 *
 * Scaffolds the workspace of an agent already declared in the config, so the
 * command cannot create a directory manager does not know about. The preset
 * defaults to the agent's `preset`, then to its id.
 */

const usage = (): void => {
  console.error('用法: npm run init -- <agent-id> [--preset <名称>] [--no-git]')
  console.error(`可用模板: ${listPresets().join(', ') || '(无)'}`)
}

interface Args {
  agentId: string | null
  preset: string | null
  useGit: boolean
}

/**
 * Walks the arguments in order so a flag's value is never read as a positional.
 * `--preset company personal` used to yield agentId "company", which would then
 * fail with a confusing "no agent named company".
 */
const parseArgs = (argv: string[]): Args => {
  const out: Args = { agentId: null, preset: null, useGit: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--no-git') out.useGit = false
    else if (arg === '--preset') {
      i += 1
      out.preset = argv[i] ?? null
    } else if (arg !== undefined && !arg.startsWith('-') && out.agentId === null) out.agentId = arg
  }
  return out
}

const main = (): void => {
  const { agentId, preset: presetFlag, useGit } = parseArgs(process.argv.slice(2))
  if (agentId === null) {
    usage()
    process.exit(2)
  }

  const config = loadConfig()
  const agent = config.agents[agentId]
  if (agent === undefined) {
    console.error(`配置里没有 agent "${agentId}"。已声明的: ${Object.keys(config.agents).join(', ')}`)
    process.exit(2)
  }

  const preset = presetFlag ?? agent.preset ?? agent.id
  if (preset === '') {
    usage()
    process.exit(2)
  }

  let result
  try {
    result = initWorkspace({ workspacePath: agent.workspacePath, preset, useGit })
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }

  console.log(`工作区: ${result.workspacePath}`)
  console.log(`模板:   ${result.preset}`)
  console.log(`新增 ${result.created.length} 个文件${result.gitInitialised ? '，并已 git init' : ''}`)
  for (const file of result.created) console.log(`  + ${file}`)
  if (result.skipped.length > 0) {
    // Loudly, because a partially-initialised workspace is a real possibility
    // and silence here would look like a complete setup.
    console.log(`跳过 ${result.skipped.length} 个已存在的文件（未覆盖）:`)
    for (const file of result.skipped) console.log(`  = ${file}`)
  }
  if (result.committed !== null) console.log(`已提交: ${result.committed.slice(0, 8)}`)
  for (const warning of result.warnings) console.warn(`⚠ ${warning}`)
  console.log(`\n打开大盘: /board/${agent.id}`)
}

main()
