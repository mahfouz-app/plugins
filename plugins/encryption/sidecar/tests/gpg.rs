//! Against the real gpg, in throwaway keyrings with generated
//! passphrase-less keys. Skipped (with the reason printed) when gpg isn't
//! installed.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use encryption_sidecar::gpg::{self, Gpg, Limits};
use encryption_sidecar::ops::{prepare_home, Engine, RECIPIENTS_DIR};
use serde_json::{json, Value};

const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(60),
    max_stdout: 4 * 1024 * 1024,
};

fn gpg_path() -> Option<PathBuf> {
    let found = gpg::resolve(std::env::var_os("PATH").as_deref());
    if found.is_none() {
        eprintln!(
            "skipping: gpg isn't installed (searched PATH and {:?})",
            gpg::FALLBACK_DIRS
        );
    }
    found
}

/// One person: their own keyring and the plugin's data dir. Stops the
/// gpg-agent the keyring started when dropped.
struct Person {
    _root: tempfile::TempDir,
    home: PathBuf,
    data: PathBuf,
    gpg: Gpg,
    fpr: String,
}

impl Drop for Person {
    fn drop(&mut self) {
        self.gpg.kill_daemons(&self.home);
        self.gpg.kill_daemons(&self.data.join(RECIPIENTS_DIR));
    }
}

impl Person {
    fn engine(&self) -> Engine {
        Engine::new(self.gpg.clone(), &self.data)
    }

    fn run(&self, args: &[&str], input: &[u8]) -> gpg::Output {
        let a: Vec<OsString> = args.iter().map(OsString::from).collect();
        self.gpg.run(None, &a, input, LIMITS).unwrap()
    }

    fn armored_public_key(&self) -> String {
        let out = self.run(&["--armor", "--export", &format!("0x{}", self.fpr)], b"");
        String::from_utf8(out.stdout).unwrap()
    }

    fn has_public_key(&self, fpr: &str) -> bool {
        self.run(&["--list-keys", &format!("0x{fpr}")], b"").success
    }
}

/// A person with a passphrase-less key. `key` is `quick-gen-key`'s
/// `algo usage expire` (e.g. `default default never`); `faked_time`
/// generates it in the past.
fn person(gpg_path: &Path, name: &str, key: &str, faked_time: Option<&str>) -> Person {
    // Short paths: gpg-agent's socket sits in the homedir on macOS, and a
    // Unix socket path is limited to about 100 bytes.
    let root = tempfile::Builder::new().prefix("mzg").tempdir().unwrap();
    let home = root.path().join("h");
    let data = root.path().join("d");
    prepare_home(&home).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let gpg = Gpg {
        path: gpg_path.to_path_buf(),
        user_home: Some(home.clone()),
    };
    let mut args: Vec<OsString> = ["--passphrase", "", "--pinentry-mode", "loopback"]
        .iter()
        .map(OsString::from)
        .collect();
    if let Some(t) = faked_time {
        args.push("--faked-system-time".into());
        args.push(t.into());
    }
    args.push("--quick-gen-key".into());
    args.push(format!("{name} <{}@example.com>", name.to_lowercase()).into());
    args.extend(key.split(' ').map(OsString::from));
    let out = gpg.run(None, &args, b"", LIMITS).unwrap();
    let fpr = encryption_sidecar::status::parse(&out.status)
        .into_iter()
        .find(|s| s.keyword == "KEY_CREATED")
        .and_then(|s| s.args.get(1).cloned())
        .unwrap_or_else(|| panic!("no key for {name}: {}", out.stderr));
    Person {
        _root: root,
        home,
        data,
        gpg,
        fpr,
    }
}

fn alice_and_bob(gpg: &Path) -> (Person, Person) {
    (
        person(gpg, "Alice", "default default never", None),
        person(gpg, "Bob", "default default never", None),
    )
}

#[test]
fn round_trip_with_a_recipient_only_in_the_plugin_keyring() {
    let Some(g) = gpg_path() else { return };
    let (alice, bob) = alice_and_bob(&g);

    // Bob's key goes into Alice's plugin keyring, never her own.
    let imported = alice
        .engine()
        .import_public(&bob.armored_public_key())
        .unwrap();
    assert_eq!(imported.len(), 1);
    let k = &imported[0];
    assert_eq!(k.fpr, bob.fpr);
    assert_eq!(k.uids, vec!["Bob <bob@example.com>"]);
    assert!(k.can_encrypt && !k.expired && !k.revoked);
    assert!(
        !alice.has_public_key(&bob.fpr),
        "imported into the user's keyring"
    );
    assert!(alice.data.join(RECIPIENTS_DIR).join("common.conf").exists());

    let text = "# Plans\n\nTop secret, naïve café ☕\n";
    let armored = alice
        .engine()
        .encrypt(text, &[alice.fpr.clone(), bob.fpr.clone()], &alice.fpr)
        .unwrap();
    assert!(armored.starts_with("-----BEGIN PGP MESSAGE-----"));
    assert!(!armored.contains("Top secret"));
    assert!(
        !alice.has_public_key(&bob.fpr),
        "encrypting imported Bob's key"
    );

    let mine = alice
        .engine()
        .decrypt(&armored, std::slice::from_ref(&alice.fpr))
        .unwrap();
    assert_eq!(mine.plaintext, text);
    assert_eq!(mine.signer, alice.fpr);

    // Bob reads it with his own secret key; Alice's public key is in his
    // plugin keyring for the signature.
    bob.engine()
        .import_public(&alice.armored_public_key())
        .unwrap();
    let his = bob
        .engine()
        .decrypt(&armored, &[bob.fpr.clone(), alice.fpr.clone()])
        .unwrap();
    assert_eq!(his.plaintext, text);
    assert_eq!(his.signer, alice.fpr);
}

#[test]
fn a_signer_outside_allowed_signers_is_rejected() {
    let Some(g) = gpg_path() else { return };
    let (alice, bob) = alice_and_bob(&g);
    bob.engine()
        .import_public(&alice.armored_public_key())
        .unwrap();
    alice
        .engine()
        .import_public(&bob.armored_public_key())
        .unwrap();
    let armored = alice
        .engine()
        .encrypt("hi", &[alice.fpr.clone(), bob.fpr.clone()], &alice.fpr)
        .unwrap();

    // Bob only allows himself: Alice's key isn't in the verify keyring.
    let err = bob
        .engine()
        .decrypt(&armored, std::slice::from_ref(&bob.fpr))
        .unwrap_err();
    assert_eq!(err.code, "signerNotAllowed", "{err}");
    // Alice only allows Bob, whose key she has: still Alice's signature.
    let err = alice
        .engine()
        .decrypt(&armored, std::slice::from_ref(&bob.fpr))
        .unwrap_err();
    assert_eq!(err.code, "signerNotAllowed", "{err}");
}

#[test]
fn a_forged_unsigned_body_is_rejected() {
    let Some(g) = gpg_path() else { return };
    let alice = person(&g, "Alice", "default default never", None);
    // Encrypted to Alice, but signed by nobody: anyone with her public key
    // can make one.
    let fpr = format!("0x{}", alice.fpr);
    let out = alice.run(
        &[
            "--trust-model",
            "always",
            "--armor",
            "--encrypt",
            "--recipient",
            &fpr,
        ],
        b"forged",
    );
    assert!(out.success, "{}", out.stderr);
    let forged = String::from_utf8(out.stdout).unwrap();
    let err = alice
        .engine()
        .decrypt(&forged, std::slice::from_ref(&alice.fpr))
        .unwrap_err();
    assert_eq!(err.code, "notSigned", "{err}");

    // Signed but not encrypted is refused too.
    let out = alice.run(&["--armor", "--local-user", &fpr, "--sign"], b"signed");
    let signed = String::from_utf8(out.stdout).unwrap();
    let err = alice
        .engine()
        .decrypt(&signed, std::slice::from_ref(&alice.fpr))
        .unwrap_err();
    assert_eq!(err.code, "notEncrypted", "{err}");
}

#[test]
fn tampered_ciphertext_fails() {
    let Some(g) = gpg_path() else { return };
    let alice = person(&g, "Alice", "default default never", None);
    let armored = alice
        .engine()
        .encrypt(
            &"x".repeat(2000),
            std::slice::from_ref(&alice.fpr),
            &alice.fpr,
        )
        .unwrap();
    // Flip one base64 character in the middle of the body.
    let mut lines: Vec<String> = armored.lines().map(str::to_string).collect();
    let mid = lines.len() / 2;
    let line = &mut lines[mid];
    let c = if line.starts_with('A') { "B" } else { "A" };
    line.replace_range(0..1, c);
    let tampered = lines.join("\n") + "\n";
    assert!(alice
        .engine()
        .decrypt(&tampered, std::slice::from_ref(&alice.fpr))
        .is_err());
}

#[test]
fn expired_and_encrypt_less_keys_are_refused() {
    let Some(g) = gpg_path() else { return };
    let alice = person(&g, "Alice", "default default never", None);
    // Made in 2020, valid for a year.
    let carol = person(&g, "Carol", "default default 1y", Some("20200101T000000"));
    // A signing-only key: no encryption subkey.
    let dave = person(&g, "Dave", "ed25519 sign never", None);

    let e = alice.engine();
    let c = e.import_public(&carol.armored_public_key()).unwrap();
    assert!(c[0].expired, "{c:?}");
    let d = e.import_public(&dave.armored_public_key()).unwrap();
    assert!(!d[0].can_encrypt && !d[0].expired, "{d:?}");

    for other in [&carol.fpr, &dave.fpr] {
        let err = e
            .encrypt("x", &[alice.fpr.clone(), other.clone()], &alice.fpr)
            .unwrap_err();
        assert_eq!(err.code, "recipientUnusable", "{err}");
    }
}

#[test]
fn recipients_and_signers_that_are_refused() {
    let Some(g) = gpg_path() else { return };
    let (alice, bob) = alice_and_bob(&g);
    let e = alice.engine();

    // Bob was never imported.
    let err = e
        .encrypt("x", &[alice.fpr.clone(), bob.fpr.clone()], &alice.fpr)
        .unwrap_err();
    assert_eq!(err.code, "unknownRecipient", "{err}");
    // The signer must be a recipient.
    e.import_public(&bob.armored_public_key()).unwrap();
    let err = e
        .encrypt("x", std::slice::from_ref(&bob.fpr), &alice.fpr)
        .unwrap_err();
    assert_eq!(err.code, "invalidParams", "{err}");
    // And one of the user's secret keys.
    let err = e
        .encrypt("x", &[alice.fpr.clone(), bob.fpr.clone()], &bob.fpr)
        .unwrap_err();
    assert_eq!(err.code, "signerUnusable", "{err}");
    // Only fingerprints.
    let err = e
        .encrypt("x", &["bob@example.com".into()], &alice.fpr)
        .unwrap_err();
    assert_eq!(err.code, "invalidParams", "{err}");
}

#[test]
fn secret_keys_and_imports() {
    let Some(g) = gpg_path() else { return };
    let alice = person(&g, "Alice", "default default never", None);
    let e = alice.engine();
    let keys = e.secret_keys().unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].fpr, alice.fpr);
    assert!(keys[0].can_sign && keys[0].can_encrypt);

    assert_eq!(e.import_public("hello").unwrap_err().code, "invalidParams");
    let secret = alice.run(
        &[
            "--pinentry-mode",
            "loopback",
            "--passphrase",
            "",
            "--armor",
            "--export-secret-keys",
        ],
        b"",
    );
    let secret = String::from_utf8(secret.stdout).unwrap();
    assert!(secret.contains("PRIVATE KEY BLOCK"));
    assert_eq!(e.import_public(&secret).unwrap_err().code, "invalidParams");
    let garbage =
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nAAAA\n-----END PGP PUBLIC KEY BLOCK-----\n";
    assert_eq!(e.import_public(garbage).unwrap_err().code, "noKeys");
}

/// The built binary over stdio, the way the app runs it.
#[test]
fn the_binary_speaks_json_rpc() {
    let Some(g) = gpg_path() else { return };
    let alice = person(&g, "Alice", "default default never", None);
    let mut child = Command::new(env!("CARGO_BIN_EXE_git-crypt"))
        .env("PATH", g.parent().unwrap())
        .env("GNUPGHOME", &alice.home)
        .env("MAHFOUZ_PLUGIN_DATA_DIR", &alice.data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut call = |id: u64, method: &str, params: Value| -> Value {
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["id"], id);
        v
    };

    let status = call(1, "status", json!({}));
    assert_eq!(status["result"]["gpgPath"], g.display().to_string());
    assert_eq!(status["result"]["supported"], true);
    let keys = call(2, "secretFingerprints", json!({}));
    assert_eq!(keys["result"][0]["fpr"], alice.fpr);
    let enc = call(
        3,
        "encrypt",
        json!({ "plaintext": "over rpc", "recipients": [alice.fpr], "signer": alice.fpr }),
    );
    let armored = enc["result"]["armored"].as_str().unwrap();
    let dec = call(
        4,
        "decrypt",
        json!({ "armored": armored, "allowedSigners": [alice.fpr] }),
    );
    assert_eq!(
        dec["result"],
        json!({ "plaintext": "over rpc", "signer": alice.fpr })
    );
    let bad = call(
        5,
        "decrypt",
        json!({ "armored": "nope", "allowedSigners": [alice.fpr] }),
    );
    assert!(bad["error"]["message"]
        .as_str()
        .unwrap()
        .starts_with("notEncrypted: "));

    drop(stdin);
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(
        out.stderr.is_empty(),
        "the sidecar logged: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn filter_modes_are_refused_until_they_exist() {
    let out = Command::new(env!("CARGO_BIN_EXE_git-crypt"))
        .arg("smudge")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
}
