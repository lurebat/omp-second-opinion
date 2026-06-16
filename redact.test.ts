// Tests for scanSecrets and redactSecrets exported from core.ts.
//
// Key invariant: redactSecrets handles MEDIUM-confidence patterns only
// (password/api-key/client-secret/token assignments). HIGH-confidence
// patterns (AWS keys, GitHub PATs, JWTs, PEM blocks, OpenAI keys, Slack
// tokens) are detected by scanSecrets but intentionally left untouched by
// redactSecrets — the caller decides whether to block the review instead.
//
// No network, no live models, no OMP runtime required.

import { describe, expect, test } from "bun:test";
import { redactSecrets, scanSecrets } from "./core";
import type { SecretScanResult } from "./core";

// ── Fixtures ─────────────────────────────────────────────────────────────────

// High-confidence samples (scanned, NOT redacted)
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE"; // AKIA + 16 uppercase/digit chars
const GITHUB_PAT = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234"; // ghp_ + 36 chars
const OPENAI_KEY = "sk-" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"; // sk- + ≥20 chars
const SLACK_TOKEN = "xoxb-" + "111222333-444555666-abcdefghijklmnopqr"; // xoxb-N-N-alphanum
const PEM_HEADER = "-----BEGIN RSA PRIVATE KEY-----";
const JWT = "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiJ0ZXN0In0" + ".SflKxwRJSMeKKF2QT4fwpMeJf36P";

// Medium-confidence samples (both scanned AND redacted)
const PASSWORD_ASSIGN = "password=reallysecure123"; // passwd/password key
const PASSWD_ASSIGN = "passwd=reallysecure123";
const API_KEY_ASSIGN = "api_key=abcdefghijklmn"; // ≥8 chars
const CLIENT_SECRET_ASSIGN = "client_secret=supersecretstuff";
const ACCESS_TOKEN_ASSIGN = "access_token=myaccesstoken12";
const AUTH_TOKEN_ASSIGN = "auth_token=myauthtoken12345";
const BEARER_TOKEN_ASSIGN = "bearer_token=mybearertoken1";
const REFRESH_TOKEN_ASSIGN = "refresh_token=myrefreshtoken1";

// ---------------------------------------------------------------------------
// scanSecrets
// ---------------------------------------------------------------------------

describe("scanSecrets", () => {
	// --- high-confidence detection ---

	test("detects AWS access key (high)", () => {
		const result = scanSecrets(`key=${AWS_KEY}`);
		expect(result.hasHigh).toBe(true);
		expect(result.matches.some(m => m.kind === "aws-access-key" && m.confidence === "high")).toBe(true);
	});

	test("detects GitHub PAT ghp_ (high)", () => {
		const result = scanSecrets(`token=${GITHUB_PAT}`);
		expect(result.hasHigh).toBe(true);
		expect(result.matches.some(m => m.kind === "github-token")).toBe(true);
	});

	test("detects GitHub fine-grained PAT (high)", () => {
		const result = scanSecrets("github_pat_11ABCDEF0123456789_abcdefghijklmnopqrstuvwxyz0123456789");
		expect(result.hasHigh).toBe(true);
		expect(result.matches.some(m => m.kind === "github-pat")).toBe(true);
	});

	test("detects OpenAI sk- key (high)", () => {
		const result = scanSecrets(`api_key=${OPENAI_KEY}`);
		expect(result.hasHigh).toBe(true);
		expect(result.matches.some(m => m.kind === "openai-key")).toBe(true);
	});

	test("detects Slack token (high)", () => {
		const result = scanSecrets(SLACK_TOKEN);
		expect(result.hasHigh).toBe(true);
		expect(result.matches.some(m => m.kind === "slack-token")).toBe(true);
	});

	test("detects PEM private key header (high)", () => {
		const result = scanSecrets(PEM_HEADER);
		expect(result.hasHigh).toBe(true);
		expect(result.matches.some(m => m.kind === "private-key")).toBe(true);
	});

	test("detects JWT token (high)", () => {
		const result = scanSecrets(JWT);
		expect(result.hasHigh).toBe(true);
		expect(result.matches.some(m => m.kind === "jwt")).toBe(true);
	});

	// --- medium-confidence detection ---

	test("detects password assignment (medium)", () => {
		const result = scanSecrets(PASSWORD_ASSIGN);
		expect(result.hasMedium).toBe(true);
		expect(result.matches.some(m => m.kind === "password-assignment" && m.confidence === "medium")).toBe(true);
	});

	test("detects api_key assignment (medium)", () => {
		const result = scanSecrets(API_KEY_ASSIGN);
		expect(result.hasMedium).toBe(true);
		expect(result.matches.some(m => m.kind === "api-key-assignment")).toBe(true);
	});

	test("detects client_secret assignment (medium)", () => {
		const result = scanSecrets(CLIENT_SECRET_ASSIGN);
		expect(result.hasMedium).toBe(true);
		expect(result.matches.some(m => m.kind === "client-secret-assignment")).toBe(true);
	});

	test("detects access_token assignment (medium)", () => {
		const result = scanSecrets(ACCESS_TOKEN_ASSIGN);
		expect(result.hasMedium).toBe(true);
		expect(result.matches.some(m => m.kind === "token-assignment")).toBe(true);
	});

	// --- clean input ---

	test("returns empty matches for clean text", () => {
		const result = scanSecrets("const x = 42; // no secrets here");
		expect(result.matches).toHaveLength(0);
		expect(result.hasHigh).toBe(false);
		expect(result.hasMedium).toBe(false);
	});

	test("returns empty matches for empty string", () => {
		const result = scanSecrets("");
		expect(result.matches).toHaveLength(0);
	});

	// --- deduplication ---

	test("deduplicates multiple occurrences of the same kind", () => {
		// Two AWS keys in the same text → single entry for aws-access-key
		const text = `first=${AWS_KEY} second=${"AKIA" + "IOSFODNN7EXAMPLF"}`;
		const result = scanSecrets(text);
		const awsMatches = result.matches.filter(m => m.kind === "aws-access-key");
		expect(awsMatches).toHaveLength(1);
	});

	// --- mixed high + medium ---

	test("sets both hasHigh and hasMedium when both are present", () => {
		const text = `${AWS_KEY} and ${PASSWORD_ASSIGN}`;
		const result = scanSecrets(text);
		expect(result.hasHigh).toBe(true);
		expect(result.hasMedium).toBe(true);
	});

	// --- values never surfaced ---

	test("matched values are never included in the result", () => {
		const result = scanSecrets(PASSWORD_ASSIGN);
		const json = JSON.stringify(result);
		// "reallysecure123" must not appear anywhere in the serialised output
		expect(json).not.toContain("reallysecure123");
	});
});

// ---------------------------------------------------------------------------
// redactSecrets — medium-confidence patterns only
// ---------------------------------------------------------------------------

describe("redactSecrets", () => {
	// --- medium patterns are redacted ---

	test("redacts password= assignment, preserving the key", () => {
		const result = redactSecrets(PASSWORD_ASSIGN);
		expect(result).not.toContain("reallysecure123");
		expect(result).toContain("password=");
		expect(result).toContain("[REDACTED]");
	});

	test("redacts passwd= assignment", () => {
		const result = redactSecrets(PASSWD_ASSIGN);
		expect(result).not.toContain("reallysecure123");
		expect(result).toContain("[REDACTED]");
	});

	test("redacts api_key= assignment", () => {
		const result = redactSecrets(API_KEY_ASSIGN);
		expect(result).not.toContain("abcdefghijklmn");
		expect(result).toContain("api_key=");
		expect(result).toContain("[REDACTED]");
	});

	test("redacts client_secret= assignment", () => {
		const result = redactSecrets(CLIENT_SECRET_ASSIGN);
		expect(result).not.toContain("supersecretstuff");
		expect(result).toContain("client_secret=");
		expect(result).toContain("[REDACTED]");
	});

	test("redacts access_token= assignment", () => {
		const result = redactSecrets(ACCESS_TOKEN_ASSIGN);
		expect(result).not.toContain("myaccesstoken12");
		expect(result).toContain("access_token=");
		expect(result).toContain("[REDACTED]");
	});

	test("redacts auth_token, bearer_token, refresh_token assignments", () => {
		expect(redactSecrets(AUTH_TOKEN_ASSIGN)).toContain("[REDACTED]");
		expect(redactSecrets(BEARER_TOKEN_ASSIGN)).toContain("[REDACTED]");
		expect(redactSecrets(REFRESH_TOKEN_ASSIGN)).toContain("[REDACTED]");
	});

	test("is case-insensitive for key names", () => {
		expect(redactSecrets("PASSWORD=reallysecure123")).toContain("[REDACTED]");
		expect(redactSecrets("API_KEY=abcdefghijklmn")).toContain("[REDACTED]");
	});

	test("redacts quoted values with spaces as one value", () => {
		const result = redactSecrets('password="my secret phrase" suffix');
		expect(result).toBe("password=[REDACTED] suffix");
	});

	// --- high-confidence patterns are NOT redacted ---

	test("does NOT redact AWS access key IDs (high-confidence; caller blocks)", () => {
		const result = redactSecrets(`key=${AWS_KEY}`);
		expect(result).toContain(AWS_KEY);
	});

	test("does NOT redact GitHub PATs (high-confidence)", () => {
		const result = redactSecrets(`token=${GITHUB_PAT}`);
		expect(result).toContain(GITHUB_PAT);
	});

	test("does NOT redact OpenAI sk- keys (high-confidence)", () => {
		const result = redactSecrets(`key=${OPENAI_KEY}`);
		expect(result).toContain(OPENAI_KEY);
	});

	test("does NOT redact PEM private key headers (high-confidence)", () => {
		const result = redactSecrets(PEM_HEADER);
		expect(result).toContain(PEM_HEADER);
	});

	test("does NOT redact JWTs (high-confidence)", () => {
		const result = redactSecrets(JWT);
		expect(result).toContain(JWT);
	});

	// --- placeholder exclusions (false-positive guards) ---

	test("does not redact password=null placeholder", () => {
		const input = "password=null";
		expect(redactSecrets(input)).toBe(input);
	});

	test("does not redact password=undefined placeholder", () => {
		const input = "password=undefined";
		expect(redactSecrets(input)).toBe(input);
	});

	test("does not redact password=${SECRET} template placeholder", () => {
		const input = "password=${SECRET}";
		expect(redactSecrets(input)).toBe(input);
	});

	test("does not redact password=<your_password_here> placeholder", () => {
		const input = "password=<your_password_here>";
		expect(redactSecrets(input)).toBe(input);
	});

	// --- value length threshold ---

	test("does not redact short values (< 8 chars)", () => {
		// "short" is 5 chars — below the minimum threshold
		const input = "password=short";
		expect(redactSecrets(input)).toBe(input);
	});

	// --- structural invariants ---

	test("returns clean text unchanged", () => {
		const clean = "const x = 42;\nreturn x;";
		expect(redactSecrets(clean)).toBe(clean);
	});

	test("handles empty string", () => {
		expect(redactSecrets("")).toBe("");
	});

	test("is idempotent — redacting already-redacted text is stable", () => {
		const once = redactSecrets(PASSWORD_ASSIGN);
		expect(redactSecrets(once)).toBe(once);
	});

	test("does not mutate text beyond the matched region", () => {
		const input = `prefix ${PASSWORD_ASSIGN} suffix`;
		const result = redactSecrets(input);
		expect(result).toContain("prefix");
		expect(result).toContain("suffix");
	});
});
