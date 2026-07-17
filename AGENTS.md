# Agent Notes

## Commands

- `bun install`
- `bun run typecheck` — strict TypeScript check without emitting files.
- `bun run build` — emits ESM JavaScript and declarations from `src/` into `dist/`.

## Layout

- `src/plugin.ts` exports `ActiveAgentDashboard` and wires OpenCode events, agent discovery, heartbeats, and server lifecycle.
- `src/server.ts` owns HTTP/SSE endpoints, port coordination across plugin processes, static-file serving, and stale-process cleanup.
- `src/dashboard-state.ts` holds in-memory dashboard state; sessions are keyed by `${processId}:${sessionID}`.
- `src/discovery.ts` supports both `client.v2.agent.list` and legacy `client.app.agents`.
- `public/` holds dashboard assets. Keep it beside generated `dist/`: server resolves assets relative to `dist/plugin.js`.
- `dist/` is generated build output. Do not edit it directly.

## Runtime behavior

- Default dashboard address: `http://127.0.0.1:8818/`. Configure with plugin options `host`/`port` or `OPENCODE_AGENT_GRAPH_HOST` / `OPENCODE_AGENT_GRAPH_PORT`.
- Concurrent plugin processes reuse existing server through `GET /health` and forward events through `POST /events`; preserve this coordination when changing startup logic.
- State is process-local and nonpersistent. Dashboard output filters sessions to `busy`/`retry`. `/stream` is Server-Sent Events; `/events` accepts JSON only and caps request bodies at 256,000 characters.

## Release

- Run `bun run release` to generate `CHANGELOG.md`, bump package version, commit release changes, and tag `v<version>`.
- Push release commit and tag to trigger `.github/workflows/publish.yml`.
- Workflow uses npm Trusted Publishing; configure Trusted Publishing on npm for this repository and workflow.
- Do not publish generated `dist` manually; workflow builds it.
