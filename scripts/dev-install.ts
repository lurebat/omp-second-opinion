#!/usr/bin/env bun
/**
 * dev-install.ts — link the extension source tree into the OMP extensions
 * directory so edits take effect without reinstalling.
 *
 * On Windows a directory junction is used (no elevation required). On
 * Unix/macOS a directory symlink is used. If either fails the script falls
 * back to a plain file copy with a warning (e.g. cross-volume or restricted FS).
 *
 * Usage:
 *   bun scripts/dev-install.ts               # install (skip if already linked)
 *   bun scripts/dev-install.ts --force       # remove existing then reinstall
 *   bun scripts/dev-install.ts --uninstall   # remove the installed extension
 */

import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Extension source root — one level above this scripts/ directory.
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// OMP user-level auto-load extensions directory.
const EXT_DIR = join(homedir(), ".omp", "agent", "extensions", "second-opinion");

// Files copied when junction/symlink is unavailable.
const COPY_FILES = [
	"index.ts",
	"core.ts",
	"prompts.ts",
	"types.ts",
	"package.json",
	"README.md",
	"LICENSE",
] as const;

/**
 * Attempt to create a junction (Windows) or directory symlink (Unix/macOS).
 * Returns true on success, false if the OS rejects the operation.
 */
function tryLink(src: string, dest: string): boolean {
	// 'junction' works without elevation on Windows and automatically makes
	// the path absolute. On non-Windows platforms Bun/Node ignores the type
	// and creates a regular symlink.
	const type = process.platform === "win32" ? "junction" : "dir";
	try {
		symlinkSync(src, dest, type);
		return true;
	} catch {
		return false;
	}
}

function copyInstall(src: string, dest: string): void {
	mkdirSync(dest, { recursive: true });
	let n = 0;
	for (const file of COPY_FILES) {
		const s = join(src, file);
		if (existsSync(s)) {
			copyFileSync(s, join(dest, file));
			n++;
		}
	}
	console.log(`  Copied ${n} file(s) → ${dest}`);
	console.warn("  Note: source changes will NOT be reflected automatically — re-run to update.");
}

function main(): void {
	const argv = process.argv.slice(2);
	const force = argv.includes("--force");
	const uninstall = argv.includes("--uninstall");

	if (uninstall) {
		if (!existsSync(EXT_DIR)) {
			console.log("Not installed — nothing to remove.");
			return;
		}
		rmSync(EXT_DIR, { recursive: true, force: true });
		console.log(`Removed ${EXT_DIR}`);
		return;
	}

	if (existsSync(EXT_DIR)) {
		let linked = false;
		try { linked = lstatSync(EXT_DIR).isSymbolicLink(); } catch { /* not a link */ }
		if (!force) {
			const kind = linked ? "linked" : "copied";
			console.log(`Already installed (${kind}): ${EXT_DIR}`);
			console.log("Pass --force to reinstall.");
			process.exit(0);
		}
		rmSync(EXT_DIR, { recursive: true, force: true });
		console.log(`Removed existing install at ${EXT_DIR}`);
	}

	mkdirSync(dirname(EXT_DIR), { recursive: true });
	console.log(`Source : ${SRC_DIR}`);
	console.log(`Target : ${EXT_DIR}`);

	if (tryLink(SRC_DIR, EXT_DIR)) {
		const kind = process.platform === "win32" ? "junction" : "symlink";
		console.log(`Linked via ${kind}. Live edits in source are reflected immediately.`);
	} else {
		console.warn("Junction/symlink unavailable — falling back to file copy.");
		copyInstall(SRC_DIR, EXT_DIR);
	}

	console.log("Done.");
}

main();
