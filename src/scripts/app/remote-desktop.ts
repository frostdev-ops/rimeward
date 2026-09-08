import { expandedDesktopWard, restoreExpandedWard } from "./desktop-state.ts";
import { RENDERERS, body, readLayout } from './wards.ts';
import { el } from './dom.ts';
import type { WardInstance } from '../../lib/wards.ts';
import type { DeviceCapabilities, RemoteDisplay } from '../../lib/dev/remote-desktop-contract.ts';
import '../../styles/remote-desktop.css';
import { remoteFiles } from './remote-files.ts';
import { remoteMedia } from './remote-media.ts';

const mounts = new Map<string, () => void>();
const base = '/api/remote-desktop/';
async function request(path: string, value?: unknown, method = 'POST', signal?: AbortSignal) {
  const response = await fetch(base + path, { method: value === undefined ? 'GET' : method, cache: 'no-store', signal,
    ...(value === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Error(response.status === 404 ? error.error ?? 'Computer unavailable. Update the host app if needed.' : error.error ?? `Connection failed (${response.status}).`);
  }
  return response;
}
function render(w: WardInstance) {
  mounts.get(w.i)?.();
  const container = body(w.i); if (!container) return;
  const root = el('div', 'rd-root'), toolbar = el('div', 'rd-toolbar'), footer = el('div', 'rd-toolbar');
  const picker = el('select', 'input'), displays = el('select', 'input');
  picker.setAttribute('aria-label', 'Computer'); displays.setAttribute('aria-label', 'Monitor');
  picker.append(new Option('Choose a computer', '')); displays.append(new Option('Monitor', ''));
  const connect = el('button', 'btn', 'Connect'), control = el('button', 'btn', 'Take control');
  const expand = el('button', 'btn', 'Expand'), scaling = el('select', 'input');
  const rime = el('select', 'input'), handoff = el('button', 'btn', 'Give control to Rime');
  rime.setAttribute('aria-label', 'Rime ward'); rime.append(new Option('Choose Rime ward', ''));
  for (const agent of readLayout().filter(w => w.type === 'agent')) rime.append(new Option(agent.title ?? `Rime · ${agent.i}`, agent.i));
  scaling.setAttribute('aria-label', 'Screen scaling'); scaling.append(new Option('Fit', 'fit'), new Option('Actual size', 'actual'));
  scaling.value = w.config?.view === 'actual' ? 'actual' : 'fit';
  const zoom = el('input', 'rd-zoom'); zoom.type = 'range'; zoom.min = '50'; zoom.max = '200'; zoom.value = '100'; zoom.step = '10'; zoom.setAttribute('aria-label', 'Screen zoom');
  const message = el('p', 'rd-status', 'Choose a computer, then Connect. Viewing starts without input control.');
  message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const viewport = el('div', 'rd-viewport'), canvas = el('canvas', 'rd-screen');
  const video = el('video', 'rd-video'); video.autoplay = true; video.playsInline = true; video.muted = true; video.hidden = true;
  canvas.tabIndex = 0; canvas.setAttribute('aria-label', 'Remote desktop. Select Take control before using the keyboard or pointer.');
  const context = canvas.getContext('2d'); if (!context) return;
  const text = el('input', 'input'); text.placeholder = 'Type text on the computer'; text.setAttribute('aria-label', 'Text to send');
  const send = el('button', 'btn', 'Send text');
  const audio = el('button', 'btn', 'Listen'), clipboard = el('button', 'btn', 'Clipboard'), files = el('button', 'btn', 'Files');
  const volume = el('input', 'rd-zoom'); volume.type = 'range'; volume.min = '0'; volume.max = '100'; volume.value = '100'; volume.hidden = true; volume.setAttribute('aria-label', 'Remote audio volume');
  volume.oninput = () => { video.volume = Number(volume.value) / 100; };
  for (const button of [audio, clipboard, files]) { button.disabled = true; button.title = 'Unavailable on this host'; }
  const diagnostic = el('small', 'rd-diagnostics'); diagnostic.hidden = w.config?.diagnostics !== true;
  const clipboardPanel = el('details', 'rd-clipboard'), clipboardTitle = el('summary', undefined, 'Clipboard exchange');
  const clipboardText = el('textarea', 'input'), clipboardSend = el('button', 'btn', 'Send text'), clipboardReceive = el('button', 'btn', 'Receive text');
  clipboardText.setAttribute('aria-label', 'Clipboard text'); clipboardText.maxLength = 1024 * 1024;
  const pngSend = el('button', 'btn', 'Send PNG'), pngReceive = el('button', 'btn', 'Receive PNG');
  const syncLabel = el('label'), syncText = el('input'); syncText.type = 'checkbox';
  syncLabel.append(syncText, document.createTextNode(' Sync text while I control this computer and this viewer is focused'));
  const clipboardButtons = el('div', 'rd-toolbar'); clipboardButtons.append(clipboardSend, clipboardReceive, pngSend, pngReceive);
  clipboardPanel.append(clipboardTitle, clipboardText, clipboardButtons, syncLabel); clipboardPanel.hidden = true;
  toolbar.append(picker, displays, connect, control, expand);
  footer.append(scaling, zoom, audio, volume, clipboard, files, rime, handoff, text, send);
  viewport.append(video, canvas); root.append(toolbar, message, viewport, footer, clipboardPanel, diagnostic); container.replaceChildren(root);
  let session = '', frame = 0, sequence = 0, ownership: number | undefined, topology = 0;
  let stopped = false, visible = true, pending = false, otherHuman = false, requestBusy = false, frameBusy = false;
  let timer: ReturnType<typeof setTimeout> | undefined, hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  let inputTimer: ReturnType<typeof setTimeout> | undefined, inputBusy = false;
  let queue: Record<string, unknown>[] = [];
  let lastClipboard = '', syncingClipboard = false, clipboardRevision = 0, controllerId = '';
  let preferWebRTC = false, listening = false;
  let allowInput = false, allowRime = false, allowText = false;
  let dialog: HTMLDialogElement | undefined;
  const abort = new AbortController();
  const fit = () => {
    const scale = scaling.value === 'actual' ? 1 : Math.min(viewport.clientWidth / canvas.width, viewport.clientHeight / canvas.height);
    canvas.style.width = `${Math.max(1, canvas.width * scale)}px`;
    canvas.style.height = `${Math.max(1, canvas.height * scale)}px`;
    video.style.width = canvas.style.width; video.style.height = canvas.style.height;
  };
  const resize = new ResizeObserver(fit); resize.observe(viewport);
  scaling.addEventListener('change', fit);
  const report = (error: unknown) => { if (!stopped) message.textContent = error instanceof Error ? error.message : String(error); };
  const paintControl = () => {
    control.textContent = ownership === undefined ? otherHuman ? 'Take over' : 'Take control' : 'Release control';
    control.disabled = !session || pending || !allowInput; send.disabled = ownership === undefined || !allowText; text.disabled = send.disabled;
    handoff.disabled = !session || pending || !allowRime;
    canvas.style.touchAction = ownership === undefined ? 'auto' : 'none';
  };
  const action = async (name: string, value: Record<string, unknown> = {}) => {
    if (!session) throw Error('Connect first.');
    const current = session;
    const response = await request(`sessions/${current}`, { ...value, action: name }, 'POST', abort.signal);
    if (current !== session || stopped) { await response.body?.cancel(); throw Error('Session changed; the previous operation was not replayed.'); }
    return response;
  };
  const transfer = remoteFiles(value => action('files', value), () => session, () => w.device ?? '', report);
  root.append(transfer.panel); files.onclick = transfer.open;
  const media = remoteMedia(video, value => action('media', value), error => {
    preferWebRTC = false; listening = false; volume.hidden = true; audio.textContent = 'Listen'; audio.disabled = true;
    void release(); report(`${error instanceof Error ? error.message : error} Switching to Compatibility mode; audio is unavailable.`);
    clearTimeout(timer); void loop();
  }, (capability, reason) => {
    if (capability === 'audio') {
      listening = false; audio.disabled = true; audio.textContent = 'Audio unavailable'; audio.title = reason; volume.hidden = true;
      void release().then(async () => { media.stop(); await action('media', { command: 'stop' }); await startMedia(); }).catch(report);
    }
    report(reason);
  });
  video.onresize = video.onloadeddata = () => {
    if (!preferWebRTC) return;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight; context.clearRect(0, 0, canvas.width, canvas.height); fit();
  };
  const startMedia = async () => {
    if (!preferWebRTC || pending) return;
    try { await media.start(w.config?.quality ?? 'auto', listening); }
    catch (error) { preferWebRTC = false; media.stop(); await action('media', { command: 'stop' }).catch(() => {}); report(error); }
  };
  audio.onclick = () => {
    listening = !listening; audio.textContent = listening ? 'Mute' : 'Listen'; volume.hidden = !listening;
    void release().then(async () => { media.stop(); await action('media', { command: 'stop' }); await startMedia(); }).catch(report);
  };
  const release = async () => {
    queue = []; clearTimeout(inputTimer);
    const held = ownership; ownership = undefined; paintControl();
    lastClipboard = ''; syncText.checked = false; clipboardRevision++; clipboardText.value = '';
    if (held !== undefined && session) await action('release').catch(report);
  };
  const disconnect = async () => {
    clearTimeout(timer); clearTimeout(hiddenTimer); clearTimeout(inputTimer);
    const old = session; session = ''; ownership = undefined; queue = []; pending = false; otherHuman = false;
    lastClipboard = ''; syncText.checked = false; clipboardRevision++; clipboardText.value = ''; clipboardPanel.hidden = true; clipboard.disabled = true;
    transfer.reset(); files.disabled = true;
    media.stop(); preferWebRTC = false; listening = false; audio.disabled = true; audio.textContent = 'Listen'; volume.hidden = true;
    context.clearRect(0, 0, canvas.width, canvas.height); diagnostic.textContent = ''; text.value = '';
    connect.textContent = 'Connect'; paintControl();
    if (old) await request(`sessions/${old}`, { action: 'disconnect' }).catch(() => {});
  };
  const updateControl = (controller: { id: string; kind: string; generation: number } | null) => {
    const nextController = controller ? `${controller.id}:${controller.generation}` : '';
    if (controllerId !== nextController) { controllerId = nextController; clipboardRevision++; clipboardText.value = ''; lastClipboard = ''; syncText.checked = false; }
    if (controller?.id !== session || controller.generation !== ownership) ownership = undefined;
    otherHuman = !!controller && controller.kind === 'human' && controller.id !== session;
    paintControl();
    message.textContent = pending ? 'Approve this connection on the host Connections page.' :
      `${preferWebRTC ? media.connected() ? 'WebRTC' : 'Connecting media' : 'Compatibility mode'} · ${ownership !== undefined ? 'You control' : controller?.kind === 'rime' ? 'Rime controls' : otherHuman ? 'Another viewer controls' : 'View-only'}${preferWebRTC ? '' : ' · up to 1280 px / 8 fps · audio unavailable'}`;
  };
  let lastStatus = 0;
  const loop = async () => {
    if (stopped || !session || !visible || document.hidden || frameBusy) return;
    frameBusy = true;
    const current = session;
    try {
      if (Date.now() - lastStatus >= 2000) {
        const state = await (await action('status')).json();
        if (session !== current || stopped) return;
        const approved = pending && state.state !== 'pending-approval'; pending = state.state === 'pending-approval';
        if (state.textInput) { allowText = state.textInput.available; text.title = send.title = state.textInput.reason ?? ''; }
        if (topology !== state.topology) {
          await release(); media.stop(); topology = state.topology; frame = 0;
          if (state.displays) { loadDisplays(state.displays); displays.value = String(state.display); }
          await startMedia();
        }
        else if (approved) await startMedia();
        updateControl(state.controller); lastStatus = Date.now();
        if (preferWebRTC && !diagnostic.hidden) diagnostic.textContent = await media.diagnostics();
      }
      if (!pending && !preferWebRTC) {
        const at = performance.now(), response = await action('frame', { ack: frame });
        if (response.status !== 204) {
          const blob = await response.blob(), bitmap = await createImageBitmap(blob);
          try {
            if (session !== current || stopped) return;
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            context.drawImage(bitmap, 0, 0); fit(); frame = Number(response.headers.get('x-rimeward-frame'));
            diagnostic.textContent = `HTTPS relay · ${Math.round(performance.now() - at)} ms frame round trip · ${Math.round(blob.size / 1024)} KiB`;
          } finally { bitmap.close(); }
        }
      }
    } catch (error) { if (current === session) { await disconnect(); report(error); } return; }
    finally { frameBusy = false; }
    if (!stopped && session === current) timer = setTimeout(() => void loop(), w.config?.quality === 'saver' ? 250 : 125);
  };
  const loadDisplays = (list: RemoteDisplay[]) => {
    displays.replaceChildren(...list.map(d => new Option(`${d.name ?? `Display ${d.display}`} · ${d.width}×${d.height}`, String(d.display))));
  };
  const start = async () => {
    if (requestBusy || stopped) return;
    requestBusy = true; connect.disabled = true;
    try {
      if (session) { await disconnect(); message.textContent = 'Disconnected.'; return; }
      if (!w.device) throw Error('Choose a computer first.');
      const capabilities: DeviceCapabilities = await (await request(`capabilities?device=${encodeURIComponent(w.device)}`, undefined, 'GET', abort.signal)).json();
      if (capabilities.protocol !== 1) throw Error('Update required on the selected computer.');
      if (!capabilities.features.screen) throw Error(capabilities.state === 'suspended' ? 'Remote access was stopped locally. Resume it on the selected computer.' : 'Screen access unavailable. Check the host Connections page and OS permissions.');
      const result = await (await request('sessions', { protocol: 1, device: w.device, ward: w.i,
        capabilities: ['screen', 'input', 'rime', 'clipboard', 'files', 'audio'] }, 'POST', abort.signal)).json();
      if (stopped) { void request(`sessions/${result.id}`, { action: 'disconnect' }); return; }
      session = result.id; frame = 0; sequence = 0; ownership = undefined; topology = result.topology;
      allowInput = result.features.input; allowRime = result.features.rime;
      allowText = result.textInput?.available ?? allowInput; text.title = send.title = result.textInput?.reason ?? '';
      control.title = allowInput ? '' : 'Input is disabled or requires host OS permission';
      handoff.title = allowRime ? '' : 'Rime input is disabled or requires host OS permission';
      clipboard.disabled = !result.features.clipboard; clipboard.title = result.features.clipboard ? 'Send or receive clipboard contents' : 'Clipboard unavailable on this host';
      files.disabled = !result.features.files; files.title = result.features.files ? 'Browse and transfer files' : 'File transfers unavailable on this host';
      pending = result.state === 'pending-approval'; lastStatus = 0;
      preferWebRTC = result.transports?.includes('webrtc') === true;
      audio.disabled = !result.features.audio || !preferWebRTC; audio.title = audio.disabled ? 'System audio unavailable on this transport' : 'Listen to the selected computer’s system output';
      loadDisplays(result.displays); displays.value = String(result.display); connect.textContent = 'Disconnect';
      updateControl(result.controller); await startMedia(); void loop();
    } catch (error) { report(error); }
    finally { requestBusy = false; connect.disabled = false; }
  };
  connect.onclick = () => void start();
  handoff.onclick = () => {
    if (!rime.value) { report('Choose an existing Rime ward.'); return; }
    void action('rime', { ward: rime.value }).then(() => {
      ownership = undefined; queue = []; syncText.checked = false; lastClipboard = ''; clipboardRevision++; clipboardText.value = ''; paintControl();
      message.textContent = 'Rime controls. No task was sent; enter your task in the selected Rime ward.';
    }).catch(report);
  };
  clipboard.onclick = () => { clipboardPanel.hidden = false; clipboardPanel.open = !clipboardPanel.open; };
  clipboardSend.onclick = () => {
    void action('clipboard', { direction: 'send', mime: 'text/plain', text: clipboardText.value })
      .then(() => { lastClipboard = clipboardText.value; message.textContent = 'Text sent to the remote clipboard.'; }).catch(report);
  };
  clipboardReceive.onclick = () => {
    const current = session, revision = clipboardRevision;
    void action('clipboard', { direction: 'receive', mime: 'text/plain' }).then(r => r.json()).then(async result => {
      if (current !== session || revision !== clipboardRevision || stopped) return;
      clipboardText.value = result.text; lastClipboard = result.text;
      await navigator.clipboard.writeText(result.text); message.textContent = 'Text received into your clipboard.';
    }).catch(report);
  };
  pngSend.onclick = () => {
    const current = session, revision = clipboardRevision;
    void navigator.clipboard.read().then(async items => {
      const item = items.find(i => i.types.includes('image/png')); if (!item) throw Error('Your clipboard does not contain a PNG image.');
      const blob = await item.getType('image/png'); if (blob.size > 8 * 1024 * 1024) throw Error('Clipboard PNG exceeds 8 MiB.');
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = reject; reader.readAsDataURL(blob); });
      if (current !== session || revision !== clipboardRevision || stopped) throw Error('Control changed; send the clipboard again explicitly.');
      await action('clipboard', { direction: 'send', mime: 'image/png', data }); message.textContent = 'PNG sent to the remote clipboard.';
    }).catch(report);
  };
  pngReceive.onclick = () => {
    const current = session, revision = clipboardRevision;
    const png = action('clipboard', { direction: 'receive', mime: 'image/png' }).then(r => r.json()).then(result => {
      if (current !== session || revision !== clipboardRevision || stopped) throw Error('Control changed; receive the clipboard again explicitly.');
      const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0)); return new Blob([bytes], { type: 'image/png' });
    });
    void navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(() => { message.textContent = 'PNG received into your clipboard.'; }).catch(report);
  };
  const clipboardTimer = setInterval(() => {
    if (!syncText.checked || ownership === undefined || !visible || document.hidden || !document.hasFocus() || syncingClipboard) return;
    const current = session, generation = ownership; syncingClipboard = true;
    void navigator.clipboard.readText().then(async value => {
      if (!syncText.checked || current !== session || generation !== ownership) return;
      if (value !== lastClipboard) {
        await action('clipboard', { direction: 'send', mime: 'text/plain', text: value, sync: true, ownership }); lastClipboard = value;
      } else {
        const result = await (await action('clipboard', { direction: 'receive', mime: 'text/plain', sync: true, ownership })).json();
        if (!syncText.checked || current !== session || generation !== ownership) return;
        if (result.text !== lastClipboard) { await navigator.clipboard.writeText(result.text); lastClipboard = result.text; }
      }
    }).catch(error => { syncText.checked = false; report(error); }).finally(() => { syncingClipboard = false; });
  }, 2000);
  picker.onchange = () => {
    if (requestBusy) { picker.value = w.device ?? ''; return; }
    const device = picker.value;
    requestBusy = true; picker.disabled = true; connect.disabled = true;
    void disconnect().then(async () => {
      if (!device) { picker.value = w.device ?? ''; return; }
      await request('target', { ward: w.i, device }, 'PUT', abort.signal);
      w.device = device; message.textContent = 'Computer selected. Connect when ready.';
    }).catch(error => { picker.value = w.device ?? ''; report(error); })
      .finally(() => { requestBusy = false; picker.disabled = false; connect.disabled = false; });
  };
  displays.onchange = () => {
    media.stop();
    void release().then(() => action('monitor', { display: Number(displays.value) })).then(async () => { frame = 0; await startMedia(); }).catch(report);
  };
  control.onclick = () => {
    if (ownership !== undefined) { void release(); return; }
    void action('acquire', { takeover: otherHuman }).then(r => r.json()).then(result => {
      ownership = result.ownership; topology = result.topology; sequence = 0;
      canvas.focus(); updateControl({ id: session, kind: 'human', generation: result.ownership });
    }).catch(report);
  };
  const heartbeat = setInterval(() => {
    if (ownership === undefined || !visible || document.hidden) return;
    void action('heartbeat', { ownership, topology }).catch(error => { void release(); report(error); });
  }, 2000);
  const flush = async () => {
    if (inputBusy || ownership === undefined || !queue.length) return;
    const events = queue; queue = []; inputBusy = true;
    try {
      const batch = { ownership, topology, sequence: ++sequence, display: Number(displays.value), events };
      if (!preferWebRTC || !media.send(batch)) await action('input', batch);
    }
    catch (error) { await release(); report(error); }
    finally { inputBusy = false; if (queue.length) void flush(); }
  };
  const input = (event: Record<string, unknown>) => {
    if (ownership === undefined) return;
    if (queue.length >= 128) { void release(); report('Input queue full. Take control again.'); return; }
    if (event.type === 'move' && queue.at(-1)?.type === 'move') queue[queue.length - 1] = event;
    else queue.push(event);
    clearTimeout(inputTimer); inputTimer = setTimeout(() => void flush(), 16);
  };
  const point = (event: PointerEvent | WheelEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { type: 'move', x: Math.max(0, Math.min(0.999999, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(0.999999, (event.clientY - rect.top) / rect.height)) };
  };
  canvas.onpointermove = event => { if (ownership !== undefined) input(point(event)); };
  canvas.onpointerdown = event => {
    if (ownership === undefined) return; event.preventDefault(); canvas.focus(); canvas.setPointerCapture(event.pointerId);
    input(point(event)); input({ type: 'button', button: event.button, down: true });
  };
  canvas.onpointerup = event => {
    if (ownership === undefined) return; event.preventDefault(); input(point(event)); input({ type: 'button', button: event.button, down: false });
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.onpointercancel = () => void release();
  canvas.oncontextmenu = event => { if (ownership !== undefined) event.preventDefault(); };
  canvas.addEventListener('wheel', event => {
    if (ownership === undefined) return; event.preventDefault(); input(point(event));
    for (const [axis, delta] of [['x', event.deltaX], ['y', event.deltaY]] as const) if (delta)
      input({ type: 'scroll', axis, amount: Math.max(-100, Math.min(100, delta * (event.deltaMode === 1 ? 1 : event.deltaMode === 2 ? viewport.clientHeight / 40 : 1 / 40))) });
  }, { passive: false });
  const key = (event: KeyboardEvent, down: boolean) => {
    if (ownership === undefined || event.isComposing) return;
    event.preventDefault(); input({ type: 'key', key: event.key === ' ' ? 'Space' : event.key, code: event.code, down, repeat: event.repeat });
  };
  canvas.onkeydown = event => key(event, true); canvas.onkeyup = event => key(event, false);
  canvas.onblur = () => {
    queue = []; clearTimeout(inputTimer);
    if (ownership !== undefined) void action('clear', { ownership, topology, sequence: ++sequence }).catch(error => { void release(); report(error); });
  };
  const windowBlur = () => void release();
  window.addEventListener('blur', windowBlur);
  root.addEventListener('focusout', event => {
    if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) void release();
  });
  send.onclick = () => { if (text.value && ownership !== undefined && allowText) { input({ type: 'text', text: text.value }); text.value = ''; } };
  const scale = () => {
    viewport.dataset.scaling = scaling.value; viewport.style.setProperty('--rd-zoom', String(Number(zoom.value) / 100));
  };
  scaling.onchange = scale; zoom.oninput = scale; scale();
  expand.onclick = () => {
    if (dialog) { dialog.close(); return; }
    dialog = el('dialog', 'fd-dialog fd-dialog-full rd-dialog'); document.body.append(dialog);
    expandedDesktopWard(w.i);
    dialog.append(root); expand.textContent = 'Collapse'; dialog.showModal();
    dialog.onclose = () => { expandedDesktopWard(); container.append(root); dialog?.remove(); dialog = undefined; expand.textContent = 'Expand'; };
  };
  const visibility = () => {
    const active = visible && !document.hidden;
    if (!active) {
      clearTimeout(timer); void release(); media.stop();
      if (session) void action('pause').catch(report);
      clearTimeout(hiddenTimer); hiddenTimer = setTimeout(() => {
        if (!session) return;
        if (transfer.active()) void action('detach').then(r => r.json()).then(result => {
          if (result.closed) return disconnect();
          message.textContent = 'Viewing ended while hidden. File transfers continue; returning reconnects view-only.';
        }).catch(report);
        else void disconnect();
      }, 60000);
    } else {
      clearTimeout(hiddenTimer);
      if (session) void action('resume').then(async () => { frame = 0; await startMedia(); clearTimeout(timer); void loop(); }).catch(report);
    }
  };
  document.addEventListener('visibilitychange', visibility);
  const observer = new IntersectionObserver(entries => { const next = entries[0]?.isIntersecting ?? false; if (visible !== next) { visible = next; visibility(); } });
  observer.observe(root);
  const transferHeartbeat = setInterval(() => {
    if (session && transfer.active() && (!visible || document.hidden)) void action('status').catch(report);
  }, 10000);
  const stop = () => {
    stopped = true; void disconnect(); transfer.stop(); abort.abort(); clearInterval(heartbeat); observer.disconnect();
    clearInterval(clipboardTimer); clearInterval(transferHeartbeat); resize.disconnect();
    document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', stop);
    window.removeEventListener('blur', windowBlur);
    dialog?.close(); dialog?.remove(); mounts.delete(w.i);
  };
  mounts.set(w.i, stop); window.addEventListener('pagehide', stop);
  restoreExpandedWard(w.i, () => expand.click());
  paintControl();
  void request('devices', undefined, 'GET', abort.signal).then(r => r.json()).then(list => {
    if (stopped) return;
    for (const d of list) picker.append(new Option(`${d.name} · ${d.platform} · ${d.online ? d.remoteDesktop === 0 ? 'Update required' : 'Online' : 'Offline'}`, d.id));
    if (w.device && !list.some((d: { id: string }) => d.id === w.device)) picker.append(new Option('Unavailable computer', w.device));
    picker.value = w.device ?? '';
    if (w.config?.autoConnect === true && w.device && visible && !document.hidden) void start();
  }).catch(report);
}
RENDERERS['remote-desktop'] = { render, stop: id => mounts.get(id)?.() };
