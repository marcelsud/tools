#!/usr/bin/env bash
# Recreate the verification fixture: a git repo whose HEAD commit introduces three
# known bugs. Both bundled workflows are verified against it, so their expected
# output is only meaningful if the fixture is exactly this.
#
#   scripts/demo-repo.sh [dir]     # default /tmp/wf-demo
set -euo pipefail

DIR="${1:-/tmp/wf-demo}"
rm -rf "$DIR"
mkdir -p "$DIR/src"
cd "$DIR"
git init -q
git config user.email demo@example.com
git config user.name "wf demo"

printf '{ "name": "wf-demo", "private": true, "type": "module" }\n' > package.json

cat > src/cart.js <<'BASELINE'
export function subtotal(items) {
	let total = 0;
	for (const item of items) {
		total += item.price * item.qty;
	}
	return total;
}

export function applyDiscount(total, percent) {
	return total * (1 - percent / 100);
}
BASELINE

git add -A
git commit -qm baseline

cat > src/cart.js <<'BUGGY'
export function subtotal(items) {
	let total = 0;
	// BUG: skips the last item — should be `i < items.length`.
	for (let i = 0; i < items.length - 1; i++) {
		total += items[i].price * items[i].qty;
	}
	return total;
}

export function applyDiscount(total, percent) {
	// BUG: no bounds check — percent > 100 yields a negative total.
	return total * (1 - percent / 100);
}

export function checkout(items, percent) {
	// BUG: JSON.parse can throw and nothing handles it.
	const coupon = JSON.parse(process.env.COUPON);
	return applyDiscount(subtotal(items), percent + coupon.bonus);
}
BUGGY

git add -A
git commit -qm "cart changes"

echo "fixture ready at $DIR (HEAD~1...HEAD introduces 3 bugs, tree clean)"
