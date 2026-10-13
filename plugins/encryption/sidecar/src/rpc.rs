//! The app's native sidecar protocol (`plugins/sidecar.rs` in the app):
//! newline-delimited JSON-RPC 2.0 over stdin/stdout. The host sends
//! requests with numeric ids and matches responses by id, so requests are
//! answered on their own threads (a decrypt waiting on pinentry doesn't
//! hold up `status`). Nothing is written to stderr: the app keeps a
//! sidecar's stderr in a log the settings page shows, and nothing a method
//! touches belongs there.
//!
//! Methods (params → result):
//!
//! - `status` `{}` → `{gpgPath, version, supported, agentRunning}`, or
//!   `{gpgNotFound: true, searched: [dir]}`
//! - `secretFingerprints` `{}` → `[{fpr, uids, canEncrypt, canSign, expired, revoked}]`
//! - `importPublic` `{armored}` → the same shape, for the keys imported
//!   into the plugin keyring
//! - `encrypt` `{plaintext, recipients: [fpr], signer: fpr}` → `{armored}`
//! - `decrypt` `{armored, allowedSigners: [fpr]}` → `{plaintext, signer}`,
//!   plus `signerExpired: true` when the signer's key has expired since it
//!   signed (a signature made after the expiry, or by a revoked key, is
//!   refused)
//!
//! Whole-vault encryption (git-crypt's scheme, see [`crate::vault`]); `vault`
//! is the vault's absolute path, a directory with a `.git`:
//!
//! - `vaultStatus` `{vault}` → `{encrypted, unlocked, keyNames, members: [fpr]}`
//! - `unlockVault` `{vault}` → `{member, alreadyUnlocked}`
//! - `lockVault` `{vault}` → `{wasUnlocked}`
//! - `initVault` `{vault, members: [fpr]}` → `{paths, gitattributes}`
//! - `addVaultMember` `{vault, fpr}` → `{paths}`
//! - `removeVaultMember` `{vault, fpr}` → `{paths}`
//!
//! An error's message starts with a stable code: `gpgNotFound`,
//! `invalidParams`, `tooLarge`, `timeout`, `cancelled`, `noSecretKey`,
//! `decryptionFailed`, `notEncrypted`, `noIntegrity`, `notSigned`,
//! `badSignature`, `signerNotAllowed`, `signerExpired`, `signerRevoked`,
//! `signatureExpired`, `unknownSigner`, `unknownRecipient`,
//! `recipientUnusable`, `signerUnusable`, `noKeys`, `notText`, `malformed`,
//! `gpgFailed`, `io`, and for the vault methods `notAVault`, `unsupported`,
//! `gitFailed`, `notInitialised`, `alreadyInitialised`, `locked`,
//! `noMemberKey`, `notAMember`, `lastMember`, `malformedKey`.

use std::ffi::OsString;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::gpg::{self, Gpg};
use crate::ops::{self, Engine};
use crate::vault::{self, Vault};

/// A request line: an 8 MiB note can grow up to six times as JSON.
pub const MAX_LINE: usize = 64 * 1024 * 1024;

/// What the sidecar found at startup. gpg is resolved once, here.
pub struct Context {
    pub gpg: Option<PathBuf>,
    pub searched: Vec<PathBuf>,
    pub data_dir: Option<PathBuf>,
    /// This binary, which the vault's git filters are configured to run.
    pub exe: Option<PathBuf>,
}

impl Context {
    pub fn from_env() -> Self {
        let path: Option<OsString> = std::env::var_os("PATH");
        Self {
            gpg: gpg::resolve(path.as_deref()),
            searched: gpg::search_dirs(path.as_deref()),
            data_dir: std::env::var_os("MAHFOUZ_PLUGIN_DATA_DIR").map(PathBuf::from),
            exe: std::env::current_exe().ok(),
        }
    }

    fn exe(&self) -> Result<&Path> {
        self.exe
            .as_deref()
            .ok_or_else(|| Error::new("io", "couldn't find this binary's own path"))
    }

    fn engine(&self) -> Result<Engine> {
        let path = self.gpg.clone().ok_or_else(|| {
            Error::new(
                "gpgNotFound",
                "gpg isn't installed (GPG Suite, or `brew install gnupg pinentry-mac`)",
            )
        })?;
        let data = self
            .data_dir
            .as_ref()
            .ok_or_else(|| Error::new("io", "MAHFOUZ_PLUGIN_DATA_DIR isn't set"))?;
        Ok(Engine::new(
            Gpg {
                path,
                user_home: None,
            },
            data,
        ))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportParams {
    armored: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EncryptParams {
    plaintext: String,
    recipients: Vec<String>,
    signer: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DecryptParams {
    armored: String,
    allowed_signers: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VaultParams {
    vault: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InitVaultParams {
    vault: String,
    members: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemberParams {
    vault: String,
    fpr: String,
}

fn params<T: DeserializeOwned>(v: Value) -> Result<T> {
    let v = if v.is_null() { json!({}) } else { v };
    serde_json::from_value(v).map_err(|e| Error::invalid(e.to_string()))
}

fn to_value(v: impl serde::Serialize) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| Error::new("io", e.to_string()))
}

/// Answers one method call. `Err(None)` is an unknown method.
pub fn dispatch(
    ctx: &Context,
    method: &str,
    p: Value,
) -> std::result::Result<Value, Option<Error>> {
    let result = match method {
        "status" => params::<Empty>(p).and_then(|_| match &ctx.gpg {
            None => Ok(json!({
                "gpgNotFound": true,
                "searched": ctx.searched.iter().map(|d| d.display().to_string()).collect::<Vec<_>>(),
            })),
            Some(path) => to_value(ops::status(&Gpg {
                path: path.clone(),
                user_home: None,
            })?),
        }),
        "secretFingerprints" => {
            params::<Empty>(p).and_then(|_| to_value(ctx.engine()?.secret_keys()?))
        }
        "importPublic" => params::<ImportParams>(p)
            .and_then(|p| to_value(ctx.engine()?.import_public(&p.armored)?)),
        "encrypt" => params::<EncryptParams>(p).and_then(|p| {
            let armored = ctx.engine()?.encrypt(&p.plaintext, &p.recipients, &p.signer)?;
            Ok(json!({ "armored": armored }))
        }),
        "decrypt" => params::<DecryptParams>(p)
            .and_then(|p| to_value(ctx.engine()?.decrypt(&p.armored, &p.allowed_signers)?)),
        "vaultStatus" => params::<VaultParams>(p)
            .and_then(|p| to_value(vault::status(&Vault::open(&p.vault)?)?)),
        "unlockVault" => params::<VaultParams>(p).and_then(|p| {
            let v = Vault::open(&p.vault)?;
            to_value(vault::unlock(&ctx.engine()?, &v, ctx.exe()?)?)
        }),
        "lockVault" => {
            params::<VaultParams>(p).and_then(|p| to_value(vault::lock(&Vault::open(&p.vault)?)?))
        }
        "initVault" => params::<InitVaultParams>(p).and_then(|p| {
            let v = Vault::open(&p.vault)?;
            to_value(vault::init(&ctx.engine()?, &v, &p.members, ctx.exe()?)?)
        }),
        "addVaultMember" => params::<MemberParams>(p).and_then(|p| {
            let v = Vault::open(&p.vault)?;
            to_value(vault::add_member(&ctx.engine()?, &v, &p.fpr)?)
        }),
        "removeVaultMember" => params::<MemberParams>(p)
            .and_then(|p| to_value(vault::remove_member(&Vault::open(&p.vault)?, &p.fpr)?)),
        _ => return Err(None),
    };
    result.map_err(Some)
}

/// One line of at most `max` bytes (without the newline). `Some(Err(()))`
/// for a longer one, which is skipped up to its newline.
fn read_line(r: &mut impl BufRead, max: usize) -> Option<std::result::Result<Vec<u8>, ()>> {
    let mut line = Vec::new();
    let mut too_long = false;
    loop {
        let buf = match r.fill_buf() {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        };
        if buf.is_empty() {
            return if line.is_empty() && !too_long {
                None
            } else if too_long {
                Some(Err(()))
            } else {
                Some(Ok(line))
            };
        }
        let (chunk, done) = match buf.iter().position(|&b| b == b'\n') {
            Some(i) => (&buf[..i], Some(i + 1)),
            None => (buf, None),
        };
        if !too_long {
            if line.len() + chunk.len() > max {
                too_long = true;
                line = Vec::new();
            } else {
                line.extend_from_slice(chunk);
            }
        }
        let used = done.unwrap_or(buf.len());
        r.consume(used);
        if done.is_some() {
            return Some(if too_long { Err(()) } else { Ok(line) });
        }
    }
}

fn error_json(id: &Value, code: i64, message: String, data: Option<&str>) -> Value {
    let mut err = json!({ "code": code, "message": message });
    if let Some(d) = data {
        err["data"] = json!({ "code": d });
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": err })
}

type Out = Arc<Mutex<Box<dyn Write + Send>>>;

/// One response line; responses from different threads never interleave.
fn send(out: &Out, v: Value) {
    let mut w = out.lock().unwrap_or_else(|p| p.into_inner());
    let _ = writeln!(w, "{v}").and_then(|_| w.flush());
}

/// Serves requests from `input` until it closes, writing responses to
/// `output`, then waits for the requests still running.
pub fn serve(ctx: Context, mut input: impl BufRead, output: impl Write + Send + 'static) {
    let ctx = Arc::new(ctx);
    let out: Out = Arc::new(Mutex::new(Box::new(output)));
    let mut running = vec![];
    while let Some(line) = read_line(&mut input, MAX_LINE) {
        let Ok(line) = line else {
            send(
                &out,
                error_json(
                    &Value::Null,
                    -32600,
                    "request too large".into(),
                    Some("tooLarge"),
                ),
            );
            continue;
        };
        let msg: Value = match serde_json::from_slice(&line) {
            Ok(v) => v,
            Err(_) if line.iter().all(u8::is_ascii_whitespace) => continue,
            Err(_) => {
                send(
                    &out,
                    error_json(&Value::Null, -32700, "parse error".into(), None),
                );
                continue;
            }
        };
        let Some(id) = msg.get("id").cloned().filter(|i| !i.is_null()) else {
            continue; // a notification: nothing to answer
        };
        let Some(method) = msg
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            send(
                &out,
                error_json(&id, -32600, "invalid request".into(), None),
            );
            continue;
        };
        let p = msg.get("params").cloned().unwrap_or(Value::Null);
        let (ctx, out) = (ctx.clone(), out.clone());
        running.push(std::thread::spawn(move || {
            let reply = match dispatch(&ctx, &method, p) {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err(None) => error_json(&id, -32601, format!("unknown method {method}"), None),
                Err(Some(e)) => error_json(&id, -32000, e.to_string(), Some(e.code)),
            };
            send(&out, reply);
        }));
        running.retain(|h| !h.is_finished());
    }
    for h in running {
        let _ = h.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn responses(input: &str, ctx: Context) -> Vec<Value> {
        let sink = Sink::default();
        serve(ctx, Cursor::new(input.to_string()), sink.clone());
        let text = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        let mut out: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        out.sort_by_key(|v| v["id"].as_u64().unwrap_or(0));
        out
    }

    fn no_gpg() -> Context {
        Context {
            gpg: None,
            searched: vec![PathBuf::from("/opt/homebrew/bin")],
            data_dir: None,
            exe: None,
        }
    }

    #[test]
    fn answers_by_id_and_reports_a_missing_gpg() {
        let r = responses(
            concat!(
                r#"{"jsonrpc":"2.0","id":1,"method":"status","params":{}}"#,
                "\n",
                r#"{"jsonrpc":"2.0","method":"ignored-notification"}"#,
                "\n",
                "\n",
                r#"{"jsonrpc":"2.0","id":2,"method":"decrypt","params":{"armored":"x","allowedSigners":[]}}"#,
                "\n",
                r#"{"jsonrpc":"2.0","id":3,"method":"nope"}"#,
                "\n",
                r#"{"jsonrpc":"2.0","id":4,"method":"encrypt","params":{"plaintext":"x"}}"#,
                "\n",
                "not json\n",
            ),
            no_gpg(),
        );
        assert_eq!(r.len(), 5, "{r:?}");
        assert_eq!(r[0]["error"]["code"], -32700);
        assert_eq!(r[1]["id"], 1);
        assert_eq!(
            r[1]["result"],
            json!({ "gpgNotFound": true, "searched": ["/opt/homebrew/bin"] })
        );
        let msg = r[2]["error"]["message"].as_str().unwrap();
        assert!(msg.starts_with("gpgNotFound: "), "{msg}");
        assert_eq!(r[3]["error"]["code"], -32601);
        let msg = r[4]["error"]["message"].as_str().unwrap();
        assert!(msg.starts_with("invalidParams: "), "{msg}");
        assert_eq!(r[4]["error"]["data"]["code"], "invalidParams");
    }

    #[test]
    fn unknown_params_are_refused() {
        let r = responses(
            concat!(
                r#"{"jsonrpc":"2.0","id":1,"method":"status","params":{"x":1}}"#,
                "\n"
            ),
            no_gpg(),
        );
        assert!(r[0]["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("invalidParams"));
    }

    #[test]
    fn vault_methods_check_their_vault() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().display().to_string();
        let r = responses(
            &[
                json!({"jsonrpc":"2.0","id":1,"method":"vaultStatus","params":{"vault":"relative"}}),
                json!({"jsonrpc":"2.0","id":2,"method":"lockVault","params":{"vault": plain}}),
                json!({"jsonrpc":"2.0","id":3,"method":"removeVaultMember","params":{"vault": plain}}),
                json!({"jsonrpc":"2.0","id":4,"method":"unlockVault","params":{"vault": plain, "x": 1}}),
            ]
            .iter()
            .map(|v| format!("{v}\n"))
            .collect::<String>(),
            no_gpg(),
        );
        let code = |i: usize| r[i]["error"]["data"]["code"].as_str().unwrap().to_string();
        assert_eq!(code(0), "invalidParams");
        assert_eq!(code(1), "notAVault");
        assert_eq!(code(2), "invalidParams");
        assert_eq!(code(3), "invalidParams");
    }

    #[test]
    fn overlong_lines_are_skipped() {
        let mut c = Cursor::new(b"0123456789\nok\nlast".to_vec());
        assert_eq!(read_line(&mut c, 4), Some(Err(())));
        assert_eq!(read_line(&mut c, 4), Some(Ok(b"ok".to_vec())));
        assert_eq!(read_line(&mut c, 4), Some(Ok(b"last".to_vec())));
        assert_eq!(read_line(&mut c, 4), None);
    }
}
