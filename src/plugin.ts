import type { Plugin } from "@opencode-ai/plugin";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents } from "./discovery.js";
import { createGraphServer } from "./server.js";
import { accept, processId } from "./dashboard-state.js";

type Input = { sessionID?: string; agent?: string };
type Output = { message?: { agent?: string } };
type Config = { host?: string; port?: number };
const number = (value: unknown, fallback: number) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value > 0 &&
  value < 65536
    ? value
    : fallback;
export const ActiveAgentDashboard: Plugin = async ({
  directory,
  client,
  ...context
}) => {
  const config = (context as { options?: Config }).options ?? {};
  const host =
    config.host ?? process.env.OPENCODE_AGENT_GRAPH_HOST ?? "127.0.0.1";
  const port = number(
    config.port ?? Number(process.env.OPENCODE_AGENT_GRAPH_PORT),
    8818,
  );
  const cwd = directory || process.cwd();
  const graph = createGraphServer({
    host,
    port,
    publicRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../public"),
  });
  let agents: unknown[] = [];
  const localAgents = new Map<string, string>();
  void discoverAgents(client, cwd).then((found) => {
    agents = found;
    return graph.send({ kind: "agents", processId, cwd, agents });
  });
  void graph.start();
  const heartbeat = () =>
    void graph.send({ kind: "heartbeat", processId, cwd, agents });
  heartbeat();
  const timer = setInterval(heartbeat, 3_000) as ReturnType<typeof setInterval>;
  timer.unref?.();
  const toolActivity = async (input: { sessionID: string }) => {
    await graph.send({
      kind: "toolActivity",
      processId,
      sessionID: input.sessionID,
      timestamp: new Date().toISOString(),
    });
  };
  return {
    "chat.message": async (input: Input, output: Output) => {
      if (!input?.sessionID) return;
      const agent = input.agent || output?.message?.agent || input.sessionID;
      localAgents.set(input.sessionID, agent);
      await graph.send({
        kind: "agent",
        processId,
        sessionID: input.sessionID,
        cwd,
        agent,
      });
    },
    "tool.execute.before": toolActivity,
    "tool.execute.after": toolActivity,
    event: async ({
      event,
    }: {
      event: { type?: string; properties?: unknown };
    }) => {
      const properties =
        event.properties && typeof event.properties === "object"
          ? (event.properties as Record<string, unknown>)
          : {};
      const info =
        properties.info && typeof properties.info === "object"
          ? (properties.info as Record<string, unknown>)
          : properties;
      const sessionID =
        typeof info.id === "string"
          ? info.id
          : typeof properties.sessionID === "string"
            ? properties.sessionID
            : undefined;
      if (!sessionID) return;
      if (event.type === "session.created")
        await graph.send({
          kind: "created",
          processId,
          sessionID,
          cwd: typeof info.directory === "string" ? info.directory : cwd,
          agent:
            typeof info.agent === "string"
              ? info.agent
              : (localAgents.get(sessionID) ?? null),
          timestamp: new Date().toISOString(),
        });
      else if (event.type === "session.status") {
        const status = (
          properties.status as Record<string, unknown> | undefined
        )?.type;
        if (status === "busy" || status === "retry" || status === "idle")
          await graph.send({
            kind: "status",
            processId,
            sessionID,
            cwd,
            agent: localAgents.get(sessionID) ?? null,
            status,
            timestamp: new Date().toISOString(),
          });
      } else if (
        event.type === "session.deleted" ||
        event.type === "session.error"
      ) {
        localAgents.delete(sessionID);
        await graph.send({ kind: "inactive", processId, sessionID });
      }
    },
  };
};
export default ActiveAgentDashboard;
