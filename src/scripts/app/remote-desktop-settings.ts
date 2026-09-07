import { el } from './dom.ts';
import { REMOTE_CAPABILITIES, type DeviceAccessPolicy } from '../../lib/dev/remote-desktop-contract.ts';

/** Same persisted policy on Devices, ward Configure and local Connections. */
export async function remoteDesktopSettings(container: HTMLElement, device: string) {
  const root = el('div', 'rd-access-policy flex flex-col gap-2');
  container.replaceChildren(root);
  root.append(el('p', 'text-xs text-ink-faint', 'Remote Desktop access for your account'));
  const message = el('p', 'text-xs'); message.setAttribute('role', 'status');
  const request = async (value?: DeviceAccessPolicy) => {
    const r = await fetch(`/api/remote-desktop/policy?device=${encodeURIComponent(device)}`, value ? {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device, policy: value }),
    } : { cache: 'no-store' });
    const body = await r.json(); if (!r.ok) throw Error(body.error ?? 'Access settings unavailable.');
    return body as DeviceAccessPolicy;
  };
  try {
    let policy = await request();
    if (!root.isConnected) return;
    const connection = el('select', 'input'); connection.setAttribute('aria-label', 'Connection approval');
    for (const [value, title] of [['account', 'My signed-in account'], ['approval', 'Approve each connection locally'], ['disabled', 'Disabled']]) connection.append(new Option(title, value));
    connection.value = policy.connection;
    const persistence = el('select', 'input'); persistence.setAttribute('aria-label', 'Remember access settings');
    persistence.append(new Option('Remember settings', 'remember'), new Option('Until Rimeward quits', 'until-quit')); persistence.value = policy.persistence;
    const fields = REMOTE_CAPABILITIES.map(capability => {
      const label = el('label', 'flex gap-2'), input = el('input'); input.type = 'checkbox'; input.checked = policy[capability];
      label.append(input, document.createTextNode({ screen: 'View screen', input: 'Mouse and keyboard', rime: 'Rime input', clipboard: 'Clipboard exchange', files: 'File transfers', audio: 'System audio' }[capability]));
      return { capability, input, label };
    });
    const save = el('button', 'btn', 'Save access settings'); save.type = 'button';
    root.append(connection, persistence, ...fields.map(f => f.label), save, message);
    save.onclick = event => {
      event.preventDefault(); save.disabled = true;
      const next = { ...policy, connection: connection.value as DeviceAccessPolicy['connection'], persistence: persistence.value as DeviceAccessPolicy['persistence'] };
      for (const f of fields) next[f.capability] = f.input.checked;
      void request(next).then(value => { policy = value; message.textContent = 'Saved. Existing viewer sessions have ended.'; })
        .catch(error => { message.textContent = error.message; }).finally(() => { save.disabled = false; });
    };
  } catch (error) { message.textContent = error instanceof Error ? error.message : 'Access settings unavailable.'; root.append(message); }
}
