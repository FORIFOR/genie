import Foundation
import GenieCore

/// 人が確認カードを**見て**「実行する」を押した、という証拠。
///
/// backend の承認（`ApprovalRelay.approve`）はこれが無いと呼べない。
///
/// **init はこのモジュールの外から見えない。**GenieMac からは、別名（typealias）・extension の init・
/// `.init(…)` の省略形のどれでも作れない（別モジュールの struct の let を extension から埋めることは
/// Swift が許さない）。GenieMac から証拠を得る道は `ApprovalLedger.issue(forPressedCard:)` の 1 本だけ。
///
/// **ただし、その 1 本は型では縛れていない。**issue は public で、任意の UUID を渡せばコンパイルは通る
/// （カードの表示と答えの待ちは GenieMac 側にあり、ここへ移していないため）。呼んでよいのは
/// `Confirm.approve` が「実行する」の答えを受け取った 1 か所だけ、という約束は**型ではなくゲートで守る**
/// （`scripts/verify-approval-boundary.sh` の ⑦ が呼び出しと参照を数え、selfcheck がその書き戻しで落ちることを確かめる）。
///
/// **コピーできない（~Copyable）。**`ApprovalRelay.approve` が consuming で受け取るので、
/// 1 回の「実行する」を 2 件の承認に使い回せない。
public struct UserApproval: ~Copyable, Sendable {
    /// どのカードへの答えか。
    public let confirmationID: UUID
    public let answeredAt: Date

    init(confirmationID: UUID) {
        self.confirmationID = confirmationID
        answeredAt = Date()
    }
}

/// 証拠を作る唯一の入口。
public enum ApprovalLedger {
    /// 確認カードで人が「実行する」を押した、その答えから証拠を 1 つ作る。
    /// **呼ぶのは `Confirm.approve` だけ。**声・会話・自動の経路からは呼ばない。
    /// public なので型はこれを止めない。止めているのはゲート（`approval_boundary.py` ⑦）だけ。
    public static func issue(forPressedCard confirmationID: UUID) -> UserApproval {
        UserApproval(confirmationID: confirmationID)
    }
}

/// backend の承認に答える唯一の場所。生の FFI（`apiTaskApprove`、decision を文字で渡せる）を
/// 呼んでよいのはこのファイルだけ。
public enum ApprovalRelay {
    /// 承認を中継する。decision は APPROVED だけ（呼び出し側に文字列を渡させない）。
    /// 証拠は consuming で受け取り、ここで使い切る。
    public static func approve(_ baseUrl: String, accessToken: String, taskId: String, approvalId: String,
                               approval: consuming UserApproval) throws {
        _ = consume approval   // 値は使わない。持っていること（= カードの答えから作った）が条件。
        try apiTaskApprove(baseUrl: baseUrl, accessToken: accessToken, taskId: taskId, approvalId: approvalId, decision: "APPROVED")
    }

    /// 承認しない（REJECTED）。止める方向なので証拠は要らない。backend はこの仕事を CANCELLED にする。
    /// **送るのは人が「やめる」を押したときだけ。**答えが無い・カードが見えないは、ここへ来ない。
    public static func reject(_ baseUrl: String, accessToken: String, taskId: String, approvalId: String) throws {
        try apiTaskApprove(baseUrl: baseUrl, accessToken: accessToken, taskId: taskId, approvalId: approvalId, decision: "REJECTED")
    }
}
