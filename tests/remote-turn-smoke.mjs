// Real authenticated TURN allocations, without sending application data to any peer.
import fs from 'node:fs';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const file = process.env.RIMEWARD_MEDIA_TURN_FILE;
if (!file) throw Error('Set RIMEWARD_MEDIA_TURN_FILE to a private test credential file.');
const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
const server = settings.iceServers[0], target = new URL(server.urls[0].replace(/^turn:/, 'turn://'));
const attribute = (type, value) => { const bytes = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4); bytes.writeUInt16BE(type); bytes.writeUInt16BE(value.length, 2); value.copy(bytes, 4); return bytes; };
const number = n => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(n); return bytes; };
function packet(method, attrs, key) {
  const id = crypto.randomBytes(12), head = Buffer.alloc(20);
  head.writeUInt16BE(method); head.writeUInt16BE(attrs.length + (key ? 24 : 0), 2); head.writeUInt32BE(0x2112a442, 4); id.copy(head, 8);
  const body = Buffer.concat([head, attrs]);
  return { id, bytes: key ? Buffer.concat([body, attribute(8, crypto.createHmac('sha1', key).update(body).digest())]) : body };
}
function attributes(message) {
  assert.ok(message.length >= 20 && message.length <= 4096 && message.readUInt32BE(4) === 0x2112a442);
  assert.equal(message.readUInt16BE(2) + 20, message.length);
  const attrs = new Map();
  for (let offset = 20; offset < message.length;) {
    assert.ok(offset + 4 <= message.length);
    const type = message.readUInt16BE(offset), length = message.readUInt16BE(offset + 2); offset += 4;
    assert.ok(offset + length <= message.length); attrs.set(type, message.subarray(offset, offset + length)); offset += Math.ceil(length / 4) * 4;
  }
  return attrs;
}
async function allocation(credentials, operation) {
  const socket = dgram.createSocket('udp4'); await new Promise((resolve, reject) => { socket.once('error', reject); socket.connect(Number(target.port), target.hostname, resolve); });
  const exchange = async (method, attrs, key) => {
    const request = packet(method, attrs, key);
    return new Promise((resolve, reject) => {
      let attempts = 0, timer;
      const finish = (error, value) => { clearTimeout(timer); socket.off('message', receive); socket.off('error', fail); error ? reject(error) : resolve(value); };
      const receive = bytes => { if (bytes.length >= 20 && bytes.subarray(8, 20).equals(request.id)) finish(null, bytes); };
      const fail = error => finish(error);
      const send = () => { if (attempts++ === 3) return finish(Error('TURN response timed out')); socket.send(request.bytes, error => { if (error) fail(error); }); timer = setTimeout(send, 1000); };
      socket.on('message', receive); socket.once('error', fail); send();
    });
  };
  let authorization, key;
  try {
    const challenge = await exchange(3, attribute(0x19, Buffer.from([17, 0, 0, 0])));
    assert.equal(challenge.readUInt16BE(0), 0x113, 'anonymous allocation must be refused');
    const attrs = attributes(challenge), code = attrs.get(9); assert.equal(code[2] * 100 + code[3], 401);
    authorization = Buffer.concat([attribute(6, Buffer.from(credentials.username)), attribute(0x14, attrs.get(0x14)), attribute(0x15, attrs.get(0x15))]);
    key = crypto.createHash('md5').update(`${credentials.username}:${attrs.get(0x14).toString()}:${credentials.credential}`).digest();
    const created = await exchange(3, Buffer.concat([authorization, attribute(0x19, Buffer.from([17, 0, 0, 0]))]), key);
    await operation(created, async ip => {
      const value = Buffer.alloc(8); value[1] = 1; value.writeUInt16BE(443 ^ 0x2112, 2);
      const address = ip.split('.').reduce((n, part) => n * 256 + Number(part), 0); value.writeUInt32BE((address ^ 0x2112a442) >>> 0, 4);
      return exchange(8, Buffer.concat([authorization, attribute(0x12, value)]), key);
    });
    if (created.readUInt16BE(0) === 0x103) await exchange(4, Buffer.concat([authorization, attribute(0x0d, number(0))]), key);
  } finally { socket.close(); }
}
await allocation(server, async (created, permission) => {
  assert.equal(created.readUInt16BE(0), 0x103, 'valid account/session credential must allocate');
  for (const ip of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.1.1','172.16.0.1','192.168.0.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1']) {
    const reply = await permission(ip), error = attributes(reply).get(9);
    assert.equal(reply.readUInt16BE(0), 0x118); assert.equal(error[2] * 100 + error[3], 403, `private/reserved peer ${ip} must be refused`);
  }
  assert.equal((await permission('8.8.8.8')).readUInt16BE(0), 0x108, 'public IPv4 must survive IPv6 exclusions');
});
if (settings.expired) await allocation(settings.expired, async created => {
  assert.equal(created.readUInt16BE(0), 0x113); const error = attributes(created).get(9); assert.equal(error[2] * 100 + error[3], 401);
});
console.log('TURN acceptance passed: anonymous/expired grants refused, private/reserved peers refused, public peer permission allowed.');
