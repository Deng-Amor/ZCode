# Managed skill signed bundles

This Node-only module authenticates an entire skill before consumers interpret its
files. Public entrypoint: `@zcode/shared/managed-skills`. No filesystem, network,
mutable cache, installation, or trust storage belongs to this module.

Publishers UTF-8 encode `JSON.stringify(payload)`, sign the exact bytes with Ed25519,
and encode payload and signature as canonical padded base64 in the strict envelope.
Verification authenticates original bytes before JSON parsing. Formatting changes
require a new signature. SHA-256 hashes are lowercase hex over decoded file content.
Files describe ordinary bytes, with no symlink or executable metadata.

Deployment owns expected ID, reserved name, public key, and minimum version.
Managed skill IDs and names are unqualified identities. Both payload and trust reject
forward slash, backslash and colon to prevent path or namespace alias interpretation.
Consumers use returned bytes directly and must not fall back to ordinary skills on
failure. Returned buffers belong to callers; do not mutate bytes shared by sessions.
This contract proves content authorization, not OS write isolation or deployment trust.
Protection is not enabled until trusted deployment and consumer integration exist.

Limits cover compact serialized envelope UTF-8 bytes, per-file and total decoded
content, and file count. Transport readers must also bound raw bytes before parsing.
Paths use well-formed UTF-16, NFC Unicode and forward slashes. Unpaired surrogates
are rejected before UTF-8 encoding can collapse different names into one.
Trust accepts a single SPKI PUBLIC KEY PEM block, never a private key or concatenated PEM.
Windows aliases, trailing dots/spaces,
parent segments, case collisions and file/directory conflicts are rejected on all OSes.
