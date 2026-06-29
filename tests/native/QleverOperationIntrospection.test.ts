import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const introspectionHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverOperationIntrospection.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever operation introspection bridge', () => {
  it('extracts operation tree metadata without executing the operation', async () => {
    expect(hasCxx(), 'c++ compiler is required for native operation introspection check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-operation-introspection-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionTree.h'), `
#pragma once
#include <string>
#include <vector>
#include "global/Id.h"
class QueryExecutionTree {
 public:
  QueryExecutionTree(std::string descriptor, size_t width, std::vector<ColumnIndex> sorted)
      : descriptor_(descriptor), width_(width), sorted_(sorted) {}
  const std::string& getDescriptor() const { return descriptor_; }
  size_t getResultWidth() const { return width_; }
  std::vector<ColumnIndex> resultSortedOn() const { return sorted_; }
 private:
  std::string descriptor_;
  size_t width_;
  std::vector<ColumnIndex> sorted_;
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
  virtual std::string getDescriptor() const = 0;
  virtual size_t getResultWidth() const = 0;
  const std::vector<ColumnIndex>& getResultSortedOn() const {
    sorted_cache_ = resultSortedOn();
    return sorted_cache_;
  }
  virtual std::vector<QueryExecutionTree*> getChildren() = 0;
 protected:
  virtual std::vector<ColumnIndex> resultSortedOn() const = 0;
 private:
  mutable std::vector<ColumnIndex> sorted_cache_;
};
`, 'utf8');

      const smoke = path.join(root, 'operation_introspection_smoke.cpp');
      const binary = path.join(root, 'operation_introspection_smoke');
      await writeFile(smoke, `
#include "XpodQleverOperationIntrospection.hpp"

class FakeOperation : public Operation {
 public:
  FakeOperation() : child_("child scan", 3, {1}) {}
  std::string getDescriptor() const override { return "root join"; }
  size_t getResultWidth() const override { return 4; }
  std::vector<QueryExecutionTree*> getChildren() override { return {&child_}; }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {0, 2}; }
 private:
  QueryExecutionTree child_;
};

int main() {
  FakeOperation operation;
  auto info = xpod::qlever::inspectQleverOperation(operation);
  if (info.descriptor != "root join") return 1;
  if (info.result_width != 4) return 2;
  if (info.sorted_by.size() != 2 || info.sorted_by[0] != 0 || info.sorted_by[1] != 2) return 3;
  if (info.children.size() != 1) return 4;
  if (info.children[0].descriptor != "child scan") return 5;
  if (info.children[0].result_width != 3) return 6;
  if (info.children[0].sorted_by.size() != 1 || info.children[0].sorted_by[0] != 1) return 7;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(introspectionHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
