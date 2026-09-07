import type { beginSignIn, pollSignIn, onboarding } from "../../lib/dev/remote.ts";
import { desktopApi, chooseProject } from "./workspace-dialogs.ts";
import { el } from "./dom.ts";
function required<T extends HTMLElement>(selector: string, parent: ParentNode = document): T {
  const element = parent.querySelector<T>(selector);
  if (!element) throw new Error(`Setup control is missing: ${selector}`);
  return element;
}
const root = required(".desktop-setup"),
  status = required("#setup-status"),
  form = required<HTMLFormElement>("#setup-form"),
  submit = required<HTMLButtonElement>("#setup-submit"),
  wait = required("#setup-wait"),
  connected = required("#setup-connected");
let requestId = "",
  timer: ReturnType<typeof setTimeout> | undefined;
function step(value: "connect" | "approve" | "ready") {
  root.dataset.step = value;
  root.querySelectorAll<HTMLElement>(".setup-progress li").forEach(li => {
    if (li.dataset.step === value) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
  status.dataset.error = "false";
}
const report = (e: unknown) => {
  status.dataset.error = "true";
  status.textContent = e instanceof Error ? e.message : String(e);
};
const action = (label: string, fn: () => Promise<unknown>) => {
  const b = el("button", "btn", label);
  b.type = "button";
  b.onclick = () => {
    b.disabled = true;
    void fn()
      .catch(report)
      .finally(() => {
        b.disabled = false;
      });
  };
  return b;
};
async function openServer(_id: string) {
  status.textContent = "Opening your workspace…";
  await desktopApi("onboard", { home: "local" });
  location.assign('/dash');
}
function showConnected(p: { id: string; server: string; email?: string }) {
  connected.hidden = false;
  const row = el("div", "setup-connected-row");
  step("ready");
  row.append(
    el("strong", undefined, p.server),
    el(
      "p",
      undefined,
      p.email ? `Connected as ${p.email}` : "Already connected to this server",
    ),
    action("Open Rimeward", () => openServer(p.id)),
  );
  connected.append(row);
}
async function poll() {
  const id = requestId;
  if (!id) return;
  try {
    const result = await desktopApi<Awaited<ReturnType<typeof pollSignIn>>>("sign-in-poll", { id });
    if (id !== requestId) return;
    if (result.status === "connected") {
      requestId = "";
      wait.hidden = true;
      submit.disabled = false;
      status.textContent =
        "Connected. Your pages, settings and Rime will come together automatically.";
      showConnected(result);
      return;
    }
    timer = setTimeout(() => void poll(), 3100);
  } catch (e) {
    if (id === requestId) {
      requestId = "";
      wait.hidden = true;
      submit.disabled = false;
      step("connect");
      report(e);
    }
  }
}
async function cancel() {
  clearTimeout(timer);
  const id = requestId;
  requestId = "";
  wait.hidden = true;
  step("connect");
  submit.disabled = false;
  if (id) await desktopApi("sign-in-cancel", { id });
}
form.onsubmit = async (e) => {
  e.preventDefault();
  if (!form.reportValidity()) return;
  submit.disabled = true;
  try {
    await cancel();
    submit.disabled = true;
    status.textContent = "Connecting to your server…";
    const input = form.elements.namedItem("server") as HTMLInputElement;
    const raw = input.value.trim(),
      server = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const result = await desktopApi<Awaited<ReturnType<typeof beginSignIn>>>("sign-in-start", { server });
    requestId = result.id;
    required("#setup-code").textContent = result.userCode;
    (document.getElementById("setup-link") as HTMLAnchorElement).href =
      result.verificationUrl;
    wait.hidden = false;
    step("approve");
    status.textContent = result.browserOpened
      ? "Waiting for your approval in the browser…"
      : "Use the approval link below to finish connecting.";
    timer = setTimeout(() => void poll(), 3100);
  } catch (e) {
    submit.disabled = false;
    report(e);
  }
};
required("#setup-reopen").onclick = () =>
  void desktopApi("sign-in-open", { id: requestId }).catch(report);
required("#setup-cancel").onclick = () =>
  void cancel()
    .then(() => {
      status.textContent = "Connection cancelled.";
    })
    .catch(report);
required("#setup-local").onclick = () =>
  void cancel()
    .then(() => desktopApi("onboard", { home: "local" }))
    .then(() => location.assign("/dash"))
    .catch(report);
required("#setup-project").onclick = async () => {
  try {
    const p = await chooseProject();
    if (!p) return;
    const { page } = await desktopApi<{ page: string }>("open-project", { project: p.id });
    await cancel();
    await desktopApi("onboard", { home: "local" });
    location.assign(`/dash#p=${page}`);
  } catch (e) {
    report(e);
  }
};
window.addEventListener("pagehide", () => clearTimeout(timer));
void desktopApi<Awaited<ReturnType<typeof onboarding>>>("onboarding")
  .then(async (state) => {
    for (const p of state.pairs) showConnected(p);
    if (state.complete && root.dataset.setup !== "1") {
      location.replace('/dash');
    }
  })
  .catch(report);

// Computer control is a local desktop setting, beside the connection it grants.

const controlForm = required<HTMLFormElement>('#computer-control-form');
const enabled = required<HTMLInputElement>('#computer-control-enabled');
const controlStatus = required<HTMLElement>('#computer-control-status');
let controlGeneration = -1;
async function settings(value?: { enabled?: boolean; generation?: number; session?: string; allow?: boolean }) {
  const response = await fetch('/api/dev/control-settings', value ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) } : { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw Error(data.error ?? 'Control settings unavailable.');
  return data;
}
controlForm.onsubmit = event => {
  event.preventDefault();
  const submit = required<HTMLButtonElement>('button[type="submit"]', controlForm); submit.disabled = true;
  void settings({ enabled: enabled.checked, generation: controlGeneration }).then(data => {
    controlGeneration = data.generation; enabled.checked = data.enabled;
    controlStatus.textContent = data.enabled ? 'Screen control enabled. Stop it at any time from the tray menu.' : 'Screen control is off.';
  }).catch(async e => {
    controlStatus.textContent = e.message;
    const current = await settings().catch(() => null);
    if (current) { controlGeneration = current.generation; enabled.checked = current.enabled; }
  }).finally(() => { submit.disabled = false; });
};
void settings().then(data => {
  controlGeneration = data.generation; enabled.checked = data.enabled;
  required<HTMLElement>('#computer-control-permissions').textContent = data.permissions ?? '';
  controlStatus.textContent = data.enabled ? 'Screen control is enabled.' : 'Screen control is off.';
}).catch(e => { controlStatus.textContent = e.message; });

const approvals = required<HTMLElement>('#computer-control-approvals');
async function refreshApprovals() {
  const data = await settings();
  approvals.replaceChildren();
  for (const pending of data.pending ?? []) {
    const row = el('div', 'flex gap-2'), label = el('span', undefined, `Connection request: ${pending.capabilities.join(', ')}`);
    row.append(label);
    for (const allow of [true, false]) {
      const button = el('button', 'btn', allow ? 'Allow connection' : 'Deny');
      button.onclick = () => { void settings({ session: pending.id, allow }).then(refreshApprovals).catch(report); };
      row.append(button);
    }
    approvals.append(row);
  }
}
const approvalTimer = setInterval(() => { if (!document.hidden) void refreshApprovals().catch(() => {}); }, 5000);
window.addEventListener('pagehide', () => clearInterval(approvalTimer), { once: true });
void desktopApi<Awaited<ReturnType<typeof onboarding>>>('onboarding').then(async state => {
  const { remoteDesktopSettings } = await import('./remote-desktop-settings.ts');
  for (const pair of state.pairs.slice(0, 1)) {
    const container = el('div'); required<HTMLElement>('#computer-access-policies').append(container);
    await remoteDesktopSettings(container, pair.id);
  }
}).catch(() => {});
