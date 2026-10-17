import {test,expect} from 'bun:test';
import {productProjectionIoBudget,PRODUCT_PROJECTION_REVIEW_PHASES,PRODUCT_PROJECTION_COHORT_BOUND} from '../../scripts/lib/independent-admission/product-projection-io-budget';
test('distinct actual indexed sizes and declared review references bound aggregate I/O',()=>{
 const budget=productProjectionIoBudget();budget.register('a'.repeat(64),10240);budget.register('a'.repeat(64),10240);
 expect(budget.snapshot().distinctOriginals).toBe(1);
 expect(budget.snapshot().maximumBytes).toBe(10240*PRODUCT_PROJECTION_COHORT_BOUND*PRODUCT_PROJECTION_REVIEW_PHASES.length);
 for(let pass=0;pass<PRODUCT_PROJECTION_COHORT_BOUND*PRODUCT_PROJECTION_REVIEW_PHASES.length;pass++)budget.reserve(10240);
 expect(()=>budget.reserve(1)).toThrow('I/O budget');
 expect(()=>budget.register('a'.repeat(64),10241)).toThrow('Conflicting');
});
test('actual cumulative I/O time, not idle time, exhausts the operation',()=>{
 const budget=productProjectionIoBudget();budget.register('b'.repeat(64),10240);
 const bound=budget.snapshot().maximumIoMilliseconds;
 budget.recordIo(bound-1);budget.reserve(1);expect(budget.remainingIoMilliseconds()).toBe(1);
 budget.recordIo(1);expect(()=>budget.reserve(1)).toThrow('I/O budget');
 expect(()=>budget.recordIo(1)).toThrow('I/O time');
});
