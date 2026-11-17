import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The mock host supplies every setting/command; never read the user's config.
const directory = mkdtempSync(join(tmpdir(), 'subagent-statusline-test-'))
process.env.CLAUDE_CONFIG_DIR = directory
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
afterAll(() => rmSync(directory, { recursive: true, force: true }))
