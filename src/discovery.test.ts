import { describe, expect, test } from 'bun:test'
import { discoverAgents } from './discovery.ts'

const DIRECTORY = '/tmp/test-project'

function v2Client(listResult: unknown): unknown {
  return {
    v2: {
      agent: {
        async list(arg: { location: { directory: string } }) {
          expect(arg.location.directory).toBe(DIRECTORY)
          return listResult
        },
      },
    },
  }
}
function legacyClient(listResult: unknown): unknown {
  return {
    app: {
      async agents(arg: { directory: string }) {
        expect(arg.directory).toBe(DIRECTORY)
        return listResult
      },
    },
  }
}
const SAMPLE = {
  name: 'build',
  description: 'Builds the project',
  mode: 'primary',
  hidden: false,
  native: true,
  model: 'gpt-4',
}

describe('discoverAgents — v2 client', () => {
  test('returns a flat list when v2.agent.list returns the data directly', async () => {
    const result = await discoverAgents(v2Client({ data: [SAMPLE] }), DIRECTORY)
    expect(result).toEqual([SAMPLE])
  })
  test('returns a flat list when v2 wraps data twice (data.data)', async () => {
    const result = await discoverAgents(v2Client({ data: { data: [SAMPLE] } }), DIRECTORY)
    expect(result).toEqual([SAMPLE])
  })
  test('passes directory via { location: { directory } } argument', async () => {
    const result = await discoverAgents(v2Client({ data: [] }), DIRECTORY)
    expect(result).toEqual([])
  })
  test('normalizes the agent shape (drops non-typed fields)', async () => {
    const result = await discoverAgents(
      v2Client({ data: [{ ...SAMPLE, extraField: 'ignored', hidden: 'not-bool' }] }),
      DIRECTORY,
    )
    expect(result).toEqual([{ ...SAMPLE, hidden: false }])
  })
})

describe('discoverAgents — legacy client', () => {
  test('falls back to client.app.agents when v2 is absent', async () => {
    const result = await discoverAgents(legacyClient({ data: [SAMPLE] }), DIRECTORY)
    expect(result).toEqual([SAMPLE])
  })
  test('legacy path also unwraps data.data', async () => {
    const result = await discoverAgents(legacyClient({ data: { data: [SAMPLE] } }), DIRECTORY)
    expect(result).toEqual([SAMPLE])
  })
})

describe('discoverAgents — graceful degradation', () => {
  test('returns [] when neither v2 nor legacy is present', async () => {
    const result = await discoverAgents({}, DIRECTORY)
    expect(result).toEqual([])
  })
  test('returns [] when the list method rejects', async () => {
    const client = {
      v2: {
        agent: {
          async list() {
            throw new Error('upstream down')
          },
        },
      },
    }
    const result = await discoverAgents(client, DIRECTORY)
    expect(result).toEqual([])
  })
  test('returns [] when the client throws synchronously', async () => {
    const client = {
      get v2() {
        throw new Error('boom')
      },
    }
    const result = await discoverAgents(client, DIRECTORY)
    expect(result).toEqual([])
  })
  test('returns [] when the response is not an array', async () => {
    const result = await discoverAgents(v2Client({ data: 'not a list' }), DIRECTORY)
    expect(result).toEqual([])
  })
  test('returns [] when the response is null', async () => {
    const result = await discoverAgents(v2Client(null), DIRECTORY)
    expect(result).toEqual([])
  })
})

describe('discoverAgents — input filtering', () => {
  test('drops entries without a name', async () => {
    const result = await discoverAgents(
      v2Client({ data: [SAMPLE, { description: 'no name' }, null, 'string', 42] }),
      DIRECTORY,
    )
    expect(result).toEqual([SAMPLE])
  })
  test('drops entries with empty-string name', async () => {
    const result = await discoverAgents(v2Client({ data: [{ name: '' }] }), DIRECTORY)
    expect(result).toEqual([])
  })
  test('keeps entries with only a name (other fields nullable)', async () => {
    const result = await discoverAgents(v2Client({ data: [{ name: 'minimal' }] }), DIRECTORY)
    expect(result).toEqual([
      {
        name: 'minimal',
        description: null,
        mode: null,
        hidden: false,
        native: false,
        model: null,
      },
    ])
  })
  test('coerces non-boolean hidden/native to false', async () => {
    const result = await discoverAgents(
      v2Client({ data: [{ name: 'x', hidden: 1, native: 'yes' }] }),
      DIRECTORY,
    )
    expect(result[0].hidden).toBe(false)
    expect(result[0].native).toBe(false)
  })
  test('preserves true booleans', async () => {
    const result = await discoverAgents(
      v2Client({ data: [{ name: 'x', hidden: true, native: true }] }),
      DIRECTORY,
    )
    expect(result[0].hidden).toBe(true)
    expect(result[0].native).toBe(true)
  })
  test('coerces non-string optional fields to null', async () => {
    const result = await discoverAgents(
      v2Client({ data: [{ name: 'x', description: 5, mode: {}, model: [] }] }),
      DIRECTORY,
    )
    expect(result[0].description).toBeNull()
    expect(result[0].mode).toBeNull()
    expect(result[0].model).toBeNull()
  })
})
