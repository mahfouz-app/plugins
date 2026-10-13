// Encryption for Mahfouz: per-note OpenPGP encryption through the user's gpg.
//
// The work happens in the sidecar (`sidecar/`, built into the `git-crypt`
// binary the install step downloads): `status`, `secretFingerprints`,
// `importPublic`, `encrypt` and `decrypt` over the app's sidecar JSON-RPC.
//
// This module registers nothing yet: the UI (onboarding, key groups, the
// encrypt and unlock actions) comes after its mockups are approved, and it
// needs the host APIs the app adds for this plugin (the body codec,
// `config.read/write` for `.config/encryption.md`).

export function activate(_host) {}

export function deactivate() {}
