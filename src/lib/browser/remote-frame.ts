// A browser ward's frame for a viewer beyond the relay. The screencast is JPEG at
// the Chromium process scale (Retina: four times the CSS pixels) at 20 fps, which
// the owner's loopback socket carries for free and a home upload cannot: every
// frame crosses the device channel as base64 inside JSON, so a viewer on the
// server queued seconds behind. Over the relay the desktop sends frames at CSS
// size, quality 50, at most eight a second — about a tenth of the bytes. The
// client derives the scale from bitmap width over CSS width, so a frame exactly
// CSS-wide reads as scale 1 and input lands where it should.
import sharp from 'sharp';

export const REMOTE_FRAME_MS = 125;
export const REMOTE_QUALITY = 50;

export interface FrameEvent { type: 'frame'; data: string; width: number; height: number }

/** The frame at CSS size and remote quality; the original when it cannot be read. */
export async function remoteFrame(ev: FrameEvent): Promise<FrameEvent> {
  try {
    const out = await sharp(Buffer.from(ev.data, 'base64'))
      .resize({ width: ev.width, height: ev.height, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: REMOTE_QUALITY })
      .toBuffer();
    return { ...ev, data: out.toString('base64') };
  } catch {
    return ev;
  }
}
