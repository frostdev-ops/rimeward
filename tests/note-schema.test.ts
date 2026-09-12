import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanStyle, plainText, sanitizeHtml } from '../src/lib/note-text.ts';
import { docToHtml, docToJSON, htmlToDoc, jsonToDoc } from '../src/lib/note-pm.ts';

/** Normal form: what the codec makes of an input, and the property that it is stable. */
const normal = (html: string): string => docToHtml(htmlToDoc(html));
const fixed = (html: string, label = html) => {
  const once = normal(html), twice = normal(once);
  assert.equal(twice, once, `not a fixed point: ${label}`);
  return once;
};

test('cleanStyle: the sanitizer and the schema share one style allowlist', () => {
  assert.equal(cleanStyle('text-align: Center; color:#FF0000; font-family:"Georgia"; position:absolute; font-size:14pt'), 'text-align:center;color:#ff0000;font-family:georgia;font-size:14pt');
  assert.equal(cleanStyle('background:url(x)'), '');
  assert.equal(sanitizeHtml('<p style="text-align:right;top:0">x</p>'), '<p style="text-align:right">x</p>');
});

test('every construct the sanitizer keeps survives the codec, and the codec is a fixed point', () => {
  const cases = [
    '<p>plain</p>',
    '<p><b>bold</b> <i>it</i> <u>u</u> <s>s</s> <sub>a</sub><sup>b</sup> <code>c</code> <mark>hl</mark></p>',
    '<p><strong>strong</strong> <em>em</em> <strike>old</strike> <del>gone</del></p>',
    '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>4</h4><h5>5</h5><h6>6</h6>',
    '<blockquote><p>quoted</p></blockquote><pre>code\n  indented</pre><hr>',
    '<ul><li><p>a</p></li><li><p>b</p><ul><li><p>nested</p></li></ul></li></ul>',
    '<ol start="3" type="a"><li><p>c</p></li></ol>',
    '<p><a href="https://example.com/x?y=1&amp;z=2">link</a> <a data-note="abc-123">note</a></p>',
    '<p><img src="https://example.com/i.png" alt="an image" style="max-width:100%;height:auto"></p>',
    '<p><input type="checkbox" disabled checked> done <input type="checkbox" disabled> todo</p>',
    '<table style="width:100%"><tbody><tr><th colspan="2">h</th></tr><tr><td><p>a</p></td><td style="width:20%"><p>b</p></td></tr><tr><td rowspan="2"><p>tall</p></td><td><p>c</p></td></tr></tbody></table>',
    '<p style="text-align:center;line-height:1.5;margin-top:6pt;margin-left:24px;text-indent:12.7mm">styled block</p>',
    '<p><span style="font-family:georgia;font-size:14pt">run</span> <span style="color:#ff0000"><span style="background-color:#fff199">nested</span></span></p>',
    '<p><mark data-comment="fix this" data-author="Ann">passage</mark></p>',
    '<p>before <ins data-change="c1" data-author="Ann">added</ins><del data-change="c1" data-author="Ann">removed</del> after</p>',
    '<section data-word-page="a4-landscape" style="width:297mm;padding:20mm"><header data-word-header="true"><p>Head</p></header><p>Body <span data-page-number="true">1</span></p><footer data-word-footer="true"><p>Foot</p></footer></section>',
    '<section data-word-page="letter-portrait" style="page-break-before:always"><p>page two</p></section>',
    '<div style="padding:4px"><p>in a div</p></div><section><p>in a section</p></section>',
    '<p>a &lt; b &amp;&amp; c &gt; d</p>',
    '<p>line<br>break</p>',
  ];
  for (const html of cases) {
    const out = fixed(html);
    assert.equal(plainText(out).replace(/\s+/g, ' '), plainText(sanitizeHtml(html)).replace(/\s+/g, ' '), `text lost: ${html}`);
  }
  // Exact round trips where the sanitizer's own output is already the schema's normal form.
  for (const html of [
    '<p><b>bold</b> <i>it</i></p>',
    '<h2 style="text-align:center">Two</h2>',
    '<ol start="3" type="a"><li><p>c</p></li></ol>',
    '<p><mark data-comment="fix this" data-author="Ann">passage</mark></p>',
    '<p><ins data-change="c1" data-author="Ann">added</ins></p>',
    '<table style="width:100%"><tbody><tr><td colspan="2"><p>a</p></td></tr></tbody></table>',
    '<section data-word-page="a4-landscape" style="width:297mm;padding:20mm"><p>Body</p></section>',
  ]) assert.equal(normal(html), sanitizeHtml(html), `changed by the codec: ${html}`);
});

test('legacy shapes normalise: bare inline text becomes paragraphs, thead rows join the body, unknown tags vanish', () => {
  assert.equal(normal('hello <b>there</b>'), '<p>hello <b>there</b></p>');
  assert.equal(normal('<div>text</div>'), '<div><p>text</p></div>');
  assert.equal(normal('<li>bare</li>'), '<ul><li><p>bare</p></li></ul>');
  assert.equal(normal('<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table>'), '<table><tbody><tr><th><p>h</p></th></tr><tr><td><p>x</p></td></tr></tbody></table>');
  assert.equal(normal('<p><font color="red">f</font><script>x</script></p>'), '<p>fx</p>', 'the sanitizer drops the tags and keeps their text');
  assert.equal(normal(''), '<p></p>');
});

test('a document survives JSON (what the shared Yjs document carries)', () => {
  const html = '<h1>T</h1><p style="text-align:right"><span style="color:#ff0000">red</span> <a data-note="n-1">n</a></p><ul><li><p>x</p></li></ul>';
  const doc = htmlToDoc(html);
  assert.equal(docToHtml(jsonToDoc(docToJSON(doc))), docToHtml(doc));
  assert.equal(docToHtml(doc), html);
});
