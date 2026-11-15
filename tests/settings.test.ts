import { describe, expect, it } from 'vitest'
import { parseYaml, SettingsSchema, stringifyYaml, defaultSettings } from '../src/settings.ts'

describe('the configuration file', () => {
  it('reads the subset a configuration uses', () => {
    const parsed = parseYaml([
      'stateDir: /tmp/state',
      'checkout: /tmp/repo',
      'github:',
      '  repository: acme/widgets',
      '  allowed:',
      '    - alice',
      '    - bob',
      'executor:',
      '  agent: codex',
      '  maxWorkers: 2',
      '  blockedCommands: [docker, kubectl]',
    ].join('\n'))
    const settings = SettingsSchema.parse(parsed)
    expect(settings.github?.repository).toBe('acme/widgets')
    expect(settings.github?.allowed).toEqual(['alice', 'bob'])
    expect(settings.executor.agent).toBe('codex')
    expect(settings.executor.maxWorkers).toBe(2)
    expect(settings.executor.blockedCommands).toEqual(['docker', 'kubectl'])
    expect(settings.attention.idleSecondsThreshold).toBe(300)
    expect(settings.budget.maxAutonomousWakesPerDay).toBe(48)
    expect(settings.timers.enabled).toBe(true)
    expect(settings.watchers).toEqual([])
  })

  it('round trips what it writes', () => {
    const settings = defaultSettings('/tmp/repo', '/home/me')
    const again = SettingsSchema.parse(parseYaml(stringifyYaml(settings)))
    expect(again).toEqual(settings)
  })

  it('names the setting that is wrong', () => {
    const result = SettingsSchema.safeParse({ stateDir: '/tmp/s', checkout: '/tmp/c', github: { repository: 'not a repo' } })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path.join('.')).toBe('github.repository')
  })

  it('reads twitter configuration', () => {
    const parsed = parseYaml([
      'stateDir: /tmp/state',
      'checkout: /tmp/repo',
      'twitter:',
      '  enabled: true',
      '  query: "superagent OR @smallnest"',
      '  pollSeconds: 120',
      '  allowed: [alice, bob]',
    ].join('\n'))
    const settings = SettingsSchema.parse(parsed)
    expect(settings.twitter?.enabled).toBe(true)
    expect(settings.twitter?.query).toBe('superagent OR @smallnest')
    expect(settings.twitter?.pollSeconds).toBe(120)
    expect(settings.twitter?.allowed).toEqual(['alice', 'bob'])
  })
})
