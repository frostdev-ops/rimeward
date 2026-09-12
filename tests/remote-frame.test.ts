import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { REMOTE_FRAME_MS, remoteFrame } from '../src/lib/browser/remote-frame.ts';

const jpeg = async (width: number, height: number) => (await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg({ quality: 90 }).toBuffer()).toString('base64');

test('remoteFrame: a Retina frame comes down to CSS size, a 1× frame is never enlarged, junk passes through', async () => {
  const retina = await remoteFrame({ type: 'frame', data: await jpeg(800, 600), width: 400, height: 300 });
  const meta = await sharp(Buffer.from(retina.data, 'base64')).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 300);
  assert.equal(retina.width, 400, 'the CSS viewport rides along unchanged');
  assert.ok(retina.data.length < (await jpeg(800, 600)).length, 'fewer bytes');
  const flat = await remoteFrame({ type: 'frame', data: await jpeg(400, 300), width: 400, height: 300 });
  const flatMeta = await sharp(Buffer.from(flat.data, 'base64')).metadata();
  assert.equal(flatMeta.width, 400);
  const junk = await remoteFrame({ type: 'frame', data: 'bm90IGEganBlZw==', width: 10, height: 10 });
  assert.equal(junk.data, 'bm90IGEganBlZw==', 'unreadable input is sent as it came');
  assert.ok(REMOTE_FRAME_MS >= 100, 'at most ten frames a second over the relay');
});
