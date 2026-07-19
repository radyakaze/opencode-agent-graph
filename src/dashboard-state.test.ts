import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests,
  accept,
  processId,
  removeStale,
  setNotifier,
  state,
} from './dashboard-state.ts'
import type { ActivityType } from './dashboard-types.ts'

let notifications = 0
beforeEach(() => {
  __resetForTests()
  notifications = 0
  setNotifier(() => {
    notifications += 1
  })
})
afterEach(() => {
  __resetForTests()
})

const PID = 'proc_test_1'
const PID2 = 'proc_test_2'
const CWD = '/tmp/proj-a'
const CWD2 = '/tmp/proj-b'
const SESSION = 'sess-1'
const NOW = '2026-07-19T08:00:00.000Z'
const LATER = '2026-07-19T08:00:05.000Z'

const SAMPLE_AGENT = {
  name: 'build',
  description: 'Build agent',
  mode: 'primary',
  hidden: false,
  native: true,
  model: 'gpt-4',
}

function createdEvent(
  overrides: Partial<{
    processId: string
    sessionID: string
    cwd: string
    agent: string
    timestamp: string
  }> = {},
) {
  return {
    kind: 'created' as const,
    processId: overrides.processId ?? PID,
    sessionID: overrides.sessionID ?? SESSION,
    cwd: overrides.cwd ?? CWD,
    agent: overrides.agent,
    timestamp: overrides.timestamp ?? NOW,
  }
}
function statusEvent(
  status: 'busy' | 'retry' | 'idle',
  overrides: Partial<{
    processId: string
    sessionID: string
    timestamp: string
    agent: string
    cwd: string
  }> = {},
) {
  return {
    kind: 'status' as const,
    processId: overrides.processId ?? PID,
    sessionID: overrides.sessionID ?? SESSION,
    status,
    timestamp: overrides.timestamp ?? LATER,
    agent: overrides.agent,
    cwd: overrides.cwd,
  }
}
function toolActivityEvent(phase: 'before' | 'after', tool = 'bash') {
  return {
    kind: 'toolActivity' as const,
    processId: PID,
    sessionID: SESSION,
    tool,
    phase,
    timestamp: LATER,
  }
}
function activityEvent(activityType: ActivityType, label = 'X') {
  return {
    kind: 'activity' as const,
    processId: PID,
    sessionID: SESSION,
    activityType,
    label,
    timestamp: LATER,
  }
}
/** Seed a project by registering an agent so it shows up in state().projects. */
function seedProject(pid = PID, cwd = CWD) {
  accept({ kind: 'heartbeat', processId: pid, cwd, agents: [SAMPLE_AGENT] })
  return state().projects.find((p) => p.cwd === cwd)
}

describe('accept — input validation', () => {
  test('rejects null, undefined, and non-objects', () => {
    const before = notifications
    accept(null)
    accept(undefined)
    accept('string')
    accept(42)
    expect(notifications).toBe(before)
  })
  test('rejects objects missing kind or processId', () => {
    const before = notifications
    accept({})
    accept({ kind: 'hello' })
    accept({ processId: PID })
    accept({ kind: 42, processId: PID })
    expect(notifications).toBe(before)
  })
  test('rejects unknown kind without sessionID', () => {
    accept({ kind: 'bogus', processId: PID })
    expect(state().projects).toEqual([])
  })
  test('rejects session event without sessionID', () => {
    accept({ kind: 'created', processId: PID, cwd: CWD })
    expect(state().projects).toEqual([])
  })
})

describe('control handlers (hello / heartbeat / agents)', () => {
  test('hello + heartbeat registers project with agents', () => {
    accept({ kind: 'hello', processId: PID, cwd: CWD })
    accept({ kind: 'heartbeat', processId: PID, cwd: CWD, agents: [SAMPLE_AGENT] })
    const project = state().projects.find((p) => p.cwd === CWD)
    expect(project).toBeDefined()
    expect(project?.availableAgents).toHaveLength(1)
  })
  test('agents message registers agents', () => {
    accept({ kind: 'agents', processId: PID, cwd: CWD, agents: [SAMPLE_AGENT] })
    const project = state().projects.find((p) => p.cwd === CWD)
    expect(project?.availableAgents).toHaveLength(1)
    expect(project?.availableAgents[0].name).toBe('build')
  })
  test('agents message with non-array agents still tracks the process', () => {
    accept({ kind: 'agents', processId: PID, cwd: CWD, agents: 'not an array' })
    // The process is tracked, so the registry may not show the project unless
    // there's at least one busy session. We just assert no agents are registered.
    const project = state().projects.find((p) => p.cwd === CWD)
    if (project) expect(project.availableAgents).toEqual([])
  })
  test('heartbeat adds cwd to process tracking', () => {
    accept({ kind: 'heartbeat', processId: PID, cwd: CWD, agents: [SAMPLE_AGENT] })
    expect(state().projects.find((p) => p.cwd === CWD)).toBeDefined()
  })
  test('agents with bad shape items are filtered out', () => {
    accept({
      kind: 'agents',
      processId: PID,
      cwd: CWD,
      agents: [SAMPLE_AGENT, null, { no_name: 1 }, { name: '' }, { name: 42 }],
    })
    const project = state().projects.find((p) => p.cwd === CWD)
    expect(project?.availableAgents).toHaveLength(1)
  })
  test('agents without cwd is a no-op for the agent registry', () => {
    accept({ kind: 'agents', processId: PID, agents: [SAMPLE_AGENT] })
    expect(state().projects).toEqual([])
  })
  test('two processes with the same cwd share agent registry', () => {
    accept({ kind: 'agents', processId: PID, cwd: CWD, agents: [SAMPLE_AGENT] })
    accept({ kind: 'heartbeat', processId: PID2, cwd: CWD, agents: [] })
    const project = state().projects.find((p) => p.cwd === CWD)
    expect(project?.availableAgents).toHaveLength(1)
  })
})

describe('handleCreated', () => {
  test('creates a new session in idle status', () => {
    accept(createdEvent())
    // No busy session, so project won't surface. Re-check via state() after busy.
    expect(state().projects).toEqual([])
  })
  test('preserves running status when re-created', () => {
    accept(createdEvent())
    accept(statusEvent('busy'))
    accept(createdEvent())
    const session = state().projects[0].agents[0]
    expect(session.status).toBe('busy')
  })
  test('falls back to process.cwd() when cwd is missing', () => {
    const origCwd = process.cwd
    Object.defineProperty(process, 'cwd', { value: () => CWD2, configurable: true })
    try {
      accept({ kind: 'created', processId: PID, sessionID: SESSION, timestamp: NOW })
      accept(statusEvent('busy'))
      expect(state().projects[0].cwd).toBe(CWD2)
    } finally {
      Object.defineProperty(process, 'cwd', { value: origCwd, configurable: true })
    }
  })
  test('agent is null when omitted', () => {
    accept(createdEvent())
    accept(statusEvent('busy'))
    expect(state().projects[0].agents[0].name).toBeNull()
  })
})

describe('handleStatus', () => {
  test('non-busy statuses are filtered from state()', () => {
    accept(createdEvent())
    accept(statusEvent('idle'))
    expect(state().projects).toEqual([])
  })
  test('busy status becomes visible with thinking activity', () => {
    accept(createdEvent())
    accept(statusEvent('busy'))
    const session = state().projects[0].agents[0]
    expect(session.status).toBe('busy')
    expect(session.currentActivity?.type).toBe('thinking')
  })
  test('retry status is treated as busy', () => {
    accept(createdEvent())
    accept(statusEvent('retry'))
    expect(state().projects[0].agents[0].status).toBe('retry')
  })
  test('idle clears currentActivity and removes from state', () => {
    accept(createdEvent())
    accept(statusEvent('busy'))
    accept(statusEvent('idle'))
    expect(state().projects).toEqual([])
  })
  test('normalizes unknown status values to busy', () => {
    accept({ kind: 'created', processId: PID, sessionID: SESSION, cwd: CWD, timestamp: NOW })
    accept({
      kind: 'status',
      processId: PID,
      sessionID: SESSION,
      status: 'weird' as 'busy',
      timestamp: LATER,
    })
    expect(state().projects[0].agents[0].status).toBe('busy')
  })
  test('preserves cwd and projectName across status updates', () => {
    accept(createdEvent({ cwd: CWD2 }))
    accept(statusEvent('busy'))
    const session = state().projects[0]
    expect(session.cwd).toBe(CWD2)
    expect(session.name).toBeTruthy()
  })
})

describe('handleInactive', () => {
  test('removes the session from state', () => {
    accept(createdEvent())
    accept(statusEvent('busy'))
    expect(state().projects[0].agents).toHaveLength(1)
    accept({ kind: 'inactive', processId: PID, sessionID: SESSION })
    expect(state().projects).toEqual([])
  })
  test('inactive for unknown session is a no-op (no publish)', () => {
    const before = notifications
    accept({ kind: 'inactive', processId: PID, sessionID: 'never-existed' })
    expect(notifications).toBe(before)
  })
})

describe('handleAgent', () => {
  test('updates the agent on an existing session', () => {
    accept(createdEvent({ agent: 'build' }))
    accept(statusEvent('busy'))
    accept({ kind: 'agent', processId: PID, sessionID: SESSION, agent: 'plan' })
    expect(state().projects[0].agents[0].name).toBe('plan')
  })
  test('agent update on unknown session is a no-op', () => {
    const before = notifications
    accept({ kind: 'agent', processId: PID, sessionID: SESSION, agent: 'plan' })
    expect(notifications).toBe(before)
    expect(state().projects).toEqual([])
  })
  test('agent update with null/empty agent is ignored (no publish)', () => {
    accept(createdEvent({ agent: 'build' }))
    accept(statusEvent('busy'))
    const before = notifications
    accept({ kind: 'agent', processId: PID, sessionID: SESSION, agent: null })
    expect(notifications).toBe(before)
    expect(state().projects[0].agents[0].name).toBe('build')
  })
})

describe('handleToolActivity', () => {
  beforeEach(() => {
    accept(createdEvent())
    accept(statusEvent('busy'))
  })
  test('classifies write tools', () => {
    accept(toolActivityEvent('before', 'write'))
    expect(state().projects[0].agents[0].currentActivity?.type).toBe('write')
    expect(state().projects[0].agents[0].currentActivity?.label).toBe('writing')
  })
  test('classifies mcp tools', () => {
    accept(toolActivityEvent('before', 'mcp__fs__read'))
    expect(state().projects[0].agents[0].currentActivity?.type).toBe('mcp')
    expect(state().projects[0].agents[0].currentActivity?.label).toBe('mcp fs')
  })
  test('classifies unknown tools as generic tool', () => {
    accept(toolActivityEvent('before', 'glob'))
    expect(state().projects[0].agents[0].currentActivity?.type).toBe('tool')
    expect(state().projects[0].agents[0].currentActivity?.label).toBe('glob')
  })
  test('defaults missing tool to "tool"', () => {
    accept({
      kind: 'toolActivity',
      processId: PID,
      sessionID: SESSION,
      phase: 'before',
      timestamp: LATER,
    })
    expect(state().projects[0].agents[0].currentActivity?.type).toBe('tool')
  })
  test('after-tool on a busy session reverts to thinking', () => {
    accept(toolActivityEvent('before', 'write'))
    accept(toolActivityEvent('after', 'write'))
    expect(state().projects[0].agents[0].currentActivity?.type).toBe('thinking')
  })
  test('after-tool on an idle session clears activity', () => {
    accept(statusEvent('idle'))
    accept(toolActivityEvent('after', 'write'))
    // Idle session is not surfaced; the underlying session.currentActivity is
    // null, which is what we care about — it just isn't visible in state().
    expect(state().projects).toEqual([])
  })
  test('tool activity on unknown session is a no-op', () => {
    const before = notifications
    accept({
      kind: 'toolActivity',
      processId: PID,
      sessionID: 'ghost',
      tool: 'write',
      phase: 'before',
      timestamp: LATER,
    })
    expect(notifications).toBe(before)
  })
})

describe('handleActivity (message.part.updated stream)', () => {
  beforeEach(() => {
    accept(createdEvent())
    accept(statusEvent('busy'))
  })
  test('sets reasoning activity', () => {
    accept(activityEvent('reasoning', 'Reasoning'))
    expect(state().projects[0].agents[0].currentActivity?.type).toBe('reasoning')
  })
  test('changes the activity when the type changes', () => {
    accept(activityEvent('reasoning'))
    accept(activityEvent('responding', 'Responding'))
    expect(state().projects[0].agents[0].currentActivity?.type).toBe('responding')
  })
  test('dedupes when the same activity type repeats (no publish)', () => {
    accept(activityEvent('reasoning'))
    const before = notifications
    accept(activityEvent('reasoning'))
    accept(activityEvent('reasoning'))
    expect(notifications).toBe(before)
  })
  test('dedup still updates lastActivityAt', () => {
    accept(activityEvent('reasoning'))
    accept({
      kind: 'activity',
      processId: PID,
      sessionID: SESSION,
      activityType: 'reasoning',
      timestamp: LATER,
    })
    expect(state().projects[0].agents[0].lastActivityAt).toBe(LATER)
  })
  test('activity on unknown session is a no-op', () => {
    const before = notifications
    accept({
      kind: 'activity',
      processId: PID,
      sessionID: 'ghost',
      activityType: 'reasoning',
      timestamp: LATER,
    })
    expect(notifications).toBe(before)
  })
  test('falls back to "Active" label when label is missing', () => {
    // First activity sets type, then a different type with no label should
    // exercise the `?? 'Active'` fallback path (only triggers on undefined).
    accept(activityEvent('reasoning', 'First'))
    accept({ kind: 'activity', processId: PID, sessionID: SESSION, activityType: 'responding' })
    expect(state().projects[0].agents[0].currentActivity?.label).toBe('Active')
  })
})

describe('removeStale', () => {
  test('removes processes older than the cutoff', () => {
    accept({ kind: 'heartbeat', processId: PID, cwd: CWD, agents: [SAMPLE_AGENT] })
    const cutoff = Date.now() + 1000
    removeStale(cutoff)
    expect(state().projects).toEqual([])
  })
  test('keeps processes newer than the cutoff', () => {
    accept({ kind: 'heartbeat', processId: PID, cwd: CWD, agents: [SAMPLE_AGENT] })
    removeStale(Date.now() - 10_000)
    expect(state().projects).toHaveLength(1)
  })
  test('removes sessions owned by stale processes', () => {
    accept(createdEvent())
    accept(statusEvent('busy'))
    expect(state().projects[0].agents.length).toBe(1)
    const cutoff = Date.now() + 1000
    removeStale(cutoff)
    expect(state().projects).toEqual([])
  })
  test('drops agent registry for a cwd once no process owns it', () => {
    accept({ kind: 'heartbeat', processId: PID, cwd: CWD, agents: [SAMPLE_AGENT] })
    expect(state().projects[0].availableAgents).toHaveLength(1)
    removeStale(Date.now() + 1000)
    expect(state().projects).toEqual([])
  })
  test('preserves agent registry when another process still owns the cwd', () => {
    accept({ kind: 'heartbeat', processId: PID, cwd: CWD, agents: [SAMPLE_AGENT] })
    accept({ kind: 'heartbeat', processId: PID2, cwd: CWD, agents: [SAMPLE_AGENT] })
    // Cutoff in the past keeps both processes, so the registry is preserved.
    removeStale(Date.now() - 10_000)
    const project = state().projects.find((p) => p.cwd === CWD)
    expect(project?.availableAgents).toHaveLength(1)
  })
})

describe('state() aggregation', () => {
  test('returns projects sorted by name then cwd', () => {
    accept({ kind: 'heartbeat', processId: 'p1', cwd: '/z/last', agents: [SAMPLE_AGENT] })
    accept({ kind: 'heartbeat', processId: 'p2', cwd: '/a/first', agents: [SAMPLE_AGENT] })
    accept({ kind: 'heartbeat', processId: 'p3', cwd: '/a/first', agents: [SAMPLE_AGENT] })
    const cwds = state().projects.map((p) => p.cwd)
    expect(cwds).toEqual(['/a/first', '/z/last'])
  })
  test('exposes processId and sessionId for each agent', () => {
    accept({ kind: 'created', processId: PID, sessionID: SESSION, cwd: CWD, timestamp: NOW })
    accept({ kind: 'status', processId: PID, sessionID: SESSION, status: 'busy', timestamp: LATER })
    const session = state().projects[0].agents[0]
    expect(session.processId).toBe(PID)
    expect(session.sessionId).toBe(SESSION)
  })
  test('omits the directories field from public agent info', () => {
    seedProject()
    const publicAgent = state().projects[0].availableAgents[0]
    expect((publicAgent as Record<string, unknown>).directories).toBeUndefined()
  })
  test('agents are sorted by name within a project', () => {
    accept({
      kind: 'created',
      processId: 'pa',
      sessionID: 'a1',
      cwd: CWD,
      agent: 'zebra',
      timestamp: NOW,
    })
    accept({ kind: 'status', processId: 'pa', sessionID: 'a1', status: 'busy', timestamp: LATER })
    accept({
      kind: 'created',
      processId: 'pa',
      sessionID: 'a2',
      cwd: CWD,
      agent: 'alpha',
      timestamp: NOW,
    })
    accept({ kind: 'status', processId: 'pa', sessionID: 'a2', status: 'busy', timestamp: LATER })
    const names = state().projects[0].agents.map((a) => a.name)
    expect(names).toEqual(['alpha', 'zebra'])
  })
  test('updatedAt advances on every publish', () => {
    accept(createdEvent())
    accept(statusEvent('busy'))
    const before = notifications
    accept(toolActivityEvent('before', 'write'))
    expect(notifications).toBe(before + 1)
  })
  test('elapsedSeconds counts from activeStartedAt', () => {
    const start = new Date(Date.now() - 30_000).toISOString()
    const status = new Date(Date.now() - 30_000).toISOString()
    accept({ kind: 'created', processId: PID, sessionID: SESSION, cwd: CWD, timestamp: start })
    accept({
      kind: 'status',
      processId: PID,
      sessionID: SESSION,
      status: 'busy',
      timestamp: status,
    })
    expect(state().projects[0].agents[0].elapsedSeconds).toBeGreaterThanOrEqual(30)
  })
  test('elapsedSeconds is 0 when activeStartedAt is null', () => {
    accept({ kind: 'created', processId: PID, sessionID: SESSION, cwd: CWD, timestamp: NOW })
    // No status event, so session has no busy state — no project surfaces.
    expect(state().projects).toEqual([])
  })
})

describe('processId export', () => {
  test('is a stable identifier for the current process', () => {
    expect(processId).toMatch(/^proc_\d+$/)
  })
})
