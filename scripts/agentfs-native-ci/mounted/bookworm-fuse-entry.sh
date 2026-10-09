#!/usr/bin/env bash
# Disposable Bookworm container entry for actual Linux Node22 noBun FUSE
# acceptance of the frozen product archive. Runs inside an owned container that
# only receives /dev/fuse + SYS_ADMIN + the mounted harness/product/evidence.
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 70; }

# 1. Real capability probe: a missing device is an actual failure, never a pass.
[ -e /dev/fuse ] || fail '{"stage":"fuse-device","errorClass":"missing-device"}'
grep -qw fuse /proc/filesystems || fail '{"stage":"fuse-device","errorClass":"kernel-fuse-absent"}'

# 2. Use the exact Node 22.21.1 runtime prepared by the network-allowed prep
#    stage into the owned prep volume; acceptance itself has no network.
NODE_VERSION=v22.21.1
node_home="${XPOD_MOUNTED_PREP:-/prep}/node22"
[ -x "${node_home}/bin/node" ] || fail '{"stage":"node-prep","errorClass":"prepared-node-missing"}'
export PATH="${node_home}/bin:${PATH}"
[ "$("${node_home}/bin/node" --version)" = "${NODE_VERSION}" ] || fail '{"stage":"node-prep","errorClass":"version-mismatch"}'

# 3. Acceptance stage: Node22 noBun from the actual consumer PATH.
if command -v bun >/dev/null 2>&1; then fail '{"stage":"node22-noBun","errorClass":"bun-present-in-path"}'; fi
export XPOD_MOUNTED_NODE="${node_home}/bin/node"

# 3.5 Bounded task-private Linux environment facts (the COLLECTOR process in the
#     acceptance container, BEFORE any mount case), collected via Node22 so JSON
#     is valid (no literal TAB) with no new dependency. Facts describe the
#     COLLECTOR process (/proc/self), NOT the product helper. Per ROOT's minimal
#     resolution, risky/optional facts are OMITTED as explicit unknown rather
#     than classified: no workspace stat/traversal, no hardcoded access success.
export XPOD_MOUNTED_WORKSPACE="${XPOD_MOUNTED_WORKSPACE:-/workspace}"
if [ -n "${XPOD_MOUNTED_EVIDENCE:-}" ]; then
  facts="${XPOD_MOUNTED_EVIDENCE}/linux-facts.json"
  "${node_home}/bin/node" -e '
    const fs=require("node:fs");
    const out=process.env.XPOD_MOUNTED_EVIDENCE+"/linux-facts.json";
    const workspace=process.env.XPOD_MOUNTED_WORKSPACE||"/workspace";
    const read=(p)=>{try{return fs.readFileSync(p,"utf8")}catch(e){return {error:(e&&e.code)||"error"}}};
    // Collector-read failures are explicit error/unknown, never silent empties.
    let status={}, statusState="collected";
    const st=read("/proc/self/status");
    if(typeof st!=="string"){statusState=`error:${st.error}`;}
    else for(const line of st.split("\n")){const m=/^(CapEff|CapBnd|NoNewPrivs|Seccomp):\s*(.*)$/.exec(line); if(m)status[m[1]]=m[2].trim();}
    let idOut=null, idState="collected";
    try{idOut=require("node:child_process").execSync("id",{encoding:"utf8"}).trim()}catch(e){idState=`error:${(e&&e.code)||"id-failed"}`;}
    // /dev/fuse: fileType/mode + truthful raw rdev + CORRECT Linux dev decode
    // (major/minor are interleaved bitfields, not 32-bit halves). No access
    // probes (optional; omitted as unknown, never a hardcoded success).
    let devFuse={state:"unknown"};
    try{
      const s=fs.lstatSync("/dev/fuse");
      const dev=BigInt(s.rdev);
      const major=Number((dev>>8n)&0xfffn)|Number((dev>>32n)&~0xfffn);
      const minor=Number(dev&0xffn)|Number((dev>>12n)&~0xffn);
      devFuse={state:"present",fileType:(s.isCharacterDevice()?"character":(s.isFIFO()?"fifo":(s.isFile()?"file":"other"))),
        mode:(s.mode&0o777).toString(8),rawRdev:Number(dev),major,minor,accessible:"not-observed"};
    }catch(e){devFuse={state:"absent-or-unreadable",error:(e&&e.code)||"error"};}
    let lsmCurrent=null, lsmState="collected";
    const lraw=read("/proc/self/attr/current");
    if(typeof lraw==="string")lsmCurrent=lraw.trim(); else lsmState=`error:${lraw.error}`;
    // Real mountinfo parse: longest mountpoint that is a prefix (path-boundary)
    // of the defaulted workspace; octal unescape; malformed/missing -> unknown.
    const unescape=(v)=>v.replace(/\\([0-7]{3})/g,(_,o)=>String.fromCharCode(parseInt(o,8)));
    let workspaceAncestor={state:"unknown"};
    const mi=read("/proc/self/mountinfo");
    if(typeof mi!=="string"){workspaceAncestor={state:`error:${mi.error}`};}
    else{
      let best=null;
      for(const line of mi.split("\n")){ if(!line)continue; const f=line.split(" "); const sep=f.indexOf("-"); if(sep<6||f.length<sep+4)continue; const mp=unescape(f[4]); if(workspace===mp||workspace.startsWith(mp.endsWith("/")?mp:mp+"/")){ if(!best||mp.length>best.mountpoint.length) best={mountpoint:mp,type:f[sep+1],fsSource:f[sep+2]}; } }
      workspaceAncestor=best?{state:"present",...best}:{state:"no-ancestor-found"};
    }
    const payload={schemaVersion:3,source:"acceptance-container-precase",collector:"node22-collector-process-not-helper",
      pid:process.pid,idOut,idState,status,statusState,lsmCurrent,lsmState,devFuse,workspace,workspaceAncestor,
      taskParent:"not-safely-observed",
      containerBinding:{state:"not-collected-in-container","note":"actualCID/imageID/NetworkMode/SecurityOpt/Mounts.RW are host-observed; never dump Env/credentials"}};
    fs.writeFileSync(out,JSON.stringify(payload,null,2)+"\n",{mode:0o600});
  '
  chmod 600 "$facts"
fi

# 4. Run the tracked, source-bound mounted acceptance driver under Node22.
export XPOD_MOUNTED_WORKSPACE="${XPOD_MOUNTED_WORKSPACE:-/workspace}"
cd "${XPOD_MOUNTED_WORKSPACE}"
exec "${node_home}/bin/node" --experimental-strip-types \
  "${XPOD_MOUNTED_WORKSPACE}/scripts/agentfs-native-ci/mounted/platform-admission.ts"
