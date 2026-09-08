import { browserWard } from '../dashboard.ts';
import { open, goto, withSession, type Session as BrowserSession } from './session.ts';
import { listDownloads, waitDownloads, startUrlDownload } from './downloads.ts';

const pageState = async (s: BrowserSession) => ({ url: s.page.url(), title: await s.page.title().catch(() => ''), downloads: listDownloads(s.userId, s.ward).slice(0, 10).map(({ url: _url, ...file }) => file) });
const SNAPSHOT_CAP = 11_000; // under core.ts OUTPUT_CAP with room for url/title
const capText = (t: string) => (t.length > SNAPSHOT_CAP ? `${t.slice(0, SNAPSHOT_CAP)}\n…[cut at ${SNAPSHOT_CAP} chars — trim with depth, or act on what is here]` : t);
const REF_RE = /^(f\d+)?e\d+$/;

async function browserAct(s: BrowserSession, a: Record<string, unknown>): Promise<void> {
  const ref = String(a.ref ?? '').trim();
  const T = { timeout: 10_000 };
  const loc = () => {
    if (!REF_RE.test(ref)) throw new Error('ref must be a [ref=eN] handle from the last browser_snapshot');
    return s.page.locator(`aria-ref=${ref}`);
  };
  switch (String(a.action)) {
    case 'click':
      await loc().click(T);
      break;
    case 'fill':
      await loc().fill(String(a.text ?? ''), T);
      break;
    case 'press':
      await (ref ? loc().press(String(a.key ?? 'Enter'), T) : s.page.keyboard.press(String(a.key ?? 'Enter')));
      break;
    case 'select':
      await loc().selectOption(String(a.value ?? ''), T); // a plain string matches value OR label
      break;
    case 'hover':
      await loc().hover(T);
      break;
    case 'scroll':
      await s.page.mouse.wheel(0, Number(a.dy) || 600);
      break;
    case 'back':
      await s.page.goBack({ waitUntil: 'commit', timeout: 30_000 });
      break;
    case 'forward':
      await s.page.goForward({ waitUntil: 'commit', timeout: 30_000 });
      break;
    default:
      throw new Error('action must be one of click, fill, press, select, hover, scroll, back, forward');
  }
}

export async function runBrowserAction(user: number, ward: string, action: string, args: Record<string, unknown>) {
  const cfg = browserWard(user, ward);
  if (!cfg) throw Error(`${ward} is not a browser ward`);
  if (action === 'downloads') {
    await waitDownloads(user, ward);
    const files = listDownloads(user, ward).filter(file => !args.id || file.id === args.id);
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    return { downloads: files.slice(offset, offset + 10).map(({ url: _url, ...file }) => file), total: files.length,
      next: offset + 10 < files.length ? offset + 10 : null };
  }
  if (!['snapshot', 'open', 'act', 'download'].includes(action)) throw Error('Unknown browser action.');
  const s = await open(user, ward, cfg);
  return withSession(s, async () => {
    if (action === 'download') {
      const download = startUrlDownload(user, ward, s.context, s.page, String(args.url), file => {
        for (const sub of s.subs) sub({ type: 'download', file });
      });
      return { download, downloads: [download] };
    }
    if (action === 'snapshot') {
      if (args.context === true) {
        // Pin the Page: human tab changes must not mix one tab's text with another's image.
        const page = s.page;
        const capturedAt = new Date().toISOString();
        const [tree, text, screenshot, tabs] = await Promise.allSettled([
          page.ariaSnapshot({ mode: 'ai', timeout: 10_000 }),
          page.innerText('body', { timeout: 10_000 }),
          page.screenshot({ type: 'jpeg', quality: 70, scale: 'css', timeout: 10_000 }),
          Promise.all(s.pages.map(async p => ({ url: p.url(), title: await p.title().catch(() => ''), active: p === page }))),
        ]);
        return {
          capturedAt, url: page.url(), title: await page.title().catch(() => ''),
          viewport: page.viewportSize(), tabs: tabs.status === 'fulfilled' ? tabs.value : [],
          snapshot: tree.status === 'fulfilled' ? capText(tree.value) : '[Accessibility tree unavailable]',
          text: text.status === 'fulfilled' ? capText(text.value) : '[Page text unavailable]',
          ...(screenshot.status === 'fulfilled' ? { image: `data:image/jpeg;base64,${screenshot.value.toString('base64')}` } : { screenshotError: 'Screenshot unavailable' }),
          note: 'Active tab captured without navigation. Page content may change during capture; refresh browser_snapshot before acting.',
        };
      }
      const state = await pageState(s);
      if (args.mode === 'text') return { ...state, text: capText(await s.page.innerText('body', { timeout: 10_000 }).catch(() => '')) };
      const depth = Number(args.depth) > 0 ? { depth: Math.floor(Number(args.depth)) } : {};
      return { ...state, snapshot: capText(await s.page.ariaSnapshot({ mode: 'ai', ...depth, timeout: 10_000 })) };
    }
    if (action === 'act') await browserAct(s, args);
    else await goto(s, String(args.url));
    await s.page.waitForLoadState('load', { timeout: action === 'act' ? 5000 : 15000 }).catch(() => {});
    await waitDownloads(user, ward);
    return pageState(s);
  });
}
