//! Key listings (`--with-colons`), read into what the sidecar reports and
//! checks before encrypting.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    /// The primary key's fingerprint.
    pub fpr: String,
    /// User ids that aren't revoked, as UTF-8 (lossy).
    pub uids: Vec<String>,
    /// The key has a usable encryption (sub)key.
    pub can_encrypt: bool,
    /// The key has a usable signing (sub)key.
    pub can_sign: bool,
    pub expired: bool,
    pub revoked: bool,
}

impl KeyInfo {
    /// Why this key can't be encrypted to, if it can't.
    pub fn unusable_for_encryption(&self) -> Option<&'static str> {
        if self.revoked {
            Some("is revoked")
        } else if self.expired {
            Some("has expired")
        } else if !self.can_encrypt {
            Some("has no usable encryption key")
        } else {
            None
        }
    }

    /// Why this key can't sign, if it can't.
    pub fn unusable_for_signing(&self) -> Option<&'static str> {
        if self.revoked {
            Some("is revoked")
        } else if self.expired {
            Some("has expired")
        } else if !self.can_sign {
            Some("has no usable signing key")
        } else {
            None
        }
    }
}

/// Undoes `--with-colons`' C-style escaping (`\x3a` for `:` and so on).
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 4 <= b.len() && b[i + 1] == b'x' {
            if let Some(v) = std::str::from_utf8(&b[i + 2..i + 4])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(v);
                i += 4;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Every primary key (`pub` or `sec` record) in a listing. `now` is in
/// seconds since the epoch, for keys gpg hasn't marked expired yet.
pub fn parse_listing(text: &str, now: u64) -> Vec<KeyInfo> {
    let mut keys: Vec<KeyInfo> = vec![];
    // Whether the next `fpr` record is the current primary key's.
    let mut want_fpr = false;
    for line in text.lines() {
        let f: Vec<&str> = line.split(':').collect();
        let field = |i: usize| f.get(i).copied().unwrap_or("");
        match field(0) {
            "pub" | "sec" => {
                let validity = field(1);
                let expires: u64 = field(6).parse().unwrap_or(0);
                let caps = field(11);
                keys.push(KeyInfo {
                    fpr: String::new(),
                    uids: vec![],
                    can_encrypt: caps.contains('E') && !caps.contains('D'),
                    can_sign: caps.contains('S') && !caps.contains('D'),
                    expired: validity == "e" || (expires != 0 && expires <= now),
                    revoked: validity == "r",
                });
                want_fpr = true;
            }
            "fpr" if want_fpr => {
                if let Some(k) = keys.last_mut() {
                    k.fpr = field(9).to_ascii_uppercase();
                }
                want_fpr = false;
            }
            "sub" | "ssb" => want_fpr = false,
            "uid" => {
                if let Some(k) = keys.last_mut() {
                    if field(1) != "r" {
                        k.uids.push(unescape(field(9)));
                    }
                }
            }
            _ => {}
        }
    }
    keys.retain(|k| !k.fpr.is_empty());
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTING: &str = "\
tru::1:1700000000:0:3:1:5
pub:u:255:22:1111111111111111:1700000000:::u:::scESC:::::ed25519:::0:
fpr:::::::::AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:
grp:::::::::0000:
uid:u::::1700000000::HASH::Alice \\x3a A <alice@example.com>::::::::::0:
uid:r::::1700000000::HASH::Old <old@example.com>::::::::::0:
sub:u:255:18:2222222222222222:1700000000::::::e:::::cv25519::
fpr:::::::::BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:
pub:e:255:22:3333333333333333:1600000000:1650000000::u:::sc:::::ed25519:::0:
fpr:::::::::cccccccccccccccccccccccccccccccccccccccc:
uid:e::::1600000000::HASH::Carol <carol@example.com>::::::::::0:
pub:r:255:22:4444444444444444:1600000000:::u:::sc:::::ed25519:::0:
fpr:::::::::DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD:
pub:-:255:22:5555555555555555:1600000000:1750000000::-:::scSC:::::ed25519:::0:
fpr:::::::::EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE:
";

    #[test]
    fn reads_primary_keys_uids_and_usability() {
        let keys = parse_listing(LISTING, 1_800_000_000);
        assert_eq!(keys.len(), 4);
        let a = &keys[0];
        assert_eq!(a.fpr, "A".repeat(40), "the primary fpr, not the subkey's");
        assert_eq!(a.uids, vec!["Alice : A <alice@example.com>"]);
        assert!(a.can_encrypt && a.can_sign && !a.expired && !a.revoked);
        assert_eq!(a.unusable_for_encryption(), None);

        let c = &keys[1];
        assert_eq!(c.fpr, "C".repeat(40));
        assert!(c.expired && !c.can_encrypt);
        assert_eq!(c.unusable_for_encryption(), Some("has expired"));

        assert!(keys[2].revoked);
        assert_eq!(keys[2].unusable_for_signing(), Some("is revoked"));

        // Expiry gpg hasn't flagged yet (its trustdb is stale) still counts.
        assert!(keys[3].expired);
    }

    #[test]
    fn a_key_without_an_encryption_subkey() {
        let l = "sec:u:255:22:1:1:::u:::scSC:::+:::ed25519:::0:\nfpr:::::::::ABABABABABABABABABABABABABABABABABABABAB:\n";
        let k = &parse_listing(l, 0)[0];
        assert!(k.can_sign && !k.can_encrypt);
        assert_eq!(
            k.unusable_for_encryption(),
            Some("has no usable encryption key")
        );
    }
}
