import { el } from './dom.ts';
import type { DownloadRecord } from './remote-download-worker.ts';

const CHUNK = 4 * 1024 * 1024;
const digest = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const encode = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = reject; reader.readAsDataURL(blob);
});
export function remoteFiles(action: (body: Record<string, unknown>) => Promise<Response>, session: () => string, device: () => string, report: (error: unknown) => void) {
  const panel = el('details', 'rd-files'), title = el('summary', undefined, 'File transfers');
  const toolbar = el('div', 'rd-toolbar'), root = el('input', 'input'), location = el('p', 'rd-status'), entries = el('div', 'rd-file-entries');
  root.placeholder = 'Absolute folder path on the computer'; root.setAttribute('aria-label', 'Remote transfer root');
  const browse = el('button', 'btn', 'Browse'), up = el('button', 'btn', 'Up'), upload = el('button', 'btn', 'Upload files'), folder = el('button', 'btn', 'Upload folder'), downloadFolder = el('button', 'btn', 'Download folder');
  const conflicts = el('select', 'input'); conflicts.setAttribute('aria-label', 'Existing files');
  conflicts.append(new Option('Keep both', 'keep-both'), new Option('Skip existing', 'skip'), new Option('Replace existing', 'replace'));
  const progress = el('div'), recovery = el('button', 'btn', 'Interrupted transfers'), recoveryList = el('div');
  let currentPath = '', generation = 0, active = 0;
  const jobs = new Map<string, { cancelled: boolean; abort?: () => void }>();
  let closed = false, rejectDisk: ((error: Error) => void) | undefined;
  let worker: Worker | undefined, diskQueue = Promise.resolve<unknown>(undefined);
  const disk = <T = DownloadRecord>(body: Record<string, unknown>): Promise<T> => {
    const result = diskQueue.then(() => new Promise<T>((resolve, reject) => {
      if (closed) { reject(Error('Viewer closed')); return; }
      rejectDisk = reject;
      worker ??= new Worker(new URL('./remote-download-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => event.data.error ? reject(Error(event.data.error)) : resolve(event.data.result);
      worker.onerror = () => { worker?.terminate(); worker = undefined; reject(Error('Local download storage unavailable')); };
      worker.postMessage(body, body.bytes instanceof ArrayBuffer ? [body.bytes] : []);
    }));
    diskQueue = result.catch(() => {}); return result;
  };
  const exportFile = async (record: DownloadRecord) => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('rimeward-downloads');
    const file = await (await directory.getFileHandle(`${record.id}.part`)).getFile();
    if (!record.complete || file.size !== record.size) throw Error('Download is incomplete');
    const link = el('a'); link.href = URL.createObjectURL(file); link.download = record.path.split('/').at(-1) ?? 'download'; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  };
  const verifyDownload = async (id: string, valid: () => void) => {
    for (let index = 0; ; index++) {
      valid(); const record = await disk({ command: 'verify', id, index }); valid();
      if (index + 1 >= record.chunks.length) return record;
    }
  };
  const receive = async (path: string, resume?: DownloadRecord) => {
    if (resume?.folderPath !== undefined) return receiveFolder(resume);
    if (active >= 2) throw Error('Wait for an active transfer to finish.');
    const startSession = session(), startGeneration = generation;
    const valid = () => { if (job.cancelled) throw Error('Transfer cancelled'); if (!startSession || startSession !== session() || startGeneration !== generation) throw Error('Session changed; resume the transfer explicitly.'); };
    const row = el('div', 'rd-toolbar'), status = el('span'), cancel = el('button', 'btn', 'Cancel');
    row.append(status, cancel); progress.append(row); active++;
    const job = { cancelled: false }; let id = resume?.id ?? '';
    cancel.onclick = () => { job.cancelled = true; cancel.disabled = true; };
    try {
      valid();
      let record: DownloadRecord;
      if (resume) {
        record = await verifyDownload(resume.id, valid);
        if (record.device !== device()) throw Error('Select the original computer to resume');
        let state = await call({ command: 'resume', ...record, upload: false });
        while (state.validating) { valid(); state = await call({ command: 'validate', id: record.id }); status.textContent = `${path} · validating ${Math.round(state.verified / Math.max(1, record.offset) * 100)}%`; }
        if (state.offset !== record.offset || state.digest !== record.digest || state.size !== record.size) throw Error('Source or destination changed');
      } else {
        const source = `browser-opfs:${crypto.randomUUID()}`, selectedRoot = root.value;
        const state = await call({ command: 'create', root: selectedRoot, path, upload: false, source });
        record = { ...state, device: device(), root: selectedRoot, path, source, chunks: [], complete: false };
        id = record.id; await disk({ command: 'create', record });
      }
      id = record.id; jobs.set(id, job);
      while (record.offset < record.size) {
        valid(); if (job.cancelled) break;
        const result = await call({ command: 'chunk', id, offset: record.offset }); valid();
        const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
        if (!bytes.length || bytes.length > CHUNK || result.offset !== record.offset + bytes.length || result.offset > record.size ||
            await digest(bytes.buffer) !== result.sha256 || !/^[a-f0-9]{64}$/.test(result.digest)) throw Error('Invalid download chunk');
        record = { ...record, offset: result.offset, digest: result.digest, chunks: [...record.chunks, result.sha256] };
        await disk({ command: 'append', record, bytes: bytes.buffer }); valid();
        status.textContent = `${path.split('/').at(-1)} · ${Math.round(record.offset / Math.max(1, record.size) * 100)}%`;
      }
      if (job.cancelled) { await call({ command: 'cancel', id }); await disk({ command: 'remove', id }); status.textContent = `${path} · cancelled`; return; }
      valid(); record.complete = true; await disk({ command: 'save', record });
      await call({ command: 'finalize', id });
      status.textContent = `${path.split('/').at(-1)} · ready to save`;
      const save = el('button', 'btn', 'Save file'), discard = el('button', 'btn', 'Discard local copy');
      save.onclick = () => void exportFile(record).catch(report);
      discard.onclick = () => void disk({ command: 'remove', id }).then(() => row.remove()).catch(report);
      row.append(save, discard);
    } catch (error) {
      if (job.cancelled && id) { await call({ command: 'cancel', id }).catch(() => {}); await disk({ command: 'remove', id }); status.textContent = `${path} · cancelled`; return; }
      if (id && session() === startSession) await call({ command: 'pause', id }).catch(() => {});
      status.textContent = `${path} · interrupted; use Interrupted transfers to resume`; throw error;
    } finally { active--; jobs.delete(id); cancel.remove(); }
  };
  const call = async (body: Record<string, unknown>) => {
    const current = session(), revision = generation;
    const result = await (await action(body)).json();
    if (current !== session() || revision !== generation) throw Error('Session changed; repeat the file operation explicitly.');
    return result;
  };
  const list = async () => {
    const result = await call({ command: 'browse', root: root.value, path: currentPath });
    location.textContent = currentPath || 'Selected root'; entries.replaceChildren(); up.disabled = !currentPath;
    for (const entry of result.entries.sort((a: { name: string; directory: boolean }, b: { name: string; directory: boolean }) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))) {
      const row = el('div', 'rd-toolbar'), open = el('button', 'btn', `${entry.directory ? '📁' : '↓'} ${entry.name}`);
      const path = [currentPath, entry.name].filter(Boolean).join('/');
      open.onclick = () => {
        if (entry.directory) { currentPath = path; void list().catch(report); }
        else void receive(path).catch(report);
      };
      row.append(open, el('small', undefined, entry.directory ? '' : `${Math.ceil(entry.size / 1024)} KiB`)); entries.append(row);
    }
  };
  browse.onclick = () => { currentPath = ''; void list().catch(report); };
  up.onclick = () => { currentPath = currentPath.split('/').slice(0, -1).join('/'); void list().catch(report); };
  const send = async (file: File, path: string, resume?: { id: string; root: string; source: string }) => {
    if (active >= 2) throw Error('Wait for an active transfer to finish.');
    const startSession = session(), startGeneration = generation, destination = resume?.root ?? root.value;
    const valid = () => { if (job.cancelled) throw Error('Transfer cancelled'); if (!startSession || startSession !== session() || startGeneration !== generation) throw Error('Session changed; resume the transfer explicitly.'); };
    active++;
    const row = el('div', 'rd-toolbar'), status = el('span'), cancel = el('button', 'btn', 'Cancel'); row.append(status, cancel); progress.append(row);
    let id = '', job = { cancelled: false };
    cancel.onclick = () => { job.cancelled = true; cancel.disabled = true; };
    try {
      valid();
      const fingerprint = `${file.name}:${file.size}:${file.lastModified}:${await digest(await file.slice(0, CHUNK).arrayBuffer())}:${await digest(await file.slice(Math.max(0, file.size - CHUNK)).arrayBuffer())}`;
      valid();
      if (resume && fingerprint !== resume.source) throw Error('The selected source file changed. Start a new transfer.');
      const result = await call({ command: resume ? 'resume' : 'create', id: resume?.id, root: destination, path, upload: true, source: fingerprint, size: file.size });
      id = result.id; jobs.set(id, job); let offset = result.offset;
      let validating = result.validating, verified = 0;
      while (validating) {
        valid(); const check = await call({ command: 'validate', id }); valid();
        if (!Number.isSafeInteger(check.verified) || check.verified < verified || (check.verified === verified && offset !== 0) || check.verified > offset || check.verified - verified > CHUNK ||
            await digest(await file.slice(verified, check.verified).arrayBuffer()) !== check.chunkSha256)
          throw Error('The selected source prefix changed. Start a new transfer.');
        verified = check.verified; validating = check.validating;
        status.textContent = `${file.name} · validating ${Math.round(verified / Math.max(1, offset) * 100)}%`;
      }
      while (offset < file.size) {
        valid(); if (job.cancelled) { await call({ command: 'cancel', id }); status.textContent = `${file.name} · cancelled`; return; }
        const blob = file.slice(offset, Math.min(file.size, offset + CHUNK));
        const sha256 = await digest(await blob.arrayBuffer()), data = await encode(blob); valid();
        const chunk = await call({ command: 'chunk', id, offset, data, sha256 }); offset = chunk.offset;
        status.textContent = `${file.name} · ${Math.round(offset / Math.max(1, file.size) * 100)}%`;
      }
      valid();
      if (job.cancelled) { await call({ command: 'cancel', id }); status.textContent = `${file.name} · cancelled`; return; }
      const finished = await call({ command: 'finalize', id, conflict: conflicts.value });
      status.textContent = `${file.name} · ${finished.skipped ? 'skipped' : 'complete'}`; void list().catch(report);
    } catch (error) {
      if (id && session() === startSession) await call({ command: job.cancelled ? 'cancel' : 'pause', id }).catch(() => {});
      status.textContent = `${file.name} · ${job.cancelled ? 'cancelled' : 'interrupted'}`;
      if (!job.cancelled) throw error;
    }
    finally { active--; jobs.delete(id); cancel.remove(); }
  };
  const choose = (directory: boolean, resume?: { id: string; root: string; path: string; source: string }) => {
    const input = el('input'); input.type = 'file'; input.multiple = !resume; if (directory) input.setAttribute('webkitdirectory', '');
    const destination = currentPath;
    input.onchange = () => {
      const selected = [...(input.files ?? [])];
      void (async () => {
        for (const file of selected) await send(file, resume?.path ?? [destination, file.webkitRelativePath || file.name].filter(Boolean).join('/'), resume);
      })().catch(report);
    };
    input.click();
  };
  upload.onclick = () => choose(false); folder.onclick = () => choose(true);
  const receiveFolder = async (resume?: DownloadRecord) => {
    if (active >= 2) throw Error('Wait for an active transfer to finish.');
    const startSession = session(), revision = generation, lifetime = new AbortController();
    const valid = () => { lifetime.signal.throwIfAborted(); if (!startSession || startSession !== session() || revision !== generation) throw Error('Session changed; resume explicitly.'); };
    let record = resume ?? { id: crypto.randomUUID().replaceAll('-', ''), device: device(), root: root.value,
      path: `${currentPath.split('/').at(-1) || 'folder'}.tar`, folderPath: currentPath, source: 'folder-download', offset: 0, size: 0, digest: '', chunks: [], complete: false };
    const row = el('div', 'rd-toolbar'), status = el('span'), cancel = el('button', 'btn', 'Cancel');
    row.append(status, cancel); progress.append(row); active++;
    const job = { cancelled: false, abort: () => lifetime.abort() }; jobs.set(record.id, job);
    cancel.onclick = () => { job.cancelled = true; lifetime.abort(); };
    let remoteId = '', reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      valid();
      if (resume) record = await verifyDownload(record.id, valid);
      else await disk({ command: 'create', record });
      valid(); if (record.device !== device()) throw Error('Select the original computer.');
      const prefix = record.offset;
      remoteId = (await call({ command: 'download-folder', root: record.root, path: record.folderPath })).id;
      valid();
      const response = await fetch(`/api/remote-desktop/sessions/${startSession}/download/${remoteId}`, { signal: lifetime.signal, cache: 'no-store' });
      if (!response.ok || !response.body) throw Error('Folder download failed. Reconnect and resume.');
      reader = response.body.getReader(); let buffer = new Uint8Array(CHUNK), filled = 0, offset = 0, index = 0;
      const consume = async (bytes: Uint8Array<ArrayBuffer>) => {
        valid(); const sha256 = await digest(bytes.buffer); offset += bytes.length;
        if (offset > 2 ** 40) throw Error('Folder exceeds the 1 TiB transfer limit.');
        if (offset <= prefix) {
          if (record.chunks[index] !== sha256) throw Error('The source folder changed; start a new download.');
        } else {
          if (offset - bytes.length < prefix) throw Error('The source folder changed; start a new download.');
          record = { ...record, offset, size: offset, chunks: [...record.chunks, sha256] };
          await disk({ command: 'append', record, bytes: bytes.buffer });
        }
        index++; status.textContent = `${record.path} · ${offset <= prefix ? 'validating' : 'received'} ${(offset / 1048576).toFixed(1)} MiB`;
      };
      for (;;) {
        valid(); const next = await reader.read(); if (next.done) break;
        for (let at = 0; at < next.value.length;) {
          const length = Math.min(CHUNK - filled, next.value.length - at);
          buffer.set(next.value.subarray(at, at + length), filled); filled += length; at += length;
          if (filled === CHUNK) { await consume(buffer); buffer = new Uint8Array(CHUNK); filled = 0; }
        }
      }
      if (filled) await consume(buffer.slice(0, filled));
      valid(); if (offset < prefix) throw Error('The source folder changed; start a new download.');
      record.complete = true; await disk({ command: 'save', record });
      status.textContent = `${record.path} · ready to save`;
      const save = el('button', 'btn', 'Save folder archive'), discard = el('button', 'btn', 'Discard local copy');
      save.onclick = () => void exportFile(record).catch(report);
      discard.onclick = () => void disk({ command: 'remove', id: record.id }).then(() => row.remove()).catch(report);
      row.append(save, discard);
    } catch (error) {
      if (job.cancelled) { await disk({ command: 'remove', id: record.id }); status.textContent = `${record.path} · cancelled`; }
      else { status.textContent = `${record.path} · interrupted; use Interrupted transfers to resume`; throw error; }
    } finally {
      await reader?.cancel().catch(() => {});
      if (remoteId && session() === startSession) await call({ command: 'cancel-folder', id: remoteId }).catch(() => {});
      active--; jobs.delete(record.id); cancel.remove();
    }
  };
  downloadFolder.onclick = () => void receiveFolder().catch(report);
  recovery.onclick = () => {
    void call({ command: 'recoveries' }).then(async result => {
      recoveryList.replaceChildren();
      for (const record of result.transfers.filter((record: { upload: boolean }) => record.upload)) {
        const button = el('button', 'btn', `Resume ${record.path} · ${Math.round(record.offset / Math.max(1, record.size) * 100)}%`);
        button.title = 'Select the original source file to validate and resume';
        button.onclick = () => choose(false, record); recoveryList.append(button);
      }
      const downloads = await disk<DownloadRecord[]>({ command: 'list', device: device() });
      for (const record of downloads) {
        const row = el('div', 'rd-toolbar'), button = el('button', 'btn', `${record.complete ? 'Save' : 'Resume'} ${record.path}`), discard = el('button', 'btn', 'Discard local copy');
        button.onclick = () => void (record.complete ? exportFile(record) : receive(record.path, record)).catch(report);
        discard.onclick = () => void disk({ command: 'remove', id: record.id }).then(() => row.remove()).catch(report);
        row.append(button, discard); recoveryList.append(row);
      }
      if (!recoveryList.childElementCount) recoveryList.textContent = 'No interrupted transfers.';
    }).catch(report);
  };
  toolbar.append(root, browse, up, upload, folder, downloadFolder, conflicts, recovery);
  panel.append(title, toolbar, location, entries, progress, recoveryList); panel.hidden = true;
  return { panel, open: () => { panel.hidden = false; panel.open = !panel.open; }, reset: () => { generation++; for (const job of jobs.values()) job.abort?.(); panel.hidden = true; }, active: () => active > 0, stop: () => { closed = true; generation++; for (const job of jobs.values()) job.abort?.(); rejectDisk?.(Error('Viewer closed')); worker?.terminate(); worker = undefined; } };
}
