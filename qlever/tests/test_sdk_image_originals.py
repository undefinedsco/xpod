import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('sdk_image',ROOT/'qlever/scripts/sdk-image-originals.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def encoded(value):return json.dumps(value,sort_keys=True).encode()
class Response(io.BytesIO):
    def __enter__(self):return self
    def __exit__(self,*_):self.close()

class ImageOriginalsTest(unittest.TestCase):
    def test_registry_preserves_exact_manifest_config_bytes_and_rejects_wrong_blob(self):
        config=encoded(dict(os='linux',architecture='amd64',config={}))
        manifest=encoded(dict(schemaVersion=2,config=dict(digest='sha256:'+hashlib.sha256(config).hexdigest()),layers=[]))
        reference='ghcr.io/example/sdk@sha256:'+hashlib.sha256(manifest).hexdigest()
        def transport(request,**_):
            if '/token?' in request.full_url:return Response(b'{"token":"scope-limited-test-token"}')
            return Response(manifest if '/manifests/' in request.full_url else config)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            actual=module.registry_originals(reference,'linux-x64',root/'image',transport)
            self.assertEqual((root/actual['configOriginal']['path']).read_bytes(),config)
            self.assertEqual((root/actual['manifestOriginal']['path']).read_bytes(),manifest)
            with self.assertRaises(ValueError):module.registry_originals(reference,'linux-arm64',root/'wrong',transport)
        with tempfile.TemporaryDirectory() as directory:
            def bad(request,**kwargs):
                if '/blobs/' in request.full_url:return Response(config+b'changed')
                return transport(request,**kwargs)
            with self.assertRaisesRegex(ValueError,'digest mismatch'):module.registry_originals(reference,'linux-x64',Path(directory)/'bad',bad)
    def test_real_git_context_capture_precedes_build_and_rehashes_originals(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();repo=root/'repo';repo.mkdir();(repo/'qlever').mkdir();(repo/'qlever/input.h').write_text('actual context source')
            (repo/'.dockerignore').write_text('**/.git')
            def git(*args):return subprocess.check_output(['git','-c','core.hooksPath=/dev/null',*args],cwd=repo,stderr=subprocess.DEVNULL,text=True).strip()
            git('init');git('add','qlever/input.h','.dockerignore')
            git('-c','user.name=SDK fixture','-c','user.email=sdk-fixture@example.invalid','commit','-m','fixture')
            sha=git('rev-parse','HEAD');old=Path.cwd()
            try:
                os.chdir(repo)
                with patch.dict(os.environ,dict(GITHUB_SHA=sha)):
                    module.capture_context(root/'originals',str(int(time.time())+12000))
                context=json.loads((root/'originals/context-originals.json').read_text())
                self.assertEqual(context['sourceSha'],sha)
                self.assertEqual(len(context['files']),2)
                self.assertTrue((root/'originals/context.original.tar').is_file())
            finally:os.chdir(old)
if __name__=='__main__':unittest.main()
