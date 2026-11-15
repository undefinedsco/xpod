"""Verify the pinned QLever runtime artifact identity from retained API metadata.

DIAGNOSTIC_NOT_QUALIFICATION: this checks the immutable identity BEFORE the
original bytes are extracted. The archive's inner file manifest is validated by
the existing desktop build, not re-implemented here.
"""
import json
import sys

EXPECTED = {
    'name': 'qlever-local-runtime-darwin-arm64-021c809886629624934826f4aacf87ff59326932',
    'digest': 'sha256:92710334875497ba29bf1995ba75af6b0eae23dee0e198f9b493e5d852fc3ca6',
    'expired': False,
}
RUN = '43148129183'
SOURCE = '021c809886629624934826f4aacf87ff59326932'


def main(path: str) -> int:
    meta = json.load(open(path))
    for key, value in EXPECTED.items():
        if meta.get(key) != value:
            print(f'QLever artifact {key} differs from the pinned identity: {meta.get(key)!r}', file=sys.stderr)
            return 1
    run = meta.get('workflow_run') or {}
    if str(run.get('id')) != RUN:
        print(f"QLever artifact run differs: {run.get('id')!r}", file=sys.stderr)
        return 1
    if str(run.get('head_sha')) != SOURCE:
        print(f"QLever artifact source differs: {run.get('head_sha')!r}", file=sys.stderr)
        return 1
    print('QLever artifact identity verified')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1]))
