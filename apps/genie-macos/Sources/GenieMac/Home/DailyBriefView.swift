import AppKit
import SwiftUI

/// A reading surface for the saved, source-backed brief. Text is display data;
/// only an explicit button press opens a source or requests another read.
struct DailyBriefView: View {
    let card: BriefCard?
    let composing: Bool
    let failure: String?
    let preferences: BriefPreferences
    let scheduleLabel: String
    var now = Date()
    var onRefresh: () -> Void
    var onPreferences: (BriefPreferences) -> String?
    var onLocationAuthorization: () -> Void
    var onConnections: () -> Void
    var onWork: () -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var settingsOpen = false
    @State private var settingsUseCurrentLocation: Bool?
    @State private var detail: DailyBriefDetail?
    private var dark: Bool { scheme == .dark }

    var body: some View {
        VStack(alignment: .leading, spacing: S.metric(Space.cardPadding)) {
            header
            if composing {
                HStack(spacing: Space.base) {
                    ProgressView().controlSize(.small)
                    Text(card == nil ? "今日の情報を取得しています…" : "保存済みの内容を表示しています。更新中…")
                }
                .font(.system(size: S.type(TypeScale.secondarySize)))
                .foregroundStyle(Palette.muted(dark))
                .accessibilityIdentifier("dailyBriefLoading")
            } else if let failure {
                Label(failure, systemImage: "exclamationmark.circle")
                    .font(.system(size: S.type(TypeScale.secondarySize)))
                    .foregroundStyle(Palette.warning(dark))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("dailyBriefFailure")
            }
            if let card, card.date != BriefStore.day(now) {
                Text("\(card.date) の保存分です。更新してください。")
                    .font(.system(size: S.type(TypeScale.secondarySize)))
                    .foregroundStyle(Palette.warning(dark))
                    .accessibilityIdentifier("dailyBriefPreviousDay")
            } else if !composing, failure == nil, let summary = card?.summary, !summary.isEmpty {
                // 更新中・失敗のときは、その状態の 1 行が冒頭を占める（4 つの話題を最初の画面に収める）。
                // 今日、何が中心か。前日の保存分では出さない（昨日の予定を今日の要点にしない）。
                Text(summary.joined())
                    .font(.system(size: S.type(TypeScale.bodySize), weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("dailyBriefSummary")
            }
            Grid(alignment: .topLeading, horizontalSpacing: S.metric(Space.largePadding), verticalSpacing: S.metric(Space.cardPadding)) {
                GridRow {
                    subject("mail")
                    subject("news")
                }
                Rectangle().fill(Color.hairline(dark)).frame(height: 0.5)
                    .gridCellColumns(2)
                GridRow {
                    subject("markets")
                    subject("weather")
                }
            }
            .accessibilityIdentifier("dailyBriefSubjects")
            supplementary
        }
        .foregroundStyle(Palette.text(dark))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dailyBrief")
        .onPreferenceChange(DailyBriefLayoutKey.self) { frames in
            if CommandLine.arguments.contains("--selftest") { DailyBriefMeasurements.frames = frames }
        }
        .sheet(isPresented: $settingsOpen) {
            DailyBriefSettings(preferences: settingsPreferences, onSave: onPreferences)
        }
        .sheet(item: $detail) { selected in
            DailyBriefSectionDetail(section: selected.section, onWork: onWork)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Space.base) {
            HStack(alignment: .firstTextBaseline, spacing: Space.base) {
                Text("今日のまとめ")
                    .font(.system(size: S.type(TypeScale.pageTitleSize), weight: TypeScale.pageTitleWeight))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: Space.base)
                Button(action: onRefresh) {
                    Label(composing ? "更新中" : "更新", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(composing)
                .accessibilityIdentifier("dailyBriefRefresh")
                ProbeButton(id: "dailyBriefSettings", action: { settingsUseCurrentLocation = nil; settingsOpen = true }) { Text("表示内容") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("今日のまとめの表示内容と時刻を変更")
                    .accessibilityIdentifier("dailyBriefSettings")
            }
            .font(.system(size: S.type(TypeScale.secondarySize)))
            Text(now.formatted(.dateTime.locale(Locale(identifier: "ja_JP")).month().day().weekday()) + " · " + scheduleLabel)
                .font(.system(size: S.type(TypeScale.secondarySize)))
                .foregroundStyle(Palette.muted(dark))
        }
    }

    private func subject(_ id: String) -> some View {
        let section = card?.sections.first { $0.id == id }
        return DailyBriefSubject(id: id, section: section, composing: composing,
                                 noCard: card == nil, useCurrentLocation: preferences.useCurrentLocation,
                                 onRefresh: onRefresh,
                                 onSettings: {
                                     settingsUseCurrentLocation = id == "weather" ? false : nil
                                     settingsOpen = true
                                 }, onLocationAuthorization: onLocationAuthorization, onConnections: onConnections,
                                 onDetail: { if let section { detail = DailyBriefDetail(section: section) } })
            .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private var settingsPreferences: BriefPreferences {
        var value = preferences
        if let settingsUseCurrentLocation { value.useCurrentLocation = settingsUseCurrentLocation }
        return value
    }

    @ViewBuilder private var supplementary: some View {
        // Cached Work inferences are not fresh mail analysis. Keep them in Work
        // rather than presenting old inferred items as today's required actions.
        let extra = card?.sections.filter { $0.id == "calendar" && !$0.lines.isEmpty } ?? []
        if !extra.isEmpty {
            VStack(alignment: .leading, spacing: Space.compact) {
                ForEach(extra, id: \.id) { section in
                    Button { detail = DailyBriefDetail(section: section) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: Space.base) {
                            Text("予定")
                            Text(section.lines.first?.text ?? "").lineLimit(1)
                            Spacer(minLength: 0)
                            Text("\(section.lines.count)件").fixedSize()
                            Image(systemName: "chevron.right").accessibilityHidden(true)
                        }.contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: S.type(TypeScale.secondarySize)))
                    .foregroundStyle(Palette.muted(dark))
                    .accessibilityIdentifier("dailyBriefSupplement-" + section.id)
                }
            }
        }
    }
}

private struct DailyBriefDetail: Identifiable {
    let section: BriefCard.Section
    var id: String { section.id }
}

private struct DailyBriefSubject: View {
    let id: String
    let section: BriefCard.Section?
    let composing: Bool
    let noCard: Bool
    let useCurrentLocation: Bool
    let onRefresh: () -> Void
    let onSettings: () -> Void
    let onLocationAuthorization: () -> Void
    let onConnections: () -> Void
    let onDetail: () -> Void
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    private var lines: [BriefCard.Line] { section?.lines ?? [] }
    // 天気は 1 行（雨の助言は傘が要るときだけ冒頭の要約に出る。詳しくで全行）。
    private var limit: Int { id == "markets" ? 3 : (id == "weather" ? 1 : 2) }
    private var title: String {
        switch id { case "mail": return "メール"; case "news": return "ニュース"; case "markets": return "株価"; default: return "天気" }
    }
    private var emptyText: String {
        if composing && noCard { return "取得しています…" }
        guard let section else { return "まだ取得していません" }
        if section.status == "ok" { return id == "mail" ? "対象のメールはありません" : "表示できる情報はありません" }
        if section.status == "stale" { return "取得できませんでした" }
        return id == "mail" ? "メールを接続して確認できます" : "表示する内容を設定できます"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.base) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.system(size: S.type(TypeScale.cardTitleSize), weight: TypeScale.cardTitleWeight))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: Space.compact)
                if section != nil, !lines.isEmpty {
                    ProbeButton(id: "dailyBriefDetail-" + id, action: onDetail) { Text("詳しく") }
                        .buttonStyle(.borderless)
                        .font(.system(size: S.type(TypeScale.secondarySize)))
                        .accessibilityLabel(title + "を詳しく見る")
                        .accessibilityIdentifier("dailyBriefDetail-" + id)
                }
            }
            if !lines.isEmpty {
                ForEach(Array(lines.prefix(limit).enumerated()), id: \.offset) { _, line in
                    VStack(alignment: .leading, spacing: Space.compact) {
                        DailyBriefSourceLine(line: line, lineLimit: 2)
                        if let subtitle = line.subtitle, !subtitle.isEmpty {
                            Text(subtitle)
                                // 副題は差出人・媒体・前日比などの付記。どの話題も出所の行と同じ段にそろえる。
                                .font(.system(size: S.type(TypeScale.microSize)))
                                .foregroundStyle(Palette.muted(dark))
                                // 先頭に前日比と「いつの値か」。残りは help と詳しくで読める。
                                .lineLimit(1)
                                .help(subtitle)
                        }
                    }
                }
            } else {
                Text(emptyText)
                    .font(.system(size: S.type(TypeScale.bodySize)))
                    .foregroundStyle(Palette.muted(dark))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let section, section.status != "ok" {
                Text((section.status == "stale" ? (lines.isEmpty ? "未更新" : "一部未更新") : "未設定") + (section.reason.map { " · " + $0 } ?? ""))
                    .font(.system(size: S.type(TypeScale.secondarySize)))
                    .foregroundStyle(section.status == "stale" ? Palette.warning(dark) : Palette.muted(dark))
                    .lineLimit(2)
                    .help(section.reason ?? "")
            }
            if let section, !section.sources.isEmpty || section.fetchedAt != nil {
                Text(DailyBriefFormatting.provenance(section))
                    .font(.system(size: S.type(TypeScale.microSize)))
                    .foregroundStyle(Palette.muted(dark))
                    .lineLimit(2)
                    .accessibilityIdentifier("dailyBriefSource-" + id)
            }
            if section?.status != "ok" {
                if section?.status == "none" {
                    if id == "weather", useCurrentLocation {
                        if DailyBriefFormatting.locationRecovery(section?.reason) == .authorize {
                            Button("現在地の利用を許可") {
                                if !composing { onLocationAuthorization() }
                            }
                            .buttonStyle(.borderless)
                            .font(.system(size: S.type(TypeScale.secondarySize)))
                            .disabled(composing)
                            .accessibilityIdentifier("dailyBriefAuthorizeLocation")
                        } else if DailyBriefFormatting.locationRecovery(section?.reason) == .settings {
                            Button("システム設定で位置情報を確認") {
                                // Same native privacy-pane pattern as Permissions.openMicrophoneSettings.
                                // This opens the pane only; it does not change a permission.
                                if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices") {
                                    NSWorkspace.shared.open(url)
                                }
                            }
                            .buttonStyle(.borderless)
                            .font(.system(size: S.type(TypeScale.secondarySize)))
                            .accessibilityIdentifier("dailyBriefLocationSettings")
                        }
                        Button("地域を指定", action: onSettings)
                            .buttonStyle(.borderless)
                            .font(.system(size: S.type(TypeScale.secondarySize)))
                            .accessibilityIdentifier("dailyBriefManualLocation")
                    } else {
                        Button(id == "mail" ? "メールを接続" : "表示内容を設定", action: id == "mail" ? onConnections : onSettings)
                            .buttonStyle(.borderless)
                            .font(.system(size: S.type(TypeScale.secondarySize)))
                            .accessibilityIdentifier("dailyBriefSetup-" + id)
                    }
                } else if !composing {
                    Button(section == nil ? "取得する" : "再試行", action: onRefresh)
                        .buttonStyle(.borderless)
                        .font(.system(size: S.type(TypeScale.secondarySize)))
                        .accessibilityIdentifier("dailyBriefRetry-" + id)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dailyBriefSection-" + id)
        .background {
            if CommandLine.arguments.contains("--selftest") {
                GeometryReader { geometry in
                    Color.clear.preference(key: DailyBriefLayoutKey.self, value: [id: geometry.frame(in: .global)])
                }
            }
        }
    }
}

private struct DailyBriefSourceLine: View {
    let line: BriefCard.Line
    var lineLimit: Int? = nil
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Group {
            if let url = DailyBriefFormatting.sourceURL(line.url) {
                Link(destination: url) { text.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .help("出所を開く · " + (url.host ?? ""))
            } else { text }
        }
        .font(.system(size: S.type(TypeScale.bodySize)))
        .foregroundStyle(Palette.text(scheme == .dark))
    }
    private var text: some View { Text(line.text).lineLimit(lineLimit).fixedSize(horizontal: false, vertical: true).help(line.text) }
}

enum DailyBriefFormatting {
    enum LocationRecovery { case authorize, settings, manual }
    static func locationRecovery(_ reason: String?) -> LocationRecovery {
        switch reason {
        case "現在地の天気には位置情報の許可が必要です": return .authorize
        case "位置情報が許可されていません": return .settings
        default: return .manual
        }
    }
    static func sourceURL(_ value: String?) -> URL? {
        guard let value, let url = URL(string: value), url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return nil }
        return url
    }
    static func timestamp(_ value: String?) -> String {
        guard let value else { return "取得時刻不明" }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return "取得時刻不明" }
        return date.formatted(.dateTime.locale(Locale(identifier: "ja_JP")).month().day().hour().minute()) + "取得"
    }
    static func provenance(_ section: BriefCard.Section) -> String {
        let names = Array(Set(section.sources.map(\.name))).sorted().joined(separator: " / ")
        return (names.isEmpty ? "" : names + " · ") + timestamp(section.fetchedAt)
    }
}

private struct DailyBriefSectionDetail: View {
    let section: BriefCard.Section
    let onWork: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: Space.cardPadding) {
            HStack {
                Text(section.id == "markets" ? "株価" : section.title)
                    .font(.system(size: S.type(TypeScale.sectionTitleSize), weight: TypeScale.sectionTitleWeight))
                Spacer()
                ProbeButton(id: "dailyBriefDetailClose", action: { dismiss() }) { Text("閉じる") }.keyboardShortcut(.cancelAction)
            }
            Text(DailyBriefFormatting.provenance(section))
                .font(.system(size: S.type(TypeScale.secondarySize))).foregroundStyle(Palette.muted(scheme == .dark))
            ScrollView {
                VStack(alignment: .leading, spacing: Space.cardPadding) {
                    if section.status != "ok" {
                        Text((section.status == "stale" ? "未更新" : "未設定") + (section.reason.map { " · " + $0 } ?? ""))
                    }
                    ForEach(Array(section.lines.enumerated()), id: \.offset) { _, line in
                        VStack(alignment: .leading, spacing: Space.compact) {
                            DailyBriefSourceLine(line: line)
                            if let subtitle = line.subtitle { Text(subtitle).foregroundStyle(Palette.muted(scheme == .dark)) }
                            if let received = line.receivedAt {
                                Text(DailyBriefFormatting.timestamp(received).replacingOccurrences(of: "取得", with: "受信"))
                                    .font(.system(size: S.type(TypeScale.microSize)))
                                    .foregroundStyle(Palette.muted(scheme == .dark))
                            }
                            if let url = DailyBriefFormatting.sourceURL(line.url) {
                                Link(section.id == "mail" ? "元のメールを開く" : "出所を開く", destination: url)
                                    .font(.system(size: S.type(TypeScale.secondarySize)))
                            }
                        }
                    }
                    if section.id == "attention" {
                        Button("Workで対応事項を確認") { dismiss(); onWork() }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.system(size: S.type(TypeScale.bodySize)))
        }
        .padding(Space.largePadding)
        .frame(width: 560, height: 480)
        .background(Palette.canvas(scheme == .dark))
        .accessibilityIdentifier("dailyBriefDetail")
    }
}

private struct DailyBriefSettings: View {
    let preferences: BriefPreferences
    let onSave: (BriefPreferences) -> String?
    @State private var region: String
    @State private var useCurrentLocation: Bool
    @State private var interests: String
    @State private var watchlist: String
    @State private var hour: Int
    @State private var minute: Int
    @State private var enabled: Bool
    @State private var issue: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    init(preferences: BriefPreferences, onSave: @escaping (BriefPreferences) -> String?) {
        self.preferences = preferences; self.onSave = onSave
        _region = State(initialValue: preferences.region)
        _useCurrentLocation = State(initialValue: preferences.useCurrentLocation)
        _interests = State(initialValue: preferences.interests.joined(separator: "、"))
        _watchlist = State(initialValue: preferences.watchlist.joined(separator: ", "))
        _hour = State(initialValue: preferences.hour); _minute = State(initialValue: preferences.minute)
        _enabled = State(initialValue: preferences.enabled)
    }

    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: Space.cardPadding) {
            Text("今日のまとめの表示内容")
                .font(.system(size: S.type(TypeScale.sectionTitleSize), weight: TypeScale.sectionTitleWeight))
            VStack(alignment: .leading, spacing: Space.compact) {
                Toggle("現在地付近の天気", isOn: $useCurrentLocation)
                    .accessibilityIdentifier("dailyBriefUseCurrentLocation")
                Text("現在地は天気の取得に使います。送信先: Open-Meteo（約1km単位）")
                    .font(.system(size: S.type(TypeScale.microSize))).foregroundStyle(Palette.muted(scheme == .dark))
                    .fixedSize(horizontal: false, vertical: true)
                Text("指定する地域・都市")
                TextField("例：東京都、大阪市", text: $region)
                    .textFieldStyle(.roundedBorder).accessibilityIdentifier("dailyBriefRegion")
                    .disabled(useCurrentLocation)
            }
            VStack(alignment: .leading, spacing: Space.compact) {
                Text("ニュースの関心（3つまで）")
                TextField("例：テクノロジー、経済、文化", text: $interests)
                    .textFieldStyle(.roundedBorder).accessibilityIdentifier("dailyBriefInterests")
                Text("カンマや読点で区切ります。空欄なら主なニュースを表示します。")
                    .font(.system(size: S.type(TypeScale.microSize))).foregroundStyle(Palette.muted(scheme == .dark))
            }
            VStack(alignment: .leading, spacing: Space.compact) {
                Text("株価の銘柄コード")
                TextField("例：^N225, ^GSPC, ^IXIC", text: $watchlist)
                    .textFieldStyle(.roundedBorder).accessibilityIdentifier("dailyBriefWatchlist")
                Text("カンマで区切ります。数値は提供元の観測時刻の参考値です。")
                    .font(.system(size: S.type(TypeScale.microSize))).foregroundStyle(Palette.muted(scheme == .dark))
            }
            Divider()
            Toggle("毎日、自動で更新する", isOn: $enabled).accessibilityIdentifier("dailyBriefAutomatic")
            HStack {
                Text("更新時刻")
                Picker("時", selection: $hour) { ForEach(0..<24, id: \.self) { Text(String(format: "%02d", $0)).tag($0) } }
                Picker("分", selection: $minute) { ForEach(0..<60, id: \.self) { Text(String(format: "%02d", $0)).tag($0) } }
            }.disabled(!enabled)
            Text("Genie起動中に更新。スリープ中は復帰後に取得します。")
                .font(.system(size: S.type(TypeScale.microSize))).foregroundStyle(Palette.muted(scheme == .dark))
            if let issue { Text(issue).foregroundStyle(Palette.warning(scheme == .dark)).accessibilityIdentifier("dailyBriefSettingsFailure") }
            HStack {
                Spacer()
                ProbeButton(id: "dailyBriefSettingsCancel", action: { dismiss() }) { Text("やめる") }.keyboardShortcut(.cancelAction)
                ProbeButton(id: "dailyBriefSettingsSave", action: {
                    var updated = preferences
                    updated.region = region.trimmingCharacters(in: .whitespacesAndNewlines)
                    updated.useCurrentLocation = useCurrentLocation
                    updated.interests = Self.split(interests)
                    updated.watchlist = Self.split(watchlist)
                    updated.hour = hour; updated.minute = minute; updated.enabled = enabled
                    issue = onSave(updated)
                    if issue == nil { dismiss() }
                }) { Text("保存して更新") }.buttonStyle(.borderedProminent).accessibilityIdentifier("dailyBriefSettingsSave")
            }
        }
        .font(.system(size: S.type(TypeScale.secondarySize)))
        .padding(Space.largePadding)
        }
        .frame(width: 500, height: 560)
        .background(Palette.canvas(scheme == .dark))
        .accessibilityIdentifier("dailyBriefPreferences")
    }

    private static func split(_ value: String) -> [String] {
        value.components(separatedBy: CharacterSet(charactersIn: ",、\n"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
}

private struct DailyBriefLayoutKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, newest in newest })
    }
}

/// Selftest-only geometry; never records content, account data or screen pixels.
@MainActor enum DailyBriefMeasurements {
    static var frames: [String: CGRect] = [:]
}
