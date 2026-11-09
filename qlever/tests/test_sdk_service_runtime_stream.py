"""RC387: runtime roots need the runtime expanded profile, not the source-archive
shard default, and the shared copy pool must be large enough for every root.

The real failed image measured /app at 568,774,144 decoded bytes (123,918,442
encoded) and /opt/xpod/qlever at 32,330,752 decoded (8,935,785 encoded). The source
archive default (shardBytes = 512 MiB) rejects the first root outright. These tests
pin the profile split without allocating hundreds of MiB: the writer's accounting is
exercised through its own bound arithmetic on a repetitive streaming fixture.
"""
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1] / 'scripts'
IMAGES = HERE / 'sdk-service-image-originals.py'
STREAM = HERE / 'sdk-service-runtime-stream.py'


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


images = _load('runtime_profile_images', IMAGES)
stream = _load('runtime_profile_stream', STREAM)

APP_EXPANDED = 568774144
APP_ENCODED = 123918442
OPT_EXPANDED = 32330752
OPT_ENCODED = 8935785


class RuntimeProfile(unittest.TestCase):
    def test_runtime_profile_is_the_reviewed_expanded_bound_not_the_shard_default(self):
        self.assertEqual(images.RUNTIME_EXPANDED_LIMIT, images.LIMITS['expandedBytes'])
        self.assertGreater(images.RUNTIME_EXPANDED_LIMIT, images.LIMITS['shardBytes'])
        # The real /app root exceeds the source-archive default and fits the runtime one.
        self.assertGreater(APP_EXPANDED, images.LIMITS['shardBytes'])
        self.assertLessEqual(APP_EXPANDED, images.RUNTIME_EXPANDED_LIMIT)

    def test_runtime_encoded_pool_covers_both_measured_roots(self):
        self.assertEqual(images.RUNTIME_ENCODED_LIMIT, images.LIMITS['packedBytes'])
        self.assertLessEqual(APP_ENCODED + OPT_ENCODED, images.RUNTIME_ENCODED_LIMIT)
        share = images.shared_runtime_cp_bound(type('R', (), {'total': 0})(), 2)
        self.assertGreaterEqual(share, APP_ENCODED)
        # After the first root is retained, the second root must still fit.
        retained = type('R', (), {'total': APP_ENCODED + images.RUNTIME_STAGE_OVERHEAD})()
        self.assertGreaterEqual(images.shared_runtime_cp_bound(retained, 1), OPT_ENCODED)

    def test_reservation_counts_one_original_plus_overhead(self):
        """The old formula reserved 2*copy_bound for stdout+stderr, but stderr is
        capped at META, so half the reservation was unusable."""
        total = images.RUNTIME_ENCODED_LIMIT
        self.assertEqual(images.RUNTIME_STAGE_OVERHEAD, 4 * images.META)
        self.assertLess(images.RUNTIME_STAGE_OVERHEAD, 2 * images.META + 3 * images.META)
        # Two roots still fit inside the pool with cleanup room.
        share = images.shared_runtime_cp_bound(type('R', (), {'total': 0})(), 2)
        need = 2 * (share + images.RUNTIME_STAGE_OVERHEAD) + images.RUNTIME_CLEANUP_ROOM
        self.assertLessEqual(need, total)

    def test_isolated_runtime_codec_leaves_the_source_codec_untouched(self):
        default_limit = stream.CODEC.ARCHIVE_LIMIT
        isolated = stream._runtime_codec(images.RUNTIME_EXPANDED_LIMIT)
        self.assertIsNot(isolated, stream.CODEC)
        self.assertEqual(isolated.ARCHIVE_LIMIT, images.RUNTIME_EXPANDED_LIMIT)
        self.assertEqual(stream.CODEC.ARCHIVE_LIMIT, default_limit)
        self.assertEqual(images.RUNTIME_EXPANDED_LIMIT,
                         images.LIMITS['expandedBytes'])
        # The runtime bound may never exceed the reviewed central contract.
        with self.assertRaises(ValueError):
            stream._runtime_codec(images.LIMITS['expandedBytes'] + 1)

    def test_runtime_writer_accepts_a_payload_over_the_shard_default(self):
        """Drive the REAL GzipBlockWriter accounting past shardBytes without holding
        the whole payload: feed repetitive blocks until the expanded counter crosses
        the source default, then prove the runtime instance still accepts."""
        codec = stream._runtime_codec(images.RUNTIME_EXPANDED_LIMIT)

        class Sink:
            def __init__(self):
                self.count = 0
                self.data = bytearray()

            def write(self, data):
                self.count += len(data)
                self.data.extend(data)
                return len(data)

            def tell(self):
                return self.count

            def flush(self):
                return None

        sink = Sink()
        writer = codec.GzipBlockWriter(sink)
        block = b'\0' * (1 << 20)
        steps = images.LIMITS['shardBytes'] // len(block) + 8
        for _ in range(steps):
            writer.write(block)
        writer.finish()
        self.assertGreater(writer.expanded_bytes, images.LIMITS['shardBytes'])
        self.assertLessEqual(writer.expanded_bytes, images.RUNTIME_EXPANDED_LIMIT)
        self.assertLessEqual(len(sink.data), images.RUNTIME_ENCODED_LIMIT)

    def test_runtime_writer_still_rejects_past_the_runtime_expanded_bound(self):
        codec = stream._runtime_codec(1024)
        sink = type('S', (), {'count': 0, 'write': lambda self, d: len(d),
                              'tell': lambda self: self.count,
                              'flush': lambda self: None})()
        writer = codec.GzipBlockWriter(sink)
        writer.write(b'\0' * 512)
        with self.assertRaises(ValueError):
            writer.write(b'\0' * 4096)


if __name__ == '__main__':
    unittest.main()
