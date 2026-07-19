export type DiscoveredAgent = {
  name: string
  description: string | null
  mode: string | null
  hidden: boolean
  native: boolean
  model: string | null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}
function asBoolean(value: unknown): boolean {
  return value === true
}
function normalize(raw: unknown): DiscoveredAgent | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (typeof item.name !== 'string' || !item.name) return null
  return {
    name: item.name,
    description: asString(item.description),
    mode: asString(item.mode),
    hidden: asBoolean(item.hidden),
    native: asBoolean(item.native),
    model: asString(item.model),
  }
}

export async function discoverAgents(
  client: unknown,
  directory: string,
): Promise<DiscoveredAgent[]> {
  try {
    const api = client as Record<string, unknown>
    let response: unknown
    const v2 = api.v2 as Record<string, unknown> | undefined
    const agent = v2?.agent as Record<string, unknown> | undefined
    if (typeof agent?.list === 'function')
      response = await (agent.list as (arg: unknown) => Promise<unknown>)({
        location: { directory },
      })
    else if (typeof (api.app as Record<string, unknown> | undefined)?.agents === 'function')
      response = await (
        (api.app as Record<string, unknown>).agents as (arg: unknown) => Promise<unknown>
      )({ directory })
    const data = (response as Record<string, unknown> | undefined)?.data
    const list = ((data as Record<string, unknown> | undefined)?.data ?? data) as unknown
    if (!Array.isArray(list)) return []
    const out: DiscoveredAgent[] = []
    for (const value of list) {
      const agent = normalize(value)
      if (agent) out.push(agent)
    }
    return out
  } catch {
    return []
  }
}
