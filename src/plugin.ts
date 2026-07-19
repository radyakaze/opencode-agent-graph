import type { Plugin } from '@opencode-ai/plugin'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_HOST, DEFAULT_PORT, HEARTBEAT_INTERVAL_MS, MAX_PORT } from './constants.js'
import { discoverAgents } from './discovery.js'
import { processId } from './dashboard-state.js'
import { createGraphServer } from './server.js'
import type { ActivityType, DashboardEvent, Status } from './dashboard-types.js'

type Input = { sessionID?: string; agent?: string }
type Output = { message?: { agent?: string } }
type Config = { host?: string; port?: number }
type EventLike = { type?: string; properties?: unknown }
type Properties = Record<string, unknown>
type Sender = (event: DashboardEvent) => Promise<void>

const HOST_ENV = 'OPENCODE_AGENT_GRAPH_HOST'
const PORT_ENV = 'OPENCODE_AGENT_GRAPH_PORT'
const TOOL_NAME_FALLBACK = 'tool'
const MAX_PERMISSION_LABEL = 40
const MAX_SPAWN_LABEL = 20

function clampPort(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < MAX_PORT
    ? value
    : fallback
}

const PERMISSION_VERBS: Record<string, string> = {
  read: 'read',
  edit: 'edit',
  write: 'write',
  bash: 'run',
  external_directory: 'read',
}

function verbFor(permission: string): string {
  return PERMISSION_VERBS[permission] ?? permission
}

function stringField(record: Properties, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function nowIso(): string {
  return new Date().toISOString()
}

function asProperties(value: unknown): Properties {
  return value && typeof value === 'object' ? (value as Properties) : {}
}

function isStatus(value: unknown): value is Status {
  return value === 'busy' || value === 'retry' || value === 'idle'
}

function permissionLabel(properties: Properties): string {
  const permission = stringField(properties, 'permission') ?? 'action'
  const verb = verbFor(permission)
  const metadata = asProperties(properties.metadata)
  const filepath = stringField(metadata, 'filepath')
  const patterns = Array.isArray(properties.patterns) ? properties.patterns : []
  const target = filepath ?? (typeof patterns[0] === 'string' ? (patterns[0] as string) : '')
  const phrase = target ? `Needs approval: ${verb} ${target}` : `Needs approval: ${verb}`
  return truncate(phrase, MAX_PERMISSION_LABEL)
}

function partActivityLabel(
  partType: string,
  part: Properties,
): { type: ActivityType; label: string } | null {
  if (partType === 'reasoning') return { type: 'reasoning', label: 'Reasoning' }
  if (partType === 'text') return { type: 'responding', label: 'Responding' }
  if (partType === 'agent') {
    const name = stringField(part, 'name') ?? 'agent'
    return { type: 'spawning', label: truncate(`Spawning ${name}`, MAX_SPAWN_LABEL) }
  }
  if (partType === 'retry') return { type: 'retrying', label: 'Retrying' }
  if (partType === 'compaction') return { type: 'compacting', label: 'Compacting' }
  if (partType === 'step-start') return { type: 'thinking', label: 'Thinking' }
  return null
}

type Ctx = { send: Sender; cwd: string; localAgents: Map<string, string> }

/**
 * Build a dispatch table mapping OpenCode event type names to handlers.
 * The handler may be `undefined` for event types we ignore.
 */
function buildEventHandlers(
  ctx: Ctx,
): Record<string, ((event: EventLike) => Promise<void>) | undefined> {
  const send = ctx.send
  const cwd = ctx.cwd
  const localAgents = ctx.localAgents

  // message.part.updated carries sessionID inside properties.part, not at the
  // top level — extract it before the generic sessionID extraction.
  const handleMessagePartUpdated = async (event: EventLike) => {
    const part = event.properties && (event.properties as Properties).part
    if (!part || typeof part !== 'object') return
    const partSessionID = stringField(part as Properties, 'sessionID')
    if (!partSessionID) return
    const partType = stringField(part as Properties, 'type') ?? ''
    const activity = partActivityLabel(partType, part as Properties)
    if (!activity) return
    await send({
      kind: 'activity',
      processId,
      sessionID: partSessionID,
      activityType: activity.type,
      label: activity.label,
      timestamp: nowIso(),
    })
  }

  // permission.asked/replied carry sessionID at the top level (not under
  // info.id like session events) — handle before the generic extraction.
  const handlePermissionAsked = async (event: EventLike) => {
    const properties = asProperties(event.properties)
    const permSessionID = stringField(properties, 'sessionID')
    if (!permSessionID) return
    await send({
      kind: 'activity',
      processId,
      sessionID: permSessionID,
      activityType: 'waiting',
      label: permissionLabel(properties),
      timestamp: nowIso(),
    })
  }
  const handlePermissionReplied = async (event: EventLike) => {
    const properties = asProperties(event.properties)
    const permSessionID = stringField(properties, 'sessionID')
    if (!permSessionID) return
    await send({
      kind: 'activity',
      processId,
      sessionID: permSessionID,
      activityType: 'thinking',
      label: 'Thinking',
      timestamp: nowIso(),
    })
  }

  const extractSessionID = (info: Properties, properties: Properties) =>
    stringField(info, 'id') ?? stringField(properties, 'sessionID')

  const handleSessionCreated = async (event: EventLike) => {
    const properties = asProperties(event.properties)
    const info = asProperties(properties.info)
    const sessionID = extractSessionID(info, properties)
    if (!sessionID) return
    await send({
      kind: 'created',
      processId,
      sessionID,
      cwd: stringField(info, 'directory') ?? cwd,
      agent: stringField(info, 'agent') ?? localAgents.get(sessionID),
      timestamp: nowIso(),
    })
  }

  const handleSessionStatus = async (event: EventLike) => {
    const properties = asProperties(event.properties)
    const info = asProperties(properties.info)
    const sessionID = extractSessionID(info, properties)
    if (!sessionID) return
    const status = (properties.status as Properties | undefined)?.type
    if (!isStatus(status)) return
    await send({
      kind: 'status',
      processId,
      sessionID,
      cwd,
      agent: localAgents.get(sessionID),
      status,
      timestamp: nowIso(),
    })
  }

  const handleSessionDeletedOrError = async (event: EventLike) => {
    const properties = asProperties(event.properties)
    const info = asProperties(properties.info)
    const sessionID = extractSessionID(info, properties)
    if (!sessionID) return
    localAgents.delete(sessionID)
    await send({ kind: 'inactive', processId, sessionID })
  }

  return {
    'message.part.updated': handleMessagePartUpdated,
    'permission.asked': handlePermissionAsked,
    'permission.replied': handlePermissionReplied,
    'session.created': handleSessionCreated,
    'session.status': handleSessionStatus,
    'session.deleted': handleSessionDeletedOrError,
    'session.error': handleSessionDeletedOrError,
  }
}

export type CreateServer = (opts: { host: string; port: number; publicRoot: string }) => {
  start: () => Promise<boolean>
  send: (event: DashboardEvent) => Promise<void>
  processId: string
}

export const ActiveAgentDashboard: Plugin = async (
  { directory, client },
  options,
  deps?: { createServer?: CreateServer },
) => {
  const createServer = deps?.createServer ?? createGraphServer
  const config = (options ?? {}) as Config
  const host = config.host ?? process.env[HOST_ENV] ?? DEFAULT_HOST
  const port = clampPort(config.port ?? Number(process.env[PORT_ENV]), DEFAULT_PORT)
  const cwd = directory || process.cwd()
  const graph = createServer({
    host,
    port,
    publicRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../public'),
  })
  const send: Sender = (event) => graph.send(event)
  let agents: unknown[] = []
  const localAgents = new Map<string, string>()
  void discoverAgents(client, cwd).then((found) => {
    agents = found
    return send({ kind: 'agents', processId, cwd, agents })
  })
  void graph.start()
  const heartbeat = () => void send({ kind: 'heartbeat', processId, cwd, agents })
  heartbeat()
  const timer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS) as ReturnType<typeof setInterval>
  timer.unref?.()
  const toolActivity = async (
    input: { sessionID: string; tool?: string; callID?: string },
    phase: 'before' | 'after',
  ) => {
    await send({
      kind: 'toolActivity',
      processId,
      sessionID: input.sessionID,
      tool: stringField(input as Properties, 'tool') ?? TOOL_NAME_FALLBACK,
      phase,
      timestamp: nowIso(),
    })
  }
  const eventHandlers = buildEventHandlers({ send, cwd, localAgents })
  return {
    'chat.message': async (input: Input, output: Output) => {
      if (!input?.sessionID) return
      const agent = input.agent || output?.message?.agent || input.sessionID
      localAgents.set(input.sessionID, agent)
      await send({
        kind: 'agent',
        processId,
        sessionID: input.sessionID,
        cwd,
        agent,
      })
    },
    'tool.execute.before': (input: { sessionID: string; tool?: string; callID?: string }) =>
      toolActivity(input, 'before'),
    'tool.execute.after': (input: { sessionID: string; tool?: string; callID?: string }) =>
      toolActivity(input, 'after'),
    event: async ({ event }: { event: EventLike }) => {
      const type = event.type ?? ''
      const handler = eventHandlers[type]
      if (!handler) return
      await handler(event)
    },
  }
}
export default ActiveAgentDashboard
