# Documentation-only Terra remediation

Repo: /Users/fishhead/.workspace/projects/nutrition-mcp
HEAD: 86ae20b1c003f94fa70f4c6b215fc176cf1a70d7

Reviewer-terra found the remaining blocker: README still contains materially false operational instructions for the current runtime, including Supabase deployment/credentials/migrations, OAuth setup, email/password authentication, and OAuth endpoints. The new food-tracking section is accurate, but stale sections contradict the actual local PostgreSQL/no-auth runtime.

## Task

1. Read current code, CLAUDE.md, README.md, .env.example and existing migration/operator docs.
2. Update only operator-facing documentation needed to make README truthful for the current implementation:
    - local PostgreSQL/Bun runtime and DATABASE_URL;
    - no Supabase/OAuth/email-password setup in this runtime;
    - migration application semantics (`001` then `002`, with 002 destructive legacy meal reset);
    - actual MCP endpoint/start command and test commands;
    - DATABASE_URL_TEST and MEDIA_ROOT;
    - food-tracking limits: no real MFP writer, no automatic backup scheduler/cloud in this slice.
3. Remove or clearly mark stale historical Supabase/OAuth instructions. Do not leave operators likely to follow them.
4. Do not modify production code, tests, plan files, or unrelated pre-existing source formatting.
5. Run full verification with DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test:
    - bun test
    - bun run typecheck
    - feature/docs Prettier check; full format may still flag unrelated pre-existing files
    - git diff --check
6. Commit focused docs fix and report SHA, exact checks, and any remaining known pre-existing format failures.
