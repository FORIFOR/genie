import Foundation

/// 回答面に出す例外のカード（`shared/design/DESIGN.md` §8）。
///
/// 新しい窓は作らない。回答面と同じ幅で、外側は `DockCardScaffold`、中身だけを種類ごとに描く。
/// 種類を足すときはここに case を足し、`DockCardView` に中身を足す（株価・TODO・予定・音楽…）。
enum DockCard: Equatable {
    /// 天気・ニュース（`genie.info/v1`）。
    case info(InfoCard)

    /// 読み上げ・コピー・Work の記録に使う文。カードを描けないときもこれを出す。
    var text: String {
        switch self {
        case .info(let card): return card.text
        }
    }

    /// カードに描くものがあるか。無ければ文だけの回答面にする。
    var hasContent: Bool {
        switch self {
        case .info(let card): return card.hasContent
        }
    }

    /// 成果物の本文から読む。どの種類でもなければ nil（本文を文として出す）。
    static func decode(_ body: String) -> DockCard? {
        if let card = InfoCard.decode(body) { return .info(card) }
        return nil
    }
}
