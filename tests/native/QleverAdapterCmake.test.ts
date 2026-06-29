import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeIndexScanHeader, fakeParsedQueryHeader, fakePermissiveSparqlParserHeader, fakeSparqlTripleHeader } from './qleverFakeHeaders';

const repoRoot = path.resolve(__dirname, '../..');
const adapterRoot = path.join(repoRoot, 'native/postgres/qlever_adapter');
const cmakeLists = path.join(adapterRoot, 'CMakeLists.txt');
const qleverBridgeSource = path.join(adapterRoot, 'src/XpodQleverBridge.cpp');
const nativeBuildTimeoutMs = 30_000;

function hasCmake(): boolean {
  try {
    execFileSync('/usr/bin/env', ['cmake', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function cmakeFailureOutput(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  return [failure.stdout, failure.stderr, failure.message]
    .filter(Boolean)
    .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
    .join('\n');
}

describe('native QLever adapter CMake target', () => {
  it('configures and builds the adapter facade as a native library', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);
    expect(existsSync(cmakeLists)).toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-cmake-'));
    try {
      const buildDir = path.join(root, 'build');
      execFileSync('cmake', ['-S', adapterRoot, '-B', buildDir, '-DXPOD_QLEVER_ADAPTER_BUILD_SHARED=OFF'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
      execFileSync('cmake', ['--build', buildDir, '--target', 'xpod_qlever_adapter'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('includes the CMake adapter build in the repository ABI check', () => {
    const scriptPath = path.join(repoRoot, 'scripts/check-rdf-physical-protocol-abi.cjs');
    const output = execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });
    expect(output).toContain('QLever adapter CMake target');
  }, nativeBuildTimeoutMs);

  it('fails clearly when QLever mode is enabled without a source tree', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-source-required-'));
    try {
      const buildDir = path.join(root, 'build');
      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', buildDir,
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('XPOD_QLEVER_SOURCE_DIR is required');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('accepts an explicit QLever source tree when the required native headers exist', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);
    expect(existsSync(qleverBridgeSource)).toBe(true);
    expect(readFileSync(cmakeLists, 'utf8')).toContain('src/XpodQleverBridge.cpp');
    expect(readFileSync(cmakeLists, 'utf8')).toContain('engine/Operation.h');
    expect(readFileSync(cmakeLists, 'utf8')).toContain('engine/QueryExecutionTree.h');

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-source-present-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/libqlever'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/libqlever/Qlever.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlParser.h'), fakePermissiveSparqlParserHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionTree.h'), `
#pragma once
#include <string>
#include <vector>
#include "global/Id.h"
class QueryExecutionTree {
 public:
  const std::string& getDescriptor() const { return descriptor_; }
  size_t getResultWidth() const { return 0; }
  std::vector<ColumnIndex> resultSortedOn() const { return {}; }
 private:
  std::string descriptor_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Operation.h'), `
#pragma once
#include <string>
#include <vector>
#include "engine/QueryExecutionTree.h"
#include "global/Id.h"
class Operation {
 public:
  virtual ~Operation() = default;
  virtual std::string getDescriptor() const { return ""; }
  virtual size_t getResultWidth() const { return 0; }
  const std::vector<ColumnIndex>& getResultSortedOn() const {
    sorted_cache_ = resultSortedOn();
    return sorted_cache_;
  }
  virtual std::vector<QueryExecutionTree*> getChildren() { return {}; }
 protected:
  virtual std::vector<ColumnIndex> resultSortedOn() const { return {}; }
 private:
  mutable std::vector<ColumnIndex> sorted_cache_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryPlanner.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/IndexScan.h'), fakeIndexScanHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/idTable/IdTable.h'), `
#pragma once
#include <cstddef>
#include <vector>
#include "global/Id.h"
class IdTable {
 public:
  explicit IdTable(size_t width) : width_(width) {}
  size_t numColumns() const { return width_; }
  size_t numRows() const { return rows_.size(); }
  void push_back(const std::vector<Id>& row) { rows_.push_back(row); }
  const Id& operator()(size_t row, size_t column) const { return rows_[row][column]; }
 private:
  size_t width_;
  std::vector<std::vector<Id>> rows_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/RuntimeInformation.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cstdint>
using ColumnIndex = uint64_t;
class Id {
 public:
  static Id fromBits(uint64_t bits) { return Id(bits); }
  uint64_t getBits() const { return bits_; }
  uint64_t bits_;
 private:
  explicit Id(uint64_t bits) : bits_(bits) {}
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), `
#pragma once
class LocalVocab {};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Result.h'), `
#pragma once
#include <utility>
#include <vector>
#include "engine/idTable/IdTable.h"
#include "global/Id.h"
#include "index/LocalVocab.h"
class Result {
 public:
  Result(IdTable table, std::vector<ColumnIndex> sortedBy, LocalVocab&&)
      : table_(std::move(table)), sortedBy_(std::move(sortedBy)) {}
  const IdTable& idTable() const { return table_; }
  const std::vector<ColumnIndex>& sortedBy() const { return sortedBy_; }
 private:
  IdTable table_;
  std::vector<ColumnIndex> sortedBy_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Index.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
  explicit Permutation(Enum value = Enum::SPO) : value_(value) {}
  Enum permutation() const { return value_; }
 private:
  Enum value_;
};
`, 'utf8');

      const buildDir = path.join(root, 'build');
      execFileSync('cmake', [
        '-S', adapterRoot,
        '-B', buildDir,
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
        `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
      ], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
      execFileSync('cmake', ['--build', buildDir, '--target', 'xpod_qlever_adapter'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('rejects a QLever source tree missing lower-level planner and index headers', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-source-incomplete-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/libqlever'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/libqlever/Qlever.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/RuntimeInformation.h'), '#pragma once\n', 'utf8');

      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', path.join(root, 'build'),
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
          `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('parser/SparqlParser.h');
      expect(output).toContain('parser/ParsedQuery.h');
      expect(output).toContain('parser/SparqlTriple.h');
      expect(output).toContain('engine/QueryPlanner.h');
      expect(output).toContain('engine/Operation.h');
      expect(output).toContain('engine/QueryExecutionTree.h');
      expect(output).toContain('engine/Result.h');
      expect(output).toContain('engine/idTable/IdTable.h');
      expect(output).toContain('global/Id.h');
      expect(output).toContain('index/Index.h');
      expect(output).toContain('index/LocalVocab.h');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);
});
