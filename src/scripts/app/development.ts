import { expandedDesktopWard, restoreExpandedWard } from "./desktop-state.ts";
import type { terminalCapabilities, readSession } from "../../lib/dev/terminals.ts";
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
  terminalNeedsRestore,
  type Project,
  type SessionView,
  type SessionResourceView,
  type TerminalKind,
} from "../../lib/dev/types.ts";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { terminalEvents } from "./terminal-stream.ts";
import { TerminalInput } from "./terminal-input.ts";
import "@xterm/xterm/css/xterm.css";
import "../../styles/development.css";

const owner = sessionStorage.getItem("rimeward-input-owner") ?? `client:${crypto.randomUUID()}`;
sessionStorage.setItem("rimeward-input-owner", owner);
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
      const screen = el("div", "dev-terminal");
      screen.id = `terminal-screen-${w.i}`;
      screen.setAttribute("role", "tabpanel");
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
      surface.append(screen, empty);
      content.replaceChildren(surface, footer);
      const term = new Terminal({
        scrollback: 10000, fontSize: 13, lineHeight: 1.2,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        theme: { background: "#101419", foreground: "#e4e9f0", cursor: "#c5d6e8" },
        disableStdin: true, screenReaderMode: localStorage.getItem("rimeward-terminal-accessibility") === "true",
        allowProposedApi: true, cursorBlink: true, rightClickSelectsWord: true,
      });
      const fit = new FitAddon(), search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      term.loadAddon(new WebLinksAddon((event, url) => {
        if ((event.ctrlKey || event.metaKey) && /^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
      }));
      term.open(screen);
      void import("@xterm/addon-webgl").then(({ WebglAddon }) => {
        if (stopped) return;
        let gpu: InstanceType<typeof WebglAddon> | undefined;
        try { gpu = new WebglAddon(); gpu.onContextLoss(() => gpu?.dispose()); term.loadAddon(gpu); }
        catch { gpu?.dispose(); } // DOM renderer remains available without a GPU.
      }).catch(() => {});
      let session: SessionView | undefined, list: SessionView[] = [];
      let sequence: number | undefined, updating: Promise<void> | undefined;
      let connected = false, streamReady = false, launching = false, failure = "";
      let retrySnapshot: ReturnType<typeof setTimeout> | undefined;
      let painting: Promise<void> | undefined, outputs: { sequence: number; data: string }[] = [];
      let outputSize = 0, resync = false, changingControl = false;
      let sessionOptions = "", autoAttach = !state.session && !state.closedSessions?.length;
      let attaching = Promise.resolve();
      const tabVisible = (s: SessionView) => (!s.command || state.tabs?.includes(s.id)) && !state.closedSessions?.includes(s.id);
      const uncertain = new Set<string>();
      const restored = new Set<string>();
      const canType = () => !stopped && !!session && connected && streamReady && session.state === "running" &&
        session.owner === owner && !uncertain.has(session.id);
      async function setRimeControl(enabled: boolean) {
        const id = state.session;
        if (!id || changingControl) return;
        changingControl = true;
        rimeToggle.checked = enabled;
        draw();
        try {
          await inputBuffer.flush();
          if (!connected || !streamReady || state.session !== id) return;
          await api("configure", { id, agentInput: enabled }, "POST");
          await update();
        } finally { changingControl = false; draw(); resize(); if (!enabled && canType()) term.focus(); }
      }
      const rimeControl = el("label", "switch term-rime-control", "Let Rime control");
      const rimeToggle = el("input");
      rimeToggle.type = "checkbox";
      rimeToggle.onchange = () => { void setRimeControl(rimeToggle.checked).catch(e => toast(e.message, undefined, true)); };
      rimeControl.prepend(rimeToggle);
      const take = button("Take control", async () => {
        const id = state.session;
        if (!id) return;
        await update();
        if (!connected || !streamReady || state.session !== id) return;
        await api("control", { id, takeover: true }, "POST");
        uncertain.delete(id);
        await update(); resize(); term.focus();
      });
      take.className = "term-control";
      const restart = button("Resume session", async () => {
        const id = state.session;
        if (id) await launch(undefined, id);
      });
      restart.className = "term-control";
      footer.append(rimeControl, take, restart);
      const keys = el("div", "term-keys");
      let showKeys = matchMedia("(pointer: coarse)").matches;
      for (const [label, data, direction] of [["Esc", "\x1b"], ["Tab", "\t"], ["Left", "\x1b[D", "180deg"],
        ["Down", "\x1b[B", "90deg"], ["Up", "\x1b[A", "-90deg"], ["Right", "\x1b[C", "0deg"], ["Ctrl-C", "\x03"], ["Enter", "\r"]] as const) {
        const key = button(label, () => send(data));
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
        const writable = canType() && !changingControl;
        term.options.disableStdin = !writable;
        empty.hidden = !!session || !connected;
        screen.hidden = !session;

        newButton.disabled = launching;
        empty.querySelectorAll<HTMLButtonElement>("button").forEach(b => { b.disabled = launching; });
        rimeControl.hidden = session?.state !== "running";
        if (!changingControl) rimeToggle.checked = !!session?.agentInput;
        rimeToggle.disabled = !connected || !streamReady || changingControl;
        take.hidden = session?.state !== "running" || canType();
        take.disabled = !connected || !streamReady || changingControl;
        take.textContent = session && uncertain.has(session.id) ? "Review & take control" : "Take control";
        restart.hidden = !session || !!session.command || session.state === "running";
        restart.disabled = !connected || launching;
        keys.hidden = !showKeys || !session || session.state !== "running";
        keys.querySelectorAll<HTMLButtonElement>("button").forEach(b => { b.disabled = !writable; });
        const text = failure ? failure : !connected || !streamReady ? "Reconnecting…" : !session ? "Ready" :
          session.state !== "running" ? terminalExitLabel(session) : changingControl ? "Saving…" :
          uncertain.has(session.id) ? "Input unconfirmed · review the screen" :
          writable ? session.agentInput ? "Shared with Rime" : "You’re in control" : session.owner ? "Viewing · controlled elsewhere" : "Viewing only";
        if (status.textContent !== text) status.textContent = text;
        status.dataset.state = !connected || !streamReady || (session && uncertain.has(session.id)) ? "attention" : writable ? "active" : "idle";
        status.title = session ? `${names[session.kind]} · ${session.agentInput ? "You and Rime can both type in this session" : "Rime input is off; you can keep typing"}` : "";
      }
      let resizeTimer: ReturnType<typeof setTimeout> | undefined, resizing = false, lastSize = "";
      const resize = () => {
        if (!canType() || !screen.clientWidth || !screen.clientHeight) return;
        const size = fit.proposeDimensions();
        if (size) term.resize(Math.max(20, Math.min(400, size.cols)), Math.max(5, Math.min(150, size.rows)));
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => void sendSize(), 60);
      };
      async function sendSize() {
        if (resizing || !canType()) return;
        const id = state.session, cols = term.cols, rows = term.rows, size = `${id}:${cols}:${rows}`;
        if (lastSize === size) return;
        resizing = true;
        try { await api("resize", { id, cols, rows }, "POST"); lastSize = size; }
        catch { lastSize = ""; }
        finally { resizing = false; }
        if (canType() && (term.cols !== cols || term.rows !== rows)) resize();
      }
      function sessionList() {
        const visible = list.filter(tabVisible);
        const signature = JSON.stringify(visible.map(s => [s.id, s.title, s.state]));
        if (signature !== sessionOptions) {
          sessionOptions = signature;
          sessions.replaceChildren();
          for (const s of visible) {
            const row = el("div", "term-tab");
            row.setAttribute("role", "presentation");
            const tab = button(s.title === s.kind ? names[s.kind] : s.title, () => attach(s.id));
            tab.className = "term-tab-label";
            tab.dataset.session = s.id;
            tab.id = `terminal-tab-${w.i}-${s.id}`;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-controls", screen.id);
            tab.setAttribute("aria-keyshortcuts", "Delete");
            tab.title = tab.textContent ?? "";
            const close = toolButton("close", `Close ${tab.textContent} tab`, () => attach(s.id, true));
            close.classList.add("term-tab-close");
            close.title = s.state === "running" ? "Close tab · session keeps running" : "Close tab";
            row.append(tab, close);
            sessions.append(row);
          }
        }
        screen.removeAttribute("aria-labelledby");
        const tabs = [...sessions.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
        for (const tab of tabs) {
          const selected = tab.dataset.session === state.session;
          tab.setAttribute("aria-selected", String(selected));
          const row = tab.parentElement;
          if (!row) continue;
          row.dataset.active = String(selected);
          tab.tabIndex = selected || (!state.session && tab === tabs[0]) ? 0 : -1;
          if (selected) {
            screen.setAttribute("aria-labelledby", tab.id);
            if (row.offsetLeft < sessions.scrollLeft || row.offsetLeft + row.offsetWidth > sessions.scrollLeft + sessions.clientWidth)
              sessions.scrollLeft = row.offsetLeft;
          }
        }
      }
      sessions.onkeydown = e => {
        if (!(e.target instanceof HTMLElement) || e.target.getAttribute("role") !== "tab" || !e.target.dataset.session) return;
        if (e.key === "Delete") {
          e.preventDefault();
          void attach(e.target.dataset.session, true).catch(error => toast(error.message, undefined, true));
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
      function drainOutput() {
        if (stopped || updating || painting) return;
        if (resync) { void update(); return; }
        const chunks = outputs;
        outputs = []; outputSize = 0;
        let next = sequence;
        const text: string[] = [];
        for (const chunk of chunks) {
          if (next !== undefined && chunk.sequence <= next) continue;
          if (next === undefined || chunk.sequence !== next + 1) { resync = true; void update(); return; }
          next = chunk.sequence;
          text.push(chunk.data);
        }
        if (!text.length) return;
        painting = new Promise<void>(resolve => term.write(text.join(""), resolve)).then(() => {
          sequence = next;
        }).finally(() => { painting = undefined; drainOutput(); });
      }
      function update(): Promise<void> {
        if (updating) return updating;
        if (stopped) return Promise.resolve();
        clearTimeout(retrySnapshot);
        updating = (async () => {
          try {
            await painting;
            resync = false;
            const next: SessionView[] = await api("sessions", { project: state.project });
            if (stopped) return;
            list = next;
            const ids = new Set(list.map(s => s.id));
            const stale = state.tabs?.some(id => !ids.has(id)) || state.closedSessions?.some(id => !ids.has(id));
            if (stale) {
              state.tabs = state.tabs?.filter(id => ids.has(id)); state.closedSessions = state.closedSessions?.filter(id => ids.has(id));
              await remember();
            }
            if (state.session && !list.some(s => s.id === state.session && tabVisible(s))) {
              state.session = undefined; session = undefined; sequence = undefined;
              outputs = []; outputSize = 0; term.reset(); autoAttach = true;
              await remember();
            }
            const visible = list.filter(tabVisible);
            if (autoAttach && visible.length) {
              autoAttach = false;
              state.session = (visible.find(s => s.state === "running") ?? visible[0])?.id;
              await remember();
            }
            sessionList();
            if (state.session) {
              const id = state.session;
              const saved = list.find(s => s.id === id);
              if (saved && terminalNeedsRestore(saved) && !restored.has(id)) {
                restored.add(id);
                await api("restart", { id }, "POST").catch(e => toast(e.message, undefined, true));
              }
              const result = await api<ReturnType<typeof readSession>>("sessions", { id, ...(sequence === undefined ? {} : { after: sequence }) });
              if (stopped || state.session !== id) return;
              session = result.session;
              screen.hidden = false;
              if (result.session.cols !== term.cols || result.session.rows !== term.rows) term.resize(result.session.cols, result.session.rows);
              if (result.reset) term.reset();
              if (result.data) await new Promise<void>(resolve => term.write(result.data, resolve));
              sequence = result.session.sequence;
              if (session.state === "running" && !session.owner && !uncertain.has(id))
                session = await api<SessionView>("control", { id }, "POST").catch(e => { if (e.status === 409) return session as SessionView; throw e; });
            }
            connected = true;
            failure = "";
          } catch (e) {
            connected = false;
            // A dead session, a refused route or a vanished desktop will not fix itself in 3 s: say why, retry slowly.
            failure = [401, 403, 404].includes((e as { status?: number }).status ?? 0) ? (e as Error).message : "";
            if (!stopped) retrySnapshot = setTimeout(() => void update(), failure ? 30000 : 3000);
          } finally {
            if (!stopped) { draw(); resize(); }
          }
        })().finally(() => { updating = undefined; if (connected) drainOutput(); });
        return updating;
      }
      function attach(id: string, close = false): Promise<void> {
        attaching = attaching.catch(() => {}).then(async () => {
          await inputBuffer.flush();
          await updating;
          await painting;
          if (stopped || (!close && state.session === id && session)) return;
          const visible = list.filter(tabVisible);
          const at = visible.findIndex(s => s.id === id);
          const next = close ? (state.session === id ? (visible[at + 1] ?? visible[at - 1])?.id : state.session) : id;
          const closed = new Set(state.closedSessions);
          if (close) closed.add(id); else closed.delete(id);
          const tabs = new Set(state.tabs);
          if (close) tabs.delete(id); else tabs.add(id);
          const value = { ...state, session: next, tabs: [...tabs], closedSessions: [...closed] };
          await api("view", { id: w.i, value }, "POST");
          autoAttach = false;
          const switched = state.session !== next || !session;
          state = value;
          if (switched) {
            session = undefined;
            sequence = undefined;
            outputs = []; outputSize = 0; lastSize = "";
            term.reset();
          }
          await update();
          if (close) {
            (sessions.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? newButton).focus();
            if (list.find(s => s.id === id)?.state === "running")
              toast("Tab closed. Session keeps running.", { label: "Reopen", fn: () => { void attach(id).catch(error => toast(error.message, undefined, true)); } });
          }
        });
        return attaching;
      }
      async function launch(options?: Record<string, unknown>, previous?: string) {
        if (launching) return;
        launching = true;
        draw();
        try {
          const s: SessionView = previous ? await api("restart", { id: previous }, "POST") :
            await api("sessions", { project: state.project, kind: "shell", mode: "human", cols: term.cols, rows: term.rows, ...options }, "POST");
          await attach(s.id);
          await api("control", { id: s.id, takeover: true }, "POST");
          await update();
          resize();
          term.focus();
        } finally {
          launching = false;
          if (!stopped) draw();
        }
      }
      const inputBuffer = new TerminalInput(async (id, data, binary) => {
        if (stopped || state.session !== id || !canType()) return;
        await api("input", { id, data, binary }, "POST");
      }, (id, error) => {
        uncertain.add(id);
        if (!stopped) { draw(); toast((error as Error).message, undefined, true); }
      });
      const send = (data: string, binary = false) => {
        if (state.session && !changingControl && canType()) inputBuffer.send(state.session, data, binary);
      };
      const listener = term.onData(data => void send(data));
      const binaryListener = term.onBinary(data => send(data, true));
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
        d.onclose = () => { d.remove(); if (canType()) term.focus(); };
      }

      const findBar = el("div", "term-find");
      findBar.hidden = true;
      const query = input("Find in terminal"), result = el("span", "term-find-result");
      result.setAttribute("role", "status");
      const find = (previous = false) => {
        const found = !query.value || (previous ? search.findPrevious(query.value) : search.findNext(query.value));
        result.textContent = found ? "" : "No match";
      };
      const closeFind = () => { findBar.hidden = true; search.clearDecorations(); term.focus(); };
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
      term.attachCustomKeyEventHandler(e => {
        // Keep Ctrl+F available to shells and interactive terminal applications.
        if ((e.metaKey || (e.ctrlKey && e.shiftKey)) && e.key.toLowerCase() === "f") {
          if (e.type === "keydown") { e.preventDefault(); openFind(); }
          return false;
        }
        if ((e.metaKey || (e.ctrlKey && e.shiftKey)) && e.key.toLowerCase() === "c" && term.hasSelection()) {
          if (e.type === "keydown") { e.preventDefault(); void navigator.clipboard.writeText(term.getSelection()).catch(err => toast(err.message, undefined, true)); }
          return false;
        }
        if ((e.metaKey || (e.ctrlKey && e.shiftKey)) && ["+", "=", "-", "0"].includes(e.key)) {
          if (e.type === "keydown") {
            e.preventDefault();
            term.options.fontSize = e.key === "0" ? 13 : Math.max(9, Math.min(28, (term.options.fontSize ?? 13) + (e.key === "-" ? -1 : 1)));
            resize();
          }
          return false;
        }
        return true;
      });
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
        action("Find in terminal…", openFind, !session);
        action("Copy selection", () => navigator.clipboard.writeText(term.getSelection()), !term.hasSelection());
        action("Paste", async () => { term.paste(await navigator.clipboard.readText()); term.focus(); }, !canType());
        action("Clear scrollback", () => term.clear(), !session);
        action(term.options.screenReaderMode ? "Disable screen reader support" : "Enable screen reader support", () => {
          term.options.screenReaderMode = !term.options.screenReaderMode;
          localStorage.setItem("rimeward-terminal-accessibility", String(term.options.screenReaderMode));
        });
        action(showKeys ? "Hide extra keys" : "Show extra keys", () => { showKeys = !showKeys; draw(); });
        action("Task manager…", taskManager);
        if (session) {
          const target = session;
          menu.append(el("hr"));
          action("Rename session…", async () => {
            const title = await askText("Session name");
            if (title?.trim()) { await api("configure", { id: target.id, title }, "POST"); await update(); }
          });
          if (target.state === "running") {
            action("Interrupt process", () => api("interrupt", { id: target.id }, "POST"), !canType());
            menu.append(el("hr"));
            action("End session…", async () => {
              if (await confirmAction(`End ${target.title}? The process will stop. Its saved screen stays available.`)) {
                await api("sessions", { id: target.id }, "DELETE");
                await update();
              }
            }, !connected, true);
          } else if (!target.command) action("Delete session…", () => deleteSaved(target), !connected, true);
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
              await refresh(); await update();
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
              await remember();
            }
            await refresh(); await update();
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
        await remember(); await update();
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
      const ro = new ResizeObserver(resize);
      ro.observe(screen);
      cleanup.push(
        terminalEvents(w.device ?? readPages().find(p => p.id === pageOfCard(w.i))?.device ?? "local", w.i, event => {
          if (stopped) return;
          if (!event) { streamReady = false; inputBuffer.clear(); draw(); return; }
          if (event.type === "reset") { streamReady = true; resync = true; void update(); return; }
          if (event.type === "session") {
            if (!event.data) { resync = true; void update(); return; }
            const next = event.data as SessionView;
            if (next.project !== state.project) return;
            const at = list.findIndex(s => s.id === next.id);
            if (at < 0) list.unshift(next); else list[at] = next;
            sessionList();
            if (autoAttach && !launching && !state.session && next.state === "running" && tabVisible(next))
              void attach(next.id).catch(error => toast(error.message, undefined, true));
            if (state.session === next.id) {
              session = next;
              if (!canType()) {
                inputBuffer.clear();
                term.resize(next.cols, next.rows);
              }
              draw();
            }
            if (updating) resync = true;
            return;
          }
          if (event.type !== "output" || event.id !== state.session) return;
          const chunk = event.data as { sequence: number; data: string };
          if (outputSize + chunk.data.length > 1024 * 1024) {
            outputs = []; outputSize = 0; resync = true;
          } else { outputs.push(chunk); outputSize += chunk.data.length; }
          drainOutput();
        }),
        () => {
          taskDialog?.close();
          if (menu.matches(":popover-open")) menu.hidePopover();
          clearTimeout(resizeTimer); clearTimeout(retrySnapshot); inputBuffer.clear();
          ro.disconnect(); listener.dispose(); binaryListener.dispose(); term.dispose();
        },
      );
      await update();
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
