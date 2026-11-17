#!/usr/bin/env node
/**
 * Genie Computer Use - Web UI Companion
 * コマンドラインではなくブラウザのグラフィカルUIからComputer Useを依頼・監視できます。
 *
 * **このページからは承認しない。**以前は承認の経路（`/api/tasks/:id/` の下）がサーバの dev token で
 * decision: APPROVED を中継していた。127.0.0.1 で認証なし・CORS * だったので、ブラウザで開いた
 * 任意のサイトが依頼を作り、承認 id を読み、人が何も見ないまま画面操作を承認できた。
 * 承認は人が確認カード（macOS アプリ）か、端末のコマンド（scripts/computer-use.mjs approve）で行う。
 * 残る書き込み（依頼・中止）も、このページ自身からの JSON だけを受け付ける（Host / Origin / Content-Type）。
 */
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_STATE, validateConfig, lockPort } from './local-preview/config.mjs';
import { desktopEmail } from './start-local-host.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 43128;
const execFileAsync = promisify(execFile);

async function loadRuntimeConfig(stateDir = DEFAULT_STATE) {
  const dir = await realpath(resolve(stateDir));
  const config = JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8'));
  validateConfig(config);
  return { dir, config };
}

async function getAccessToken(base, identity) {
  const res = await fetch(`${base}/v1/auth/dev/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: desktopEmail(identity),
      display_name: 'Genie Computer Use UI',
    }),
  });
  if (!res.ok) throw new Error(`Auth failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Genie Computer Use Studio</title>
  <style>
    :root {
      --bg: #0f1117;
      --card-bg: rgba(26, 29, 39, 0.85);
      --card-border: rgba(255, 255, 255, 0.08);
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --accent-glow: rgba(59, 130, 246, 0.3);
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.25);
      --warning: #f59e0b;
      --warning-glow: rgba(245, 158, 11, 0.25);
      --danger: #ef4444;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --radius: 14px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      padding: 32px 20px 60px;
      line-height: 1.5;
    }
    .container {
      max-width: 960px;
      margin: 0 auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 28px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--card-border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-icon {
      font-size: 26px;
      background: linear-gradient(135deg, #60a5fa, #a855f7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .brand-title {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .brand-subtitle {
      font-size: 13px;
      color: var(--text-muted);
    }
    .status-badges {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
    }
    .badge.ready {
      background: var(--success-glow);
      color: #34d399;
      border-color: rgba(52, 211, 153, 0.3);
    }
    .badge-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      padding: 24px;
      margin-bottom: 24px;
      backdrop-filter: blur(16px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    }
    .card-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .presets-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 14px;
      margin-bottom: 8px;
    }
    .preset-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: all 0.15s ease;
      cursor: pointer;
    }
    .preset-card:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(96, 165, 250, 0.4);
      transform: translateY(-2px);
    }
    .preset-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 6px;
    }
    .preset-desc {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 12px;
    }
    .preset-actions {
      display: flex;
      gap: 8px;
    }
    .btn-small {
      padding: 5px 10px;
      font-size: 11px;
      border-radius: 6px;
      border: 1px solid var(--card-border);
      background: rgba(255, 255, 255, 0.06);
      color: var(--text);
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn-small:hover { background: rgba(255, 255, 255, 0.12); }
    .form-group {
      margin-bottom: 16px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 6px;
      color: var(--text-muted);
    }
    textarea, input[type="text"] {
      width: 100%;
      padding: 12px 14px;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      color: var(--text);
      font-size: 14px;
      font-family: inherit;
      resize: vertical;
      transition: border-color 0.15s;
    }
    textarea:focus, input[type="text"]:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    .btn-primary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      border: none;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 14px var(--accent-glow);
      transition: all 0.15s ease;
    }
    .btn-primary:hover {
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      transform: translateY(-1px);
    }
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    .btn-approve {
      background: linear-gradient(135deg, #059669, #10b981);
      box-shadow: 0 4px 14px var(--success-glow);
    }
    .btn-approve:hover {
      background: linear-gradient(135deg, #10b981, #34d399);
    }
    .btn-cancel {
      background: rgba(239, 68, 68, 0.15);
      color: #fca5a5;
      border: 1px solid rgba(239, 68, 68, 0.3);
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 13px;
      cursor: pointer;
    }
    .btn-cancel:hover { background: rgba(239, 68, 68, 0.25); }
    .approval-banner {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(245, 158, 11, 0.05));
      border: 1px solid rgba(245, 158, 11, 0.4);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      animation: pulse 2s infinite ease-in-out;
    }
    @keyframes pulse {
      0%, 100% { border-color: rgba(245, 158, 11, 0.4); }
      50% { border-color: rgba(245, 158, 11, 0.8); }
    }
    .approval-actions {
      display: flex;
      gap: 12px;
      align-items: center;
      margin-top: 14px;
    }
    .log-terminal {
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      max-height: 280px;
      overflow-y: auto;
      color: #d1d5db;
    }
    .log-item {
      padding: 4px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .log-time { color: var(--text-muted); font-size: 11px; min-width: 60px; }
    .log-msg { flex: 1; word-break: break-all; }
    .status-pill {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-WAITING_APPROVAL { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
    .status-RUNNING { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
    .status-COMPLETED { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .status-FAILED { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .result-view {
      background: rgba(16, 185, 129, 0.08);
      border: 1px solid rgba(16, 185, 129, 0.3);
      border-radius: 8px;
      padding: 16px;
      margin-top: 16px;
      white-space: pre-wrap;
      font-size: 13px;
    }
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-icon">✦</div>
        <div>
          <div class="brand-title">Genie Computer Use Studio</div>
          <div class="brand-subtitle">バックグラウンド画面操作・ユーザー非干渉コントローラー</div>
        </div>
      </div>
      <div class="status-badges" id="statusBadges">
        <div class="badge ready"><span class="badge-dot"></span>接続確認中...</div>
      </div>
    </header>

    <div class="card">
      <div class="card-title">🎯 クイックシナリオ（1クリック設定）</div>
      <div class="presets-grid">
        <div class="preset-card" onclick="setPreset('multistep')">
          <div>
            <div class="preset-header">📝 多工程フォーム自動入力</div>
            <div class="preset-desc">名前と住所を入力し、保存ボタンを押して「保存しました」を確認する3工程</div>
          </div>
          <div class="preset-actions">
            <button class="btn-small" onclick="event.stopPropagation(); openFixture('multistep')">📄 画面を開く</button>
            <button class="btn-small">🎯 セット</button>
          </div>
        </div>

        <div class="preset-card" onclick="setPreset('typing')">
          <div>
            <div class="preset-header">⌨️ 物理キータイピング</div>
            <div class="preset-desc">表示される英単語を物理キーストロークで順に打ち込み、CLEARを達成する</div>
          </div>
          <div class="preset-actions">
            <button class="btn-small" onclick="event.stopPropagation(); openFixture('typing')">📄 画面を開く</button>
            <button class="btn-small">🎯 セット</button>
          </div>
        </div>

        <div class="preset-card" onclick="setPreset('native')">
          <div>
            <div class="preset-header">🪟 ネイティブデスクトップアプリ</div>
            <div class="preset-desc">macOSネイティブアプリの詳細ボタンを押して詳細表示・コールバックを確認</div>
          </div>
          <div class="preset-actions">
            <button class="btn-small" onclick="event.stopPropagation(); openFixture('native')">🚀 アプリ起動</button>
            <button class="btn-small">🎯 セット</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">🚀 タスクの作成</div>
      <div class="form-group">
        <label for="goal">目的 (Goal)</label>
        <textarea id="goal" rows="2" placeholder="例: 名前の欄に genie、住所の欄に tokyo と入力して保存ボタンを押す"></textarea>
      </div>
      <div class="form-group">
        <label for="criteria">完了判定条件 (Success Criteria)</label>
        <textarea id="criteria" rows="2" placeholder="例: 画面に保存しましたと表示されている"></textarea>
      </div>
      <button class="btn-primary" id="btnStart" onclick="startTask()">
        <span>🚀 画面操作タスクを開始する</span>
      </button>
    </div>

    <div class="card" id="taskCard" style="display: none;">
      <div class="card-title" style="justify-content: space-between;">
        <span>📊 実行ステータス</span>
        <span id="taskStatusPill" class="status-pill">PENDING</span>
      </div>

      <div id="approvalBanner" class="approval-banner" style="display: none;">
        <div style="font-weight: 600; font-size: 15px; margin-bottom: 4px;">⚠️ 画面操作の承認待ちです</div>
        <div style="font-size: 13px; color: #fde68a;">
          このページからは承認できません。この依頼は承認待ちのまま残ります。<br>
          画面操作を試すときは、端末で <code>node scripts/computer-use.mjs start</code> から依頼し、<code>approve</code> で承認してください。
        </div>
        <div class="approval-actions">
          <button class="btn-cancel" onclick="cancelTask()">❌ 中止</button>
        </div>
      </div>

      <div id="runningNotice" style="display: none; padding: 12px 16px; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 8px; margin-bottom: 16px; font-size: 13px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="spinner"></span>
          <span><strong>バックグラウンドで操作中:</strong> 対象ウィンドウを背面に置いたまま、手元のブラウジングや作業を続けて構いません。</span>
        </div>
      </div>

      <div class="log-terminal" id="logTerminal">
        <div class="log-item">
          <span class="log-time">--:--:--</span>
          <span class="log-msg">タスクの初期化を待っています...</span>
        </div>
      </div>

      <div id="resultCard" class="result-view" style="display: none;"></div>
    </div>
  </div>

  <script>
    let currentTaskId = null;
    let currentApprovalId = null;
    let pollInterval = null;

    const PRESETS = {
      multistep: {
        goal: '名前の欄に genie、住所の欄に tokyo と入力して保存ボタンを押す',
        criteria: '画面に保存しましたと表示されている'
      },
      typing: {
        goal: '表示されている単語を入力欄に打ち込む。単語が変わったら次の単語も打つ',
        criteria: 'スコアが 3 / 3 になっている、画面に CLEAR と表示されている'
      },
      native: {
        goal: 'Open the details in my disposable test app',
        criteria: 'The details heading and contents are visible'
      }
    };

    function setPreset(key) {
      const p = PRESETS[key];
      if (!p) return;
      document.getElementById('goal').value = p.goal;
      document.getElementById('criteria').value = p.criteria;
    }

    async function openFixture(type) {
      addLog('fixture', \`\${type} ターゲットを開いています...\`);
      try {
        const res = await fetch('/api/open-fixture', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type })
        });
        const data = await res.json();
        addLog('fixture', data.message || 'ターゲットを開きました');
      } catch (err) {
        addLog('error', 'ターゲットのオープンに失敗しました: ' + err.message);
      }
    }

    async function checkStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.ready) {
          document.getElementById('statusBadges').innerHTML = \`
            <div class="badge ready"><span class="badge-dot"></span>Gateway 接続中 (:43123)</div>
            <div class="badge"><span class="badge-dot" style="background:#60a5fa"></span>モデル: \${data.model || 'qwen3.5:9b'}</div>
            <div class="badge"><span class="badge-dot" style="background:#a78bfa"></span>非干渉AXモード</div>
          \`;
        }
      } catch (e) {
        document.getElementById('statusBadges').innerHTML = \`
          <div class="badge" style="color:#ef4444"><span class="badge-dot"></span>Gateway未接続</div>
        \`;
      }
    }

    function addLog(source, msg) {
      const term = document.getElementById('logTerminal');
      const time = new Date().toLocaleTimeString();
      const div = document.createElement('div');
      div.className = 'log-item';
      div.innerHTML = \`<span class="log-time">\${time}</span><span class="log-msg">[\${source}] \${msg}</span>\`;
      term.appendChild(div);
      term.scrollTop = term.scrollHeight;
    }

    async function startTask() {
      const goal = document.getElementById('goal').value.trim();
      const criteria = document.getElementById('criteria').value.trim();
      if (!goal || !criteria) {
        alert('目的と完了条件を入力してください。');
        return;
      }

      document.getElementById('btnStart').disabled = true;
      document.getElementById('taskCard').style.display = 'block';
      document.getElementById('logTerminal').innerHTML = '';
      document.getElementById('resultCard').style.display = 'none';
      document.getElementById('approvalBanner').style.display = 'none';
      document.getElementById('runningNotice').style.display = 'none';

      addLog('client', 'タスクを作成しています...');

      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ goal, criteria })
        });
        if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
        const task = await res.json();
        currentTaskId = task.id;
        addLog('gateway', \`タスクが作成されました (ID: \${task.id})\`);
        updateStatus(task.status);
        startPolling();
      } catch (err) {
        addLog('error', 'タスク作成失敗: ' + err.message);
        document.getElementById('btnStart').disabled = false;
      }
    }

    function updateStatus(status) {
      const pill = document.getElementById('taskStatusPill');
      pill.textContent = status;
      pill.className = 'status-pill status-' + status;
    }

    function startPolling() {
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(pollTask, 1500);
      pollTask();
    }

    async function pollTask() {
      if (!currentTaskId) return;
      try {
        const res = await fetch('/api/tasks/' + encodeURIComponent(currentTaskId));
        if (!res.ok) return;
        const data = await res.json();
        const task = data.task;
        updateStatus(task.status);

        if (task.status === 'WAITING_APPROVAL') {
          document.getElementById('runningNotice').style.display = 'none';
          if (data.approvals && data.approvals.length > 0) {
            currentApprovalId = data.approvals[0].id;
            document.getElementById('approvalBanner').style.display = 'block';
            addLog('task', '画面操作の承認待ちです (Approval ID: ' + currentApprovalId + ')');
          }
        } else if (task.status === 'RUNNING') {
          document.getElementById('approvalBanner').style.display = 'none';
          document.getElementById('runningNotice').style.display = 'block';
        } else if (task.status === 'COMPLETED' || task.status === 'FAILED') {
          clearInterval(pollInterval);
          pollInterval = null;
          document.getElementById('approvalBanner').style.display = 'none';
          document.getElementById('runningNotice').style.display = 'none';
          document.getElementById('btnStart').disabled = false;

          if (task.status === 'COMPLETED') {
            addLog('task', '🎉 タスクが正常に完了しました！');
            if (data.artifact) {
              const resCard = document.getElementById('resultCard');
              resCard.style.display = 'block';
              resCard.textContent = data.artifact;
            }
          } else {
            addLog('task', '❌ タスクが停止しました: ' + (task.error?.message || '不明なエラー'));
          }
        }
      } catch (e) {
        // ignore network glitches
      }
    }

    async function cancelTask() {
      if (!currentTaskId) return;
      try {
        await fetch(\`/api/tasks/\${encodeURIComponent(currentTaskId)}/cancel\`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        });
        addLog('client', '中止要求を送信しました');
      } catch (err) {
        addLog('error', '中止要求失敗: ' + err.message);
      }
    }

    checkStatus();
    setInterval(checkStatus, 5000);
  </script>
</body>
</html>`;

async function main() {
  const { config } = await loadRuntimeConfig();
  const base = `http://127.0.0.1:${config.port}`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const method = req.method;

    // CORS は付けない（このページ自身のほかに読ませない）。
    const sendJSON = (code, data) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    // 名前の書き換え（DNS rebinding）で別の名前から来たものは受けない。
    const origins = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
    if (!origins.includes(`http://${req.headers.host ?? ''}`)) {
      sendJSON(403, { error: 'Forbidden host' });
      return;
    }
    // 書き込みは、このページからの JSON だけ。ほかのサイトの form / text/plain の POST
    // （プリフライトの起きない形）で依頼や中止を送らせない。
    if (method !== 'GET') {
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!origins.includes(String(req.headers.origin ?? '')) || type !== 'application/json') {
        sendJSON(403, { error: 'Forbidden origin' });
        return;
      }
    }

    try {
      if (url.pathname === '/' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(HTML_CONTENT);
        return;
      }

      if (url.pathname === '/api/status' && method === 'GET') {
        sendJSON(200, {
          ready: true,
          gateway: base,
          model: config.model,
        });
        return;
      }

      if (url.pathname === '/api/open-fixture' && method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          const { type } = JSON.parse(body || '{}');
          if (type === 'multistep') {
            await execFileAsync('open', [join(ROOT, 'tools/computer-use/multistep-fixture.html')]);
            sendJSON(200, { message: 'multistep-fixture.html をブラウザで開きました' });
          } else if (type === 'typing') {
            await execFileAsync('open', [join(ROOT, 'tools/computer-use/typing-fixture.html')]);
            sendJSON(200, { message: 'typing-fixture.html をブラウザで開きました' });
          } else if (type === 'native') {
            const appPath = join(ROOT, '.build/GenieTest.app/Contents/MacOS/GenieTestApp');
            execFile(appPath, { env: { ...process.env, GENIE_TEST_RESULT: '/tmp/genie-test-result.json' } });
            sendJSON(200, { message: 'GenieTestApp を起動しました' });
          } else {
            sendJSON(400, { error: 'Unknown fixture' });
          }
        });
        return;
      }

      const token = await getAccessToken(base, config.identity);
      const authHeaders = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      };

      if (url.pathname === '/api/tasks' && method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          const { goal, criteria } = JSON.parse(body || '{}');
          const taskReq = {
            kind: 'computer.run',
            input: { goal, successCriteria: criteria },
          };
          const gRes = await fetch(`${base}/v1/tasks`, {
            method: 'POST',
            headers: {
              ...authHeaders,
              'idempotency-key': randomUUID(),
            },
            body: JSON.stringify(taskReq),
          });
          const task = await gRes.json();
          sendJSON(gRes.status, task);
        });
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/);
      if (taskMatch && method === 'GET') {
        const taskId = taskMatch[1];
        const gRes = await fetch(`${base}/v1/tasks/${encodeURIComponent(taskId)}`, {
          headers: authHeaders,
        });
        const task = await gRes.json();
        let approvals = [];
        if (task.status === 'WAITING_APPROVAL') {
          const aRes = await fetch(`${base}/v1/tasks/${encodeURIComponent(taskId)}/approvals`, {
            headers: authHeaders,
          });
          const aData = await aRes.json();
          approvals = aData.items || [];
        }
        let artifact = null;
        if (task.status === 'COMPLETED' && task.result_artifact_id) {
          const artRes = await fetch(`${base}/v1/artifacts/${encodeURIComponent(task.result_artifact_id)}/content`, {
            headers: authHeaders,
          });
          if (artRes.ok) artifact = await artRes.text();
        }
        sendJSON(200, { task, approvals, artifact });
        return;
      }

      const cancelMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/cancel$/);
      if (cancelMatch && method === 'POST') {
        const taskId = cancelMatch[1];
        const cRes = await fetch(`${base}/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ reason: 'user_cancelled_from_ui' }),
        });
        sendJSON(cRes.status, await cRes.json().catch(() => ({})));
        return;
      }

      sendJSON(404, { error: 'Not found' });
    } catch (err) {
      console.error(err);
      sendJSON(500, { error: err.message });
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`GENIE_COMPUTER_USE_UI_READY http://127.0.0.1:${PORT}`);
    execFileAsync('open', [`http://127.0.0.1:${PORT}`]).catch(() => {});
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
