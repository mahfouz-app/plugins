//! Whole-vault encryption against real git (temporary repositories), real
//! gpg (throwaway keyrings with passphrase-less keys) and, where it's
//! installed, the real `git-crypt` CLI. A test that needs gpg or git-crypt
//! and doesn't find it says so and passes; CI installs both.

use std::ffi::OsString;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use encryption_sidecar::gitcrypt::{self, KeyFile, FILE_HEADER};
use encryption_sidecar::gpg::{self, Gpg, Limits};
use encryption_sidecar::ops::{prepare_home, Engine, RECIPIENTS_DIR};
use encryption_sidecar::vault::{self, Vault, ROOT_GITATTRIBUTES, STATE_GITATTRIBUTES};

const EXE: &str = env!("CARGO_BIN_EXE_git-crypt");

const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(60),
    max_stdout: 4 * 1024 * 1024,
};

// ---- git ------------------------------------------------------------------

/// git with none of the user's global or system config (commit signing,
/// hooks, a filter of their own), and no inherited repository.
fn git_command(dir: &Path) -> Command {
    let mut c = Command::new("git");
    c.current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");
    c
}

fn git_raw(dir: &Path, args: &[&str]) -> Output {
    git_command(dir).args(args).output().unwrap()
}

fn git(dir: &Path, args: &[&str]) -> Vec<u8> {
    let out = git_raw(dir, args);
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

fn new_repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    for (k, v) in [
        ("user.name", "Test"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
    ] {
        git(dir, &["config", k, v]);
    }
}

fn commit_all(dir: &Path, message: &str) {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
}

fn clone(from: &Path, to: &Path) {
    let out = git_command(from.parent().unwrap())
        .args(["clone", "-q"])
        .arg(from)
        .arg(to)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    for (k, v) in [
        ("user.name", "Test"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
    ] {
        git(to, &["config", k, v]);
    }
}

fn blob(dir: &Path, path: &str) -> Vec<u8> {
    git(dir, &["cat-file", "blob", &format!("HEAD:{path}")])
}

/// What git-crypt's unlock does after installing the key: rewrite the
/// encrypted files from the index through the filter. The app's forced
/// checkout must do the same; here the files are removed first so git
/// can't skip them as unchanged.
fn recheckout(dir: &Path, files: &[&str]) {
    for f in files {
        let _ = std::fs::remove_file(dir.join(f));
    }
    git(dir, &["checkout", "-f", "HEAD", "--", "."]);
}

fn porcelain(dir: &Path) -> String {
    String::from_utf8(git(dir, &["status", "--porcelain"])).unwrap()
}

fn vault(dir: &Path) -> Vault {
    Vault::open(dir.to_str().unwrap()).unwrap()
}

fn exe() -> &'static Path {
    Path::new(EXE)
}

fn mode(p: &Path) -> u32 {
    std::fs::metadata(p).unwrap().permissions().mode() & 0o777
}

/// Runs this crate's binary as a filter in `dir`, with `input` on stdin.
fn ours(dir: &Path, args: &[&str], input: &[u8]) -> Output {
    run_with_input(
        Command::new(EXE)
            .args(args)
            .current_dir(dir)
            .env_remove("GIT_DIR"),
        input,
    )
}

fn run_with_input(cmd: &mut Command, input: &[u8]) -> Output {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let data = input.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&data);
    });
    let out = child.wait_with_output().unwrap();
    writer.join().unwrap();
    out
}

// ---- gpg ------------------------------------------------------------------

fn gpg_path() -> Option<PathBuf> {
    let found = gpg::resolve(std::env::var_os("PATH").as_deref());
    if found.is_none() {
        eprintln!("skipping: gpg isn't installed");
    }
    found
}

/// One person: their own keyring and the plugin's data dir.
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

    fn armored_public_key(&self) -> String {
        let a: Vec<OsString> = ["--armor", "--export", &format!("0x{}", self.fpr)]
            .iter()
            .map(OsString::from)
            .collect();
        String::from_utf8(self.gpg.run(None, &a, b"", LIMITS).unwrap().stdout).unwrap()
    }
}

fn person(gpg_path: &Path, name: &str) -> Person {
    let root = tempfile::Builder::new().prefix("mzv").tempdir().unwrap();
    let home = root.path().join("h");
    let data = root.path().join("d");
    prepare_home(&home).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let gpg = Gpg {
        path: gpg_path.to_path_buf(),
        user_home: Some(home.clone()),
    };
    let args: Vec<OsString> = [
        "--passphrase",
        "",
        "--pinentry-mode",
        "loopback",
        "--quick-gen-key",
        &format!("{name} <{}@example.com>", name.to_lowercase()),
        "default",
        "default",
        "never",
    ]
    .iter()
    .map(OsString::from)
    .collect();
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

// ---- the real git-crypt ---------------------------------------------------

fn real_git_crypt() -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let found = std::env::split_paths(&path)
        .map(|d| d.join("git-crypt"))
        .find(|p| p.is_file() && p != Path::new(EXE));
    if found.is_none() {
        eprintln!(
            "skipping: git-crypt isn't on PATH (apt install git-crypt / brew install git-crypt)"
        );
    }
    found
}

/// The real git-crypt in `dir`, with git's config isolated like
/// [`git_command`] and, for its GPG commands, `person`'s keyring.
fn real(gc: &Path, dir: &Path, args: &[&str], person: Option<&Person>) -> Command {
    let mut c = Command::new(gc);
    c.args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove("GIT_DIR");
    if let Some(p) = person {
        // git-crypt runs `gpg` by name.
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut dirs = vec![p.gpg.path.parent().unwrap().to_path_buf()];
        dirs.extend(std::env::split_paths(&path));
        c.env("PATH", std::env::join_paths(dirs).unwrap())
            .env("GNUPGHOME", &p.home);
    }
    c
}

fn ok(out: Output, what: &str) -> Output {
    assert!(
        out.status.success(),
        "{what} failed ({:?}): {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

// ---- tests ----------------------------------------------------------------

const NOTE: &[u8] = b"# Plans\n\nTop secret, naive cafe\n";

/// Files of the sizes that matter to the format: empty, under, at and over
/// an AES block, the 64 KiB stream chunk, and the 8 MiB in-memory limit.
fn sized_files() -> Vec<(String, Vec<u8>)> {
    let big = gitcrypt::IN_MEMORY as usize;
    [0usize, 1, 15, 16, 17, 1024, 65_537, big - 1, big + 70_001]
        .iter()
        .map(|&n| {
            (
                format!("data/f{n}.bin"),
                (0..n).map(|i| (i * 131 + n) as u8).collect(),
            )
        })
        .collect()
}

#[test]
fn init_commit_clone_unlock_lock() {
    let Some(g) = gpg_path() else { return };
    let alice = person(&g, "Alice");
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    new_repo(&a);

    let va = vault(&a);
    let st = vault::status(&va).unwrap();
    assert!(!st.encrypted && !st.unlocked && st.members.is_empty() && st.key_names.is_empty());
    assert!(!st.uses_lfs && !st.has_remote);
    std::fs::write(a.join(".gitattributes"), "*.md text eol=lf\n").unwrap();

    let init = vault::init(
        &alice.engine(),
        &va,
        std::slice::from_ref(&alice.fpr),
        exe(),
    )
    .unwrap();
    let member_rel = format!(".git-crypt/keys/default/0/{}.gpg", alice.fpr);
    assert_eq!(
        init.paths,
        vec![
            ".git-crypt/.gitattributes".to_string(),
            member_rel.clone(),
            ".gitattributes".to_string()
        ]
    );
    assert_eq!(init.gitattributes, ROOT_GITATTRIBUTES);
    // The block goes after what the root attributes already held.
    let root_attrs = format!("*.md text eol=lf\n{ROOT_GITATTRIBUTES}");
    assert_eq!(
        std::fs::read_to_string(a.join(".gitattributes")).unwrap(),
        root_attrs
    );
    assert_eq!(
        std::fs::read_to_string(a.join(".git-crypt/.gitattributes")).unwrap(),
        STATE_GITATTRIBUTES
    );
    let key_path = a.join(".git/git-crypt/keys/default");
    assert_eq!(mode(&key_path), 0o600);
    assert_eq!(mode(&a.join(".git/git-crypt/keys")), 0o700);
    assert_eq!(mode(&a.join(".git/git-crypt")), 0o700);
    let key = KeyFile::load(&std::fs::read(&key_path).unwrap()).unwrap();
    assert!(key.key_name.is_none() && key.get(0).is_some());
    let quoted = format!("\"{EXE}\"");
    for (k, v) in [
        ("filter.git-crypt.smudge", format!("{quoted} smudge")),
        ("filter.git-crypt.clean", format!("{quoted} clean")),
        ("filter.git-crypt.required", "true".into()),
        ("diff.git-crypt.textconv", format!("{quoted} diff")),
    ] {
        assert_eq!(
            String::from_utf8(git(&a, &["config", "--get", k]))
                .unwrap()
                .trim(),
            v
        );
    }
    assert_eq!(
        vault::init(
            &alice.engine(),
            &va,
            std::slice::from_ref(&alice.fpr),
            exe()
        )
        .unwrap_err()
        .code,
        "alreadyInitialised"
    );

    std::fs::write(a.join("note.md"), NOTE).unwrap();
    commit_all(&a, "encrypted");

    let stored = blob(&a, "note.md");
    assert!(stored.starts_with(FILE_HEADER), "the blob is ciphertext");
    assert_eq!(gitcrypt::decrypt_bytes(&key, &stored).unwrap(), NOTE);
    assert_eq!(blob(&a, ".gitattributes"), root_attrs.as_bytes());
    let member = blob(&a, &member_rel);
    assert!(
        !member.starts_with(FILE_HEADER),
        "member files stay out of the filter"
    );
    assert_eq!(member, std::fs::read(a.join(&member_rel)).unwrap());
    assert_eq!(porcelain(&a), "", "clean is deterministic");

    // The textconv shows plaintext in a diff.
    std::fs::write(a.join("note.md"), [NOTE, b"more\n"].concat()).unwrap();
    let diff = String::from_utf8(git(&a, &["diff"])).unwrap();
    assert!(diff.contains("+more"), "{diff}");
    git(&a, &["checkout", "--", "note.md"]);

    // A clone without the key holds ciphertext.
    let b = root.path().join("b");
    clone(&a, &b);
    assert_eq!(std::fs::read(b.join("note.md")).unwrap(), stored);
    let vb = vault(&b);
    let st = vault::status(&vb).unwrap();
    assert!(st.encrypted && !st.unlocked && st.has_remote && !st.uses_lfs);
    assert_eq!(st.key_names, vec!["default"]);
    assert_eq!(st.members, vec![alice.fpr.clone()]);

    let u = vault::unlock(&alice.engine(), &vb, exe()).unwrap();
    assert_eq!(u.member.as_deref(), Some(alice.fpr.as_str()));
    assert!(!u.already_unlocked);
    assert!(vault::status(&vb).unwrap().unlocked);
    assert_eq!(
        std::fs::read(b.join(".git/git-crypt/keys/default")).unwrap(),
        std::fs::read(&key_path).unwrap()
    );
    recheckout(&b, &["note.md"]);
    assert_eq!(std::fs::read(b.join("note.md")).unwrap(), NOTE);
    assert_eq!(porcelain(&b), "");
    assert!(
        vault::unlock(&alice.engine(), &vb, exe())
            .unwrap()
            .already_unlocked
    );

    // Locking waits for everything to be committed, untracked files too.
    std::fs::write(b.join("draft.md"), b"draft\n").unwrap();
    assert_eq!(vault::lock(&vb).unwrap_err().code, "uncommitted");
    assert!(vault::status(&vb).unwrap().unlocked);
    std::fs::remove_file(b.join("draft.md")).unwrap();

    let l = vault::lock(&vb).unwrap();
    assert!(l.was_unlocked);
    assert!(!b.join(".git/git-crypt/keys/default").exists());
    for section in ["^filter\\.git-crypt\\.", "^diff\\.git-crypt\\."] {
        assert_eq!(
            git_raw(&b, &["config", "--get-regexp", section])
                .status
                .code(),
            Some(1)
        );
    }
    assert!(!vault::status(&vb).unwrap().unlocked);
    assert!(!vault::lock(&vb).unwrap().was_unlocked);
    recheckout(&b, &["note.md"]);
    assert_eq!(std::fs::read(b.join("note.md")).unwrap(), stored);
}

#[test]
fn members_are_added_and_removed() {
    let Some(g) = gpg_path() else { return };
    let alice = person(&g, "Alice");
    let bob = person(&g, "Bob");
    let carol = person(&g, "Carol");
    alice
        .engine()
        .import_public(&bob.armored_public_key())
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    new_repo(&a);
    let va = vault(&a);

    // Bob alone isn't enough: Alice must be able to unlock her own vault.
    let only_bob =
        vault::init(&alice.engine(), &va, std::slice::from_ref(&bob.fpr), exe()).unwrap_err();
    assert_eq!(only_bob.code, "invalidParams");
    // A member nobody imported refuses before anything is written.
    let stranger = vault::init(
        &alice.engine(),
        &va,
        &[alice.fpr.clone(), carol.fpr.clone()],
        exe(),
    )
    .unwrap_err();
    assert_eq!(stranger.code, "unknownRecipient");
    assert!(!a.join(".git-crypt").exists());
    assert!(!a.join(".gitattributes").exists());
    assert!(!a.join(".git/git-crypt").exists());
    assert_eq!(
        git_raw(&a, &["config", "--get", "filter.git-crypt.clean"])
            .status
            .code(),
        Some(1)
    );

    let init = vault::init(
        &alice.engine(),
        &va,
        std::slice::from_ref(&alice.fpr),
        exe(),
    )
    .unwrap();
    std::fs::write(a.join(".gitattributes"), &init.gitattributes).unwrap();
    std::fs::write(a.join("note.md"), NOTE).unwrap();
    commit_all(&a, "encrypted");

    let added = vault::add_member(&alice.engine(), &va, &bob.fpr).unwrap();
    let bob_rel = format!(".git-crypt/keys/default/0/{}.gpg", bob.fpr);
    assert_eq!(added.paths, vec![bob_rel.clone()]);
    assert!(a.join(&bob_rel).is_file());
    let mut both = vec![alice.fpr.clone(), bob.fpr.clone()];
    both.sort();
    assert_eq!(vault::status(&va).unwrap().members, both);
    assert!(vault::add_member(&alice.engine(), &va, &bob.fpr)
        .unwrap()
        .paths
        .is_empty());
    assert_eq!(
        vault::add_member(&alice.engine(), &va, &carol.fpr)
            .unwrap_err()
            .code,
        "unknownRecipient"
    );
    commit_all(&a, "add bob");

    // Bob unlocks his own clone with his own key.
    let c = root.path().join("c");
    clone(&a, &c);
    let vc = vault(&c);
    let u = vault::unlock(&bob.engine(), &vc, exe()).unwrap();
    assert_eq!(u.member.as_deref(), Some(bob.fpr.as_str()));
    recheckout(&c, &["note.md"]);
    assert_eq!(std::fs::read(c.join("note.md")).unwrap(), NOTE);
    // Carol isn't a member.
    let d = root.path().join("d");
    clone(&a, &d);
    assert_eq!(
        vault::unlock(&carol.engine(), &vault(&d), exe())
            .unwrap_err()
            .code,
        "noMemberKey"
    );

    let removed = vault::remove_member(&va, &bob.fpr).unwrap();
    assert_eq!(removed.paths, vec![bob_rel.clone()]);
    assert!(!a.join(&bob_rel).exists());
    assert_eq!(vault::status(&va).unwrap().members, vec![alice.fpr.clone()]);
    assert_eq!(
        vault::remove_member(&va, &bob.fpr).unwrap_err().code,
        "notAMember"
    );
    assert_eq!(
        vault::remove_member(&va, &alice.fpr).unwrap_err().code,
        "lastMember"
    );

    assert_eq!(vault::lock(&va).unwrap_err().code, "uncommitted");
    commit_all(&a, "remove bob");
    vault::lock(&va).unwrap();
    assert_eq!(
        vault::add_member(&alice.engine(), &va, &bob.fpr)
            .unwrap_err()
            .code,
        "locked"
    );
}

#[test]
fn clean_without_a_key_fails_and_git_stores_nothing() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    new_repo(&a);

    let out = ours(&a, &["clean"], b"secret");
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("Unable to open key file"));
    // smudge loads the key before it looks at its input, as git-crypt does.
    assert_eq!(ours(&a, &["smudge"], b"plain").status.code(), Some(1));

    // A clone whose key is gone but whose filter is still configured.
    let quoted = format!("\"{EXE}\"");
    git(
        &a,
        &[
            "config",
            "filter.git-crypt.clean",
            &format!("{quoted} clean"),
        ],
    );
    git(
        &a,
        &[
            "config",
            "filter.git-crypt.smudge",
            &format!("{quoted} smudge"),
        ],
    );
    git(&a, &["config", "filter.git-crypt.required", "true"]);
    std::fs::write(a.join(".gitattributes"), ROOT_GITATTRIBUTES).unwrap();
    std::fs::write(a.join("secret.md"), b"plaintext that must not be stored").unwrap();
    let add = git_raw(&a, &["add", "secret.md"]);
    assert!(!add.status.success());
    let staged = String::from_utf8(git(&a, &["ls-files", "--stage"])).unwrap();
    assert!(!staged.contains("secret.md"), "{staged}");
}

#[test]
fn filter_commands_with_a_key_file() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path();
    let key = KeyFile::generate(None).unwrap();
    let k = dir.join("k");
    std::fs::write(&k, key.store()).unwrap();
    let kf = format!("--key-file={}", k.display());

    let a = ours(dir, &["clean", &kf], NOTE);
    assert_eq!(a.status.code(), Some(0));
    assert!(a.stdout.starts_with(FILE_HEADER));
    let b = ours(dir, &["clean", "--key-file", k.to_str().unwrap()], NOTE);
    assert_eq!(a.stdout, b.stdout, "deterministic");
    let s = ours(dir, &["smudge", &kf], &a.stdout);
    assert_eq!(s.status.code(), Some(0));
    assert_eq!(s.stdout, NOTE);
    assert!(s.stderr.is_empty());

    // Plain input passes through smudge, with git-crypt's warning.
    let p = ours(dir, &["smudge", &kf], b"not encrypted");
    assert_eq!(p.status.code(), Some(0));
    assert_eq!(p.stdout, b"not encrypted");
    assert!(String::from_utf8_lossy(&p.stderr).contains("file not encrypted"));

    // A changed byte: the output is written, the exit says it's no good.
    let mut bad = a.stdout.clone();
    *bad.last_mut().unwrap() ^= 1;
    let t = ours(dir, &["smudge", &kf], &bad);
    assert_eq!(t.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&t.stderr).contains("tampered"));

    // diff (the textconv) reads a file.
    let ct = dir.join("ct");
    std::fs::write(&ct, &a.stdout).unwrap();
    let d = ours(dir, &["diff", &kf, ct.to_str().unwrap()], b"");
    assert_eq!((d.status.code(), d.stdout.as_slice()), (Some(0), NOTE));
    let plain = dir.join("plain");
    std::fs::write(&plain, b"plain").unwrap();
    let d = ours(dir, &["diff", &kf, plain.to_str().unwrap()], b"");
    assert_eq!(
        (d.status.code(), d.stdout.as_slice()),
        (Some(0), &b"plain"[..])
    );

    // The legacy positional key file (pre-0.4: the two keys, nothing else).
    let e = key.get(0).unwrap();
    let legacy = dir.join("legacy");
    std::fs::write(&legacy, [&e.aes_key[..], &e.hmac_key[..]].concat()).unwrap();
    let l = ours(dir, &["clean", legacy.to_str().unwrap()], NOTE);
    assert_eq!(l.stdout, a.stdout);

    // Usage errors are 2; a key name git-crypt would never write, 1.
    assert_eq!(ours(dir, &["clean", "a", "b"], b"").status.code(), Some(2));
    assert_eq!(ours(dir, &["clean", "--bogus"], b"").status.code(), Some(2));
    assert_eq!(ours(dir, &["diff", &kf], b"").status.code(), Some(2));
    assert_eq!(
        ours(dir, &["clean", "--key-name=../../x"], b"")
            .status
            .code(),
        Some(1)
    );

    // The key from $GIT_DIR, as git sets it for its filters.
    let gd = dir.join("gd");
    std::fs::create_dir_all(gd.join("git-crypt/keys")).unwrap();
    std::fs::write(gd.join("git-crypt/keys/default"), key.store()).unwrap();
    let mut cmd = Command::new(EXE);
    cmd.arg("smudge").current_dir(dir).env("GIT_DIR", &gd);
    let g = run_with_input(&mut cmd, &a.stdout);
    assert_eq!((g.status.code(), g.stdout.as_slice()), (Some(0), NOTE));
}

// ---- compatibility with the real git-crypt ----------------------------------

/// Same key file, same plaintext → the same bytes, from either
/// implementation, at every size where the format has an edge; and each
/// decrypts the other's output.
#[test]
fn clean_and_smudge_match_git_crypt_byte_for_byte() {
    let Some(gc) = real_git_crypt() else { return };
    let root = tempfile::tempdir().unwrap();
    let dir = root.path();
    let k = dir.join("k");
    ok(
        real(&gc, dir, &["keygen", k.to_str().unwrap()], None)
            .output()
            .unwrap(),
        "git-crypt keygen",
    );
    let raw = std::fs::read(&k).unwrap();
    assert_eq!(
        KeyFile::load(&raw).unwrap().store(),
        raw,
        "the key file round-trips"
    );
    let kf = format!("--key-file={}", k.display());

    for (name, pt) in sized_files()
        .into_iter()
        .chain([(String::from("kat"), NOTE.to_vec())])
    {
        let theirs = ok(
            run_with_input(&mut real(&gc, dir, &["clean", &kf], None), &pt),
            "git-crypt clean",
        )
        .stdout;
        let mine = ok(ours(dir, &["clean", &kf], &pt), "our clean").stdout;
        assert!(theirs == mine, "{name}: clean differs from git-crypt's");
        let back = ok(
            run_with_input(&mut real(&gc, dir, &["smudge", &kf], None), &mine),
            "git-crypt smudge",
        )
        .stdout;
        assert!(back == pt, "{name}: git-crypt can't read ours");
        let back = ok(ours(dir, &["smudge", &kf], &theirs), "our smudge").stdout;
        assert!(back == pt, "{name}: we can't read git-crypt's");
    }
}

/// A vault made by `initVault` opens with `git-crypt unlock`, both with
/// the exported key file and with the member's GPG key.
#[test]
fn git_crypt_unlocks_a_vault_we_made() {
    let Some(gc) = real_git_crypt() else { return };
    let Some(g) = gpg_path() else { return };
    let alice = person(&g, "Alice");
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    new_repo(&a);
    let va = vault(&a);
    let init = vault::init(
        &alice.engine(),
        &va,
        std::slice::from_ref(&alice.fpr),
        exe(),
    )
    .unwrap();
    std::fs::write(a.join(".gitattributes"), &init.gitattributes).unwrap();
    std::fs::write(a.join("note.md"), NOTE).unwrap();
    let files = sized_files();
    std::fs::create_dir_all(a.join("data")).unwrap();
    for (name, data) in &files {
        std::fs::write(a.join(name), data).unwrap();
    }
    commit_all(&a, "encrypted by the sidecar");
    let key_path = a.join(".git/git-crypt/keys/default");

    // With the symmetric key file.
    let b = root.path().join("b");
    clone(&a, &b);
    assert!(std::fs::read(b.join("note.md"))
        .unwrap()
        .starts_with(FILE_HEADER));
    ok(
        real(&gc, &b, &["unlock", key_path.to_str().unwrap()], None)
            .output()
            .unwrap(),
        "git-crypt unlock KEYFILE",
    );
    assert_eq!(std::fs::read(b.join("note.md")).unwrap(), NOTE);
    for (name, data) in &files {
        assert!(&std::fs::read(b.join(name)).unwrap() == data, "{name}");
    }
    assert_eq!(
        std::fs::read(b.join(".git/git-crypt/keys/default")).unwrap(),
        std::fs::read(&key_path).unwrap(),
        "git-crypt stores the same key file"
    );
    assert_eq!(porcelain(&b), "");

    // With Alice's GPG key, through the member file.
    let c = root.path().join("c");
    clone(&a, &c);
    ok(
        real(&gc, &c, &["unlock"], Some(&alice)).output().unwrap(),
        "git-crypt unlock (GPG)",
    );
    assert_eq!(std::fs::read(c.join("note.md")).unwrap(), NOTE);
    assert_eq!(
        std::fs::read(c.join(".git/git-crypt/keys/default")).unwrap(),
        std::fs::read(&key_path).unwrap()
    );
}

/// A vault `git-crypt init` + `add-gpg-user` made is unlocked by
/// `unlockVault`, decrypted by our smudge, and re-encrypted by our clean to
/// the very blobs git-crypt committed; `git-crypt lock` then undoes our
/// unlock.
#[test]
fn we_unlock_a_vault_git_crypt_made() {
    let Some(gc) = real_git_crypt() else { return };
    let Some(g) = gpg_path() else { return };
    let alice = person(&g, "Alice");
    let root = tempfile::tempdir().unwrap();
    let r = root.path().join("r");
    new_repo(&r);
    ok(
        real(&gc, &r, &["init"], None).output().unwrap(),
        "git-crypt init",
    );
    std::fs::write(r.join(".gitattributes"), ROOT_GITATTRIBUTES).unwrap();
    std::fs::write(r.join("note.md"), NOTE).unwrap();
    commit_all(&r, "encrypted by git-crypt");
    ok(
        real(
            &gc,
            &r,
            &["add-gpg-user", "--trusted", &format!("0x{}", alice.fpr)],
            Some(&alice),
        )
        .output()
        .unwrap(),
        "git-crypt add-gpg-user",
    );
    let stored = blob(&r, "note.md");
    assert!(stored.starts_with(FILE_HEADER));
    assert_eq!(
        blob(&r, ".git-crypt/.gitattributes"),
        STATE_GITATTRIBUTES.as_bytes(),
        "the same .git-crypt/.gitattributes"
    );
    let theirs_key = std::fs::read(r.join(".git/git-crypt/keys/default")).unwrap();

    let c = root.path().join("c");
    clone(&r, &c);
    assert_eq!(std::fs::read(c.join("note.md")).unwrap(), stored);
    let vc = vault(&c);
    let st = vault::status(&vc).unwrap();
    assert!(st.encrypted && !st.unlocked);
    assert_eq!(st.members, vec![alice.fpr.clone()]);

    let u = vault::unlock(&alice.engine(), &vc, exe()).unwrap();
    assert_eq!(u.member.as_deref(), Some(alice.fpr.as_str()));
    let ours_key = std::fs::read(c.join(".git/git-crypt/keys/default")).unwrap();
    assert_eq!(ours_key, theirs_key, "the same key file, byte for byte");
    recheckout(&c, &["note.md"]);
    assert_eq!(std::fs::read(c.join("note.md")).unwrap(), NOTE);
    assert_eq!(porcelain(&c), "", "our clean reproduces git-crypt's blob");
    let kf = format!(
        "--key-file={}",
        c.join(".git/git-crypt/keys/default").display()
    );
    assert_eq!(ours(&c, &["clean", &kf], NOTE).stdout, stored);

    // git-crypt's lock reads our filter config and key location.
    ok(
        real(&gc, &c, &["lock"], None).output().unwrap(),
        "git-crypt lock",
    );
    assert!(!c.join(".git/git-crypt/keys/default").exists());
    assert_eq!(std::fs::read(c.join("note.md")).unwrap(), stored);
    assert!(!vault::status(&vc).unwrap().unlocked);
}

#[test]
fn a_vault_using_git_lfs_is_refused() {
    let Some(g) = gpg_path() else { return };
    let alice = person(&g, "Alice");
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    new_repo(&a);
    let attrs = "*.png filter=lfs diff=lfs merge=lfs -text\n";
    std::fs::write(a.join(".gitattributes"), attrs).unwrap();
    let va = vault(&a);
    assert!(vault::status(&va).unwrap().uses_lfs);
    let err = vault::init(
        &alice.engine(),
        &va,
        std::slice::from_ref(&alice.fpr),
        exe(),
    )
    .unwrap_err();
    assert_eq!(err.code, "usesLfs");
    assert!(!a.join(".git-crypt").exists());
    assert!(!a.join(".git/git-crypt").exists());
    assert_eq!(
        std::fs::read_to_string(a.join(".gitattributes")).unwrap(),
        attrs
    );
}
