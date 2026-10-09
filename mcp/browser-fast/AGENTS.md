# browser-fast Agent Rules

These rules apply to every change under this directory.

1. Never retry a browser mutation from the same prediction.
2. Pass every selected action through policy before execution.
3. Never treat Jev `DONE` alone as success.
4. Always run the independent verifier against a fresh observation.
5. Never log credentials, cookies, authorization headers, or sensitive field values.
6. Keep screenshots disabled by default and do not use `record_dir` for normal traces.
7. Do not add site-specific action scripts.
8. Do not let a model generate selectors.
9. Do not execute arbitrary model-generated JavaScript.
10. Keep upstream Jev changes at zero or strictly minimal; prefer this adapter.
11. Pin the exact upstream Jev commit and keep `UPSTREAM.lock` synchronized.
12. Financial transactions are forbidden in Phase 1.
13. Login and authentication workflows are forbidden in Phase 1.
14. Tests must not call paid APIs.
15. Do not commit or push without the user's explicit instruction.
