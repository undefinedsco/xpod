# Native-first RDF Physical Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add the first native-first RDF physical backend protocol artifact: a stable C ABI header, header validator, and docs links for future PostgreSQL extension / QLever-compatible executor work.

**Architecture:** The protocol source of truth is a C ABI header under `native/postgres/rdf_protocol/include/`. TypeScript is used only for tests and validation tooling. The header defines opaque/native-safe value structs, callback tables, scan/search/stats/profile surfaces, and avoids QLever/C++ types at the boundary.

**Tech Stack:** C11-compatible ABI header, Vitest for repository tests, Node script for ABI/header checks, existing Bun test runner.

---

### Task 1: Header validation test

**Files:**
- Create: `tests/native/RdfPhysicalBackendProtocolHeader.test.ts`

- [x] **Step 1: Write failing tests for the native protocol header**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const headerPath = path.join(repoRoot, 'native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h');

function compiler(name: 'cc' | 'c++'): string | null {
  try {
    execFileSync('/usr/bin/env', [name, '--version'], { stdio: 'ignore' });
    return name;
  } catch {
    return null;
  }
}

describe('native RDF physical backend protocol header', () => {
  it('exists and exposes a native-first C ABI boundary', () => {
    expect(existsSync(headerPath)).toBe(true);
    const header = readFileSync(headerPath, 'utf8');

    expect(header).toContain('#define XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION 1');
    expect(header).toContain('extern "C"');
    expect(header).toContain('typedef struct xpod_rdf_backend_v1');
    expect(header).toContain('xpod_rdf_scan_permutation_fn');
    expect(header).toContain('xpod_rdf_text_search_fn');
    expect(header).toContain('xpod_rdf_vector_search_fn');
    expect(header).toContain('xpod_rdf_profile_event_callback');

    expect(header).not.toMatch(/std::|namespace\s+|template\s*</);
    expect(header).not.toMatch(/IndexImpl|PermutationPtr|RuntimeInformation|QLever/);
  });

  it('is consumable from C and C++ without exposing C++ ABI', async () => {
    const cc = compiler('cc');
    const cxx = compiler('c++');
    expect(cc, 'cc compiler is required for native ABI syntax check').toBeTruthy();
    expect(cxx, 'c++ compiler is required for native ABI syntax check').toBeTruthy();

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-protocol-'));
    try {
      const source = `#include "native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h"\nint main(void) {\n  xpod_rdf_backend_v1 backend = {0};\n  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;\n  return backend.abi_version == 1 ? 0 : 1;\n}\n`;
      const cFile = path.join(root, 'check.c');
      const cppFile = path.join(root, 'check.cpp');
      await writeFile(cFile, source, 'utf8');
      await writeFile(cppFile, source, 'utf8');

      execFileSync(cc!, ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', repoRoot, '-fsyntax-only', cFile], { stdio: 'pipe' });
      execFileSync(cxx!, ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', repoRoot, '-fsyntax-only', cppFile], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts --run`

Expected: FAIL because `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h` does not exist.

### Task 2: Native C ABI header

**Files:**
- Create: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`

- [x] **Step 1: Implement the minimal native protocol header**

Create a C11-compatible header with:

- ABI/version macros.
- `extern "C"` guard.
- fixed-width opaque handles (`uint64_t`).
- term/snapshot/quad/graph/access/source structs.
- permutation scan, count/distinct, stats, text search, vector search callbacks.
- execution profile callback shape.
- `xpod_rdf_backend_v1` function table.

- [x] **Step 2: Run header test to verify it passes**

Run: `bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts --run`

Expected: PASS.

### Task 3: ABI check script and package command

**Files:**
- Create: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `package.json`

- [x] **Step 1: Add script-level validator**

The script should:

- read the header;
- assert required symbols exist;
- assert forbidden C++/QLever-internal symbols do not exist;
- compile a tiny C and C++ translation unit if `cc` / `c++` are available.

- [x] **Step 2: Add package script**

Add:

```json
"check:rdf-protocol-abi": "node scripts/check-rdf-physical-protocol-abi.cjs"
```

- [x] **Step 3: Run script**

Run: `bun run check:rdf-protocol-abi`

Expected: PASS with an OK message.

### Task 4: Docs wiring

**Files:**
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`
- Modify: `docs/rdf-engine-spec.md` only if needed for the concrete header path.

- [x] **Step 1: Link the spec to the new header**

Add a short implementation artifact section pointing to:

```text
native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h
scripts/check-rdf-physical-protocol-abi.cjs
```

- [x] **Step 2: Verify docs and staged diff**

Run:

```bash
git diff --check
git status --short
```

Expected: only planned files changed, no whitespace errors.

### Task 5: Final verification and commit

**Files:** all changed files.

- [x] **Step 1: Run focused verification**

Run:

```bash
bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts --run
bun run check:rdf-protocol-abi
bun run build:ts
```

Expected: all pass.

- [x] **Step 2: Commit**

Use a lore commit message that records the native-first boundary and explicitly rejects TS-as-hot-protocol.
