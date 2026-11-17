import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The mock host supplies every setting/command; never read the user's config.
const directory = mkdtempSync(join(tmpdir(), 'subagent-statusline-test-'))
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = directory
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(directory, { recursive: true, force: true })
})
