import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct ConnectorsPane: View {
    let apps: [String]
    @ObservedObject private var connections: ConnectorState
    init(apps: [String], connections: ConnectorState = .shared) {
        self.apps = apps; self.connections = connections
    }
    @Environment(\.colorScheme) private var scheme
    @State private var preview: String?
    @State private var configurationError: String?
    private var dark: Bool { scheme == .dark }
    private let providers = ["google", "microsoft"]
    private func title(_ provider: String) -> String { provider == "google" ? "Google Workspace" : "Microsoft 365" }
    private func sources(_ provider: String) -> [ConnectorState.Source] { connections.sources.filter { $0.provider == provider } }
    private func connected(_ provider: String) -> [ConnectorState.Source] { sources(provider).filter { connections.status[$0.statusKey] == .connected } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                WorkspaceHeader(title: Facts.appsConnectors,
                    subtitle: "いつものメールや予定を、次の仕事につなげる。")
                if let configurationError {
                    Text(configurationError).font(.system(size: TypeScale.secondarySize)).foregroundStyle(Palette.danger(dark))
                }
                if connections.sources.isEmpty {
                    Text("接続サービスを読み込めませんでした。アプリの同梱データを確認してください。")
                    Button("再読み込み") { connections.reloadSources(); connections.refresh() }
                }
                ForEach(providers, id: \.self) { provider in
                    if !sources(provider).isEmpty { providerCard(provider) }
                }
                Text("メールの送信や変更に必要な権限は、その操作を使うときに確認します。")
                    .font(.system(size: TypeScale.secondarySize)).foregroundStyle(Palette.muted(dark))
                DisclosureGroup("詳しい接続情報") {
                    VStack(alignment: .leading, spacing: 12) {
                Text("運営者の接続設定を使います。パスワードやトークンの入力は不要です。")
                        Button("接続設定を読み込む…") { importConfiguration() }
                        ForEach(connections.sources) { source in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(source.name).fontWeight(.medium)
                                Text(source.purpose)
                                Text(statusText(connections.status[source.statusKey] ?? .disconnected))
                            }
                        }
                    }.font(.system(size: TypeScale.microSize)).padding(.top, 12)
                }.font(.system(size: TypeScale.secondarySize))
                    .accessibilityIdentifier("connectionDiagnostics")
            }.foregroundStyle(Palette.text(dark)).padding(28)
                .frame(maxWidth: 900, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
        }.background(Palette.canvas(dark))
            .accessibilityElement(children: .contain).accessibilityIdentifier("connectionsPane")
            .task {
                // Fixtures do not authenticate or read live account data.
                guard !CommandLine.arguments.contains("--selftest") else { return }
                _ = await MainData.shared.ensureConnected(); connections.refresh()
            }
            .sheet(isPresented: Binding(get: { preview != nil }, set: { if !$0 { preview = nil } })) {
                if let provider = preview { purposeSheet(provider, dark: dark) }
            }
    }
    private func providerCard(_ provider: String) -> some View {
        let ready = connected(provider)
        let busy = connections.activeProvider == provider
        let configured = connections.configuredProviders().contains(provider)
        let needsRecovery = sources(provider).contains { if case .failed = connections.status[$0.statusKey] { return true }; return false }
        return VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: provider == "google" ? "envelope" : "square.grid.2x2")
                    .font(.system(size: 20)).foregroundStyle(Palette.muted(dark)).frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title(provider)).font(.system(size: TypeScale.cardTitleSize, weight: .medium))
                    if let account = connections.accounts[provider], !ready.isEmpty {
                        Text(account).font(.system(size: TypeScale.microSize)).textSelection(.enabled)
                    }
                }
                Spacer(minLength: 12)
                if busy {
                    ProgressView().controlSize(.small).accessibilityLabel("接続を処理中")
                } else if ready.count == sources(provider).count {
                    Label("接続済み", systemImage: "checkmark.circle.fill")
                        .font(.system(size: TypeScale.microSize)).foregroundStyle(Palette.success(dark))
                } else {
                    Button(configured ? (ready.isEmpty ? "接続" : "接続を完了") : "接続設定") {
                        if configured { preview = provider } else { importConfiguration() }
                    }.disabled(connections.activeProvider != nil)
                        .accessibilityIdentifier("connectProvider-\(provider)")
                }
            }
            Text(provider == "google" ? "会議の準備、必要なメール探し、初期Profileの作成に。" : "メール・会議・未完了タスクをまとめて、次にすることを整理。")
                .font(.system(size: TypeScale.bodySize)).fixedSize(horizontal: false, vertical: true)
            if !configured {
                Text("このプレビューの接続設定が必要です。「接続設定」から読み込めます。")
                    .font(.system(size: TypeScale.secondarySize)).foregroundStyle(Palette.muted(dark))
            }
            ForEach(sources(provider)) { source in
                let status = connections.status[source.statusKey] ?? .disconnected
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: status == .connected ? "checkmark.circle" : "circle")
                        .foregroundStyle(status == .connected ? Palette.success(dark) : Palette.muted(dark))
                    Text(source.name).font(.system(size: TypeScale.secondarySize))
                    Spacer(minLength: 12)
                    Text(statusText(status)).font(.system(size: TypeScale.microSize)).foregroundStyle(Palette.muted(dark))
                        .multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true)
                }.accessibilityElement(children: .combine).accessibilityIdentifier("workSource-\(source.pluginId)")
            }
            if let notice = connections.notice[provider] {
                Text(notice).font(.system(size: TypeScale.secondarySize)).foregroundStyle(Palette.muted(dark))
            }
            if busy || !ready.isEmpty || needsRecovery || connections.disconnectFailures.contains(provider) {
              HStack(spacing: 16) {
                if busy {
                    if sources(provider).contains(where: { connections.status[$0.statusKey] == .connecting }) {
                        Button("接続を中止") { connections.cancel() }.accessibilityIdentifier("cancelConnection-\(provider)")
                    }
                } else {
                    if !ready.isEmpty {
                        Button("Profileを確認") {
                            if InitialProfileStore.shared.result?.finished == true {
                                MainNav.shared.personalizationOpen = true
                            } else { InitialProfileStore.shared.connected(provider: provider) }
                            MainWindowController.shared.showSection(.home)
                        }
                        Button("会議の準備を頼む") {
                            MainNav.shared.intentDraft = "明日の会議の準備をしてください。予定と関連するメールを確認して、準備することを整理してください。"
                            MainWindowController.shared.showSection(.home); MainNav.shared.requestIntentFocus()
                        }
                    }
                    Spacer(minLength: 0)
                    Button("再確認") { Task { _ = await MainData.shared.ensureConnected(reconnect: true); connections.refresh() } }
                    if !ready.isEmpty || connections.accounts[provider] != nil || connections.disconnectFailures.contains(provider) {
                        Button("切断") {
                            guard Confirm.ask(ActionConfirmation(title: "\(title(provider)) を切断します", details: ["このアカウントの読み取りと送信の接続を解除します。", "保存済みの成果物は残ります。再び接続すると利用できます。"], risk: .r2, confirmLabel: "切断する")) else { return }
                            connections.disconnectProvider(provider)
                        }.accessibilityIdentifier("disconnectProvider-\(provider)")
                    }
                }
              }.font(.system(size: TypeScale.secondarySize)).disabled(connections.activeProvider != nil && !busy)
            }
        }.buttonStyle(.bordered).controlSize(.regular)
            .padding(Space.cardPadding)
            .background(Palette.surface(dark), in: RoundedRectangle(cornerRadius: Metrics.paletteRadius))
            .overlay(RoundedRectangle(cornerRadius: Metrics.paletteRadius).stroke(Palette.border(dark)))
            .accessibilityElement(children: .contain).accessibilityIdentifier("connectionGroup-\(provider)")
    }
    func purposeSheet(_ provider: String, dark: Bool) -> some View {
        VStack(alignment: .leading, spacing: Space.largePadding) {
            Text(title(provider)).font(.system(size: TypeScale.sectionTitleSize, weight: .semibold))
            Text("つなぐと、できること").font(.system(size: TypeScale.cardTitleSize))
            Label("予定と関連メールから会議の準備", systemImage: "calendar")
            Label("よく関わる人と今の仕事を整理", systemImage: "person.2")
            Label("初期Profileで回答や提案をあなた向けに", systemImage: "sparkles")
            Text("アカウントの識別情報と、\(provider == "google" ? "メール・カレンダー" : "メール・カレンダー・To Do")の読み取りを許可します。送信・変更の権限は、必要な操作の前に別に確認します。")
                .font(.system(size: TypeScale.secondarySize)).foregroundStyle(Palette.muted(dark)).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("やめる") { preview = nil }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(provider == "google" ? "Googleで続ける" : "Microsoftで続ける") {
                    preview = nil
                    Task { _ = await MainData.shared.ensureConnected(); _ = connections.connectProvider(provider) }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("authorizeProvider-\(provider)")
            }
        }.font(.system(size: TypeScale.bodySize)).padding(28).frame(width: 500)
            .accessibilityIdentifier("connectionPurpose")
    }
    private func importConfiguration() {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.json]; panel.allowsMultipleSelection = false
        panel.message = "運営者が発行した接続設定（connections.json）を選んでください。"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let values = ConnectionConfiguration.read(url)
        guard ["google", "microsoft"].contains(where: { ConnectionConfiguration.clientId(provider: $0, readOnly: true, values: values) != nil }) else {
            configurationError = "有効な接続設定がありません。運営者のconnections.jsonを選んでください。"; return
        }
        do {
            let destination = ConnectionConfiguration.localURL
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            // Preserve other configured providers when importing one provider.
            let merged = ConnectionConfiguration.merge([ConnectionConfiguration.read(destination), values])
            try JSONEncoder().encode(merged).write(to: destination, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
            configurationError = nil; connections.reloadSources(); connections.refresh()
        } catch { configurationError = "接続設定を保存できませんでした。保存先の権限を確認してください。" }
    }
    private func statusText(_ status: ConnectorState.Status) -> String {
        switch status {
        case .connected: return "接続済み"
        case .disconnected: return "未接続"
        case .cannotConnect: return "設定が必要"
        case .connecting: return "ブラウザーで許可を待っています"
        case .checking: return "接続を保存しています…"
        case .disconnecting: return "接続を解除しています…"
        case .failed(let reason): return reason
        }
    }
}
