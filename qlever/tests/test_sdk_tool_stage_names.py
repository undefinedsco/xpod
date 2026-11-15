import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('sdk_safe_stage',ROOT/'qlever/scripts/sdk-inner-materials.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class SafeToolStageNamesTest(unittest.TestCase):
    def test_real_capture_gate_accepts_every_declared_tool_without_identity_rewrite(self):
        self.assertEqual(len({stage for _,stage in module.SDK_TOOLS}),len(module.SDK_TOOLS))
        self.assertEqual(len({tool for tool,_ in module.SDK_TOOLS}),len(module.SDK_TOOLS))
        self.assertIn(('g++-12','tool-gxx-12'),module.SDK_TOOLS)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for tool,stage in module.SDK_TOOLS:
                result=module.commands.capture(stage,[sys.executable,'-c','import sys;print(sys.argv[1])',tool],root,root,timeout=5)
                self.assertEqual((root/result['stdout']['path']).read_text().strip(),tool)
            with self.assertRaisesRegex(ValueError,'stage name'):
                module.commands.capture('tool-g++-12',[sys.executable,'-c','pass'],root,root,timeout=5)
if __name__=='__main__':unittest.main()
