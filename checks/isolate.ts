import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The mock host supplies every setting/command; never read the user's config.
const directory = mkdtempSync(join(tmpdir(), 'subagent-statusline-test-'))
const previous = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
}
process.env.CLAUDE_CONFIG_DIR = directory
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
afterAll(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(directory, { recursive: true, force: true })
})
