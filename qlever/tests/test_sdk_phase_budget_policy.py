import importlib.util
from pathlib import Path
import time
import unittest

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
budget=load('budget_policy_test',ROOT/'qlever/scripts/sdk-execution-budget.py')
vma=load('vma_policy_test',ROOT/'qlever/scripts/sdk-generated-vma-originals.py')
ptrace=load('ptrace_policy_test',ROOT/'qlever/scripts/sdk-ptrace-execution.py')
inner=load('inner_policy_test',ROOT/'qlever/scripts/sdk-inner-materials.py')
wait=load('owned_wait_policy_test',ROOT/'qlever/scripts/sdk-blocking-owned-wait.py')

class PhaseBudgetPolicyTest(unittest.TestCase):
 def test_legacy_keeps_exact_fixed_caps_and_window(self):
  clock=[1000.,10.]
  b=budget.ExecutionBudget(6000,lambda:clock[0],lambda:clock[1])
  self.assertEqual(b.phase_timeout('configure',1800,4200),800)
  self.assertEqual(b.policy.observation_window_deadline(1000,100),101)
  self.assertEqual(b.policy.declaration()['configure'],'fixed-1800')
  self.assertEqual(b.policy.declaration()['windowSeconds'],1.0)

 def test_new_configure_is_run_budget_minus_existing_reserve(self):
  clock=[1000.,10.]
  b=budget.ExecutionBudget(6000,lambda:clock[0],lambda:clock[1],budget.PHASE_PARENT_BUDGET_POLICY)
  self.assertEqual(b.phase_timeout('configure',1800,4200),800)
  self.assertEqual(b.phase_timeout('configure',None,4200),800)
  clock[:]=[1500.,510.]
  self.assertEqual(b.phase_timeout('configure',1800,4200),300)
  clock[:]=[6000.,5010.]
  with self.assertRaises(TimeoutError):b.phase_timeout('configure',1800,4200)
  for reserve in (0,4199,4201):
   with self.subTest(reserve=reserve):
    with self.assertRaises(ValueError):b.phase_timeout('configure',1800,reserve)

 def test_new_window_is_the_exact_parent_deadline_and_old_unknown_reject(self):
  self.assertEqual(budget.PHASE_PARENT_BUDGET_POLICY.observation_window_deadline(1000,100),1000)
  self.assertEqual(budget.LEGACY_PHASE_BUDGET_POLICY.observation_window_deadline(1000,100),101)
  with self.assertRaises(ValueError):budget.policy_for_version('unknown')
  with self.assertRaises(ValueError):budget.policy_for_version(None)
  self.assertEqual(budget.PHASE_PARENT_BUDGET_POLICY.declaration(),{
   'schemaVersion':1,'name':'phase-parent-v1','version':'phase-parent-v1','configure':'run-minus-reserve',
   'downstreamReserveSeconds':4200,'observationWindow':'phase-parent'})

 def test_declared_window_reader_accepts_only_exact_parent_authority(self):
  decl=budget.PHASE_PARENT_BUDGET_POLICY.declaration()
  window={'observedMonotonicNs':'100','windowDeadlineMonotonicNs':'200','parentDeadlineMonotonicNs':'200','budgetPolicy':decl}
  row={'observedMonotonicNs':'150','windowDeadlineMonotonicNs':'200','parentDeadlineMonotonicNs':'200','budgetPolicy':decl}
  self.assertTrue(vma.validate_window_budget(window,row,200,vma.PHASE_PARENT_MODEL))
  for forged in (
   dict(window,budgetPolicy=dict(decl,version='unknown')),
   {key:value for key,value in window.items() if key!='budgetPolicy'},
   dict(window,windowDeadlineMonotonicNs='201'),
   dict(window,budgetPolicy=dict(decl,observationWindow='fixed-seconds'))):
   with self.subTest(forged=forged):
    with self.assertRaises(ValueError):vma.validate_window_budget(forged,row,200,vma.PHASE_PARENT_MODEL)
  with self.assertRaises(ValueError):vma.validate_window_budget(window,row,200,'unknown-model')
  old_window={'observedMonotonicNs':'100','windowDeadlineMonotonicNs':'150','parentDeadlineMonotonicNs':'200'}
  old_row={'observedMonotonicNs':'120','windowDeadlineMonotonicNs':'150','parentDeadlineMonotonicNs':'200'}
  self.assertTrue(vma.validate_window_budget(old_window,old_row,200,vma.PARKED_WAIT_MODEL))
  with self.assertRaises(ValueError):vma.validate_window_budget(window,row,200,vma.PARKED_WAIT_MODEL)
  with self.assertRaises(ValueError):vma.validate_window_budget(dict(old_window,budgetPolicy=decl),old_row,200,vma.PARKED_WAIT_MODEL)
  self.assertIn(vma.PHASE_PARENT_MODEL,vma.PARKED_WAIT_MODELS)
  self.assertIn(vma.PHASE_PARENT_MODEL,vma.COORDINATED_WAIT_MODELS)
  self.assertEqual(vma.Runtime(__import__('types').SimpleNamespace(phase_budget_policy=budget.PHASE_PARENT_BUDGET_POLICY)).model,vma.PHASE_PARENT_MODEL)
  self.assertEqual(vma.Runtime(__import__('types').SimpleNamespace()).model,vma.MODEL)

 def test_phase_parent_claim_requires_exact_policy_and_waiter(self):
  import threading
  waiter=object();claim=dict(waiter=waiter,thread=threading.get_ident(),phase='configure',parent=200,local=200,policyVersion='phase-parent-v1')
  observer=type('Observer',(),{'current_phase':'configure','phase_budget_policy':budget.PHASE_PARENT_BUDGET_POLICY})()
  self.assertTrue(ptrace.held_outer_lease_context_matches(observer,waiter,claim,True,200,200))
  for forged in (dict(claim,policyVersion='legacy-fixed-v1'),dict(claim,local=199),dict(claim,phase='compile'),dict(claim,waiter=object())):
   with self.subTest(forged=forged):
    self.assertFalse(ptrace.held_outer_lease_context_matches(observer,waiter,forged,True,200,200))
  self.assertFalse(ptrace.held_outer_lease_context_matches(observer,waiter,claim,True,201,200))

 def test_actual_cross_module_observer_boundary_uses_registered_version(self):
  import tempfile
  self.assertIsNot(inner.budget_module.PhaseBudgetPolicy,ptrace.budget_policy_module.PhaseBudgetPolicy)
  with tempfile.TemporaryDirectory() as directory:
   observer=ptrace.Observer(directory,directory+'/source',directory+'/build',deadline_monotonic=time.monotonic()+30,check_budget=lambda:None,phase_budget_policy_version=inner.budget_module.PHASE_PARENT_BUDGET_POLICY.version)
   self.assertEqual(observer.phase_budget_policy.version,'phase-parent-v1')
  for bad in ('unknown',{'version':'phase-parent-v1'},inner.budget_module.PHASE_PARENT_BUDGET_POLICY,True):
   with self.subTest(bad=type(bad).__name__):
    with self.assertRaises(ValueError):ptrace.Observer('/tmp','/tmp/source','/tmp/build',deadline_monotonic=time.monotonic()+30,phase_budget_policy_version=bad)

 def test_legacy_new_fixture_fallback_and_finite_ns_edges(self):
  import threading
  waiter=object();claim=dict(waiter=waiter,thread=threading.get_ident(),phase='configure',parent=20,local=10)
  observer=object.__new__(ptrace.Observer);observer.current_phase='configure'
  self.assertTrue(ptrace.held_outer_lease_context_matches(observer,waiter,claim,True,10,20))
  with self.assertRaises(ValueError):budget.PHASE_PARENT_BUDGET_POLICY.observation_window_deadline(float('nan'),1)
  with self.assertRaises(ValueError):budget.PHASE_PARENT_BUDGET_POLICY.observation_window_deadline(float('inf'),1)
  decl=budget.PHASE_PARENT_BUDGET_POLICY.declaration()
  with self.assertRaises(ValueError):
   vma.validate_window_budget({'observedMonotonicNs':'1.5','windowDeadlineMonotonicNs':'200','parentDeadlineMonotonicNs':'200','budgetPolicy':decl},{'observedMonotonicNs':'2','windowDeadlineMonotonicNs':'200','parentDeadlineMonotonicNs':'200','budgetPolicy':decl},200,vma.PHASE_PARENT_MODEL)

 def test_real_sigalrm_short_parent_still_times_out_at_same_parent_deadline(self):
  parent=time.monotonic()+0.35
  timer=wait.BlockingOwnedWait(parent)
  with timer:
   token=timer.clamp(parent)
   self.assertEqual(timer.deadline,timer.parent_deadline)
   with self.assertRaises(TimeoutError):time.sleep(0.8)
  self.assertIsNone(timer.window)
  self.assertEqual(timer.deadline,timer.parent_deadline)

if __name__=='__main__':unittest.main()
