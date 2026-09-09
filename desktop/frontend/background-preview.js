const app = document.getElementById('app'), picture = document.getElementById('image');
const cursor = document.getElementById('cursor'), frame = document.getElementById('frame');
const time = document.getElementById('time'), status = document.getElementById('status');
const pause = document.getElementById('pause'), takeover = document.getElementById('takeover'), stop = document.getElementById('stop');
let session, paused = false, observedAt = 0, working = false, ratio = 1, actionError = '';
function fit() {
  const bounds = frame.parentElement.getBoundingClientRect();
  const width = Math.min(bounds.width, bounds.height * ratio);
  frame.style.width = `${width}px`; frame.style.height = `${width / ratio}px`;
}
new ResizeObserver(fit).observe(frame.parentElement);
const invoke = (action) => window.__TAURI__.core.invoke('background_preview', { action, session });
async function refresh() {
  try {
    const state = await invoke('state');
    session = state.session; paused = state.paused;
    for (const button of [pause, takeover, stop]) button.disabled = !state.active || working;
    picture.hidden = !state.active || !state.image;
    document.getElementById('empty').hidden = !picture.hidden;
    app.textContent = state.app || 'Rime · Background app';
    pause.textContent = paused ? 'Resume' : 'Pause';
    status.textContent = actionError || (state.active ? (state.reason || 'Rime is working in this app') : 'Session ended');
    if (!picture.hidden && state.observedAt !== observedAt) {
      observedAt = state.observedAt;
      picture.src = `data:${state.imageMime};base64,${state.image}`;
      ratio = state.width / state.height; fit();
    }
    time.textContent = state.observedAt ? `Observed ${Math.max(0, Math.floor((Date.now() - state.observedAt) / 1000))}s ago · updates after actions` : 'No observation yet';
    cursor.hidden = !state.active || !state.cursor;
    if (!cursor.hidden) {
      cursor.style.left = `${state.cursor.x / state.width * 100}%`;
      cursor.style.top = `${state.cursor.y / state.height * 100}%`;
    }
  } catch { status.textContent = 'Preview unavailable. Use the tray to Stop control.'; }
}
async function act(action) {
  if (working || !session) return;
  working = true;
  actionError = '';
  try { await invoke(action); }
  catch (error) { actionError = String(error); }
  finally { working = false; }
  await refresh();
}
pause.onclick = () => act(paused ? 'resume' : 'pause');
takeover.onclick = () => act('takeover');
stop.onclick = () => act('stop');
async function poll() { await refresh(); setTimeout(poll, 1000); }
void poll();
