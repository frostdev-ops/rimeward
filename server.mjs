// Production entry (pm2, ecosystem.config.cjs): Astro's own standalone server,
// plus the one thing no Astro route can do — the raw `upgrade` event the
// desktop app's tunnel needs (src/lib/tunnel.ts). The autostart switch must
// be set BEFORE the entry evaluates, hence the dynamic import.
process.env.ASTRO_NODE_AUTOSTART = 'disabled';
const { startServer } = await import('./dist/server/entry.mjs');
const { server } = startServer();
export const httpServer=server.server;
server.server.on('upgrade', async (req, sock, head) => {
  // The middleware (which publishes __fdUpgrade) loads on the first request;
  // one self-request boots it if the app connects before anyone browses.
  if (!globalThis.__fdUpgrade) await fetch(`http://127.0.0.1:${server.server.address().port}/login`).catch(() => {});
  if(req.url?.startsWith('/api/browser/ws/')) { (globalThis.__fdBrowserUpgrade ?? ((_,s)=>s.destroy()))(req,sock,head);return; }
  if(req.url?.startsWith('/api/dev/ws?')) { (globalThis.__fdDevUpgrade ?? ((_,s)=>s.destroy()))(req,sock,head);return; }
  if(req.url==='/api/live/stream') { (globalThis.__fdLiveUpgrade ?? ((_,s)=>s.destroy()))(req,sock,head);return; }
  if(req.url==='/api/devices/connect') { (globalThis.__fdDeviceUpgrade ?? ((_,s)=>s.destroy()))(req,sock,head);return; }
  (globalThis.__fdUpgrade ?? ((_, s) => s.destroy()))(req, sock, head);
});
