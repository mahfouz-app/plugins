//! Finding gpg and running it: fixed argv, stdin/stdout pipes, a separate
//! status pipe, bounded output and a timeout. Never a shell.

use std::ffi::{OsStr, OsString};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::error::{Error, Result};

/// Where gpg is looked for after `PATH`: Homebrew on Apple Silicon and on
/// Intel, then GPG Suite. An app launched from the Dock gets a minimal
/// `PATH`, so these matter more than `PATH` does.
pub const FALLBACK_DIRS: [&str; 3] = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/local/MacGPG2/bin",
];
const NAMES: [&str; 2] = ["gpg", "gpg2"];

/// The oldest gpg with everything used here: `--recipient-file` (2.1.14)
/// and `--unwrap` (2.1.10).
pub const MIN_VERSION: (u32, u32, u32) = (2, 1, 14);

/// The status pipe's descriptor in the child.
const STATUS_FD: i32 = 3;

const MAX_STDERR: usize = 64 * 1024;
const MAX_STATUS: usize = 1024 * 1024;
/// How long to wait for the pipes to close once gpg has exited.
const DRAIN_WAIT: Duration = Duration::from_secs(5);

/// Every directory searched, in order: `PATH`'s absolute entries, then
/// [`FALLBACK_DIRS`].
pub fn search_dirs(path_var: Option<&OsStr>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = path_var
        .map(|p| {
            std::env::split_paths(p)
                .filter(|d| d.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    for d in FALLBACK_DIRS {
        let d = PathBuf::from(d);
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs
}

fn is_executable(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The first `gpg` (or `gpg2`) in [`search_dirs`], as an absolute path.
pub fn resolve(path_var: Option<&OsStr>) -> Option<PathBuf> {
    search_dirs(path_var)
        .into_iter()
        .find_map(|dir| NAMES.iter().map(|n| dir.join(n)).find(|c| is_executable(c)))
}

/// A tool installed next to gpg (`gpgconf`, `gpg-connect-agent`).
pub fn sibling(gpg: &Path, name: &str) -> Option<PathBuf> {
    let p = gpg.parent()?.join(name);
    is_executable(&p).then_some(p)
}

/// `2.4.7` from `gpg (GnuPG/MacGPG2) 2.4.7`.
pub fn parse_version(version_output: &str) -> Option<(String, (u32, u32, u32))> {
    let first = version_output.lines().next()?;
    let v = first.split_whitespace().last()?;
    let mut nums = v.split(['.', '-']).map(|n| n.parse::<u32>());
    let parsed = (
        nums.next()?.ok()?,
        nums.next()?.ok()?,
        nums.next().and_then(|r| r.ok()).unwrap_or(0),
    );
    Some((v.to_string(), parsed))
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub timeout: Duration,
    pub max_stdout: usize,
}

#[derive(Debug)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub status: String,
    pub stderr: String,
    pub success: bool,
}

impl Output {
    /// gpg's last `gpg: …` log line, for an error message. gpg never logs
    /// message contents there.
    pub fn last_log_line(&self) -> String {
        let line = self
            .stderr
            .lines()
            .rev()
            .find(|l| l.starts_with("gpg: "))
            .unwrap_or("")
            .trim();
        line.chars().take(300).collect()
    }
}

/// Reads all of `r`, keeping at most `max` bytes. `None` when there was
/// more.
fn read_bounded(mut r: impl Read, max: usize) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    let mut over = false;
    loop {
        match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if out.len() + n > max {
                    over = true;
                } else {
                    out.extend_from_slice(&buf[..n]);
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    (!over).then_some(out)
}

fn spawn_reader(r: impl Read + Send + 'static, max: usize) -> mpsc::Receiver<Option<Vec<u8>>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(read_bounded(r, max));
    });
    rx
}

/// Runs `program args…` with `input` on stdin. With `status`, gpg's status
/// lines go to a pipe of their own (`--status-fd 3`), so nothing in gpg's
/// human-readable log can pass for one. Without it, the child gets the
/// args as given.
pub fn exec(
    program: &Path,
    args: &[OsString],
    input: &[u8],
    limits: Limits,
    status: bool,
) -> Result<Output> {
    let gpg_err = |e: io::Error| {
        Error::new(
            "gpgFailed",
            format!("couldn't run {}: {e}", program.display()),
        )
    };
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut status_pipe = None;
    if status {
        cmd.arg("--status-fd").arg(STATUS_FD.to_string());
        let (r, w) = io::pipe().map_err(gpg_err)?;
        let wfd = w.as_raw_fd();
        // std's pipes are close-on-exec, so no other child can inherit the
        // write end; here it's put on fd 3 for this child alone. dup2 and
        // fcntl are async-signal-safe.
        unsafe {
            cmd.pre_exec(move || {
                if wfd == STATUS_FD {
                    let flags = libc::fcntl(wfd, libc::F_GETFD);
                    if flags < 0 || libc::fcntl(wfd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                } else if libc::dup2(wfd, STATUS_FD) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        status_pipe = Some((r, w));
    }
    cmd.args(args);
    let mut child = cmd.spawn().map_err(gpg_err)?;
    // The parent's copy of the write end must close, or the status reader
    // never sees EOF.
    let status_rx = status_pipe.map(|(r, w)| {
        drop(w);
        spawn_reader(r, MAX_STATUS)
    });
    let stdout_rx = spawn_reader(child.stdout.take().expect("piped"), limits.max_stdout);
    let stderr_rx = spawn_reader(child.stderr.take().expect("piped"), MAX_STDERR);
    let mut stdin = child.stdin.take().expect("piped");
    let data = input.to_vec();
    thread::spawn(move || {
        // A broken pipe means gpg stopped reading, which its exit reports.
        let _ = stdin.write_all(&data);
    });

    let deadline = Instant::now() + limits.timeout;
    let exit = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(gpg_err(e)),
        }
    };
    let Some(exit) = exit else {
        return Err(Error::new(
            "timeout",
            format!(
                "gpg didn't finish within {} seconds",
                limits.timeout.as_secs()
            ),
        ));
    };
    let drained = |rx: mpsc::Receiver<Option<Vec<u8>>>| {
        rx.recv_timeout(DRAIN_WAIT)
            .map_err(|_| Error::new("gpgFailed", "gpg left its output open"))
    };
    let stdout = drained(stdout_rx)?.ok_or_else(|| {
        Error::new(
            "tooLarge",
            format!("gpg's output is larger than {} bytes", limits.max_stdout),
        )
    })?;
    let stderr = String::from_utf8_lossy(&drained(stderr_rx)?.unwrap_or_default()).into_owned();
    let status = match status_rx {
        Some(rx) => String::from_utf8_lossy(
            &drained(rx)?.ok_or_else(|| Error::new("gpgFailed", "too many status lines"))?,
        )
        .into_owned(),
        None => String::new(),
    };
    Ok(Output {
        stdout,
        status,
        stderr,
        success: exit.success(),
    })
}

/// One gpg installation, and the user's keyring (`None`: gpg's default,
/// `$GNUPGHOME` or `~/.gnupg`).
#[derive(Debug, Clone)]
pub struct Gpg {
    pub path: PathBuf,
    pub user_home: Option<PathBuf>,
}

impl Gpg {
    /// gpg in `home` (`None`: the user's keyring), always `--batch
    /// --no-tty` with a status pipe, and never reaching the network for a
    /// key.
    pub fn run(
        &self,
        home: Option<&Path>,
        args: &[OsString],
        input: &[u8],
        limits: Limits,
    ) -> Result<Output> {
        let mut full: Vec<OsString> = vec![];
        if let Some(h) = home.or(self.user_home.as_deref()) {
            full.push("--homedir".into());
            full.push(h.into());
        }
        for a in [
            "--batch",
            "--no-tty",
            "--no-auto-key-locate",
            "--no-auto-key-retrieve",
        ] {
            full.push(a.into());
        }
        full.extend(args.iter().cloned());
        exec(&self.path, &full, input, limits, true)
    }

    pub fn version(&self) -> Result<(String, (u32, u32, u32))> {
        let out = exec(
            &self.path,
            &["--version".into()],
            b"",
            Limits {
                timeout: Duration::from_secs(10),
                max_stdout: 64 * 1024,
            },
            false,
        )?;
        parse_version(&String::from_utf8_lossy(&out.stdout))
            .ok_or_else(|| Error::new("gpgFailed", "couldn't read gpg's version"))
    }

    /// Whether the user's gpg-agent is running (never starts it).
    pub fn agent_running(&self) -> bool {
        let Some(tool) = sibling(&self.path, "gpg-connect-agent") else {
            return false;
        };
        let mut args: Vec<OsString> = vec![];
        if let Some(h) = &self.user_home {
            args.push("--homedir".into());
            args.push(h.into());
        }
        args.push("--no-autostart".into());
        args.push("/bye".into());
        exec(
            &tool,
            &args,
            b"",
            Limits {
                timeout: Duration::from_secs(10),
                max_stdout: 64 * 1024,
            },
            false,
        )
        .is_ok_and(|o| o.success)
    }

    /// Stops any daemon gpg started for `home` (a throwaway keyring).
    pub fn kill_daemons(&self, home: &Path) {
        if let Some(gpgconf) = sibling(&self.path, "gpgconf") {
            let _ = exec(
                &gpgconf,
                &[
                    "--homedir".into(),
                    home.into(),
                    "--kill".into(),
                    "all".into(),
                ],
                b"",
                Limits {
                    timeout: Duration::from_secs(10),
                    max_stdout: 64 * 1024,
                },
                false,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_first_then_the_fallbacks_and_only_absolute_entries() {
        let dirs = search_dirs(Some(OsStr::new("relative:/usr/bin:/opt/homebrew/bin")));
        assert_eq!(
            dirs,
            [
                "/usr/bin",
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/local/MacGPG2/bin"
            ]
            .map(PathBuf::from)
        );
        assert_eq!(search_dirs(None).len(), 3);
    }

    #[test]
    fn versions() {
        assert_eq!(
            parse_version("gpg (GnuPG/MacGPG2) 2.4.7\nlibgcrypt 1.10"),
            Some(("2.4.7".into(), (2, 4, 7)))
        );
        assert_eq!(
            parse_version("gpg (GnuPG) 2.2.27-beta"),
            Some(("2.2.27-beta".into(), (2, 2, 27)))
        );
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn status_lines_come_through_their_own_pipe_and_output_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-gpg");
        // Ignores its arguments (`--status-fd 3`), like a gpg that only
        // writes: a status line on fd 3, data on stdout, a log on stderr,
        // and a log line pretending to be a status line.
        std::fs::write(
            &script,
            "#!/bin/sh\necho '[GNUPG:] GOODSIG x' >&3\necho \"$@\"\necho '[GNUPG:] BADSIG forged' >&2\necho 'gpg: log' >&2\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let limits = Limits {
            timeout: Duration::from_secs(10),
            max_stdout: 64,
        };
        let out = exec(&script, &["x".into()], b"", limits, true).unwrap();
        assert!(out.success);
        assert_eq!(out.stdout, b"--status-fd 3 x\n");
        assert_eq!(out.status, "[GNUPG:] GOODSIG x\n");
        assert_eq!(out.last_log_line(), "gpg: log");

        let small = Limits {
            max_stdout: 4,
            ..limits
        };
        let big = exec(&script, &["x".into()], b"", small, true);
        assert_eq!(big.unwrap_err().code, "tooLarge");
    }

    #[test]
    fn a_hung_process_times_out() {
        let err = exec(
            Path::new("/bin/sleep"),
            &["5".into()],
            b"",
            Limits {
                timeout: Duration::from_millis(200),
                max_stdout: 8,
            },
            false,
        )
        .unwrap_err();
        assert_eq!(err.code, "timeout");
    }
}
