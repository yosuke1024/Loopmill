// Two layers of defence against credentials reaching the store, per docs/design/mvp-design.md
// §13.4 ("Secrets in the record") and docs/spec/envelope.md §11.1 ("No secrets in envelopes"):
//
//  - `redact` is the persistence-time transform: every captured stream is run through it
//    before it is written to `.loopmill/logs/`, an envelope field or a report, replacing
//    credential-shaped substrings with a `***REDACTED***` marker (mvp-design.md §13.4: "for
//    `sk-ant-`, `oat01`, `sk-` patterns"; extended here to the GitHub token shapes, Bearer
//    tokens and JWTs already redacted by the spike harnesses this codebase inherits the
//    convention from — spikes/spike-1-claude-subscription/run.sh, spikes/spike-4-codex-cli/run.sh).
//  - `looksLikeCredential` is the schema-level backstop of docs/spec/envelope.md §11.1 / TV-5:
//    a narrow, boundary-aware predicate (docs/spec/envelope.schema.json `$defs.secretFree`)
//    that free-text envelope fields are checked against so an unredacted credential fails
//    validation loudly instead of being persisted.

// Boundary-aware: a credential shape only counts if it starts the string or is preceded by a
// character that cannot be part of an identifier (`[^A-Za-z0-9]`). This is exactly what keeps
// "the task-12345678901234567890 finished" and "briskly-1234567890123456789012" (TV-5,
// docs/spec/envelope.md §13) from tripping the `sk-` pattern: the "sk-" substring inside
// "task-" and the "sk" inside "briskly" are not preceded by a boundary.
const CREDENTIAL_SHAPE =
  "(sk-ant-[A-Za-z0-9_-]{6,}" +
  "|sk-[A-Za-z0-9]{20,}" +
  "|oat01[A-Za-z0-9_-]{6,}" +
  "|gh[pousr]_[A-Za-z0-9]{20,}" +
  "|github_pat_[A-Za-z0-9_]{20,}" +
  "|xox[abprs]-[A-Za-z0-9-]{10,}" +
  "|AKIA[0-9A-Z]{16})";

const LOOKS_LIKE_CREDENTIAL_RE = new RegExp(
  `(^|[^A-Za-z0-9])${CREDENTIAL_SHAPE}|-----BEGIN [A-Z ]*PRIVATE KEY-----`,
);

/**
 * The boundary-aware credential-shape backstop of `envelope.schema.json`'s `secretFree` $def
 * (docs/spec/envelope.md §11.1, test vector TV-5). Deliberately narrow: it exists to catch an
 * unredacted credential that slipped past `redact`, not to flag ordinary prose that merely
 * contains digits or the letters "sk".
 */
export function looksLikeCredential(s: string): boolean {
  return LOOKS_LIKE_CREDENTIAL_RE.test(s);
}

const REDACTED = "***REDACTED***";

// Same boundary rule as `looksLikeCredential`, plus the shapes the spike harnesses already
// redact that the schema backstop does not need to name individually: `Bearer <token>` and
// JSON Web Tokens (docs/design/mvp-design.md §13.4; spikes/spike-1-claude-subscription/run.sh;
// spikes/spike-4-codex-cli/run.sh, d9/probe.sh).
const REDACT_RE = new RegExp(
  "(^|[^A-Za-z0-9])(?:" +
    "(?<antKey>sk-ant-[A-Za-z0-9_-]{6,})" +
    "|(?<oatToken>oat01-?[A-Za-z0-9_-]{6,})" +
    "|(?<genericSk>sk-[A-Za-z0-9_-]{10,})" +
    "|(?<ghToken>gh[pousr]_[A-Za-z0-9]{20,})" +
    "|(?<ghPat>github_pat_[A-Za-z0-9_]{20,})" +
    "|(?<awsKey>AKIA[0-9A-Z]{16})" +
    "|(?<slackToken>xox[abprs]-[A-Za-z0-9-]{10,})" +
    "|(?<bearer>Bearer [A-Za-z0-9._-]{20,})" +
    "|(?<jwt>eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})" +
    ")",
  "g",
);

/**
 * Persistence-time redaction: replaces every credential-shaped substring of `s` with a
 * `***REDACTED***` marker, preserving a short recognisable prefix where the spike-harness
 * convention already did (`sk-ant-`, `oat01-`, `sk-`, `Bearer `). Ordinary prose — including
 * strings that merely resemble the boundary condition, per TV-5 — passes through unchanged.
 */
export function redact(s: string): string {
  return s.replace(REDACT_RE, (...args: unknown[]) => {
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    const boundary = args[1] as string;
    if (groups.antKey) return `${boundary}sk-ant-${REDACTED}`;
    if (groups.oatToken) return `${boundary}oat01-${REDACTED}`;
    if (groups.genericSk) return `${boundary}sk-${REDACTED}`;
    if (groups.bearer) return `${boundary}Bearer ${REDACTED}`;
    // ghToken, ghPat, awsKey, slackToken, jwt: no meaningful prefix worth keeping.
    return `${boundary}${REDACTED}`;
  });
}
