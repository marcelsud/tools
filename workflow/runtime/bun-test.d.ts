/** Minimal ambient types so host.test.ts typechecks without a bun-types dependency. */
declare module "bun:test" {
	export function describe(name: string, fn: () => void): void;
	export function test(name: string, fn: () => void | Promise<void>): void;
	export function beforeAll(fn: () => void | Promise<void>): void;
	export function afterAll(fn: () => void | Promise<void>): void;
	export function expect(actual: unknown): {
		toBe(expected: unknown): void;
		toContain(expected: unknown): void;
		toHaveLength(expected: number): void;
		toBeLessThan(expected: number): void;
	};
}
