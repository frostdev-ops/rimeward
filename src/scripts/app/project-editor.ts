import { readDesktopCheckpoint, saveDesktopState } from "./desktop-state.ts";
import type { searchFiles, bufferCopies } from "../../lib/dev/projects.ts";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from "@codemirror/view";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { LanguageDescription, indentUnit, syntaxHighlighting, foldGutter, indentOnInput, defaultHighlightStyle, bracketMatching, foldKeymap } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { languages } from "@codemirror/language-data";
import { indentWithTab, history, historyField, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { openSearchPanel, gotoLine, highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { MergeView } from "@codemirror/merge";
import { icon } from "./icon.ts";
import { el, toast } from "./dom.ts";
import { askText, dialog } from "./workspace-dialogs.ts";
import { poll } from "./wards.ts";
import type { BufferView, Project } from "../../lib/dev/types.ts";

type Api = <T = unknown>(action: string, data?: Record<string, unknown>, method?: string) => Promise<T>;
const run = (fn: () => unknown) => void Promise.resolve().then(fn).catch(e => toast(e.message, undefined, true));
const folds = foldGutter({ markerDOM: open => {
  const marker = el("span", "editor-fold"); marker.dataset.open = String(open);
  marker.append(icon("right")); return marker;
} });
// CodeMirror's standard setup, with one themed fold gutter in place of its default.
const editorSetup = [lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), folds,
  drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true), indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }), bracketMatching(), closeBrackets(), autocompletion(),
  rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap])];
function themedEditorChrome(root: HTMLElement) {
  // These CodeMirror controls have no icon-rendering option. Keep their native
  // behavior and route only their decoration through Rimeward's icon contract.
  const paint = () => {
    for (const marker of root.querySelectorAll<HTMLElement>(".cm-lint-marker"))
      if (!marker.querySelector("[data-icon]")) marker.append(icon(marker.classList.contains("cm-lint-marker-error") ? "close" : marker.classList.contains("cm-lint-marker-warning") ? "warning" : "info"));
    for (const close of root.querySelectorAll<HTMLButtonElement>('.cm-search button[name="close"]'))
      if (!close.querySelector("[data-icon]")) close.replaceChildren(icon("close"));
  };
  const observer = new MutationObserver(paint); observer.observe(root, { childList: true, subtree: true }); paint();
  return () => observer.disconnect();
}
function action(label: string, fn: () => unknown, glyph?: string) {
  const b = el("button", glyph ? "editor-tool" : "editor-action", glyph ? undefined : label);
  b.type = "button"; b.title = label; b.setAttribute("aria-label", label);
  if (glyph) b.append(icon(glyph));
  b.onclick = () => run(fn);
  return b;
}
function actions(anchor: HTMLButtonElement, items: () => [string, () => unknown, boolean?][]) {
  const menu = el("div", "term-menu editor-menu");
  menu.popover = "auto"; menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", anchor.title);
  anchor.setAttribute("aria-haspopup", "menu"); anchor.setAttribute("aria-expanded", "false");
  anchor.after(menu);
  anchor.onclick = () => {
    menu.replaceChildren();
    for (const [label, fn, disabled] of items()) {
      const b = action(label, () => { menu.hidePopover(); return fn(); });
      b.className = "term-menu-item"; b.setAttribute("role", "menuitem"); b.disabled = !!disabled; menu.append(b);
    }
    menu.togglePopover();
  };
  menu.addEventListener("toggle", e => {
    const open = (e as ToggleEvent).newState === "open";
    anchor.setAttribute("aria-expanded", String(open));
    if (!open) return;
    const a = anchor.getBoundingClientRect(), b = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(a.right - b.width, innerWidth - b.width - 8))}px`;
    menu.style.top = `${a.bottom + b.height < innerHeight - 8 ? a.bottom + 4 : Math.max(8, a.top - b.height - 4)}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  });
  menu.onkeydown = e => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const all = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")], at = all.indexOf(document.activeElement as HTMLButtonElement);
    all[e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
  };
  return () => { if (menu.matches(":popover-open")) menu.hidePopover(); menu.remove(); };
}

/** The same explorer works inside Editor or as a separate Project files ward. */
export function fileExplorer(host: HTMLElement, api: Api, project: string, open: (path: string, line?: number) => unknown,
  rename: (from: string, to: string) => Promise<void> = async (from, to) => { await api("rename", { project, path: from, to }, "POST"); }) {
  host.classList.add("editor-explorer");
  const heading = el("div", "editor-explorer-heading"), list = el("div", "editor-file-list"), search = el("input", "input editor-file-search");
  search.placeholder = "Find a file or text…"; search.setAttribute("aria-label", "Search project files");
  list.setAttribute("aria-label", "Project files");
  const add = action("File actions", () => {}, "plus");
  heading.append(el("strong", undefined, "Files"), add); host.append(heading, search, list);
  let selected = "", selectedDirectory = false, stopped = false, request = 0;
  const expanded = new Set<string>(), folders = new Map<string, HTMLElement>([["", list]]), signatures = new Map<string, string>();
  const choose = (file: string, directory: boolean) => {
    selected = file; selectedDirectory = directory;
    for (const b of host.querySelectorAll<HTMLElement>("[data-file]")) b.dataset.active = String(b.dataset.file === file);
  };
  const load = async (dir: string) => {
    const target = folders.get(dir); if (!target) return;
    const entries: {name: string; path: string; directory: boolean}[] = await api("files", { project, path: dir });
    if (stopped || search.value) return;
    const signature = JSON.stringify(entries);
    if (signatures.get(dir) === signature) return;
    signatures.set(dir, signature);
    const focused = target.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.file : undefined;
    target.replaceChildren();
    for (const e of entries) {
      if (e.directory) {
        const details = el("details", "editor-directory"), label = el("summary", "editor-file"), children = el("div");
        const arrow = el("span", "editor-folder-arrow"); arrow.append(icon("right"));
        label.append(arrow, icon("folder"), el("span", "editor-file-name", e.name));
        label.title = e.path; label.dataset.file = e.path; label.dataset.active = String(selected === e.path);
        label.onclick = () => choose(e.path, true);
        folders.set(e.path, children); signatures.delete(e.path);
        details.append(label, children); details.open = expanded.has(e.path);
        details.ontoggle = () => { if (details.open) { expanded.add(e.path); run(() => load(e.path)); } else expanded.delete(e.path); };
        target.append(details);
        if (details.open) await load(e.path);
      } else {
        const b = action(e.name, () => { choose(e.path, false); return open(e.path); });
        b.className = "editor-file"; b.title = e.path; b.dataset.file = e.path; b.dataset.active = String(selected === e.path);
        b.replaceChildren(icon("page"), el("span", "editor-file-name", e.name)); target.append(b);
      }
    }
    if (!entries.length) target.append(el("p", "editor-no-files", dir ? "Empty folder" : "No files yet. Use + to create one."));
    if (focused) [...target.querySelectorAll<HTMLElement>("[data-file]")].find(b => b.dataset.file === focused)?.focus();
  };
  const refresh = async () => {
    if (search.value || stopped) return;
    await load("");
    for (const dir of expanded) if (folders.get(dir)?.isConnected) await load(dir);
  };
  const create = async (directory: boolean) => {
    const parent = selectedDirectory ? selected : selected.includes("/") ? selected.slice(0, selected.lastIndexOf("/")) : "";
    const file = await askText(directory ? "New folder" : "New file", parent ? `${parent}/` : "");
    if (!file) return;
    await api("files", { project, path: file, directory }, "POST");
    search.value = ""; signatures.clear(); await refresh();
    if (!directory) await open(file);
  };
  const stopMenu = actions(add, () => [
    ["New file…", () => create(false)], ["New folder…", () => create(true)],
    ["Rename…", async () => { const from = selected, to = await askText(`Rename ${from}`, from); if (to && to !== from) { await rename(from, to); search.value = ""; signatures.clear(); await refresh(); } }, !selected],
    ["Refresh files", async () => { search.value = ""; signatures.clear(); await refresh(); }],
  ]);
  let searchTimer: ReturnType<typeof setTimeout>;
  search.oninput = () => {
    clearTimeout(searchTimer); const id = ++request, q = search.value;
    searchTimer = setTimeout(() => run(async () => {
      if (!q.trim()) { signatures.clear(); return refresh(); }
      const rows = await api<Awaited<ReturnType<typeof searchFiles>>>("search", { project, q });
      if (stopped || id !== request) return;
      list.replaceChildren();
      for (const r of rows) {
        const b = action(`${r.path}:${r.line}`, () => open(r.path, r.line));
        b.className = "editor-search-result"; b.append(el("small", undefined, r.text)); list.append(b);
      }
      if (!rows.length) list.append(el("p", "editor-no-files", "No matching files or text."));
    }), 250);
  };
  const stopPoll = poll(() => refresh().catch(e => {
    if (!list.childElementCount) { const retry = action("Retry loading files", refresh); list.append(el("p", "editor-no-files", e.message), retry); }
  }), 5000, () => !host.getClientRects().length);
  return { refresh, select: (path: string) => choose(path, false), focus: () => search.focus(), stop: () => { stopped = true; clearTimeout(searchTimer); stopPoll(); stopMenu(); } };
}

export function projectEditor(host: HTMLElement, options: {
  api: Api; owner: string; ward: string; project: Project; state: { tabs?: string[]; active?: string }; remember: () => Promise<unknown>;
  changeProject: () => unknown; expand: () => void; page?: string;
}) {
  const { api, owner, project, state, remember } = options;
  const recoveryKey = `editor:${options.ward}:${project.id}`;
  const recovered = readDesktopCheckpoint<{ files: Record<string, { state: { doc?: string; [key: string]: unknown }; top: number; left: number }>; hidden: boolean; wrap: boolean; problems: boolean }>(recoveryKey);
  const toolbar = el("div", "editor-toolbar"), shell = el("div", "editor-shell"), side = el("aside"), main = el("div", "editor-main");
  const tabs = el("div", "editor-tabs"), breadcrumb = el("div", "editor-breadcrumb"), editorHost = el("div", "dev-editor"), footer = el("div", "editor-statusbar");
  const empty = el("div", "editor-welcome"), notice = el("div", "editor-notice"), message = el("span"), problems = el("section", "editor-problems");
  const status = el("span", "editor-save-status"), cursor = el("span", "editor-cursor"), languageLabel = el("span", "editor-language"), metadata = el("span", "editor-metadata");
  tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Open files"); tabs.setAttribute("aria-orientation", "horizontal");
  side.setAttribute("aria-label", "File explorer"); main.setAttribute("aria-label", "Code editor");
  notice.hidden = true; message.setAttribute("role", "status");
  const toggle = action("Toggle file explorer", () => { host.classList.toggle("editor-files-hidden"); toggle.setAttribute("aria-expanded", String(!host.classList.contains("editor-files-hidden"))); }, "folders");
  toggle.setAttribute("aria-expanded", "true");
  const projectName = action(project.name, () => runExclusive(async () => { await flush(); return options.changeProject(); }));
  projectName.className = "editor-project"; projectName.title = `Change project · ${project.root}`;
  const quick = action("Quick open (⌘/Ctrl P)", () => quickOpen(), "search"), save = action("Save file (⌘/Ctrl S)", () => saveFile(), "save");
  const more = action("Editor actions", () => {}, "more"), expand = action("Expand editor", options.expand, "resize"); expand.classList.add("editor-expand");
  toolbar.append(toggle, projectName, quick, save, more, expand);
  const take = action("Take over", () => takeOver()), compare = action("Compare changes", () => compareFile());
  notice.append(message, take, compare);
  const problemToggle = action("Problems", () => { problems.hidden = !problems.hidden; problemToggle.setAttribute("aria-expanded", String(!problems.hidden)); });
  problemToggle.className = "editor-problem-count"; problemToggle.setAttribute("aria-expanded", "false");
  problems.hidden = true; problems.setAttribute("aria-label", "Problems in current file");
  footer.append(problemToggle, status, cursor, metadata, languageLabel);
  const welcomeMark = el("span", "editor-welcome-mark"); welcomeMark.append(icon("code"));
  empty.append(welcomeMark, el("h3", undefined, "Make something here"), el("p", undefined, "Choose a file from the explorer, or find one with quick open."), action("Open a file", () => quickOpen()), el("small", undefined, "⌘/Ctrl P  Quick open   ·   ⌘/Ctrl S  Save"));
  main.append(tabs, breadcrumb, notice, empty, editorHost, problems); shell.append(side, main); host.replaceChildren(toolbar, shell, footer);
  host.classList.add("project-editor");
  let current: BufferView | undefined, pending = false, generation = 0, stopped = false, busy = false, syncing = false, changing = false, uncertain = false;
  let queue = Promise.resolve(), operation = Promise.resolve<unknown>(undefined), recoveryTimer: ReturnType<typeof setTimeout>, lintTimer: ReturnType<typeof setTimeout>;
  let lintGeneration = 0, linting = false, lintLabel = "Open a file to check it", diagnostics: Diagnostic[] = [], wrap = false;
  const language = new Compartment(), editable = new Compartment(), wrapping = new Compartment(), theme = new Compartment();
  const positions = new Map<string, { top: number; left: number }>();
  const fileStates = new Map<string, EditorState>(), dirtyFiles = new Set<string>();
  const canEdit = () => !!current && !current.readonly && !busy && !uncertain && (!current.owner || current.owner === owner);
  const permissions = () => [EditorView.editable.of(canEdit()), EditorState.readOnly.of(!canEdit())];
  const editorTheme = () => [document.documentElement.classList.contains("dark") ? syntaxHighlighting(oneDarkHighlightStyle) : [], EditorView.theme({
    "&": { color: "var(--color-ink)", backgroundColor: "var(--color-surface)" },
    ".cm-content": { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace', fontSize: "13px", lineHeight: "1.65", caretColor: "var(--color-accent-hi)" },
    ".cm-gutters": { backgroundColor: "var(--color-surface)", color: "var(--color-ink-faint)", border: "none", fontSize: "12px" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--color-ink) 4%, transparent)" },
    ".cm-cursor": { borderLeftColor: "var(--color-accent-hi)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--color-accent-hi) 22%, transparent)" },
  }, { dark: document.documentElement.classList.contains("dark") })];
  const extensions = [editorSetup, indentUnit.of("  "), lintGutter(), theme.of(editorTheme()), language.of([]), editable.of(permissions()), wrapping.of([]),
    EditorView.contentAttributes.of({ "aria-label": "File contents" }),
    keymap.of([indentWithTab, { key: "Mod-s", run: () => { run(saveFile); return true; } }, { key: "Mod-p", run: () => { run(quickOpen); return true; } },
      { key: "Mod-Shift-m", run: () => { problemToggle.click(); return true; } }, { key: "Alt-Shift-f", run: () => { run(formatFile); return true; } }]),
    EditorView.updateListener.of(u => {
      if (u.docChanged && !changing && current) {
        pending = true; generation++; dirtyFiles.add(current.path); renderTabs(); refreshStatus(false);
        clearTimeout(recoveryTimer); recoveryTimer = setTimeout(() => run(flush), 300); scheduleLint();
      }
      if (u.selectionSet || u.docChanged) updateCursor();
    }),
  ];
  const editor = new EditorView({ parent: editorHost, extensions });
  const stopChrome = themedEditorChrome(host);
  const explorer = fileExplorer(side, api, project.id, (file, line) => load(file, line), async (from, to) => {
    await runExclusive(async () => {
      await flush();
      await api("rename", { project: project.id, path: from, to }, "POST");
      const renamed = (p: string) => p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p;
      for (const [file, cached] of [...fileStates]) if (renamed(file) !== file) { fileStates.delete(file); fileStates.set(renamed(file), cached); }
      state.tabs = state.tabs?.map(renamed);
      if (current) { current.path = renamed(current.path); state.active = current.path; }
      await remember(); renderTabs(); refreshStatus();
    });
  });
  function updateCursor() {
    const at = editor.state.selection.main.head, line = editor.state.doc.lineAt(at);
    cursor.textContent = current ? `Ln ${line.number}, Col ${at - line.from + 1}` : "";
  }
  let tabSignature = "";
  function renderTabs() {
    const signature = JSON.stringify([state.tabs, current?.path, [...dirtyFiles]]);
    if (signature === tabSignature) return;
    tabSignature = signature;
    const scroll = tabs.scrollLeft;
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.tab : undefined;
    tabs.replaceChildren();
    for (const file of state.tabs ?? []) {
      const tab = el("div", "editor-tab"), b = action(file.split("/").at(-1) ?? file, () => load(file));
      tab.dataset.active = String(current?.path === file);
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(current?.path === file)); b.title = file; b.dataset.tab = file;
      b.tabIndex = current?.path === file ? 0 : -1; b.className = "editor-tab-label";
      b.prepend(icon("page"));
      if (dirtyFiles.has(file)) { const dot = el("span", "editor-dirty", "•"); dot.setAttribute("aria-label", "Unsaved"); b.append(dot); }
      const close = action(`Close ${file}`, () => closeTab(file), "close"); close.classList.add("editor-tab-close");
      tab.append(b, close); tabs.append(tab);
    }
    if (focus) [...tabs.querySelectorAll<HTMLElement>("[data-tab]")].find(b => b.dataset.tab === focus)?.focus();
    tabs.scrollLeft = scroll;
    tabResize.disconnect(); tabResize.observe(tabs);
    for (const tab of tabs.children) tabResize.observe(tab);
  }
  function revealTab() {
    if (stopped) return;
    const tab = tabs.querySelector<HTMLElement>('.editor-tab[data-active="true"]');
    if (!tab) return;
    // Layout coordinates stay stable while the expand dialog scales into view.
    const left = tab.offsetLeft, right = left + tab.offsetWidth;
    if (left < tabs.scrollLeft) tabs.scrollLeft = left;
    else if (right > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = right - tabs.clientWidth;
  }
  const tabResize = new ResizeObserver(revealTab);
  tabResize.observe(tabs);
  tabs.onkeydown = e => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault(); const all = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')], at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = all[e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length]; next?.focus(); next?.click();
  };
  function refreshStatus(reconfigure = true) {
    if (stopped) return;
    const hasFile = !!current; empty.hidden = hasFile; editorHost.hidden = !hasFile; breadcrumb.hidden = !hasFile;
    save.disabled = !canEdit();
    status.textContent = !current ? "" : uncertain ? "Recovery not acknowledged" : pending ? "Keeping recovery…" : current.dirty ? "Unsaved · recovery stored" : "Saved";
    breadcrumb.textContent = current?.path.split("/").join("  /  ") ?? "";
    metadata.textContent = current ? `${current.encoding?.toUpperCase() ?? ""}  ${current.newline === "\r\n" ? "CRLF" : current.newline === "\r" ? "CR" : "LF"}` : "";
    take.hidden = !current || current.readonly || (!uncertain && (!current.owner || current.owner === owner));
    take.textContent = uncertain ? "Review & take over" : "Take over";
    compare.hidden = !current?.conflict && !uncertain;
    notice.hidden = !current || (!current.readonly && !current.conflict && take.hidden);
    message.textContent = uncertain ? "Your text is retained. Review before continuing." : current?.conflict ? "This file changed on disk. Both versions are available." : current?.readonly ? "Read-only file · original encoding and contents are preserved." : "Editing on another device. Take over to make changes here.";
    if (reconfigure) editor.dispatch({ effects: editable.reconfigure(permissions()) }); updateCursor();
  }
  function setText(text: string) {
    if (editor.state.doc.toString() === text) return;
    changing = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, annotations: Transaction.addToHistory.of(false) });
    changing = false; scheduleLint();
  }
  function flush(): Promise<void> {
    clearTimeout(recoveryTimer);
    queue = queue.catch(() => {}).then(async () => {
      if (!pending || !current) return;
      const file = current.path, text = editor.state.doc.toString(), at = generation;
      try {
        const next: BufferView = await api("buffer", { project: project.id, path: file, text, revision: current.revision }, "POST");
        if (current.path !== file) return;
        current = next;
        if (generation === at) pending = false;
        uncertain = false; refreshStatus();
      } catch (e) { uncertain = true; refreshStatus(); throw e; }
    });
    return queue;
  }
  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = operation.catch(() => {}).then(async () => {
      busy = true; refreshStatus();
      try { return await fn(); }
      finally { busy = false; refreshStatus(); }
    });
    operation = next; return next;
  }
  async function saveFile() {
    await runExclusive(async () => {
      await flush(); if (!current) return;
      current = await api<BufferView>("buffer", { project: project.id, path: current.path, revision: current.revision, save: true }, "POST");
      dirtyFiles.delete(current.path); renderTabs();
    });
  }
  async function load(file: string, line?: number) {
    await runExclusive(async () => {
      await flush(); if (stopped) return;
      if (current) {
        fileStates.set(current.path, editor.state);
        positions.set(current.path, { top: editor.scrollDOM.scrollTop, left: editor.scrollDOM.scrollLeft });
      }
      let next: BufferView = await api("buffer", { project: project.id, path: file });
      if (!next.readonly && !next.owner) {
        try { next = await api("buffer", { project: project.id, path: next.path }, "POST"); }
        catch { next = await api("buffer", { project: project.id, path: next.path }); }
      }
      if (stopped) return;
      current = next; pending = false; uncertain = false; lintGeneration++; diagnostics = []; lintLabel = "Checking…";
      state.tabs = [...new Set([...(state.tabs ?? []), next.path])]; state.active = next.path;
      if (next.dirty) dirtyFiles.add(next.path); else dirtyFiles.delete(next.path);
      let cached = fileStates.get(next.path);
      const saved = recovered?.files?.[next.path];
      if (!cached && saved?.state?.doc === next.text) {
        try { cached = EditorState.fromJSON(saved.state, { extensions }, { history: historyField }); positions.set(next.path, saved); }
        catch { /* Disk/recovery text remains the authority if UI history is invalid. */ }
      }
      editor.setState(cached?.doc.toString() === next.text ? cached : EditorState.create({ doc: next.text, extensions }));
      const lang = LanguageDescription.matchFilename(languages, next.path), support = await lang?.load();
      editor.dispatch({ effects: [language.reconfigure(support ?? []), wrapping.reconfigure(wrap ? EditorView.lineWrapping : [])] });
      languageLabel.textContent = lang?.name ?? "Plain text";
      if (line) { const target = editor.state.doc.line(Math.min(Math.max(1, line), editor.state.doc.lines)); editor.dispatch({ selection: { anchor: target.from }, scrollIntoView: true }); }
      renderTabs(); explorer.select(next.path); renderProblems(); scheduleLint(); await remember();
      requestAnimationFrame(() => {
        revealTab();
        const position = positions.get(next.path);
        if (!line && position) editor.scrollDOM.scrollTo(position.left, position.top);
      });
      if (recovered ? recovered.hidden : host.clientWidth < 620) { host.classList.add("editor-files-hidden"); toggle.setAttribute("aria-expanded", "false"); }
    });
    editor.focus();
  }
  async function closeTab(file: string) {
    await runExclusive(async () => {
      await flush(); const wasCurrent = current?.path === file;
      state.tabs = state.tabs?.filter(p => p !== file); fileStates.delete(file);
      if (wasCurrent) { current = undefined; state.active = undefined; pending = false; lintGeneration++; clearTimeout(lintTimer); diagnostics = []; lintLabel = "Open a file to check it"; }
      renderTabs(); renderProblems(); await remember();
      if (dirtyFiles.has(file)) toast("Draft kept on this desktop. Reopen the file to continue.");
    });
    const last = state.tabs?.at(-1);
    if (!current && last) await load(last);
  }
  async function takeOver() {
    await runExclusive(async () => {
      if (!current) return;
      if (pending) {
        await api("copies", { project: project.id, path: current.path, text: editor.state.doc.toString() }, "POST");
        toast("Your previous text is available in Recovery history.");
      }
      current = await api<BufferView>("buffer", { project: project.id, path: current.path, takeover: true }, "POST");
      pending = false; uncertain = false; setText(current.text); renderTabs();
    });
    editor.focus();
  }
  function renderProblems() {
    const count = diagnostics.length;
    problemToggle.textContent = count ? `${count} ${count === 1 ? "problem" : "problems"}` : "Problems";
    problemToggle.dataset.severity = diagnostics.some(d => d.severity === "error") ? "error" : count ? "warning" : "none";
    problemToggle.title = lintLabel;
    problems.replaceChildren();
    const heading = el("div", "editor-problems-heading"); heading.append(el("strong", undefined, "Problems"), el("span", undefined, lintLabel), action("Close Problems", () => { problems.hidden = true; problemToggle.setAttribute("aria-expanded", "false"); }, "close")); problems.append(heading);
    for (const d of diagnostics) {
      const b = action(d.message, () => { editor.dispatch({ selection: { anchor: Math.min(d.from, editor.state.doc.length) }, scrollIntoView: true }); editor.focus(); });
      b.className = "editor-problem"; b.dataset.severity = d.severity;
      const line = editor.state.doc.lineAt(Math.min(d.from, editor.state.doc.length));
      const mark = el("span", "editor-problem-symbol"); mark.append(icon(d.severity === "error" ? "close" : d.severity === "warning" ? "warning" : "info"));
      b.prepend(mark); b.append(el("small", undefined, `Biome · ${line.number}:${d.from - line.from + 1}`)); problems.append(b);
    }
    if (!count) problems.append(el("p", "editor-no-files", lintLabel));
  }
  function scheduleLint() {
    clearTimeout(lintTimer); lintGeneration++;
    lintTimer = setTimeout(() => void lint(), 650);
  }
  async function lint() {
    if (stopped || !current) return;
    if (linting) { lintTimer = setTimeout(() => void lint(), 350); return; }
    if (current.readonly) { lintLabel = "Read-only file · analysis unavailable"; diagnostics = []; renderProblems(); return; }
    const id = lintGeneration, file = current.path, text = editor.state.doc.toString(); linting = true;
    try {
      const result = await api<{ supported: boolean; diagnostics: Diagnostic[]; truncated?: boolean }>("lint", { project: project.id, path: file, text }, "POST");
      if (stopped || id !== lintGeneration || file !== current?.path) return;
      diagnostics = result.diagnostics;
      lintLabel = !result.supported ? "No linter for this language" : result.truncated ? "Biome · showing the first 100 problems" : diagnostics.length ? "Biome · current file" : "Biome · no problems found";
      editor.dispatch(setDiagnostics(editor.state, diagnostics)); renderProblems();
    } catch (e) {
      if (!stopped && id === lintGeneration) { lintLabel = (e as Error).message; diagnostics = []; editor.dispatch(setDiagnostics(editor.state, [])); renderProblems(); }
    } finally { linting = false; }
  }
  async function formatFile() {
    if (!canEdit()) return;
    await runExclusive(async () => {
      if (!current) return;
      const result = await api<{ supported: boolean; text?: string }>("format", { project: project.id, path: current.path, text: editor.state.doc.toString() }, "POST");
      if (!result.supported || result.text === undefined) throw Error("Formatting is not available for this language.");
      if (editor.state.doc.toString() !== result.text) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: result.text }, userEvent: "input.format" });
      await flush();
    });
  }
  async function quickOpen() {
    const { d, form, actions: buttons } = dialog("Quick open"); d.classList.add("editor-quick-dialog");
    const query = el("input", "input"), results = el("div", "editor-quick-results");
    query.placeholder = "Search files and text…"; query.setAttribute("aria-label", "Quick open query"); buttons.remove();
    const close = action("Close quick open", () => d.close(), "close"); close.classList.add("editor-quick-close"); form.append(close, query, results);
    let timer: ReturnType<typeof setTimeout>, request = 0;
    const render = (rows: { path: string; line?: number; text?: string }[]) => {
      results.replaceChildren();
      for (const r of rows.slice(0, 60)) { const b = action(r.path, () => { d.close(); return load(r.path, r.line); }); b.className = "editor-quick-result"; if (r.text) b.append(el("small", undefined, `${r.line} · ${r.text}`)); results.append(b); }
      if (!rows.length) results.append(el("p", "editor-no-files", "No matches. Try a file name or some text."));
    };
    render((state.tabs ?? []).map(path => ({ path })));
    query.oninput = () => { clearTimeout(timer); const id = ++request; timer = setTimeout(() => run(async () => { const rows = query.value.trim() ? await api<Awaited<ReturnType<typeof searchFiles>>>("search", { project: project.id, q: query.value }) : (state.tabs ?? []).map(path => ({ path })); if (id === request && d.open) render(rows); }), 200); };
    form.onsubmit = e => { e.preventDefault(); results.querySelector<HTMLButtonElement>("button")?.click(); };
    d.onkeydown = e => { if (!["ArrowDown", "ArrowUp"].includes(e.key)) return; e.preventDefault(); const all = [...results.querySelectorAll<HTMLButtonElement>("button")], at = all.indexOf(document.activeElement as HTMLButtonElement); all[(at + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus(); };
    d.onclose = () => { clearTimeout(timer); d.remove(); }; query.focus();
  }
  async function compareFile() {
    if (!current) return;
    const file = current.path, local = editor.state.doc.toString(), latest: BufferView = await api("buffer", { project: project.id, path: file });
    const d = el("dialog", "fd-dialog editor-compare"), header = el("div", "editor-compare-heading"), mount = el("div", "editor-merge");
    const error = el("p", "banner banner-err"); error.hidden = true;
    header.append(el("h2", undefined, `Compare changes · ${file}`), action("Close comparison", () => d.close(), "close"));
    d.setAttribute("aria-label", "Compare changes");
    const labels = el("div", "editor-compare-labels"); labels.append(el("strong", undefined, "On disk"), el("strong", undefined, "Your editor"));
    const controls = el("div", "dev-bar");
    const resolve = async (version: "mine" | "disk") => {
      try {
        await runExclusive(async () => {
          if (current?.path !== file || current.revision !== latest.revision || editor.state.doc.toString() !== local) throw Error("The file changed while comparing. Close and compare again.");
          await flush();
          // Do not resolve an unseen external write made while the comparison was open.
          const now: BufferView = await api("buffer", { project: project.id, path: file });
          if (now.revision !== current.revision || (now.diskText ?? now.text) !== (latest.diskText ?? latest.text)) throw Error("The file changed while comparing. Close and compare again.");
          current = await api<BufferView>("buffer", { project: project.id, path: file, revision: current.revision, resolve: version }, "POST");
          pending = false; uncertain = false; dirtyFiles.delete(file); setText(current.text); renderTabs();
        });
        d.close();
      } catch (e) { error.textContent = (e as Error).message; error.hidden = false; }
    };
    if (!latest.readonly && (!latest.owner || latest.owner === owner)) controls.append(action("Use disk version", () => resolve("disk")), action("Save editor version", () => resolve("mine")));
    const copies = await api<ReturnType<typeof bufferCopies>>("copies", { project: project.id, path: file });
    const history = el("details", "editor-recovery"); history.append(el("summary", undefined, `Recovery history (${copies.length})`));
    for (const c of copies) { const item = el("details"), text = el("textarea", "input"); text.value = c.text; text.readOnly = true; text.setAttribute("aria-label", `Recovery from ${c.saved_at}`); item.append(el("summary", undefined, c.saved_at), text, action("Copy recovery text", () => navigator.clipboard.writeText(c.text))); history.append(item); }
    d.append(header, labels, mount, error, controls, history); document.body.append(d); d.showModal();
    const cm = [editorSetup, theme.of(editorTheme()), EditorView.editable.of(false), EditorState.readOnly.of(true)];
    const merge = new MergeView({ parent: mount, a: { doc: latest.diskText ?? latest.text, extensions: cm }, b: { doc: local, extensions: cm }, highlightChanges: true, collapseUnchanged: { margin: 3, minSize: 8 }, diffConfig: { timeout: 1000 } });
    const stopChrome = themedEditorChrome(d);
    d.onclose = () => { stopChrome(); merge.destroy(); d.remove(); };
  }
  const stopMenu = actions(more, () => [
    ["Find / replace", () => { openSearchPanel(editor); }, !current], ["Go to line…", () => { gotoLine(editor); }, !current],
    ["Format document", formatFile, !canEdit()], [wrap ? "Turn off word wrap" : "Turn on word wrap", () => { wrap = !wrap; editor.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) }); }],
    ["Compare / recovery…", compareFile, !current], ["Open another project…", () => runExclusive(async () => { await flush(); return options.changeProject(); })],
  ]);
  const onOpen = (e: Event) => { const d = (e as CustomEvent).detail; if (d.project === project.id && d.page === options.page) run(() => load(d.path, d.line)); };
  window.addEventListener("fd:open-file", onOpen);
  const onKey = (e: KeyboardEvent) => { if (!e.defaultPrevented && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") { e.preventDefault(); e.stopPropagation(); run(quickOpen); } };
  host.addEventListener("keydown", onKey);
  let renewed = 0;
  const stopPoll = poll(async () => {
    if (!current || pending || busy || syncing) return;
    const file = current.path, mine = current.owner === owner;
    // Holding the lease (30 s): one body-less POST renews it AND returns the view, every 10 s — over a
    // relay each call is a fresh channel. Watching someone else's buffer: refresh every 2 s.
    if (mine && Date.now() - renewed < 10_000) return;
    syncing = true;
    try {
      let next: BufferView;
      if (mine) {
        try { next = await api("buffer", { project: project.id, path: file }, "POST"); renewed = Date.now(); }
        catch (e) { if ((e as { status?: number }).status !== 409) throw e; next = await api("buffer", { project: project.id, path: file }); } // lease taken over: show whose
      } else next = await api("buffer", { project: project.id, path: file });
      if (stopped || pending || busy || current?.path !== file) return;
      current = next; setText(next.text); if (next.dirty) dirtyFiles.add(file); else dirtyFiles.delete(file); renderTabs(); refreshStatus();
    } catch (e) { if (!stopped) status.textContent = (e as { status?: number }).status === 401 ? "Signed out · text retained" : "Disconnected · text retained"; }
    finally { syncing = false; }
  }, 2000, () => !host.getClientRects().length);
  const themeObserver = new MutationObserver(() => editor.dispatch({ effects: theme.reconfigure(editorTheme()) }));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-mode"] });
  function checkpointEditor() {
    if (current) {
      fileStates.set(current.path, editor.state);
      positions.set(current.path, { top: editor.scrollDOM.scrollTop, left: editor.scrollDOM.scrollLeft });
    }
    saveDesktopState(recoveryKey, { files: Object.fromEntries([...fileStates].filter(([file]) => state.tabs?.includes(file)).map(([file, value]) => [file, {
      state: value.toJSON({ history: historyField }), ...positions.get(file),
    }])), hidden: host.classList.contains('editor-files-hidden'), wrap, problems: !problems.hidden });
  }
  const beforeNavigate = (e: Event) => (e as CustomEvent<{ waitUntil(p: Promise<unknown>): void }>).detail.waitUntil(runExclusive(async () => {
    await flush(); checkpointEditor(); await remember();
  }));
  window.addEventListener("fd:before-workspace-navigation", beforeNavigate);
  const unload = (e: BeforeUnloadEvent) => { if (pending) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", unload);
  wrap = recovered?.wrap === true;
  problems.hidden = recovered?.problems !== true;
  problemToggle.setAttribute('aria-expanded', String(!problems.hidden));
  renderTabs(); refreshStatus(); renderProblems(); const active = state.active; if (active) run(() => load(active));
  return () => {
    stopped = true; clearTimeout(recoveryTimer); clearTimeout(lintTimer); lintGeneration++; stopPoll(); stopMenu(); stopChrome(); explorer.stop(); themeObserver.disconnect(); tabResize.disconnect();
    window.removeEventListener("fd:before-workspace-navigation", beforeNavigate);
    window.removeEventListener("fd:open-file", onOpen); window.removeEventListener("beforeunload", unload); host.removeEventListener("keydown", onKey);
    void flush().catch(() => {}).finally(() => editor.destroy());
  };
}
