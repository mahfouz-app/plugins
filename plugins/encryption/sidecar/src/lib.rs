//! The `mahfouz/encryption` plugin's sidecar: per-note OpenPGP encryption
//! through the user's own `gpg`.
//!
//! Run with no arguments, the `git-crypt` binary speaks the app's native
//! sidecar protocol (newline-delimited JSON-RPC 2.0 over stdin/stdout, see
//! [`rpc`]). The methods live in [`ops`].
//!
//! Two keyrings take part, and neither is ever written to by the other's
//! operations:
//!
//! - the **user's** (`~/.gnupg`, or `$GNUPGHOME`): their secret keys and
//!   gpg-agent, used to sign and decrypt. Pinentry asks for the passphrase
//!   or a card touch, as configured in gpg-agent. Nothing is ever imported
//!   into it.
//! - the **plugin's** (`<plugin data>/gnupg-recipients`, 0700): other
//!   people's public keys, imported with `importPublic` (from
//!   `https://github.com/<login>.gpg`). It holds no secret keys.
//!
//! How the two meet is described on [`ops::Engine::encrypt`] and
//! [`ops::Engine::decrypt`].

pub mod error;
pub mod fpr;
pub mod gpg;
pub mod keys;
pub mod ops;
pub mod rpc;
pub mod status;
