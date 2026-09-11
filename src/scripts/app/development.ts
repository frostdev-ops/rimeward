import { expandedDesktopWard, restoreExpandedWard } from "./desktop-state.ts";
import type { terminalCapabilities } from "../../lib/dev/terminals.ts";
import type { gitView } from "../../lib/dev/projects.ts";
import { icon } from "./icon.ts";
import { chooseProject, askText, confirmAction, dialog as workspaceDialog } from "./workspace-dialogs.ts";
import { RENDERERS, body, poll } from "./wards.ts";
import { el, toast, reducedMotion } from "./dom.ts";
import { readPages, pageOfCard } from "./pages.ts";
import { CATALOG, type WardInstance } from "../../lib/wards.ts";
import {
  DEV_WARDS,
  terminalExitLabel,
  type Project,
  type SessionView,
  type SessionResourceView,
  type TerminalKind,
} from "../../lib/dev/types.ts";
import { owner, terminalEvents } from "./terminal-stream.ts";
import { DEFAULT_PREFS, Pane, isMac, readPrefs, savePrefs, type PaneHost, type Prefs } from "./terminal-pane.ts";
import { MAX_PANES, has, insert, leaves, parseNode, reconcile, remove, swap, type Node, type Side } from "../../lib/dev/terminal-layout.ts";
import "@xterm/xterm/css/xterm.css";
import "../../styles/development.css";

async function request<T = unknown>(
  action: string,
  data: Record<string, unknown> = {},
  method = "GET",
  ward = '',
): Promise<T> {
  const response = await fetch(
    "/api/dev/" +
      action +
      `?${new URLSearchParams({ ...(method === 'GET' ? data as Record<string, string> : {}), _ward: ward })}`,
    {
      method,
      cache: "no-store",
      // Every call is bounded: the relay bounds only the channel handshake, not the proxied request.
      signal: AbortSignal.timeout(action === "input" || (action === "sessions" && method === "GET") ? 15000 : 60000),
      ...(method === "GET"
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...data, owner }),
          }),
    },
  );
  // An HTML body (proxy error page, login redirect) must not surface as a JSON parse error.
  const value = await response.json().catch(() => { throw Object.assign(new Error("Desktop returned an invalid response."), { status: response.ok ? 502 : response.status }); });
  if (!response.ok) throw Object.assign(new Error(value.error ?? "Desktop unavailable."), { status: response.status });
  return value;
}
const button = (label: string, fn: () => unknown) => {
  const b = el("button", "btn text-xs", label);
  b.type = "button";
  b.onclick = () => {
    Promise.resolve()
      .then(fn)
      .catch((e) => toast(e.message, undefined, true));
  };
  return b;
};
const input = (label: string) => {
  const i = el("input", "input text-xs");
  i.placeholder = label;
  i.setAttribute("aria-label", label);
  return i;
};
const select = (label: string, choices: string[]) => {
  const s = el("select", "input text-xs");
  s.setAttribute("aria-label", label);
  for (const c of choices) s.add(new Option(c, c));
  return s;
};
const states = new Map<string, { stop: () => void }>();
function expand(host: HTMLElement) {
  expandedDesktopWard(host.dataset.ward);
  const placeholder = document.createComment("expanded ward"),
    dlg = el("dialog", "fd-dialog dev-expanded");
  host.before(placeholder);
  dlg.setAttribute("aria-label", `${host.dataset.title ?? "Ward"} · expanded`);
  const nav = el("div", "dev-bar");
  nav.append(button("Close", () => dlg.close()));
  for (const other of document.querySelectorAll<HTMLElement>(".dev-workspace"))
    if (other !== host && !other.closest("[data-wd-off]"))
      nav.append(
        button(other.dataset.title ?? "Ward", () => {
          dlg.close();
          expand(other);
        }),
      );
  dlg.append(nav, host);
  document.body.append(dlg);
  dlg.onclose = () => {
    expandedDesktopWard();
    placeholder.replaceWith(host);
    dlg.remove();
  };
  dlg.oncancel = event => {
    if (host.dataset.kind === "terminal" && document.activeElement?.closest(".xterm")) event.preventDefault();
  };
  dlg.showModal();
}
interface State {
  project: string;
  session?: string;
  closedSessions?: string[];
  tabs?: string[];
  active?: string;
  /** The terminal's pane tree per tab (lib/dev/terminal-layout.ts); presentation only. */
  groups?: Node[];
}
async function mount(w: WardInstance) {
  const api = <T = unknown>(action: string, data: Record<string, unknown> = {}, method = 'GET') => request<T>(action, data, method, w.i);
  const b = body(w.i);
  if (!b) return;
  states.get(w.i)?.stop(); // resize / undo / project change re-render: replace the live instance, never blank it
  const host = el("div", "dev-workspace"),
    bar = el("div", "dev-bar"),
    content = el("div", "dev-content");
  host.dataset.kind = w.type;
  host.dataset.ward = w.i;
  host.dataset.title = w.title ?? CATALOG[w.type]?.title ?? w.type;
  host.append(bar, content);
  b.replaceChildren(host);
  let stopped = false;
  const cleanup: (() => void)[] = [];
  states.set(w.i, {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const stop of cleanup) stop();
      host.closest<HTMLDialogElement>("dialog.dev-expanded")?.close();
      states.delete(w.i);
    },
  });
  try {
    const projects: Project[] = await api("projects");
    let state: State = await api("view", { id: w.i });
    if (stopped) return;
    state.project ||=
      readPages().find((p) => p.id === pageOfCard(w.i))?.project ??
      projects[0]?.id ??
      "";
    const picker = select("Project", []);
    picker.add(new Option("Select project", ""));
    for (const p of projects) picker.add(new Option(p.name, p.id));
    picker.value = state.project;
    const remember = () => api("view", { id: w.i, value: state }, "POST");
    picker.onchange = async () => {
      state = { project: picker.value };
      await remember();
      states.get(w.i)?.stop();
      void mount(w);
    };
    const projectButton = button("Open / new project", async () => {
      const project = await chooseProject(w.i);
      if (!project) return;
      state = { project: project.id };
      await remember();
      states.get(w.i)?.stop();
      await mount(w);
    });
    bar.append(picker, projectButton, button("Expand", () => expand(host)));
    const project = projects.find(p => p.id === state.project);
    restoreExpandedWard(w.i, () => expand(host));
    if (!project) {
      if (w.type === "terminal" || w.type === "editor") bar.hidden = true;
      const empty = el("div", "dev-empty");
      const mark = el("span", "dev-empty-icon"); mark.append(icon(w.type === "terminal" ? "code" : "folder"));
      empty.append(mark, el("h3", undefined, "Your workspace starts here"),
        el("p", undefined, "Open a folder or create a project to get started. Files and sessions stay on this desktop."));
      empty.append(projectButton);
      content.append(empty);
      return;
    }
    if (w.type === "project-files") {
      const { fileExplorer } = await import("./project-editor.ts");
      const explorer = fileExplorer(content, api, state.project, (path, line) =>
        window.dispatchEvent(new CustomEvent("fd:open-file", { detail: { project: state.project, path, line, page: pageOfCard(w.i) } })));
      cleanup.push(explorer.stop);
    } else if (w.type === "editor") {
      const { projectEditor } = await import("./project-editor.ts");
      if (stopped) return;
      cleanup.push(projectEditor(host, {
        api, owner, ward: w.i, project, state, remember,
        changeProject: () => projectButton.click(), expand: () => expand(host), page: pageOfCard(w.i),
      }));
    } else if (w.type === "terminal") {
      const caps = await api<ReturnType<typeof terminalCapabilities>>("capabilities");
      if (stopped) return;
      const names = { shell: "Shell", codex: "Codex", claude: "Claude Code" };
      const sessions = el("div", "term-tabs");
      sessions.setAttribute("role", "tablist");
      sessions.setAttribute("aria-label", "Terminal sessions");
      const surface = el("div", "term-surface");
      const panesHost = el("div", "term-panes");
      panesHost.id = `terminal-screen-${w.i}`;
      const empty = el("div", "dev-empty term-empty");
      const footer = el("div", "term-footer");
      const status = el("span", "term-status", "Loading sessions…");
      status.setAttribute("role", "status");
      projectButton.className = "term-project";
      projectButton.replaceChildren(icon("folder"), el("span", undefined, project?.name ?? "Project"));
      projectButton.title = project?.root ?? "Change project";
      projectButton.setAttribute("aria-label", "Change project");
      const toolButton = (id: string, label: string, fn: () => unknown) => {
        const b = button(label, fn);
        b.className = "term-tool";
        b.replaceChildren(icon(id));
        b.title = label;
        b.setAttribute("aria-label", label);
        return b;
      };
      const newButton = toolButton("plus", "New terminal session", () => sessionDialog());
      const more = toolButton("more", "Terminal actions", () => {});
      const expandButton = toolButton("resize", "Expand terminal", () => expand(host));
      expandButton.classList.add("term-expand");
      bar.classList.add("term-toolbar");
      bar.replaceChildren(sessions, newButton, more, expandButton);
      footer.append(projectButton, status);
      surface.append(panesHost, empty);
      content.replaceChildren(surface, footer);

      // The ward owns the session LIST and the groups; every pane owns its session.
      let list: SessionView[] = [], launching = false, changingControl = false, listOk = false, streamReady = false, failure = "";
      let zoomed: string | undefined, treeSig = "", sessionOptions = "";
      let groups: Node[] = (Array.isArray(state.groups) ? state.groups : []).map(parseNode).filter((n): n is Node => n !== null);
      let prefs = readPrefs();
      let autoAttach = !state.session && !state.closedSessions?.length;
      let attaching = Promise.resolve();
      let retryList: ReturnType<typeof setTimeout> | undefined, refreshing: Promise<void> | undefined;
      const panes = new Map<string, Pane>();
      const tabVisible = (s: SessionView) => (!s.command || state.tabs?.includes(s.id)) && !state.closedSessions?.includes(s.id);
      const visibleIds = () => list.filter(tabVisible).map(s => s.id);
      const focused = () => (state.session ? panes.get(state.session) : undefined);
      const groupOf = (id: string) => groups.find(g => has(g, id));
      const activeGroup = () => (state.session && groupOf(state.session)) || groups[0];
      const titleOf = (id: string) => { const s = list.find(x => x.id === id); return s ? (s.title === s.kind ? names[s.kind] : s.title) : id; };
      const save = () => { state.groups = groups; return remember(); };
      function syncGroups() {
        const next = reconcile(groups, visibleIds());
        if (JSON.stringify(next) !== JSON.stringify(groups)) { groups = next; void save(); }
      }
      function refreshList(): Promise<void> {
        if (refreshing) return refreshing;
        if (stopped) return Promise.resolve();
        clearTimeout(retryList);
        refreshing = (async () => {
          try {
            const next: SessionView[] = await api("sessions", { project: state.project });
            if (stopped) return;
            list = next;
            const ids = new Set(list.map(s => s.id));
            if (state.tabs?.some(id => !ids.has(id)) || state.closedSessions?.some(id => !ids.has(id))) {
              state.tabs = state.tabs?.filter(id => ids.has(id)); state.closedSessions = state.closedSessions?.filter(id => ids.has(id));
              await save();
            }
            listOk = true;
            if (state.session && !list.some(s => s.id === state.session && tabVisible(s))) { state.session = undefined; autoAttach = true; }
            syncGroups();
            if (!state.session) {
              const visible = list.filter(tabVisible);
              const g = groups[0];
              const pick = autoAttach ? (visible.find(s => s.state === "running") ?? visible[0])?.id : g ? leaves(g)[0] : undefined;
              if (pick) { autoAttach = false; state.session = pick; await save(); }
            }
            failure = "";
          } catch (e) {
            listOk = false;
            failure = [401, 403, 404].includes((e as { status?: number }).status ?? 0) ? (e as Error).message : "";
            if (!stopped) retryList = setTimeout(() => void refreshList(), failure ? 30000 : 3000);
          } finally {
            if (!stopped) render();
          }
        })().finally(() => { refreshing = undefined; });
        return refreshing;
      }
      function render() { sessionList(); renderPanes(); draw(); }
      function renderPanes() {
        const g = activeGroup();
        const want = g ? leaves(g) : [];
        for (const [id, p] of panes) if (!want.includes(id)) { p.dispose(); panes.delete(id); }
        for (const id of want) if (!panes.has(id)) {
          const p = new Pane(id, paneHost);
          p.session = list.find(s => s.id === id);
          panes.set(id, p);
          if (streamReady) { p.streamReady = true; void p.update(); }
        }
        if (zoomed && !panes.has(zoomed)) zoomed = undefined;
        const sig = JSON.stringify([g ?? null, zoomed ?? null]);
        if (sig !== treeSig) {
          treeSig = sig;
          const hadFocus = panesHost.contains(document.activeElement);
          const zoom = zoomed ? panes.get(zoomed) : undefined;
          panesHost.replaceChildren(...(g ? [zoom ? zoom.el : build(g)] : []));
          if (hadFocus) focused()?.focus();
        }
        panesHost.classList.toggle("term-zoomed", !!zoomed);
        for (const p of panes.values()) { p.showBar(want.length > 1 && !zoomed); p.setActive(want.length > 1 && p.id === state.session); p.resize(); }
        panesHost.hidden = !want.length;
      }
      function build(n: Node): HTMLElement {
        if (typeof n === "string") return panes.get(n)?.el ?? el("div", "term-pane");
        const box = el("div", "term-split");
        box.dataset.dir = n.dir;
        const a = build(n.a), b = build(n.b), divider = el("div", "term-divider");
        divider.setAttribute("role", "separator");
        divider.setAttribute("aria-orientation", n.dir === "row" ? "vertical" : "horizontal");
        const apply = () => { a.style.flex = `${n.ratio} 1 0px`; b.style.flex = `${1 - n.ratio} 1 0px`; };
        apply();
        divider.onpointerdown = e => {
          if (e.button !== 0) return;
          e.preventDefault();
          divider.setPointerCapture(e.pointerId);
          const move = (ev: PointerEvent) => {
            const r = box.getBoundingClientRect();
            n.ratio = Math.max(0.1, Math.min(0.9, n.dir === "row" ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height));
            apply();
          };
          const up = () => { divider.removeEventListener("pointermove", move); divider.removeEventListener("pointerup", up); void save(); for (const p of panes.values()) p.resize(); };
          divider.addEventListener("pointermove", move);
          divider.addEventListener("pointerup", up, { once: true });
        };
        box.append(a, divider, b);
        return box;
      }
      async function setRimeControl(enabled: boolean) {
        const p = focused();
        if (!p || changingControl) return;
        changingControl = true;
        rimeToggle.checked = enabled;
        draw();
        try {
          await p.flush();
          if (!p.connected || !streamReady || state.session !== p.id) return;
          await api("configure", { id: p.id, agentInput: enabled }, "POST");
          await p.update();
        } finally { changingControl = false; draw(); p.resize(); if (!enabled && p.canType()) p.focus(); }
      }
      const rimeControl = el("label", "switch term-rime-control", "Let Rime control");
      const rimeToggle = el("input");
      rimeToggle.type = "checkbox";
      rimeToggle.onchange = () => { void setRimeControl(rimeToggle.checked).catch(e => toast(e.message, undefined, true)); };
      rimeControl.prepend(rimeToggle);
      const take = button("Take control", async () => {
        const p = focused();
        if (!p) return;
        await p.update();
        if (!p.connected || !streamReady || state.session !== p.id) return;
        await api("control", { id: p.id, takeover: true }, "POST");
        p.reclaim();
        await p.update(); p.resize(); p.focus();
      });
      take.className = "term-control";
      const restart = button("Resume session", async () => {
        const p = focused();
        if (p) await launch(undefined, p.id);
      });
      restart.className = "term-control";
      footer.append(rimeControl, take, restart);
      const keys = el("div", "term-keys");
      let showKeys = matchMedia("(pointer: coarse)").matches;
      for (const [label, data, direction] of [["Esc", "\x1b"], ["Tab", "\t"], ["Left", "\x1b[D", "180deg"],
        ["Down", "\x1b[B", "90deg"], ["Up", "\x1b[A", "-90deg"], ["Right", "\x1b[C", "0deg"], ["Ctrl-C", "\x03"], ["Enter", "\r"]] as const) {
        const key = button(label, () => focused()?.send(data));
        if (direction) {
          const arrow = el("span"); arrow.style.display = "inline-flex"; arrow.style.rotate = direction;
          arrow.append(icon("right")); key.replaceChildren(arrow); key.setAttribute("aria-label", label); key.title = label;
        }
        // A touch key must not dismiss the phone's terminal keyboard.
        key.addEventListener("pointerdown", e => e.preventDefault());
        keys.append(key);
      }
      surface.after(keys);
      function draw() {
        const p = focused(), session = p?.session;
        const writable = !!p && p.writable();
        empty.hidden = !!p || !listOk;
        newButton.disabled = launching;
        empty.querySelectorAll<HTMLButtonElement>("button").forEach(b => { b.disabled = launching; });
        rimeControl.hidden = session?.state !== "running";
        if (!changingControl) rimeToggle.checked = !!session?.agentInput;
        rimeToggle.disabled = !p?.connected || !streamReady || changingControl;
        take.hidden = session?.state !== "running" || !!p?.canType();
        take.disabled = !p?.connected || !streamReady || changingControl;
        take.textContent = p?.uncertain ? "Review & take control" : "Take control";
        restart.hidden = !session || !!session.command || session.state === "running";
        restart.disabled = !p?.connected || launching;
        keys.hidden = !showKeys || !session || session.state !== "running";
        keys.querySelectorAll<HTMLButtonElement>("button").forEach(b => { b.disabled = !writable; });
        const why = failure || p?.failure || "";
        const text = why ? why : !listOk || !streamReady || (p && !p.connected) ? "Reconnecting…" : !session ? "Ready" :
          session.state !== "running" ? terminalExitLabel(session) : changingControl ? "Saving…" :
          p?.uncertain ? "Input unconfirmed · review the screen" :
          writable ? session.agentInput ? "Shared with Rime" : "You’re in control" : session.owner ? "Viewing · controlled elsewhere" : "Viewing only";
        if (status.textContent !== text) status.textContent = text;
        status.dataset.state = !listOk || !streamReady || (p && (!p.connected || p.uncertain)) ? "attention" : writable ? "active" : "idle";
        status.title = session ? `${names[session.kind]} · ${session.agentInput ? "You and Rime can both type in this session" : "Rime input is off; you can keep typing"}` : "";
      }
      function sessionList() {
        const active = activeGroup();
        const signature = JSON.stringify(groups.map(g => leaves(g).map(id => [id, titleOf(id), list.find(s => s.id === id)?.state])));
        if (signature !== sessionOptions) {
          sessionOptions = signature;
          sessions.replaceChildren();
          groups.forEach((g, index) => {
            const ids = leaves(g), first = ids[0] ?? "";
            const row = el("div", "term-tab");
            row.setAttribute("role", "presentation");
            row.dataset.group = String(index);
            const tab = button(titleOf(first), () => attach(first));
            tab.className = "term-tab-label";
            tab.dataset.session = first;
            tab.id = `terminal-tab-${w.i}-${first}`;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-controls", panesHost.id);
            tab.setAttribute("aria-keyshortcuts", "Delete");
            tab.title = ids.map(titleOf).join(" · ");
            if (ids.length > 1) { row.dataset.split = "true"; tab.append(el("span", "term-tab-badge", `+${ids.length - 1}`)); }
            tab.onpointerdown = e => startDrag(e, { kind: "tab", group: g });
            const close = toolButton("close", `Close ${titleOf(first)} tab`, () => closeSessions(ids, "tab"));
            close.classList.add("term-tab-close");
            close.title = ids.some(id => list.find(s => s.id === id)?.state === "running") ? "Close tab · session keeps running" : "Close tab";
            row.append(tab, close);
            sessions.append(row);
          });
        }
        panesHost.removeAttribute("aria-labelledby");
        const tabs = [...sessions.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
        for (const tab of tabs) {
          const row = tab.parentElement;
          if (!row) continue;
          const selected = groups[Number(row.dataset.group)] === active && !!state.session;
          tab.setAttribute("aria-selected", String(selected));
          row.dataset.active = String(selected);
          tab.tabIndex = selected || (!state.session && tab === tabs[0]) ? 0 : -1;
          if (selected) {
            panesHost.setAttribute("aria-labelledby", tab.id);
            if (row.offsetLeft < sessions.scrollLeft || row.offsetLeft + row.offsetWidth > sessions.scrollLeft + sessions.clientWidth)
              sessions.scrollLeft = row.offsetLeft;
          }
        }
      }
      sessions.onkeydown = e => {
        if (!(e.target instanceof HTMLElement) || e.target.getAttribute("role") !== "tab" || !e.target.dataset.session) return;
        if (e.key === "Delete") {
          e.preventDefault();
          const g = groupOf(e.target.dataset.session);
          if (g) void closeSessions(leaves(g), "tab").catch(error => toast(error.message, undefined, true));
          return;
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const tabs = [...sessions.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
        const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
        const tab = tabs[e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 :
          (at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
        tab?.focus(); tab?.click();
      };
      /** Show `id`: its group becomes the active tab (a new tab when it is in none). */
      function attach(id: string): Promise<void> {
        attaching = attaching.catch(() => {}).then(async () => {
          if (stopped) return;
          const shown = state.session === id ? panes.get(id) : undefined;
          if (shown) { shown.focus(); return; }
          const closed = new Set(state.closedSessions); closed.delete(id);
          const tabs = new Set(state.tabs); tabs.add(id);
          state = { ...state, session: id, tabs: [...tabs], closedSessions: [...closed] };
          autoAttach = false;
          if (!groupOf(id)) groups = [...groups, id];
          zoomed = undefined;
          await save();
          render();
          panes.get(id)?.focus();
        });
        return attaching;
      }
      /** Hide sessions (a tab's every pane, or one pane); their processes keep running. */
      function closeSessions(ids: string[], what: "tab" | "pane"): Promise<void> {
        attaching = attaching.catch(() => {}).then(async () => {
          if (stopped) return;
          const closed = new Set(state.closedSessions), tabs = new Set(state.tabs);
          for (const id of ids) { closed.add(id); tabs.delete(id); }
          let next = state.session;
          if (next && ids.includes(next)) {
            const g = groupOf(next), at = g ? groups.indexOf(g) : -1;
            const rest = g ? leaves(g).filter(x => !ids.includes(x)) : [];
            const neighbour = groups[at + 1] ?? groups[at - 1];
            next = rest[0] ?? (neighbour ? leaves(neighbour)[0] : undefined);
          }
          groups = groups.flatMap(g => { let n: Node | null = g; for (const id of ids) n = n === null ? null : remove(n, id); return n === null ? [] : [n]; });
          state = { ...state, session: next, tabs: [...tabs], closedSessions: [...closed] };
          zoomed = undefined;
          await save();
          render();
          (focused()?.el.contains(document.activeElement) ? undefined : sessions.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? newButton)?.focus();
          const running = ids.find(id => list.find(s => s.id === id)?.state === "running");
          if (running) toast(`${what === "tab" ? "Tab" : "Pane"} closed. Session keeps running.`, { label: "Reopen", fn: () => { void attach(running).catch(error => toast(error.message, undefined, true)); } });
        });
        return attaching;
      }
      async function launch(options?: Record<string, unknown>, previous?: string, place?: { target: string; side: Side }) {
        if (launching) return;
        launching = true;
        draw();
        try {
          const size = focused()?.term;
          const s: SessionView = previous ? await api("restart", { id: previous }, "POST") :
            await api("sessions", { project: state.project, kind: "shell", mode: "human", cols: size?.cols ?? 100, rows: size?.rows ?? 30, ...options }, "POST");
          if (!list.some(x => x.id === s.id)) list.unshift(s);
          if (place && groupOf(place.target) && !groupOf(s.id)) groups = groups.map(g => has(g, place.target) ? insert(g, place.target, s.id, place.side) : g);
          await attach(s.id);
          await api("control", { id: s.id, takeover: true }, "POST");
          const p = panes.get(s.id);
          if (p) { p.reclaim(); await p.update(); p.resize(); p.focus(); }
        } finally {
          launching = false;
          if (!stopped) draw();
        }
      }
      /** A new shell beside `target`. Existing sessions are tiled by dragging their tab in. */
      async function split(side: Side, target = state.session) {
        const g = target && groupOf(target);
        if (!g || !target) { toast("Open a terminal first.", undefined, true); return; }
        if (leaves(g).length >= MAX_PANES) { toast(`Up to ${MAX_PANES} panes in one tab.`, undefined, true); return; }
        await launch({ title: `${names.shell} ${list.filter(s => s.kind === "shell" && !s.command).length + 1}` }, undefined, { target, side });
      }
      function cycleTab(delta: number) {
        const g = activeGroup();
        const next = g ? groups[(groups.indexOf(g) + delta + groups.length) % groups.length] : undefined;
        const first = next ? leaves(next)[0] : undefined;
        if (first) void attach(first).catch(e => toast(e.message, undefined, true));
      }
      function focusNeighbour(p: Pane, dir: string) {
        const r = p.el.getBoundingClientRect(), cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
        let best: Pane | undefined, score = Infinity;
        for (const q of panes.values()) {
          if (q === p || !q.el.isConnected) continue;
          const b = q.el.getBoundingClientRect(), dx = (b.left + b.right) / 2 - cx, dy = (b.top + b.bottom) / 2 - cy;
          if (dir === "left" ? dx >= -1 : dir === "right" ? dx <= 1 : dir === "up" ? dy >= -1 : dy <= 1) continue;
          const s = dir === "left" || dir === "right" ? Math.abs(dx) + 2 * Math.abs(dy) : Math.abs(dy) + 2 * Math.abs(dx);
          if (s < score) { score = s; best = q; }
        }
        best?.focus();
      }
      function setPrefs(next: Prefs) {
        prefs = next; savePrefs(next);
        for (const p of panes.values()) p.applyPrefs(next);
      }
      function shortcut(e: KeyboardEvent, p: Pane): boolean {
        const k = e.key.toLowerCase();
        if (k === "f") { openFind(); return true; }
        if (k === "c") {
          if (!p.term.hasSelection()) return false;
          void navigator.clipboard.writeText(p.term.getSelection()).catch(err => toast(err.message, undefined, true));
          return true;
        }
        if (k === "v") { void navigator.clipboard.readText().then(text => { if (p.writable()) p.term.paste(text); }).catch(err => toast(err.message, undefined, true)); return true; }
        if (k === "k") { p.term.clear(); return true; }
        if (k === "d" || k === "e") { void split(k === "d" ? "right" : "bottom", p.id); return true; }
        if (["+", "=", "-", "0"].includes(e.key)) {
          setPrefs({ ...prefs, size: e.key === "0" ? DEFAULT_PREFS.size : Math.max(9, Math.min(28, prefs.size + (e.key === "-" ? -1 : 1))) });
          return true;
        }
        if (k === "[" || k === "]") { cycleTab(k === "]" ? 1 : -1); return true; }
        if (/^[1-9]$/.test(k)) { const first = leaves(groups[Number(k) - 1] ?? "")[0]; if (first) void attach(first); return true; }
        if (k === "enter" && e.shiftKey) { zoomed = zoomed === p.id ? undefined : p.id; renderPanes(); p.focus(); return true; }
        if (k.startsWith("arrow") && e.altKey) { focusNeighbour(p, k.slice(5)); return true; }
        return false;
      }
      type DragSource = { kind: "tab"; group: Node } | { kind: "pane"; id: string };
      type DropTarget = { kind: "strip"; index: number } | { kind: "pane"; id: string; side: Side | "center" };
      function startDrag(e: PointerEvent, source: DragSource) {
        if (e.button !== 0 || e.pointerType === "touch") return;
        const sx = e.clientX, sy = e.clientY;
        let active = false, ghost: HTMLElement | undefined, target: DropTarget | undefined, marked: HTMLElement | undefined;
        const label = source.kind === "tab" ? leaves(source.group).map(titleOf).join(" · ") : titleOf(source.id);
        const clearMark = () => { marked?.removeAttribute("data-drop"); marked = undefined; };
        const move = (ev: PointerEvent) => {
          if (!active) {
            if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
            active = true;
            ghost = el("div", "term-ghost", label);
            document.body.append(ghost);
            host.dataset.dragging = source.kind;
          }
          if (ghost) ghost.style.translate = `${ev.clientX + 12}px ${ev.clientY + 12}px`;
          clearMark(); target = undefined;
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          if (!under) return;
          if (sessions.contains(under)) {
            const rows = [...sessions.querySelectorAll<HTMLElement>(".term-tab")];
            let index = rows.length;
            rows.forEach((row, i) => { const r = row.getBoundingClientRect(); if (index === rows.length && ev.clientX < r.left + r.width / 2) index = i; });
            target = { kind: "strip", index };
            marked = rows[index] ?? rows.at(-1);
            marked?.setAttribute("data-drop", rows[index] ? "before" : "after");
            return;
          }
          const paneEl = under.closest<HTMLElement>(".term-pane");
          if (!paneEl || !panesHost.contains(paneEl)) return;
          const id = paneEl.dataset.session ?? "";
          if ((source.kind === "pane" && source.id === id) || (source.kind === "tab" && has(source.group, id))) return;
          const r = paneEl.getBoundingClientRect(), fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
          const side: Side | "center" = fx < 0.25 ? "left" : fx > 0.75 ? "right" : fy < 0.25 ? "top" : fy > 0.75 ? "bottom" : "center";
          target = { kind: "pane", id, side };
          marked = paneEl; paneEl.dataset.drop = side;
        };
        const up = () => {
          window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
          ghost?.remove(); clearMark(); delete host.dataset.dragging;
          if (active && target) drop(source, target);
        };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
      }
      function drop(source: DragSource, target: DropTarget) {
        const node: Node = source.kind === "tab" ? source.group : source.id;
        const focusId = leaves(node)[0] ?? "";
        if (source.kind === "pane" && target.kind === "pane" && target.side === "center" && groupOf(source.id) === groupOf(target.id))
          groups = groups.map(g => swap(g, source.id, target.id));
        else {
          let index = target.kind === "strip" ? target.index : -1;
          if (source.kind === "tab") { const from = groups.indexOf(source.group); if (from >= 0 && from < index) index--; groups = groups.filter(g => g !== source.group); }
          else groups = groups.flatMap(g => { const n = remove(g, source.id); return n === null ? [] : [n]; });
          if (target.kind === "strip") groups = [...groups.slice(0, index), node, ...groups.slice(index)];
          else {
            const gi = groups.findIndex(g => has(g, target.id));
            const into = groups[gi];
            if (!into || leaves(into).length + leaves(node).length > MAX_PANES) {
              if (gi >= 0) toast(`Up to ${MAX_PANES} panes in one tab.`, undefined, true);
              groups = [...groups, node];
            } else groups = groups.map((g, i) => i === gi ? insert(g, target.id, node, target.side === "center" ? "right" : target.side) : g);
          }
        }
        state.session = focusId; zoomed = undefined;
        void save();
        render();
        panes.get(focusId)?.focus();
      }
      const start = button("Open terminal", () => launch());
      start.className = "btn-primary";
      const agentChoices = el("div", "term-agent-choices");
      agentChoices.append(button("Codex", () => sessionDialog("codex")), button("Claude Code", () => sessionDialog("claude")));
      const mark = el("span", "dev-empty-icon"); mark.append(icon("code"));
      empty.append(mark, el("h3", undefined, "A terminal for your project"),
        el("p", undefined, "Open a shell, or work with a terminal agent."), start, agentChoices);

      function sessionDialog(initial: TerminalKind = "shell") {
        const { d, form, actions, error, submit } = workspaceDialog("New terminal session");
        d.classList.add("term-session-dialog");
        const field = (label: string, control: HTMLElement) => {
          const row = el("label", undefined, label);
          row.append(control);
          return row;
        };
        const program = select("Program", []);
        for (const [value, name] of Object.entries(names)) program.add(new Option(name, value));
        program.value = initial;
        const shell = select("Shell", [...new Set<string>(caps.shells)]);
        const agentInput = el("input"); agentInput.type = "checkbox";
        agentInput.checked = true;
        const agentField = el("label", "switch term-rime-control", "Let Rime control");
        agentField.prepend(agentInput);
        const task = el("textarea", "input");
        task.rows = 3; task.maxLength = 8000;
        task.placeholder = "What would you like the agent to work on?";
        const taskField = field("Initial task (optional)", task);
        const options = el("details", "term-launch-options");
        const shellField = field("Shell", shell);
        options.append(el("summary", undefined, "Shell options"), shellField);
        const availability = el("p", "term-help");
        const syncProgram = () => {
          const kind = program.value as TerminalKind;
          taskField.hidden = kind === "shell";
          shellField.hidden = kind !== "shell";
          options.hidden = kind !== "shell";
          const missing = kind !== "shell" && !caps.agents[kind];
          submit.disabled = missing;
          submit.textContent = kind === "shell" ? "Open terminal" : `Start ${names[kind]}`;
          availability.replaceChildren();
          if (kind !== "shell") {
            availability.append(document.createTextNode(missing ? `${names[kind]} isn’t installed on this desktop. ` : "Uses your existing local sign-in. "));
            const link = el("a", "link", "Setup guide ↗");
            link.href = kind === "codex" ? "https://developers.openai.com/codex/cli" : "https://code.claude.com/docs/en/setup";
            link.target = "_blank"; link.rel = "noopener noreferrer";
            availability.append(link);
          }
        };
        actions.before(field("Program", program), taskField, availability, agentField,
          el("p", "term-help", "You can always type. Leave this on for Rime to use the same session with you."), options);
        program.onchange = syncProgram;
        syncProgram();
        form.onsubmit = async e => {
          e.preventDefault();
          submit.disabled = true;
          error.hidden = true;
          try {
            const kind = program.value as TerminalKind;
            await launch({ kind, agentInput: agentInput.checked, ...(kind === "shell" ? { shell: shell.value } : { task: task.value }),
              title: `${names[kind]} ${list.filter(s => s.kind === kind && !s.command).length + 1}` });
            d.close();
          } catch (e) {
            error.textContent = (e as Error).message;
            error.hidden = false;
          } finally { submit.disabled = false; }
        };
        d.onclose = () => { d.remove(); focused()?.focus(); };
      }
      function settingsDialog() {
        const { d, form, actions, error, submit } = workspaceDialog("Terminal settings");
        d.classList.add("term-settings");
        const field = (label: string, control: HTMLElement) => { const row = el("label", undefined, label); row.append(control); return row; };
        const check = (label: string, on: boolean) => { const c = el("input"); c.type = "checkbox"; c.checked = on; const row = el("label", "term-settings-check", label); row.prepend(c); return { c, row }; };
        const number = (label: string, value: number, min: number, max: number, step = 1) => {
          const i = el("input", "input"); i.type = "number"; i.min = String(min); i.max = String(max); i.step = String(step); i.value = String(value); i.setAttribute("aria-label", label);
          return i;
        };
        const font = el("input", "input"); font.value = prefs.font; font.setAttribute("aria-label", "Font family");
        const fonts = el("datalist"); fonts.id = `term-fonts-${w.i}`;
        for (const f of [DEFAULT_PREFS.font, "JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", "Menlo", "Monaco", "Consolas", "Source Code Pro", "IBM Plex Mono", "Hack", "Ubuntu Mono", "DejaVu Sans Mono"]) fonts.append(new Option(f));
        font.setAttribute("list", fonts.id);
        const size = number("Font size", prefs.size, 9, 28), lineHeight = number("Line height", prefs.lineHeight, 1, 1.6, 0.05);
        const weight = select("Weight", ["300", "400", "500", "600"]); weight.value = String(prefs.weight);
        const boldWeight = select("Bold weight", ["600", "700", "800"]); boldWeight.value = String(prefs.boldWeight);
        const cursor = select("Cursor", ["block", "underline", "bar"]); cursor.value = prefs.cursor;
        const blink = check("Blink cursor", prefs.blink), optionMeta = check("Option key sends Meta (Alt)", prefs.optionMeta), webgl = check("GPU rendering (WebGL)", prefs.webgl);
        const contrast = number("Minimum contrast", prefs.contrast, 1, 21, 0.5), scrollback = number("Scrollback lines", prefs.scrollback, 1000, 50000, 1000);
        const renderer = el("p", "term-help");
        const p = focused() ?? panes.values().next().value;
        renderer.textContent = `Renderer now: ${!p ? "no pane open" : p.renderer() === "webgl" ? "WebGL (GPU)" : prefs.webgl ? "DOM — WebGL unavailable here" : "DOM"}`;
        const grid = el("div", "term-settings-grid");
        grid.append(field("Font family", font), fonts, field("Size", size), field("Line height", lineHeight), field("Weight", weight), field("Bold weight", boldWeight),
          field("Cursor", cursor), field("Minimum contrast", contrast), field("Scrollback", scrollback));
        const checks = el("div", "term-settings-checks");
        checks.append(blink.row, webgl.row);
        if (isMac) checks.append(optionMeta.row);
        const reset = button("Reset to defaults", () => { setPrefs({ ...DEFAULT_PREFS }); d.close(); });
        actions.prepend(reset);
        actions.before(grid, checks, renderer, el("p", "term-help", `Shortcuts: ${isMac ? "⌘" : "Ctrl+Shift"} D split right · E split down · K clear · F find · [ ] switch tab · 1–9 tab · ${isMac ? "⌘⌥" : "Ctrl+Shift+Alt"} arrows focus pane · ${isMac ? "⌘⇧" : "Ctrl+Shift"}+Enter zoom · Shift+Enter newline in agents.`));
        submit.textContent = "Save";
        form.onsubmit = e => {
          e.preventDefault();
          error.hidden = true;
          const read = (i: HTMLInputElement, lo: number, hi: number, fallback: number) => { const v = Number(i.value); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback; };
          setPrefs({
            font: font.value.trim().slice(0, 200) || DEFAULT_PREFS.font, size: read(size, 9, 28, 13), lineHeight: read(lineHeight, 1, 1.6, 1.2),
            weight: Number(weight.value), boldWeight: Number(boldWeight.value), cursor: cursor.value as Prefs["cursor"],
            blink: blink.c.checked, optionMeta: optionMeta.c.checked, contrast: read(contrast, 1, 21, 1), scrollback: read(scrollback, 1000, 50000, 10000), webgl: webgl.c.checked,
          });
          d.close();
        };
        d.onclose = () => { d.remove(); focused()?.focus(); };
      }

      const findBar = el("div", "term-find");
      findBar.hidden = true;
      const query = input("Find in terminal"), result = el("span", "term-find-result");
      result.setAttribute("role", "status");
      const find = (previous = false) => {
        const search = focused()?.search;
        const found = !search || !query.value || (previous ? search.findPrevious(query.value) : search.findNext(query.value));
        result.textContent = found ? "" : "No match";
      };
      const closeFind = () => { findBar.hidden = true; focused()?.search.clearDecorations(); focused()?.focus(); };
      findBar.append(query, result, toolButton("left", "Previous match", () => find(true)),
        toolButton("right", "Next match", () => find()), toolButton("close", "Close search", closeFind));
      surface.prepend(findBar);
      const openFind = () => { findBar.hidden = false; query.focus(); query.select(); };
      query.oninput = () => find();
      query.onkeydown = e => {
        if (e.isComposing) return;
        if (e.key === "Enter") { e.preventDefault(); find(e.shiftKey); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
      };
      // Native popovers stay above ward clipping and the expanded dialog, and
      // provide outside-click/Escape dismissal without document listeners.
      const menu = el("div", "term-menu");
      menu.popover = "auto";
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "Terminal actions");
      more.popoverTargetElement = menu;
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      host.append(menu);
      menu.addEventListener("beforetoggle", e => {
        if ((e as ToggleEvent).newState !== "open") return;
        menu.replaceChildren();
        const action = (label: string, fn: () => unknown, disabled = false, danger = false) => {
          const b = button(label, async () => { menu.hidePopover(); await fn(); });
          b.className = "term-menu-item";
          b.setAttribute("role", "menuitem");
          b.disabled = disabled;
          if (danger) b.dataset.danger = "true";
          menu.append(b);
        };
        const p = focused(), session = p?.session, g = activeGroup();
        const many = !!g && leaves(g).length > 1;
        action("Split right", () => split("right"), !p || launching);
        action("Split down", () => split("bottom"), !p || launching);
        action("Close pane", () => p && closeSessions([p.id], "pane"), !many);
        action(zoomed ? "Unzoom pane" : "Zoom pane", () => { zoomed = zoomed ? undefined : p?.id; renderPanes(); p?.focus(); }, !many && !zoomed);
        menu.append(el("hr"));
        action("Find in terminal…", openFind, !p);
        action("Copy selection", () => p && navigator.clipboard.writeText(p.term.getSelection()), !p?.term.hasSelection());
        action("Paste", async () => { if (p) { p.term.paste(await navigator.clipboard.readText()); p.focus(); } }, !p?.writable());
        action("Clear scrollback", () => p?.term.clear(), !p);
        action("Terminal settings…", settingsDialog);
        action(paneHost.screenReader() ? "Disable screen reader support" : "Enable screen reader support", () => {
          const on = !paneHost.screenReader();
          localStorage.setItem("rimeward-terminal-accessibility", String(on));
          for (const q of panes.values()) q.term.options.screenReaderMode = on;
        });
        action(showKeys ? "Hide extra keys" : "Show extra keys", () => { showKeys = !showKeys; draw(); });
        action("Task manager…", taskManager);
        if (session) {
          const target = session;
          menu.append(el("hr"));
          action("Rename session…", async () => {
            const title = await askText("Session name");
            if (title?.trim()) { await api("configure", { id: target.id, title }, "POST"); await refreshList(); }
          });
          if (target.state === "running") {
            action("Interrupt process", () => p?.interrupt(), !p?.canType());
            menu.append(el("hr"));
            action("End session…", async () => {
              if (await confirmAction(`End ${target.title}? The process will stop. Its saved screen stays available.`)) {
                await api("sessions", { id: target.id }, "DELETE");
                await refreshList();
              }
            }, !listOk, true);
          } else if (!target.command) action("Delete session…", () => deleteSaved(target), !listOk, true);
        }
      });
      let taskDialog: HTMLDialogElement | undefined;
      function taskManager() {
        const { d, form, error, actions } = workspaceDialog("Task manager");
        taskDialog = d;
        d.classList.add("term-task-manager");
        error.style.whiteSpace = "pre-line";
        const headingIcon = el("span", "term-task-heading-icon");
        headingIcon.setAttribute("aria-hidden", "true"); headingIcon.append(icon("chart"));
        d.querySelector("h2")?.prepend(headingIcon);
        const dismiss = button("Close", () => closeManager());
        dismiss.classList.add("term-task-dismiss");
        dismiss.setAttribute("aria-label", "Close");
        actions.replaceChildren(dismiss);
        dismiss.replaceChildren(icon("close"), document.createTextNode("Close"));
        let closing = false;
        const closeManager = async () => {
          if (closing) return;
          closing = true;
          if (!reducedMotion()) await d.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(8px)" }], { duration: 140 }).finished;
          d.close();
        };
        d.oncancel = e => { e.preventDefault(); void closeManager(); };
        form.onsubmit = e => e.preventDefault();
        const summary = el("p", "term-task-summary", "Loading sessions…");
        const filters = el("div", "term-task-filters"), search = input("Find a session");
        search.type = "search";
        const searchField = el("label", "term-task-search"); searchField.append(icon("search"), search);
        let filter = "All", sort = "Session", descending = false;
        let records: SessionResourceView[] = [], loading = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const filterButtons = ["All", "Running", "Saved"].map(value => {
          const b = button(value, () => { filter = value; drawTasks(true); });
          b.className = "term-task-filter"; filters.append(b); return b;
        });
        filters.append(searchField);
        const selection = new Set<string>();
        let applying = false;
        const bulk = el("div", "term-task-bulk"), selectedCount = el("span", "term-task-selection", "None selected");
        const selectAll = el("input"); selectAll.type = "checkbox"; selectAll.setAttribute("aria-label", "Select all matching sessions");
        const selectLabel = el("label", "term-task-select-all"); selectLabel.append(selectAll, document.createTextNode("Select all"));
        const history = el("input"); history.type = "checkbox";
        const historyLabel = el("label", "term-task-history"); historyLabel.append(history, icon("history"), document.createTextNode("History"));
        historyLabel.title = "Completed command logs · newest 100, kept for up to 30 days";
        const endSelected = button("End selected", () => bulkAction("end")), deleteSelected = button("Delete selected", () => bulkAction("delete"));
        endSelected.prepend(icon("stop")); deleteSelected.prepend(icon("trash"));
        bulk.append(selectLabel, selectedCount, endSelected, deleteSelected, historyLabel);
        const scroll = el("div", "term-task-scroll"), table = el("table", "table term-task-table");
        table.setAttribute("aria-label", "Terminal sessions and resource usage");
        const head = el("thead"), headings = el("tr"), rows = el("tbody");
        for (const label of ["Session", "Status", "CPU", "Memory", "PID", "Actions"]) {
          const th = el("th"); th.scope = "col";
          if (label === "Memory") th.title = "Resident memory including child processes; shared pages may be counted more than once.";
          if (["Session", "CPU", "Memory"].includes(label)) {
            const b = button(label, () => { descending = sort === label ? !descending : label !== "Session"; sort = label; drawTasks(true); });
            b.className = "term-task-sort"; b.setAttribute("aria-label", label); b.append(icon("down")); th.append(b); th.dataset.sort = label;
          } else th.textContent = label;
          if (label === "PID") th.className = "term-task-pid";
          headings.append(th);
        }
        head.append(headings); table.append(head, rows); scroll.append(table);
        const emptyTasks = el("p", "term-task-empty", "No sessions to show."); emptyTasks.hidden = true;
        const note = el("p", "term-help", "Darker rows use more resources. Usage includes child processes; 100% CPU is one core.");
        actions.before(summary, filters, bulk, scroll, emptyTasks, note);
        const entries = new Map<string, ReturnType<typeof makeRow>>();
        const memory = (bytes: number | null) => bytes === null ? "—" : bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
        function makeRow(s: SessionResourceView) {
          const row = el("tr"); row.dataset.session = s.id;
          const nameCell = el("td"), name = el("strong"), detail = el("span", "term-task-detail");
          const identity = el("div", "term-task-identity"), text = el("div");
          const selected = el("input"); selected.type = "checkbox"; selected.setAttribute("aria-label", `Select ${s.title}`);
          selected.onchange = () => { if (selected.checked) selection.add(s.id); else selection.delete(s.id); drawTasks(); };
          text.append(name, detail); identity.append(selected, icon(s.kind === "shell" ? "code" : "bot"), text); nameCell.append(identity);
          const stateCell = el("td"), status = el("span", "term-task-status"); stateCell.append(status);
          const cpu = el("td", "term-task-number"), meter = el("div", "term-task-meter"), fill = el("i"), cpuText = el("span");
          fill.setAttribute("aria-hidden", "true"); meter.append(fill, cpuText); cpu.append(meter);
          const mem = el("td", "term-task-number"), pid = el("td", "term-task-pid term-task-number");
          const controls = el("td"), buttons = el("div", "term-task-actions");
          const open = button("Open", async () => { await attach(s.id); await closeManager(); });
          open.prepend(icon("right")); open.setAttribute("aria-label", `Open ${s.title}`);
          const remove = button("", async () => {
            if (applying) return;
            const target = records.find(item => item.id === s.id);
            if (!target) return;
            remove.disabled = true;
            remove.dataset.busy = "true";
            try {
              if (target.state === "running") {
                if (!await confirmAction(`End ${target.title}? The process will stop. Its saved screen stays available.`)) return;
                await api("sessions", { id: target.id }, "DELETE");
              } else if (!await deleteSaved(target)) return;
              await refresh(); await refreshList();
            } finally { delete remove.dataset.busy; if (remove.isConnected) remove.disabled = applying; }
          });
          buttons.append(open, remove); controls.append(buttons);
          row.append(nameCell, stateCell, cpu, mem, pid, controls);
          return { row, selected, name, detail, status, cpuText, fill, mem, pid, remove };
        }
        async function bulkAction(action: "end" | "delete") {
          const targets = records.filter(s => selection.has(s.id) && (action === "end" ? s.state === "running" : s.state !== "running"));
          if (applying || !targets.length) return;
          if (!await confirmAction(action === "end" ? `End ${targets.length} selected sessions? Their processes will stop; saved screens remain.` :
            `Delete ${targets.length} selected saved sessions and their terminal history? Project files and native CLI conversations are kept.`)) return;
          applying = true; drawTasks();
          try {
            const results = await Promise.allSettled(targets.map(s => api(action === "end" ? "sessions" : "session-history", { id: s.id }, "DELETE")));
            const failures: string[] = [], deleted = new Set<string>();
            results.forEach((r, i) => {
              const target = targets[i];
              if (!target) return;
              if (r.status === "rejected") failures.push(`${target.title}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
              else { selection.delete(target.id); if (action === "delete") deleted.add(target.id); }
            });
            if (deleted.size) {
              state.closedSessions = state.closedSessions?.filter(id => !deleted.has(id));
              state.tabs = state.tabs?.filter(id => !deleted.has(id));
              await save();
            }
            await refresh(); await refreshList();
            if (failures.length) { error.textContent = failures.join("\n"); error.hidden = false; }
          } finally { applying = false; drawTasks(); }
        }
        function drawTasks(animate = false) {
          const positions = new Map([...entries].filter(([, e]) => e.row.isConnected && !e.row.hidden).map(([id, e]) => [id, e.row.getBoundingClientRect().top]));
          for (const { row } of entries.values()) for (const animation of row.getAnimations()) if (animation.id === "term-task-reorder") animation.cancel();
          const query = search.value.trim().toLowerCase();
          const visible = records.filter(s => (filter === "All" || (s.state === "running" ? "Running" : "Saved") === filter) &&
            `${s.title} ${names[s.kind]} ${s.pid ?? ""}`.toLowerCase().includes(query));
          visible.sort((a, b) => Number(b.state === "running") - Number(a.state === "running") ||
            (sort === "CPU" ? (a.cpuPercent ?? -1) - (b.cpuPercent ?? -1) : sort === "Memory" ? (a.memoryBytes ?? -1) - (b.memoryBytes ?? -1) : a.title.localeCompare(b.title)) * (descending ? -1 : 1));
          for (const b of filterButtons) b.setAttribute("aria-pressed", String(b.textContent === filter));
          for (const th of headings.querySelectorAll<HTMLElement>("[data-sort]")) th.setAttribute("aria-sort", th.dataset.sort === sort ? descending ? "descending" : "ascending" : "none");
          const active = records.filter(s => s.state === "running");
          const maxCpu = Math.max(100, ...active.map(s => s.cpuPercent ?? 0));
          const maxMemory = Math.max(256 * 1024 * 1024, ...active.map(s => s.memoryBytes ?? 0));
          summary.textContent = `${active.length} running · ${records.length - active.length} saved · ${memory(active.some(s => s.memoryBytes === null) ? null : active.reduce((total, s) => total + (s.memoryBytes ?? 0), 0))} in use`;
          const recordIds = new Set(records.map(s => s.id)), visibleIds = new Set(visible.map(s => s.id));
          for (const id of selection) if (!recordIds.has(id)) selection.delete(id);
          const selectedVisible = visible.filter(s => selection.has(s.id));
          selectAll.checked = visible.length > 0 && selectedVisible.length === visible.length;
          selectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visible.length;
          selectAll.disabled = applying || !visible.length;
          const selectedRunning = records.filter(s => selection.has(s.id) && s.state === "running").length;
          selectedCount.textContent = applying ? `Applying to ${selection.size} sessions…` : selection.size ? `${selection.size} selected` : "None selected";
          endSelected.disabled = applying || !selectedRunning;
          deleteSelected.disabled = applying || selection.size === selectedRunning;
          history.disabled = applying;
          for (const [id, entry] of entries) {
            if (recordIds.has(id)) continue;
            entries.delete(id);
            if (entry.row.contains(document.activeElement)) search.focus();
            if (reducedMotion()) entry.row.remove();
            else void entry.row.animate([{ opacity: 1 }, { opacity: 0, transform: "translateX(8px)" }], { duration: 140, fill: "forwards" }).finished.then(() => entry.row.remove());
          }
          for (const [id, entry] of entries) entry.row.hidden = !visibleIds.has(id);
          visible.forEach((s, index) => {
            let entry = entries.get(s.id);
            const added = !entry;
            if (!entry) { entry = makeRow(s); entries.set(s.id, entry); }
            const { row, name, detail, status, cpuText, fill, mem, pid, remove } = entry;
            entry.selected.checked = selection.has(s.id); entry.selected.disabled = applying;
            entry.selected.setAttribute("aria-label", `Select ${s.title}`);
            row.dataset.selected = String(entry.selected.checked);
            name.textContent = s.title === s.kind ? names[s.kind] : s.title;
            detail.textContent = s.command ? "Rime command" : names[s.kind];
            status.textContent = s.state === "running" ? "Running" : "Saved";
            status.dataset.running = String(s.state === "running");
            cpuText.textContent = s.cpuPercent === null ? "—" : `${s.cpuPercent.toFixed(1)}%`;
            fill.style.transform = `scaleX(${Math.min(1, (s.cpuPercent ?? 0) / 100)})`;
            const load = s.state === "running" ? 1 - (1 - (s.cpuPercent ?? 0) / maxCpu) * (1 - (s.memoryBytes ?? 0) / maxMemory) : 0;
            row.style.setProperty("--task-load", String(load));
            mem.textContent = memory(s.memoryBytes); pid.textContent = s.pid === null ? "—" : String(s.pid);
            const action = s.state === "running" ? "End" : "Delete";
            if (remove.dataset.action !== action) { remove.dataset.action = action; remove.replaceChildren(icon(action === "End" ? "stop" : "trash"), document.createTextNode(action)); }
            remove.setAttribute("aria-label", `${action} ${s.title}`);
            remove.disabled = applying || remove.dataset.busy === "true";
            row.hidden = false;
            if (rows.children[index] !== row) rows.insertBefore(row, rows.children[index] ?? null);
            if (added && !reducedMotion()) row.animate([{ opacity: 0, transform: "translateY(5px)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "ease-out" });
          });
          if (!reducedMotion()) for (const s of visible) {
            const row = entries.get(s.id)?.row, before = positions.get(s.id);
            if (!row || before === undefined) continue;
            const offset = before - row.getBoundingClientRect().top;
            if (Math.abs(offset) < 1) continue;
            row.animate([{ transform: `translateY(${offset}px)` }, { transform: "none" }], { duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)", id: "term-task-reorder" });
          }
          emptyTasks.hidden = visible.length > 0;
          if (animate && !reducedMotion()) rows.animate([{ opacity: .45, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "ease-out" });
        }
        async function refresh() {
          clearTimeout(timer);
          if (!d.open || loading) return;
          loading = true;
          try {
            if (document.hidden) return;
            const result = await api<{ sessions: SessionResourceView[]; error?: string }>("session-resources", { project: state.project, history: String(history.checked) });
            if (!d.open) return;
            records = result.sessions; drawTasks();
            error.textContent = result.error ?? ""; error.hidden = !result.error;
          } catch (e) { error.textContent = (e as Error).message; error.hidden = false; }
          finally { loading = false; if (d.open) timer = setTimeout(() => void refresh(), 2000); }
        }
        search.oninput = () => drawTasks(true);
        selectAll.onchange = () => { for (const [id, entry] of entries) if (!entry.row.hidden) { if (selectAll.checked) selection.add(id); else selection.delete(id); } drawTasks(); };
        history.onchange = () => { selection.clear(); void refresh(); };
        d.onclose = () => { clearTimeout(timer); taskDialog = undefined; d.remove(); };
        void refresh();
      }
      async function deleteSaved(target: SessionView) {
        if (!await confirmAction(`Delete ${target.title} and its saved terminal history? Project files and Codex or Claude conversations are kept.`)) return false;
        await api("session-history", { id: target.id }, "DELETE");
        state.closedSessions = state.closedSessions?.filter(id => id !== target.id);
        state.tabs = state.tabs?.filter(id => id !== target.id);
        await save(); await refreshList();
        return true;
      }
      menu.addEventListener("toggle", e => {
        const open = (e as ToggleEvent).newState === "open";
        more.setAttribute("aria-expanded", String(open));
        if (!open) return;
        const anchor = more.getBoundingClientRect(), box = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(anchor.right - box.width, innerWidth - box.width - 8))}px`;
        menu.style.top = `${anchor.bottom + box.height + 8 < innerHeight ? anchor.bottom + 5 : Math.max(8, anchor.top - box.height - 5)}px`;
        menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
      });
      menu.onkeydown = e => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        items[e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 :
          (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      };
      // Declared last: the stream notifies its listener synchronously (a `null` on connect).
      const stream = terminalEvents(w.device ?? readPages().find(p => p.id === pageOfCard(w.i))?.device ?? "local", w.i, event => {
        if (stopped) return;
        if (!event) { streamReady = false; for (const p of panes.values()) p.event(null); draw(); return; }
        if (event.type === "reset") { streamReady = true; void refreshList(); for (const p of panes.values()) p.event(event); return; }
        if (event.type === "session") {
          if (!event.data) { void refreshList(); return; }
          const next = event.data as SessionView;
          if (next.project !== state.project) return;
          const at = list.findIndex(s => s.id === next.id);
          if (at < 0) list.unshift(next); else list[at] = next;
          if (listOk) syncGroups();
          sessionList();
          if (autoAttach && !launching && !state.session && next.state === "running" && tabVisible(next))
            void attach(next.id).catch(error => toast(error.message, undefined, true));
          panes.get(next.id)?.event(event);
          return;
        }
        if (event.type === "output") panes.get(event.id)?.event(event);
      }, ack => { for (const p of panes.values()) p.ack(ack); });
      const paneHost: PaneHost = {
        api, stream, prefs: () => prefs,
        screenReader: () => localStorage.getItem("rimeward-terminal-accessibility") === "true",
        busy: p => changingControl && p.id === state.session,
        changed: p => { if (p.id === state.session) draw(); },
        focused: p => {
          if (state.session === p.id) return;
          state.session = p.id; void save();
          for (const q of panes.values()) q.setActive(panes.size > 1 && q === p);
          sessionList(); draw();
        },
        shortcut, close: p => void closeSessions([p.id], "pane").catch(e => toast(e.message, undefined, true)),
        drag: (e, p) => startDrag(e, { kind: "pane", id: p.id }),
      };
      cleanup.push(() => {
        taskDialog?.close();
        if (menu.matches(":popover-open")) menu.hidePopover();
        clearTimeout(retryList);
        for (const p of panes.values()) p.dispose();
        panes.clear();
        stream.stop();
      });
      await refreshList();
    } else {
      const output = el("pre", "dev-diff");
      content.append(output);
      const refresh = async () => {
        const g = await api<Awaited<ReturnType<typeof gitView>>>("git", { project: state.project });
        output.textContent = `${g.status}\n${g.diff}\n${g.worktrees}`;
      };
      bar.append(
        button("Refresh", refresh),
        button("New worktree", async () => {
          const name = await askText("Worktree name");
          if (name) {
            await api(
              "worktree",
              { project: state.project, name, op: "add" },
              "POST",
            );
            await refresh();
          }
        }),
        button("Remove worktree", async () => {
          const name = await askText(
            "Rimeward worktree name (dirty trees are preserved)",
          );
          if (name) {
            await api(
              "worktree",
              { project: state.project, name, op: "remove" },
              "POST",
            );
            await refresh();
          }
        }),
      );
      cleanup.push(
        poll(
          () =>
            refresh().catch((e) => {
              output.textContent = e.message;
            }),
          5000,
        ),
      );
    }
  } catch (err) {
    if (stopped) return;
    content.textContent = (err as Error).message;
    // A single owned timer. poll() ticks synchronously, so its stop would land in THIS (already
    // run) cleanup list and the poller would remount the ward every 5 s for the rest of the page.
    const slow = [401, 403, 404].includes((err as { status?: number }).status ?? 0);
    const retry = setTimeout(() => { states.get(w.i)?.stop(); void mount(w); }, slow ? 30000 : 5000);
    cleanup.push(() => clearTimeout(retry));
  }
}
for (const type of DEV_WARDS)
  RENDERERS[type] = {
    render: mount,
    stop(id) {
      states.get(id)?.stop();
    },
  };
