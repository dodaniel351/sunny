import { describe, it, expect } from 'vitest'
import {
  approvalGateKey,
  approvalGateOutcome,
  outcomeAllows,
  postRunDisposition
} from '@main/worker/approval-policy'

// The autonomous worker's approval gate is a pure decision over the most recent
// approval for a (task, gate). Kept native-free so it's testable without a DB
// (mirrors goals-rollup.test.ts).

describe('approvalGateOutcome', () => {
  it('requests a new gate when no prior approval exists', () => {
    expect(approvalGateOutcome(null)).toBe('request')
  })

  it('waits (no duplicate) while an approval is still pending', () => {
    expect(approvalGateOutcome({ status: 'pending' })).toBe('wait')
  })

  it('allows the action once the user has approved the gate', () => {
    expect(approvalGateOutcome({ status: 'approved' })).toBe('allow')
  })

  it('denies a rejected gate permanently — never re-asks', () => {
    expect(approvalGateOutcome({ status: 'rejected' })).toBe('deny')
  })

  it('re-asks when the prior gate expired', () => {
    expect(approvalGateOutcome({ status: 'expired' })).toBe('request')
  })
})

describe('outcomeAllows', () => {
  it('lets the action proceed only on allow', () => {
    expect(outcomeAllows('allow')).toBe(true)
  })

  it('denies the action on request / wait / deny', () => {
    expect(outcomeAllows('request')).toBe(false)
    expect(outcomeAllows('wait')).toBe(false)
    expect(outcomeAllows('deny')).toBe(false)
  })
})

describe('approvalGateKey', () => {
  it('is stable for the same tool + detail (a re-run matches its own approval)', () => {
    expect(approvalGateKey('run_command', 'git status')).toBe(
      approvalGateKey('run_command', 'git status')
    )
  })

  it('normalizes surrounding whitespace in the detail', () => {
    expect(approvalGateKey('run_command', '  git status  ')).toBe(
      approvalGateKey('run_command', 'git status')
    )
  })

  it('differs for a different command on the same tool (no blanket allow)', () => {
    expect(approvalGateKey('run_command', 'git status')).not.toBe(
      approvalGateKey('run_command', 'rm -rf /')
    )
  })

  it('differs for the same detail on a different tool', () => {
    expect(approvalGateKey('run_command', 'x')).not.toBe(approvalGateKey('write_file', 'x'))
  })

  it('is scoped (tool:<tool>:<12-hex-digest>) and never the bare tool key', () => {
    const key = approvalGateKey('run_command', 'git status')
    expect(key).toMatch(/^tool:run_command:[0-9a-f]{12}$/)
    expect(key).not.toBe('tool:run_command')
  })
})

describe('postRunDisposition', () => {
  it('is done when no gate was denied this run', () => {
    expect(postRunDisposition([])).toBe('done')
  })

  it('parks while any denied gate is still pending', () => {
    expect(postRunDisposition(['pending'])).toBe('park')
    expect(postRunDisposition(['approved', 'pending'])).toBe('park')
    expect(postRunDisposition(['rejected', 'pending'])).toBe('park')
  })

  it('requeues when none pending and at least one was approved mid-run', () => {
    expect(postRunDisposition(['approved'])).toBe('requeue')
    expect(postRunDisposition(['rejected', 'approved'])).toBe('requeue')
  })

  it('stays rejected when none pending and all were decided otherwise', () => {
    expect(postRunDisposition(['rejected'])).toBe('rejected')
    expect(postRunDisposition(['rejected', 'expired'])).toBe('rejected')
  })
})
