import type { Plugin } from "@opencode-ai/plugin";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents } from "./discovery.js";
import { createGraphServer } from "./server.js";
import { processId } from "./dashboard-state.js";

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
export const ActiveAgentDashboard: Plugin = async (
  { directory, client },
  options,
) => {
  const config = (options ?? {}) as Config;
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
  const toolActivity = async (
    input: { sessionID: string; tool?: string; callID?: string },
    phase: "before" | "after",
  ) => {
    await graph.send({
      kind: "toolActivity",
      processId,
      sessionID: input.sessionID,
      tool: typeof input.tool === "string" ? input.tool : "tool",
      phase,
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
    "tool.execute.before": (input: { sessionID: string; tool?: string; callID?: string }) =>
      toolActivity(input, "before"),
    "tool.execute.after": (input: { sessionID: string; tool?: string; callID?: string }) =>
      toolActivity(input, "after"),
    event: async ({
      event,
    }: {
      event: { type?: string; properties?: unknown };
    }) => {
      const properties =
        event.properties && typeof event.properties === "object"
          ? (event.properties as Record<string, unknown>)
          : {};
      // message.part.updated carries sessionID inside properties.part, not at
      // the top level — handle it before the generic sessionID extraction.
      if (event.type === "message.part.updated") {
        const part =
          properties.part && typeof properties.part === "object"
            ? (properties.part as Record<string, unknown>)
            : null;
        if (!part) return;
        const partSessionID =
          typeof part.sessionID === "string" ? part.sessionID : undefined;
        if (!partSessionID) return;
        const partType = typeof part.type === "string" ? part.type : "";
        const at = new Date().toISOString();
        const sendActivity = (activityType: string, label: string) =>
          graph.send({
            kind: "activity",
            processId,
            sessionID: partSessionID,
            activityType,
            label,
            timestamp: at,
          });
        if (partType === "reasoning") await sendActivity("reasoning", "Reasoning");
        else if (partType === "text") await sendActivity("responding", "Responding");
        else if (partType === "agent") {
          const name = typeof part.name === "string" ? part.name : "agent";
          await sendActivity("spawning", `Spawning ${name}`.slice(0, 20));
        }
        else if (partType === "retry") await sendActivity("retrying", "Retrying");
        else if (partType === "compaction") await sendActivity("compacting", "Compacting");
        else if (partType === "step-start") await sendActivity("thinking", "Thinking");
        return;
      }
      // permission.asked/replied carry sessionID at the top level (not under
      // info.id like session events) — handle before the generic extraction.
      if (event.type === "permission.asked") {
        const permSessionID =
          typeof properties.sessionID === "string" ? properties.sessionID : undefined;
        if (!permSessionID) return;
        const permissionType =
          typeof properties.permission === "string" ? properties.permission : "action";
        const verbMap: Record<string, string> = {
          read: "read",
          edit: "edit",
          write: "write",
          bash: "run",
          external_directory: "read",
        };
        const verb = verbMap[permissionType] || permissionType;
        const metadata =
          properties.metadata && typeof properties.metadata === "object"
            ? (properties.metadata as Record<string, unknown>)
            : {};
        const filepath =
          typeof metadata.filepath === "string" ? metadata.filepath : "";
        const patterns = Array.isArray(properties.patterns) ? properties.patterns : [];
        const target = filepath || (typeof patterns[0] === "string" ? patterns[0] : "");
        const label = target
          ? `Needs approval: ${verb} ${target}`.slice(0, 40)
          : `Needs approval: ${verb}`.slice(0, 40);
        await graph.send({
          kind: "activity",
          processId,
          sessionID: permSessionID,
          activityType: "waiting",
          label,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (event.type === "permission.replied") {
        const permSessionID =
          typeof properties.sessionID === "string" ? properties.sessionID : undefined;
        if (!permSessionID) return;
        await graph.send({
          kind: "activity",
          processId,
          sessionID: permSessionID,
          activityType: "thinking",
          label: "Thinking",
          timestamp: new Date().toISOString(),
        });
        return;
      }
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
