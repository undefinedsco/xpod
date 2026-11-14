/** Serialization contract only. None of these fields issues source/runtime
 * authority; only same-private-SDK readers and controlled originals can do so. */
export interface SdkExecutionOriginalRef {readonly path:string;readonly bytes:number;readonly sha256:string}
interface SdkExecutionStageBase {
 readonly name:'configure'|'compile';
 readonly inputs:readonly SdkExecutionOriginalRef[];readonly outputs:readonly SdkExecutionOriginalRef[];
 readonly receipt:SdkExecutionOriginalRef;readonly stdout:SdkExecutionOriginalRef;readonly stderr:SdkExecutionOriginalRef;
}
/** These are different observed closure mechanisms. A tracking receipt cannot
 * be serialized as a successful closed-process-group supervisor receipt. */
export type SdkExecutionStageOriginals=SdkExecutionStageBase & (
 {readonly closureKind?:'closed-process-group-v1';readonly supervisionReceipt:SdkExecutionOriginalRef;readonly supervisionRaw:SdkExecutionOriginalRef} |
 {readonly closureKind:'ptrace-tracked-phase-v1';readonly trackingReceipt:SdkExecutionOriginalRef;readonly rawTraceShards:readonly SdkExecutionOriginalRef[]}
);
export interface SdkObserverTrackedPhaseOriginal {
 readonly schemaVersion:1;readonly kind:'sdk-observer-tracked-phase-original';readonly phase:'configure'|'compile';
 readonly observerPid:number;readonly command:readonly string[];readonly actualRootPid:number;readonly actualRootReturnCode:number;
 readonly actualTrackedWait:boolean;readonly trackedProcessesClosed:boolean;readonly deadlineMonotonic:number;
 readonly startedUnixNs:string;readonly completedUnixNs:string;
 readonly waitReferences:readonly {readonly pid:number;readonly sequence:number;readonly returnCode:number;readonly phase:'configure'|'compile'}[];
}
export interface SdkExecutionObserverOriginal {
 readonly sourcePath:string;readonly file:SdkExecutionOriginalRef;
}
export interface SdkExecutionBackendDeclaration {
 readonly id:'ptrace-all-stop-process-v1'|'strace-process-v1';
 readonly observerOriginals:readonly SdkExecutionObserverOriginal[];
 /** Descriptive limitations, never verifier approval. Unknown operations fail
  * closed even if omitted here; receivers derive facts from actual raw events. */
 readonly coverage:{readonly processModel:'all-observed-descendants-single-thread';readonly consumerIo:readonly ('read'|'mmap')[];readonly unsupported:readonly string[]};
}
export interface SdkExecutionCaptureIndex {
 readonly schemaVersion:1;
 /** Full original refs, with unique basename for each capture across both
  * phases. Raw capture events refer to this basename; reader resolves only
  * through this exact same-ZIP index, never a caller filesystem path. */
 readonly files:readonly SdkExecutionOriginalRef[];
}
export interface SdkExecutionSelectedInputs {
 readonly schemaVersion:1;
 readonly files:readonly {readonly originalPath:string;readonly actualInput:{readonly originalPath:string;readonly archivePath:string;readonly bytes:number;readonly sha256:string;readonly mode:number;readonly role:string}}[];
 readonly unresolvedInputs:readonly {readonly path:string;readonly reason:'generated-or-unobserved-before-compile'}[];
}
export interface SdkToolchainExecutionCollection {
 readonly schemaVersion:1;readonly kind:'qlever-sdk-toolchain-execution-originals';
 /** Root collection only. The inner original has the same complete object
  * minus this field and every reference path without the 'inner/' prefix. */
 readonly innerMaterials:SdkExecutionOriginalRef;
 readonly sourceRoot:'/opt/qlever-sdk/source';readonly buildRoot:'/opt/qlever-sdk/build';
 readonly sourceProviderOriginals:{readonly mountinfo:SdkExecutionOriginalRef};
 readonly preparedSource:{readonly upstreamInventory:SdkExecutionOriginalRef;
  readonly beforeInputs:SdkExecutionOriginalRef;readonly afterInputs:SdkExecutionOriginalRef;
  readonly symlinks:{readonly before:SdkExecutionOriginalRef;readonly after:SdkExecutionOriginalRef};
  readonly generationMetadata:{readonly before:SdkExecutionOriginalRef;readonly after:SdkExecutionOriginalRef}};
 /** Exactly the existing producer ExecutionBudget.deadline_unix; no new window.
  * Controller verification independently clamps all I/O to its own remaining. */
 readonly deadlineUnix:number;
 readonly phases:readonly {readonly name:'configure'|'compile';readonly backend:SdkExecutionBackendDeclaration;
  readonly phaseBinding:SdkExecutionStageOriginals;
  /** Ordered JSONL records, sequence is contiguous globally configure→compile;
   * each <= canonical shardBytes, sum shares the existing 4GiB source budget. */
  readonly rawTraceShards:readonly SdkExecutionOriginalRef[];
  /** Each index <= canonical metadataBytes. Payload bytes are unique, full
   * originals; identical content may share a registered capture basename. */
  readonly captures:{readonly indexes:readonly SdkExecutionOriginalRef[];readonly files:number;readonly bytes:number};
  readonly selectedInputs:SdkExecutionOriginalRef}[];
}
