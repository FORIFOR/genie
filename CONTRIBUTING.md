# Contributing to Genie

Start with a reproducible issue or a small workflow proposal. Please discuss larger changes before writing them, especially changes to permissions, external transmission, model routing, or the native interface.

Use synthetic data in examples, screenshots, and recordings. Do not include credentials, account exports, private meetings, or other people's messages. For a security issue, use GitHub's private vulnerability reporting if available; do not disclose an exploitable issue in a public ticket.

For UI work, read `AGENTS.md`, `shared/design/DESIGN.md`, `docs/DESIGN_SYSTEM.md`, and `shared/design/tokens.json`. Record the required reference/hypothesis/measured/candidates/gate round, regenerate affected goldens and geometry, and run `scripts/verify-all.sh` before committing. Do not hand-edit generated tokens.

For other changes, run the relevant tests and describe the actual validation and remaining limitations in the PR. Do not mark untested behavior as passed, remove a release gate to make it green, or introduce automatic paid retries.

First-party project code is licensed under [MIT](LICENSE). Submit only code you have the right to contribute under those terms. Keep third-party notices and dependency licenses intact. See [SECURITY.md](SECURITY.md) for sensitive reports and [the integration contract](docs/INTEGRATION.md) for compatibility boundaries.
