"""Run the SDK86 metadata/ownership regressions in the existing early CI gate.

The gate is `python3 -m unittest discover -s qlever/tests -p test_qlever*`, so
only names starting with that prefix are imported remotely. This module exposes
the already-existing SDK86 semantic and ownership test classes; it adds no test
body, no fixture and no product role.
"""
from qlever.tests.test_sdk86_timestamp_effect import TimespecRange as Sdk86TimespecRangeTests
from qlever.tests.test_sdk86_timestamp_effect import SharedEffect as Sdk86SharedEffectTests
from qlever.tests.test_sdk_retained_metadata_chain import Tests as RetainedMetadataChainTests
from qlever.tests.test_sdk_ownership_cohort import WholeCohortBracket as OwnershipCohortBracketTests
from qlever.tests.test_sdk_ownership_cohort import LocalRefusal as OwnershipLocalRefusalTests
from qlever.tests.test_sdk_ownership_cohort import NegativeOwnership as OwnershipNegativeTests
from qlever.tests.test_sdk_shared_task_ownership import Tests as SharedTaskOwnershipTests
from qlever.tests.test_sdk_shared_task_ownership import AliasCloseTests as SharedTaskAliasCloseTests
from qlever.tests.test_sdk86_metadata_operands import TimestampOperands as Sdk86TimestampOperandTests
from qlever.tests.test_sdk86_metadata_operands import LinkOperands as Sdk86LinkOperandTests
