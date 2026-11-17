#!/usr/bin/env python3
"""Genie の動くアーキテクチャ図（live-panel 用 config）を作る。

実装（2026-10-05 の genie リポジトリ）にあるものだけを描く:
  VoiceInputHub / LiveKitWakeDetector(genie_ja.onnx) / GeminiLiveProvider(gemini-3.8-live, googleSearch, delegate_task)
  / api-gateway conversations / services/task(Temporal, planTask) / workers/agent-host の各 runner / Dock(InfoCard)
動く数字（点数・件数）は演出（illustrative）。閾値 0.8・プレロール 2.0 s・保持 15 s は実装の値。
使い方: python3 genie_config.py > genie.json
"""
import json

C = {"bg": "#0d1117", "bar": "#1b2230", "line": "#3d4a5f", "line2": "#2f3a4c", "dim": "#6b778c", "mute": "#a7b0c0",
     "fg": "#e6ebf2", "wh": "#ffffff", "cy": "#5fe3f0", "gr": "#7fdba8", "pu": "#b9a2f2", "ye": "#e3c07a",
     "bl": "#8fb4f6", "hl": "#16303a", "dots": "#4a566b"}

machines = {
    "packets": {"type": "counter", "start": 2400, "rate": 9, "format": "comma"},
    "wake": {"type": "gauge", "values": [0.34, 0.59, 0.92, 0.31, 0.97, 0.41, 0.88], "threshold": 0.8, "period": 3.6,
             "t0": 0.4, "seed": 5, "decimals": 2,
             "high": {"label": "wake", "dest": "Gemini Live"}, "low": {"label": "standby", "dest": "local"},
             "log": {"who": "wake", "c": "gr", "msgs": ["genie_ja.onnx · 2 s window"], "tail": "score={value} → {label}"}},
    "delegate": {"type": "triggers", "color": "cy", "period": 4.6, "on": 3.1, "t0": -1.2, "callsStart": 1,
                 "onText": "routing", "offText": "on call",
                 "items": [
                     {"name": "見せて", "adv": ["» browser.open_official", "» 公式サイトを前面に"]},
                     {"name": "天気・ニュース", "adv": ["» info.lookup", "» Dock に InfoCard"]},
                     {"name": "注文したい", "adv": ["» checkout.open", "» 公式注文画面・未注文"]},
                     {"name": "Excel直して", "adv": ["» office.edit", "» 原本は変えずコピー"]}],
                 "log": {"who": "gemini", "c": "pu", "start": {"m": "delegate_task · {name}"},
                         "end": {"m": "{name} · done, reply by voice"}}},
    "talk": {"type": "lane", "period": 8, "run": 5.5, "off": 0.6, "busy": "listening", "done": ["replied"], "phase": 0,
             "log": {"who": "gemini", "c": "pu", "msgs": [["voice reply streamed · 24 kHz", ""]]}},
    "task": {"type": "lane", "period": 7, "run": 4.8, "off": 2.2, "busy": "planning", "done": ["planned"], "phase": 1,
             "log": {"who": "task", "c": "ye", "msgs": [["Temporal workflow · 1 step", ""]]}},
    "w0": {"type": "lane", "period": 9, "run": 6.0, "off": 1.0, "busy": "running", "done": ["opened"], "phase": 2},
    "w1": {"type": "lane", "period": 7.5, "run": 5.0, "off": 3.1, "busy": "running", "done": ["card"], "phase": 3},
    "w2": {"type": "lane", "period": 10, "run": 7.0, "off": 5.0, "busy": "running", "done": ["copy"], "phase": 4},
    "w3": {"type": "lane", "period": 8.5, "run": 6.0, "off": 6.2, "busy": "running", "done": ["done"], "phase": 5,
           "log": {"who": "host", "c": "bl", "msgs": [["computer.run · screenshot → click", ""]]}},
}

E = []
E.append({"type": "text", "x": 0, "w": 1200, "y": 78, "align": "center", "ls": 1, "runs": [
    {"t": "GENIE", "c": "wh", "b": 1}, {"t": "  ·  ", "c": "dim"}, {"t": "ON-DEVICE WAKE", "c": "gr", "b": 1},
    {"t": "  ·  ", "c": "dim"}, {"t": "GEMINI LIVE", "c": "pu", "b": 1}, {"t": "  ·  ", "c": "dim"},
    {"t": "MAC AGENT", "c": "bl", "b": 1}]})
E.append({"type": "rule", "x": 34, "y": 106, "w": 1132})
E.append({"type": "text", "x": 0, "w": 1200, "y": 138, "align": "center", "runs": [
    {"sw": "gr"}, {"t": "on this Mac", "c": "dim"}, {"t": "     ", "c": "dim"}, {"sw": "pu"}, {"t": "Gemini", "c": "dim"},
    {"t": "     ", "c": "dim"}, {"sw": "ye"}, {"t": "Genie services", "c": "dim"}, {"t": "     ", "c": "dim"},
    {"sw": "bl"}, {"t": "device tools", "c": "dim"}, {"t": "     ", "c": "dim"}, {"sw": "cy"}, {"t": "delegate_task", "c": "dim"}]})

# 左の柱: delegate_task の 4 つ
E.append({"type": "box", "x": 40, "y": 170, "w": 300, "h": 1010, "color": "cy", "pad": [13, 7, 7], "lines": [
    {"t": "delegate_task", "c": "cy", "b": 1}, {"t": "Gemini → Genie", "c": "cy"}, "",
    {"align": "left", "indent": 20, "c": "mute", "t": "見せて・開いて・注文・"},
    {"align": "left", "indent": 20, "c": "mute", "t": "Mac の作業は Genie へ。"},
    {"align": "left", "indent": 20, "c": "mute", "t": "確定の前は画面で確認。"},
    "", "", "", "", "", "", "", "", "",
    {"trigger": ["delegate", 0]}, {"trigger": ["delegate", 1]}, {"trigger": ["delegate", 2]}, {"trigger": ["delegate", 3]},
    "", "",
    {"align": "left", "indent": 20, "c": "mute", "t": "last route:"},
    {"align": "left", "indent": 20, "runs": [{"v": "delegate.adv0", "c": "cy", "b": 1}]},
    {"align": "left", "indent": 20, "runs": [{"v": "delegate.adv1", "c": "cy"}]}]})

# 1 段目: マイク → 呼びかけ
E.append({"type": "box", "x": 380, "y": 170, "w": 360, "h": 150, "color": "gr", "pad": [13, 14], "lines": [
    {"runs": [{"t": "MIC · VoiceInputHub", "c": "gr", "b": 1}]}, "one mic: wake + talk",
    {"runs": [{"t": "pre-roll ", "c": "dim"}, {"t": "2.0 s", "c": "gr", "b": 1}, {"t": " · hold ", "c": "dim"}, {"t": "≤15 s", "c": "gr", "b": 1}]},
    {"c": "dim", "t": "standby audio stays local"}]})
E.append({"type": "box", "x": 790, "y": 170, "w": 370, "h": 150, "color": "gr", "pad": [13, 14], "align": "left", "lines": [
    {"runs": [{"t": "WAKE · genie_ja.onnx", "c": "gr", "b": 1}]},
    {"c": "mute", "t": "LiveKit WakeWord · ONNX"},
    {"items": [{"w": 150, "bar": {"gauge": "wake", "w": 135, "h": 20, "high": "gr", "low": "dim"}},
               {"runs": [{"v": "wake", "c": "fg", "when": {"var": "wake.low", "ne": "1"}, "then": {"b": 1, "c": "wh"}},
                         {"t": " "}, {"v": "wake.label"}]}]},
    {"c": "dim", "t": "fires at 0.80 × 2 in a row"}]})
E.append({"type": "line", "from": [740, 245], "to": [790, 245]})

# 2 段目: Gemini Live
E.append({"type": "box", "x": 380, "y": 380, "w": 780, "h": 170, "color": "pu", "pad": [13, 14], "align": "left", "lines": [
    {"items": [{"w": 520, "runs": [{"t": "GEMINI LIVE · gemini-3.8-live", "c": "pu", "b": 1}]},
               {"align": "right", "grow": 1, "runs": [{"v": "talk"}]}]},
    {"runs": [{"t": "voice in/out", "c": "fg"}, {"t": " · interrupt · 16 kHz in / 24 kHz out", "c": "dim"}]},
    {"runs": [{"t": "tools ", "c": "dim"}, {"t": "googleSearch", "c": "pu"}, {"t": "  ", "c": "dim"}, {"t": "delegate_task", "c": "cy", "b": 1}]},
    {"runs": [{"t": "「ジーニー」だけ → ", "c": "dim"}, {"t": "「はい、どうされましたか？」", "c": "fg"}]}]})
E.append({"type": "line", "from": [975, 320], "to": [975, 380]})
E.append({"type": "line", "from": [560, 320], "to": [560, 380]})

# 3 段目: Genie services
E.append({"type": "box", "x": 380, "y": 610, "w": 780, "h": 140, "color": "ye", "pad": [13, 14], "align": "left", "lines": [
    {"items": [{"w": 520, "runs": [{"t": "GENIE SERVICES", "c": "ye", "b": 1}]}, {"align": "right", "grow": 1, "runs": [{"v": "task"}]}]},
    {"runs": [{"t": "api-gateway", "c": "fg"}, {"t": " · lane: 公式サイト / 注文 / Office / 天気", "c": "dim"}]},
    {"runs": [{"t": "task service", "c": "fg"}, {"t": " · Temporal · planTask · 承認", "c": "dim"}]}]})
E.append({"type": "line", "from": [770, 550], "to": [770, 610]})

# 4 段目: 端末の道具
# どの依頼（左の柱で光っているもの）がどの道具で動くか。光っている間その箱も光る。
W = [("browser", "open_official", "checkout.open", "w0", ["0", "2"]), ("info", "lookup", "weather/news", "w1", ["1"]),
     ("office", "edit", "docx / xlsx", "w2", ["3"]), ("computer", "run · vision", "screen + click", "w3", [])]
for i, (a, b, c2, m, lit) in enumerate(W):
    x = 380 + i * 198
    box = {"type": "box", "x": x, "y": 820, "w": 186, "h": 150, "color": "bl", "pad": [13, 12], "lines": [
        {"runs": [{"t": a, "c": "fg", "b": 1}]}, {"runs": [{"t": b, "c": "bl"}]}, {"c": "dim", "t": c2}, {"runs": [{"v": m}]}]}
    if lit:
        box["when"] = {"var": "delegate.active", "in": lit}
        box["then"] = {"color": "cy", "glow": "cy", "border": 3}
    E.append(box)
E.append({"type": "line", "from": [770, 750], "to": [770, 785]})
E.append({"type": "line", "from": [473, 785], "to": [1067, 785]})
for i in range(4):
    E.append({"type": "line", "from": [473 + i * 198, 785], "to": [473 + i * 198, 820]})

# 5 段目: 出口
E.append({"type": "box", "x": 380, "y": 1040, "w": 780, "h": 140, "color": "cy", "pad": [13, 14], "align": "left", "lines": [
    {"runs": [{"t": "OUT", "c": "cy", "b": 1}, {"t": "  what you see and hear", "c": "dim"}]},
    {"runs": [{"t": "Dock", "c": "fg"}, {"t": " InfoCard (天気・ニュース)  ", "c": "dim"}, {"t": "Browser", "c": "fg"}, {"t": " 公式ページ", "c": "dim"}]},
    {"runs": [{"t": "Voice", "c": "fg"}, {"t": " Gemini Live / Gemini TTS · 標準の声は使わない", "c": "dim"}]}]})
for i in range(4):
    E.append({"type": "line", "from": [473 + i * 198, 970], "to": [473 + i * 198, 1040]})

# 柱からの矢印（光っている依頼の行き先）
for i, y in enumerate([634, 663, 692, 721]):
    E.append({"type": "tarrow", "machine": "delegate", "i": i, "from": [345, y], "to": [378, y]})

flows = [
    ([[740, 245], [790, 245]], 1.6, [0], "gr"),
    ([[975, 320], [975, 380]], 2.2, [0.4], "gr"),
    ([[560, 320], [560, 380]], 1.8, [0.1, 0.9], "pu"),
    ([[770, 550], [770, 610]], 2.0, [0.2], "cy"),
    ([[770, 750], [770, 785], [473, 785], [473, 820]], 2.6, [0.3], "ye"),
    ([[770, 750], [770, 785], [1067, 785], [1067, 820]], 2.9, [1.2], "ye"),
    ([[671, 970], [671, 1040]], 2.1, [0.5], "bl"),
    ([[869, 970], [869, 1040]], 2.4, [1.4], "bl"),
]
for path, period, offsets, color in flows:
    E.append({"type": "flow", "path": path, "period": period, "offsets": offsets, "color": color})

E.append({"type": "log", "x": 40, "y": 1222, "w": 1120, "rows": 4, "padTop": 16, "padBottom": 29, "padLeft": 20,
          "title": "genie.log", "titleX": 38, "titleW": 150,
          "cols": [{"key": "time", "x": 0}, {"key": "who", "x": 126}, {"key": "m", "x": 250}, {"key": "g", "x": 760}]})
E.append({"type": "text", "x": 34, "y": 1410, "runs": [{"t": "~/genie $", "c": "gr", "b": 1}, {"t": " 「ジーニー、調子どう？」"}, {"cursor": True, "c": "gr"}]})
E.append({"type": "text", "x": 34, "y": 1442, "runs": [
    {"t": "wake ", "c": "dim"}, {"t": "[", "c": "gr", "b": 1}, {"v": "wake.label", "c": "gr", "b": 1}, {"t": "]", "c": "gr", "b": 1},
    {"t": "  delegate ", "c": "dim"}, {"t": "[", "c": "cy", "b": 1}, {"v": "delegate.status"}, {"t": "]", "c": "cy", "b": 1},
    {"t": "  packets ", "c": "dim"}, {"v": "packets", "c": "fg", "b": 1}, {"t": " (illustrative)", "c": "dim"}]})

config = {
    "meta": {"title": "Genie live system map", "lang": "ja"},
    "canvas": {"preset": "4:5", "width": 1200, "height": 1500, "duration": 30, "fps": 30, "preroll": 10},
    "theme": {"preset": "terminal-dark",
              "font": "\"JetBrains Mono\",\"SF Mono\",\"Menlo\",\"Osaka-Mono\",\"Hiragino Sans\",monospace",
              "fontSize": 19, "lineHeight": 29, "colors": C},
    "clock": {"start": "09:41:00", "rate": 2},
    "titlebar": {"text": "~/genie — live system map — Reachmade"},
    "credit": {"text": "Genie architecture from the genie repo (2026-10-05) · scores/counters illustrative · live-panel (method after @thedelost)", "y": 1484},
    "machines": machines,
    "elements": E,
}
print(json.dumps(config, ensure_ascii=False, indent=1))
