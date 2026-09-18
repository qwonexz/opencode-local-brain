// Secret detection for brain inputs. Blocklist (best-effort): reduces
// accidents but cannot catch every obfuscation. Callers must still eyeball
// what they store. Shared by the core API and the migration script.

const SECRET_PATTERNS = [
  /api[\s_-]*hash/i,
  /api[\s_-]*id/i,
  /api[\s_-]*ke+y/i,
  /bot[\s_-]*token/i,
  /auth[\s_-]*token/i,
  /access[\s_-]*token/i,
  /private[\s_-]*key/i,
  /mnemonic|seed[\s_-]*phrase/i,
  /passwd|pwd|passwords?/i,
  /secrets?/i,
  /(^|[\s_.=:|-])tokens?([\s_.=:|-]|s\b|$)/i,
  /токены?/i,
  /секреты?/i,
  /пароли?/i,
  /gh[pous]_[A-Za-z0-9]+/,
  /glpat-[A-Za-z0-9_]+/,
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9]{16,}/,
  /xox[bpas]-/i,
  /[=:]\s*[A-Za-z0-9_\-+/]{20,}/, // KEY=... / id:... high-entropy values
];

export function isSecretLike(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** Throw if the text looks like a credential. The brain must never store secrets. */
export function assertNoSecrets(text: string, field: string): void {
  if (isSecretLike(text)) {
    throw new Error(
      `${field} looks like a secret or credential and was rejected. ` +
        `The brain stores facts, never tokens/passwords/keys.`
    );
  }
}
