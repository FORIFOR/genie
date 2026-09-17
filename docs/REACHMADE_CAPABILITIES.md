# Reachmade Capability Protocol

Genie can treat other Reachmade products as capabilities instead of asking the user to switch applications manually.

The first connected products are:

- **Agent Team** — request → draft/research/build → review/revision → immutable artifacts and run evidence.
- **Launchloom** — product brief/campaign → local pre-publish launch assets → explicit storyboard review gate → finished launch kit.

The contract is deliberately evidence-first:

```text
Intent → Route → Plan → Execute → Artifact + Evidence
```

A capability may not return `completed` or `partial` without an Evidence Envelope. A timeout is `unknown`, never success.

## Local configuration

Nothing is connected by default. Start the products locally and configure their actual URLs:

```dotenv
REACHMADE_AGENT_TEAM_URL=http://127.0.0.1:8787
REACHMADE_LAUNCHLOOM_URL=http://127.0.0.1:8788
REACHMADE_LAUNCHLOOM_TOKEN=<the token printed by Launchloom>
```

Both products normally use loopback-only local servers. If you deliberately connect a remote deployment, additionally set:

```dotenv
REACHMADE_ALLOW_REMOTE_CAPABILITIES=true
```

Remote endpoints are rejected without that opt-in. Credentials must be supplied through the environment, never request bodies.

## Genie API

All routes are behind the existing Genie authentication middleware.

### Discover

```http
GET /v1/reachmade/capabilities
```

### Route one intent

```http
POST /v1/reachmade/route
Content-Type: application/json

{
  "id": "work-42",
  "objective": "Research this change, implement it and review the artifact"
}
```

### Plan without executing

```http
POST /v1/reachmade/plan
```

Uses the same intent shape and returns the selected capability plus its side-effect plan.

### Execute one capability

```http
POST /v1/reachmade/execute
Content-Type: application/json

{
  "id": "work-42",
  "objective": "Research this change, implement it and review the artifact"
}
```

### Execute a multi-product workflow

One authenticated Genie request can hand work across products:

```http
POST /v1/reachmade/workflows/execute
Content-Type: application/json

{
  "id": "ship-orbit",
  "objective": "Review the launch story, then turn it into a launch kit",
  "steps": [
    {
      "id": "review",
      "capabilityId": "agent-team"
    },
    {
      "id": "launch",
      "capabilityId": "launchloom",
      "inputs": {
        "brief": {
          "name": "Orbit",
          "tagline": "A factual tagline",
          "audience": "Developers evaluating the product",
          "description": "A factual product description",
          "product_url": "https://example.com",
          "features": [
            {
              "title": "Export",
              "detail": "Exports a local kit",
              "evidence": "Operator-approved evidence note",
              "approved": true
            }
          ],
          "language": "en",
          "goal": "github",
          "channels": ["x"]
        }
      }
    }
  ]
}
```

The workflow attaches the prior step's Evidence Envelope as `upstreamEvidence` to the next step. It stops rather than guessing when a prior step is `failed`, `unknown`, or `awaiting_approval`.

## Safety boundary

### Agent Team

Genie calls the product's existing `/api/runs` API and reads the terminal run plus artifact manifests. Hashes reported by Agent Team become evidence; Genie does **not** independently claim the artifact contents are correct.

### Launchloom

Genie only uses local campaign/build/render/read endpoints. The adapter:

- defaults `review_plan` to true;
- does not enable paid/external film providers;
- does not enable LLM planning through this path;
- does not enable site writes;
- never calls `release`, publication approval, or social `submit` endpoints;
- only calls `render` when `approvePlan: true` is explicit.

A Launchloom campaign at `awaiting_review` is therefore returned as `awaiting_approval`, not as a finished result.

## Current scope

This is the first integration layer. It proves that Genie can issue one request through a common protocol, delegate to real Agent Team / Launchloom APIs, and return artifacts with evidence. It does not yet make every Reachmade product a capability, and it does not claim external user adoption or production readiness from this integration alone.
