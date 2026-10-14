//! OpenPGP fingerprints, the only way a caller names a key.
//!
//! A full fingerprint (40 hex digits for v4 keys, 64 for v5/v6) is the only
//! key specifier accepted: never a user id, an email, a short key id or
//! anything gpg would search for. Validating it here also means no
//! caller-supplied string reaches gpg's argv except as `0x<HEX>`.

use std::fmt;

use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Fpr(String);

impl Fpr {
    /// Accepts upper or lower case, with no spaces or `0x`.
    pub fn parse(s: &str) -> Result<Self> {
        let ok = matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit());
        if !ok {
            return Err(Error::invalid(format!(
                "{s:?} isn't a full key fingerprint (40 or 64 hex digits)"
            )));
        }
        Ok(Self(s.to_ascii_uppercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `0x<FPR>`, how it's handed to gpg.
    pub fn arg(&self) -> String {
        format!("0x{}", self.0)
    }

    /// Parses a list, refusing duplicates and more than `max` entries.
    pub fn parse_list(items: &[String], what: &str, max: usize) -> Result<Vec<Self>> {
        if items.is_empty() {
            return Err(Error::invalid(format!("{what} is empty")));
        }
        if items.len() > max {
            return Err(Error::invalid(format!(
                "{what} has {} entries; at most {max}",
                items.len()
            )));
        }
        let mut out: Vec<Self> = Vec::with_capacity(items.len());
        for s in items {
            let f = Self::parse(s)?;
            if out.contains(&f) {
                return Err(Error::invalid(format!("{what} lists {f} twice")));
            }
            out.push(f);
        }
        Ok(out)
    }
}

impl fmt::Display for Fpr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_full_fingerprints() {
        let v4 = "0123456789abcdef0123456789ABCDEF01234567";
        assert_eq!(Fpr::parse(v4).unwrap().as_str(), v4.to_ascii_uppercase());
        assert!(Fpr::parse(&"A".repeat(64)).is_ok());
        for bad in [
            "",
            "0x0123456789ABCDEF0123456789ABCDEF01234567",
            "0123456789ABCDEF",
            "alice@example.com",
            "0123456789ABCDEF0123456789ABCDEF0123456G",
            "0123456789ABCDEF0123456789ABCDEF01234567!",
            "--homedir",
        ] {
            assert!(Fpr::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn lists_refuse_empty_duplicates_and_too_many() {
        let a = "A".repeat(40);
        assert!(Fpr::parse_list(&[], "recipients", 4).is_err());
        assert!(Fpr::parse_list(&[a.clone(), a.to_lowercase()], "recipients", 4).is_err());
        assert!(Fpr::parse_list(&vec!["B".repeat(40); 1], "recipients", 0).is_err());
        assert_eq!(Fpr::parse_list(&[a], "recipients", 4).unwrap().len(), 1);
    }
}
