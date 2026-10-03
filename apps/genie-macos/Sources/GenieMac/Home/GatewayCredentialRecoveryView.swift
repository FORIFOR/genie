import SwiftUI

/// A person explicitly opens the OS's existing-item read confirmation. This view
/// receives status only, never credentials, and never decides an OS permission.
struct GatewayCredentialRecoveryView: View {
    let state: GatewayCredentialRecovery.State
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.base) {
            Text(message)
                .font(.system(size: S.type(TypeScale.secondarySize)))
                .foregroundStyle(Palette.warning(dark))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityIdentifier("homeCredentialAccessMessage")
            Button(state == .checking ? "macOSで確認中…" : "キーチェーンへのアクセスを確認", action: action)
                .buttonStyle(.bordered)
                .font(.system(size: S.type(TypeScale.secondarySize)))
                .disabled(state == .checking || state == .readable)
                .help("保存済みの接続情報の読み取りだけを確認します。入力内容は送信しません。")
                .accessibilityIdentifier("homeCredentialAccess")
        }
    }

    private var message: String {
        switch state {
        case .idle: return "接続情報を読み取るにはmacOSでの確認が必要です。入力は残しています。"
        case .checking: return "macOSの確認画面に応答してください。入力内容は送信しません。"
        case .readable: return "接続情報を読み取れました。内容を確認して送信してください。"
        case .missing: return "保存済みの接続情報が見つかりません。入力は残しています。"
        case .denied: return "接続情報を読み取れませんでした。入力は残しています。"
        case .invalid: return "保存済みの接続情報を確認できません。入力は残しています。"
        case .busy: return "別のキーチェーン確認が終わってから試してください。入力は残しています。"
        }
    }
}
