import {
  AgentInfo,
  DashboardState,
  DashboardEvent,
  projectName,
  Session,
  Status,
} from "./dashboard-types.js";

const sessions = new Map<string, Session>();
const processes = new Map<string, number>();
const availableAgents = new Map<string, Map<string, AgentInfo>>();
const processCwds = new Map<string, Set<string>>();
let updatedAt = new Date().toISOString();
let notify: (() => void) | undefined;
export const processId = `proc_${process.pid}`;

export function setNotifier(value: () => void): void {
  notify = value;
}
function publish(): void {
  updatedAt = new Date().toISOString();
  notify?.();
}
function timestamp(value: unknown): string {
  return typeof value === "string" ? value : new Date().toISOString();
}
function mergeAgents(input: unknown, cwd: unknown): void {
  if (!Array.isArray(input) || typeof cwd !== "string" || !cwd) return;
  const registry = availableAgents.get(cwd) ?? new Map<string, AgentInfo>();
  availableAgents.set(cwd, registry);
  let changed = false;
  for (const raw of input) {
    const item = raw && typeof raw === "object" ? (raw as DashboardEvent) : null;
    if (!item || typeof item.name !== "string" || !item.name) continue;
    let agent = registry.get(item.name);
    if (!agent) {
      agent = {
        name: item.name,
        description:
          typeof item.description === "string" ? item.description : null,
        mode: typeof item.mode === "string" ? item.mode : null,
        hidden: item.hidden === true,
        native: item.native === true,
        model: typeof item.model === "string" ? item.model : null,
        directories: new Set(),
      };
      registry.set(item.name, agent);
      changed = true;
    }
    if (!agent.directories.has(cwd)) {
      agent.directories.add(cwd);
      changed = true;
    }
  }
  if (changed) publish();
}
export function accept(input: unknown): void {
  const message =
    input && typeof input === "object" ? (input as DashboardEvent) : null;
  if (
    !message ||
    typeof message.kind !== "string" ||
    typeof message.processId !== "string"
  )
    return;
  processes.set(message.processId, Date.now());
  if (
    message.kind === "hello" ||
    message.kind === "heartbeat" ||
    message.kind === "agents"
  ) {
    if (typeof message.cwd === "string" && message.cwd) {
      const cwds = processCwds.get(message.processId) ?? new Set<string>();
      cwds.add(message.cwd);
      processCwds.set(message.processId, cwds);
    }
    mergeAgents(message.agents, message.cwd);
    if (message.kind === "agents") publish();
    return;
  }
  if (typeof message.sessionID !== "string") return;
  const id = `${message.processId}:${message.sessionID}`;
  const previous = sessions.get(id);
  if (message.kind === "created") {
    const cwd =
      typeof message.cwd === "string" && message.cwd
        ? message.cwd
        : process.cwd();
    sessions.set(id, {
      id,
      processId: message.processId,
      sessionId: message.sessionID,
      cwd,
      projectName: projectName(cwd),
      agent: typeof message.agent === "string" ? message.agent : null,
      status: previous?.status ?? "idle",
      startedAt: previous?.startedAt ?? timestamp(message.timestamp),
      activeStartedAt: previous?.activeStartedAt ?? null,
      lastActivityAt: previous?.lastActivityAt ?? timestamp(message.timestamp),
    });
    publish();
    return;
  }
  if (message.kind === "inactive") {
    if (sessions.delete(id)) publish();
    return;
  }
  if (message.kind === "agent") {
    if (previous && typeof message.agent === "string") {
      previous.agent = message.agent;
      publish();
    }
    return;
  }
  if (message.kind === "toolActivity") {
    if (previous) {
      previous.lastActivityAt = timestamp(message.timestamp);
      publish();
    }
    return;
  }
  if (message.kind !== "status") return;
  const status: Status =
    message.status === "retry"
      ? "retry"
      : message.status === "idle"
        ? "idle"
        : "busy";
  const cwd =
    typeof message.cwd === "string" && message.cwd
      ? message.cwd
      : process.cwd();
  const at = timestamp(message.timestamp);
  sessions.set(id, {
    id,
    processId: message.processId,
    sessionId: message.sessionID,
    cwd: previous?.cwd ?? cwd,
    projectName: previous?.projectName ?? projectName(cwd),
    agent:
      previous?.agent ??
      (typeof message.agent === "string" ? message.agent : null),
    status,
    startedAt: previous?.startedAt ?? at,
    activeStartedAt:
      status === "idle" ? null : (previous?.activeStartedAt ?? at),
    lastActivityAt: previous?.lastActivityAt ?? at,
  });
  publish();
}
export function removeStale(cutoff: number): void {
  let changed = false;
  for (const [id, seen] of processes)
    if (seen < cutoff) {
      processes.delete(id);
      const cwds = processCwds.get(id) ?? new Set<string>();
      processCwds.delete(id);
      for (const cwd of cwds) {
        const stillOwned = [...processCwds].some(
          ([processId, ownedCwds]) =>
            processes.has(processId) && ownedCwds.has(cwd),
        );
        if (!stillOwned && availableAgents.delete(cwd)) changed = true;
      }
      for (const sessionId of sessions.keys())
        if (sessionId.startsWith(`${id}:`)) {
          sessions.delete(sessionId);
          changed = true;
        }
    }
  if (changed) publish();
}
export function state(): DashboardState {
  const now = Date.now();
  const grouped = new Map<
    string,
    {
      cwd: string;
      name: string;
      agents: Array<Record<string, unknown>>;
      availableAgents: AgentInfo[];
    }
  >();
  for (const session of sessions.values()) {
    if (session.status !== "busy" && session.status !== "retry") continue;
    const project = grouped.get(session.cwd) ?? {
      cwd: session.cwd,
      name: session.projectName,
      agents: [],
      availableAgents: [],
    };
    project.agents.push({
      name: session.agent,
      sessionId: session.sessionId,
      processId: session.processId,
      status: session.status,
      activeStartedAt: session.activeStartedAt,
      lastActivityAt: session.lastActivityAt,
      startedAt: session.startedAt,
      elapsedSeconds: session.activeStartedAt
        ? Math.max(
            0,
            Math.floor((now - Date.parse(session.activeStartedAt)) / 1000),
          )
        : 0,
    });
    grouped.set(session.cwd, project);
  }
  for (const [cwd, registry] of availableAgents) {
    const project = grouped.get(cwd) ?? {
      cwd,
      name: projectName(cwd),
      agents: [],
      availableAgents: [],
    };
    project.availableAgents = [...registry.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    grouped.set(cwd, project);
  }
  return {
    updatedAt,
    projects: [...grouped.values()]
      .sort(
        (a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd),
      )
      .map(({ availableAgents: agents, ...project }) => ({
        ...project,
        availableAgents: agents.map(({ directories: _, ...agent }) => agent),
        agents: project.agents.sort((a, b) =>
          String(a.name ?? "").localeCompare(String(b.name ?? "")),
        ),
      })),
  };
}
