/** Proves `superagent --version` reports the version the package actually ships. */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { main, VERSION } from '../src/cli.ts'

const shipped = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** Runs one command with both streams captured, so a version flag does not write into the test output. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { out.push(String(chunk)); return true })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => { err.push(String(chunk)); return true })
  try { return { code: await main(argv), out: out.join(''), err: err.join('') } }
  finally { stdout.mockRestore(); stderr.mockRestore() }
}

describe('the version', () => {
  it('is the one package.json ships, not a copy in the source', () => {
    expect(VERSION).toBe(shipped)
  })

  it.each([['--version'], ['-v'], ['version']])('prints it for %s', async flag => {
    const result = await run([flag])
    expect(result.code).toBe(0)
    expect(result.err).toBe('')
    expect(result.out).toBe(`superagent ${shipped}\n`)
  })

  it('is named in the usage', async () => {
    const result = await run(['--help'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('superagent --version')
  })
})
