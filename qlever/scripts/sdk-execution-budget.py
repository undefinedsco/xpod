"""One producer-owned absolute deadline across Docker phases; no admission state."""
import math
import time

class ExecutionBudget:
    def __init__(self,deadline_unix,wall=time.time,monotonic=time.monotonic):
        deadline=float(deadline_unix);remaining=deadline-wall()
        if not math.isfinite(deadline) or not 0<remaining<=21000:raise ValueError('Invalid or expired SDK producer deadline')
        self.deadline_unix=deadline;self.monotonic=monotonic;self.end=monotonic()+remaining
    def remaining(self):return self.end-self.monotonic()
    def check(self,reserve=0):
        if self.remaining()<=reserve:raise TimeoutError('SDK producer deadline reserve exhausted')
    def timeout(self,cap,reserve=0):
        if cap<=0 or reserve<0:raise ValueError('Invalid SDK stage budget')
        self.check(reserve)
        return min(cap,self.remaining()-reserve)
