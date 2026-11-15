/**
 * Human presence detection and attention management.
 *
 * Implements the "Don't let the agent guess your presence" and "Start quiet" principles from Anthropic's
 * "Building always-on agents" and FanBox practice: detect system-level input idle time, route notifications
 * to local terminal/desktop when user is at their machine, and dispatch to mobile (Feishu/etc.) only when
 * user is away or during active attention requests, respecting quiet hours.
 */
import { stat } from 'node:fs/promises'
import { run } from './commands.ts'

export interface QuietHoursConfig {
  enabled: boolean
  start: string // e.g. "23:00"
  end: string   // e.g. "08:00"
}

/**
 * Determines whether a given time falls within configured quiet hours.
 * Supports intervals that cross midnight (e.g. 23:00 to 08:00).
 */
export function isQuietHours(now = new Date(), config?: QuietHoursConfig): boolean {
  if (!config || !config.enabled) return false
  const [startH = 23, startM = 0] = (config.start || '23:00').split(':').map(Number)
  const [endH = 8, endM = 0] = (config.end || '08:00').split(':').map(Number)
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes
  }
  // Crosses midnight, e.g. 23:00 - 08:00
  return currentMinutes >= startMinutes || currentMinutes < endMinutes
}

/**
 * Returns estimated system idle seconds (time since last user keyboard/mouse/console input).
 * Uses macOS /dev/console mtime or ioreg, falls back to 0.
 */
export async function getSystemIdleSeconds(): Promise<number> {
  // Method 1: on macOS/UNIX, /dev/console mtime reflects console user activity
  try {
    const s = await stat('/dev/console')
    const idleSeconds = Math.max(0, Math.floor((Date.now() - s.mtimeMs) / 1000))
    if (Number.isFinite(idleSeconds)) return idleSeconds
  } catch { /* ignored */ }

  // Method 2: ioreg HIDIdleTime on macOS
  try {
    const out = await run('/bin/sh', ['-c', "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'"], { timeoutMs: 2000 })
    const idle = parseInt(out.trim(), 10)
    if (!Number.isNaN(idle) && idle >= 0) return idle
  } catch { /* ignored */ }

  return 0
}

/**
 * Determines whether a human user is currently active at the local machine.
 * When idle time is below thresholdSeconds (default 300s = 5m), the user is considered present.
 */
export async function isUserPresent(
  thresholdSeconds = 300,
  idleProvider: () => Promise<number> = getSystemIdleSeconds,
): Promise<boolean> {
  try {
    const idle = await idleProvider()
    return idle < thresholdSeconds
  } catch {
    return false
  }
}
