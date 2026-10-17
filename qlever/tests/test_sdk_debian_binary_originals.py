"""Tiny byte mechanics only. Fake armor never authenticates Debian signatures."""
import gzip
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('binary_originals', Path(__file__).parents[1] / 'scripts/sdk-debian-binary-originals.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def tar(rows):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, body in rows:
            item = tarfile.TarInfo(name)
            item.size, item.mode = len(body), 0o755
            archive.addfile(item, io.BytesIO(body))
    return output.getvalue()


def ar(rows):
    result = b'!<arch>\n'
    for name, body in rows:
        result += ('%-16s%-12s%-6s%-6s%-8s%-10s`\n' % (name + '/', '0', '0', '0', '100644', str(len(body)))).encode() + body
        if len(body) % 2:
            result += b'\n'
    return result


class BinaryOriginalTests(unittest.TestCase):
    def package(self, source='compiler-src (1.2-3)', mutation=None):
        control = ('Package: compiler\nVersion: 1.2-3+b1\nArchitecture: amd64\nSource: ' + source + '\n').encode()
        data = tar([('./usr/bin/compiler', b'actual installed bytes')])
        if mutation:
            data = mutation(data)
        deb = ar([('debian-binary', b'2.0\n'), ('control.tar.gz', gzip.compress(tar([('./control', control)]))), ('data.tar.xz', module.lzma.compress(data))])
        expected = dict(package='compiler', version='1.2-3+b1', architecture='amd64', source=dict(name='compiler-src', version='1.2-3'), bytes=len(deb), sha256=sha(deb))
        selected = [dict(dataPath='usr/bin/compiler', bytes=22, sha256=sha(b'actual installed bytes'), mode=0o755)]
        return deb, expected, selected

    def test_actual_deb_control_data_bin_nmu_source_tuple(self):
        deb, expected, selected = self.package()
        result = module.verify_deb(io.BytesIO(deb), expected, selected)
        self.assertEqual(result['files'], selected)
        self.assertEqual(result['unresolved'], [])
        self.assertEqual(result['debSha256'], sha(deb))

    def test_sha_changed_installed_bytes_mode_and_source_rejected(self):
        deb, expected, selected = self.package()
        for field, value in [('bytes', 23), ('sha256', '0' * 64), ('mode', 0o644)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                module.verify_deb(io.BytesIO(deb), expected, [{**selected[0], field: value}])
        with self.assertRaises(ValueError):
            module.verify_deb(io.BytesIO(deb), {**expected, 'sha256': '0' * 64}, selected)
        with self.assertRaises(ValueError):
            module.verify_deb(io.BytesIO(deb), {**expected, 'source': dict(name='compiler-src', version='1.2-3+b1')}, selected)

    def test_nonzero_hidden_tar_tail_and_duplicate_path_rejected(self):
        for mutation in [lambda raw: raw + b'hidden second archive', lambda _: tar([('./usr/bin/compiler', b'actual installed bytes'), ('./usr/bin/compiler', b'actual installed bytes')])]:
            deb, expected, selected = self.package(mutation=mutation)
            with self.assertRaises(ValueError):
                module.verify_deb(io.BytesIO(deb), expected, selected)

    def test_extended_tar_metadata_is_rejected_before_tarfile_large_read(self):
        def metadata(raw, kind, size):
            header = tarfile.TarInfo('././@LongLink')
            header.type, header.size = kind, size
            body = b'p' * (size - 1) + b'\0'
            if kind == tarfile.XHDTYPE:
                value = b'path=' + b'p' * size + b'\n'
                length = len(value) + 2
                while len(str(length)) + 1 + len(value) != length:
                    length = len(str(length)) + 1 + len(value)
                body = str(length).encode() + b' ' + value
                header.size = len(body)
            following = tarfile.TarInfo('unused')
            following.size = 0
            return header.tobuf(format=tarfile.GNU_FORMAT) + body + b'\0' * (-len(body) % 512) + following.tobuf(format=tarfile.USTAR_FORMAT) + raw
        original_read = tarfile._Stream.read
        for kind in [tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK, tarfile.XHDTYPE, tarfile.XGLTYPE]:
            actual_reads = []
            def instrument(stream, size):
                actual_reads.append(size)
                return original_read(stream, size)
            deb, expected, selected = self.package(mutation=lambda raw: metadata(raw, kind, module.META + 32))
            with patch.object(tarfile._Stream, 'read', instrument), self.assertRaisesRegex(ValueError, 'GNU/PAX metadata'):
                module.verify_deb(io.BytesIO(deb), expected, selected)
            self.assertTrue(actual_reads)
            self.assertLessEqual(max(actual_reads), module.META)
        # Each record fits, but their combined padded payload is over META.
        deb, expected, selected = self.package(mutation=lambda raw: metadata(metadata(raw, tarfile.GNUTYPE_LONGNAME, module.META // 2 + 1), tarfile.GNUTYPE_LONGNAME, module.META // 2 + 1))
        with self.assertRaisesRegex(ValueError, 'aggregate'):
            module.verify_deb(io.BytesIO(deb), expected, selected)

    def test_signed_packages_checksum_exact_coordinates_and_filename(self):
        deb, expected, _ = self.package()
        fields = ('Package: compiler\nVersion: 1.2-3+b1\nArchitecture: amd64\nSource: compiler-src (1.2-3)\nFilename: pool/main/c/compiler/compiler_1.2-3+b1_amd64.deb\nSize: ' + str(len(deb)) + '\nSHA256: ' + sha(deb) + '\n\n').encode()
        compressed = gzip.compress(fields)
        path = 'main/binary-amd64/Packages.gz'
        # Mechanical test only: no cryptographic signature is claimed.
        release = ('-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nComponents: main\nArchitectures: amd64 arm64 all\nSHA256:\n ' + sha(compressed) + ' ' + str(len(compressed)) + ' ' + path + '\n-----BEGIN PGP SIGNATURE-----\nfixture\n-----END PGP SIGNATURE-----\n').encode()
        request = [{key: expected[key] for key in ('package', 'version', 'architecture', 'source')}]
        result = module.verify_packages(release, io.BytesIO(compressed), path, request)
        self.assertEqual(result[0]['sha256'], sha(deb))
        for data, requested in [(compressed + b'x', request), (compressed, [{**request[0], 'version': '1.2-3'}]), (compressed, [{**request[0], 'source': dict(name='other', version='1')}])]:
            with self.assertRaises(ValueError):
                module.verify_packages(release, io.BytesIO(data), path, requested)
        with self.assertRaises(ValueError):
            module.verify_packages(release, io.BytesIO(compressed), 'main/binary-arm64/Packages.gz', request)

    def test_producer_protocol_preserves_exact_refs_and_counts_external_stages_once(self):
        # Protocol-only stage stub; no apt, network, signature or SDK cap.
        deb, expected, selected = self.package()
        parent = Path(__file__).resolve().parents[2] / '.test-data/debian-binary-tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            base = Path(directory)
            out, lists = base / 'out', base / 'lists'
            out.mkdir()
            lists.mkdir()
            owner = out / 'ownership-originals/compiler.list'
            owner.parent.mkdir()
            owner.write_bytes(b'/usr/bin/compiler\n')
            ledger = out / 'ledger.raw'
            ledger.write_bytes(b'compiler\t1.2-3+b1\tcompiler-src\t1.2-3\n')
            def ref(path, root):
                raw = Path(path).read_bytes()
                return dict(path=str(Path(path).relative_to(root)), bytes=len(raw), sha256=sha(raw))
            fields = ('Package: compiler\nVersion: 1.2-3+b1\nArchitecture: amd64\nSource: compiler-src (1.2-3)\nFilename: pool/main/c/compiler/compiler_1.2-3+b1_amd64.deb\nSize: ' + str(len(deb)) + '\nSHA256: ' + sha(deb) + '\n\n').encode()
            compressed = gzip.compress(fields)
            index_path = 'main/binary-amd64/Packages.gz'
            prefix = 'deb.debian.org_debian_dists_bookworm_'
            (lists / (prefix + 'main_binary-amd64_Packages.gz')).write_bytes(compressed)
            (lists / (prefix + 'InRelease')).write_bytes(('-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nComponents: main\nArchitectures: amd64 arm64 all\nSHA256:\n ' + sha(compressed) + ' ' + str(len(compressed)) + ' ' + index_path + '\n-----BEGIN PGP SIGNATURE-----\nfixture\n-----END PGP SIGNATURE-----\n').encode())
            original_regular = module.regular
            def regular(path, maximum, check):
                if str(path) == '/var/lib/dpkg/info/compiler.list':
                    return owner.read_bytes()
                return original_regular(path, maximum, check)
            def stage(name, command, cwd):
                stage_dir = out / 'stages' / name
                stage_dir.mkdir(parents=True)
                stdout = stage_dir / 'stdout.raw'
                if command[0] == 'dpkg-query':
                    stdout.write_bytes(b'compiler\t1.2-3+b1\tamd64\tcompiler-src\t1.2-3\n')
                else:
                    self.assertEqual(command[-5], '--download')
                    self.assertEqual(command[-4], 'https://deb.debian.org/debian/pool/main/c/compiler/compiler_1.2-3+b1_amd64.deb')
                    Path(command[-3]).write_bytes(deb)
                    stdout.write_bytes(b'')
                return dict(stdout=ref(stdout, out))
            before = {path.resolve() for path in out.rglob('*') if path.is_file()}
            remaining = lambda: 1024 * 1024 - sum(path.stat().st_size for path in out.rglob('*') if path.is_file())
            with patch.object(module, 'regular', side_effect=regular):
                result, count = module.acquire(out,
                    [dict(originalPath='/usr/bin/compiler', bytes=selected[0]['bytes'], sha256=selected[0]['sha256'], mode=0o755)],
                    [dict(originalPath='/var/lib/dpkg/info/compiler.list', original=ref(owner, out))],
                    ref(ledger, out), 'linux-x64', remaining, stage, ref, lambda: None, lists=lists)
            collection = module.json.loads((out / result['path']).read_text())
            self.assertEqual(collection['packages'][0]['byteObservation']['files'], selected)
            self.assertEqual(collection['unresolvedInputs'], [])
            created = {path.resolve() for path in out.rglob('*') if path.is_file()} - before
            self.assertEqual(count, sum(path.stat().st_size for path in created))
            def prefix(value):
                if isinstance(value, list):
                    return [prefix(child) for child in value]
                if isinstance(value, dict):
                    if all(key in value for key in ('path', 'bytes', 'sha256')):
                        return dict(value, path='inner/' + value['path'])
                    return {key: prefix(child) for key, child in value.items()}
                return value
            archive = base / 'sdk-original.zip'
            with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as sdk_zip:
                for path in out.rglob('*'):
                    if path.is_file():
                        sdk_zip.write(path, 'inner/' + str(path.relative_to(out)))
            plan = dict(collection=prefix(collection), verifiedRows=[dict(originalPath='/usr/bin/compiler', bytes=22, sha256=sha(b'actual installed bytes'), mode=0o755)],
                        sourceCoordinates=[dict(name='compiler-src', version='1.2-3')],
                        signatureReleaseSha256=[collection['indexOriginals'][0]['inRelease']['sha256']], remainingMilliseconds=10000)
            observed = module.observe_sdk(archive, plan)
            self.assertEqual(observed['files'][0]['installedPath'], '/usr/bin/compiler')
            self.assertEqual(observed['files'][0]['binary']['name'], 'compiler')
            self.assertFalse(observed['officialAuthorityIssued'])
            self.assertFalse(observed['wholeToolchainVerified'])
            alias = module.json.loads(module.json.dumps(plan))
            alias['verifiedRows'][0]['originalPath'] = '/opt/qlever-sdk/build/unrelated-copy'
            alias['collection']['packages'][0]['installed'][0]['originalPath'] = '/opt/qlever-sdk/build/unrelated-copy'
            changed_path = module.observe_sdk(archive, alias)
            self.assertEqual(changed_path['files'], [])
            self.assertEqual(changed_path['unresolved'], [dict(installedPath='/opt/qlever-sdk/build/unrelated-copy', reason='deb-member-to-installed-path-or-alias-binding-unverified')])
            for changed in [dict(plan, signatureReleaseSha256=['0' * 64]), dict(plan, sourceCoordinates=[dict(name='compiler-src', version='wrong')]),
                            dict(plan, verifiedRows=[dict(plan['verifiedRows'][0], sha256='0' * 64)])]:
                with self.assertRaises(ValueError):
                    module.observe_sdk(archive, changed)


if __name__ == '__main__':
    unittest.main()
