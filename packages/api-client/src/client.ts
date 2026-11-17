/**
 * Genie API クライアント。実装仕様 §11 の表面をそのまま写す。
 *
 * 応答は必ず contracts のスキーマで検証してから返す。
 * サーバを信用して素通しすると、契約のずれが UI の奥深くで初めて露見する。
 */
import {
  Artifact,
  ConversationState,
  CreateMeetingRequest,
  OnboardingState,
  PackRecommendation,
  DailyBrief,
  DashboardView,
  ActionReceiptView,
  CreateTaskRequest,
  EvidenceLedger,
  Meeting,
  MeetingSegment,
  MeetingSpeaker,
  MeResponse as MeResponseSchema,
  TokenResponse,
  AuthProvidersResponse,
  IdpSignInRequest,
  PluginCatalogEntry,
  PluginInstall,
  Share,
  type CreateShareRequest,
  SendTurnRequest,
  StartConversationRequest,
  Task,
  TaskListItem,
  type TaskCurrentStep,
  WorldFact,
  VoiceSynthesisRequest,
  VoiceSynthesisResponse,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResponse,
  dockStateFor,
  uuidv7,
  type ApprovalDecision,
  type ArtifactType,
  type InstallPluginRequest,
  type MeResponse,
  type TaskDockState,
} from '@genie/contracts';
import { z } from 'zod';
import { HttpClient, type ClientConfig } from './http.js';
import { streamMeetingEvents, streamTaskEvents, type StreamOptions } from './sse.js';

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() });

/** 一覧の返り値。cursor は UUIDv7 なので時系列で辿れる。 */
export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/** サーバが導いた Dock 表示状態を同梱した Task（実装仕様 §11）。 */
export const TaskWithDockState = Task.extend({ dock_state: z.string().optional() });
export interface TaskView extends Task {
  readonly dockState: TaskDockState;
  /** 一覧のときだけ入る（§9.1）。単体取得では undefined。 */
  readonly current_step?: TaskCurrentStep | null;
}

function toView(task: Task | TaskListItem, dockState?: string): TaskView {
  return {
    ...task,
    // サーバが付けてくれるならそれを使う。無ければ同じ規則で導く。
    dockState: (dockState as TaskDockState | undefined) ?? dockStateFor(task.status, task.error),
  };
}

export class GenieClient {
  readonly http: HttpClient;

  constructor(config: ClientConfig) {
    this.http = new HttpClient(config);
  }

  me(): Promise<MeResponse> {
    return this.http.request({ path: '/v1/me' }, (value) => MeResponseSchema.parse(value));
  }

  /**
   * 開発用のサインイン。本番ではこの経路自体がサーバに登録されていない（§4.3）。
   * 実 IdP へ差し替えるときに触るのはここだけで済むようにしてある。
   */
  /** どの提供者でサインインできるか。設定されていないものは configured=false で返る。 */
  authProviders(): Promise<AuthProvidersResponse> {
    return this.http.request({ method: 'GET', path: '/v1/auth/providers' }, (value) =>
      AuthProvidersResponse.parse(value),
    );
  }

  /** 提供者の ID トークンで Genie のトークンを得る。access / refresh token は渡さない。 */
  signInWithIdp(body: IdpSignInRequest): Promise<TokenResponse> {
    return this.http.request({ method: 'POST', path: '/v1/auth/idp/token', body }, (value) =>
      TokenResponse.parse(value),
    );
  }

  devSignIn(email: string, displayName: string): Promise<TokenResponse> {
    return this.http.request(
      {
        method: 'POST',
        path: '/v1/auth/dev/token',
        body: { email, display_name: displayName },
      },
      (value) => TokenResponse.parse(value),
    );
  }

  /** refresh token をローテーションする。旧トークンはこの時点で失効する（§4.2）。 */
  refresh(refreshToken: string): Promise<TokenResponse> {
    return this.http.request(
      { method: 'POST', path: '/v1/auth/refresh', body: { refresh_token: refreshToken } },
      (value) => TokenResponse.parse(value),
    );
  }

  async logout(refreshToken: string): Promise<void> {
    await this.http.send({
      method: 'POST',
      path: '/v1/auth/logout',
      body: { refresh_token: refreshToken },
    });
  }

  /**
   * タスクを作る。
   *
   * Idempotency-Key は**呼び出し側が渡せる**ようにしてある。
   * 再送で同じ鍵を使えるのが冪等性の意味であって、毎回新しく作ると意味が無い。
   */
  async createTask(
    request: CreateTaskRequest,
    idempotencyKey: string = uuidv7(),
  ): Promise<TaskView> {
    const raw = await this.http.request(
      { method: 'POST', path: '/v1/tasks', body: request, idempotencyKey },
      (value) => TaskWithDockState.parse(value),
    );
    return toView(Task.parse(raw), raw.dock_state);
  }

  async getTask(taskId: string): Promise<TaskView> {
    const raw = await this.http.request({ path: `/v1/tasks/${taskId}` }, (value) =>
      TaskWithDockState.parse(value),
    );
    return toView(Task.parse(raw), raw.dock_state);
  }

  async listTasks(options: { limit?: number; cursor?: string } = {}): Promise<Page<TaskView>> {
    const parsed = await this.http.request(
      { path: '/v1/tasks', query: { limit: options.limit, cursor: options.cursor } },
      (value) => page(TaskListItem).parse(value),
    );
    return { items: parsed.items.map((t) => toView(t)), nextCursor: parsed.next_cursor };
  }

  async cancelTask(taskId: string, reason = 'user_requested'): Promise<TaskView> {
    const task = await this.http.request(
      { method: 'POST', path: `/v1/tasks/${taskId}/cancel`, body: { reason } },
      (value) => Task.parse(value),
    );
    return toView(task);
  }

  /** この成果物に出ている共有。UI/UX §10.2「共有状態は header に常時可視化」。 */
  /** 共有リンクを作る。平文の URL が返るのはこの一度だけ。 */
  async createShare(
    artifactId: string,
    body: CreateShareRequest,
  ): Promise<{ share: Share; url: string }> {
    return this.http.request(
      { method: 'POST', path: `/v1/artifacts/${encodeURIComponent(artifactId)}/share`, body },
      (value) => z.object({ share: Share, url: z.string() }).parse(value),
    );
  }

  async revokeShare(shareId: string): Promise<void> {
    await this.http.request(
      { method: 'DELETE', path: `/v1/shares/${encodeURIComponent(shareId)}` },
      () => undefined,
    );
  }

  async artifactShares(artifactId: string): Promise<Share[]> {
    return this.http.request(
      { method: 'GET', path: `/v1/artifacts/${artifactId}/shares` },
      (value) => z.object({ items: z.array(Share) }).parse(value).items,
    );
  }

  /**
   * 根拠の台帳。UI/UX §15。**L0〜L3 を 1 度に取る。**
   * 調査でない仕事では 404（空の台帳を返さない）。
   */
  async taskEvidence(taskId: string): Promise<EvidenceLedger> {
    return this.http.request({ method: 'GET', path: `/v1/tasks/${taskId}/evidence` }, (value) =>
      EvidenceLedger.parse(value),
    );
  }

  /** 受け取りの控え。UI/UX §22。新しい順。 */
  async taskReceipts(taskId: string): Promise<ActionReceiptView[]> {
    return this.http.request(
      { method: 'GET', path: `/v1/tasks/${taskId}/receipts` },
      (value) => z.object({ items: z.array(ActionReceiptView) }).parse(value).items,
    );
  }

  async decideApproval(taskId: string, decision: ApprovalDecision): Promise<void> {
    await this.http.send({
      method: 'POST',
      path: `/v1/tasks/${taskId}/approve`,
      body: decision,
    });
  }

  /** タスクの進捗を購読する。切断からの再開は clientside で面倒を見る（§7.3）。 */
  streamTask(taskId: string, options: StreamOptions): Promise<number> {
    return streamTaskEvents(this.http, taskId, options);
  }

  // ---------------------------------------------------------- onboarding

  async onboarding(): Promise<OnboardingState> {
    return this.http.request({ path: '/v1/onboarding' }, (value) => OnboardingState.parse(value));
  }

  async updateOnboarding(patch: Record<string, unknown>): Promise<OnboardingState> {
    return this.http.request({ method: 'PATCH', path: '/v1/onboarding', body: patch }, (value) =>
      OnboardingState.parse(value),
    );
  }

  /** 薦めるものと、そのために要る許可。**まとめて要求はしない。** */
  async onboardingRecommendations(
    interests: readonly string[],
  ): Promise<{ items: PackRecommendation[]; permissions: string[] }> {
    return this.http.request(
      {
        path: '/v1/onboarding/recommendations',
        query: { interests: interests.join(',') },
      },
      (value) =>
        z
          .object({ items: z.array(PackRecommendation), permissions: z.array(z.string()) })
          .parse(value),
    );
  }

  // --------------------------------------------------------- conversation

  /** 会話を始める。voice と text は同じ会話（正本 §2）。 */
  async startConversation(
    request: StartConversationRequest = { response_mode: 'text' },
  ): Promise<{ id: string; state: ConversationState }> {
    return this.http.request(
      { method: 'POST', path: '/v1/conversations', body: request },
      (value) => z.object({ id: z.string(), state: ConversationState }).parse(value),
    );
  }

  /**
   * 発話を送る。
   *
   * **解決できない指示語があれば、そのまま進めずに聞き返しが返る。**
   * 呼び出し側はそれを出すだけでよい。
   */
  async sendTurn(
    conversationId: string,
    // 既定のある項目まで呼び出し側に書かせない（context_referents 等）
    request: z.input<typeof SendTurnRequest>,
  ): Promise<{
    needsClarification: boolean;
    answer: string | null;
    intent: string | null;
    /** 始まった仕事。始められなければ null で、理由は notice。 */
    taskId: string | null;
    notice: string | null;
  }> {
    const parsed = await this.http.request(
      {
        method: 'POST',
        path: `/v1/conversations/${conversationId}/turns`,
        body: request,
      },
      (value) =>
        z
          .object({
            needs_clarification: z.boolean(),
            answer: z.object({ text: z.string() }).optional(),
            intent: z.string().optional(),
            task_id: z.string().nullable().optional(),
            notice: z.string().nullable().optional(),
          })
          .parse(value),
    );
    return {
      needsClarification: parsed.needs_clarification,
      answer: parsed.answer?.text ?? null,
      intent: parsed.intent ?? null,
      taskId: parsed.task_id ?? null,
      notice: parsed.notice ?? null,
    };
  }

  /** Read a saved request receipt after response loss. Never resubmits a turn. */
  async getTurnReceipt(conversationId: string, requestId: string) {
    return this.http.request(
      { method: 'GET', path: `/v1/conversations/${conversationId}/requests/${requestId}` },
      (value) =>
        z
          .discriminatedUnion('status', [
            z.object({ status: z.literal('pending') }),
            z.object({
              status: z.literal('resolved'),
              response: z.object({
                needs_clarification: z.boolean(),
                answer: z.object({ text: z.string() }).optional(),
                intent: z.string().optional(),
                task_id: z.string().nullable().optional(),
                notice: z.string().nullable().optional(),
              }),
            }),
          ])
          .parse(value),
    );
  }

  /** 利用者が許したときだけ、確定用の音声を Google STT へ送る。 */
  transcribeVoice(
    request: z.input<typeof VoiceTranscriptionRequest>,
  ): Promise<z.infer<typeof VoiceTranscriptionResponse>> {
    return this.http.request(
      { method: 'POST', path: '/v1/voice/transcriptions', body: request },
      (value) => VoiceTranscriptionResponse.parse(value),
    );
  }

  /** Agent の文字応答を Google TTS で音へ変える。 */
  synthesizeVoice(
    request: z.input<typeof VoiceSynthesisRequest>,
  ): Promise<z.infer<typeof VoiceSynthesisResponse>> {
    return this.http.request({ method: 'POST', path: '/v1/voice/speech', body: request }, (value) =>
      VoiceSynthesisResponse.parse(value),
    );
  }

  /** 触れたものを覚えさせる。「それ」の解決先になる。 */
  async rememberReferent(
    conversationId: string,
    referent: { label: string; target: Record<string, unknown> },
  ): Promise<void> {
    await this.http.send({
      method: 'POST',
      path: `/v1/conversations/${conversationId}/referents`,
      body: referent,
    });
  }

  /**
   * 「今日気にすべきこと」。正本 §2.1、Phase 6 §4。
   *
   * **server 側で組む。**commitment も会議も client は持っていないので、
   * 画面で組み立てると task しか見えない feed になる。
   */
  brief(): Promise<DailyBrief> {
    return this.http.request({ path: '/v1/brief' }, (value) => DailyBrief.parse(value));
  }

  /**
   * 「これは出さないで」。UI/UX §16。
   *
   * `never` は明示拒否。**こちらの都合で忘れない。**
   */
  async dismissAttention(itemId: string, verdict: 'later' | 'never' = 'later'): Promise<void> {
    await this.http.send({
      method: 'POST',
      path: `/v1/brief/items/${encodeURIComponent(itemId)}/dismiss`,
      body: { verdict },
    });
  }

  async commitments(): Promise<WorldFact[]> {
    const parsed = await this.http.request({ path: '/v1/commitments' }, (value) =>
      z.object({ items: z.array(WorldFact) }).parse(value),
    );
    return parsed.items;
  }

  /** 済ませる / やめる。**消さずに残る。** */
  settleCommitment(factId: string, status: 'DONE' | 'DROPPED'): Promise<WorldFact> {
    return this.http.request(
      { method: 'POST', path: `/v1/commitments/${factId}/settle`, body: { status } },
      (value) => WorldFact.parse(value),
    );
  }

  // ------------------------------------------------------------- meetings

  /**
   * 会議を始める。**同意の確認は呼び出し側の責任**で、
   * `consent_confirmed: true` が無いと契約側で落ちる（UI/UX §12.1）。
   */
  /** gateway の場所と、いまの access token。端末側の音声送信が使う。 */
  get baseUrl(): string {
    return this.http.baseUrl;
  }

  currentAccessToken(): Promise<string | null> {
    return this.http.currentAccessToken();
  }

  async startMeeting(request: CreateMeetingRequest): Promise<Meeting> {
    return this.http.request({ method: 'POST', path: '/v1/meetings', body: request }, (value) =>
      Meeting.parse(value),
    );
  }

  async getMeeting(meetingId: string): Promise<Meeting> {
    return this.http.request({ path: `/v1/meetings/${meetingId}` }, (value) =>
      Meeting.parse(value),
    );
  }

  async listMeetings(): Promise<Meeting[]> {
    const parsed = await this.http.request({ path: '/v1/meetings' }, (value) =>
      z.object({ items: z.array(Meeting) }).parse(value),
    );
    return parsed.items;
  }

  /** transcript。pass を省くと final があれば final、無ければ live。 */
  async meetingSegments(
    meetingId: string,
    pass?: 'live' | 'final',
  ): Promise<{ segments: MeetingSegment[]; speakers: MeetingSpeaker[] }> {
    const parsed = await this.http.request(
      { path: `/v1/meetings/${meetingId}/segments`, query: { pass } },
      (value) =>
        z
          .object({ items: z.array(MeetingSegment), speakers: z.array(MeetingSpeaker) })
          .parse(value),
    );
    return { segments: parsed.items, speakers: parsed.speakers };
  }

  /** 話者に名前を付ける。この会議の中だけの対応（正本 §11.3）。 */
  async nameSpeaker(
    meetingId: string,
    speakerTag: number,
    displayName: string,
  ): Promise<MeetingSpeaker> {
    return this.http.request(
      {
        method: 'POST',
        path: `/v1/meetings/${meetingId}/speakers`,
        body: { speaker_tag: speakerTag, display_name: displayName },
      },
      (value) => MeetingSpeaker.parse(value),
    );
  }

  /** 終了。返るのは finalize の task id。閉じても続く（UI/UX §12.5）。 */
  async finishMeeting(meetingId: string): Promise<{ meetingId: string; taskId: string }> {
    const parsed = await this.http.request(
      { method: 'POST', path: `/v1/meetings/${meetingId}/finish` },
      (value) => z.object({ meeting_id: z.string(), task_id: z.string() }).parse(value),
    );
    return { meetingId: parsed.meeting_id, taskId: parsed.task_id };
  }

  /** 会議の transcript を購読する。終端は meeting.ended。 */
  streamMeeting(meetingId: string, options: StreamOptions): Promise<number> {
    return streamMeetingEvents(this.http, meetingId, options);
  }

  async listArtifacts(
    options: {
      limit?: number;
      cursor?: string;
      type?: ArtifactType;
      /** その仕事から生まれたものだけ（§9.2 Outputs）。 */
      sourceTaskId?: string;
    } = {},
  ): Promise<Page<Artifact>> {
    const parsed = await this.http.request(
      {
        path: '/v1/artifacts',
        query: {
          limit: options.limit,
          cursor: options.cursor,
          type: options.type,
          source_task_id: options.sourceTaskId,
        },
      },
      (value) => page(Artifact).parse(value),
    );
    return { items: parsed.items, nextCursor: parsed.next_cursor };
  }

  getArtifact(artifactId: string): Promise<Artifact> {
    return this.http.request({ path: `/v1/artifacts/${artifactId}` }, (value) =>
      Artifact.parse(value),
    );
  }

  /**
   * 本体の取得先。**raw なストレージ URL は返らない**（正本 §2.3）。
   * 認証が要るので、そのまま `<img src>` には使えない。fetch して blob にする。
   */
  artifactContentUrl(artifactId: string): string {
    return this.http.urlFor(`/v1/artifacts/${artifactId}/content`);
  }

  async artifactContent(artifactId: string): Promise<Blob> {
    const response = await this.http.send({ path: `/v1/artifacts/${artifactId}/content` });
    return response.blob();
  }

  async pluginCatalog(): Promise<PluginCatalogEntry[]> {
    const parsed = await this.http.request({ path: '/v1/plugins/catalog' }, (value) =>
      z.object({ items: z.array(PluginCatalogEntry) }).parse(value),
    );
    return parsed.items;
  }

  installPlugin(pluginId: string, request: InstallPluginRequest): Promise<PluginInstall> {
    return this.http.request(
      { method: 'POST', path: `/v1/plugins/${pluginId}/install`, body: request },
      (value) => PluginInstall.parse(value),
    );
  }

  /** install しただけで増えた dashboard の一覧（Phase 4 Exit）。 */
  async dashboards(): Promise<
    { plugin_id: string; plugin_name: string; id: string; title: string }[]
  > {
    const parsed = await this.http.request({ path: '/v1/dashboards' }, (value) =>
      z
        .object({
          items: z.array(
            z.object({
              plugin_id: z.string(),
              plugin_name: z.string(),
              id: z.string(),
              title: z.string(),
            }),
          ),
        })
        .parse(value),
    );
    return parsed.items;
  }

  /** schema と、解決済みのデータ。解決できなかったものは理由が入る。 */
  dashboard(pluginId: string, dashboardId: string): Promise<DashboardView> {
    return this.http.request(
      { path: `/v1/plugins/${pluginId}/dashboards/${dashboardId}` },
      (value) => DashboardView.parse(value),
    );
  }

  async updatePlugin(
    pluginId: string,
    version: string,
    grantedScopes: readonly string[] = [],
  ): Promise<PluginInstall> {
    return this.http.request(
      {
        method: 'POST',
        path: `/v1/plugins/${pluginId}/update`,
        body: { version, granted_scopes: grantedScopes },
      },
      (value) => PluginInstall.parse(value),
    );
  }

  async rollbackPlugin(pluginId: string): Promise<PluginInstall> {
    return this.http.request(
      { method: 'POST', path: `/v1/plugins/${pluginId}/rollback` },
      (value) => PluginInstall.parse(value),
    );
  }

  /**
   * connector を繋ぐ。正本 §21。
   *
   * **渡すのは参照だけ。**値そのものはサーバへ送らない
   * （送っても ConnectionService が断るが、送る側でも作らない）。
   */
  async connectConnector(
    pluginId: string,
    request: {
      connector_id: string;
      credential_ref: string;
      granted_scopes: string[];
      account_label: string | null;
      expires_at: string | null;
    },
  ): Promise<void> {
    await this.http.send({
      method: 'POST',
      path: `/v1/plugins/${pluginId}/connect`,
      body: request,
    });
  }

  async disconnectConnector(pluginId: string, connectorId: string): Promise<void> {
    await this.http.send({
      method: 'DELETE',
      path: `/v1/plugins/${pluginId}/connections/${connectorId}`,
    });
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    await this.http.send({ method: 'DELETE', path: `/v1/plugins/${pluginId}` });
  }
}
