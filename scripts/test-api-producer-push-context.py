"""Actual normal producer context contract; no build, install or network."""
import importlib.util,json,tempfile,unittest
from pathlib import Path
FILE=Path(__file__).with_name('api-module-producer.py')
spec=importlib.util.spec_from_file_location('api_context',FILE);api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
class Context(unittest.TestCase):
 def test_actual_push_context_and_rejected_drift(self):
  parent=FILE.parent.parent/'.test-data/api-producer-push-context';parent.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=parent) as temp:
   file=Path(temp)/'event.json';sha='a'*40
   env=dict(GITHUB_REPOSITORY=api.REPOSITORY,GITHUB_SHA=sha,GITHUB_EVENT_NAME='push',GITHUB_REF='refs/heads/staging',GITHUB_EVENT_PATH=str(file),GITHUB_RUN_ID='2',GITHUB_RUN_ATTEMPT='1',GITHUB_WORKFLOW_REF=api.REPOSITORY+'/'+api.WORKFLOW+'@refs/heads/staging',GITHUB_WORKFLOW_SHA=sha)
   body=dict(ref='refs/heads/staging',after=sha,deleted=False);file.write_text(json.dumps(body));source=dict(sha=sha,status='')
   actual=api.context(env,source);self.assertEqual(actual['event'],'push');self.assertEqual(actual['actualCheckoutSha'],sha);self.assertEqual(actual['runHeadSha'],sha)
   for key,value in [('after','b'*40),('ref','refs/heads/main'),('deleted',True),('deleted',None)]:
    file.write_text(json.dumps({**body,key:value}))
    with self.subTest(event=key,value=value),self.assertRaises(ValueError):api.context(env,source)
   file.write_text(json.dumps(body))
   for key,value in [('GITHUB_REF','refs/heads/main'),('GITHUB_SHA','b'*40),('GITHUB_WORKFLOW_SHA','b'*40),('GITHUB_WORKFLOW_REF',api.REPOSITORY+'/'+api.WORKFLOW+'@refs/heads/main')]:
    with self.subTest(environment=key),self.assertRaises(ValueError):api.context({**env,key:value},source)
   for event in ['workflow_dispatch','pull_request']:
    file.write_text(json.dumps({'pull_request':{'head':{'sha':'b'*40}}}));actual=api.context({**env,'GITHUB_EVENT_NAME':event},source)
    self.assertEqual(actual['runHeadSha'],'b'*40 if event=='pull_request' else sha)
if __name__=='__main__':unittest.main()
