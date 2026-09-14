import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveConfigForm } from '../src/lib/setup.ts';
import { saveConfig } from '../src/lib/app-config.ts';
import { getSetting, setSetting } from '../src/lib/settings.ts';

// The wizard re-posts every field on Continue; saveConfig drops smtp_verified on
// ANY SMTP_* write, so an unchanged (even untrimmed) value must not be a write.
test('a wizard step re-posted unchanged is not a write', () => {
  saveConfig('SMTP_HOST', 'mail.example.invalid', null);
  setSetting('smtp_verified', new Date().toISOString());
  const form = new FormData();
  form.set('SMTP_HOST', 'mail.example.invalid');
  saveConfigForm(form, ['SMTP_HOST'], null);
  assert.ok(getSetting('smtp_verified'), 'Continue over an unchanged field re-locked the email step');
  form.set('SMTP_HOST', '  mail.example.invalid  ');
  saveConfigForm(form, ['SMTP_HOST'], null);
  assert.ok(getSetting('smtp_verified'), 'a pasted trailing space re-locked the email step');
});

