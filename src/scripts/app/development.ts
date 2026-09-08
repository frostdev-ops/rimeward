import { expandedDesktopWard, restoreExpandedWard } from "./desktop-state.ts";
import type { terminalCapabilities, readSession } from "../../lib/dev/terminals.ts";
import type { gitView } from "../../lib/dev/projects.ts";
import { icon } from "./icon.ts";
import { chooseProject, askText, confirmAction, dialog as workspaceDialog } from "./workspace-dialogs.ts";
import { RENDERERS, body, poll } from "./wards.ts";
import { el, toast } from "./dom.ts";
import { readPages, pageOfCard } from "./pages.ts";
import { CATALOG, type WardInstance } from "../../lib/wards.ts";
import {
  DEV_WARDS,
  terminalExitLabel,
  type Project,
  type SessionView,
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
      signal: action === "input" || (action === "sessions" && method === "GET") ? AbortSignal.timeout(15000) : undefined,
      ...(method === "GET"
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...data, owner }),
          }),
    },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "Desktop unavailable.");
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
  if (!b || states.has(w.i)) return;
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
      stopped = true;
      for (const stop of cleanup) stop();
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
      let connected = false, streamReady = false, launching = false;
      let retrySnapshot: ReturnType<typeof setTimeout> | undefined;
      let painting: Promise<void> | undefined, outputs: { sequence: number; data: string }[] = [];
      let outputSize = 0, resync = false, released = false;
      let sessionOptions = "", autoAttach = !state.session && !state.closedSessions?.length;
      let attaching = Promise.resolve();
      const tabVisible = (s: SessionView) => (!s.command || state.tabs?.includes(s.id)) && !state.closedSessions?.includes(s.id);
      const uncertain = new Set<string>();
      const canType = () => !stopped && !!session && connected && streamReady && session.state === "running" &&
        session.owner === owner && !uncertain.has(session.id);
      const take = button("Take control", async () => {
        const id = state.session;
        if (!id) return;
        await update(); // Reconcile the screen before acknowledging uncertain input.
        if (!connected || !streamReady || state.session !== id) return;
        await api("control", { id, takeover: true }, "POST");
        released = false;
        uncertain.delete(id);
        await update();
        resize();
        term.focus();
      });
      take.className = "term-control";
      const restart = button("Start again", async () => {
        const id = state.session;
        if (id) await launch(undefined, id);
      });
      restart.className = "term-control";
      footer.append(take, restart);
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
        const writable = canType();
        term.options.disableStdin = !writable;
        empty.hidden = !!session || !connected;
        screen.hidden = !session;

        newButton.disabled = launching;
        empty.querySelectorAll<HTMLButtonElement>("button").forEach(b => { b.disabled = launching; });
        take.hidden = session?.state !== "running" || writable;
        take.disabled = !connected || !streamReady;
        take.textContent = session && uncertain.has(session.id) ? "Review & take control" : "Take control";
        restart.hidden = !session || session.state === "running";
        restart.disabled = !connected || launching;
        keys.hidden = !showKeys || !session || session.state !== "running";
        keys.querySelectorAll<HTMLButtonElement>("button").forEach(b => { b.disabled = !writable; });
        const text = !connected || !streamReady ? "Reconnecting…" : !session ? "Ready" :
          session.state !== "running" ? terminalExitLabel(session) :
          uncertain.has(session.id) ? "Input unconfirmed · review the screen" :
          writable ? "You’re in control" : session.owner ? "Viewing · controlled elsewhere" : "Viewing only";
        if (status.textContent !== text) status.textContent = text;
        status.dataset.state = !connected || !streamReady || (session && uncertain.has(session.id)) ? "attention" : writable ? "active" : "idle";
        status.title = session ? `${names[session.kind]} · Rime input ${session.agentInput ? "enabled" : "off"}${session.kind === "shell" ? "" : ` · ${session.mode === "yolo" ? "Unrestricted" : "Standard"} CLI permissions`}` : "";
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
            const tab = button(`${s.title === s.kind ? names[s.kind] : s.title}${s.state === "running" ? "" : ` · ${s.state}`}`, () => attach(s.id));
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
              const result = await api<ReturnType<typeof readSession>>("sessions", { id, ...(sequence === undefined ? {} : { after: sequence }) });
              if (stopped || state.session !== id) return;
              session = result.session;
              screen.hidden = false;
              if (result.session.cols !== term.cols || result.session.rows !== term.rows) term.resize(result.session.cols, result.session.rows);
              if (result.reset) term.reset();
              if (result.data) await new Promise<void>(resolve => term.write(result.data, resolve));
              sequence = result.session.sequence;
              if (session.state === "running" && !session.owner && !session.agentInput && !released && !uncertain.has(id))
                session = await api<SessionView>("control", { id }, "POST");
            }
            connected = true;
          } catch {
            connected = false;
            if (!stopped) retrySnapshot = setTimeout(() => void update(), 3000);
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
            outputs = []; outputSize = 0; released = false; lastSize = "";
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
          // This action created the session for this human; make it ready to type.
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
        if (state.session && canType()) inputBuffer.send(state.session, data, binary);
      };
      const listener = term.onData(data => void send(data));
      const binaryListener = term.onBinary(data => send(data, true));
      const start = button("Open terminal", () => launch());
      start.className = "btn-primary";
      const agentChoices = el("div", "term-agent-choices");
      agentChoices.append(button("Codex", () => sessionDialog(undefined, "codex")), button("Claude Code", () => sessionDialog(undefined, "claude")));
      const mark = el("span", "dev-empty-icon"); mark.append(icon("code"));
      empty.append(mark, el("h3", undefined, "A terminal for your project"),
        el("p", undefined, "Open a shell, or work with a terminal agent."), start, agentChoices);

      function sessionDialog(existing?: SessionView, initial: TerminalKind = "shell") {
        const { d, form, actions, error, submit } = workspaceDialog(existing ? "Session settings" : "New terminal session");
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
        const mode = select("Permission mode", []);
        mode.add(new Option("Standard — keep CLI permission prompts", "human"));
        mode.add(new Option("Unrestricted — bypass CLI permissions", "yolo"));
        mode.value = existing?.nextMode === "yolo" ? "yolo" : "human";
        const agentInput = el("input"); agentInput.type = "checkbox";
        agentInput.checked = existing?.agentInput ?? false;
        agentInput.setAttribute("aria-label", "Allow Rime to type");
        const agentField = field("Allow Rime to type", agentInput);
        const task = el("textarea", "input");
        task.rows = 3; task.maxLength = 8000;
        task.placeholder = "What would you like the agent to work on?";
        const taskField = field("Initial task (optional)", task);
        const options = el("details", "term-launch-options");
        const shellField = field("Shell", shell);
        const permissionField = field("CLI permissions", mode);
        options.append(el("summary", undefined, "More options"), shellField, permissionField, agentField);
        const modeHelp = el("p", "term-help");
        const describeMode = () => {
          modeHelp.textContent = "Rime input includes answering CLI prompts and changes immediately. Taking control pauses Rime; release control to let it type. " +
            (program.value === "shell" && !existing || existing?.kind === "shell" ? "Shell commands run with your desktop account’s permissions." :
            mode.value === "human" ? "The CLI keeps its own permission prompts." : "Unrestricted disables the CLI’s approval and sandbox protections on its next start.");
        };
        mode.onchange = describeMode;
        describeMode();
        options.append(modeHelp);
        const availability = el("p", "term-help");
        const syncProgram = () => {
          const kind = program.value as TerminalKind;
          taskField.hidden = kind === "shell";
          shellField.hidden = kind !== "shell";
          permissionField.hidden = kind === "shell";
          describeMode();
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
        if (existing) {
          options.open = true;
          shellField.hidden = true;
          permissionField.hidden = existing.kind === "shell";
          actions.before(el("p", "term-help", `${existing.title} · ${names[existing.kind]}. CLI permission changes apply on the next start.`), options);
          submit.textContent = "Save settings";
        } else {
          actions.before(field("Program", program), taskField, availability, options);
          program.onchange = syncProgram;
          syncProgram();
        }
        form.onsubmit = async e => {
          e.preventDefault();
          submit.disabled = true;
          error.hidden = true;
          try {
            if (existing) {
              await api("configure", { id: existing.id, agentInput: agentInput.checked, ...(existing.kind !== "shell" ? { mode: mode.value } : {}) }, "POST");
              await update();
            } else {
              const kind = program.value as TerminalKind;
              await launch({ kind, mode: kind === "shell" ? "human" : mode.value, agentInput: agentInput.checked, ...(kind === "shell" ? { shell: shell.value } : { task: task.value }),
                title: `${names[kind]} ${list.filter(s => s.kind === kind && !s.command).length + 1}` });
            }
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
        const commands = list.filter(s => s.command && !tabVisible(s));
        if (commands.length) action("Rime commands…", () => {
          const { d, form, error, actions, submit } = workspaceDialog("Rime commands");
          const choices = select("Command", []);
          for (const s of commands) choices.add(new Option(`${s.title} · ${s.state}`, s.id));
          actions.before(el("p", "term-help", "Routine commands stay in chat Tasks. Open a terminal view here when you need it."), choices);
          submit.textContent = "Open in terminal";
          form.onsubmit = async e => {
            e.preventDefault(); submit.disabled = true; error.hidden = true;
            try { await attach(choices.value); d.close(); }
            catch (e) { error.textContent = (e as Error).message; error.hidden = false; }
            finally { submit.disabled = false; }
          };
          d.onclose = () => d.remove();
        });
        const closed = list.filter(s => !s.command && state.closedSessions?.includes(s.id));
        if (closed.length) {
          menu.append(el("hr"));
          for (const s of closed) action(`Reopen ${s.title}${s.state === "running" ? "" : ` · ${s.state}`}`, () => attach(s.id));
        }
        if (session) {
          const target = session;
          menu.append(el("hr"));
          action("Session settings…", () => sessionDialog(target));
          action("Rename session…", async () => {
            const title = await askText("Session name");
            if (title?.trim()) { await api("configure", { id: target.id, title }, "POST"); await update(); }
          });
          if (target.state === "running") {
            action(target.agentInput ? "Let Rime type" : "Release input control", async () => {
              await inputBuffer.flush();
              released = true;
              await api("release", { id: target.id }, "POST"); await update();
            }, !canType());
            action("Interrupt process", () => api("interrupt", { id: target.id }, "POST"), !canType());
            menu.append(el("hr"));
            action("End session…", async () => {
              if (await confirmAction(`End ${target.title}? The process will stop. Its saved screen stays available.`)) {
                await api("sessions", { id: target.id }, "DELETE");
                await update();
              }
            }, !connected, true);
          }
        }
      });
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
    content.textContent = (err as Error).message;
    cleanup.push(poll(() => { states.get(w.i)?.stop(); void mount(w); }, 5000));
  }
}
for (const type of DEV_WARDS)
  RENDERERS[type] = {
    render: mount,
    stop(id) {
      states.get(id)?.stop();
    },
  };
