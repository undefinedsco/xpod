"""Pure Docker context policy contracts; no Docker build or native qualification."""
import re
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def runtime_dependency_specifiers(text):
    """Fixed helper declarations: whole `import type` is erased, not a runtime edge.

    A default runtime binding literally named `type` remains a runtime import.
    Only the reviewed complete type-only clause grammar is erased; unknown
    or commented clauses fail closed as runtime. Side-effect imports and
    require calls remain subject to the builtin gate.
    """
    result = re.findall(r"require\(['\"]([^'\"]+)['\"]\)", text)
    for clause, name in re.findall(r"^import\s+(.+?)\s+from\s+['\"]([^'\"]+)['\"]", text, re.M):
        type_only = re.fullmatch(r'type\s+(?:[A-Za-z_$][\w$]*|\*\s+as\s+[A-Za-z_$][\w$]*|\{[\w$\s,]*\})', clause)
        if type_only is None:
            result.append(name)
    result.extend(re.findall(r"^import\s+['\"]([^'\"]+)['\"]", text, re.M))
    return result


class ModuleContextTests(unittest.TestCase):
    def setUp(self):
        self.rules = [line.strip() for line in (ROOT / '.dockerignore').read_text().splitlines()
                      if line.strip() and not line.startswith('#')]

    def test_native_recipe_originals_have_exact_parent_and_file_exceptions(self):
        for directory in ['docker/qlever-runtime-sdk', 'docker/qlever-local-runtime']:
            file = directory + '/Dockerfile.module-bookworm'
            required = ['!docker/', 'docker/**', '!' + directory + '/', directory + '/**', '!' + file]
            positions = [self.rules.index(rule) for rule in required]
            self.assertEqual(positions, sorted(positions))
            self.assertTrue((ROOT / file).is_file())
        exceptions = [rule for rule in self.rules if rule.startswith('!docker/')]
        self.assertEqual(set(exceptions), {'!docker/', '!docker/qlever-runtime-sdk/', '!docker/qlever-local-runtime/',
            '!docker/qlever-runtime-sdk/Dockerfile.module-bookworm', '!docker/qlever-local-runtime/Dockerfile.module-bookworm',
            '!docker/qlever-runtime-sdk/Dockerfile', '!docker/qlever-local-runtime/Dockerfile'})
        self.assertNotIn('!docker/**', self.rules)

    def test_every_module_sdk_docker_recipe_copy_has_an_exact_context_exception(self):
        recipe = '\n'.join((ROOT / file).read_text() for file in ['docker/qlever-runtime-sdk/Dockerfile.module-bookworm','docker/qlever-runtime-sdk/Dockerfile'])
        sources = re.findall(r'^COPY ((?:docker/|scripts/|\.dockerignore)\S*) \S+$', recipe, re.M)
        self.assertGreaterEqual(len(sources), 5)
        self.assertIn('.dockerignore', sources)
        for source in sources:
            self.assertIn('!' + source, self.rules)
            self.assertTrue((ROOT / source).is_file())

    def test_every_direct_service_docker_script_reference_has_an_exact_context_exception(self):
        dockerfile = (ROOT / 'Dockerfile').read_text()
        scripts = set(re.findall(r'(?:/app/)?(scripts/[A-Za-z0-9_./-]+\.(?:cjs|mjs|ts|js|py))', dockerfile))
        self.assertTrue(scripts)
        for source in scripts:
            with self.subTest(source=source):
                self.assertIn('!' + source, self.rules)
                self.assertTrue((ROOT / source).is_file())
        self.assertNotIn('!scripts/**', self.rules)
        self.assertNotIn('!scripts/', self.rules)

    def test_package_build_driver_and_nonbuiltin_dependency_sources_are_available(self):
        manifest = json.loads((ROOT / 'package.json').read_text())
        command = manifest['scripts']['build:packages']
        driver = 'scripts/build-afs-from-producer.ts'
        self.assertIn(driver, command); self.assertIn('!' + driver, self.rules)
        self.assertLess(command.index('--filter @undefineds.co/xpod-cli build &&'), command.index(driver))
        source = (ROOT / driver).read_text()
        imports = re.findall(r"^import .* from ['\"]([^'\"]+)['\"]", source, re.M)
        relatives = [name for name in imports if name.startswith('.')]
        self.assertTrue(relatives)
        for name in relatives:
            path = (ROOT / 'scripts' / name).resolve()
            self.assertTrue(path.is_relative_to(ROOT / 'packages'))
            self.assertTrue(path.with_suffix('.ts').is_file())
        self.assertIn('!packages/', self.rules)
        externals = [name for name in imports if not name.startswith(('.', 'node:'))]
        cli = json.loads((ROOT / 'packages/xpod-cli/package.json').read_text())
        self.assertEqual(externals, ['tar']); self.assertIn('tar', cli['devDependencies'])
        self.assertIn('ENV NODE_ENV=development', (ROOT / 'Dockerfile').read_text())
        runtime_edges = {
            'scripts/run-npm-pack.cjs': {'./service-pack-phase.cjs', './service-pack-originals.cjs'},
            'scripts/service-pack-phase.cjs': {'./lib/module-artifact-limits.json'},
            'scripts/service-pack-originals.cjs': {'./lib/module-artifact-limits.json'},
            'scripts/check-dependency-state.ts': set(),
        }
        for source, expected in runtime_edges.items():
            text = (ROOT / source).read_text()
            dependencies = runtime_dependency_specifiers(text)
            self.assertTrue(dependencies)
            self.assertEqual({name for name in dependencies if not name.startswith('node:')}, expected)
            for name in expected:
                target = (ROOT / source).parent / name
                self.assertTrue(target.resolve().is_relative_to(ROOT / 'scripts'))
                relative = target.resolve().relative_to(ROOT).as_posix()
                self.assertIn('!' + relative, self.rules)
                self.assertTrue(target.is_file())
        self.assertIn('!scripts/service-pack-parent.py', self.rules)
        self.assertIn('!scripts/agentfs-native-ci/supervise.py', self.rules)

    def test_builtin_gate_erases_only_type_imports_and_keeps_runtime_nonbuiltin_edges(self):
        source = "\n".join([
            "import type {Scope} from './erased-scope';",
            "import type Scope from './erased-default';",
            "import type /* runtime binding */, {x} from './runtime-comment-comma';",
            "import type, {x} from './runtime-default-comma';",
            "import type from './runtime-default-named-type';",
            "import {Scope} from './runtime-scope';",
            "import './runtime-side-effect';",
            "const helper = require('./runtime-required');",
            "import {readFileSync} from 'node:fs';",
        ])
        actual = runtime_dependency_specifiers(source)
        self.assertNotIn('./erased-scope', actual)
        self.assertNotIn('./erased-default', actual)
        for name in ['./runtime-comment-comma', './runtime-default-comma', './runtime-default-named-type', './runtime-scope', './runtime-side-effect', './runtime-required']:
            self.assertIn(name, actual)
            self.assertFalse(name.startswith('node:'))
        self.assertIn('node:fs', actual)

    def test_service_afs_notices_receive_the_original_root_license(self):
        # RC image build executes the AFS notice collector inside /app.
        collector = (ROOT / 'packages/xpod-afs/scripts/javascript-materials.ts').read_text()
        self.assertIn("path.join(options.repoRoot, 'LICENSE')", collector)
        self.assertIn('!LICENSE', self.rules)
        self.assertGreater((ROOT / 'LICENSE').stat().st_size, 0)
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertLess(dockerfile.index('COPY . .'), dockerfile.index('RUN bun run build:packages'))

    def test_host_python_cache_and_test_outputs_remain_excluded_after_all_exceptions(self):
        final_exception = max(index for index, rule in enumerate(self.rules) if rule.startswith('!'))
        for rule in ['**/__pycache__', '**/*.pyc', '**/*.pyo', '**/.pytest_cache', '**/.test-data']:
            self.assertIn(rule, self.rules)
            self.assertGreater(self.rules.index(rule), final_exception)
        self.assertIn('!qlever/', self.rules)
        self.assertIn('**/node_modules', self.rules)
        self.assertIn('**/dist', self.rules)


if __name__ == '__main__':
    unittest.main()
