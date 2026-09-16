import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import ssh2 from 'ssh2';
import pty from 'node-pty';
const { Server, utils } = ssh2;

export const sftpServer = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/ssh/sftp-server'].find(file => fs.existsSync(file));

/** A local encrypted SSH transport over the OS's real SFTP subsystem; no installed service or remote account. */
export async function sshFixture(directory, denyFsync = false) {
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const parsed = utils.parseKey(key); if (parsed instanceof Error) throw parsed;
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  const password = crypto.randomBytes(24).toString('base64url'), clients = new Set(), children = new Set(), commands = [], sizes = [];
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === password ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); let requestedPty, nativePty;
      session.on('pty', (accept, _reject, size) => { requestedPty = size; sizes.push(size); accept?.(); });
      session.on('window-change', (accept, _reject, size) => { sizes.push(size); nativePty?.resize(size.cols, size.rows); accept?.(); });
      const bridge = (channel, executable, args) => {
        if (requestedPty) {
          nativePty = pty.spawn(executable, args, { cwd: directory, env: { HOME: directory, SHELL: '/bin/sh', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, cols: requestedPty.cols, rows: requestedPty.rows, name: 'xterm-256color' });
          const child = nativePty; children.add(child); channel.on('data', data => child.write(data.toString()));
          child.onData(data => channel.write(data)); child.onExit(({ exitCode }) => { children.delete(child); if (!channel.destroyed) { channel.exit(exitCode); channel.end(); } });
          channel.on('error', () => {}); channel.on('close', () => child.kill()); return;
        }
        const child = spawn(executable, args, { cwd: directory, env: { HOME: directory, SHELL: '/bin/sh', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
        children.add(child); channel.pipe(child.stdin);
        child.stdin.on('error', () => {}); channel.on('error', () => {});
        child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false });
        channel.on('close', () => child.kill());
        child.on('error', () => { channel.exit(127); channel.end(); });
        child.on('close', code => { children.delete(child); if (!channel.destroyed) { if (code !== null) channel.exit(code); channel.end(); } });
      };
      // Generic subsystem exposes a normal channel; the native binary negotiates its actual OpenSSH extensions.
      session.on('subsystem', (accept, reject, info) => info.name === 'sftp' ? bridge(accept(), sftpServer, denyFsync ? ['-P', 'fsync'] : []) : reject());
      session.on('exec', (accept, _reject, info) => {
        commands.push(info.command); const channel = accept();
        if (info.command === 'fixture:no-status' || info.command.includes('__fixture_missing_status__')) { channel.end('closed without exit status'); return; }
        if (info.command === 'fixture:unicode') {
          const bytes = Buffer.from('🙂 café\n'); channel.write(bytes.subarray(0, 2));
          setImmediate(() => { channel.write(bytes.subarray(2)); channel.exit(0); channel.end(); }); return;
        }
        bridge(channel, '/bin/sh', ['-c', info.command]);
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { host: '127.0.0.1', port: server.address().port, username: 'fixture', password, fingerprint, commands, sizes,
    async close() { for (const child of children) child.kill(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); },
  };
}
