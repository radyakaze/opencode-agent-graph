(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    list: $("sessions-list"),
    placeholder: $("state-placeholder"),
    sessionCount: $("session-count"),
    summary: $("summary-text"),
    summaryDot: $("summary-indicator"),
    unavailable: $("unavailable"),
    retry: $("retry-button"),
    clock: $("clock"),
    version: $("version"),
  };
  let source;
  let retryTimer;
  let packetFrame;
  let packetNodes = [];
  let activeProjectCount = 0;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ACTIVITY_WINDOW_MS = 60 * 1000;

  const text = (value, fallback) =>
    value === undefined || value === null || value === "" ? fallback : String(value);
  const escapeHtml = (value) => String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]),
  );
  const slug = (value) => String(value).toLowerCase().replace(/[^a-z]+/g, "-");
  const compactPath = (value) => String(value).replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
  const normalizedStatus = (value) => {
    const status = slug(text(value, "idle"));
    return ["busy", "retry", "idle", "waiting-input"].includes(status) ? status : "idle";
  };
  const hasRecentActivity = (value, now = Date.now()) => {
    const timestamp = Date.parse(value || "");
    return Number.isFinite(timestamp) && now - timestamp <= ACTIVITY_WINDOW_MS;
  };
  const formatElapsed = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    if (minutes) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
    return `${remainder}s`;
  };
  function setConnection(state, label) {
    els.summary.textContent = label;
    els.summaryDot.className = `status-indicator status-${state}`;
    document.body.dataset.connection = state;
  }

  function connectedLabel() {
    return "Connected";
  }

  function elapsedFor(agent) {
    if (typeof agent.elapsedSeconds === "number") return agent.elapsedSeconds;
    const started = Date.parse(agent.activeStartedAt || "");
    return Number.isFinite(started) ? Math.max(0, (Date.now() - started) / 1000) : null;
  }

  function updateElapsedTimers() {
    const now = Date.now();
    els.list.querySelectorAll("[data-elapsed]").forEach((timer) => {
      const started = Date.parse(timer.dataset.activeStartedAt || "");
      const base = Number(timer.dataset.elapsedSeconds);
      const renderedAt = Number(timer.dataset.renderedAt);
      const elapsed = Number.isFinite(base) && Number.isFinite(renderedAt)
        ? base + (now - renderedAt) / 1000
        : Number.isFinite(started) ? (now - started) / 1000 : null;
      if (elapsed !== null) timer.textContent = formatElapsed(elapsed);
    });
  }

  const projectId = (value, index) => `live-project-${index}-${String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const radialPoint = (index, total) => {
    const angle = -Math.PI / 2 + (index / total) * Math.PI * 2;
    return { x: 500 + Math.cos(angle) * 330, y: 185 + Math.sin(angle) * 112 };
  };

  function mergeProjectAgents(project) {
    const active = Array.isArray(project.agents) ? project.agents : [];
    const registered = Array.isArray(project.availableAgents)
      ? project.availableAgents.filter((agent) => agent && agent.hidden !== true)
      : [];
    const usedActive = new Set();
    const merged = [];

    registered.forEach((registeredAgent) => {
      const matchIndex = active.findIndex((agent, index) =>
        !usedActive.has(index) && agent && agent.name === registeredAgent.name,
      );
      if (matchIndex >= 0) {
        usedActive.add(matchIndex);
        merged.push({ ...active[matchIndex], registered: registeredAgent });
      } else {
        merged.push({
          name: registeredAgent.name,
          status: "idle",
          elapsedSeconds: null,
          activeStartedAt: null,
          sessionId: null,
          registered: registeredAgent,
        });
      }
    });
    active.forEach((agent, index) => {
      if (!usedActive.has(index)) merged.push({ ...agent, registered: null });
    });
    return merged;
  }

  function topologyMarkup(project, index) {
    const agents = mergeProjectAgents(project);
    const activeCount = agents.filter((agent) => agent.status === "busy" || agent.status === "retry").length;
    const retryCount = agents.filter((agent) => normalizedStatus(agent.status) === "retry").length;
    const uid = projectId(project.name || project.cwd, index);
    const paths = [];
    const agentMarkup = agents.map((agent, agentIndex) => {
      const status = normalizedStatus(agent.status);
      const point = radialPoint(agentIndex, Math.max(agents.length, 1));
      const pathId = `${uid}-cable-${agentIndex}`;
      const curve = `M 500 185 C ${(500 + point.x) / 2 + (agentIndex % 2 ? 28 : -28)} ${(185 + point.y) / 2}, ${(500 + point.x) / 2} ${(185 + point.y) / 2 + (agentIndex % 2 ? -25 : 25)}, ${point.x} ${point.y}`;
      const active = status === "busy" || status === "retry";
      const live = status === "retry" || (status === "busy" && hasRecentActivity(agent.lastActivityAt));
      const offset = agentIndex / (agents.length + 1);
      paths.push({ pathId, active, live, retry: status === "retry", status, lastActivityAt: agent.lastActivityAt, offset });
      const packetMarkup = active
        ? Array.from({ length: status === "retry" ? 1 : 3 }, (_, packetIndex) => [
          `<circle class="cable-packet live-packet packet-${packetIndex} ${status === "retry" ? "retry" : ""}" data-path="${pathId}" data-offset="${offset + packetIndex * .19}" data-direction="forward" r="${packetIndex === 0 ? 4.5 : 3.5}" aria-hidden="true"></circle>`,
          `<circle class="cable-packet live-packet packet-${packetIndex} ${status === "retry" ? "retry" : ""}" data-path="${pathId}" data-offset="${offset + packetIndex * .19 + .09}" data-direction="reverse" r="${packetIndex === 0 ? 4 : 3}" aria-hidden="true"></circle>`,
        ]).flat().join("")
        : "";
      const detail = active ? formatElapsed(elapsedFor(agent) ?? 0) : "-";
      const sessionSuffix = active && agent.sessionId ? ` · ${String(agent.sessionId).slice(-6)}` : "";
      const elapsedAttributes = active
        ? ` data-elapsed data-active-started-at="${escapeHtml(agent.activeStartedAt || "")}" data-elapsed-seconds="${escapeHtml(agent.elapsedSeconds ?? "")}" data-rendered-at="${Date.now()}"`
        : "";
      const noActivity = status === "busy" && !live;
      const descriptionAttrs = agent.registered
        ? ` data-agent-description="${escapeHtml(typeof agent.registered.description === "string" ? agent.registered.description : "")}" data-agent-native="${agent.registered.native === true}" data-agent-mode="${escapeHtml(agent.registered.mode || "")}"`
        : "";
      return `<path id="${pathId}" class="cable live-cable ${status === "busy" ? "busy active" : status === "retry" ? "retry" : "idle muted"}${noActivity ? " no-activity" : ""}" d="${curve}" aria-hidden="true"></path>${packetMarkup}<g class="agent-node live-agent-node ${status}${noActivity ? " no-activity" : ""}" data-path="${pathId}" data-last-activity-at="${escapeHtml(agent.lastActivityAt || "")}" data-agent-status="${escapeHtml(status)}"${descriptionAttrs} tabindex="0" role="group" aria-label="${escapeHtml(text(agent.name, "Unnamed agent"))}${escapeHtml(sessionSuffix)}, ${status} agent"><circle cx="${point.x}" cy="${point.y}" r="31"></circle><circle class="node-ring agent-ring" cx="${point.x}" cy="${point.y}" r="39"></circle><text x="${point.x}" y="${point.y - 1}">${escapeHtml(text(agent.name, "Unnamed agent"))}</text><text class="node-sub" x="${point.x}" y="${point.y + 14}"${elapsedAttributes}>${escapeHtml(detail)}</text></g>`;
    }).join("");
    packetNodes.push(...paths.filter((path) => path.active).map((path) => ({ ...path, selector: `${uid}-cable-${paths.indexOf(path)}` })));
    return `<article class="live-project-group"><header class="live-project-header"><div class="folder-mark" aria-hidden="true"></div><div class="group-heading"><p class="group-kicker">Project topology</p><h3>${escapeHtml(text(project.name, "Unnamed project"))}</h3><p class="group-path">${escapeHtml(compactPath(text(project.cwd, "Working directory unavailable")))}</p></div><span class="group-count">${activeCount} active${retryCount ? ` · ${retryCount} retry` : ""}</span></header><div class="live-diagram-wrap"><svg class="live-topology" viewBox="0 0 1000 370" role="img" aria-label="${escapeHtml(text(project.name, "Project"))} topology with ${activeCount} active agents" tabindex="0"><defs><pattern id="${uid}-grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="#29372d" stroke-width="1" opacity=".42"></path></pattern><filter id="${uid}-glow"><feGaussianBlur stdDeviation="3" result="blur"></feGaussianBlur><feMerge><feMergeNode in="blur"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge></filter></defs><rect class="diagram-grid" width="1000" height="370" fill="url(#${uid}-grid)"></rect><g>${agentMarkup}</g><g class="live-project-hub${retryCount ? " hub-retry" : ""}" tabindex="0" role="group" aria-label="${escapeHtml(text(project.name, "Project"))} project hub"><circle cx="500" cy="185" r="38"></circle><circle class="hub-ring" cx="500" cy="185" r="49"></circle><text x="500" y="181">${escapeHtml(text(project.name, "PROJECT").toUpperCase())}</text><text class="hub-count" x="500" y="196">${activeCount} ACTIVE</text></g></svg><p class="diagram-caption"><span class="legend"><span><i class="legend-dot"></i> working</span><span><i class="legend-dot retry"></i> retry</span><span><i class="legend-dot idle"></i> idle</span></span></p></div></article>`;
  }

  function updateLiveness() {
    const now = Date.now();
    packetNodes.forEach((packet) => {
      const live = packet.retry || (packet.status === "busy" && hasRecentActivity(packet.lastActivityAt, now));
      const path = document.getElementById(packet.pathId);
      if (path) path.classList.toggle("no-activity", packet.status === "busy" && !live);
      document.querySelectorAll(`.live-agent-node[data-path="${packet.pathId}"]`).forEach((node) => {
        node.classList.toggle("no-activity", packet.status === "busy" && !live);
      });
      document.querySelectorAll(`.live-packet[data-path="${packet.pathId}"]`).forEach((element) => {
        element.style.display = live ? "" : "none";
      });
    });
  }

  function animatePackets(time) {
    packetNodes.forEach((packet) => {
      const elements = document.querySelectorAll(`.live-packet[data-path="${packet.pathId}"]`);
      elements.forEach((element) => {
        const path = document.getElementById(packet.pathId);
        if (!path) return;
        const raw = (time * (packet.retry ? .00016 : .00042) + Number(element.dataset.offset)) % 2;
        const pingPong = raw <= 1 ? raw : 2 - raw;
        const burst = packet.retry ? (time * .0011 + Number(element.dataset.offset) * 3.7) % 4.4 < .9 : true;
        element.style.opacity = packet.retry && !burst ? "0" : "";
        const progress = element.dataset.direction === "reverse" ? 1 - pingPong : pingPong;
        const point = path.getPointAtLength(path.getTotalLength() * progress);
        element.setAttribute("cx", point.x);
        element.setAttribute("cy", point.y);
      });
    });
    packetFrame = requestAnimationFrame(animatePackets);
  }

  function renderState(payload) {
    const projects = Array.isArray(payload?.projects) ? payload.projects : [];
    activeProjectCount = projects.length;
    els.sessionCount.textContent = `${activeProjectCount} active project${activeProjectCount === 1 ? "" : "s"}`;
    if (packetFrame) cancelAnimationFrame(packetFrame);
    packetNodes = [];
    els.placeholder.hidden = projects.length > 0;
    if (!projects.length) {
      els.placeholder.innerHTML = `<span class="state-marker state-marker-empty" aria-hidden="true"></span><p>No active agents</p><span>Active plugin work will appear here.</span>`;
      els.list.querySelectorAll(".live-project-group").forEach((node) => node.remove());
      return;
    }
    hideTooltip();
    els.list.innerHTML = projects.map(topologyMarkup).join("");
    updateElapsedTimers();
    updateLiveness();
    if (!reduceMotion.matches) packetFrame = requestAnimationFrame(animatePackets);
  }


  async function loadState() {
    setConnection("pending", "Connecting to state");
    try {
      const response = await fetch("/state", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      renderState(await response.json());
      setConnection("connected", connectedLabel());
      els.unavailable.hidden = true;
      connectStream();
    } catch {
      setConnection("offline", "State unavailable");
      els.unavailable.hidden = false;
      scheduleRetry();
    }
  }

  function connectStream() {
    if (source) source.close();
    const nextSource = new EventSource("/stream");
    source = nextSource;
    nextSource.onopen = () => {
      if (source !== nextSource) return;
      setConnection("connected", connectedLabel());
      els.unavailable.hidden = true;
    };
    nextSource.addEventListener("state", (message) => {
      if (source !== nextSource) return;
      try {
        renderState(JSON.parse(message.data));
        setConnection("connected", connectedLabel());
        els.unavailable.hidden = true;
      } catch {}
    });
    nextSource.onerror = () => {
      if (source !== nextSource || nextSource.readyState !== EventSource.CLOSED) return;
      source = null;
      setConnection("offline", "Stream disconnected");
      nextSource.close();
      els.unavailable.hidden = false;
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(loadState, 8000);
  }
  async function loadVersion() {
    try {
      const response = await fetch("/version", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      els.version.textContent = `Version ${text(payload?.version, "unavailable")}`;
    } catch {
      els.version.textContent = "Version unavailable";
    }
  }
  const tooltipEl = document.createElement("div");
  tooltipEl.className = "agent-tooltip";
  tooltipEl.setAttribute("role", "tooltip");
  tooltipEl.hidden = true;
  document.body.appendChild(tooltipEl);
  let tooltipRaf = 0;

  function buildTooltipContent(node) {
    if (!("agentDescription" in node.dataset)) return null;
    const description = node.dataset.agentDescription || "";
    const native = node.dataset.agentNative === "true";
    const mode = node.dataset.agentMode || "";
    const status = node.dataset.agentStatus || "idle";
    let body = description.trim();
    if (!body) {
      if (native) body = "Native agent";
      else if (mode) body = `${mode.charAt(0).toUpperCase()}${mode.slice(1)} agent`;
      else body = "Registered agent";
    }
    const ariaLabel = node.getAttribute("aria-label") || "";
    const name = ariaLabel.split(",")[0].trim() || "Agent";
    const statusDot = `<span class="agent-tooltip-status" data-status="${escapeHtml(status)}" aria-hidden="true"></span>`;
    const divider = `<span class="agent-tooltip-divider" aria-hidden="true"></span>`;
    return `<span class="agent-tooltip-name">${statusDot}${escapeHtml(name)}</span>${divider}<span class="agent-tooltip-body">${escapeHtml(body)}</span>`;
  }

  function positionTooltip(node) {
    const rect = node.getBoundingClientRect();
    tooltipEl.style.left = "0px";
    tooltipEl.style.top = "0px";
    const tipRect = tooltipEl.getBoundingClientRect();
    const margin = 12;
    let top = rect.top - tipRect.height - margin;
    let placeBelow = false;
    if (top < margin) {
      top = rect.bottom + margin;
      placeBelow = true;
    }
    let left = rect.left + (rect.width - tipRect.width) / 2;
    const maxLeft = window.innerWidth - tipRect.width - margin;
    if (left < margin) left = margin;
    if (left > maxLeft) left = maxLeft;
    tooltipEl.style.top = `${Math.max(margin, top + window.scrollY)}px`;
    tooltipEl.style.left = `${left + window.scrollX}px`;
    tooltipEl.classList.toggle("below", placeBelow);
    // Point the caret at the node center; clamp so it stays attached when the tooltip is shifted to the screen edge.
    const nodeCenterX = rect.left + rect.width / 2;
    const tipCenterX = left + tipRect.width / 2;
    const caretPadding = 18;
    const maxCaretOffset = Math.max(0, tipRect.width / 2 - caretPadding);
    const caretOffset = Math.max(-maxCaretOffset, Math.min(maxCaretOffset, nodeCenterX - tipCenterX));
    tooltipEl.style.setProperty("--caret-x", `${caretOffset}px`);
  }

  function showTooltip(node) {
    const html = buildTooltipContent(node);
    if (!html) return;
    cancelAnimationFrame(tooltipRaf);
    tooltipEl.innerHTML = html;
    tooltipEl.hidden = false;
    positionTooltip(node);
    tooltipEl.classList.remove("is-visible");
    // Force layout so the entrance transition runs from the hidden state.
    void tooltipEl.offsetWidth;
    tooltipRaf = requestAnimationFrame(() => {
      tooltipEl.classList.add("is-visible");
    });
  }

  function hideTooltip() {
    cancelAnimationFrame(tooltipRaf);
    tooltipEl.classList.remove("is-visible");
    tooltipEl.hidden = true;
    tooltipEl.innerHTML = "";
  }

  function tooltipNodeFor(event) {
    return event.target.closest?.(".live-agent-node") || null;
  }

  els.list.addEventListener("mouseover", (event) => {
    const node = tooltipNodeFor(event);
    if (node) showTooltip(node);
  });
  els.list.addEventListener("mouseout", (event) => {
    const node = tooltipNodeFor(event);
    if (node && (!event.relatedTarget || !node.contains(event.relatedTarget))) hideTooltip();
  });
  els.list.addEventListener("focusin", (event) => {
    const node = tooltipNodeFor(event);
    if (node) showTooltip(node);
  });
  els.list.addEventListener("focusout", (event) => {
    const node = tooltipNodeFor(event);
    if (node && (!event.relatedTarget || !node.contains(event.relatedTarget))) hideTooltip();
  });
  window.addEventListener("scroll", hideTooltip, { passive: true });

  els.retry.addEventListener("click", () => {
    clearTimeout(retryTimer);
    loadState();
  });
  setInterval(() => {
    els.clock.textContent = new Date().toLocaleTimeString([], { hour12: false });
    updateElapsedTimers();
    updateLiveness();
  }, 1000);
  loadVersion();
  loadState();
})();
