//! Transfers hold directory capabilities, so a substituted symlink cannot escape the selected root.
use base64::Engine;
use cap_std::fs::{Dir, File, OpenOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const CHUNK: usize = 4 * 1024 * 1024;
static PROFILE: OnceLock<PathBuf> = OnceLock::new();
// ponytail: disk operations serialize across at most eight transfers; use per-transfer locks if disk latency dominates.
static TRANSFERS: Mutex<Option<HashMap<String, Transfer>>> = Mutex::new(None);
#[derive(Clone, Serialize, Deserialize)]
struct Recovery {
    id: String,
    actor: String,
    root: String,
    path: String,
    source: String,
    size: u64,
    offset: u64,
    digest: String,
    upload: bool,
    modified: u128,
}
struct Transfer {
    record: Recovery,
    session: String,
    expires: u64,
    parent: Dir,
    file: File,
    hash: Sha256,
    validating: Option<u64>,
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing {key}"))
}
fn relative(raw: &str) -> Result<&Path, String> {
    let path = Path::new(raw);
    if raw.len() > 4096
        || raw.contains(['\\', '\0', ':'])
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Choose a relative path inside the selected folder".into());
    }
    Ok(path)
}
fn parent(root: &str, path: &str, create: bool) -> Result<(Dir, String), String> {
    if !Path::new(root).is_absolute() || root.len() > 4096 {
        return Err("Choose an absolute folder path".into());
    }
    let relative = relative(path)?;
    let name = relative
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Missing file name")?
        .to_owned();
    let dir = Dir::open_ambient_dir(root, cap_std::ambient_authority()).map_err(error)?;
    let parent = relative
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if create {
        dir.create_dir_all(parent).map_err(error)?;
    }
    Ok((dir.open_dir(parent).map_err(error)?, name))
}
fn temporary(id: &str) -> String {
    format!(".rimeward-transfer-{id}.part")
}
fn recovery_file(id: &str) -> Result<PathBuf, String> {
    if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid transfer".into());
    }
    Ok(PROFILE
        .get()
        .ok_or("Transfer storage unavailable")?
        .join(format!("{id}.json")))
}
fn recovery(path: &Path) -> Result<Recovery, String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(error)?
        .take(12 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() > 12 * 1024 {
        return Err("Invalid recovery record".into());
    }
    serde_json::from_slice(&bytes).map_err(error)
}
fn save(record: &Recovery) -> Result<(), String> {
    let path = recovery_file(&record.id)?;
    let temp = path.with_extension("new");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(&temp).map_err(error)?;
    f.write_all(&serde_json::to_vec(record).map_err(error)?)
        .map_err(error)?;
    f.sync_all().map_err(error)?;
    std::fs::rename(temp, path).map_err(error)
}
fn modified(file: &File) -> Result<u128, String> {
    Ok(file
        .metadata()
        .map_err(error)?
        .modified()
        .map_err(error)?
        .into_std()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(error)?
        .as_nanos())
}
pub fn initialize(profile: &Path) {
    let directory = profile.join("remote-transfers");
    if std::fs::create_dir_all(&directory).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).is_err()
            {
                return;
            }
        }
        let _ = PROFILE.set(directory);
    }
}
pub fn expire(now: u64, enabled: bool) {
    if let Ok(mut guard) = TRANSFERS.try_lock() {
        if let Some(transfers) = guard.as_mut() {
            // Dropping descriptors leaves only a private recovery record and an unpublished temporary file.
            transfers.retain(|_, t| enabled && t.expires > now);
        }
    }
}
pub fn request(v: &Value, now: u64, enabled: impl Fn() -> bool) -> Result<Value, String> {
    let began = std::time::Instant::now();
    let actor = required(v, "actor")?;
    let session = required(v, "session")?;
    let expires = v["expires"]
        .as_u64()
        .filter(|e| *e > now && *e <= now + 31000)
        .ok_or("Transfer authorization expired")?;
    let authorized = || enabled() && began.elapsed().as_millis() < u128::from(expires - now);
    if !enabled() {
        return Err("Remote access stopped".into());
    }
    let command = required(v, "command")?;
    let mut guard = TRANSFERS.lock().map_err(|_| "Transfers unavailable")?;
    if !authorized() {
        return Err("Transfer authorization expired".into());
    }
    let transfers = guard.get_or_insert_with(HashMap::new);
    transfers.retain(|_, t| t.expires > now);
    if command == "close" {
        transfers.retain(|_, t| t.session != session);
        return Ok(json!({"closed": true}));
    }
    if command == "renew" {
        for t in transfers
            .values_mut()
            .filter(|t| t.actor() == actor && t.session == session)
        {
            t.expires = expires;
        }
        return Ok(json!({"active": transfers.values().filter(|t| t.session == session).count()}));
    }
    if command == "browse" {
        let root = required(v, "root")?;
        if !Path::new(root).is_absolute() || root.len() > 4096 {
            return Err("Choose an absolute folder path".into());
        }
        let directory = Dir::open_ambient_dir(root, cap_std::ambient_authority()).map_err(error)?;
        let path = v["path"].as_str().unwrap_or("");
        let directory = if path.is_empty() {
            directory
        } else {
            directory.open_dir(relative(path)?).map_err(error)?
        };
        let mut entries = Vec::new();
        for entry in directory.entries().map_err(error)?.take(1001) {
            let entry = entry.map_err(error)?;
            let kind = entry.file_type().map_err(error)?;
            if kind.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(".rimeward-transfer-") {
                continue;
            }
            let size = if kind.is_file() {
                entry.metadata().map_err(error)?.len()
            } else {
                0
            };
            entries.push(json!({"name": name, "directory": kind.is_dir(), "size": size}));
        }
        if entries.len() > 1000 {
            return Err(
                "This directory has more than 1000 entries; choose a smaller folder".into(),
            );
        }
        return Ok(json!({"entries": entries}));
    }
    if command == "recoveries" {
        let mut records = Vec::new();
        for entry in std::fs::read_dir(PROFILE.get().ok_or("Transfer storage unavailable")?)
            .map_err(error)?
            .take(1000)
            .flatten()
        {
            if entry.path().extension().is_some_and(|e| e == "json") {
                if let Ok(record) = recovery(&entry.path()) {
                    if record.actor == actor && !transfers.contains_key(&record.id) {
                        records.push(json!(record));
                    }
                    if records.len() >= 256 {
                        break;
                    }
                }
            }
        }
        return Ok(json!({"transfers": records}));
    }
    if command == "create" || command == "resume" {
        if transfers.values().filter(|t| t.session == session).count() >= 2 || transfers.len() >= 8
        {
            return Err("Two transfers may run per session".into());
        }
        let root = required(v, "root")?;
        let path = required(v, "path")?;
        let upload = v["upload"].as_bool().ok_or("Choose upload or download")?;
        let source = required(v, "source")?;
        if source.len() > 512 {
            return Err("Invalid source fingerprint".into());
        }
        let (parent, name) = parent(root, path, upload)?;
        let (mut record, file) = if command == "resume" {
            let id = required(v, "id")?;
            if transfers.contains_key(id) {
                return Err("Transfer already active".into());
            }
            let mut record = recovery(&recovery_file(id)?)?;
            if record.actor != actor
                || record.root != root
                || record.path != path
                || record.upload != upload
                || record.source != source
            {
                return Err("Source or destination changed; start a new transfer".into());
            }
            let file = parent
                .open_with(
                    if upload { temporary(id) } else { name.clone() },
                    OpenOptions::new().read(true).write(upload),
                )
                .map_err(error)?;
            if upload {
                if file.metadata().map_err(error)?.len() < record.offset {
                    return Err("Temporary file changed".into());
                }
            } else if file.metadata().map_err(error)?.len() != record.size
                || modified(&file)? != record.modified
            {
                return Err("Source file changed".into());
            }
            if !upload && !v["offset"].is_null() {
                let offset = v["offset"]
                    .as_u64()
                    .filter(|offset| {
                        *offset <= record.offset
                            && (*offset == record.size || offset % CHUNK as u64 == 0)
                    })
                    .ok_or("Invalid verified download offset")?;
                let digest = required(v, "digest")?;
                if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("Invalid download prefix digest".into());
                }
                record.offset = offset;
                record.digest = digest.to_string();
            }
            (record, file)
        } else {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(error)?;
            let id = random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let file = parent
                .open_with(
                    if upload { temporary(&id) } else { name.clone() },
                    OpenOptions::new()
                        .read(true)
                        .write(upload)
                        .create_new(upload),
                )
                .map_err(error)?;
            if !file.metadata().map_err(error)?.is_file() {
                return Err("Select a regular file".into());
            }
            let size = if upload {
                v["size"]
                    .as_u64()
                    .filter(|n| *n <= 1u64 << 40)
                    .ok_or("Invalid file size")?
            } else {
                file.metadata().map_err(error)?.len()
            };
            let modified = modified(&file)?;
            (
                Recovery {
                    id,
                    actor: actor.to_string(),
                    root: root.to_string(),
                    path: path.to_string(),
                    source: source.to_string(),
                    size,
                    offset: 0,
                    digest: format!("{:x}", Sha256::new().finalize()),
                    upload,
                    modified,
                },
                file,
            )
        };
        let hash = Sha256::new();
        let validating = (command == "resume").then_some(0);
        if validating.is_none() {
            record.modified = modified(&file)?;
            save(&record)?;
        }
        let result = json!({"id": record.id, "offset": record.offset, "size": record.size, "digest": record.digest, "validating":validating.is_some()});
        transfers.insert(
            record.id.clone(),
            Transfer {
                record,
                session: session.to_string(),
                expires,
                parent,
                file,
                hash,
                validating,
            },
        );
        return Ok(result);
    }
    let id = required(v, "id")?;
    let t = transfers
        .get_mut(id)
        .filter(|t| t.session == session && t.actor() == actor)
        .ok_or("Transfer unavailable; reauthorize and resume explicitly")?;
    t.expires = expires;
    if command == "inspect" {
        return Ok(
            json!({"id": id, "offset": t.record.offset, "size": t.record.size, "digest": t.record.digest, "upload": t.record.upload,
                "name": Path::new(&t.record.path).file_name().and_then(|n| n.to_str())}),
        );
    }
    if command == "pause" {
        transfers.remove(id);
        return Ok(json!({"paused": true}));
    }
    if command == "cancel" {
        if t.record.upload {
            t.parent.remove_file(temporary(id)).map_err(error)?;
        }
        std::fs::remove_file(recovery_file(id)?).map_err(error)?;
        transfers.remove(id);
        return Ok(json!({"cancelled": true}));
    }
    if command == "validate" {
        let mut chunk_hash = None;
        if let Some(offset) = t.validating {
            if offset > t.record.offset {
                return Err("Prefix validation failed; restart the transfer".into());
            }
            if !t.record.upload
                && (t.file.metadata().map_err(error)?.len() != t.record.size
                    || modified(&t.file)? != t.record.modified)
            {
                return Err("Source file changed".into());
            }
            let length = (t.record.offset - offset).min(CHUNK as u64) as usize;
            let mut bytes = vec![0; length];
            t.file.read_exact(&mut bytes).map_err(error)?;
            chunk_hash = Some(format!("{:x}", Sha256::digest(&bytes)));
            t.hash.update(&bytes);
            t.validating = Some(offset + length as u64);
            if offset + length as u64 == t.record.offset {
                if format!("{:x}", t.hash.clone().finalize()) != t.record.digest {
                    t.validating = Some(u64::MAX);
                    return Err("Transferred prefix changed; start a new transfer".into());
                }
                if !authorized() {
                    return Err("Transfer authorization ended".into());
                }
                if t.record.upload {
                    t.file.set_len(t.record.offset).map_err(error)?;
                }
                if t.record.upload {
                    t.record.modified = modified(&t.file)?;
                } else if t.file.metadata().map_err(error)?.len() != t.record.size
                    || modified(&t.file)? != t.record.modified
                {
                    return Err("Source file changed".into());
                }
                save(&t.record)?;
                t.validating = None;
            }
        }
        return Ok(
            json!({"validating":t.validating.is_some(), "verified":t.validating.unwrap_or(t.record.offset), "offset":t.record.offset, "size":t.record.size, "digest":t.record.digest, "chunkSha256":chunk_hash}),
        );
    }
    if t.validating.is_some() {
        return Err("Validate the saved prefix before continuing".into());
    }
    if command == "chunk" {
        if v["offset"].as_u64() != Some(t.record.offset) {
            return Err("Offset changed; inspect the transfer before continuing".into());
        }
        let remaining = t.record.size - t.record.offset;
        let bytes = if t.record.upload {
            let raw = required(v, "data")?;
            if raw.len() > 6 * 1024 * 1024 {
                return Err("Chunk exceeds 4 MiB".into());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(raw)
                .map_err(error)?;
            if bytes.is_empty() || bytes.len() > CHUNK || bytes.len() as u64 > remaining {
                return Err("Invalid chunk size".into());
            }
            if format!("{:x}", Sha256::digest(&bytes)) != required(v, "sha256")? {
                return Err("Chunk checksum mismatch".into());
            }
            if let Err(e) = t.file.write_all(&bytes).and_then(|_| t.file.sync_data()) {
                let _ = t.file.set_len(t.record.offset);
                let _ = t.file.seek(SeekFrom::Start(t.record.offset));
                return Err(error(e));
            }
            bytes
        } else {
            if t.file.metadata().map_err(error)?.len() != t.record.size
                || modified(&t.file)? != t.record.modified
            {
                return Err("Source file changed".into());
            }
            let mut bytes = vec![0; remaining.min(CHUNK as u64) as usize];
            t.file.read_exact(&mut bytes).map_err(error)?;
            if t.file.metadata().map_err(error)?.len() != t.record.size
                || modified(&t.file)? != t.record.modified
            {
                return Err("Source file changed during read".into());
            }
            bytes
        };
        t.hash.update(&bytes);
        t.record.offset += bytes.len() as u64;
        t.record.digest = format!("{:x}", t.hash.clone().finalize());
        save(&t.record)?;
        if !authorized() {
            return Err("Remote access stopped; reauthorize before resuming".into());
        }
        return Ok(
            json!({"offset": t.record.offset, "digest": t.record.digest, "sha256": format!("{:x}", Sha256::digest(&bytes)),
            "data": if t.record.upload { None } else { Some(base64::engine::general_purpose::STANDARD.encode(bytes)) }}),
        );
    }
    if command == "finalize" {
        if t.record.offset != t.record.size {
            return Err("Transfer is incomplete".into());
        }
        if !authorized() {
            return Err("Remote access stopped".into());
        }
        let mut name = relative(&t.record.path)?
            .file_name()
            .ok_or("Invalid filename")?
            .to_string_lossy()
            .into_owned();
        if t.record.upload {
            t.file.sync_all().map_err(error)?;
            if !authorized() {
                return Err("Transfer authorization ended before finalization".into());
            }
            let named = t.parent.symlink_metadata(temporary(id)).map_err(error)?;
            let opened = t.file.metadata().map_err(error)?;
            if !named.is_file()
                || opened.len() != t.record.size
                || named.len() != opened.len()
                || named.modified().map_err(error)? != opened.modified().map_err(error)?
            {
                return Err("Temporary file changed; finalization refused".into());
            }
            #[cfg(unix)]
            {
                use cap_std::fs::MetadataExt;
                if named.dev() != opened.dev() || named.ino() != opened.ino() {
                    return Err("Temporary file was substituted".into());
                }
            }
            match v["conflict"].as_str().unwrap_or("skip") {
                "replace" => t
                    .parent
                    .rename(temporary(id), &t.parent, &name)
                    .map_err(error)?,
                "skip" | "keep-both" => {
                    let original = name.clone();
                    let mut n = 1;
                    loop {
                        match t.parent.hard_link(temporary(id), &t.parent, &name) {
                            Ok(()) => {
                                t.parent.remove_file(temporary(id)).map_err(error)?;
                                break;
                            }
                            Err(e)
                                if e.kind() == std::io::ErrorKind::AlreadyExists
                                    && v["conflict"] == "keep-both"
                                    && n < 10000 =>
                            {
                                name = format!("{original} ({n})");
                                n += 1;
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                                t.parent.remove_file(temporary(id)).map_err(error)?;
                                std::fs::remove_file(recovery_file(id)?).map_err(error)?;
                                transfers.remove(id);
                                return Ok(json!({"skipped": true}));
                            }
                            Err(e) => return Err(error(e)),
                        }
                    }
                }
                _ => return Err("Choose Keep both, Skip or Replace".into()),
            }
        }
        let result = json!({"complete": true, "name": name, "sha256": t.record.digest, "size": t.record.size});
        std::fs::remove_file(recovery_file(id)?).map_err(error)?;
        transfers.remove(id);
        return Ok(result);
    }
    Err("Unknown transfer operation".into())
}
impl Transfer {
    fn actor(&self) -> &str {
        &self.record.actor
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transfers_preserve_files_and_validate_authority_paths_chunks_and_resume() {
        let root =
            std::env::temp_dir().join(format!("rimeward-transfer-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        initialize(&root.join("profile"));
        let actor = "a".repeat(64);
        let call = |mut value: Value| {
            value["actor"] = actor.clone().into();
            value["session"] = "test-session".into();
            value["expires"] = 30100.into();
            request(&value, 100, || true)
        };
        let create = |path: &str| {
            call(
                json!({"command":"create", "root":root, "path":path, "upload":true, "size":3, "source":"fixture"}),
            )
        };
        assert!(create("../escape").is_err());
        assert!(create("/escape").is_err());
        assert!(create("a\\..\\escape").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(std::env::temp_dir(), root.join("escape")).unwrap();
            assert!(create("escape/cannot-write").is_err());
        }
        std::fs::write(root.join("original.txt"), b"original").unwrap();
        let first = create("original.txt").unwrap();
        let id = first["id"].as_str().unwrap();
        let bytes = b"new";
        let chunk = json!({"command":"chunk", "id":id, "offset":0, "data":base64::engine::general_purpose::STANDARD.encode(bytes), "sha256":format!("{:x}",Sha256::digest(bytes))});
        let mut bad = chunk.clone();
        bad["sha256"] = "wrong".into();
        assert!(call(bad).is_err());
        assert_eq!(call(chunk.clone()).unwrap()["offset"], 3);
        assert!(call(chunk).is_err());
        assert_eq!(
            std::fs::read(root.join("original.txt")).unwrap(),
            b"original"
        );
        call(json!({"command":"close"})).unwrap();
        let mut resume = json!({"command":"resume","id":id,"root":root,"path":"original.txt","upload":true,"source":"wrong"});
        assert!(call(resume.clone()).is_err());
        resume["source"] = "fixture".into();
        assert_eq!(call(resume).unwrap()["offset"], 3);
        assert_eq!(
            call(json!({"command":"validate","id":id})).unwrap()["chunkSha256"],
            format!("{:x}", Sha256::digest(bytes))
        );
        assert_eq!(
            call(json!({"command":"finalize","id":id,"conflict":"skip"})).unwrap()["skipped"],
            true
        );
        assert_eq!(
            std::fs::read(root.join("original.txt")).unwrap(),
            b"original"
        );
        for conflict in ["keep-both", "replace"] {
            let t = create("original.txt").unwrap();
            call(json!({"command":"chunk","id":t["id"],"offset":0,"data":"bmV3","sha256":format!("{:x}",Sha256::digest(b"new"))})).unwrap();
            assert_eq!(
                call(json!({"command":"finalize","id":t["id"],"conflict":conflict})).unwrap()
                    ["complete"],
                true
            );
        }
        assert_eq!(std::fs::read(root.join("original.txt")).unwrap(), b"new");
        assert_eq!(
            std::fs::read(root.join("original.txt (1)")).unwrap(),
            b"new"
        );
        let t = create("cancelled.txt").unwrap();
        call(json!({"command":"cancel","id":t["id"]})).unwrap();
        assert!(!root.join("cancelled.txt").exists());
        std::fs::create_dir(root.join("blocked")).unwrap();
        std::fs::write(root.join("blocked/existing.txt"), b"keep").unwrap();
        let t = create("blocked").unwrap();
        call(json!({"command":"chunk","id":t["id"],"offset":0,"data":"bmV3","sha256":format!("{:x}",Sha256::digest(b"new"))})).unwrap();
        assert!(call(json!({"command":"finalize","id":t["id"],"conflict":"replace"})).is_err());
        assert_eq!(
            std::fs::read(root.join("blocked/existing.txt")).unwrap(),
            b"keep"
        );
        call(json!({"command":"cancel","id":t["id"]})).unwrap();
        let t = create("damaged.txt").unwrap();
        let id = t["id"].as_str().unwrap();
        call(json!({"command":"chunk","id":id,"offset":0,"data":"bmV3","sha256":format!("{:x}",Sha256::digest(b"new"))})).unwrap();
        call(json!({"command":"close"})).unwrap();
        std::fs::write(root.join(temporary(id)), b"bad").unwrap();
        call(json!({"command":"resume","id":id,"root":root,"path":"damaged.txt","upload":true,"source":"fixture"})).unwrap();
        assert!(call(json!({"command":"validate","id":id})).is_err());
        call(json!({"command":"pause","id":id})).unwrap();
        assert!(!root.join("damaged.txt").exists());
        let download = call(json!({"command":"create","root":root,"path":"original.txt","upload":false,"source":"download-fixture"})).unwrap();
        let id = download["id"].as_str().unwrap();
        let chunk = call(json!({"command":"chunk","id":id,"offset":0})).unwrap();
        assert_eq!(chunk["digest"], format!("{:x}", Sha256::digest(b"new")));
        call(json!({"command":"pause","id":id})).unwrap();
        let mut resume = json!({"command":"resume","id":id,"root":root,"path":"original.txt","upload":false,"source":"download-fixture","offset":0,"digest":format!("{:x}", Sha256::digest(b""))});
        assert_eq!(
            call(resume.clone()).unwrap()["offset"],
            0,
            "a lost reply can be reauthorized from the last locally committed prefix"
        );
        call(json!({"command":"validate","id":id})).unwrap();
        call(json!({"command":"chunk","id":id,"offset":0})).unwrap();
        call(json!({"command":"pause","id":id})).unwrap();
        resume["offset"] = 3.into();
        call(resume.clone()).unwrap();
        assert!(
            call(json!({"command":"validate","id":id})).is_err(),
            "a different local prefix must be refused"
        );
        call(json!({"command":"pause","id":id})).unwrap();
        resume["digest"] = chunk["digest"].clone();
        assert_eq!(call(resume).unwrap()["offset"], 3);
        call(json!({"command":"validate","id":id})).unwrap();
        assert_eq!(
            call(json!({"command":"finalize","id":id})).unwrap()["complete"],
            true
        );
        let stopped = json!({"actor":actor,"session":"test-session","expires":30100,"command":"browse","root":root});
        assert!(request(&stopped, 100, || false).is_err());
        #[cfg(target_os = "linux")]
        if let Some(full) = std::env::var_os("RIMEWARD_TEST_FULL_FS") {
            use std::os::unix::ffi::OsStrExt;
            let full = PathBuf::from(full);
            let path = std::ffi::CString::new(full.as_os_str().as_bytes()).unwrap();
            let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
            assert_eq!(
                unsafe { libc::statfs(path.as_ptr(), stats.as_mut_ptr()) },
                0
            );
            let stats = unsafe { stats.assume_init() };
            assert_eq!(
                stats.f_type,
                libc::TMPFS_MAGIC,
                "disk-full acceptance requires its private tmpfs"
            );
            assert!(stats.f_blocks * stats.f_bsize as u64 <= 32 * 1024 * 1024);
            let full = full.join(format!("rimeward-transfer-{}", std::process::id()));
            std::fs::create_dir(&full).unwrap();
            std::fs::write(full.join("existing.txt"), b"keep").unwrap();
            let t = call(json!({"command":"create","root":full,"path":"existing.txt","upload":true,"size":3,"source":"full-fixture"})).unwrap();
            let mut filler = std::fs::File::create(full.join("filler")).unwrap();
            let bytes = vec![0; CHUNK];
            let failure = (0..9)
                .find_map(|_| filler.write_all(&bytes).err())
                .expect("private tmpfs should fill within 32 MiB");
            assert_eq!(failure.raw_os_error(), Some(libc::ENOSPC));
            let error = call(json!({"command":"chunk","id":t["id"],"offset":0,"data":"bmV3","sha256":format!("{:x}",Sha256::digest(b"new"))})).unwrap_err();
            assert!(error.contains("os error 28"));
            assert_eq!(std::fs::read(full.join("existing.txt")).unwrap(), b"keep");
            assert_eq!(
                call(json!({"command":"inspect","id":t["id"]})).unwrap()["offset"],
                0
            );
            call(json!({"command":"cancel","id":t["id"]})).unwrap();
            drop(filler);
            std::fs::remove_dir_all(full).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
