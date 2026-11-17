import { describe, expect, it } from 'vitest';
import {
  nextFallbackRoute,
  resolveExecutionRoute,
} from '../src/execution-ladder.js';

describe('Hybrid Execution Ladder', () => {
  it('resolves Tier 1 (API/MCP) when structured API tools are available', () => {
    const res = resolveExecutionRoute({
      goal: 'カレンダーに田中さんとのミーティングを追加',
      availableTools: ['calendar.createEvent', 'mcp.notion.createPage'],
    });
    expect(res.route).toBe('tier1_api_mcp');
    expect(res.confidence).toBeGreaterThan(0.9);
  });

  it('resolves Tier 2 (Web DOM) when targeting URLs or web browsers', () => {
    const res1 = resolveExecutionRoute({
      goal: '最新のAI論文を検索して要約',
      url: 'https://arxiv.org/list/cs.AI/recent',
    });
    expect(res1.route).toBe('tier2_web_dom');

    const res2 = resolveExecutionRoute({
      goal: 'Xで最新のトレンドを調べる',
    });
    expect(res2.route).toBe('tier2_web_dom');
  });

  it('resolves Tier 3 (CLI/FS) when operating on local files and shell', () => {
    const res1 = resolveExecutionRoute({
      goal: 'ダウンロードフォルダを拡張子ごとに整理して',
    });
    expect(res1.route).toBe('tier3_cli_fs');

    const res2 = resolveExecutionRoute({
      goal: 'このドキュメントをPDFに変換してデスクトップに保存',
    });
    expect(res2.route).toBe('tier3_cli_fs');
  });

  it('resolves Tier 4 (macOS AX) for native desktop apps without stealing screen', () => {
    const res1 = resolveExecutionRoute({
      goal: 'Calendarアプリで金曜日の空き状況を確認',
      app: 'Calendar',
    });
    expect(res1.route).toBe('tier4_macos_ax');
    expect(res1.targetApp).toBe('Calendar');

    const res2 = resolveExecutionRoute({
      goal: 'Notesにメモを新規作成',
    });
    expect(res2.route).toBe('tier4_macos_ax');
  });

  it('falls back to Tier 5 (Vision) when no structured or AX route is matched', () => {
    const res = resolveExecutionRoute({
      goal: '特定のカスタム独自UIの赤色のボタンを押して',
    });
    expect(res.route).toBe('tier5_vision');
    expect(res.confidence).toBeLessThan(0.7);
  });

  it('walks down fallback ladder sequentially', () => {
    expect(nextFallbackRoute('tier1_api_mcp')).toBe('tier2_web_dom');
    expect(nextFallbackRoute('tier2_web_dom')).toBe('tier3_cli_fs');
    expect(nextFallbackRoute('tier3_cli_fs')).toBe('tier4_macos_ax');
    expect(nextFallbackRoute('tier4_macos_ax')).toBe('tier5_vision');
    expect(nextFallbackRoute('tier5_vision')).toBeNull();
  });
});
