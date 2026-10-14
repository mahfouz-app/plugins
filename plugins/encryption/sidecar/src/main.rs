//! `git-crypt`: with no arguments, the mahfouz/encryption plugin's sidecar
//! (JSON-RPC over stdin/stdout, see `rpc`). With `clean`, `smudge` or
//! `diff`, git-crypt's filter commands, which git runs for paths whose
//! attributes say `filter=git-crypt diff=git-crypt` (see `filter`). Any
//! other command is git-crypt's to run: this binary only stands in for it
//! as git's filter.

use std::ffi::OsString;
use std::io;

fn main() {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let Some(first) = args.first() else {
        let ctx = encryption_sidecar::rpc::Context::from_env();
        encryption_sidecar::rpc::serve(ctx, io::stdin().lock(), io::stdout());
        return;
    };
    let first = first.to_string_lossy();
    if first == "--version" || first == "version" {
        println!(
            "git-crypt (mahfouz/encryption sidecar) {}",
            env!("CARGO_PKG_VERSION")
        );
        return;
    }
    if let Some(cmd) = encryption_sidecar::filter::COMMANDS
        .iter()
        .find(|c| **c == first)
    {
        std::process::exit(encryption_sidecar::filter::main(cmd, &args[1..]));
    }
    eprintln!(
        "git-crypt (mahfouz/encryption {}): '{first}' isn't one of this binary's commands; \
         it only runs git's filters (clean, smudge, diff). Use git-crypt itself for the rest.",
        env!("CARGO_PKG_VERSION")
    );
    std::process::exit(2);
}
