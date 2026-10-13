//! `git-crypt`: with no arguments, the mahfouz/encryption plugin's sidecar.
//! A later version adds git-crypt's filter modes (`clean`, `smudge`,
//! `textconv`) under the same name; until then any argument is refused, so
//! this binary never passes for a working git-crypt filter.

use std::io;

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|a| a == "--version") {
        println!(
            "git-crypt (mahfouz/encryption sidecar) {}",
            env!("CARGO_PKG_VERSION")
        );
        return;
    }
    if !args.is_empty() {
        eprintln!(
            "git-crypt (mahfouz/encryption {}): this version has no filter modes; \
             run it with no arguments as the Mahfouz plugin sidecar",
            env!("CARGO_PKG_VERSION")
        );
        std::process::exit(2);
    }
    let ctx = encryption_sidecar::rpc::Context::from_env();
    encryption_sidecar::rpc::serve(ctx, io::stdin().lock(), io::stdout());
}
