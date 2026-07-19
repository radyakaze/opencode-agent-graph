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
export type Session = {
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
export type DashboardEvent = Record<string, unknown>
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
