//! gpg's machine-readable status lines (`--status-fd`) and the verdicts the
//! sidecar draws from them. Only status lines are trusted: never gpg's exit
//! code alone, and never its human-readable log.

use crate::error::{Error, Result};
use crate::fpr::Fpr;

const PREFIX: &str = "[GNUPG:] ";

/// `GPG_ERR_CANCELED`, the low 16 bits of an error code when the user
/// dismissed pinentry (or didn't touch their card in time).
const ERR_CANCELED: u32 = 99;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub keyword: String,
    pub args: Vec<String>,
}

/// Every `[GNUPG:] KEYWORD args…` line, in order. Anything else is ignored.
pub fn parse(text: &str) -> Vec<Status> {
    text.lines()
        .filter_map(|l| l.strip_prefix(PREFIX))
        .filter_map(|l| {
            let mut parts = l.split(' ').filter(|p| !p.is_empty());
            let keyword = parts.next()?.to_string();
            Some(Status {
                keyword,
                args: parts.map(str::to_string).collect(),
            })
        })
        .collect()
}

fn has(status: &[Status], keyword: &str) -> bool {
    status.iter().any(|s| s.keyword == keyword)
}

fn count(status: &[Status], keyword: &str) -> usize {
    status.iter().filter(|s| s.keyword == keyword).count()
}

/// True when an `ERROR`/`FAILURE` line carries `GPG_ERR_CANCELED`.
pub fn cancelled(status: &[Status]) -> bool {
    status
        .iter()
        .filter(|s| s.keyword == "ERROR" || s.keyword == "FAILURE")
        .filter_map(|s| s.args.last()?.parse::<u32>().ok())
        .any(|code| code & 0xFFFF == ERR_CANCELED)
}

/// The first step of a decrypt (`--decrypt --unwrap` in the user's
/// keyring): the encryption layer must have come off, with integrity
/// protection, and nothing may have failed.
pub fn judge_decrypt(status: &[Status]) -> Result<()> {
    if has(status, "BADSIG") {
        return Err(Error::new("badSignature", "the signature doesn't match"));
    }
    if cancelled(status) {
        return Err(Error::new(
            "cancelled",
            "the passphrase prompt was cancelled",
        ));
    }
    let failed = has(status, "DECRYPTION_FAILED");
    if failed || !has(status, "DECRYPTION_OKAY") {
        let enc_to = count(status, "ENC_TO");
        if enc_to > 0 && count(status, "NO_SECKEY") >= enc_to {
            return Err(Error::new(
                "noSecretKey",
                "it isn't encrypted to any of your secret keys",
            ));
        }
        if failed {
            return Err(Error::new(
                "decryptionFailed",
                "gpg couldn't decrypt it (damaged, or tampered with)",
            ));
        }
        return Err(Error::new("notEncrypted", "it isn't an encrypted message"));
    }
    // DECRYPTION_INFO <mdc_method> <sym_algo> [<aead_algo>]: neither an MDC
    // nor AEAD means no integrity protection. gpg 2.2+ already refuses
    // that, so this only guards an old or misconfigured gpg.
    for info in status.iter().filter(|s| s.keyword == "DECRYPTION_INFO") {
        let mdc = info.args.first().map(String::as_str).unwrap_or("0");
        let aead = info.args.get(2).map(String::as_str).unwrap_or("0");
        if mdc == "0" && aead == "0" {
            return Err(Error::new(
                "noIntegrity",
                "the message has no integrity protection",
            ));
        }
    }
    Ok(())
}

/// What a verification found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    /// The (first) signer's primary key fingerprint.
    pub signer: Fpr,
    /// A signing key has expired since: every such signature was made
    /// before it expired.
    pub signer_expired: bool,
}

/// The second step (verifying the unwrapped message in a keyring holding
/// only `allowed`'s public keys). Every signature must be good, from an
/// allowed key, and there must be at least one.
///
/// A key that has expired since (`EXPKEYSIG`) is accepted when the
/// signature was made before it expired: `key_expiry` gives a signing key's
/// expiry (seconds since the epoch, the earlier of its own and its primary
/// key's; 0 for never), and the signature's creation time in `VALIDSIG`
/// must be before it. A revoked key never is.
pub fn judge_verify(
    status: &[Status],
    allowed: &[Fpr],
    key_expiry: impl Fn(&Fpr) -> Option<u64>,
) -> Result<Verified> {
    if has(status, "BADSIG") {
        return Err(Error::new("badSignature", "the signature doesn't match"));
    }
    if has(status, "ERRSIG") {
        // Only the allowed signers' keys are in that keyring, so an unknown
        // key is one outside the list.
        if has(status, "NO_PUBKEY") {
            return Err(Error::new(
                "signerNotAllowed",
                "it's signed by a key that isn't among the allowed signers",
            ));
        }
        return Err(Error::new(
            "badSignature",
            "the signature couldn't be checked",
        ));
    }
    if has(status, "REVKEYSIG") {
        return Err(Error::new("signerRevoked", "it's signed by a revoked key"));
    }
    if has(status, "EXPSIG") {
        return Err(Error::new("signatureExpired", "its signature has expired"));
    }
    // A second encryption layer inside the first: not something `encrypt`
    // makes.
    if has(status, "BEGIN_DECRYPTION") || has(status, "ENC_TO") {
        return Err(Error::new(
            "malformed",
            "it holds a second encryption layer",
        ));
    }
    let valid: Vec<&Status> = status.iter().filter(|s| s.keyword == "VALIDSIG").collect();
    let good = count(status, "GOODSIG");
    let expired = count(status, "EXPKEYSIG");
    if valid.is_empty() || good + expired == 0 {
        return Err(Error::new("notSigned", "it isn't signed"));
    }
    if good + expired != valid.len() {
        return Err(Error::new(
            "badSignature",
            "not every signature on it is good",
        ));
    }
    let mut signer = None;
    for v in &valid {
        // VALIDSIG <signing key fpr> <date> <sig created> <sig expires> <ver>
        //          <reserved> <pk algo> <hash algo> <class> [<primary fpr>]
        let signing = v.args.first().and_then(|s| Fpr::parse(s).ok());
        let primary = v
            .args
            .get(9)
            .and_then(|s| Fpr::parse(s).ok())
            .or_else(|| signing.clone());
        let ok = [&signing, &primary]
            .iter()
            .any(|f| f.as_ref().is_some_and(|f| allowed.contains(f)));
        let (Some(signing), Some(primary), true) = (signing, primary, ok) else {
            return Err(Error::new(
                "signerNotAllowed",
                "it's signed by a key that isn't among the allowed signers",
            ));
        };
        if expired > 0 {
            // gpg doesn't say which signature EXPKEYSIG is about, so every
            // signature from a key that has an expiry is held to it.
            let created: Option<u64> = v.args.get(2).and_then(|t| t.parse().ok());
            match (created, key_expiry(&signing)) {
                (Some(c), Some(e)) if e == 0 || c < e => {}
                (_, Some(e)) if e != 0 => {
                    return Err(Error::new(
                        "signerExpired",
                        "it was signed after the signer's key expired",
                    ))
                }
                _ => {
                    return Err(Error::new(
                        "signerExpired",
                        "it's signed by an expired key whose expiry can't be read",
                    ))
                }
            }
        }
        signer.get_or_insert(primary);
    }
    // EXPKEYSIG with no key that has an expiry: nothing showed the
    // signature predates it.
    if expired > 0
        && !valid.iter().any(|v| {
            v.args
                .first()
                .and_then(|s| Fpr::parse(s).ok())
                .and_then(|f| key_expiry(&f))
                .is_some_and(|e| e != 0)
        })
    {
        return Err(Error::new(
            "signerExpired",
            "it's signed by an expired key whose expiry can't be read",
        ));
    }
    Ok(Verified {
        signer: signer.expect("valid isn't empty"),
        signer_expired: expired > 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALICE: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const ALICE_SUB: &str = "A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1";
    const MALLORY: &str = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

    /// Verifies with no key expiries known.
    fn jv(status: &[Status], allowed: &[Fpr]) -> Result<Verified> {
        judge_verify(status, allowed, |_| None)
    }

    fn fpr(s: &str) -> Fpr {
        Fpr::parse(s).unwrap()
    }

    const DECRYPTED: &str = "\
[GNUPG:] ENC_TO 1111111111111111 18 0
[GNUPG:] ENC_TO 2222222222222222 18 0
[GNUPG:] NO_SECKEY 2222222222222222
[GNUPG:] KEY_CONSIDERED BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB 0
[GNUPG:] DECRYPTION_KEY 1111 BBBB u
[GNUPG:] BEGIN_DECRYPTION
[GNUPG:] DECRYPTION_INFO 2 9 0
[GNUPG:] PLAINTEXT 62 1700000000
[GNUPG:] DECRYPTION_OKAY
[GNUPG:] GOODMDC
[GNUPG:] END_DECRYPTION
";

    fn verified(signing: &str, primary: &str) -> String {
        format!(
            "[GNUPG:] NEWSIG\n\
             [GNUPG:] KEY_CONSIDERED {primary} 0\n\
             [GNUPG:] SIG_ID abc 2026-10-14 1700000000\n\
             [GNUPG:] GOODSIG {} Alice <alice@example.com>\n\
             [GNUPG:] VALIDSIG {signing} 2026-10-14 1700000000 0 4 0 22 10 00 {primary}\n\
             [GNUPG:] TRUST_ULTIMATE 0 pgp\n",
            &signing[24..]
        )
    }

    #[test]
    fn parses_only_status_lines() {
        let s = parse("gpg: [GNUPG:] GOODSIG fake\n[GNUPG:] NEWSIG\n[GNUPG:] VALIDSIG  a b\nnoise");
        assert_eq!(
            s,
            vec![
                Status {
                    keyword: "NEWSIG".into(),
                    args: vec![]
                },
                Status {
                    keyword: "VALIDSIG".into(),
                    args: vec!["a".into(), "b".into()]
                },
            ]
        );
    }

    #[test]
    fn good_decryption_and_signature() {
        judge_decrypt(&parse(DECRYPTED)).unwrap();
        let v = jv(&parse(&verified(ALICE, ALICE)), &[fpr(ALICE)]).unwrap();
        assert_eq!(v.signer, fpr(ALICE));
        assert!(!v.signer_expired);
    }

    #[test]
    fn a_signing_subkey_reports_its_primary_key() {
        let s = parse(&verified(ALICE_SUB, ALICE));
        assert_eq!(jv(&s, &[fpr(ALICE)]).unwrap().signer, fpr(ALICE));
    }

    #[test]
    fn bad_signature() {
        let s = parse(&format!(
            "[GNUPG:] NEWSIG\n[GNUPG:] BADSIG {} Alice\n",
            &ALICE[24..]
        ));
        assert_eq!(jv(&s, &[fpr(ALICE)]).unwrap_err().code, "badSignature");
        // BADSIG anywhere also fails the decrypt step.
        let d = parse(&format!("{DECRYPTED}[GNUPG:] BADSIG 1 x\n"));
        assert_eq!(judge_decrypt(&d).unwrap_err().code, "badSignature");
    }

    #[test]
    fn no_signature() {
        let s = parse("[GNUPG:] PLAINTEXT 62 0\n");
        assert_eq!(jv(&s, &[fpr(ALICE)]).unwrap_err().code, "notSigned");
        // GOODSIG without VALIDSIG isn't enough either.
        let s = parse("[GNUPG:] GOODSIG 1 Alice\n");
        assert_eq!(jv(&s, &[fpr(ALICE)]).unwrap_err().code, "notSigned");
    }

    #[test]
    fn wrong_signer() {
        // Signed by a key whose public key was in the verify keyring but
        // isn't allowed (a stale keyring, a subkey/primary mix-up).
        let s = parse(&verified(MALLORY, MALLORY));
        assert_eq!(jv(&s, &[fpr(ALICE)]).unwrap_err().code, "signerNotAllowed");
        // Signed by a key the verify keyring doesn't have at all.
        let s = parse(&format!(
            "[GNUPG:] NEWSIG\n[GNUPG:] ERRSIG {} 22 10 00 1700000000 9 {MALLORY}\n[GNUPG:] NO_PUBKEY {}\n",
            &MALLORY[24..],
            &MALLORY[24..]
        ));
        assert_eq!(jv(&s, &[fpr(ALICE)]).unwrap_err().code, "signerNotAllowed");
        // One good allowed signature next to a disallowed one still fails.
        let s = parse(&format!(
            "{}{}",
            verified(ALICE, ALICE),
            verified(MALLORY, MALLORY)
        ));
        assert_eq!(jv(&s, &[fpr(ALICE)]).unwrap_err().code, "signerNotAllowed");
    }

    /// A signature by a key that has expired since: EXPKEYSIG instead of
    /// GOODSIG, VALIDSIG with the signature's creation time (1700000000).
    fn expired_since(signing: &str, primary: &str) -> String {
        verified(signing, primary).replace("GOODSIG", "EXPKEYSIG")
    }

    #[test]
    fn an_expired_key_counts_for_signatures_made_before_it_expired() {
        let s = parse(&expired_since(ALICE, ALICE));
        let before = |f: &Fpr| (f == &fpr(ALICE)).then_some(1_800_000_000);
        let v = judge_verify(&s, &[fpr(ALICE)], before).unwrap();
        assert_eq!(v.signer, fpr(ALICE));
        assert!(v.signer_expired);

        // Signed at or after the expiry.
        for expiry in [1_700_000_000, 1_600_000_000] {
            let err = judge_verify(&s, &[fpr(ALICE)], |_| Some(expiry)).unwrap_err();
            assert_eq!(err.code, "signerExpired", "{expiry}");
        }
        // No expiry to compare with: refused.
        for unknown in [None, Some(0)] {
            let err = judge_verify(&s, &[fpr(ALICE)], |_| unknown).unwrap_err();
            assert_eq!(err.code, "signerExpired");
        }
        // Still only allowed signers.
        let err = judge_verify(&s, &[fpr(MALLORY)], before).unwrap_err();
        assert_eq!(err.code, "signerNotAllowed");
        // EXPKEYSIG without VALIDSIG is not a signature.
        let s = parse(&format!("[GNUPG:] EXPKEYSIG {} Alice\n", &ALICE[24..]));
        assert_eq!(
            judge_verify(&s, &[fpr(ALICE)], before).unwrap_err().code,
            "notSigned"
        );
    }

    #[test]
    fn a_revoked_signer_is_refused_even_before_revocation() {
        let s = parse(&format!(
            "[GNUPG:] REVKEYSIG {} Alice\n{}",
            &ALICE[24..],
            verified(ALICE, ALICE).replace("GOODSIG", "IGNORED")
        ));
        let err = judge_verify(&s, &[fpr(ALICE)], |_| Some(u64::MAX)).unwrap_err();
        assert_eq!(err.code, "signerRevoked");
    }

    #[test]
    fn decryption_failed() {
        let s = parse(
            "[GNUPG:] ENC_TO 1111111111111111 18 0\n\
             [GNUPG:] BEGIN_DECRYPTION\n\
             [GNUPG:] DECRYPTION_FAILED\n\
             [GNUPG:] END_DECRYPTION\n",
        );
        assert_eq!(judge_decrypt(&s).unwrap_err().code, "decryptionFailed");
        // DECRYPTION_OKAY next to DECRYPTION_FAILED still fails.
        let s = parse(&format!("{DECRYPTED}[GNUPG:] DECRYPTION_FAILED\n"));
        assert_eq!(judge_decrypt(&s).unwrap_err().code, "decryptionFailed");
    }

    #[test]
    fn not_for_us_not_encrypted_cancelled_no_integrity() {
        let s = parse(
            "[GNUPG:] ENC_TO 1111111111111111 18 0\n\
             [GNUPG:] NO_SECKEY 1111111111111111\n\
             [GNUPG:] BEGIN_DECRYPTION\n\
             [GNUPG:] DECRYPTION_FAILED\n",
        );
        assert_eq!(judge_decrypt(&s).unwrap_err().code, "noSecretKey");
        assert_eq!(
            judge_decrypt(&parse("[GNUPG:] NODATA 1\n"))
                .unwrap_err()
                .code,
            "notEncrypted"
        );
        let s = parse(
            "[GNUPG:] ENC_TO 1111111111111111 18 0\n\
             [GNUPG:] PINENTRY_LAUNCHED 1 curses 1.2 - - - - 0/0 0\n\
             [GNUPG:] ERROR pkdecrypt_failed 83886179\n\
             [GNUPG:] BEGIN_DECRYPTION\n\
             [GNUPG:] DECRYPTION_FAILED\n",
        );
        assert_eq!(judge_decrypt(&s).unwrap_err().code, "cancelled");
        let s = parse(&DECRYPTED.replace("DECRYPTION_INFO 2 9 0", "DECRYPTION_INFO 0 9"));
        assert_eq!(judge_decrypt(&s).unwrap_err().code, "noIntegrity");
    }

    #[test]
    fn a_nested_encryption_layer_is_refused() {
        let s = parse(&format!(
            "[GNUPG:] BEGIN_DECRYPTION\n{}",
            verified(ALICE, ALICE)
        ));
        assert_eq!(jv(&s, &[fpr(ALICE)]).unwrap_err().code, "malformed");
    }
}
