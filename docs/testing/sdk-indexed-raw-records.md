# SDK execution raw record storage

The normal SDK observer uses `schema-indexed-ndjson-v2` inside the lossless
`kernel-raw-gzip-v1` container. This is a lossless
storage format: it indexes repeated sets of field names and retains every event,
its ordering, all nested values, and exact integer values. It neither combines
events nor changes capture file contents. Historical object JSONL and indexed
v1 remain readable. Explicit low-level diagnostic callers can retain their
legacy settings.

The historical v1 phase begins with `["schema-indexed-ndjson-v1"]`. A new sorted, unique key
set is declared as `["schema", id, keys]` and immediately used by
`["row", id, values]`. IDs start at zero and increase without gaps. The decoder
persists across that phase's physical shards. A decoded `owned-root-binding`
must declare the actual format through `rawRecordModel`; legacy roots omit it.
Mixed formats, duplicate schemas, unused declarations, unknown IDs, mismatched
value counts, and incomplete indexed streams are rejected.

The existing source-material ledger charges every physical byte, including the
header and schema declarations, before an entire emit bundle is written. The
4 GiB aggregate budget, 512 MiB shard bound, 64 KiB emit bundle and decoded
record bounds, and parent deadlines remain in force. A dictionary has at most
256 schemas, each with at most 256 keys of at most 128 characters; its encoded
definitions also stay within 4 MiB. These limits describe storage metadata,
not new authority to accept an execution or source tree.

The independent generation reader parses each physical record once. Its
optional record callback performs the source controller's existing root-command,
operation classification and dependency checks after sequence/phase validation.
All capture-content verification and source closure checks still apply.
The observed-tool original reader also uses the shared decoder, keeping one
instance across all shards of each phase and finishing it before joining tool
descriptors. Its controller pins both the reader and imported decoder bytes.
Format metadata never enters the event sequence or tool-file universe. Existing
whole-original hashes, physical byte accounting, sequence, phase and private
snapshot joins remain required. The full tool fixture runs in both legacy and
indexed formats; cross-shard dictionaries and malformed or incomplete streams
are covered by `qlever/tests/test_sdk_observed_tool_originals.py`.
Mutation probes decode and re-encode their modified semantic rows using the same
format, so a refusal must still reach the actual execution relationship checks.

`qlever/tests/test_sdk_raw_record_codec.py` covers exact nested values and large
integers, legacy streams, malformed dictionaries and rows, and both size limits.
The actual Linux coordinated-wait and Clang/CMake probes exercise the normal
producer and independent reader together. Diagnostic results are not full SDK
publication qualification.

V2 indexes constant kind, phase, and architecture fields and encodes selected
integer fields as exact deltas. Canonical decimal string timestamps retain their
string type and original decimal bytes after decoding; noncanonical strings
(including leading zeroes) stay literal. Record order, values, and identities
are unchanged. The same 4 GiB aggregate logical wire bound, 512 MiB logical
shard bound, 64 KiB expanded record/emit limits, and schema bounds apply.

Gzip physical bytes, including final trailers and temporary peaks, share the
existing retained-byte ledger. Encoded and logical lengths and SHA256 are both
verified. Readers must exhaust each stream before issuing an observation; CRC,
truncation, missing EOF, extra data, and concatenated gzip members are rejected.
Physical compression does not increase a logical or time budget.
