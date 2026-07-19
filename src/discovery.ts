import { DashboardEvent } from './dashboard-types.js'
export async function discoverAgents(
  client: unknown,
  directory: string,
): Promise<DashboardEvent[]> {
  try {
    const api = client as DashboardEvent
    let response: unknown
    const v2 = api.v2 as DashboardEvent | undefined
    const agent = v2?.agent as DashboardEvent | undefined
    if (typeof agent?.list === 'function')
      response = await (agent.list as (arg: unknown) => Promise<unknown>)({
        location: { directory },
      })
    else if (typeof (api.app as DashboardEvent | undefined)?.agents === 'function')
      response = await ((api.app as DashboardEvent).agents as (arg: unknown) => Promise<unknown>)({
        directory,
      })
    const data = (response as DashboardEvent)?.data
    const list = (data as DashboardEvent)?.data ?? data
    return Array.isArray(list)
      ? list.flatMap((value) => {
          if (
            !value ||
            typeof value !== 'object' ||
            typeof (value as DashboardEvent).name !== 'string'
          )
            return []
          const item = value as DashboardEvent
          return [
            {
              name: item.name,
              description: typeof item.description === 'string' ? item.description : null,
              mode: typeof item.mode === 'string' ? item.mode : null,
              hidden: item.hidden === true,
              native: item.native === true,
              model: typeof item.model === 'string' ? item.model : null,
            },
          ]
        })
      : []
  } catch {
    return []
  }
}
