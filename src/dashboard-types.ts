export type Status = 'busy' | 'retry' | 'idle'
export type ActivityType =
  | 'reasoning'
  | 'responding'
  | 'thinking'
  | 'write'
  | 'tool'
  | 'mcp'
  | 'spawning'
  | 'retrying'
  | 'compacting'
  | 'waiting'
export type Activity = {
  type: ActivityType
  label: string
  startedAt: string
  tool?: string
}
export type AgentInfo = {
  name: string
  description: string | null
  mode: string | null
  hidden: boolean
  native: boolean
  model: string | null
  directories: Set<string>
}
export type DashboardState = {
  projects: Array<{
    cwd: string
    name: string
    agents: Array<Record<string, unknown>>
    availableAgents: Array<Omit<AgentInfo, 'directories'>>
  }>
  updatedAt: string
}

export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() || 'Project'
}

type BaseEvent = {
  processId: string
  cwd?: string
  timestamp?: string
}

type HelloEvent = BaseEvent & {
  kind: 'hello'
  agents?: unknown
}
type HeartbeatEvent = BaseEvent & {
  kind: 'heartbeat'
  agents?: unknown
}
type AgentsEvent = BaseEvent & {
  kind: 'agents'
  agents?: unknown
}

type SessionEvent = BaseEvent & {
  sessionID: string
}
type CreatedEvent = SessionEvent & {
  kind: 'created'
  agent?: string
}
type InactiveEvent = SessionEvent & {
  kind: 'inactive'
}
type AgentChangeEvent = SessionEvent & {
  kind: 'agent'
  agent?: string
}
type ToolActivityEvent = SessionEvent & {
  kind: 'toolActivity'
  tool?: string
  phase?: 'before' | 'after'
}
type ActivityEvent = SessionEvent & {
  kind: 'activity'
  activityType: ActivityType
  label?: string
}
type StatusEvent = SessionEvent & {
  kind: 'status'
  status: Status
  agent?: string
}

export type DashboardEvent =
  | HelloEvent
  | HeartbeatEvent
  | AgentsEvent
  | CreatedEvent
  | InactiveEvent
  | AgentChangeEvent
  | ToolActivityEvent
  | ActivityEvent
  | StatusEvent
