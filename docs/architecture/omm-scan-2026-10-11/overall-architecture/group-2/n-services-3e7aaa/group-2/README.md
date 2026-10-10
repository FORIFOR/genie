# overall-architecture/group-2/n-services-3e7aaa/group-2

[解析トップへ戻る](../../../../README.md)

このグループは表示用の区切りです。独立した実行モジュールではありません。


```mermaid
graph TD
    n-services-meeting-de78b1["meeting\nservices/meeting"]
    n-services-notification-401137["notification\nservices/notification"]
    n-services-plugin-registry-132389["plugin-registry\nservices/plugin-registry"]
    n-services-research-52ec42["research\nservices/research"]
    n-services-share-cd184f["share\nservices/share"]
    n-services-task-5f74b6["task\nservices/task"]
    n-services-world-model-ab8440["world-model\nservices/world-model"]
```

## 要素の説明

### n-services-meeting-de78b1

実在パス: `services/meeting`。28ファイル。

- `services/meeting/package.json`
- `services/meeting/src/anthropic.ts`
- `services/meeting/src/data-sources.ts`
- `services/meeting/src/executor.ts`
- `services/meeting/src/factory.ts`
- `services/meeting/src/google-grpc.ts`
- `services/meeting/src/google-rest.ts`
- `services/meeting/src/google-streaming.ts`
- `services/meeting/src/google-tts.ts`
- `services/meeting/src/google.ts`
- `services/meeting/src/host-summarizer.ts`
- `services/meeting/src/index.ts`
- `services/meeting/src/providers.ts`
- `services/meeting/src/recording.ts`
- `services/meeting/src/service.ts`
- `services/meeting/src/stabilize.ts`
- `services/meeting/src/summarize.ts`
- `services/meeting/test/anthropic.test.ts`
- `services/meeting/test/factory.test.ts`
- `services/meeting/test/google-rest.test.ts`
- `services/meeting/test/google-streaming.test.ts`
- `services/meeting/test/google-tts.test.ts`
- `services/meeting/test/google.test.ts`
- `services/meeting/test/service.db.test.ts`
- `services/meeting/test/stabilize.test.ts`

### n-services-notification-401137

実在パス: `services/notification`。5ファイル。

- `services/notification/package.json`
- `services/notification/src/heartbeat.ts`
- `services/notification/src/index.ts`
- `services/notification/test/heartbeat.test.ts`
- `services/notification/tsconfig.json`

### n-services-plugin-registry-132389

実在パス: `services/plugin-registry`。10ファイル。

- `services/plugin-registry/package.json`
- `services/plugin-registry/src/agent-resolver.ts`
- `services/plugin-registry/src/compliance.ts`
- `services/plugin-registry/src/connections.ts`
- `services/plugin-registry/src/data-sources.ts`
- `services/plugin-registry/src/index.ts`
- `services/plugin-registry/src/service.ts`
- `services/plugin-registry/test/compliance.test.ts`
- `services/plugin-registry/test/connections.db.test.ts`
- `services/plugin-registry/tsconfig.json`

### n-services-research-52ec42

実在パス: `services/research`。24ファイル。

- `services/research/package.json`
- `services/research/src/anthropic.ts`
- `services/research/src/data-sources.ts`
- `services/research/src/executor.ts`
- `services/research/src/factory.ts`
- `services/research/src/general-executor.ts`
- `services/research/src/host-model.ts`
- `services/research/src/host-search.ts`
- `services/research/src/index.ts`
- `services/research/src/ledger.ts`
- `services/research/src/providers.ts`
- `services/research/src/quality.ts`
- `services/research/src/search.ts`
- `services/research/src/service.ts`
- `services/research/test/anthropic.test.ts`
- `services/research/test/factory.test.ts`
- `services/research/test/general.test.ts`
- `services/research/test/host-model.test.ts`
- `services/research/test/host-search.test.ts`
- `services/research/test/model-context.test.ts`
- `services/research/test/quality.test.ts`
- `services/research/test/report.test.ts`
- `services/research/test/search.test.ts`
- `services/research/tsconfig.json`

### n-services-share-cd184f

実在パス: `services/share`。7ファイル。

- `services/share/package.json`
- `services/share/src/index.ts`
- `services/share/src/service.ts`
- `services/share/src/tokens.ts`
- `services/share/test/sensitivity.test.ts`
- `services/share/test/tokens.test.ts`
- `services/share/tsconfig.json`

### n-services-task-5f74b6

実在パス: `services/task`。27ファイル。

- `services/task/package.json`
- `services/task/src/activities.ts`
- `services/task/src/activity-heartbeat.ts`
- `services/task/src/activity-types.ts`
- `services/task/src/agent-plan.ts`
- `services/task/src/events.ts`
- `services/task/src/index.ts`
- `services/task/src/plan.ts`
- `services/task/src/runtime/fake.ts`
- `services/task/src/runtime/index.ts`
- `services/task/src/runtime/temporal.ts`
- `services/task/src/runtime/types.ts`
- `services/task/src/service.ts`
- `services/task/src/task-title.ts`
- `services/task/src/worker.ts`
- `services/task/src/workflows.ts`
- `services/task/test/activity-heartbeat.test.ts`
- `services/task/test/agent-plan.test.ts`
- `services/task/test/computer-plan.test.ts`
- `services/task/test/host-wait.test.ts`
- `services/task/test/mail-plan.test.ts`
- `services/task/test/metered-workflow.test.ts`
- `services/task/test/policy-context.test.ts`
- `services/task/test/queues.test.ts`
- `services/task/test/task-title.test.ts`

### n-services-world-model-ab8440

実在パス: `services/world-model`。27ファイル。

- `services/world-model/package.json`
- `services/world-model/src/brief.ts`
- `services/world-model/src/index.ts`
- `services/world-model/src/memory.ts`
- `services/world-model/src/service.ts`
- `services/world-model/src/work/business-time.ts`
- `services/world-model/src/work/deadline.ts`
- `services/world-model/src/work/graph.ts`
- `services/world-model/src/work/initial-profile.ts`
- `services/world-model/src/work/injection.ts`
- `services/world-model/src/work/meeting-brief.ts`
- `services/world-model/src/work/meeting-publisher.ts`
- `services/world-model/src/work/personalization.ts`
- `services/world-model/src/work/pressure.ts`
- `services/world-model/src/work/reply.ts`
- `services/world-model/src/work/semantic.ts`
- `services/world-model/src/work/service.ts`
- `services/world-model/test/brief.test.ts`
- `services/world-model/test/deadline.test.ts`
- `services/world-model/test/initial-profile.db.test.ts`
- `services/world-model/test/meeting-loop.test.ts`
- `services/world-model/test/memory.test.ts`
- `services/world-model/test/reply-brief.test.ts`
- `services/world-model/test/service.db.test.ts`
- `services/world-model/test/work.db.test.ts`

