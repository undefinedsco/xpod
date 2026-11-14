import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('api_producer',ROOT/'scripts/api-module-producer.py');producer=importlib.util.module_from_spec(spec);spec.loader.exec_module(producer)
class LifecycleTests(unittest.TestCase):
 def test_global_default_retains_exact_original_install_and_stage_order(self):
  rows=producer.phase_plan('/repo','/output','1.0.0','darwin-arm64');self.assertEqual(rows[0],('install',['bun','install','--frozen-lockfile'],600));self.assertEqual([r[0] for r in rows],['install','declarations','shared-packages','dependency-state','api-build','native-inputs','stage','native-material','notices','pack','pack-result'])
 def test_explicit_lifecycle_retains_shared_build_and_scopes_dependency_entry(self):
  rows=producer.phase_plan('/repo','/output','1.0.0','darwin-arm64',workspace_recipe='api-ui-root-minimal-v2',workspace_source_sha='a'*40)
  self.assertEqual([r[0] for r in rows[:7]],['install-selection','install','postinstall','declarations','install-graph','shared-packages','dependency-state']);self.assertEqual(rows[2][1],['bun','run','postinstall']);self.assertEqual(rows[5][1],['bun','run','build:packages']);self.assertEqual(rows[6][1],['bun','/repo/scripts/check-api-producer-dependency-state.ts','a'*40,'darwin-arm64','/output/evidence/install-selection.raw.log'])
  self.assertIn('install',rows[1][1]);self.assertNotIn('--ignore-scripts',sum([r[1] for r in rows],[]))
 def test_unknown_recipe_or_unbound_source_cannot_project_new_lifecycle(self):
  for options in [dict(workspace_recipe='unknown'),dict(workspace_recipe='api-ui-root-minimal-v2'),dict(workspace_recipe='api-ui-root-minimal-v2',workspace_source_sha='head')]:
   with self.assertRaises(ValueError):producer.phase_plan('/repo','/output','1.0.0','darwin-arm64',**options)
if __name__=='__main__':unittest.main()
