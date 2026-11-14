import {test,expect} from 'bun:test';
import {projectStartupFailure,STARTUP_CONTAINER_STATES,STARTUP_HEALTH_STATUSES} from '../../scripts/accept-service-image-modes';

/** RC382: `start-base-topology-local` failed with code 1 after ~153s and the safe
 * artifact had no canary/modes/liveFailure/bootstrap, so nothing named the owned
 * container's state. This projection reports ONLY fixed enums and integer codes
 * from `docker inspect`, before cleanup, and never changes the original failure. */

const inspect=(over:any={})=>[{State:{Status:'exited',ExitCode:137,Health:{Status:'unhealthy'},...over}}];

test('a real inspect shape projects to fixed enums and integer codes',()=>{
  const got=projectStartupFailure({mode:'local',commandExitCode:1,inspect:inspect()})!;
  expect(got.mode).toBe('local');
  expect(got.containerState).toBe('exited');
  expect(got.healthStatus).toBe('unhealthy');
  expect(got.containerExitCode).toBe(137);
  expect(got.commandExitCode).toBe(1);
  expect(Object.keys(got).sort()).toEqual(['commandExitCode','containerExitCode','containerState','healthStatus','mode']);
});

test('an absent or unreadable owned container is reported honestly, never guessed',()=>{
  // ABSENT only when a successful owned query returned zero containers.
  const absent=projectStartupFailure({mode:'local',commandExitCode:1,reason:'container-absent'})!;
  expect(absent.containerState).toBe('absent');
  expect(absent.containerExitCode).toBeUndefined();
  // Every other read failure is UNAVAILABLE, never "absent".
  for(const reason of ['docker-unavailable','inspect-failed','inspect-unparseable'] as const){
    const got=projectStartupFailure({mode:'local',commandExitCode:1,reason})!;
    expect({reason,state:got.containerState}).toEqual({reason,state:'unavailable'});
  }
  // no reason at all + no inspect data is also unavailable, not a silent absence
  expect(projectStartupFailure({mode:'local',commandExitCode:1})!.containerState).toBe('unavailable');
});

test('unknown states, bad health values, non-integer and out-of-range codes are rejected',()=>{
  // unknown state enum -> unavailable rather than an invented value
  expect(projectStartupFailure({mode:'local',commandExitCode:1,inspect:inspect({Status:'weird-state'})})!.containerState).toBe('unavailable');
  // unknown health enum is dropped entirely
  expect(projectStartupFailure({mode:'local',commandExitCode:1,inspect:inspect({Health:{Status:'totally-made-up'}})})!.healthStatus).toBeUndefined();
  // string / negative / out-of-range container exit codes dropped
  for(const bad of ['137',-1,1.5,999]){
    expect(projectStartupFailure({mode:'local',commandExitCode:1,inspect:inspect({ExitCode:bad})})!.containerExitCode).toBeUndefined();
  }
  // non-integer or out-of-range command exit code makes the projection undefined
  for(const bad of ['1',-1,1.5,256,undefined]){
    expect(projectStartupFailure({mode:'local',commandExitCode:bad,inspect:inspect()})).toBeUndefined();
  }
  // unknown mode is refused
  expect(projectStartupFailure({mode:'prod',commandExitCode:1,inspect:inspect()})).toBeUndefined();
});

test('malicious Env/Config/Output/log strings are never copied into the projection',()=>{
  const hostile=inspect({
    Status:'running',
    Env:['XPOD_NODE_TOKEN=secret-token-value','PGPASSWORD=hunter2'],
    Output:'curl: (7) Failed to connect to http://secret.internal/ token=abc',
    Config:{Env:['SECRET=1'],Image:'ghcr.io/x/y@sha256:'+'a'.repeat(64)},
  });
  const got=projectStartupFailure({mode:'local',commandExitCode:1,inspect:hostile})!;
  const wire=JSON.stringify(got);
  for(const leak of ['secret-token-value','hunter2','secret.internal','token=abc','XPOD_NODE_TOKEN','PGPASSWORD','ghcr.io']){
    expect(wire).not.toContain(leak);
  }
  // enum set membership is the whole vocabulary
  expect(STARTUP_CONTAINER_STATES).toContain(got.containerState);
  expect(got.healthStatus===undefined||STARTUP_HEALTH_STATUSES.includes(got.healthStatus)).toBe(true);
});

test('the original startup failure code is preserved, never converted to success',()=>{
  for(const code of [1,2,125,137,255]){
    const got=projectStartupFailure({mode:'cloud',commandExitCode:code,inspect:inspect()})!;
    expect(got.commandExitCode).toBe(code);
    // projection is a report, not a status: the caller still throws
    expect('status' in got).toBe(false);
  }
});
