import { icon } from "./icon.ts";
import { el } from "./dom.ts";
import type { Project } from "../../lib/dev/types.ts";
import "../../styles/development.css";

export async function desktopApi<T = unknown>(action: string, body?: unknown): Promise<T> {
  const page = new URLSearchParams(location.hash.slice(1)).get('p');
  const r = await fetch(`/api/dev/${action}${page ? `${action.includes('?') ? '&' : '?'}_page=${encodeURIComponent(page)}` : ''}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await r
    .json()
    .catch(() => ({ error: "This desktop is unavailable." }));
  if (!r.ok) throw new Error(data.error ?? "Desktop request failed.");
  return data;
}
export function dialog(title: string) {
  const d = el("dialog", "fd-dialog dev-project-dialog"),
    form = el("form"),
    heading = el("h2", undefined, title),
    error = el("p", "banner banner-err"),
    actions = el("div", "dev-bar"),
    cancel = el("button", "btn", "Cancel"),
    submit = el("button", "btn-primary", "Continue");
  error.hidden = true;
  error.setAttribute("role", "alert");
  heading.id = `dialog-${crypto.randomUUID()}`;
  d.setAttribute("aria-labelledby", heading.id);
  cancel.type = "button";
  cancel.onclick = () => d.close();
  submit.type = "submit";
  actions.append(cancel, submit);
  form.append(heading, error, actions);
  d.append(form);
  document.body.append(d);
  d.showModal();
  return { d, form, error, actions, submit };
}
export function askText(label: string, value = ""): Promise<string | null> {
  const { d, form, actions } = dialog(label),
    i = el("input", "input");
  i.value = value;
  i.required = true;
  i.setAttribute("aria-label", label);
  actions.before(i);
  i.focus();
  return new Promise((resolve) => {
    let result: string | null = null;
    form.onsubmit = (e) => {
      e.preventDefault();
      if (i.reportValidity()) {
        result = i.value;
        d.close();
      }
    };
    d.onclose = () => {
      d.remove();
      resolve(result);
    };
  });
}
export function confirmAction(text: string): Promise<boolean> {
  const { d, form } = dialog(text);
  return new Promise((resolve) => {
    let result = false;
    form.onsubmit = (e) => {
      e.preventDefault();
      result = true;
      d.close();
    };
    d.onclose = () => {
      d.remove();
      resolve(result);
    };
  });
}
export function chooseProject(ward?: string): Promise<Project | null> {
  const api = <T = unknown>(action: string, body?: unknown) => desktopApi<T>(action + (ward ? `?_ward=${encodeURIComponent(ward)}` : ''), body);
  const { d, form, error, actions, submit } = dialog("Open a project");
  const modes = el("div", "dev-project-modes"),
    existing = el("button", "btn", "Existing folder"),
    fresh = el("button", "btn", "New project"),
    saved = el("div", "dev-project-list");
  const folderLabel = el("label", undefined, "Project folder"),
    folder = el("input", "input"),
    browse = el("button", "btn", "Choose folder…"),
    nameLabel = el("label", undefined, "Project name"),
    name = el("input", "input");
  folder.setAttribute("aria-label", "Project folder");
  folder.required = true;
  folder.placeholder = "Choose a folder on this desktop";
  const folderCaption = el("span", undefined, "Project folder");
  folderLabel.replaceChildren(folderCaption, folder, browse);
  name.setAttribute("aria-label", "Project name");
  name.required = true;
  nameLabel.append(name);
  nameLabel.hidden = true;
  name.disabled = true;
  let create = false,
    parent = "",
    root = "";
  const mode = (next: boolean) => {
    error.hidden = true;
    if (create) parent = folder.value;
    else root = folder.value;
    create = next;
    folder.value = create ? parent : root;
    folderCaption.textContent = create ? "Create inside this folder" : "Project folder";
    nameLabel.hidden = !create;
    name.disabled = !create;
    existing.setAttribute("aria-pressed", String(!create));
    fresh.setAttribute("aria-pressed", String(create));
    submit.textContent = create ? "Create project" : "Open project";
    folder.setAttribute(
      "aria-label",
      create ? "Parent folder" : "Project folder",
    );
    (create ? name : folder).focus();
  };
  for (const b of [existing, fresh, browse]) b.type = "button";
  existing.onclick = () => mode(false);
  fresh.onclick = () => mode(true);
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Project location");
  existing.setAttribute("aria-pressed", "true");
  fresh.setAttribute("aria-pressed", "false");
  modes.append(existing, fresh);
  actions.before(saved, modes, nameLabel, folderLabel);
  submit.textContent = "Open project";
  browse.onclick = async () => {
    try {
      const r = await api<{ path: string | null }>("folder", {});
      if (r.path) folder.value = r.path;
    } catch (e) {
      error.textContent =
        `${(e as Error).message} You can enter the folder path above.`;
      error.hidden = false;
    }
  };
  return new Promise((resolve) => {
    let result: Project | null = null;
    const finish = (p: Project) => {
      if (!d.open) return;
      result = p;
      window.dispatchEvent(new CustomEvent("fd:project-added", { detail: p }));
      d.close();
    };
    d.onclose = () => {
      d.remove();
      resolve(result);
    };
    void Promise.all([api<Project[]>("projects"), api<{ parent: string }>("project-defaults")])
      .then(([projects, defaults]) => {
        parent = defaults.parent;
        if (create && !folder.value) folder.value = parent;
        if (projects.length) saved.append(el("p", "dev-label", "Recent projects"));
        for (const p of projects) {
          const b = el("button", "dev-recent-project");
          const text = el("span");
          text.append(el("strong", undefined, p.name), el("small", undefined, p.root));
          b.append(icon("folder"), text, icon("right"));
          b.type = "button";
          b.title = p.root;
          b.onclick = () => finish(p);
          saved.append(b);
        }
      })
      .catch((e) => {
        error.textContent = e.message;
        error.hidden = false;
      });
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      submit.disabled = true;
      error.hidden = true;
      try {
        finish(
          await api(
            "projects",
            create
              ? { create: true, parent: folder.value, name: name.value }
              : { root: folder.value },
          ),
        );
      } catch (e) {
        error.textContent = (e as Error).message;
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    };
  });
}
export async function openProjectWorkspace() {
  const project = await chooseProject();
  if (project) {
    const { page } = await desktopApi<{ page: string }>("open-project", { project: project.id });
    const next=new URL(location.href);
    next.hash=`p=${page}`;
    next.searchParams.set('workspace',page);
    location.assign(next.href);
  }
}

/** Give mounted editors time to acknowledge recovery before crossing runtimes. */
export async function prepareWorkspaceNavigation() {
  const pending: Promise<unknown>[] = [];
  window.dispatchEvent(new CustomEvent("fd:before-workspace-navigation", {
    detail: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
  }));
  const results = await Promise.allSettled(pending);
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
