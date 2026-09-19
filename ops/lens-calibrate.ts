// `node ops/lens-calibrate.ts --user <id>` — measures the `for` prefilter for
// whatever is embedding on this machine and writes its calibration row
// (`lens_calibration:<embedderId>`), which is what lets a `for` watch run at
// all (lens/gate.ts).
//
// Lifted from BlackIce tests/calibrate.ts: the same twelve intents a consumer
// would plausibly watch for, each with realistic synthetic changed-line sets
// that should match (positives) and every other intent's sets plus generic UI
// noise that should not (negatives); the same four score variants; the same
// product rule. The one change is the embedder: instead of BlackIce's probe
// binary it asks `deciderFor(user).embed`, so whichever tower this machine
// actually judges with (the bundled MobileCLIP helper, llama.cpp, a paired
// runtime, a cloud embedding provider) is the one measured.
//
// The product rule: the cosine is a prefilter in front of triage, so the
// operating point is fixed at FN <= 5 % and the threshold is the one with the
// lowest FP there; whatever FP remains is triage calls, not deliveries. The
// variant with the lowest FP at that point wins. When triage cannot answer, a
// `for` watch runs on the cosine alone at the same threshold and reports
// `evaluation: 'weak'`.
//
// Nothing here has ever been on a real screen.
// ponytail: no vector cache — a re-run re-embeds. This is a manual, occasional
// script; add one if a slow runtime ever makes that hurt.

import { cosine, lineTexts, saveCalibration, watchText } from '../src/lib/lens/gate.ts';
import type { ScoreVariant } from '../src/lib/lens/gate.ts';
import { deciderFor } from '../src/lib/lens/decider.ts';
import type { Decider } from '../src/lib/lens/core.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--user');
const user = at < 0 ? 1 : Number(args[at + 1]);
if (!Number.isInteger(user) || user <= 0) throw Error('Usage: node ops/lens-calibrate.ts --user <id>');

const FROM = 0.5;
const TO = 0.98;
const STEP = 0.005;
const FN_TARGET = 0.05;
const FP_TARGET = 0.02;
const VARIANTS: ScoreVariant[] = ['raw', 'set', 'template', 'template-set'];
/** FP points a variant must save at the operating point to displace `raw`. */
const VARIANT_MARGIN = 0.02;
/** One embed call per this many texts: a local llama-server is happier in bites. */
const BATCH = 32;

interface Intent {
  name: string;
  /** What the consumer wrote in `lens_watch({ for })`. */
  intent: string;
  /** Changed-line sets that should fire. */
  positives: string[][];
}

// -------------------------------------------------------------------- corpus

const INTENTS: Intent[] = [
  {
    name: 'build-error',
    intent: 'a build error appeared',
    positives: [
      ['error[E0308]: mismatched types', '  --> src/lens/gate.rs:214:9'],
      ['error: could not compile `blackice` (bin "blackice") due to 3 previous errors'],
      ['Build failed: 3 errors, 1 warning'],
      ['error[E0425]: cannot find value `forThreshold` in this scope'],
      ['BUILD FAILED', 'The following build commands failed:'],
      ['error TS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.'],
      ['✖ compilation failed after 4.2s'],
      ['error: linking with `cc` failed: exit status: 1'],
      ['Failed to compile.', './src/lens/scene.ts', 'Syntax error: Unexpected token'],
      ['error[E0599]: no method named `freeze` found for struct `SceneState`'],
      ['swift build: error: value of type \'Signal\' has no member \'dirty\''],
      ['2 errors generated.'],
      ['error: expected `;`, found `}`'],
      ['ERROR in ./src/lens/events.ts', 'Module build failed'],
      ['cargo clippy: error: this expression creates a reference which is immediately dereferenced'],
      ['error: aborting due to 1 previous error'],
    ],
  },
  {
    name: 'error-dialog',
    intent: 'an error dialog appeared',
    positives: [
      ['Something went wrong', 'Please try again later', 'OK'],
      ['Unable to open the document.', 'The file may be damaged.', 'OK'],
      ['Error', 'The operation could not be completed.', 'Dismiss'],
      ['Connection failed', 'Check your network settings and retry.', 'Retry', 'Cancel'],
      ['An unexpected error occurred (code 5031)', 'OK'],
      ['Permission denied', 'You do not have access to this folder.', 'OK'],
      ['The application quit unexpectedly.', 'Reopen', 'Report…'],
      ['Could not save changes', 'The disk is full.', 'OK'],
      ['Warning: this action cannot be undone', 'Continue', 'Cancel'],
      ['Sync error', 'Your last change was not uploaded.', 'Try again'],
      ['Invalid certificate', 'The server identity could not be verified.', 'Cancel'],
      ['Out of memory', 'Close some windows and try again.', 'OK'],
      ['Operation timed out', 'The server did not respond in time.', 'OK'],
      ['Failed to load project', 'The workspace file is unreadable.', 'Close'],
      ['Alert: the export did not finish', 'OK'],
      ['We could not process that request.', 'Dismiss'],
    ],
  },
  {
    name: 'payment-total',
    intent: 'the payment total changed',
    positives: [
      ['Order total $118.20', 'Subtotal $109.00'],
      ['Total: $2,418.75'],
      ['Amount due 640.00 USD'],
      ['Grand total £84.50', 'Shipping £4.99'],
      ['invoice 0042 total 118.20'],
      ['Total charged to card ending 6411: $51.25'],
      ['Balance owing: $0.00'],
      ['Cart subtotal updated to $77.40'],
      ['Tax $9.64', 'Total $128.09'],
      ['You will be charged €212.00 monthly'],
      ['Refund amount $31.10'],
      ['Estimated total at checkout: $1,004.99'],
      ['Payment of $450.00 scheduled'],
      ['Total (3 items) $62.97'],
      ['Due today $0.00', 'Due Nov 1 $29.00'],
      ['Invoice 8812 amount 3,200.00 AUD'],
    ],
  },
  {
    name: 'test-run-finished',
    intent: 'a test run finished',
    positives: [
      ['Test Suites: 14 passed, 14 total', 'Tests: 212 passed, 212 total'],
      ['test result: ok. 96 passed; 0 failed; 2 ignored'],
      ['ℹ pass 41', 'ℹ fail 0', 'ℹ duration_ms 812.4'],
      ['Executed 58 tests, with 0 failures in 3.114 seconds'],
      ['All tests passed in 12.8s'],
      ['1 failing', '41 passing (2s)'],
      ['test result: FAILED. 94 passed; 2 failed'],
      ['Ran 120 tests in 4.02s', 'OK'],
      ['✔ every fixture replays with no failures (64ms)'],
      ['Coverage: 84.1% of statements', 'Tests finished'],
      ['PASS tests/gate.test.ts'],
      ['Finished test [unoptimized + debuginfo] target(s) in 9.41s'],
      ['Test run complete: 0 failures'],
      ['3 suites, 61 tests, 0 skipped — done'],
      ['swift test: Executed 22 tests, with 0 failures'],
      ['✗ 2 of 88 checks failed', 'Test run ended'],
    ],
  },
  {
    name: 'new-chat-message',
    intent: 'a new chat message arrived',
    positives: [
      ['Dana Whitlock', 'can you look at the gate thresholds today?'],
      ['#lens-dev', 'Priya: pushed the snapshot fix, please pull'],
      ['New message from Ari Solberg'],
      ['Marco: standup moved to 10:15'],
      ['3 unread messages'],
      ['Direct message · Kim Tran · 2m ago'],
      ['Tomas replied to your thread'],
      ['@here the staging build is back up'],
      ['Nina: I left comments on the fixture format'],
      ['You were mentioned in #release'],
      ['Chat · Jo Hazel · are you free for 10 minutes?'],
      ['Sam sent an attachment: notes.md'],
      ['New reply in "gate thresholds"'],
      ['Reyna: done, merged'],
      ['Group chat · 2 new · Design review'],
      ['Message from Wren Adeyemi: ping me when the replay lands'],
    ],
  },
  {
    name: 'file-saved',
    intent: 'the file was saved',
    positives: [
      ['gate.rs — Saved'],
      ['All changes saved'],
      ['Saved to ~/Documents/notes.md'],
      ['Document saved at 14:32'],
      ['scene.ts', 'Saved just now'],
      ['Autosaved'],
      ['Changes written to disk'],
      ['Saving… done'],
      ['notes.md (saved)'],
      ['Last saved 2 seconds ago'],
      ['File written: 42 KB'],
      ['Draft saved'],
      ['Saved · no unsaved changes'],
      ['events.ts — up to date'],
      ['Your edit was saved'],
      ['Saved 1 file'],
    ],
  },
  {
    name: 'download-finished',
    intent: 'a download finished',
    positives: [
      ['blackice-0.1.0.dmg', 'Download complete'],
      ['Downloaded 52.4 MB of 52.4 MB'],
      ['node-v24.6.0-darwin-arm64.tar.gz — finished'],
      ['1 download completed'],
      ['Saved to Downloads: report.pdf'],
      ['Download finished in 12s'],
      ['fixtures.zip · Done'],
      ['Transfer complete (100%)'],
      ['Finished downloading 3 files'],
      ['Your export is ready to download'],
      ['Downloads · 1 item · complete'],
      ['Received 18.2 MB — done'],
      ['calibration.json downloaded'],
      ['Download succeeded'],
      ['Completed: helper.pkg'],
      ['Done — 4 of 4 files downloaded'],
    ],
  },
  {
    name: 'login-prompt',
    intent: 'a login prompt appeared',
    positives: [
      ['Sign in to continue', 'Email', 'Password', 'Sign in'],
      ['Your session expired. Please log in again.'],
      ['Enter your password for admin@frostdev.io'],
      ['Two-factor authentication required', 'Enter the 6-digit code'],
      ['Log in', 'Forgot password?'],
      ['Authentication needed to continue'],
      ['Keychain wants to use your login password'],
      ['Sign in with your work account'],
      ['You have been signed out'],
      ['Authorize this device', 'Approve', 'Deny'],
      ['Username', 'Password', 'Remember me'],
      ['Please authenticate to view this page'],
      ['Login required for the staging environment'],
      ['Session timed out — sign in again'],
      ['Verify it is you', 'Send code'],
      ['Access token expired, re-authenticate'],
    ],
  },
  {
    name: 'merge-conflict',
    intent: 'a merge conflict appeared',
    positives: [
      ['CONFLICT (content): Merge conflict in src/lens/gate.ts'],
      ['Automatic merge failed; fix conflicts and then commit the result.'],
      ['<<<<<<< HEAD', '=======', '>>>>>>> feature/replay'],
      ['2 conflicting files', 'Resolve in editor'],
      ['error: Your local changes would be overwritten by merge'],
      ['Rebase stopped at 3f1a2bd — conflicts to resolve'],
      ['Merge conflict in tests/replay.ts'],
      ['Both modified: src/lens/scene.ts'],
      ['This branch has conflicts that must be resolved'],
      ['git status: Unmerged paths'],
      ['CONFLICT (modify/delete): migrations/002_consumer_counter.sql'],
      ['Cannot merge: 4 conflicting hunks'],
      ['Conflicts detected, merge aborted'],
      ['Resolve conflicts before continuing the rebase'],
      ['Incoming change / Current change / Accept both'],
      ['Merge blocked by conflicts in 1 file'],
    ],
  },
  {
    name: 'deployment-done',
    intent: 'a deployment finished',
    positives: [
      ['Deployment succeeded', 'Production · 2m 14s'],
      ['Deployed blackice@0.1.0 to staging'],
      ['Release complete — live in production'],
      ['Rollout finished: 4 of 4 instances healthy'],
      ['Deploy #812 succeeded'],
      ['Shipped to prod at 14:32 UTC'],
      ['Deployment failed at step "migrate"'],
      ['Published to the update channel'],
      ['All checks passed, deploy promoted'],
      ['Canary complete, traffic at 100%'],
      ['Build 4421 deployed'],
      ['Environment updated: staging now on 0.1.0'],
      ['Deploy finished in 96s'],
      ['Service restarted after deploy'],
      ['Rollback complete — deployment reverted'],
      ['Deployment status: Done'],
    ],
  },
  {
    name: 'calendar-reminder',
    intent: 'a calendar reminder appeared',
    positives: [
      ['Design review in 10 minutes', 'Join'],
      ['Reminder: standup at 10:15'],
      ['Upcoming · 1:1 with Dana · 15:00'],
      ['Event starts in 5 minutes'],
      ['Notification · Calendar · Sprint planning'],
      ['Meeting now: Lens architecture'],
      ['You have a call in 2 minutes'],
      ['Reminder · Submit timesheet · today'],
      ['Alarm: take a break'],
      ['Calendar: 3 events today'],
      ['Starting soon — Retrospective (30 min)'],
      ['Don\'t forget: release checkpoint at 16:00'],
      ['Tomorrow 09:00 · Onboarding'],
      ['Snooze · Dismiss · Join meeting'],
      ['Reminder for "send the calibration numbers"'],
      ['Your next event begins at 11:30'],
    ],
  },
  {
    name: 'form-validation-error',
    intent: 'a form validation error appeared',
    positives: [
      ['Email is required'],
      ['Please enter a valid email address'],
      ['Password must be at least 12 characters'],
      ['This field cannot be empty'],
      ['Card number is invalid'],
      ['Passwords do not match'],
      ['Enter a number between 1 and 60'],
      ['Select at least one option'],
      ['Postcode is not recognised'],
      ['That username is already taken'],
      ['Invalid date format (YYYY-MM-DD)'],
      ['3 fields need your attention'],
      ['Phone number must include an area code'],
      ['Value out of range'],
      ['Please accept the terms to continue'],
      ['Required · Company name'],
    ],
  },
];

/** Changed-line sets no watch should ever fire on. */
const NOISE: string[][] = [
  ['fn render(scene: Scene) -> String {'],
  ['  let total = subtotal + tax + shipping;'],
  ['import path from \'node:path\';'],
  ['line 07 quartz falcon'],
  ['  // basalt condor, see the ring buffer note'],
  ['export const DELIVERY_CAP = 11_800;'],
  ['File  Edit  Selection  View  Go  Run  Help'],
  ['gate.rs  scene.rs  events.rs  +3'],
  ['14:32:18'],
  ['Untitled-1'],
  ['Ln 214, Col 9  Spaces: 2  UTF-8  LF  TypeScript'],
  ['main ↑2 ↓0'],
  ['Search results (18)'],
  ['Zoom 125%'],
  ['Battery 84%  Wi-Fi  Bluetooth'],
  ['Yesterday  ·  Last 7 days  ·  Last 30 days'],
  ['Drag a file here to attach it'],
  ['Showing 1–25 of 412'],
  ['  emit(total);'],
  ['Sort by: Name  Size  Date modified'],
  ['README.md  package.json  tsconfig.json'],
  ['Preferences  ›  Appearance  ›  Theme'],
  ['plover agate lumen kestrel'],
  ['const words = [\'quartz\', \'falcon\'];'],
  ['Scale 2×   1800 × 1169'],
  ['Untracked files: tests/fixtures/'],
];

// ------------------------------------------------------------------- vectors

/** Every text the variants need, in one pass through this user's embedder. */
async function embedAll(texts: string[], decider: Decider): Promise<Map<string, number[]>> {
  const embed = decider.embed;
  const id = decider.embedderId;
  if (!embed || !id) {
    console.error(
      'lens-calibrate: nothing on this runtime can embed. Set an embedder up under ' +
        'Account → Agent → Semantic retrieval (or start the desktop app so the lens helper loads).\n' +
        'Nothing was written.'
    );
    process.exit(1);
  }
  console.log(`embedding ${texts.length} texts through ${id} …`);
  const out = new Map<string, number[]>();
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const vectors = await embed(batch);
    if (vectors === null || vectors.length !== batch.length) {
      console.error(`lens-calibrate: ${id} stopped answering after ${i} texts. Nothing was written.`);
      process.exit(1);
    }
    for (const [n, text] of batch.entries()) out.set(text, vectors[n] as number[]);
    if (process.stdout.isTTY) process.stdout.write(`\r  ${Math.min(i + BATCH, texts.length)}/${texts.length}`);
  }
  return out;
}

// ------------------------------------------------------------------- scoring

/** The chance a positive set scores above a negative one; ties count a half. */
function auc(positives: number[], negatives: number[]): number {
  const sorted = [...negatives].sort((a, b) => a - b);
  const countBelow = (value: number, orEqual: boolean): number => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const at2 = sorted[mid] ?? 0;
      if (orEqual ? at2 <= value : at2 < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  let total = 0;
  for (const p of positives) {
    const below = countBelow(p, false);
    total += below + (countBelow(p, true) - below) / 2;
  }
  return total / (positives.length * negatives.length);
}

const fixed = (n: number): string => n.toFixed(3);
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

interface Scan {
  rows: { t: number; fn: number; fp: number }[];
  positives: number[];
  negatives: number[];
}

function scanSpace(score: (intent: string, set: string[]) => number): Scan {
  const perIntent = INTENTS.map((intent) => {
    const positives = intent.positives.map((set) => score(intent.intent, set)).sort((a, b) => a - b);
    const negatives = [
      ...INTENTS.filter((other) => other.name !== intent.name).flatMap((other) => other.positives),
      ...NOISE,
    ]
      .map((set) => score(intent.intent, set))
      .sort((a, b) => a - b);
    return { positives, negatives };
  });
  const positives = perIntent.flatMap((r) => r.positives);
  const negatives = perIntent.flatMap((r) => r.negatives);
  const rows: Scan['rows'] = [];
  for (let t = FROM; t <= TO + 1e-9; t += STEP) {
    rows.push({
      t: Number(t.toFixed(3)),
      fn: positives.filter((s) => s < t).length / positives.length,
      fp: negatives.filter((s) => s >= t).length / negatives.length,
    });
  }
  return { rows, positives, negatives };
}

/** The operating point: FN <= 5 % with the lowest FP there; if no threshold
 *  reaches it, the lowest FN in range. */
function choose(scan: Scan): { t: number; fn: number; fp: number; why: 'both' | 'fn-first' | 'best-fn' } {
  const withinFn = scan.rows.filter((row) => row.fn <= FN_TARGET);
  if (withinFn.length > 0) {
    const best = withinFn.reduce((a, b) => (b.fp < a.fp ? b : a));
    return { ...best, why: best.fp <= FP_TARGET ? 'both' : 'fn-first' };
  }
  const loosest = scan.rows.reduce((a, b) => (b.fn < a.fn || (b.fn === a.fn && b.fp < a.fp) ? b : a));
  return { ...loosest, why: 'best-fn' };
}

export async function calibrate(who: number = user, decider: Decider = deciderFor(who)): Promise<void> {
  const sets = [...INTENTS.flatMap((i) => i.positives), ...NOISE];
  const phrases = INTENTS.map((i) => i.intent);
  const texts = new Set<string>();
  for (const variant of VARIANTS) {
    for (const phrase of phrases) texts.add(watchText(phrase, variant));
    for (const set of sets) for (const text of lineTexts(set, variant)) texts.add(text);
  }
  const vectors = await embedAll([...texts].sort(), decider);
  const vec = (text: string): number[] => vectors.get(text) ?? [];

  const results = VARIANTS.map((variant) => {
    const score = (intent: string, set: string[]): number => {
      const target = vec(watchText(intent, variant));
      let top = -1;
      for (const text of lineTexts(set, variant)) top = Math.max(top, cosine(vec(text), target));
      return top;
    };
    const scan = scanSpace(score);
    return { variant, scan, chosen: choose(scan), auc: auc(scan.positives, scan.negatives) };
  });

  console.log('\nvariant        AUC     threshold   FN      FP     (at FN <= 5 %, lowest FP)');
  for (const r of results) {
    console.log(
      `${r.variant.padEnd(14)} ${fixed(r.auc)}   ${fixed(r.chosen.t)}      ${pct(r.chosen.fn).padStart(6)}  ${pct(r.chosen.fp).padStart(6)}${r.chosen.why === 'best-fn' ? '   (FN target not reached)' : ''}`
    );
  }

  // `raw` is the baseline: one embed per changed line, no prefix. Another
  // variant replaces it only when it lowers FP at the operating point by a
  // margin worth its extra embed or its templating.
  const best = results.reduce((a, b) => {
    const aMet = a.chosen.why !== 'best-fn';
    const bMet = b.chosen.why !== 'best-fn';
    if (aMet !== bMet) return aMet ? a : b;
    return b.chosen.fp <= a.chosen.fp - VARIANT_MARGIN ? b : a;
  });
  const { scan, chosen } = best;

  console.log(
    `\nchosen ${best.variant} forThreshold ${fixed(chosen.t)}: FN ${pct(chosen.fn)} (target <= ${pct(FN_TARGET)}), ` +
      `FP ${pct(chosen.fp)} (plan target <= ${pct(FP_TARGET)}), AUC ${fixed(best.auc)}, over ${scan.positives.length} positive and ` +
      `${scan.negatives.length} negative changed-line sets`
  );
  if (chosen.why !== 'both') {
    console.log(
      'The FP target is not met by any variant: the cosine is a prefilter, triage decides, and the FP above is the ' +
        'share of unrelated changes that cost a triage call. A `for` watch without triage runs at this threshold ' +
        "and reports `evaluation: 'weak'`."
    );
  }

  const embedderId = decider.embedderId as string;
  const payload = {
    forThreshold: chosen.t,
    visualThreshold: 0.15,
    liveThreshold: 0.05,
    score: best.variant,
    at: new Date().toISOString(),
    auc: Number(best.auc.toFixed(4)),
    fn: Number(chosen.fn.toFixed(4)),
    fp: Number(chosen.fp.toFixed(4)),
    n: scan.positives.length + scan.negatives.length,
  };
  saveCalibration(embedderId, payload);
  console.log(`\nwrote lens_calibration:${embedderId} ${JSON.stringify(payload)}`);
}

// Imported by the test, run by the operator.
if (process.argv[1]?.endsWith('lens-calibrate.ts')) await calibrate();
