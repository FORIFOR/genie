/**
 * ハイブリッド実行経路ラダー（Execution Ladder）。
 *
 * 5段階の優先順位で最適なPC実行経路を決定論的に解決する:
 * 1. tier1_api_mcp: API / MCP / App Intents (直接構造化通信・最速・安価・画面非占有)
 * 2. tier2_web_dom: DOM / WebMCP / Playwright (ブラウザ内直結・画面非占有)
 * 3. tier3_cli_fs: CLI / filesystem / AppleScript (OSスクリプト/FS操作・確実)
 * 4. tier4_macos_ax: macOS Accessibility API (非前面・画面非占有バックグラウンド操作)
 * 5. tier5_vision: Vision Model + Native Input (スクリーンショット+座標入力、最終手段フォールバック)
 */
import {
  EXECUTION_ROUTES,
  type ExecutionRoute,
} from '@genie/contracts';

export interface ExecutionLadderInput {
  readonly goal: string;
  readonly app?: string | undefined;
  readonly url?: string | undefined;
  readonly availableTools?: readonly string[] | undefined;
  readonly hasWebAutomation?: boolean | undefined;
  readonly hasCliFsAccess?: boolean | undefined;
  readonly hasBackgroundAx?: boolean | undefined;
  readonly hasVisionInput?: boolean | undefined;
}

export interface ExecutionRouteCandidate {
  readonly route: ExecutionRoute;
  readonly confidence: number;
  readonly reason: string;
  readonly fallbackRoutes: ExecutionRoute[];
  readonly targetApp?: string | undefined;
}

const NATIVE_AX_APPS = new Set([
  'calendar',
  'notes',
  'reminders',
  'mail',
  'finder',
  'system settings',
  'system preferences',
  'maps',
  'calculator',
  'music',
  'preview',
  'slack',
  'discord',
  'notion',
]);

const WEB_BROWSERS = new Set(['safari', 'google chrome', 'chrome', 'brave', 'arc', 'edge', 'firefox']);

const CLI_FS_KEYWORDS = [
  'ファイル',
  'フォルダ',
  'ディレクトリ',
  'ダウンロード',
  'デスクトップ',
  'file',
  'folder',
  'directory',
  'download',
  'desktop',
  'mv ',
  'cp ',
  'rm ',
  'mkdir',
  'git ',
  'ターミナル',
  'terminal',
  'コマンド',
  'スクリプト',
  'script',
  'osascript',
  'applescript',
  '整理',
  'zip',
  'tar',
  'pdfに変換',
  'convert to pdf',
];

/**
 * 目標・対象アプリ・URL・利用可能なツール群から最適な実行経路を解決する。
 */
export function resolveExecutionRoute(input: ExecutionLadderInput): ExecutionRouteCandidate {
  const goalLower = input.goal.toLowerCase();
  const appLower = input.app?.trim().toLowerCase();
  const availableTools = input.availableTools ?? [];

  const hasMcpTools = availableTools.some(
    (t) => t.startsWith('mcp.') || t.startsWith('api.') || t.startsWith('calendar.') || t.startsWith('mail.'),
  );
  const hasWeb = input.hasWebAutomation ?? true;
  const hasCliFs = input.hasCliFsAccess ?? true;
  const hasAx = input.hasBackgroundAx ?? true;

  // 1. Tier 1: API / MCP
  if (hasMcpTools) {
    return {
      route: 'tier1_api_mcp',
      confidence: 0.95,
      reason: 'Matching direct API/MCP structured tools are available.',
      fallbackRoutes: ['tier4_macos_ax', 'tier3_cli_fs', 'tier5_vision'],
      targetApp: input.app,
    };
  }

  // 2. Tier 2: Web DOM / Browser
  const isWebUrl = Boolean(input.url && /^https?:\/\//i.test(input.url));
  const isBrowserApp = appLower ? WEB_BROWSERS.has(appLower) : false;
  const mentionsWeb =
    isWebUrl ||
    isBrowserApp ||
    goalLower.includes('http://') ||
    goalLower.includes('https://') ||
    goalLower.includes('x.com') ||
    goalLower.includes('twitter') ||
    /(?:^|[^a-z0-9])x(?:で|から|の|を|に|上|検索|$|\s)/i.test(input.goal) ||
    goalLower.includes('ブラウザ') ||
    goalLower.includes('browser') ||
    goalLower.includes('webサイト') ||
    goalLower.includes('website');

  if (mentionsWeb && hasWeb) {
    return {
      route: 'tier2_web_dom',
      confidence: 0.9,
      reason: 'Target is a web resource suitable for DOM/WebMCP browser automation without screen stealing.',
      fallbackRoutes: ['tier4_macos_ax', 'tier5_vision'],
      targetApp: input.app ?? 'Safari',
    };
  }

  // 3. Tier 3: CLI / Filesystem
  const mentionsCliFs = CLI_FS_KEYWORDS.some((kw) => goalLower.includes(kw));
  if (mentionsCliFs && hasCliFs) {
    return {
      route: 'tier3_cli_fs',
      confidence: 0.88,
      reason: 'Target task involves direct filesystem, shell, or AppleScript execution.',
      fallbackRoutes: ['tier4_macos_ax', 'tier5_vision'],
      targetApp: input.app,
    };
  }

  // 4. Tier 4: macOS AX (Background accessibility)
  const isNativeAxApp = appLower ? NATIVE_AX_APPS.has(appLower) : false;
  const mentionsAxApp = Array.from(NATIVE_AX_APPS).some((app) => goalLower.includes(app));

  if ((isNativeAxApp || mentionsAxApp) && hasAx) {
    const matchedApp =
      input.app ??
      Array.from(NATIVE_AX_APPS).find((app) => goalLower.includes(app)) ??
      'Finder';
    return {
      route: 'tier4_macos_ax',
      confidence: 0.85,
      reason: `Target app "${matchedApp}" can be operated via macOS Accessibility API in the background without stealing foreground focus.`,
      fallbackRoutes: ['tier5_vision'],
      targetApp: matchedApp,
    };
  }

  // 5. Tier 5: Vision + Native Input fallback
  return {
    route: 'tier5_vision',
    confidence: 0.6,
    reason: 'No direct API, DOM, CLI, or AX route matched. Falling back to Computer Vision + mouse/keyboard coordinates.',
    fallbackRoutes: [],
    targetApp: input.app,
  };
}

/**
 * 失敗時に次善のフォールバック経路を取得する。
 */
export function nextFallbackRoute(
  currentRoute: ExecutionRoute,
  candidates: readonly ExecutionRoute[] = EXECUTION_ROUTES,
): ExecutionRoute | null {
  const currentIndex = candidates.indexOf(currentRoute);
  if (currentIndex === -1 || currentIndex >= candidates.length - 1) {
    return null;
  }
  return candidates[currentIndex + 1] ?? null;
}
