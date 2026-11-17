# Security reports and integration boundaries

This is an experimental developer preview. There is no supported production release or security-response SLA. Pin the app, gateway, workers, contracts and SDK to the same source revision; a matching `0.1.4` display version alone does not establish compatibility.

Do not post credentials, screenshots of private data, exploit payloads containing real data, or complete logs in a public issue. Use GitHub's private vulnerability reporting **if enabled** for this repository. If unavailable, ask the maintainer for a private reporting channel without including vulnerability details. No private email address is advertised here.

For local testing use the managed preview's loopback services and synthetic data. Development sign-in is not production authentication. Model output and generated HTML are untrusted content. Review documents before use; never execute generated commands or publish output automatically.

See [integration contract](docs/INTEGRATION.md), [computer-use boundaries](docs/COMPUTER_VISION.md), and [acceptance evidence](docs/quality/acceptance.md). External sends require execution-layer authorization; a UI confirmation or an SDK idempotency key is not a blanket exactly-once guarantee for third-party services.
