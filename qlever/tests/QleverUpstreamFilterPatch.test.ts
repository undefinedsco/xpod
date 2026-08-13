import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'qlever/scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-filter-physical-bounded-expression.patch',
);
const splitConjunctionsPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-filter-split-conjunctions.patch',
);

const upstreamFilterFixture = `#include "engine/Filter.h"

#include <sstream>

#include "backports/algorithm.h"
#include "engine/CallFixedSize.h"
#include "engine/ExistsJoin.h"
#include "engine/QueryExecutionTree.h"
#include "engine/sparqlExpressions/SparqlExpression.h"

Result Filter::computeResult(bool requestLaziness) {
  AD_LOG_DEBUG << "Getting sub-result for Filter result computation..." << endl;
  std::shared_ptr<const Result> subRes = _subtree->getResult(true);
  AD_LOG_DEBUG << "Filter result computation..." << endl;
  checkCancellation();

  if (subRes->isFullyMaterialized()) {
    IdTable result = filterIdTable(subRes->sortedBy(), subRes->idTableView());
    AD_LOG_DEBUG << "Filter result computation done." << endl;

    return {std::move(result), resultSortedOn(), subRes->getSharedLocalVocab()};
  }

  if (requestLaziness) {
    return {Result::LazyResult{
                ad_utility::OwningView{ad_utility::CachingTransformInputRange{
                    subRes->idTables(),
                    [this, subRes](auto& idTableVocabPair) {
                      IdTable filteredTable = this->filterIdTable(
                          subRes->sortedBy(), idTableVocabPair.idTable_);
                      return Result::IdTableVocabPair{
                          std::move(filteredTable),
                          std::move(idTableVocabPair.localVocab_)};
                    }}} |

                ql::views::filter(
                    [](const auto& pair) { return !pair.idTable_.empty(); })},
            subRes->sortedBy()};
  }

  // If we receive a generator of IdTables, we need to materialize it into a
  // single IdTable.
  size_t width = getSubtree().get()->getResultWidth();
  IdTable result{width, getExecutionContext()->getAllocator()};

  LocalVocab resultLocalVocab{};
  ad_utility::callFixedSizeVi(
      width, [this, &subRes, &result, &resultLocalVocab](auto WIDTH) {
        for (Result::IdTableVocabPair& pair : subRes->idTables()) {
          computeFilterImpl<WIDTH>(result, std::move(pair.idTable_),
                                   subRes->sortedBy());
          resultLocalVocab.mergeWith(pair.localVocab_);
        }
      });

  AD_LOG_DEBUG << "Filter result computation done." << endl;

  return {std::move(result), resultSortedOn(), std::move(resultLocalVocab)};
}

// _____________________________________________________________________________
CPP_template_def(typename Table)(requires IdTableLike<Table>)
    IdTable Filter::filterIdTable(std::vector<ColumnIndex> sortedBy,
                                  Table&& idTable) const {
  size_t width = idTable.numColumns();
  IdTable result{width, getExecutionContext()->getAllocator()};

  auto impl = [this, &result, &idTable, &sortedBy](auto WIDTH) {
    return this->computeFilterImpl<WIDTH>(result, AD_FWD(idTable),
                                          std::move(sortedBy));
  };
  ad_utility::callFixedSizeVi(width, impl);
  return result;
}

// _____________________________________________________________________________
CPP_template_def(int WIDTH,
                 typename Table)(requires IdTableLike<Table>) void Filter::
    computeFilterImpl(IdTable& dynamicResultTable, Table&& inputTable,
                      std::vector<ColumnIndex> sortedBy) const {
  LocalVocab dummyLocalVocab{};
  AD_CONTRACT_CHECK(inputTable.numColumns() == WIDTH || WIDTH == 0);
  IdTableStatic<WIDTH> resultTable =
      std::move(dynamicResultTable).toStatic<static_cast<size_t>(WIDTH)>();
  sparqlExpression::EvaluationContext evaluationContext(
      *getExecutionContext(), _subtree->getVariableColumns(),
      inputTable.template asStaticView<0>(),
      getExecutionContext()->getAllocator(), dummyLocalVocab,
      cancellationHandle_, deadline_);

  // TODO<joka921> This should be a mandatory argument to the
  // EvaluationContext constructor.
  evaluationContext._columnsByWhichResultIsSorted = std::move(sortedBy);
  const auto input =
      evaluationContext._inputTable.asStaticView<static_cast<size_t>(WIDTH)>();
  sparqlExpression::ExpressionResult expressionResult =
      _expression.getPimpl()->evaluate(&evaluationContext);
}
`;

const upstreamFilterHeaderFixture = `#pragma once

class Filter : public Operation {
  CPP_template(int WIDTH, typename Table)(
      requires IdTableLike<
          Table>) void computeFilterImpl(IdTable& dynamicResultTable,
                                         Table&& input,
                                         std::vector<ColumnIndex> sortedBy)
      const;

  // Run \`computeFilterImpl\` on the provided IdTable.
  CPP_template(typename Table)(requires IdTableLike<Table>) IdTable
      filterIdTable(std::vector<ColumnIndex> sortedBy, Table&& idTable) const;
};

#endif  // QLEVER_SRC_ENGINE_FILTER_H
`;

const upstreamFilterVisitorFixture = `Visitor::OperationsAndFilters Visitor::visit(
    Parser::GroupGraphPatternSubContext* ctx) {
  std::vector<GraphPatternOperation> ops;
  std::vector<SparqlFilter> filters;

  auto filter = [&filters](SparqlFilter filter) {
    filters.emplace_back(std::move(filter));
  };
  auto op = [&ops](GraphPatternOperation op) {
    ops.emplace_back(std::move(op));
  };

  if (ctx->triplesBlock()) {
    ops.emplace_back(visit(ctx->triplesBlock()));
  }
  for (auto& [graphPattern, triples] :
       visitVector(ctx->graphPatternNotTriplesAndMaybeTriples())) {
    std::visit(ad_utility::OverloadCallOperator{filter, op},
               std::move(graphPattern));

    // TODO<C++23>: use \`optional.transform\` for this pattern.
    if (!triples.has_value()) {
      continue;
    }
    if (ops.empty() || !std::holds_alternative<BasicGraphPattern>(ops.back())) {
      ops.emplace_back(BasicGraphPattern{});
    }
    std::get<BasicGraphPattern>(ops.back())
        .appendTriples(std::move(triples.value()));
  }
  return {std::move(ops), std::move(filters)};
}
`;

describe('QLever upstream Filter patch asset', () => {
  it('applies cleanly to the locked real upstream Filter source when configured', () => {
    const qleverSource = process.env.XPOD_QLEVER_SOURCE_DIR;
    if (qleverSource === undefined) {
      return;
    }

    execFileSync('node', [
      patchScript,
      '--qlever-source',
      qleverSource,
      '--patch',
      patchPath,
    ], { cwd: repoRoot, stdio: 'pipe' });
  });

  it('splits top-level FILTER conjunctions so independent predicates can move below joins', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-filter-conjunction-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(
        qleverSource,
        'src/parser/sparqlParser/SparqlQleverVisitor.cpp',
      );
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamFilterVisitorFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        splitConjunctionsPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(sourcePath, 'utf8');
      expect(patched).toContain('visitFilterConjuncts');
      expect(patched).toContain('conjunctions.size() == 1');
      expect(patched).toContain('visitExpressionPimpl(conjunct)');
      expect(patched).toContain('result.push_back(visit(filterContext))');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies to Filter computeResult so bounded expressions can use Xpod physical term ids', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-filter-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/Filter.cpp');
      const headerPath = path.join(qleverSource, 'src/engine/Filter.h');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamFilterFixture, 'utf8');
      await writeFile(headerPath, upstreamFilterHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(sourcePath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalFilterContextBridge.hpp"');
      expect(patched).toContain('xpod::qlever::physicalFilterResultFromContext');
      expect(patched).toContain('xpodFilter.status == XPOD_RDF_STATUS_OK');
      expect(patched).toContain('return std::move(xpodFilter.result);');
      expect(patched).toContain('LocalVocab localVocab = subRes->getCopyOfLocalVocab();');
      expect(patched).toContain('subRes->idTableView(), localVocab');
      const patchedHeader = await readFile(headerPath, 'utf8');
      expect(patchedHeader).toContain('LocalVocab& localVocab');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is a complete git-applyable patch asset', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-filter-git-apply-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/Filter.cpp');
      const headerPath = path.join(qleverSource, 'src/engine/Filter.h');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamFilterFixture, 'utf8');
      await writeFile(headerPath, upstreamFilterHeaderFixture, 'utf8');

      execFileSync('git', [
        'apply',
        '--check',
        patchPath,
      ], { cwd: qleverSource, stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an already patched Filter source as valid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-filter-patched-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/Filter.cpp');
      const headerPath = path.join(qleverSource, 'src/engine/Filter.h');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamFilterFixture, 'utf8');
      await writeFile(headerPath, upstreamFilterHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
        '--apply',
      ], { stdio: 'pipe' });
      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
      ], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not fail closed to the bridge fallback for bounded Filter modifiers', async () => {
    const bridge = await readFile(
      path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp'),
      'utf8',
    );

    expect(bridge).not.toContain('hasBridgeTermFilterModifier');
  });

  it('removes unary NOT bridge-owned filters from the residual QLever path', async () => {
    const bridge = await readFile(
      path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp'),
      'utf8',
    );

    expect(bridge).toContain('isBridgeTermFilterModifier');
    expect(bridge).toContain('BridgeResultModifierKind::AllOf');
    expect(bridge).toContain('BridgeResultModifierKind::Not');
    expect(bridge).toContain('BridgeResultModifierKind::Exists');
    expect(bridge).toContain('removeBridgeTermFilterModifiers(child)');
  });
});
