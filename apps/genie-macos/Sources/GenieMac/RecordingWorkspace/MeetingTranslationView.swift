import SwiftUI

/// Shared by the Dock and detached workspace; controls and results stay together.
struct MeetingTranslationView: View {
    @ObservedObject var model: MeetingTranslation
    var compact = false
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    private var textSize: CGFloat { compact ? S.type(Metrics.dockRowSize) : TypeScale.microSize }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(Facts.translationTarget)
                ForEach(TranslationLanguage.allCases) { language in
                    Button { model.setLanguage(language) } label: {
                        Text(language.title).padding(.horizontal, 10).frame(height: 32)
                    }
                        .buttonStyle(GenieControlStyle(radius: 7, base: model.language == language ? 0.10 : 0))
                        .accessibilityAddTraits(model.language == language ? .isSelected : [])
                        .accessibilityIdentifier("translationLanguage-\(language.rawValue)")
                }
                Spacer(minLength: 8)
                Toggle(Facts.translationAuto, isOn: Binding(get: { model.enabled }, set: model.setEnabled))
                    .toggleStyle(.switch).controlSize(.small).fixedSize()
                    .accessibilityIdentifier("translationAutoUpdate")
            }
            .font(.system(size: textSize))
            HStack {
                if model.availableEngines.count > 1 {
                    ForEach(model.availableEngines) { engine in
                        Button { model.setEngine(engine) } label: {
                            Text(engine.title).padding(.horizontal, 8).frame(height: 32)
                        }
                            .buttonStyle(GenieControlStyle(radius: 7, base: model.engine == engine ? 0.10 : 0))
                            .accessibilityAddTraits(model.engine == engine ? .isSelected : [])
                            .accessibilityIdentifier("translationEngine-\(engine.rawValue)")
                            .help(engine == .codex ? "Codex 接続で発言を OpenAI に送って翻訳します。ローカルモデルへの自動切替はありません。" : engine.title)
                    }
                } else { Text("このMacで翻訳 · \(MeetingTranslationClient.localModel)") }
                Spacer(minLength: 0)
                if model.isTranslating { Text("翻訳中 · 残り\(model.pendingCount)件") }
            }
            .font(.system(size: compact ? S.type(Metrics.dockMetaSize) : TypeScale.captionSize))
            .foregroundStyle(Palette.muted(dark))
            if let failure = model.failure {
                Text(failure).foregroundStyle(Palette.danger(dark))
                    .font(.system(size: textSize)).fixedSize(horizontal: false, vertical: true)
                Button { model.retry() } label: {
                    Text(Facts.translationRetry).padding(.horizontal, 10).frame(height: 32)
                }
                    .buttonStyle(GenieControlStyle(radius: 7, base: 0))
                    .accessibilityIdentifier("translationRetry")
            }
            if model.rows.isEmpty && !model.isTranslating && model.failure == nil {
                Text(model.enabled ? "発言が確定すると翻訳します。" : "自動更新をオンにすると、発言を順に翻訳します。")
                    .font(.system(size: textSize)).foregroundStyle(Palette.muted(dark))
                    .fixedSize(horizontal: false, vertical: true)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(model.displayRows) { row in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(row.source.speaker) · \(row.source.timeLabel)")
                                    .font(.system(size: compact ? S.type(Metrics.dockMetaSize) : TypeScale.captionSize))
                                    .foregroundStyle(Palette.accent(dark))
                                Text(row.translation ?? row.source.text).font(.system(size: textSize))
                                    .foregroundStyle(Palette.text(dark)).fixedSize(horizontal: false, vertical: true)
                                Text(row.translation != nil ? row.source.text : model.enabled && model.failure == nil ? "翻訳を待っています…" : "未翻訳")
                                    .font(.system(size: compact ? S.type(Metrics.dockMetaSize) : TypeScale.captionSize))
                                    .foregroundStyle(Palette.muted(dark)).fixedSize(horizontal: false, vertical: true)
                            }.id(row.id).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .onChange(of: model.rows.count) {
                    if let last = model.displayRows.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
                .onChange(of: model.displayRows.count) {
                    if let last = model.displayRows.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("meetingTranslation")
    }
}
