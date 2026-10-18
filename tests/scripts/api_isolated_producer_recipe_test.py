import copy,importlib.util,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('isolated_api',ROOT/'scripts/validate-api-isolated-producer.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
class Recipe(unittest.TestCase):
 def plan(self):
  role=dict(id='root-build-packages-01',command='bun run --filter a build:tools',argv=['bun','run','--cwd','packages/a','build:tools'],cwd='packages/a',after=[])
  return dict(sourceSha='a'*40,target='linux-arm64',workspaceMode='api-ui-v1',executable=False,rootBuildRoles=[role],selectedBuildRoles=[copy.deepcopy(role)],isolatedInstall=dict(argv=['bun','install','--frozen-lockfile','--filter=root','--filter=a','--filter=!unused']),apiBuild=dict(argv=['bun','run','--cwd','packages/xpod-api','build']))
 def test_actual_role_recipe_and_frozen_install_only(self):
  plan=self.plan();rows=runner.validate_plan(plan,'a'*40,'linux-arm64');self.assertEqual([x[0] for x in rows],['isolated-install','root-build-packages-01','api-build']);self.assertNotIn('--prod',rows[0][1]);self.assertTrue(all(row[2]=='' for row in rows))
 def test_modified_role_order_command_or_install_rejects(self):
  for mutation in ['source','role','after','install','authority']:
   plan=self.plan()
   if mutation=='source':plan['sourceSha']='b'*40
   elif mutation=='role':plan['selectedBuildRoles'][0]['argv']=['bun','evil.ts']
   elif mutation=='after':plan['selectedBuildRoles'][0]['after']=['unknown']
   elif mutation=='install':plan['isolatedInstall']['argv'].append('--production')
   else:plan['executable']=True
   with self.assertRaises(ValueError):runner.validate_plan(plan,'a'*40,'linux-arm64')
if __name__=='__main__':unittest.main()
