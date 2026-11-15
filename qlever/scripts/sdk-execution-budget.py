"""One producer-owned absolute deadline across Docker phases; no admission state.

The policy object is the single declaration consumed by the producer and the
independent phase reader.  Historical policies keep their original fixed caps;
new policies derive configure time from the already-armed global deadline and
never create a second or extendable deadline.
"""
import math
import time


class PhaseBudgetPolicy:
    def __init__(self,name,version,configure,downstream_reserve_seconds,observation_window,window_seconds=None):
        self.name=name
        self.version=version
        self.configure=configure
        self.downstream_reserve_seconds=downstream_reserve_seconds
        self.observation_window=observation_window
        self.window_seconds=window_seconds

    def declaration(self):
        value=dict(schemaVersion=1,name=self.name,version=self.version,configure=self.configure,
                   downstreamReserveSeconds=self.downstream_reserve_seconds,
                   observationWindow=self.observation_window)
        if self.window_seconds is not None:value['windowSeconds']=self.window_seconds
        return value

    def configure_timeout(self,budget,cap,reserve):
        if self.configure=='run-minus-reserve':
            if reserve!=self.downstream_reserve_seconds:raise ValueError('phase budget requires the exact existing downstream reserve')
            budget.check(reserve)
            remaining=budget.remaining()-reserve
            if remaining<=0:raise TimeoutError('SDK producer deadline reserve exhausted')
            return remaining
        return budget.timeout(cap,reserve)

    def observation_window_deadline(self,parent_deadline,now):
        if type(parent_deadline) not in [int,float] or type(now) not in [int,float] or not math.isfinite(parent_deadline) or not math.isfinite(now):
            raise ValueError('finite phase-parent deadline required')
        if parent_deadline<=now:raise TimeoutError('actual owned child observation deadline')
        if self.observation_window=='phase-parent':return parent_deadline
        if self.window_seconds is None:raise ValueError('observation window policy lacks a cap')
        return min(parent_deadline,now+self.window_seconds)


LEGACY_PHASE_BUDGET_POLICY=PhaseBudgetPolicy(
    'legacy-fixed-v1','legacy-fixed-v1','fixed-1800',4200,'fixed-seconds',1.0)
PHASE_PARENT_BUDGET_POLICY=PhaseBudgetPolicy(
    'phase-parent-v1','phase-parent-v1','run-minus-reserve',4200,'phase-parent')
PHASE_BUDGET_POLICIES={p.version:p for p in (LEGACY_PHASE_BUDGET_POLICY,PHASE_PARENT_BUDGET_POLICY)}


def canonical_policy_version(value):
    if type(value) is not str or value not in PHASE_BUDGET_POLICIES:raise ValueError('unknown phase budget policy version')
    return value


def policy_for_version(version):
    return PHASE_BUDGET_POLICIES[canonical_policy_version(version)]


class ExecutionBudget:
    def __init__(self,deadline_unix,wall=time.time,monotonic=time.monotonic,policy=None):
        deadline=float(deadline_unix);remaining=deadline-wall()
        if not math.isfinite(deadline) or not 0<remaining<=21000:raise ValueError('Invalid or expired SDK producer deadline')
        if policy is not None and not isinstance(policy,PhaseBudgetPolicy):raise ValueError('invalid phase budget policy')
        self.deadline_unix=deadline;self.monotonic=monotonic;self.end=monotonic()+remaining
        self.policy=policy or LEGACY_PHASE_BUDGET_POLICY
    def remaining(self):return self.end-self.monotonic()
    def check(self,reserve=0):
        if self.remaining()<=reserve:raise TimeoutError('SDK producer deadline reserve exhausted')
    def timeout(self,cap,reserve=0):
        if cap<=0 or reserve<0:raise ValueError('Invalid SDK stage budget')
        self.check(reserve)
        return min(cap,self.remaining()-reserve)
    def phase_timeout(self,phase,cap,reserve=0):
        if phase=='configure':return self.policy.configure_timeout(self,cap,reserve)
        return self.timeout(cap,reserve)
