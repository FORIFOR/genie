#!/usr/bin/env node
/**
 * 見た目のメトリクスを各 OS のソースへ生成する。正は shared/design/tokens.json。
 *
 * macOS: apps/genie-macos/Sources/GenieMac/App/GeneratedMetrics.swift
 * Windows: apps/windows/Genie/GeneratedMetrics.cs
 *
 * TypeScript(Tauri) と同じく「TS/JSON を正として生成し、CI で鮮度検査」する作法。
 *   node scripts/gen-design-tokens.mjs [--check]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tokens = JSON.parse(await readFile(path.join(root, 'shared/design/tokens.json'), 'utf8'));

const w = tokens.recordingWorkspace;
const d = tokens.taskDock;
const h = tokens.voiceHud;
const p = tokens.palette;
const a = tokens.animation;
const ib = tokens.intentBar;
const ri = tokens.recordingIndicator;
const wl = tokens.workspaceLayout;
const sh = tokens.shell;
const bp = tokens.breakpoint;
const ix = tokens.interaction;

/** Swift/C# が使う名前 → 値。名前は両 OS で共通にして、生成物の差を値だけにする。 */
const FIELDS = [
  ['homeComposerEditorHeight', tokens.homeComposer.editorHeight],
  ['homeContentWidth', tokens.homeComposer.contentWidth],
  ['workspaceWidth', w.width],
  ['workspaceHeight', w.height],
  ['workspaceRadius', w.cornerRadius],
  ['notchWidth', w.notchWidth],
  ['notchDepth', w.notchDepth],
  ['notchShoulder', w.notchShoulder],
  ['dockWidth', d.width],
  ['dockHeight', d.height],
  ['hudWidth', h.width],
  ['hudHeight', h.height],
  ['hudBottomRadius', h.bottomRadius],
  ['hudTopRadius', h.topRadius],
  ['dockIdleWidth', h.idleWidth],
  ['dockIdleHeight', h.idleHeight],
  ['dockContextWidth', h.contextWidth],
  ['dockContextHeight', h.contextHeight],
  ['dockContextExpandedWidth', h.contextExpandedWidth],
  ['dockContextExpandedBase', h.contextExpandedBase],
  ['dockListeningWidth', h.listeningWidth],
  ['dockListeningHeight', h.listeningHeight],
  ['dockThinkingWidth', h.thinkingWidth],
  ['dockThinkingHeight', h.thinkingHeight],
  ['dockAgentWidth', h.agentWidth],
  ['dockAgentHeightBase', h.agentHeightBase],
  ['dockAgentRowHeight', h.agentRowHeight],
  ['dockResultWidth', h.resultWidth],
  ['dockResultHeight', h.resultHeight],
  ['dockCardMaxHeight', h.cardMaxHeight],
  ['dockCardImageHeight', h.cardImageHeight],
  ['dockConfirmWidth', h.confirmWidth],
  ['dockConfirmHeight', h.confirmHeight],
  ['dockConfirmPrimaryMinWidth', h.confirmPrimaryMinWidth],
  ['dockMeetingWidth', h.meetingWidth],
  ['dockMeetingHeight', h.meetingHeight],
  ['dockMeetingExpandedHeight', h.meetingExpandedHeight],
  ['dockTitleSize', tokens.dockType.title],
  ['dockSpeechSize', tokens.dockType.speech],
  ['dockPrimarySize', tokens.dockType.primary],
  ['dockRowSize', tokens.dockType.row],
  ['dockMetaSize', tokens.dockType.meta],
  ['dockLabelSize', tokens.dockType.label],
  ['dockPadH', h.padH],
  ['dockPadV', h.padV],
  ['dockRowGap', h.rowGap],
  ['hudOrbSize', h.orbSize],
  ['hudOrbCompactSize', h.orbCompactSize],
  ['paletteWidth', p.toolWidth],
  ['assistantWidth', p.aiWidth],
  ['paletteRadius', p.radius],
  ['intentReadyWidth', ib.readyWidth],
  ['intentReadyHeight', ib.readyHeight],
  ['intentTypingWidth', ib.typingWidth],
  ['intentTypingHeightMax', ib.typingHeightMax],
  ['intentListeningWidth', ib.listeningWidth],
  ['intentListeningHeight', ib.listeningHeight],
  ['intentContextPeekWidth', ib.contextPeekWidth],
  ['intentContextPeekHeightMax', ib.contextPeekHeightMax],
  ['intentBottomInset', ib.bottomInset],
  ['intentRadius', ib.radius],
  ['recordingIndicatorWidth', ri.width],
  ['recordingIndicatorHeight', ri.height],
  ['recordingIndicatorRadius', ri.radius],
  ['sidebarWidth', sh.sidebarWidth],
  ['sidebarCollapsed', sh.sidebarCollapsed],
  ['topBarHeight', sh.topBar],
  ['mainMinWidth', sh.mainMin],
  ['inspectorWidth', sh.inspector],
  ['composerMinHeight', sh.composerMin],
  ['composerMaxHeight', sh.composerMax],
  ['bpThreeColumn', bp.threeColumn],
  ['bpInspectorDrawer', bp.inspectorDrawer],
  ['bpSidebarCollapse', bp.sidebarCollapse],
  ['wsGutter', wl.gutter],
  ['wsContentTop', wl.contentTop],
  ['wsColumnGap', wl.columnGap],
  ['wsRightColumn', wl.rightColumn],
  ['wsRagDrawer', wl.ragDrawer],
  ['wsBottomBar', wl.bottomBar],
  ['wsStatusBar', wl.statusBar],
  ['wsAskBar', wl.askBar],
  ['hoverDelta', ix.hoverDelta],
  ['pressedDelta', ix.pressedDelta],
  ['pressedScale', ix.pressedScale],
  ['focusRing', ix.focusRing],
];
const DURATIONS = [
  ['showMs', a.showMs],
  ['hideMs', a.hideMs],
  ['drawerMs', a.drawerMs],
  ['hoverMs', ix.hoverMs],
  ['dockResizeMs', a.dockResizeMs],
  ['dockContentDelayMs', a.dockContentDelayMs],
  ['markStretchMs', a.markStretchMs],
  ['markAckMs', a.markAckMs],
];

// §17 Visual Design System を単一正に。色/タイポ/余白を各 OS へ直書きせず tokens から生成する。
const COLORS = Object.entries(tokens.color); // [name, {light,dark}]
const TYPE = Object.entries(tokens.type).filter(([k]) => !k.startsWith('$')); // [role, {size,weight}]
const SPACE = Object.entries(tokens.space).concat(
  Object.entries(tokens.radius).map(([k, v]) => [
    `radius${k.charAt(0).toUpperCase() + k.slice(1)}`,
    v,
  ]),
);
const hexRgb = (hex) => {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => (parseInt(n.slice(i, i + 2), 16) / 255).toFixed(4));
};
const swiftColor = (hex) => {
  const [r, g, b] = hexRgb(hex);
  return `Color(.sRGB, red: ${r}, green: ${g}, blue: ${b})`;
};

const swiftPascal = (name) => name.charAt(0).toUpperCase() + name.slice(1);

const swift = `// @generated by scripts/gen-design-tokens.mjs — do not edit.
// 正は shared/design/tokens.json。値を変えたら \`pnpm gen:design-tokens\`。
import CoreGraphics
import SwiftUI

/// 手書き案の寸法（logical points）。両 OS 共通の数値を Swift へ生成したもの。
enum Metrics {
${FIELDS.map(([name, value]) => `    static let ${name}: CGFloat = ${value}`).join('\n')}
}

/// 遷移の時間（秒）。
enum Motion {
${DURATIONS.map(([name, ms]) => `    static let ${name}: Double = ${(ms / 1000).toFixed(3)}`).join('\n')}
}

/// §17.1 カラートークン（Light/Dark）。UI に直書きせずここから使う。
enum Palette {
${COLORS.map(([name]) => `    static func ${name}(_ dark: Bool) -> Color { dark ? ${name}Dark : ${name}Light }`).join('\n')}
${COLORS.map(([name, v]) => `    static let ${name}Light = ${swiftColor(v.light)}\n    static let ${name}Dark = ${swiftColor(v.dark)}`).join('\n')}
}

/// §17.2 タイポグラフィ（pt / weight）。
enum TypeScale {
${TYPE.map(([role, t]) => `    static let ${role}Size: CGFloat = ${t.size}\n    static let ${role}Weight: Font.Weight = ${t.weight >= 600 ? '.semibold' : t.weight >= 500 ? '.medium' : '.regular'}`).join('\n')}
}

/// §17.3 余白・角丸（pt）。
enum Space {
${SPACE.map(([name, v]) => `    static let ${name}: CGFloat = ${v}`).join('\n')}
}
`;

const csharp = `// <auto-generated by scripts/gen-design-tokens.mjs — do not edit.>
// 正は shared/design/tokens.json。値を変えたら \`pnpm gen:design-tokens\`。
namespace Genie;

/// <summary>手書き案の寸法（effective px）。両 OS 共通の数値を Windows へ生成したもの。</summary>
public static class Metrics
{
${FIELDS.map(([name, value]) => `    public const double ${swiftPascal(name)} = ${value};`).join('\n')}
}

/// <summary>遷移の時間（ミリ秒）。</summary>
public static class Motion
{
${DURATIONS.map(([name, ms]) => `    public const int ${swiftPascal(name)} = ${ms};`).join('\n')}
}

/// <summary>§17.1 カラートークン（Light/Dark, #AARRGGBB は不要な #RRGGBB 文字列）。</summary>
public static class Palette
{
${COLORS.map(([name, v]) => `    public const string ${swiftPascal(name)}Light = "${v.light}";\n    public const string ${swiftPascal(name)}Dark = "${v.dark}";`).join('\n')}
}

/// <summary>§17.2 タイポグラフィ（pt / weight）。</summary>
public static class TypeScale
{
${TYPE.map(([role, t]) => `    public const double ${swiftPascal(role)}Size = ${t.size};\n    public const int ${swiftPascal(role)}Weight = ${t.weight};`).join('\n')}
}

/// <summary>§17.3 余白・角丸（pt）。</summary>
public static class Space
{
${SPACE.map(([name, v]) => `    public const double ${swiftPascal(name)} = ${v};`).join('\n')}
}
`;

const outputs = [
  ['apps/genie-macos/Sources/GenieMac/App/GeneratedMetrics.swift', swift],
  ['apps/windows/Genie/GeneratedMetrics.cs', csharp],
];

const check = process.argv.includes('--check');
let stale = false;
for (const [rel, body] of outputs) {
  const target = path.join(root, rel);
  if (check) {
    const current = await readFile(target, 'utf8').catch(() => '');
    // 改行を正規化して比較する（Windows の checkout で LF→CRLF に変換されても
    // 「stale」と誤判定しないため。.gitattributes で LF 固定もするが二重の保険）。
    const norm = (s) => s.replace(/\r\n/g, '\n');
    if (norm(current) !== norm(body)) {
      console.error(`FAIL: ${rel} is stale. Run: pnpm gen:design-tokens`);
      stale = true;
    }
  } else {
    await writeFile(target, body);
    console.log(`wrote ${rel}`);
  }
}
if (check && stale) process.exit(1);
if (check) console.log('design tokens are current');
