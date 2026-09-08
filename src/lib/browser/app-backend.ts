import net from 'node:net';
import { chromium, type BrowserContext } from 'playwright-core';
import { openStream, tunnelOnline } from '../tunnel.ts';
import { extensionRegistry, extensionZip } from './extensions.ts';
import { unzipSync } from 'fflate';

/** Legacy CDP app profiles also keep the packages on the computer that runs Chromium. */
export async function syncAppExtensions(userId: number, ward: string): Promise<void> {
  const packages = extensionRegistry(userId, ward).extensions.filter(e => e.enabled).map(entry => ({
    id: entry.id,
    files: Object.fromEntries(Object.entries(unzipSync(extensionZip(userId, ward, entry.id))).map(([name, data]) => [name, Buffer.from(data).toString('base64')])),
  }));
  const stream = await openStream(userId, `extensions:${ward}`);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Desktop extension update timed out')), 30_000);
      let reply = '';
      stream.on('error', reject).on('data', chunk => {
        reply += chunk.toString();
        if (reply.length > 2000) { clearTimeout(timer); reject(Error('Invalid desktop extension response')); }
        if (reply.includes('\n')) {
          clearTimeout(timer);
          try { const result = JSON.parse(reply); if (result.error) reject(Error(result.error)); else resolve(); } catch (error) { reject(error); }
        }
      }).on('close', () => { clearTimeout(timer); reject(Error('Desktop extension transfer closed before completion. Update Rimeward if needed.')); });
      const data = Buffer.from(JSON.stringify({ packages }) + '\n');
      if (data.length > 64 * 1024 * 1024) { clearTimeout(timer); reject(Error('Enabled desktop extensions exceed the 64 MB transfer limit')); return; }
      for (let offset = 0; offset < data.length; offset += 64 * 1024) stream.write(data.subarray(offset, offset + 64 * 1024));
    });
  } finally { stream.destroy(); }
}

// The "My computer" backend: a Chromium the desktop app runs for this ward,
// reached over the tunnel. A loopback listener here forwards each TCP
// connection into a `cdp:<ward>` stream, and Playwright connects to it like
// any remote browser — so the agent's tools, the screencast and the input
// path never learn where the browser is. Logins live in the app's profile
// for the ward; egress is the user's own connection by construction.

const OFFLINE = 'Rimeward offline — open it on your computer';

export async function connectApp(userId: number, ward: string): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  if (!tunnelOnline(userId)) throw new Error(OFFLINE);
  await syncAppExtensions(userId, ward);
  // The probe makes the app launch (or download) the browser and name it; a
  // refusal ("downloading 42%") is the message the ward shows.
  const probe = await openStream(userId, `cdp:${ward}`);
  const wsPath = probe.opened;
  probe.destroy();
  if (!wsPath.startsWith('/devtools/browser/')) throw new Error('the desktop app did not name a browser');
  const socks = new Set<net.Socket>();
  const srv = net.createServer((sock) => {
    sock.on('error', () => {});
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
    openStream(userId, `cdp:${ward}`).then(
      (up) => {
        if (sock.destroyed) return up.destroy();
        sock.pipe(up).pipe(sock);
        const drop = () => {
          up.destroy();
          sock.destroy();
        };
        up.on('error', drop).on('close', drop);
        sock.on('close', drop);
      },
      () => sock.destroy()
    );
  });
  await new Promise<void>((resolve, reject) => srv.once('error', reject).listen(0, '127.0.0.1', resolve));
  srv.unref();
  const port = (srv.address() as net.AddressInfo).port;
  const stop = () => {
    for (const sock of socks) sock.destroy();
    srv.close();
  };
  try {
    // Chrome only serves a Host that is an IP or localhost; the forwarder is both.
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${wsPath}`, { timeout: 60_000 });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    // close() on a connected-over-CDP browser only disconnects: the app keeps
    // its Chromium (and the profile) until it reaps it.
    return {
      context,
      close: async () => {
        await browser.close();
        stop();
      },
    };
  } catch (err) {
    stop();
    throw err;
  }
}
