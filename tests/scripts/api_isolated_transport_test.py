import importlib.util,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('transport_validator',ROOT/'scripts/validate-api-isolated-producer.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Transport(unittest.TestCase):
 def test_declared_proxy_forwarded_without_secret_or_node_option_inheritance(self):
  env=module.transport_environment({'PATH':'/tools','HTTPS_PROXY':'http://127.0.0.1:7897','HTTP_PROXY':'http://127.0.0.1:7897','NO_PROXY':'127.0.0.1,localhost','GH_TOKEN':'private','NODE_OPTIONS':'--require untrusted.js','NODE_PATH':'/ambient'},Path('/home'),Path('/tmp'),Path('/cache'))
  self.assertEqual(env['HTTPS_PROXY'],'http://127.0.0.1:7897');self.assertEqual(env['NO_PROXY'],'127.0.0.1,localhost');self.assertEqual(env['NODE_OPTIONS'],'--use-env-proxy');self.assertNotIn('GH_TOKEN',env);self.assertNotIn('NODE_PATH',env)
 def test_transport_bounds_do_not_echo_values(self):
  for value in ['secret\nvalue','x'*8193]:
   with self.assertRaises(ValueError) as error:module.transport_environment({'HTTPS_PROXY':value},Path('/home'),Path('/tmp'),Path('/cache'))
   self.assertNotIn(value,str(error.exception))
if __name__=='__main__':unittest.main()
