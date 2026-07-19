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
function publish(): void {
  updatedAt = new Date().toISOString()
  notify?.()
}
function timestamp(value: unknown): string {
  return typeof value === 'string' ? value : new Date().toISOString()
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
  if (typeof message.processId !== 'string') return
  processes.set(message.processId, Date.now())
  if (typeof message.cwd === 'string' && message.cwd) {
    const cwds = processCwds.get(message.processId) ?? new Set<string>()
    cwds.add(message.cwd)
    processCwds.set(message.processId, cwds)
  }
}
function mergeAgents(input: unknown, cwd: unknown): void {
  if (!Array.isArray(input) || typeof cwd !== 'string' || !cwd) return
  const registry = availableAgents.get(cwd) ?? new Map<string, AgentInfo>()
  availableAgents.set(cwd, registry)
  let changed = false
  for (const raw of input) {
    const item = raw && typeof raw === 'object' ? (raw as DashboardEvent) : null
    if (!item || typeof item.name !== 'string' || !item.name) continue
    let agent = registry.get(item.name)
    if (!agent) {
      agent = {
        name: item.name,
        description: typeof item.description === 'string' ? item.description : null,
        mode: typeof item.mode === 'string' ? item.mode : null,
        hidden: item.hidden === true,
        native: item.native === true,
        model: typeof item.model === 'string' ? item.model : null,
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

type Handler = (message: DashboardEvent) => void
type SessionHandler = (id: string, previous: Session | undefined, message: DashboardEvent) => void

function handleHello(message: DashboardEvent): void {
  mergeAgents(message.agents, message.cwd)
}
function handleHeartbeat(message: DashboardEvent): void {
  mergeAgents(message.agents, message.cwd)
}
function handleAgents(message: DashboardEvent): void {
  mergeAgents(message.agents, message.cwd)
  publish()
}
const controlHandlers: Record<string, Handler> = {
  hello: handleHello,
  heartbeat: handleHeartbeat,
  agents: handleAgents,
}

function handleCreated(id: string, previous: Session | undefined, message: DashboardEvent): void {
  const cwd = asString(message.cwd) ?? process.cwd()
  const startedAt = previous?.startedAt ?? timestamp(message.timestamp)
  sessions.set(id, {
    id,
    processId: String(message.processId),
    sessionId: String(message.sessionID),
    cwd,
    projectName: projectName(cwd),
    agent: asString(message.agent),
    status: previous?.status ?? 'idle',
    startedAt,
    activeStartedAt: previous?.activeStartedAt ?? null,
    lastActivityAt: previous?.lastActivityAt ?? timestamp(message.timestamp),
    currentActivity: previous?.currentActivity ?? null,
  })
  publish()
}
function handleInactive(id: string): boolean {
  if (sessions.delete(id)) {
    publish()
    return true
  }
  return false
}
function handleAgent(id: string, previous: Session | undefined, message: DashboardEvent): void {
  if (previous) {
    const agent = asString(message.agent)
    if (agent !== null) {
      previous.agent = agent
      publish()
    }
  }
}
function handleToolActivity(
  id: string,
  previous: Session | undefined,
  message: DashboardEvent,
): void {
  if (!previous) return
  const at = timestamp(message.timestamp)
  previous.lastActivityAt = at
  const tool = asString(message.tool) ?? 'tool'
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
  if (!previous) return
  const type = message.activityType as ActivityType
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
    label: asString(message.label) ?? 'Active',
    startedAt: timestamp(message.timestamp),
  }
  publish()
}
function handleStatus(id: string, previous: Session | undefined, message: DashboardEvent): void {
  const status = normalizeStatus(message.status)
  const cwd = asString(message.cwd) ?? process.cwd()
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
    processId: String(message.processId),
    sessionId: String(message.sessionID),
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
const sessionHandlers: Record<string, SessionHandler> = {
  created: handleCreated,
  inactive: (id) => {
    handleInactive(id)
  },
  agent: handleAgent,
  toolActivity: handleToolActivity,
  activity: handleActivity,
  status: handleStatus,
}

export function accept(input: unknown): void {
  const message = input && typeof input === 'object' ? (input as DashboardEvent) : null
  if (!message || typeof message.kind !== 'string' || typeof message.processId !== 'string') return
  trackProcess(message)
  const control = controlHandlers[message.kind]
  if (control) {
    control(message)
    return
  }
  if (typeof message.sessionID !== 'string') return
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
