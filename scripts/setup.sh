#!/usr/bin/env bash
# Link this checkout against the omp package you already have installed.
#
# The tools import `@oh-my-pi/pi-coding-agent` for types and for the subagent
# executor. Rather than install a second copy, point node_modules at the same
# package the `omp` on your PATH runs from — so the tools always typecheck
# against the runtime that will actually load them.
set -euo pipefail

cd "$(dirname "$0")/.."

OMP_BIN="$(command -v omp || true)"
if [[ -z "$OMP_BIN" ]]; then
	echo "error: 'omp' is not on your PATH. Install it first: bun add -g @oh-my-pi/pi-coding-agent" >&2
	exit 1
fi

# <pkg>/dist/cli.js -> <pkg>
PKG_DIR="$(dirname "$(dirname "$(readlink -f "$OMP_BIN")")")"
SCOPE_DIR="$(dirname "$PKG_DIR")"

if [[ ! -f "$PKG_DIR/package.json" ]]; then
	echo "error: could not resolve the omp package from $OMP_BIN (looked at $PKG_DIR)" >&2
	exit 1
fi

mkdir -p node_modules/@oh-my-pi
for pkg in pi-coding-agent pi-agent-core pi-utils pi-natives pi-wire; do
	if [[ -d "$SCOPE_DIR/$pkg" ]]; then
		ln -sfn "$SCOPE_DIR/$pkg" "node_modules/@oh-my-pi/$pkg"
	fi
done

echo "linked node_modules/@oh-my-pi -> $SCOPE_DIR"
echo "next: bunx tsc --noEmit -p tsconfig.json"
