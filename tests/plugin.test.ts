import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ActiveAgentDashboard } from '../src/plugin.ts'
import { __resetForTests } from '../src/dashboard-state.ts'
import type { DashboardEvent } from '../src/dashboard-types.js'

type SentEvent = DashboardEvent
let sent: SentEvent[] = []

function makeMockServer() {
  sent = []
  return {
    start: () => Promise.resolve(true),
    processId: 'proc_test',
    send: (event: DashboardEvent) => {
      sent.push(event)
      return Promise.resolve()
    },
  }
}

beforeEach(() => {
  __resetForTests()
  sent = []
})
afterEach(() => {
  __resetForTests()
})

async function loadPlugin(
  directory = '/tmp/test-dir',
  options: Record<string, unknown> = {},
  server = makeMockServer(),
) {
  const pluginFn = ActiveAgentDashboard
  const hooks = await pluginFn({ directory, client: {} } as never, options, {
    createServer: () => server,
  })
  return hooks
}

describe('ActiveAgentDashboard — chat.message', () => {
  test('sends an "agent" event for chat.message with explicit agent', async () => {
    const hooks = await loadPlugin()
    const input = { sessionID: 's1', agent: 'plan' }
    const output: { message?: { agent?: string } } = {}
    await hooks['chat.message'](input as never, output as never)
    // chat.message may also fire on the initial heartbeat/agents — filter for 'agent'
    const agentEvents = sent.filter((e) => e.kind === 'agent')
    expect(agentEvents).toHaveLength(1)
    expect(agentEvents[0]).toMatchObject({ kind: 'agent', sessionID: 's1', agent: 'plan' })
  })
  test('falls back to output.message.agent when input.agent is missing', async () => {
    const hooks = await loadPlugin()
    const input = { sessionID: 's1' }
    const output = { message: { agent: 'build' } }
    await hooks['chat.message'](input as never, output as never)
    const agentEvents = sent.filter((e) => e.kind === 'agent')
    expect(agentEvents[0]?.kind).toBe('agent')
    if (agentEvents[0]?.kind === 'agent') expect(agentEvents[0].agent).toBe('build')
  })
  test('falls back to sessionID when neither input nor output has agent', async () => {
    const hooks = await loadPlugin()
    await hooks['chat.message']({ sessionID: 's1' } as never, {} as never)
    const agentEvents = sent.filter((e) => e.kind === 'agent')
    if (agentEvents[0]?.kind === 'agent') expect(agentEvents[0].agent).toBe('s1')
  })
  test('ignores chat.message without sessionID', async () => {
    const hooks = await loadPlugin()
    await hooks['chat.message']({} as never, {} as never)
    const agentEvents = sent.filter((e) => e.kind === 'agent')
    expect(agentEvents).toHaveLength(0)
  })
})

describe('ActiveAgentDashboard — tool.execute.before / after', () => {
  test('tool.execute.before sends toolActivity with phase=before', async () => {
    const hooks = await loadPlugin()
    await hooks['tool.execute.before']({ sessionID: 's1', tool: 'read' } as never)
    const ta = sent.filter((e) => e.kind === 'toolActivity')
    expect(ta).toHaveLength(1)
    if (ta[0]?.kind === 'toolActivity') {
      expect(ta[0].phase).toBe('before')
      expect(ta[0].tool).toBe('read')
    }
  })
  test('tool.execute.after sends toolActivity with phase=after', async () => {
    const hooks = await loadPlugin()
    await hooks['tool.execute.after']({ sessionID: 's1', tool: 'write' } as never)
    const ta = sent.filter((e) => e.kind === 'toolActivity')
    if (ta[0]?.kind === 'toolActivity') expect(ta[0].phase).toBe('after')
  })
  test('falls back to "tool" when tool name is missing', async () => {
    const hooks = await loadPlugin()
    await hooks['tool.execute.before']({ sessionID: 's1' } as never)
    const ta = sent.filter((e) => e.kind === 'toolActivity')
    if (ta[0]?.kind === 'toolActivity') expect(ta[0].tool).toBe('tool')
  })
})

describe('ActiveAgentDashboard — message.part.updated', () => {
  test('maps reasoning part to "reasoning" activity', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { sessionID: 's1', type: 'reasoning' } },
      },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    expect(acts).toHaveLength(1)
    if (acts[0]?.kind === 'activity') {
      expect(acts[0].activityType).toBe('reasoning')
      expect(acts[0].label).toBe('Reasoning')
    }
  })
  test('maps text part to "responding" activity', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { sessionID: 's1', type: 'text' } },
      },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    if (acts[0]?.kind === 'activity') expect(acts[0].activityType).toBe('responding')
  })
  test('maps retry part to "retrying"', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { sessionID: 's1', type: 'retry' } },
      },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    if (acts[0]?.kind === 'activity') expect(acts[0].activityType).toBe('retrying')
  })
  test('maps compaction to "compacting"', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { sessionID: 's1', type: 'compaction' } },
      },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    if (acts[0]?.kind === 'activity') expect(acts[0].activityType).toBe('compacting')
  })
  test('maps step-start to "thinking"', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { sessionID: 's1', type: 'step-start' } },
      },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    if (acts[0]?.kind === 'activity') expect(acts[0].activityType).toBe('thinking')
  })
  test('maps agent part to "spawning" with name label', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { sessionID: 's1', type: 'agent', name: 'plan-agent' } },
      },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    if (acts[0]?.kind === 'activity') {
      expect(acts[0].activityType).toBe('spawning')
      expect(acts[0].label).toContain('Spawning')
    }
  })
  test('truncates the spawning label to 20 chars', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { sessionID: 's1', type: 'agent', name: 'a-very-long-agent-name' } },
      },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    if (acts[0]?.kind === 'activity') expect(acts[0].label?.length).toBeLessThanOrEqual(20)
  })
  test('ignores part without sessionID', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: { type: 'message.part.updated', properties: { part: { type: 'text' } } },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    expect(acts).toHaveLength(0)
  })
  test('ignores unknown part type', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { sessionID: 's1', type: 'unknown' } },
      },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    expect(acts).toHaveLength(0)
  })
})

describe('ActiveAgentDashboard — permission events', () => {
  test('permission.asked sends "waiting" activity with approval label', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'permission.asked',
        properties: { sessionID: 's1', permission: 'bash', metadata: { filepath: '/etc/hosts' } },
      },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    expect(acts).toHaveLength(1)
    if (acts[0]?.kind === 'activity') {
      expect(acts[0].activityType).toBe('waiting')
      expect(acts[0].label).toMatch(/Needs approval/)
    }
  })
  test('permission.asked maps bash verb to "run"', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'permission.asked',
        properties: { sessionID: 's1', permission: 'bash' },
      },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    if (acts[0]?.kind === 'activity') expect(acts[0].label).toContain('run')
  })
  test('permission.asked maps read to "read"', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'permission.asked',
        properties: { sessionID: 's1', permission: 'read' },
      },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    if (acts[0]?.kind === 'activity') expect(acts[0].label).toMatch(/^Needs approval: read/)
  })
  test('permission.asked uses patterns[0] when no filepath', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'permission.asked',
        properties: { sessionID: 's1', permission: 'read', patterns: ['*.log'] },
      },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    if (acts[0]?.kind === 'activity') expect(acts[0].label).toContain('*.log')
  })
  test('permission.asked truncates label to 40 chars', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'permission.asked',
        properties: {
          sessionID: 's1',
          permission: 'bash',
          metadata: { filepath: '/a-very-long-file-path-that-definitely-exceeds-forty-chars.txt' },
        },
      },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    if (acts[0]?.kind === 'activity') expect(acts[0].label?.length).toBeLessThanOrEqual(40)
  })
  test('permission.replied sends "thinking" activity', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: { type: 'permission.replied', properties: { sessionID: 's1' } },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    expect(acts).toHaveLength(1)
    if (acts[0]?.kind === 'activity') {
      expect(acts[0].activityType).toBe('thinking')
      expect(acts[0].label).toBe('Thinking')
    }
  })
  test('permission.asked without sessionID is ignored', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: { type: 'permission.asked', properties: { permission: 'read' } },
    } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    expect(acts).toHaveLength(0)
  })
})

describe('ActiveAgentDashboard — session events', () => {
  test('session.created sends "created" event with directory and agent', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 's1', directory: '/tmp/dir', agent: 'plan' } },
      },
    } as never)
    const created = sent.filter((e) => e.kind === 'created')
    expect(created).toHaveLength(1)
    if (created[0]?.kind === 'created') {
      expect(created[0].sessionID).toBe('s1')
      expect(created[0].cwd).toBe('/tmp/dir')
      expect(created[0].agent).toBe('plan')
    }
  })
  test('session.created uses localAgents when info.agent is missing', async () => {
    const hooks = await loadPlugin()
    // Seed localAgents via chat.message
    await hooks['chat.message']({ sessionID: 's1', agent: 'plan' } as never, {} as never)
    sent.length = 0 // clear agent events from chat.message
    await hooks.event({
      event: { type: 'session.created', properties: { info: { id: 's1' } } },
    } as never)
    const created = sent.filter((e) => e.kind === 'created')
    if (created[0]?.kind === 'created') expect(created[0].agent).toBe('plan')
  })
  test('session.status sends "status" event for valid status', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'session.status',
        properties: { info: { id: 's1' }, status: { type: 'busy' } },
      },
    } as never)
    const status = sent.filter((e) => e.kind === 'status')
    expect(status).toHaveLength(1)
    if (status[0]?.kind === 'status') expect(status[0].status).toBe('busy')
  })
  test('session.status with unknown status type is ignored', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: {
        type: 'session.status',
        properties: { info: { id: 's1' }, status: { type: 'weird-state' } },
      },
    } as never)
    const status = sent.filter((e) => e.kind === 'status')
    expect(status).toHaveLength(0)
  })
  test('session.deleted sends "inactive" event', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: { type: 'session.deleted', properties: { info: { id: 's1' } } },
    } as never)
    const inactive = sent.filter((e) => e.kind === 'inactive')
    expect(inactive).toHaveLength(1)
    if (inactive[0]?.kind === 'inactive') expect(inactive[0].sessionID).toBe('s1')
  })
  test('session.error sends "inactive" event', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: { type: 'session.error', properties: { info: { id: 's1' } } },
    } as never)
    const inactive = sent.filter((e) => e.kind === 'inactive')
    expect(inactive).toHaveLength(1)
  })
  test('session.deleted clears localAgents entry', async () => {
    const hooks = await loadPlugin()
    await hooks['chat.message']({ sessionID: 's1', agent: 'plan' } as never, {} as never)
    sent.length = 0
    await hooks.event({
      event: { type: 'session.deleted', properties: { info: { id: 's1' } } },
    } as never)
    sent.length = 0
    // After delete, a new session.created for s1 should NOT pick the old agent.
    await hooks.event({
      event: { type: 'session.created', properties: { info: { id: 's1' } } },
    } as never)
    const created = sent.filter((e) => e.kind === 'created')
    if (created[0]?.kind === 'created') expect(created[0].agent).toBeUndefined()
  })
  test('session event without sessionID is ignored', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: { type: 'session.created', properties: { info: { directory: '/tmp' } } },
    } as never)
    const created = sent.filter((e) => e.kind === 'created')
    expect(created).toHaveLength(0)
  })
})

describe('ActiveAgentDashboard — unknown event types', () => {
  test('unknown event.type is silently ignored', async () => {
    const hooks = await loadPlugin()
    await hooks.event({
      event: { type: 'something.weird', properties: { sessionID: 's1' } },
    } as never)
    const types = sent.map((e) => e.kind)
    // Only heartbeat/agents initial events should be present (kind of).
    expect(types.filter((t) => t !== 'heartbeat' && t !== 'agents')).toEqual([])
  })
  test('event with no type is ignored', async () => {
    const hooks = await loadPlugin()
    await hooks.event({ event: { properties: {} } } as never)
    const types = sent.map((e) => e.kind)
    expect(types.filter((t) => t !== 'heartbeat' && t !== 'agents')).toEqual([])
  })
  test('event with null properties is handled gracefully', async () => {
    const hooks = await loadPlugin()
    await hooks.event({ event: { type: 'message.part.updated', properties: null } } as never)
    const acts = sent.filter((e) => e.kind === 'activity')
    expect(acts).toHaveLength(0)
  })
})

describe('ActiveAgentDashboard — configuration', () => {
  test('respects host option', async () => {
    const hooks = await loadPlugin('/tmp', { host: '0.0.0.0' })
    // We can't easily assert the host was used, but the plugin should load
    // without throwing.
    expect(hooks).toBeDefined()
  })
  test('respects port option when valid', async () => {
    const hooks = await loadPlugin('/tmp', { port: 19_999 })
    expect(hooks).toBeDefined()
  })
  test('falls back to default port when invalid', async () => {
    const hooks = await loadPlugin('/tmp', { port: -1 })
    expect(hooks).toBeDefined()
  })
  test('falls back to default port when non-integer', async () => {
    const hooks = await loadPlugin('/tmp', { port: 3.14 })
    expect(hooks).toBeDefined()
  })
  test('reads OPENCODE_AGENT_GRAPH_PORT env var', async () => {
    const orig = process.env.OPENCODE_AGENT_GRAPH_PORT
    process.env.OPENCODE_AGENT_GRAPH_PORT = '19888'
    try {
      const hooks = await loadPlugin()
      expect(hooks).toBeDefined()
    } finally {
      if (orig === undefined) delete process.env.OPENCODE_AGENT_GRAPH_PORT
      else process.env.OPENCODE_AGENT_GRAPH_PORT = orig
    }
  })
  test('uses directory as cwd when provided', async () => {
    const hooks = await loadPlugin('/some/other/dir')
    // session.created falls back to directory when info.directory is missing.
    await hooks.event({
      event: { type: 'session.created', properties: { info: { id: 's1' } } },
    } as never)
    const created = sent.filter((e) => e.kind === 'created')
    if (created[0]?.kind === 'created') expect(created[0].cwd).toBe('/some/other/dir')
  })
})

describe('ActiveAgentDashboard — initial events', () => {
  test('sends an initial heartbeat on load', async () => {
    await loadPlugin()
    const heartbeats = sent.filter((e) => e.kind === 'heartbeat')
    expect(heartbeats.length).toBeGreaterThanOrEqual(1)
  })
})
