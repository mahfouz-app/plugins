## What git-crypt doesn't protect

- File and folder names (your note titles), commit messages, and when each file changed stay readable on GitHub.
- The key can't be changed. Removing a member doesn't take back what they already have; to shut someone out, move the vault to a new repository.
- Commits made before you encrypt stay unencrypted unless you rewrite history or move to a new repository.
- Vaults using Git LFS can't be encrypted. To run git-crypt commands in a terminal, install git-crypt itself.
- Every installed plugin can ask your keys to decrypt, just as this one does. Set gpg-agent to ask for your passphrase or a YubiKey touch on every decrypt.
