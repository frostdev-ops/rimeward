// Collect the exact target's Rust dependency notices without embedding build-machine paths.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function rustNotices(manifest, output, target) {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version=1', '--filter-platform', target, '--manifest-path', manifest], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node])), included = new Set();
  const visit = id => { if (included.has(id)) return; included.add(id); for (const dep of nodes.get(id)?.deps ?? []) visit(dep.pkg); };
  visit(metadata.resolve.root);
  const notices = [];
  fs.mkdirSync(output, { recursive: true });
  for (const pkg of metadata.packages.filter(pkg => included.has(pkg.id) && pkg.source)) {
    const root = path.dirname(pkg.manifest_path), destination = path.join(output, `${pkg.name}-${pkg.version}`);
    const files = fs.readdirSync(root).filter(name => /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(name));
    if (pkg.license_file) files.push(pkg.license_file);
    const copied = [];
    for (const name of new Set(files)) {
      const file = path.resolve(root, name);
      if (!file.startsWith(root + path.sep)) throw Error(`License escapes crate: ${pkg.name}`);
      if (!fs.existsSync(file)) continue;
      fs.mkdirSync(destination, { recursive: true });
      fs.cpSync(file, path.join(destination, path.basename(name)), { recursive: true, dereference: true });
      copied.push(path.basename(name));
    }
    let licenseSources;
    if (!copied.length && pkg.license === 'MPL-2.0') {
      // MPL has no package-specific copyright placeholder; use the same unmodified license text.
      const source = metadata.packages.find(p => p.license === 'MPL-2.0' && fs.existsSync(path.join(path.dirname(p.manifest_path), 'LICENSE-MPL-2.0')));
      if (source) {
        fs.mkdirSync(destination, { recursive: true });
        fs.copyFileSync(path.join(path.dirname(source.manifest_path), 'LICENSE-MPL-2.0'), path.join(destination, 'LICENSE-MPL-2.0'));
        copied.push('LICENSE-MPL-2.0');
      }
    }
    if (!copied.length) {
      // Some published crates omit their repository-wide license. These copies are pinned to the crate's commit.
      const vcs = JSON.parse(fs.readFileSync(path.join(root, '.cargo_vcs_info.json'), 'utf8'));
      const bundled = fileURLToPath(new URL('./licenses/', import.meta.url));
      const index = JSON.parse(fs.readFileSync(path.join(bundled, 'sources.json'), 'utf8'));
      const files = index[`${pkg.repository?.replace(/\/$/, '') ?? pkg.name}@${vcs.git.sha1}`] ?? (pkg.license === 'MPL-2.0' ? index['MPL-2.0'] : undefined);
      for (const record of files ?? []) {
        const bytes = fs.readFileSync(path.join(bundled, record.file));
        if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw Error(`License checksum mismatch: ${pkg.name}`);
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, path.basename(record.file)), bytes); copied.push(path.basename(record.file));
      }
      licenseSources = files?.map(file => file.url);
    }
    if (!copied.length) throw Error(`Missing upstream license text: ${pkg.name} ${pkg.version}`);
    notices.push({ name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository,
      source: `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`, authors: pkg.authors, notices: copied, licenseSources });
  }
  fs.writeFileSync(path.join(output, 'index.json'), JSON.stringify(notices, null, 2));
  fs.copyFileSync(path.join(path.dirname(manifest), 'Cargo.lock'), path.join(output, 'Cargo.lock'));
  return notices.length;
}
