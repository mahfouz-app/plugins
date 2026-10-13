//! git-crypt's formats, byte for byte: the symmetric key file and the
//! encrypted file. Everything here follows AGWA/git-crypt 0.8.0 (the files
//! cited are identical on `master` at 8c7a90f), so a repository encrypted by
//! one is read by the other with the same key file.
//!
//! **Key file** (`key.cpp`, `Key_file::store`/`load`, lines 179-263): the
//! 12-byte preamble `\0GITCRYPTKEY`, the format version 2 as a big-endian
//! u32, then header fields and key entries, each field a big-endian
//! `(id, length)` pair and its bytes:
//!
//! - header: `KEY_NAME` (1) for a named key, then `END` (0);
//! - each entry, newest version first (`std::map<…, std::greater>`,
//!   `key.hpp:87`): `VERSION` (1, 4 bytes), `AES_KEY` (3, 32 bytes),
//!   `HMAC_KEY` (5, 64 bytes), `END` (0).
//!
//! An unknown odd field id is critical (`Incompatible`), an unknown even
//! one is skipped (at most 1 MiB). The pre-0.4 "legacy" file is just the
//! AES key and the HMAC key with nothing after them (`load_legacy`,
//! `key.cpp:105-127`).
//!
//! **Encrypted file** (`commands.cpp`, `clean`, lines 716-833): the 10-byte
//! header `\0GITCRYPT\0`, a 12-byte nonce, then the plaintext under
//! AES-256-CTR. The nonce is the first 12 bytes of HMAC-SHA1(hmac key,
//! plaintext), so encryption is deterministic and git sees an unchanged
//! file as unchanged. The CTR block is the nonce followed by the block
//! number as a big-endian u32 starting at 0 (`crypto.cpp:35-67`), which is
//! RustCrypto's `Ctr32BE` with the IV `nonce || 00000000`. Decryption
//! recomputes the HMAC over the plaintext and compares it with the nonce
//! (`decrypt_file_to_stdout`, `commands.cpp:835-867`): that's git-crypt's
//! only integrity check.

use std::collections::BTreeMap;
use std::fmt;
use std::io::{self, Read, Seek, SeekFrom, Write};

use aes::Aes256;
use ctr::cipher::{KeyIvInit, StreamCipher};
use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;

/// The key file's preamble.
pub const KEY_PREAMBLE: &[u8; 12] = b"\0GITCRYPTKEY";
/// `Key_file::FORMAT_VERSION`.
pub const FORMAT_VERSION: u32 = 2;
/// An encrypted file's header.
pub const FILE_HEADER: &[u8; 10] = b"\0GITCRYPT\0";
pub const NONCE_LEN: usize = 12;
/// The header plus the nonce.
pub const PREFIX_LEN: usize = FILE_HEADER.len() + NONCE_LEN;
pub const AES_KEY_LEN: usize = 32;
pub const HMAC_KEY_LEN: usize = 64;
pub const KEY_NAME_MAX_LEN: usize = 128;
const MAX_FIELD_LEN: u32 = 1 << 20;

const HEADER_FIELD_END: u32 = 0;
const HEADER_FIELD_KEY_NAME: u32 = 1;
const KEY_FIELD_END: u32 = 0;
const KEY_FIELD_VERSION: u32 = 1;
const KEY_FIELD_AES_KEY: u32 = 3;
const KEY_FIELD_HMAC_KEY: u32 = 5;

/// Files of this size or more can't be encrypted. git-crypt counts the
/// bytes it encrypts in a `uint32_t` and throws once it wraps
/// (`crypto.cpp:61-65`), so a file of 2^32 bytes fails there (exit 1) even
/// though `MAX_CRYPT_BYTES` (`crypto.hpp:74`) is larger.
pub const MAX_FILE: u64 = 1 << 32;

/// How much of a file `clean` keeps in memory before spilling the rest to
/// a temporary file, as git-crypt does (`commands.cpp:757`).
pub const IN_MEMORY: u64 = 8 * 1024 * 1024;

type Ctr = ctr::Ctr32BE<Aes256>;
type HmacSha1 = Hmac<Sha1>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyError {
    /// Not a key file, or a damaged one.
    Malformed,
    /// A key file from a newer git-crypt (a critical field or a format
    /// version this doesn't know).
    Incompatible,
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            KeyError::Malformed => "malformed git-crypt key file",
            KeyError::Incompatible => "git-crypt key file in a newer, incompatible format",
        })
    }
}

impl std::error::Error for KeyError {}

/// One version of a key.
#[derive(Clone, PartialEq, Eq)]
pub struct Entry {
    pub version: u32,
    pub aes_key: [u8; AES_KEY_LEN],
    pub hmac_key: [u8; HMAC_KEY_LEN],
}

impl fmt::Debug for Entry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Entry")
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

impl Drop for Entry {
    fn drop(&mut self) {
        // Best effort, like git-crypt's explicit_memset.
        for b in self.aes_key.iter_mut().chain(self.hmac_key.iter_mut()) {
            unsafe { std::ptr::write_volatile(b, 0) };
        }
    }
}

impl Entry {
    /// A fresh random key (`Key_file::Entry::generate`).
    pub fn generate(version: u32) -> io::Result<Self> {
        let mut e = Entry {
            version,
            aes_key: [0; AES_KEY_LEN],
            hmac_key: [0; HMAC_KEY_LEN],
        };
        getrandom::fill(&mut e.aes_key).map_err(io::Error::other)?;
        getrandom::fill(&mut e.hmac_key).map_err(io::Error::other)?;
        Ok(e)
    }

    fn zeroed() -> Self {
        Entry {
            version: 0,
            aes_key: [0; AES_KEY_LEN],
            hmac_key: [0; HMAC_KEY_LEN],
        }
    }

    fn load(r: &mut Reader) -> Result<Self, KeyError> {
        let mut e = Entry::zeroed();
        loop {
            let id = r.be32()?;
            if id == KEY_FIELD_END {
                return Ok(e);
            }
            let len = r.be32()?;
            match id {
                KEY_FIELD_VERSION => {
                    if len != 4 {
                        return Err(KeyError::Malformed);
                    }
                    e.version = r.be32()?;
                }
                KEY_FIELD_AES_KEY => {
                    if len as usize != AES_KEY_LEN {
                        return Err(KeyError::Malformed);
                    }
                    e.aes_key.copy_from_slice(r.take(AES_KEY_LEN)?);
                }
                KEY_FIELD_HMAC_KEY => {
                    if len as usize != HMAC_KEY_LEN {
                        return Err(KeyError::Malformed);
                    }
                    e.hmac_key.copy_from_slice(r.take(HMAC_KEY_LEN)?);
                }
                id if id & 1 == 1 => return Err(KeyError::Incompatible),
                _ => r.skip(len)?,
            }
        }
    }

    fn store(&self, out: &mut Vec<u8>) {
        be32(out, KEY_FIELD_VERSION);
        be32(out, 4);
        be32(out, self.version);
        be32(out, KEY_FIELD_AES_KEY);
        be32(out, AES_KEY_LEN as u32);
        out.extend_from_slice(&self.aes_key);
        be32(out, KEY_FIELD_HMAC_KEY);
        be32(out, HMAC_KEY_LEN as u32);
        out.extend_from_slice(&self.hmac_key);
        be32(out, KEY_FIELD_END);
    }

    fn hmac(&self) -> HmacSha1 {
        <HmacSha1 as KeyInit>::new_from_slice(&self.hmac_key).expect("HMAC takes any key length")
    }

    fn ctr(&self, nonce: &[u8]) -> Ctr {
        let mut iv = [0u8; 16];
        iv[..NONCE_LEN].copy_from_slice(&nonce[..NONCE_LEN]);
        Ctr::new_from_slices(&self.aes_key, &iv).expect("fixed key and IV lengths")
    }
}

fn be32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

/// Reads a key file the way git-crypt's `std::istream` code does.
struct Reader<'a> {
    data: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], KeyError> {
        if self.data.len() < n {
            return Err(KeyError::Malformed);
        }
        let (head, rest) = self.data.split_at(n);
        self.data = rest;
        Ok(head)
    }

    fn be32(&mut self) -> Result<u32, KeyError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    /// An unknown non-critical field.
    fn skip(&mut self, len: u32) -> Result<(), KeyError> {
        if len > MAX_FIELD_LEN {
            return Err(KeyError::Malformed);
        }
        self.take(len as usize).map(|_| ())
    }
}

/// `validate_key_name` (`key.cpp:311-335`): 1-128 of `[A-Za-z0-9_-]`, and
/// not `default`.
pub fn valid_key_name(name: &str) -> bool {
    !name.is_empty()
        && name != "default"
        && name.len() <= KEY_NAME_MAX_LEN
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A git-crypt key file: an optional key name and its versions.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeyFile {
    /// `None` for the default key.
    pub key_name: Option<String>,
    entries: BTreeMap<u32, Entry>,
}

impl KeyFile {
    /// A key file holding one fresh version-0 key (`git-crypt init`).
    pub fn generate(key_name: Option<String>) -> io::Result<Self> {
        let mut k = KeyFile {
            key_name,
            entries: BTreeMap::new(),
        };
        k.add(Entry::generate(0)?);
        Ok(k)
    }

    /// Adds (or replaces) the entry for its version.
    pub fn add(&mut self, e: Entry) {
        self.entries.insert(e.version, e);
    }

    pub fn get(&self, version: u32) -> Option<&Entry> {
        self.entries.get(&version)
    }

    /// The newest version, which `clean` encrypts with.
    pub fn latest(&self) -> Option<&Entry> {
        self.entries.values().next_back()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// `Key_file::load`.
    pub fn load(data: &[u8]) -> Result<Self, KeyError> {
        let mut r = Reader { data };
        let preamble = r.take(16)?;
        if &preamble[..12] != KEY_PREAMBLE {
            return Err(KeyError::Malformed);
        }
        if u32::from_be_bytes([preamble[12], preamble[13], preamble[14], preamble[15]])
            != FORMAT_VERSION
        {
            return Err(KeyError::Incompatible);
        }
        let mut k = KeyFile::default();
        loop {
            let id = r.be32()?;
            if id == HEADER_FIELD_END {
                break;
            }
            let len = r.be32()?;
            if id == HEADER_FIELD_KEY_NAME {
                if len as usize > KEY_NAME_MAX_LEN {
                    return Err(KeyError::Malformed);
                }
                let name =
                    std::str::from_utf8(r.take(len as usize)?).map_err(|_| KeyError::Malformed)?;
                if !valid_key_name(name) {
                    return Err(KeyError::Malformed);
                }
                k.key_name = Some(name.to_string());
            } else if id & 1 == 1 {
                return Err(KeyError::Incompatible);
            } else {
                r.skip(len)?;
            }
        }
        while !r.data.is_empty() {
            let e = Entry::load(&mut r)?;
            k.add(e);
        }
        Ok(k)
    }

    /// `Key_file::load_legacy`: a pre-0.4 key file, the AES key then the
    /// HMAC key and nothing else, read as version 0.
    pub fn load_legacy(data: &[u8]) -> Result<Self, KeyError> {
        if data.len() != AES_KEY_LEN + HMAC_KEY_LEN {
            return Err(KeyError::Malformed);
        }
        let mut e = Entry::zeroed();
        e.aes_key.copy_from_slice(&data[..AES_KEY_LEN]);
        e.hmac_key.copy_from_slice(&data[AES_KEY_LEN..]);
        let mut k = KeyFile::default();
        k.add(e);
        Ok(k)
    }

    /// `Key_file::store`: entries newest first.
    pub fn store(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(16 + 8 + self.entries.len() * 128);
        out.extend_from_slice(KEY_PREAMBLE);
        be32(&mut out, FORMAT_VERSION);
        if let Some(name) = &self.key_name {
            be32(&mut out, HEADER_FIELD_KEY_NAME);
            be32(&mut out, name.len() as u32);
            out.extend_from_slice(name.as_bytes());
        }
        be32(&mut out, HEADER_FIELD_END);
        for e in self.entries.values().rev() {
            e.store(&mut out);
        }
        out
    }

    /// The file git-crypt encrypts to each GPG user: this key's name and
    /// only the one version (`encrypt_repo_key`, `commands.cpp:678-686`).
    pub fn single_version(&self, version: u32) -> Option<KeyFile> {
        let e = self.get(version)?.clone();
        let mut k = KeyFile {
            key_name: self.key_name.clone(),
            entries: BTreeMap::new(),
        };
        k.add(e);
        Some(k)
    }
}

/// Why a file couldn't be encrypted or decrypted.
#[derive(Debug)]
pub enum CryptError {
    Io(io::Error),
    /// The file is [`MAX_FILE`] bytes or more.
    TooLong,
    /// The key file has no key in it.
    EmptyKey,
    /// An encrypted file needs a key version the key file doesn't have.
    MissingVersion(u32),
    /// The HMAC doesn't match: the file was changed, or the key is wrong.
    /// The output has been written all the same, as git-crypt does.
    Tampered,
}

impl fmt::Display for CryptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CryptError::Io(e) => write!(f, "I/O error: {e}"),
            CryptError::TooLong => f.write_str("file too long to encrypt securely"),
            CryptError::EmptyKey => f.write_str("key file is empty"),
            CryptError::MissingVersion(v) => write!(
                f,
                "key version {v} not available - please unlock with the latest version of the key."
            ),
            CryptError::Tampered => f.write_str("encrypted file has been tampered with!"),
        }
    }
}

impl From<io::Error> for CryptError {
    fn from(e: io::Error) -> Self {
        CryptError::Io(e)
    }
}

const CHUNK: usize = 64 * 1024;

/// Reads until `buf` is full or the input ends; the number of bytes read.
pub fn read_full(r: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

/// `clean`: encrypts all of `input` to `output` with the key's newest
/// version. The whole file is read first (its HMAC is the nonce), the
/// first [`IN_MEMORY`] bytes in memory and the rest in a temporary file,
/// so memory stays bounded. Nothing is written before the input has been
/// read in full and accepted.
///
/// Input that is already encrypted is encrypted again, as git-crypt does:
/// `clean` never looks at its input's header.
pub fn encrypt(
    key: &KeyFile,
    mut input: impl Read,
    mut output: impl Write,
) -> Result<(), CryptError> {
    let entry = key.latest().ok_or(CryptError::EmptyKey)?;
    let mut mac = entry.hmac();
    let mut head: Vec<u8> = Vec::new();
    let mut spill: Option<std::fs::File> = None;
    let mut size: u64 = 0;
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = match input.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        };
        size += n as u64;
        if size >= MAX_FILE {
            return Err(CryptError::TooLong);
        }
        mac.update(&buf[..n]);
        // Split exactly at IN_MEMORY, so nothing depends on read sizes.
        let room = (IN_MEMORY as usize).saturating_sub(head.len()).min(n);
        head.extend_from_slice(&buf[..room]);
        if room < n {
            let f = match &mut spill {
                Some(f) => f,
                None => spill.insert(tempfile::tempfile()?),
            };
            f.write_all(&buf[room..n])?;
        }
    }
    let digest = mac.finalize().into_bytes();
    let nonce = &digest[..NONCE_LEN];
    output.write_all(FILE_HEADER)?;
    output.write_all(nonce)?;
    let mut ctr = entry.ctr(nonce);
    for chunk in head.chunks_mut(CHUNK) {
        ctr.apply_keystream(chunk);
        output.write_all(chunk)?;
    }
    if let Some(mut f) = spill {
        f.seek(SeekFrom::Start(0))?;
        loop {
            let n = read_full(&mut f, &mut buf)?;
            if n == 0 {
                break;
            }
            ctr.apply_keystream(&mut buf[..n]);
            output.write_all(&buf[..n])?;
        }
    }
    output.flush()?;
    Ok(())
}

/// Whether `prefix` (the first [`PREFIX_LEN`] bytes of a file, or fewer
/// for a shorter one) starts an encrypted file.
pub fn is_encrypted(prefix: &[u8]) -> bool {
    prefix.len() == PREFIX_LEN && prefix.starts_with(FILE_HEADER)
}

/// Decrypts the rest of an encrypted file whose [`PREFIX_LEN`]-byte
/// `prefix` has been read, streaming (`decrypt_file_to_stdout`). Like
/// git-crypt it always uses key version 0 (the file format has no version
/// field) and writes the plaintext before it knows the HMAC matches:
/// [`CryptError::Tampered`] comes after, and git refuses the result on the
/// non-zero exit that follows.
pub fn decrypt_rest(
    key: &KeyFile,
    prefix: &[u8],
    mut input: impl Read,
    mut output: impl Write,
) -> Result<(), CryptError> {
    let entry = key.get(0).ok_or(CryptError::MissingVersion(0))?;
    let nonce = &prefix[FILE_HEADER.len()..PREFIX_LEN];
    let mut ctr = entry.ctr(nonce);
    let mut mac = entry.hmac();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = read_full(&mut input, &mut buf)?;
        if n == 0 {
            break;
        }
        ctr.apply_keystream(&mut buf[..n]);
        mac.update(&buf[..n]);
        output.write_all(&buf[..n])?;
    }
    output.flush()?;
    let digest = mac.finalize().into_bytes();
    if !constant_time_eq(&digest[..NONCE_LEN], nonce) {
        return Err(CryptError::Tampered);
    }
    Ok(())
}

/// `leakless_equals`.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// In-memory helpers, for tests and small inputs.
pub fn encrypt_bytes(key: &KeyFile, plaintext: &[u8]) -> Result<Vec<u8>, CryptError> {
    let mut out = Vec::with_capacity(plaintext.len() + PREFIX_LEN);
    encrypt(key, plaintext, &mut out)?;
    Ok(out)
}

/// Decrypts an encrypted file; anything else comes back as it is (the way
/// `smudge` passes it through).
pub fn decrypt_bytes(key: &KeyFile, data: &[u8]) -> Result<Vec<u8>, CryptError> {
    if data.len() < PREFIX_LEN || !is_encrypted(&data[..PREFIX_LEN]) {
        return Ok(data.to_vec());
    }
    let mut out = Vec::with_capacity(data.len() - PREFIX_LEN);
    decrypt_rest(key, &data[..PREFIX_LEN], &data[PREFIX_LEN..], &mut out)?;
    Ok(out)
}

/// `escape_shell_arg` (`util.cpp:63-75`): double quotes, with `"`, `\`,
/// `$` and `` ` `` backslash-escaped. How git-crypt writes its own path into
/// the filter commands.
pub fn escape_shell_arg(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        if matches!(c, '"' | '\\' | '$' | '`') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixed key: AES key bytes 0x00..=0x1f, HMAC key bytes 0x20..=0x5f.
    fn fixed_key() -> KeyFile {
        let mut e = Entry::zeroed();
        for (i, b) in e.aes_key.iter_mut().enumerate() {
            *b = i as u8;
        }
        for (i, b) in e.hmac_key.iter_mut().enumerate() {
            *b = 0x20 + i as u8;
        }
        let mut k = KeyFile::default();
        k.add(e);
        k
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// The key file above, as git-crypt stores it: preamble, format 2, no
    /// key name (END), then VERSION 0, AES_KEY, HMAC_KEY, END.
    const FIXED_KEY_FILE: &str = concat!(
        "004749544352595054",
        "4b4559", // "\0GITCRYPTKEY"
        "00000002",
        "00000000",
        "00000001",
        "00000004",
        "00000000",
        "00000003",
        "00000020",
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        "00000005",
        "00000040",
        "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
        "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
        "00000000",
    );

    #[test]
    fn key_file_layout_and_round_trip() {
        let k = fixed_key();
        let stored = k.store();
        assert_eq!(hex(&stored), FIXED_KEY_FILE);
        assert_eq!(stored.len(), 16 + 4 + 12 + 8 + 32 + 8 + 64 + 4);
        let back = KeyFile::load(&stored).unwrap();
        assert_eq!(back, k);
        assert_eq!(back.store(), stored);
    }

    #[test]
    fn named_keys_and_several_versions_store_newest_first() {
        let mut k = KeyFile::generate(Some("team_a-1".into())).unwrap();
        let mut v1 = Entry::generate(1).unwrap();
        v1.aes_key[0] = 0xAA;
        k.add(v1.clone());
        let stored = k.store();
        // Preamble, format, KEY_NAME (1) "team_a-1" (8), END, then version 1.
        assert_eq!(&stored[16..24], &[0, 0, 0, 1, 0, 0, 0, 8]);
        assert_eq!(&stored[24..32], b"team_a-1");
        assert_eq!(&stored[32..36], &[0, 0, 0, 0]);
        assert_eq!(&stored[36..48], &[0, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0, 1]);
        let back = KeyFile::load(&stored).unwrap();
        assert_eq!(back.key_name.as_deref(), Some("team_a-1"));
        assert_eq!(back.latest().unwrap(), &v1);
        assert!(back.get(0).is_some());

        let one = back.single_version(0).unwrap();
        assert_eq!(one.key_name.as_deref(), Some("team_a-1"));
        assert!(one.get(1).is_none() && one.get(0).is_some());
    }

    #[test]
    fn malformed_and_incompatible_key_files() {
        let good = unhex(FIXED_KEY_FILE);
        assert_eq!(KeyFile::load(b"\0GITCRYPTKEY"), Err(KeyError::Malformed));
        let mut bad = good.clone();
        bad[1] = b'X';
        assert_eq!(KeyFile::load(&bad), Err(KeyError::Malformed));
        let mut newer = good.clone();
        newer[15] = 3;
        assert_eq!(KeyFile::load(&newer), Err(KeyError::Incompatible));
        // A truncated entry.
        assert_eq!(
            KeyFile::load(&good[..good.len() - 1]),
            Err(KeyError::Malformed)
        );
        // An unknown critical header field (7), then an unknown ignorable
        // one (8, two bytes) that loads.
        let mut crit = good[..16].to_vec();
        crit.extend_from_slice(&[0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(KeyFile::load(&crit), Err(KeyError::Incompatible));
        let mut skip = good[..16].to_vec();
        skip.extend_from_slice(&[0, 0, 0, 8, 0, 0, 0, 2, 9, 9]);
        skip.extend_from_slice(&good[16..]);
        assert_eq!(KeyFile::load(&skip).unwrap(), fixed_key());
        // `default` isn't a legal key name.
        let mut named = good[..16].to_vec();
        named.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 7]);
        named.extend_from_slice(b"default");
        named.extend_from_slice(&good[16..]);
        assert_eq!(KeyFile::load(&named), Err(KeyError::Malformed));
        // A wrong AES key length.
        let mut short = good.clone();
        short[16 + 4 + 12 + 7] = 0x1f;
        assert_eq!(KeyFile::load(&short), Err(KeyError::Malformed));
    }

    #[test]
    fn legacy_key_files() {
        let k = fixed_key();
        let e = k.get(0).unwrap();
        let mut raw = e.aes_key.to_vec();
        raw.extend_from_slice(&e.hmac_key);
        assert_eq!(KeyFile::load_legacy(&raw).unwrap(), k);
        raw.push(0);
        assert_eq!(KeyFile::load_legacy(&raw), Err(KeyError::Malformed));
    }

    #[test]
    fn key_names() {
        assert!(valid_key_name("work"));
        assert!(valid_key_name("a-b_C9"));
        assert!(!valid_key_name("default"));
        assert!(!valid_key_name(""));
        assert!(!valid_key_name("../x"));
        assert!(!valid_key_name("é"));
        assert!(!valid_key_name(&"a".repeat(129)));
        assert!(valid_key_name(&"a".repeat(128)));
    }

    /// Known-answer vector for [`fixed_key`]. Derived independently of this
    /// code, from git-crypt's algorithm, with OpenSSL:
    ///
    /// ```sh
    /// printf 'The quick brown fox jumps over the lazy dog\n' > pt
    /// # nonce: the first 12 bytes of HMAC-SHA1(hmac key, plaintext)
    /// openssl dgst -sha1 -mac HMAC \
    ///   -macopt hexkey:202122…5f pt          # 7e767af4a6b8afae57fad786 47035758ecea8eca: the first 24 hex digits
    /// # body: AES-256-CTR, key 0001…1f, IV = nonce || 00000000
    /// openssl enc -aes-256-ctr -nosalt -K 000102…1f -iv <nonce>00000000 -in pt | xxd -p
    /// ```
    ///
    /// and checked against the real CLI (git-crypt 0.8.0): the key file
    /// [`FIXED_KEY_FILE`] written to `k`, then
    /// `git-crypt clean --key-file=k < pt | xxd -p` gives the same bytes.
    const KAT_PLAINTEXT: &[u8] = b"The quick brown fox jumps over the lazy dog\n";
    const KAT_NONCE: &str = "7e767af4a6b8afae57fad786";
    const KAT_BODY: &str = concat!(
        "c4f3de2bf53343aafe432f9daacbfe2eee7c2a17895d7033",
        "0ff4379a61a2ead62e5d100898663ad2defd06d0"
    );

    #[test]
    fn known_answer() {
        let k = fixed_key();
        let out = encrypt_bytes(&k, KAT_PLAINTEXT).unwrap();
        assert_eq!(&out[..10], FILE_HEADER);
        assert_eq!(hex(&out[10..22]), KAT_NONCE);
        assert_eq!(hex(&out[22..]), KAT_BODY);
        assert_eq!(decrypt_bytes(&k, &out).unwrap(), KAT_PLAINTEXT);
    }

    #[test]
    fn empty_file() {
        let k = fixed_key();
        let out = encrypt_bytes(&k, b"").unwrap();
        assert_eq!(out.len(), PREFIX_LEN);
        assert_eq!(decrypt_bytes(&k, &out).unwrap(), b"");
    }

    #[test]
    fn round_trips_and_is_deterministic() {
        let k = KeyFile::generate(None).unwrap();
        for len in [
            1usize,
            15,
            16,
            17,
            1023,
            1024,
            1025,
            CHUNK - 1,
            CHUNK + 1,
            300_000,
        ] {
            let pt: Vec<u8> = (0..len).map(|i| (i * 7 + len) as u8).collect();
            let a = encrypt_bytes(&k, &pt).unwrap();
            let b = encrypt_bytes(&k, &pt).unwrap();
            assert_eq!(a, b, "deterministic at {len}");
            assert_eq!(a.len(), len + PREFIX_LEN);
            assert_ne!(&a[PREFIX_LEN..], &pt[..]);
            assert_eq!(decrypt_bytes(&k, &a).unwrap(), pt, "round trip at {len}");
        }
        // A one-byte change gives a different nonce.
        let a = encrypt_bytes(&k, b"hello world").unwrap();
        let b = encrypt_bytes(&k, b"hello worle").unwrap();
        assert_ne!(a[10..22], b[10..22]);
    }

    /// Reads in odd sizes, so the in-memory split and the stream don't
    /// depend on how the input arrives.
    struct Dribble<'a>(&'a [u8], usize);
    impl Read for Dribble<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.0.len().min(buf.len()).min(self.1);
            buf[..n].copy_from_slice(&self.0[..n]);
            self.0 = &self.0[n..];
            self.1 = self.1 % 4093 + 1;
            Ok(n)
        }
    }

    #[test]
    fn a_file_larger_than_the_in_memory_part_spills_and_still_matches() {
        let k = KeyFile::generate(None).unwrap();
        let pt: Vec<u8> = (0..IN_MEMORY as usize + 70_001)
            .map(|i| (i % 251) as u8)
            .collect();
        let whole = encrypt_bytes(&k, &pt).unwrap();
        let mut dribbled = vec![];
        encrypt(&k, Dribble(&pt, 1), &mut dribbled).unwrap();
        assert_eq!(whole, dribbled);
        let mut back = vec![];
        decrypt_rest(
            &k,
            &whole[..PREFIX_LEN],
            Dribble(&whole[PREFIX_LEN..], 3),
            &mut back,
        )
        .unwrap();
        assert_eq!(back, pt);
    }

    #[test]
    fn already_encrypted_input_is_encrypted_again() {
        let k = fixed_key();
        let once = encrypt_bytes(&k, b"note").unwrap();
        let twice = encrypt_bytes(&k, &once).unwrap();
        assert_ne!(once, twice);
        assert_eq!(decrypt_bytes(&k, &twice).unwrap(), once);
    }

    #[test]
    fn tampering_and_wrong_keys_are_detected() {
        let k = fixed_key();
        let mut ct = encrypt_bytes(&k, b"secret text").unwrap();
        ct[PREFIX_LEN + 2] ^= 1;
        assert!(matches!(decrypt_bytes(&k, &ct), Err(CryptError::Tampered)));
        let other = KeyFile::generate(None).unwrap();
        let ct = encrypt_bytes(&k, b"secret text").unwrap();
        assert!(matches!(
            decrypt_bytes(&other, &ct),
            Err(CryptError::Tampered)
        ));
    }

    #[test]
    fn plaintext_passes_through_decryption() {
        let k = fixed_key();
        for data in [
            &b""[..],
            b"short",
            b"\0GITCRYPT\0 too short",
            b"# a longer plain note\n",
        ] {
            assert_eq!(decrypt_bytes(&k, data).unwrap(), data);
        }
    }

    #[test]
    fn an_empty_key_file_or_a_missing_version() {
        let empty = KeyFile::default();
        assert!(matches!(
            encrypt_bytes(&empty, b"x"),
            Err(CryptError::EmptyKey)
        ));
        let mut v1_only = KeyFile::default();
        v1_only.add(Entry::generate(1).unwrap());
        let ct = encrypt_bytes(&v1_only, b"x").unwrap();
        assert!(matches!(
            decrypt_bytes(&v1_only, &ct),
            Err(CryptError::MissingVersion(0))
        ));
    }

    #[test]
    fn shell_escaping() {
        assert_eq!(
            escape_shell_arg("/Users/o/Library/Application Support/x/git-crypt"),
            "\"/Users/o/Library/Application Support/x/git-crypt\""
        );
        assert_eq!(escape_shell_arg(r#"a"b\c$d`e"#), r#""a\"b\\c\$d\`e""#);
    }
}
