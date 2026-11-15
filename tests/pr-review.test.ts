import { describe, expect, it, afterAll } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runPrVerification } from '../src/infra/pr-verifier.ts'
import { pollOpenPullRequests } from '../src/sources/github.ts'
import { composePrompt } from '../src/prompts.ts'
import { SettingsSchema } from '../src/settings.ts'
import { FileRepositories } from '../src/state/files.ts'
import { runLoop } from '../src/runner.ts'

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

describe('PR Verification Runner', () => {
  it('passes when all commands succeed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'superagent-pr-test-'))
    dirs.push(dir)

    const result = await runPrVerification({
      cwd: dir,
      commands: ['echo "Building..."', 'echo "Tests passed!"'],
    })

    expect(result.passed).toBe(true)
    expect(result.totalCommands).toBe(2)
    expect(result.results[0]!.passed).toBe(true)
    expect(result.results[1]!.passed).toBe(true)
    expect(result.markdown).toContain('All local verification checks passed')
    expect(result.markdown).toContain('`echo "Building..."`')
  })

  it('fails and captures error log when a command exits non-zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'superagent-pr-test-'))
    dirs.push(dir)

    const result = await runPrVerification({
      cwd: dir,
      commands: ['echo "Step 1 OK"', 'sh -c "echo syntax error >&2; exit 1"', 'echo "Step 3 never reached"'],
    })

    expect(result.passed).toBe(false)
    expect(result.results).toHaveLength(2)
    expect(result.results[1]!.passed).toBe(false)
    expect(result.results[1]!.exitCode).toBe(1)
    expect(result.markdown).toContain('Local verification failed')
    expect(result.markdown).toContain('Failure Log: `sh -c "echo syntax error >&2; exit 1"`')
    expect(result.markdown).toContain('syntax error')
  })
})

describe('Pull Request Prompt Composition', () => {
  it('composes specialized PR review prompt with verification report and anti-AI slop guidelines', () => {
    const prompt = composePrompt({
      ticket: { id: 'ticket-pr-10', title: 'Review PR #10' } as any,
      trigger: {
        id: 'trigger-pr-10',
        text: 'Fix buffer overflow in parser',
        url: 'https://github.com/acme/app/pull/10',
      } as any,
      repository: 'acme/app',
      agentLogin: 'superagent-bot',
      branchPrefix: 'superagent/',
      instructions: '',
      isPrReview: true,
      prNumber: 10,
      autoMergeAllowed: true,
      prVerification: {
        passed: true,
        markdown: '### Automated Local Verification\n- `npm test`: PASS',
      },
    })

    expect(prompt).toContain('Pull Request #10 Review & Verification')
    expect(prompt).toContain('Automated Local Verification Report')
    expect(prompt).toContain('Zero Tolerance for AI Slop')
    expect(prompt).toContain('DECISION: MERGE')
  })

  it('warns critically in prompt when local automated verification failed', () => {
    const prompt = composePrompt({
      ticket: { id: 'ticket-pr-11', title: 'Review PR #11' } as any,
      trigger: {
        id: 'trigger-pr-11',
        text: 'Refactor auth logic',
        url: 'https://github.com/acme/app/pull/11',
      } as any,
      repository: 'acme/app',
      agentLogin: 'superagent-bot',
      branchPrefix: 'superagent/',
      instructions: '',
      isPrReview: true,
      prNumber: 11,
      autoMergeAllowed: true,
      prVerification: {
        passed: false,
        markdown: '### Automated Local Verification\n- `npm test`: FAIL (exit 1)',
      },
    })

    expect(prompt).toContain('⚠️ **CRITICAL: Local automated verification has FAILED.**')
    expect(prompt).toContain('You MUST NOT approve or merge this PR')
  })
})

describe('PR Active Polling and Auto-Review End-to-End', () => {
  it('actively polls open PRs, verifies locally, and executes merge on approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-pr-loop-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })

    // Create a mock git repository in root
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' })
    execFileSync('git', ['-C', root, '-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-q', '--allow-empty', '-m', 'initial'], { stdio: 'ignore' })

    const callLog = join(root, 'calls.log')

    // Mock gh CLI
    await writeFile(join(bin, 'gh'), `#!/bin/sh
echo "$@" >> ${JSON.stringify(callLog)}
case "$1 $2" in
  "api user") echo '{"login":"superagent-bot"}' ;;
  "api notifications"*) echo '[]' ;;
  "pr list")
    echo '[{"number":42,"title":"Add health check endpoint","body":"This PR adds /healthz","author":{"login":"bob","type":"User"},"updatedAt":"2026-11-15T10:00:00Z","url":"https://github.com/acme/app/pull/42"}]'
    ;;
  "pr merge")
    echo '{"merged":true}'
    ;;
  "pr comment")
    echo '{"id":1234}'
    ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 })

    // Mock agent that outputs DECISION: MERGE
    await writeFile(join(bin, 'fake-agent'), `#!/bin/sh
cat > /dev/null
mkdir -p .superagent
printf '{"summary":"Code is clean, tests passed. DECISION: MERGE","state":"ready","prs":[]}' > .superagent/report.json
echo "DECISION: MERGE"
`, { mode: 0o755 })
    await chmod(join(bin, 'gh'), 0o755)
    await chmod(join(bin, 'fake-agent'), 0o755)

    const settings = SettingsSchema.parse({
      stateDir: join(root, 'state'),
      checkout: root,
      github: {
        enabled: true,
        repository: 'acme/app',
        cli: join(bin, 'gh'),
        allowed: ['bob'],
        pollSeconds: 60,
        prReview: {
          enabled: true,
          pollOpenPrs: true,
          verifyCommands: ['echo "Running verification: OK"'],
          autoMerge: true,
          mergeMethod: 'squash',
        },
      },
      executor: {
        agent: 'codex',
        binary: join(bin, 'fake-agent'),
        maxWorkers: 1,
        timeoutMinutes: 5,
        prepare: '',
        blockedCommands: [],
      },
      assess: { binary: join(bin, 'no-assessor') },
      prompts: '',
    })

    const repo = new FileRepositories(settings.stateDir)
    await repo.open()

    const logFn = (line: string) => {
      // console.log(line)
    }

    await runLoop({
      settings,
      repo,
      signal: new AbortController().signal,
      log: logFn,
      once: true,
    })

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const ticket = repo.tickets.list()[0]
      if (ticket?.assignments.at(-1)?.report?.state === 'ready') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    // Verify tickets created for the PR
    const tickets = repo.tickets.list()
    expect(tickets.length).toBeGreaterThan(0)
    expect(tickets[0]!.title).toContain('PR #42')

    // Verify calls made to gh
    const { readFile: read } = await import('node:fs/promises')
    const calls = await read(callLog, 'utf8')
    expect(calls).toContain('pr list')
    expect(calls).toContain('pr merge 42 --squash --auto --repo acme/app')
    expect(calls).toContain('pr comment 42 --repo acme/app')
  })
})
