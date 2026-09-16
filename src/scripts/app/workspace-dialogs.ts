import { el } from "./dom.ts";
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
