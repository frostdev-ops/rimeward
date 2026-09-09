// Deliberately small overlay on the pinned source; fail on upstream drift.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function patchCua(source) {
  const platform = path.join(source, 'crates/platform-macos/src');
  fs.copyFileSync(fileURLToPath(new URL('./guard.rs', import.meta.url)), path.join(platform, 'rimeward_guard.rs'));
  const replace = (file, from, to) => {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(from)) throw Error(`Pinned Cua source drift: ${file}`);
    fs.writeFileSync(file, text.replace(from, to));
  };
  fs.appendFileSync(path.join(platform, 'lib.rs'), '\npub mod rimeward_guard;\n');
  replace(path.join(platform, 'input/skylight.rs'),
    '    unsafe { post_fn(pid, event_ptr) };',
    '    crate::rimeward_guard::before(pid, event_ptr);\n    unsafe { post_fn(pid, event_ptr) };\n    crate::rimeward_guard::after(pid, event_ptr);');
  // This is a CLASS factory. class_respondsToSelector(cls, sel) checks
  // instances and silently disables keyboard authentication on current macOS.
  replace(path.join(platform, 'input/skylight.rs'),
    'Some(f) => unsafe { f(cls, sel) },',
    'Some(f) => unsafe {\n            type Meta = unsafe extern "C" fn(*mut c_void) -> *mut c_void;\n            match find_sym(b"object_getClass\\0") {\n                Some(p) => f(as_fn::<Meta>(p)(cls), sel), None => false,\n            }\n        },');
  for (const file of ['input/keyboard.rs', 'input/mouse.rs']) {
    const full = path.join(platform, file), before = fs.readFileSync(full, 'utf8');
    const after = before.replace(/(\w+)\.post_to_pid\((pid as libc::pid_t)\)/g, 'crate::rimeward_guard::public_post($2, &$1)');
    if (after === before || after.includes('.post_to_pid(')) throw Error(`Missing guarded posts: ${file}`);
    fs.writeFileSync(full, after);
  }
  replace(path.join(source, 'crates/cua-driver/src/private_worker.rs'), '"ready": true,', '"ready": true, "rimeward_release_guard": 1,');
  replace(path.join(source, 'crates/cua-driver/src/private_worker.rs'),
    '        let response = handle_request(&driver, &mut sessions, &generation, request).await;',
    '        let response = handle_request(&driver, &mut sessions, &generation, request).await;\n        #[cfg(target_os = "macos")]\n        platform_macos::rimeward_guard::clear();');
}
