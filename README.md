# OpenCode Agent Graph

OpenCode Agent Graph is a local OpenCode plugin for seeing multi-agent work as it happens. It brings active agents, running sessions, work status, and recent tool activity into one focused dashboard, making parallel work easier to follow without switching between sessions.

## Demo

<video src="./video.mp4" width="100%" autoplay loop muted playsinline></video>


## Why use it

- See which agents are active and which sessions need attention.
- Understand parallel work in real time instead of checking sessions one by one.

## Quick start

Add package name to `opencode.json`. OpenCode installs plugin automatically on first use:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-agent-graph"]
}
```

Pin a version when needed:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-agent-graph@1.0"]
}
```

After OpenCode starts plugin, open dashboard:

```text
http://127.0.0.1:8818/
```

## Configuration

Dashboard default address is `http://127.0.0.1:8818/`.

Override host and port with environment variables:

| Option | Default |
| --- | --- |
| `host` | `127.0.0.1` |
| `port` | `8818` |

```sh
OPENCODE_AGENT_GRAPH_HOST=127.0.0.1
OPENCODE_AGENT_GRAPH_PORT=8818
```
