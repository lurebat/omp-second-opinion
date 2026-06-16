// Tests for hashMaterial, isStaleHash, globToRegExp, and matchesAnyGlob
// exported from core.ts by DiffHash.
// isStaleHash will fail at import until DiffHash's in-flight edit lands.
// No network, no live models, no OMP runtime required.

import { describe, expect, test } from "bun:test";
import { globToRegExp, hashMaterial, isStaleHash, matchesAnyGlob } from "./core";

// ---------------------------------------------------------------------------
// hashMaterial
// ---------------------------------------------------------------------------

describe("hashMaterial", () => {
	test("returns exactly 8 lowercase hex characters (FNV-1a 32-bit)", () => {
		expect(hashMaterial(["hello"])).toMatch(/^[0-9a-f]{8}$/);
	});

	test("is deterministic — same parts always produce the same hash", () => {
		const parts = ["diff --git a/src/foo.ts", "+added line\n"];
		expect(hashMaterial(parts)).toBe(hashMaterial(parts));
	});

	test("different part arrays produce different hashes", () => {
		expect(hashMaterial(["a"])).not.toBe(hashMaterial(["b"]));
		expect(hashMaterial(["a", "b"])).not.toBe(hashMaterial(["b", "a"]));
	});

	test("order of parts matters", () => {
		expect(hashMaterial(["first", "second"])).not.toBe(hashMaterial(["second", "first"]));
	});

	test("undefined parts are treated the same as empty strings", () => {
		expect(hashMaterial([undefined])).toBe(hashMaterial([""]));
		expect(hashMaterial(["x", undefined, "y"])).toBe(hashMaterial(["x", "", "y"]));
	});

	test("concatenated single part differs from two separate parts", () => {
		// The sentinel byte between parts prevents 'ab' === ['a','b']
		expect(hashMaterial(["ab"])).not.toBe(hashMaterial(["a", "b"]));
	});

	test("empty array produces a valid 8-hex hash", () => {
		expect(hashMaterial([])).toMatch(/^[0-9a-f]{8}$/);
	});

	test("large input still returns exactly 8 hex chars", () => {
		expect(hashMaterial(["x".repeat(100_000)])).toMatch(/^[0-9a-f]{8}$/);
	});

	test("multi-element arrays return consistent 8 hex chars", () => {
		expect(hashMaterial(["scope:transcript", "reviewer:openai/gpt-4o", "diff-hash:00000000"])).toMatch(
			/^[0-9a-f]{8}$/,
		);
	});
});

// ---------------------------------------------------------------------------
// isStaleHash
// ---------------------------------------------------------------------------

describe("isStaleHash", () => {
	test("returns 'current' when stored hash matches current hash", () => {
		const h = hashMaterial(["same content"]);
		expect(isStaleHash(h, h)).toBe("current");
	});

	test("returns 'changed' when stored hash differs from current hash", () => {
		const stored = hashMaterial(["old content"]);
		const current = hashMaterial(["new content"]);
		expect(isStaleHash(stored, current)).toBe("changed");
	});

	test("returns 'unknown' when stored is undefined (no prior run)", () => {
		const current = hashMaterial(["some content"]);
		expect(isStaleHash(undefined, current)).toBe("unknown");
	});

	test("is consistent with hashMaterial for identical inputs", () => {
		const text = "const x = 1;\n";
		expect(isStaleHash(hashMaterial([text]), hashMaterial([text]))).toBe("current");
	});

	test("detects a change between two distinct hashMaterial results", () => {
		expect(isStaleHash(hashMaterial(["v1"]), hashMaterial(["v2"]))).toBe("changed");
	});
});

// ---------------------------------------------------------------------------
// globToRegExp
// ---------------------------------------------------------------------------

describe("globToRegExp", () => {
	test("matches exact literal paths", () => {
		expect(globToRegExp("src/foo.ts").test("src/foo.ts")).toBe(true);
		expect(globToRegExp("src/foo.ts").test("src/bar.ts")).toBe(false);
	});

	test("* matches within a single path segment (no slash)", () => {
		const re = globToRegExp("src/*.ts");
		expect(re.test("src/foo.ts")).toBe(true);
		expect(re.test("src/bar.ts")).toBe(true);
		expect(re.test("src/sub/foo.ts")).toBe(false); // * does not cross /
	});

	test("** matches across path segments", () => {
		const re = globToRegExp("src/**/*.ts");
		expect(re.test("src/foo.ts")).toBe(true);
		expect(re.test("src/sub/foo.ts")).toBe(true);
		expect(re.test("src/a/b/c/foo.ts")).toBe(true);
		expect(re.test("lib/foo.ts")).toBe(false);
	});

	test("? matches exactly one non-slash character", () => {
		const re = globToRegExp("src/fo?.ts");
		expect(re.test("src/foo.ts")).toBe(true);
		expect(re.test("src/fo.ts")).toBe(false); // ? requires exactly one char
		expect(re.test("src/fooo.ts")).toBe(false);
		expect(re.test("src/fo/.ts")).toBe(false); // ? does not match slash
	});

	test("regex special characters in path are escaped", () => {
		const re = globToRegExp("src/foo.ts"); // dot is literal in glob
		expect(re.test("src/fooXts")).toBe(false); // dot is NOT a regex wildcard
	});

	test("produces an anchored regex (full path match, not substring)", () => {
		const re = globToRegExp("foo.ts");
		expect(re.test("foo.ts")).toBe(true);
		expect(re.test("prefix/foo.ts")).toBe(false); // anchored at start
		expect(re.test("foo.tsx")).toBe(false); // anchored at end
	});
});

// ---------------------------------------------------------------------------
// matchesAnyGlob
// ---------------------------------------------------------------------------

describe("matchesAnyGlob", () => {
	test("returns false for empty globs array", () => {
		expect(matchesAnyGlob("src/foo.ts", [])).toBe(false);
	});

	test("returns false for undefined globs", () => {
		expect(matchesAnyGlob("src/foo.ts", undefined)).toBe(false);
	});

	test("returns true when path matches one of the globs", () => {
		expect(matchesAnyGlob("src/foo.ts", ["src/*.ts", "lib/*.ts"])).toBe(true);
	});

	test("returns false when path matches none of the globs", () => {
		expect(matchesAnyGlob("test/foo.spec.ts", ["src/*.ts", "lib/*.ts"])).toBe(false);
	});

	test("normalises Windows backslashes before matching", () => {
		expect(matchesAnyGlob("src\\foo.ts", ["src/*.ts"])).toBe(true);
	});

	test("single ** glob matches nested paths", () => {
		expect(matchesAnyGlob("src/a/b/c.ts", ["**/*.ts"])).toBe(true);
	});

	test("returns true on first matching glob (short-circuits)", () => {
		// Both globs match; function must not throw or return duplicate results
		expect(matchesAnyGlob("src/foo.ts", ["src/foo.ts", "src/*.ts"])).toBe(true);
	});
});
