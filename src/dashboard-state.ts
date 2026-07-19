import {
  Activity,
  ActivityType,
  AgentInfo,
  DashboardEvent,
  DashboardState,
  Status,
  projectName,
} from './dashboard-types.js'

const sessions = new Map<string, Session>()
const processes = new Map<string, number>()
const availableAgents = new Map<string, Map<string, AgentInfo>>()
const processCwds = new Map<string, Set<string>>()
let updatedAt = new Date().toISOString()
let notify: (() => void) | undefined
export const processId = `proc_${process.pid}`

type Session = {
  id: string
  processId: string
  sessionId: string
  cwd: string
  projectName: string
  agent: string | null
  status: Status
  startedAt: string
  activeStartedAt: string | null
  lastActivityAt: string
  currentActivity: Activity | null
}

export function setNotifier(value: () => void): void {
  notify = value
}

/**
 * Test-only: reset all module-level state. Not part of the public API.
 * Production code should never call this.
 */
export function __resetForTests(): void {
  sessions.clear()
  processes.clear()
  availableAgents.clear()
  processCwds.clear()
  updatedAt = new Date().toISOString()
  notify = undefined
}
function publish(): void {
  updatedAt = new Date().toISOString()
  notify?.()
}
function timestamp(value: string | undefined): string {
  return value ?? new Date().toISOString()
}
const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'apply_patch',
  'write_file',
  'str_replace',
  'replace',
])
function classifyTool(tool: string): ActivityType {
  if (WRITE_TOOLS.has(tool)) return 'write'
  if (tool.startsWith('mcp__') || tool.startsWith('mcp.')) return 'mcp'
  return 'tool'
}
function formatActivityLabel(tool: string, type: ActivityType): string {
  if (type === 'write') return 'writing'
  if (type === 'mcp') {
    const parts = tool.split('__')
    const server = parts.length > 1 ? parts[1] : tool
    return `mcp ${server}`
  }
  return tool
}
function normalizeStatus(value: unknown): Status {
  return value === 'retry' ? 'retry' : value === 'idle' ? 'idle' : 'busy'
}
function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}
function trackProcess(message: DashboardEvent): void {
  processes.set(message.processId, Date.now())
  if (message.cwd) {
    const cwds = processCwds.get(message.processId) ?? new Set<string>()
    cwds.add(message.cwd)
    processCwds.set(message.processId, cwds)
  }
}
function mergeAgents(input: unknown, cwd: string | undefined): void {
  if (!Array.isArray(input) || !cwd) return
  const registry = availableAgents.get(cwd) ?? new Map<string, AgentInfo>()
  availableAgents.set(cwd, registry)
  let changed = false
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (typeof item.name !== 'string' || !item.name) continue
    let agent = registry.get(item.name)
    if (!agent) {
      agent = {
        name: item.name,
        description: asString(item.description),
        mode: asString(item.mode),
        hidden: item.hidden === true,
        native: item.native === true,
        model: asString(item.model),
        directories: new Set(),
      }
      registry.set(item.name, agent)
      changed = true
    }
    if (!agent.directories.has(cwd)) {
      agent.directories.add(cwd)
      changed = true
    }
  }
  if (changed) publish()
}

type ControlHandler = (message: DashboardEvent) => void
function handleHello(message: DashboardEvent): void {
  if (message.kind === 'hello') mergeAgents(message.agents, message.cwd)
}
function handleHeartbeat(message: DashboardEvent): void {
  if (message.kind === 'heartbeat') mergeAgents(message.agents, message.cwd)
}
function handleAgents(message: DashboardEvent): void {
  if (message.kind !== 'agents') return
  mergeAgents(message.agents, message.cwd)
  publish()
}
const controlHandlers: Record<DashboardEvent['kind'], ControlHandler | undefined> = {
  hello: handleHello,
  heartbeat: handleHeartbeat,
  agents: handleAgents,
  created: undefined,
  inactive: undefined,
  agent: undefined,
  toolActivity: undefined,
  activity: undefined,
  status: undefined,
}

type SessionHandler = (id: string, previous: Session | undefined, message: DashboardEvent) => void

function handleCreated(id: string, previous: Session | undefined, message: DashboardEvent): void {
  if (message.kind !== 'created') return
  const cwd = message.cwd ?? process.cwd()
  const at = timestamp(message.timestamp)
  sessions.set(id, {
    id,
    processId: message.processId,
    sessionId: message.sessionID,
    cwd,
    projectName: projectName(cwd),
    agent: asString(message.agent),
    status: previous?.status ?? 'idle',
    startedAt: previous?.startedAt ?? at,
    activeStartedAt: previous?.activeStartedAt ?? null,
    lastActivityAt: previous?.lastActivityAt ?? at,
    currentActivity: previous?.currentActivity ?? null,
  })
  publish()
}
function handleInactive(id: string): void {
  if (sessions.delete(id)) publish()
}
function handleAgent(id: string, previous: Session | undefined, message: DashboardEvent): void {
  if (message.kind !== 'agent' || !previous) return
  const agent = asString(message.agent)
  if (agent !== null) {
    previous.agent = agent
    publish()
  }
}
function handleToolActivity(
  id: string,
  previous: Session | undefined,
  message: DashboardEvent,
): void {
  if (message.kind !== 'toolActivity' || !previous) return
  const at = timestamp(message.timestamp)
  previous.lastActivityAt = at
  const tool = message.tool ?? 'tool'
  const phase = message.phase === 'after' ? 'after' : 'before'
  if (phase === 'before') {
    const type = classifyTool(tool)
    previous.currentActivity = {
      type,
      label: formatActivityLabel(tool, type),
      startedAt: at,
      tool,
    }
  } else {
    // Tool finished → back to thinking (or idle if not busy)
    previous.currentActivity =
      previous.status === 'busy' || previous.status === 'retry'
        ? { type: 'thinking', label: 'Thinking', startedAt: at }
        : null
  }
  publish()
}
function handleActivity(id: string, previous: Session | undefined, message: DashboardEvent): void {
  if (message.kind !== 'activity' || !previous) return
  const type = message.activityType
  // Dedup: message.part.updated fires on every token delta, but the
  // activity type doesn't change for the same part — skip publish when
  // the type is unchanged so the dashboard doesn't thrash.
  if (previous.currentActivity?.type === type) {
    previous.lastActivityAt = timestamp(message.timestamp)
    return
  }
  previous.lastActivityAt = timestamp(message.timestamp)
  previous.currentActivity = {
    type,
    label: message.label ?? 'Active',
    startedAt: timestamp(message.timestamp),
  }
  publish()
}
function handleStatus(id: string, previous: Session | undefined, message: DashboardEvent): void {
  if (message.kind !== 'status') return
  const status = normalizeStatus(message.status)
  const cwd = message.cwd ?? process.cwd()
  const at = timestamp(message.timestamp)
  const currentActivity =
    status === 'idle'
      ? null
      : (previous?.currentActivity ?? {
          type: 'thinking' as ActivityType,
          label: 'Thinking',
          startedAt: at,
        })
  sessions.set(id, {
    id,
    processId: message.processId,
    sessionId: message.sessionID,
    cwd: previous?.cwd ?? cwd,
    projectName: previous?.projectName ?? projectName(cwd),
    agent: previous?.agent ?? asString(message.agent),
    status,
    startedAt: previous?.startedAt ?? at,
    activeStartedAt: status === 'idle' ? null : (previous?.activeStartedAt ?? at),
    lastActivityAt: previous?.lastActivityAt ?? at,
    currentActivity,
  })
  publish()
}
const sessionHandlers: Record<DashboardEvent['kind'], SessionHandler | undefined> = {
  hello: undefined,
  heartbeat: undefined,
  agents: undefined,
  created: handleCreated,
  inactive: (id) => handleInactive(id),
  agent: handleAgent,
  toolActivity: handleToolActivity,
  activity: handleActivity,
  status: handleStatus,
}

function isSessionEvent(
  message: DashboardEvent,
): message is Extract<DashboardEvent, { sessionID: string }> {
  return 'sessionID' in message
}

export function accept(input: unknown): void {
  if (!input || typeof input !== 'object') return
  const candidate = input as Record<string, unknown>
  if (typeof candidate.kind !== 'string' || typeof candidate.processId !== 'string') return
  const message = candidate as unknown as DashboardEvent
  trackProcess(message)
  const control = controlHandlers[message.kind]
  if (control) {
    control(message)
    return
  }
  if (!isSessionEvent(message)) return
  const id = `${message.processId}:${message.sessionID}`
  const previous = sessions.get(id)
  const handler = sessionHandlers[message.kind]
  if (!handler) return
  handler(id, previous, message)
}
export function removeStale(cutoff: number): void {
  let changed = false
  for (const [id, seen] of processes)
    if (seen < cutoff) {
      processes.delete(id)
      const cwds = processCwds.get(id) ?? new Set<string>()
      processCwds.delete(id)
      for (const cwd of cwds) {
        const stillOwned = [...processCwds].some(
          ([processId, ownedCwds]) => processes.has(processId) && ownedCwds.has(cwd),
        )
        if (!stillOwned && availableAgents.delete(cwd)) changed = true
      }
      for (const sessionId of sessions.keys())
        if (sessionId.startsWith(`${id}:`)) {
          sessions.delete(sessionId)
          changed = true
        }
    }
  if (changed) publish()
}
export function state(): DashboardState {
  const now = Date.now()
  const grouped = new Map<
    string,
    {
      cwd: string
      name: string
      agents: Array<Record<string, unknown>>
      availableAgents: AgentInfo[]
    }
  >()
  for (const session of sessions.values()) {
    if (session.status !== 'busy' && session.status !== 'retry') continue
    const project = grouped.get(session.cwd) ?? {
      cwd: session.cwd,
      name: session.projectName,
      agents: [],
      availableAgents: [],
    }
    project.agents.push({
      name: session.agent,
      sessionId: session.sessionId,
      processId: session.processId,
      status: session.status,
      activeStartedAt: session.activeStartedAt,
      lastActivityAt: session.lastActivityAt,
      startedAt: session.startedAt,
      currentActivity: session.currentActivity,
      elapsedSeconds: session.activeStartedAt
        ? Math.max(0, Math.floor((now - Date.parse(session.activeStartedAt)) / 1000))
        : 0,
    })
    grouped.set(session.cwd, project)
  }
  for (const [cwd, registry] of availableAgents) {
    const project = grouped.get(cwd) ?? {
      cwd,
      name: projectName(cwd),
      agents: [],
      availableAgents: [],
    }
    project.availableAgents = [...registry.values()].sort((a, b) => a.name.localeCompare(b.name))
    grouped.set(cwd, project)
  }
  return {
    updatedAt,
    projects: [...grouped.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd))
      .map(({ availableAgents: agents, ...project }) => ({
        ...project,
        availableAgents: agents.map(({ directories: _, ...agent }) => agent),
        agents: project.agents.sort((a, b) =>
          String(a.name ?? '').localeCompare(String(b.name ?? '')),
        ),
      })),
  }
}
