// The instance's identity: site settings (lib/site.ts) and brand slots
// (lib/brand-files.ts). brand.ts itself imports .svg components and stays an
// Astro-only module.
import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SITE_DEFAULTS, cardsFromLines, cardsToLines, saveSite, siteInfo, validateCards } from '../src/lib/site.ts';
import { BRAND_DIR, SLOTS, brandFile, brandOverride, isSlot } from '../src/lib/brand-files.ts';

test('siteInfo: defaults until set, empty clears back to them', () => {
  assert.deepEqual(siteInfo(), SITE_DEFAULTS);
  saveSite({ name: '  Frostdev ', tagline: 'Power · Maintenance · Automation', footer: '© Frostdev', cards: [{ title: 'Loothing', blurb: 'Guild tooling' }] });
  assert.deepEqual(siteInfo(), {
    name: 'Frostdev',
    tagline: 'Power · Maintenance · Automation',
    footer: '© Frostdev',
    cards: [{ title: 'Loothing', blurb: 'Guild tooling' }],
    links: true,
  });
  saveSite({ links: false });
  assert.equal(siteInfo().links, false, 'the admin turned public share links off');
  saveSite({ links: true });
  assert.equal(siteInfo().links, true);
  saveSite({ name: '', footer: '', cards: [] });
  assert.equal(siteInfo().name, SITE_DEFAULTS.name);
  assert.equal(siteInfo().footer, '');
  assert.deepEqual(siteInfo().cards, []);
  assert.equal(siteInfo().tagline, 'Power · Maintenance · Automation'); // untouched
});

test('validateCards: bounds and shape', () => {
  assert.throws(() => validateCards(Array.from({ length: 7 }, () => ({ title: 'x', blurb: '' }))), /at most 6/);
  assert.throws(() => validateCards([{ blurb: 'no title' }]), /title required/);
  assert.throws(() => validateCards([{ title: 'x'.repeat(61), blurb: '' }]), /over 60/);
  assert.throws(() => validateCards('nope'), /array/);
  assert.deepEqual(validateCards([{ title: ' A ', blurb: ' b ', extra: 1 }]), [{ title: 'A', blurb: 'b' }]);
});

test('cards round-trip through the admin textarea, a | in the blurb included', () => {
  const cards = [
    { title: 'PMA', blurb: 'Database administration | on call' },
    { title: 'Bare', blurb: '' },
  ];
  const text = cardsToLines(cards);
  assert.equal(text, 'PMA | Database administration | on call\nBare');
  assert.deepEqual(cardsFromLines(text + '\n\n'), cards);
});

test('brand: every slot has a built-in file, an override wins, nothing else is a slot', () => {
  for (const slot of Object.keys(SLOTS) as (keyof typeof SLOTS)[]) {
    assert.equal(brandOverride(slot), null, slot);
    assert.ok(fs.existsSync(brandFile(slot)), `${slot}: ${brandFile(slot)}`);
  }
  fs.mkdirSync(BRAND_DIR, { recursive: true });
  const mine = path.join(BRAND_DIR, 'mark.svg');
  fs.writeFileSync(mine, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal(brandOverride('mark'), mine);
  assert.equal(brandFile('mark'), mine);
  assert.equal(brandOverride('emblem'), null);
  assert.equal(isSlot('..'), false);
  assert.equal(isSlot('constructor'), false);
  assert.equal(isSlot('favicon'), true);
});
