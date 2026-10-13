//! The sidecar's methods.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::fpr::Fpr;
use crate::gpg::{Gpg, Limits, Output, MIN_VERSION};
use crate::keys::{effective_expiry, parse_listing, KeyInfo};
use crate::status;

/// A note's body, before encryption.
pub const MAX_PLAINTEXT: usize = 8 * 1024 * 1024;
/// An encrypted body (armor adds about a third).
pub const MAX_ARMORED: usize = 16 * 1024 * 1024;
/// A public key block, such as `https://github.com/<login>.gpg`.
pub const MAX_KEY_BLOCK: usize = 1024 * 1024;
pub const MAX_RECIPIENTS: usize = 64;
pub const MAX_ALLOWED_SIGNERS: usize = 256;
/// Keys reported from one import.
const MAX_IMPORTED: usize = 64;

/// Operations that never wait for the user.
const QUICK: Duration = Duration::from_secs(30);
/// Signing and decrypting, which may wait on pinentry or a card touch.
const INTERACTIVE: Duration = Duration::from_secs(180);
/// A key listing or export.
const MAX_LISTING: usize = 4 * 1024 * 1024;

const MESSAGE_HEADER: &str = "-----BEGIN PGP MESSAGE-----";
const PUBLIC_KEY_HEADER: &str = "-----BEGIN PGP PUBLIC KEY BLOCK-----";

/// The plugin keyring's directory name inside the plugin's data dir.
pub const RECIPIENTS_DIR: &str = "gnupg-recipients";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub gpg_path: String,
    pub version: String,
    /// At least [`MIN_VERSION`].
    pub supported: bool,
    pub agent_running: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Decrypted {
    pub plaintext: String,
    /// The signer's primary key fingerprint.
    pub signer: String,
    /// The signer's key has expired since; the signature was made while it
    /// was valid. Left out when false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub signer_expired: bool,
}

/// `status`: which gpg, its version, and whether the user's agent runs.
/// Needs no keyring.
pub fn status(gpg: &Gpg) -> Result<StatusReport> {
    let (version, parsed) = gpg.version()?;
    Ok(StatusReport {
        gpg_path: gpg.path.display().to_string(),
        version,
        supported: parsed >= MIN_VERSION,
        agent_running: gpg.agent_running(),
    })
}

/// gpg plus the two keyrings it works with.
pub struct Engine {
    pub gpg: Gpg,
    /// The plugin-owned keyring for other people's public keys.
    pub recipients_home: PathBuf,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn quick(max_stdout: usize) -> Limits {
    Limits {
        timeout: QUICK,
        max_stdout,
    }
}

fn args(list: &[&str]) -> Vec<OsString> {
    list.iter().map(OsString::from).collect()
}

/// A keyring directory the sidecar owns: 0700, and with a `common.conf` so
/// gpg 2.4+ keeps a plain `pubring.kbx` there instead of starting a
/// keyboxd daemon for it.
pub fn prepare_home(dir: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let io = |e: std::io::Error| Error::new("io", format!("{}: {e}", dir.display()));
    std::fs::create_dir_all(dir).map_err(io)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(io)?;
    let conf = dir.join("common.conf");
    if !conf.exists() {
        std::fs::write(
            &conf,
            "# Written by the mahfouz/encryption plugin: no keyboxd for this keyring.\n",
        )
        .map_err(io)?;
    }
    Ok(())
}

fn failure(code: &'static str, what: &str, out: &Output) -> Error {
    let log = out.last_log_line();
    if log.is_empty() {
        Error::new(code, what.to_string())
    } else {
        Error::new(code, format!("{what} ({log})"))
    }
}

/// A throwaway keyring (removed on drop, its daemons stopped first).
struct TempHome<'a> {
    gpg: &'a Gpg,
    dir: tempfile::TempDir,
}

impl<'a> TempHome<'a> {
    fn new(gpg: &'a Gpg) -> Result<Self> {
        let dir = tempfile::Builder::new()
            .prefix("mahfouz-gpg-")
            .tempdir()
            .map_err(|e| Error::new("io", format!("temporary keyring: {e}")))?;
        prepare_home(dir.path())?;
        Ok(Self { gpg, dir })
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }
}

impl Drop for TempHome<'_> {
    fn drop(&mut self) {
        self.gpg.kill_daemons(self.dir.path());
    }
}

impl Engine {
    /// The engine the sidecar runs: the user's default keyring, and the
    /// plugin keyring inside the plugin's data directory.
    pub fn new(gpg: Gpg, plugin_data_dir: &Path) -> Self {
        Self {
            gpg,
            recipients_home: plugin_data_dir.join(RECIPIENTS_DIR),
        }
    }

    /// The user's secret keys.
    pub fn secret_keys(&self) -> Result<Vec<KeyInfo>> {
        let out = self.gpg.run(
            None,
            &args(&["--with-colons", "--fixed-list-mode", "--list-secret-keys"]),
            b"",
            quick(MAX_LISTING),
        )?;
        if !out.success {
            return Err(failure("gpgFailed", "couldn't list your secret keys", &out));
        }
        Ok(parse_listing(&String::from_utf8_lossy(&out.stdout), now()))
    }

    /// One public key from `home` (`None`: the user's keyring), if it's
    /// there under that primary fingerprint.
    fn public_key(&self, home: Option<&Path>, fpr: &Fpr) -> Result<Option<KeyInfo>> {
        let mut a = args(&["--with-colons", "--fixed-list-mode", "--list-keys", "--"]);
        a.push(fpr.arg().into());
        let out = self.gpg.run(home, &a, b"", quick(MAX_LISTING))?;
        if !out.success {
            return Ok(None); // "No public key"
        }
        Ok(parse_listing(&String::from_utf8_lossy(&out.stdout), now())
            .into_iter()
            .find(|k| k.fpr == fpr.as_str()))
    }

    /// `fpr`'s public key, minimal, from `home`. Empty when it isn't there.
    fn export(&self, home: Option<&Path>, fpr: &Fpr) -> Result<Vec<u8>> {
        let mut a = args(&["--export-options", "export-minimal", "--export", "--"]);
        a.push(fpr.arg().into());
        Ok(self.gpg.run(home, &a, b"", quick(MAX_LISTING))?.stdout)
    }

    /// Imports public keys into the plugin keyring (never the user's) and
    /// reports each key the block held.
    pub fn import_public(&self, armored: &str) -> Result<Vec<KeyInfo>> {
        if armored.len() > MAX_KEY_BLOCK {
            return Err(Error::new(
                "tooLarge",
                format!("a key block is at most {MAX_KEY_BLOCK} bytes"),
            ));
        }
        if !armored.contains(PUBLIC_KEY_HEADER) {
            return Err(Error::invalid("not an armored public key block"));
        }
        if armored.contains("PRIVATE KEY BLOCK") {
            return Err(Error::invalid(
                "that's a secret key; only public keys can be imported",
            ));
        }
        prepare_home(&self.recipients_home)?;
        let home = Some(self.recipients_home.as_path());
        let out = self.gpg.run(
            home,
            &args(&["--import-options", "import-minimal", "--import"]),
            armored.as_bytes(),
            quick(64 * 1024),
        )?;
        // IMPORT_OK <reasons> <fingerprint>, for new and unchanged keys.
        let mut fprs: Vec<Fpr> = vec![];
        for s in status::parse(&out.status) {
            if s.keyword == "IMPORT_OK" {
                if let Some(f) = s.args.get(1).and_then(|f| Fpr::parse(f).ok()) {
                    if !fprs.contains(&f) {
                        fprs.push(f);
                    }
                }
            }
        }
        if fprs.is_empty() {
            return Err(failure(
                "noKeys",
                "no usable public key in that block",
                &out,
            ));
        }
        let mut keys = vec![];
        for f in fprs.iter().take(MAX_IMPORTED) {
            if let Some(k) = self.public_key(home, f)? {
                keys.push(k);
            }
        }
        Ok(keys)
    }

    /// Signs `plaintext` with `signer` and encrypts it to `recipients`, as
    /// one ASCII-armored OpenPGP message.
    ///
    /// Each recipient is looked up by fingerprint: among the user's own
    /// secret keys first (their own key, a second device's), otherwise in
    /// the plugin keyring. A key that's expired, revoked or can't encrypt
    /// is refused, and so is a recipient in neither place. The signer must
    /// be one of the user's secret keys and one of the recipients, so the
    /// author can always read their own note.
    ///
    /// The keyrings meet through `--recipient-file`: each recipient's
    /// public key is exported (minimal) into a throwaway 0700 directory and
    /// handed to the sign-and-encrypt run in the user's keyring with `-f`.
    /// gpg takes a key given that way as fully valid for that one run, so
    /// no trust model is overridden, and nothing is imported into the
    /// user's keyring. The alternatives are worse: `--keyring <plugin
    /// pubring>` is ignored when the user's gpg runs keyboxd (the default
    /// for new keyrings since 2.4.1), and running in a separate homedir
    /// can't sign, because the secret key lives in the user's gpg-agent,
    /// which is bound to the user's homedir.
    pub fn encrypt(&self, plaintext: &str, recipients: &[String], signer: &str) -> Result<String> {
        if plaintext.len() > MAX_PLAINTEXT {
            return Err(Error::new(
                "tooLarge",
                format!("a note is at most {MAX_PLAINTEXT} bytes"),
            ));
        }
        let recipients = Fpr::parse_list(recipients, "recipients", MAX_RECIPIENTS)?;
        let signer = Fpr::parse(signer)?;
        if !recipients.contains(&signer) {
            return Err(Error::invalid(
                "the signer must also be a recipient, or its author couldn't read the note",
            ));
        }

        let own = self.secret_keys()?;
        let own_key = |f: &Fpr| own.iter().find(|k| k.fpr == f.as_str());
        let signer_key = own_key(&signer).ok_or_else(|| {
            Error::new(
                "signerUnusable",
                format!("{signer} isn't one of your secret keys"),
            )
        })?;
        if let Some(why) = signer_key.unusable_for_signing() {
            return Err(Error::new(
                "signerUnusable",
                format!("your key {signer} {why}"),
            ));
        }

        let files = TempHome::new(&self.gpg)?;
        let mut cmd = args(&["--no-encrypt-to", "--armor", "--local-user"]);
        cmd.push(signer.arg().into());
        cmd.extend(args(&["--sign", "--encrypt"]));
        for (i, f) in recipients.iter().enumerate() {
            let (home, key) = match own_key(f) {
                Some(k) => (None, Some(k.clone())),
                None => {
                    let home = Some(self.recipients_home.as_path());
                    let key = if self.recipients_home.is_dir() {
                        self.public_key(home, f)?
                    } else {
                        None
                    };
                    (home, key)
                }
            };
            let key = key.ok_or_else(|| {
                Error::new(
                    "unknownRecipient",
                    format!("{f} hasn't been imported (importPublic) and isn't one of your keys"),
                )
            })?;
            if let Some(why) = key.unusable_for_encryption() {
                return Err(Error::new("recipientUnusable", format!("{f} {why}")));
            }
            let exported = self.export(home, f)?;
            if exported.is_empty() {
                return Err(Error::new(
                    "unknownRecipient",
                    format!("couldn't export {f}"),
                ));
            }
            let path = files.path().join(format!("recipient-{i}.gpg"));
            std::fs::write(&path, exported)
                .map_err(|e| Error::new("io", format!("{}: {e}", path.display())))?;
            cmd.push("--recipient-file".into());
            cmd.push(path.into());
        }
        cmd.extend(args(&["--output", "-"]));

        let out = self.gpg.run(
            None,
            &cmd,
            plaintext.as_bytes(),
            Limits {
                timeout: INTERACTIVE,
                max_stdout: MAX_ARMORED,
            },
        )?;
        let st = status::parse(&out.status);
        if status::cancelled(&st) {
            return Err(Error::new(
                "cancelled",
                "the passphrase prompt was cancelled",
            ));
        }
        let has = |k: &str| st.iter().any(|s| s.keyword == k);
        if has("INV_SGNR") || has("NO_SGNR") {
            return Err(failure(
                "signerUnusable",
                "gpg couldn't sign with your key",
                &out,
            ));
        }
        if has("INV_RECP") || has("NO_RECP") {
            return Err(failure(
                "recipientUnusable",
                "gpg refused a recipient",
                &out,
            ));
        }
        if !out.success || !has("SIG_CREATED") || !has("END_ENCRYPTION") {
            return Err(failure("gpgFailed", "gpg couldn't sign and encrypt", &out));
        }
        let armored = String::from_utf8(out.stdout)
            .map_err(|_| Error::new("gpgFailed", "gpg's output isn't armored"))?;
        if !armored.starts_with(MESSAGE_HEADER) {
            return Err(Error::new(
                "gpgFailed",
                "gpg's output isn't an armored message",
            ));
        }
        Ok(armored)
    }

    /// Decrypts `armored` and checks it's signed by one of
    /// `allowed_signers`; returns the text only when both hold.
    ///
    /// Two steps, so verification only ever sees the allowed keys:
    ///
    /// 1. In the user's keyring (their secret key, through gpg-agent),
    ///    `--decrypt --unwrap` removes only the encryption layer, which
    ///    must report `DECRYPTION_OKAY` and no `DECRYPTION_FAILED`. The
    ///    output, the signed message, stays in memory.
    /// 2. In a throwaway keyring holding only the allowed signers' public
    ///    keys (copied from the plugin keyring, else the user's), with
    ///    `--trust-model always`, that message is verified: every
    ///    signature `GOODSIG` + `VALIDSIG` from an allowed fingerprint. A
    ///    signer outside the list has no key there, so gpg can't call it
    ///    good. Running it in the user's keyring instead would miss
    ///    collaborators (their keys are in the plugin keyring), and adding
    ///    the plugin keyring with `--keyring` fails under keyboxd.
    pub fn decrypt(&self, armored: &str, allowed_signers: &[String]) -> Result<Decrypted> {
        if armored.len() > MAX_ARMORED {
            return Err(Error::new(
                "tooLarge",
                format!("an encrypted note is at most {MAX_ARMORED} bytes"),
            ));
        }
        if !armored.trim_start().starts_with(MESSAGE_HEADER) {
            return Err(Error::new("notEncrypted", "not an armored OpenPGP message"));
        }
        let allowed = Fpr::parse_list(allowed_signers, "allowedSigners", MAX_ALLOWED_SIGNERS)?;

        let unwrapped = self.gpg.run(
            None,
            &args(&["--unwrap", "--decrypt"]),
            armored.as_bytes(),
            Limits {
                timeout: INTERACTIVE,
                max_stdout: MAX_ARMORED,
            },
        )?;
        status::judge_decrypt(&status::parse(&unwrapped.status))?;
        if !unwrapped.success {
            return Err(failure(
                "decryptionFailed",
                "gpg couldn't decrypt it",
                &unwrapped,
            ));
        }

        let verify = TempHome::new(&self.gpg)?;
        let vhome = Some(verify.path());
        let mut imported = 0;
        for f in &allowed {
            let mut key = vec![];
            if self.recipients_home.is_dir() {
                key = self.export(Some(&self.recipients_home), f)?;
            }
            if key.is_empty() {
                key = self.export(None, f)?;
            }
            if key.is_empty() {
                continue;
            }
            let out = self
                .gpg
                .run(vhome, &args(&["--import"]), &key, quick(64 * 1024))?;
            if status::parse(&out.status)
                .iter()
                .any(|s| s.keyword == "IMPORT_OK")
            {
                imported += 1;
            }
        }
        if imported == 0 {
            return Err(Error::new(
                "unknownSigner",
                "none of the allowed signers' public keys is available",
            ));
        }

        let out = self.gpg.run(
            vhome,
            &args(&["--trust-model", "always", "--decrypt"]),
            &unwrapped.stdout,
            Limits {
                timeout: QUICK,
                max_stdout: MAX_PLAINTEXT,
            },
        )?;
        // The verify keyring's own view of each signing key's expiry, for a
        // key that has expired since it signed.
        let st = status::parse(&out.status);
        let listing = if st.iter().any(|s| s.keyword == "EXPKEYSIG") {
            let l = self.gpg.run(
                vhome,
                &args(&["--with-colons", "--fixed-list-mode", "--list-keys"]),
                b"",
                quick(MAX_LISTING),
            )?;
            String::from_utf8_lossy(&l.stdout).into_owned()
        } else {
            String::new()
        };
        let verified =
            status::judge_verify(&st, &allowed, |f| effective_expiry(&listing, f.as_str()))?;
        // gpg exits non-zero for a signature by a key that has expired
        // since; the status lines above are what decide it.
        if !out.success && !verified.signer_expired {
            return Err(failure("badSignature", "gpg couldn't verify it", &out));
        }
        let plaintext = String::from_utf8(out.stdout)
            .map_err(|_| Error::new("notText", "the decrypted note isn't UTF-8 text"))?;
        Ok(Decrypted {
            plaintext,
            signer: verified.signer.to_string(),
            signer_expired: verified.signer_expired,
        })
    }
}
