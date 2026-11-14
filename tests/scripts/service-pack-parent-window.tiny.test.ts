import {test,expect} from 'bun:test';
import {servicePackSupervisorUtc,inspectServicePackParentWindow} from '../../scripts/lib/independent-admission/service-pack-parent-window';
test('actual Python supervisor microseconds and legacy JSON ISO stay in exact parent/job window',()=>{
 const started='2026-10-22T01:02:03.123456+00:00',closed='2026-10-22T01:02:03.123457+00:00';
 expect(servicePackSupervisorUtc(closed)-servicePackSupervisorUtc(started)).toBe(1000n);
 expect(servicePackSupervisorUtc('2026-10-22T01:02:03.123Z')).toBe(servicePackSupervisorUtc('2026-10-22T01:02:03.123000+00:00'));
 const value={receipt:{startedUTC:started,closedUTC:closed},jobStartedMs:Date.parse('2026-10-22T01:02:00Z'),jobClosedMs:Date.parse('2026-10-22T01:03:00Z'),deadlineUnixMs:Date.parse('2026-10-22T01:03:00Z')};
 expect(inspectServicePackParentWindow(value).closedUnixNs>inspectServicePackParentWindow(value).startedUnixNs).toBe(true);
 expect(()=>inspectServicePackParentWindow({...value,receipt:{startedUTC:closed,closedUTC:started}})).toThrow('window');
 expect(()=>inspectServicePackParentWindow({...value,deadlineUnixMs:value.deadlineUnixMs+900000})).toThrow('window');
 for(const invalid of ['2026-02-30T00:00:00.000Z','2026-10-22T01:02:03.123456+01:00','2026-10-22T01:02:03.123+00:00','2026-10-22T01:02:03.123456Z','2026-10-22T01:02:03.000Z ','2026-10-22T01:02:60.000Z'])expect(()=>servicePackSupervisorUtc(invalid)).toThrow();
});
