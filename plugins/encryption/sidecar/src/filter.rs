//! git-crypt's filter commands, run by git: `clean` (stdin → ciphertext on
//! stdout), `smudge` (the reverse) and `diff FILE` (the textconv), each
//! with `--key-name NAME`/`-k NAME`/`--key-file PATH` and git-crypt's
//! deprecated positional legacy key file. Arguments, messages and exit codes
//! follow git-crypt 0.8.0 (`commands.cpp:705-946`, `git-crypt.cpp:183-264`,
//! `parse_options.cpp`):
//!
//! - 0: done. `smudge` and `diff` copy input that isn't encrypted through
//!   unchanged (`smudge` warns on stderr).
//! - 1: an error: no key file (so a `clean` without a key always fails and
//!   git, with `filter.git-crypt.required`, stores nothing), a malformed or
//!   incompatible key file, an I/O error, a file of 4 GiB or more, or a
//!   decrypted file whose HMAC doesn't match (its output has already been
//!   written; git discards it on the non-zero exit).
//! - 2: bad usage.
//!
//! The key is `.git/git-crypt/keys/<name>` (`default` without a name) in the
//! git directory: `$GIT_DIR` when git set it, else `git rev-parse --git-dir`
//! (`get_internal_state_path`, `commands.cpp:240-259`).

use std::ffi::OsString;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::gitcrypt::{self, CryptError, KeyError, KeyFile, PREFIX_LEN};

/// The filter commands, for `main`.
pub const COMMANDS: [&str; 3] = ["clean", "smudge", "diff"];

struct Options {
    key_name: Option<String>,
    key_file: Option<PathBuf>,
    positional: Vec<OsString>,
}

/// An error that ends the command, with its exit code.
#[derive(Debug)]
struct Fail(i32, String);

impl From<io::Error> for Fail {
    fn from(e: io::Error) -> Self {
        Fail(1, format!("git-crypt: I/O error: {e}"))
    }
}

/// `parse_plumbing_options`: `-k NAME`, `-kNAME`, `--key-name NAME`,
/// `--key-name=NAME`, `--key-file PATH`, `--key-file=PATH`, `--` ends the
/// options. Anything else starting with `-` (but not `-` alone) is invalid.
fn parse(args: &[OsString]) -> Result<Options, Fail> {
    let mut o = Options {
        key_name: None,
        key_file: None,
        positional: vec![],
    };
    let mut i = 0;
    let invalid = |name: &str, why: &str| Fail(2, format!("git-crypt: Error: {name}: {why}"));
    while i < args.len() {
        let a = args[i].to_string_lossy().into_owned();
        if !a.starts_with('-') || a == "-" {
            break;
        }
        i += 1;
        if a == "--" {
            break;
        }
        let (name, inline) = if let Some(long) = a.strip_prefix("--") {
            match long.split_once('=') {
                Some((n, v)) => (format!("--{n}"), Some(v.to_string())),
                None => (a.clone(), None),
            }
        } else {
            // `-kNAME`: the option is the first character, the rest its value.
            let mut chars = a[1..].chars();
            let c = chars.next().expect("longer than \"-\"");
            let rest = chars.as_str();
            (
                format!("-{c}"),
                (!rest.is_empty()).then(|| rest.to_string()),
            )
        };
        if !matches!(name.as_str(), "-k" | "--key-name" | "--key-file") {
            return Err(invalid(&name, "Invalid option"));
        }
        let value = match inline {
            Some(v) => OsString::from(v),
            None => {
                let v = args
                    .get(i)
                    .cloned()
                    .ok_or_else(|| invalid(&name, "Option requires a value"))?;
                i += 1;
                v
            }
        };
        if name == "--key-file" {
            o.key_file = Some(PathBuf::from(value));
        } else {
            o.key_name = Some(value.to_string_lossy().into_owned());
        }
    }
    o.positional = args[i..].to_vec();
    Ok(o)
}

/// `GIT_DIR`, else `git rev-parse --git-dir`, from the current directory.
pub fn git_dir() -> Result<PathBuf, String> {
    if let Some(d) = std::env::var_os("GIT_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(d));
    }
    let out = Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .output()
        .map_err(|e| {
            format!("'git rev-parse --git-dir' failed - is this a Git repository? ({e})")
        })?;
    if !out.status.success() {
        return Err("'git rev-parse --git-dir' failed - is this a Git repository?".into());
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().next().unwrap_or("").to_string();
    if line.is_empty() {
        return Err("'git rev-parse --git-dir' failed - is this a Git repository?".into());
    }
    Ok(PathBuf::from(line))
}

/// `<git dir>/git-crypt/keys/<name>`.
pub fn internal_key_path(git_dir: &Path, key_name: Option<&str>) -> PathBuf {
    git_dir
        .join("git-crypt")
        .join("keys")
        .join(key_name.unwrap_or("default"))
}

fn key_error(e: KeyError) -> Fail {
    Fail(
        1,
        match e {
            KeyError::Malformed => {
                "git-crypt: This repository contains a malformed key file.  It may be corrupted."
            }
            KeyError::Incompatible => {
                "git-crypt: This repository contains a incompatible key file.  Please upgrade git-crypt."
            }
        }
        .into(),
    )
}

/// `load_key` (`commands.cpp:589-611`).
fn load_key(o: &Options, legacy: Option<&Path>) -> Result<KeyFile, Fail> {
    if let Some(p) = legacy {
        let data = std::fs::read(p).map_err(|_| {
            Fail(
                1,
                format!("git-crypt: Error: Unable to open key file: {}", p.display()),
            )
        })?;
        return KeyFile::load_legacy(&data).map_err(key_error);
    }
    if let Some(p) = &o.key_file {
        let data = std::fs::read(p).map_err(|_| {
            Fail(
                1,
                format!("git-crypt: Error: Unable to open key file: {}", p.display()),
            )
        })?;
        return KeyFile::load(&data).map_err(key_error);
    }
    if let Some(name) = &o.key_name {
        // git-crypt joins the name into the path unchecked; a name it could
        // never have written is refused here instead of read.
        if !gitcrypt::valid_key_name(name) {
            return Err(Fail(
                1,
                format!("git-crypt: Error: invalid key name {name:?}"),
            ));
        }
    }
    let dir = git_dir().map_err(|e| Fail(1, format!("git-crypt: Error: {e}")))?;
    let path = internal_key_path(&dir, o.key_name.as_deref());
    let data = std::fs::read(&path).map_err(|_| {
        Fail(
            1,
            "git-crypt: Error: Unable to open key file - have you unlocked/initialized this repository yet?"
                .into(),
        )
    })?;
    KeyFile::load(&data).map_err(key_error)
}

fn crypt_error(e: CryptError) -> Fail {
    match e {
        CryptError::Io(e) => Fail(1, format!("git-crypt: I/O error: {e}")),
        other => Fail(1, format!("git-crypt: error: {other}")),
    }
}

/// `clean`/`smudge` take no positional argument, or one (a legacy key
/// file) when no key option is given. `diff` takes the file, plus the
/// legacy key file before it.
fn split_positional<'a>(
    o: &'a Options,
    command: &str,
) -> Result<(Option<&'a Path>, Option<&'a Path>), Fail> {
    let n = o.positional.len();
    let no_key_opt = o.key_name.is_none() && o.key_file.is_none();
    let p = |i: usize| Some(Path::new(o.positional[i].as_os_str()));
    let usage = || {
        Fail(
            2,
            if command == "diff" {
                "Usage: git-crypt diff [--key-name=NAME] [--key-file=PATH] FILENAME".into()
            } else {
                format!("Usage: git-crypt {command} [--key-name=NAME] [--key-file=PATH]")
            },
        )
    };
    match (command, n) {
        ("diff", 1) => Ok((None, p(0))),
        ("diff", 2) if no_key_opt => Ok((p(0), p(1))),
        ("diff", _) => Err(usage()),
        (_, 0) => Ok((None, None)),
        (_, 1) if no_key_opt => Ok((p(0), None)),
        _ => Err(usage()),
    }
}

fn run(command: &str, args: &[OsString]) -> Result<(), Fail> {
    let o = parse(args)?;
    let (legacy, file) = split_positional(&o, command)?;
    let key = load_key(&o, legacy)?;
    let stdout = io::stdout();
    let mut out = BufWriter::with_capacity(64 * 1024, stdout.lock());
    match command {
        "clean" => {
            if key.is_empty() {
                return Err(Fail(1, "git-crypt: error: key file is empty".into()));
            }
            gitcrypt::encrypt(&key, io::stdin().lock(), &mut out).map_err(crypt_error)
        }
        "smudge" => {
            let mut input = io::stdin().lock();
            let mut prefix = [0u8; PREFIX_LEN];
            let n = gitcrypt::read_full(&mut input, &mut prefix)?;
            if !gitcrypt::is_encrypted(&prefix[..n]) {
                eprintln!("git-crypt: Warning: file not encrypted");
                eprintln!("git-crypt: Run 'git-crypt status' to make sure all files are properly encrypted.");
                eprintln!("git-crypt: If 'git-crypt status' reports no problems, then an older version of");
                eprintln!(
                    "git-crypt: this file may be unencrypted in the repository's history.  If this"
                );
                eprintln!("git-crypt: file contains sensitive information, you can use 'git filter-branch'");
                eprintln!("git-crypt: to remove its old versions from the history.");
                out.write_all(&prefix[..n])?;
                io::copy(&mut input, &mut out)?;
                out.flush()?;
                return Ok(());
            }
            gitcrypt::decrypt_rest(&key, &prefix, input, &mut out).map_err(crypt_error)
        }
        "diff" => {
            let file = file.expect("split_positional gives diff a file");
            let mut input = std::fs::File::open(file).map_err(|_| {
                Fail(
                    1,
                    format!("git-crypt: {}: unable to open for reading", file.display()),
                )
            })?;
            let mut prefix = [0u8; PREFIX_LEN];
            let n = gitcrypt::read_full(&mut input, &mut prefix)?;
            if !gitcrypt::is_encrypted(&prefix[..n]) {
                out.write_all(&prefix[..n])?;
                io::copy(&mut input, &mut out)?;
                out.flush()?;
                return Ok(());
            }
            gitcrypt::decrypt_rest(&key, &prefix, input, &mut out).map_err(crypt_error)
        }
        _ => unreachable!("main only routes the filter commands here"),
    }
}

/// Runs a filter command; its exit code.
pub fn main(command: &str, args: &[OsString]) -> i32 {
    match run(command, args) {
        Ok(()) => 0,
        Err(Fail(code, msg)) => {
            eprintln!("{msg}");
            code
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(v: &[&str]) -> Vec<OsString> {
        v.iter().map(OsString::from).collect()
    }

    #[test]
    fn options_the_way_git_crypt_reads_them() {
        let o = parse(&os(&["--key-name=work"])).unwrap();
        assert_eq!(o.key_name.as_deref(), Some("work"));
        let o = parse(&os(&["--key-name", "work", "x"])).unwrap();
        assert_eq!(o.key_name.as_deref(), Some("work"));
        assert_eq!(o.positional, os(&["x"]));
        let o = parse(&os(&["-kwork"])).unwrap();
        assert_eq!(o.key_name.as_deref(), Some("work"));
        let o = parse(&os(&["-k", "work"])).unwrap();
        assert_eq!(o.key_name.as_deref(), Some("work"));
        let o = parse(&os(&["--key-file=/k", "--", "-f"])).unwrap();
        assert_eq!(o.key_file, Some(PathBuf::from("/k")));
        assert_eq!(o.positional, os(&["-f"]));
        let o = parse(&os(&["-", "y"])).unwrap();
        assert_eq!(o.positional, os(&["-", "y"]));
        assert_eq!(parse(&os(&["--nope"])).err().unwrap().0, 2);
        assert_eq!(parse(&os(&["-x"])).err().unwrap().0, 2);
        assert_eq!(parse(&os(&["--key-name"])).err().unwrap().0, 2);
    }

    #[test]
    fn positional_arguments() {
        let o = parse(&os(&[])).unwrap();
        assert!(matches!(split_positional(&o, "clean"), Ok((None, None))));
        let o = parse(&os(&["legacy"])).unwrap();
        assert!(matches!(
            split_positional(&o, "smudge"),
            Ok((Some(_), None))
        ));
        let o = parse(&os(&["-k", "w", "legacy"])).unwrap();
        assert_eq!(split_positional(&o, "clean").err().unwrap().0, 2);
        let o = parse(&os(&["a", "b"])).unwrap();
        assert_eq!(split_positional(&o, "clean").err().unwrap().0, 2);
        assert!(matches!(
            split_positional(&o, "diff"),
            Ok((Some(_), Some(_)))
        ));
        let o = parse(&os(&[])).unwrap();
        assert_eq!(split_positional(&o, "diff").err().unwrap().0, 2);
    }
}
