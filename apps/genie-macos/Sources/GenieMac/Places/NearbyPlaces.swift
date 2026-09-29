import CoreLocation
import Foundation

/// 近くの店を探して、地図つきのカードにする。モデルも gateway も通さない（位置と鍵はこの Mac にある）。
///
/// 外へ出るのは `PlacesClient` だけで、作るのはここだけ（`scripts/verify-privacy-egress.sh` 規則 9）。
@MainActor
enum NearbyPlaces {
    /// カードに出す店の数と地図の寸法（中身の幅 = 回答面 520 − 縁 20×2）。
    static let shown = 3
    static let mapWidth = Int(Metrics.dockResultWidth - Metrics.dockPadH * 2)
    static let mapHeight = Int(Metrics.dockCardImageHeight)

    enum Failure: Error, Equatable {
        case needsKey, limitReached, locationDenied, locationUnavailable, rejected, quota, network

        /// 何ができないかと、次の一手（Dock の回答面にそのまま出す）。
        var message: String {
            switch self {
            case .needsKey: return "近くの店を探すには、設定で Google Maps Platform のキーと月の上限を決めてください。"
            case .limitReached: return "今月の検索の上限に達しました。設定で上限を変えられます。"
            case .locationDenied: return "現在地を使う許可がありません。システム設定の「位置情報サービス」で Genie を許可してください。"
            case .locationUnavailable: return "現在地を取得できませんでした。少し待ってからもう一度頼んでください。"
            case .rejected: return "Google Maps Platform がキーを受け付けませんでした。Places API (New) と Maps Static API が有効か確かめてください。"
            case .quota: return "Google Maps Platform の呼び出し上限に達しました。時間をおいて頼んでください。"
            case .network: return "Google マップに接続できませんでした。ネットワークを確かめてください。"
            }
        }
    }

    static func search(_ intent: NearbyPlaceIntent, settings: PlacesSettings = .shared,
                       location: CurrentLocation = .shared) async -> Result<PlacesCard, Failure> {
        guard settings.hasKey, settings.monthlyLimit > 0 else { return .failure(.needsKey) }
        guard settings.canSearch() else { return .failure(.limitReached) }
        guard let key = settings.apiKey(), !key.isEmpty else { return .failure(.needsKey) }
        let here: CLLocation
        do { here = try await location.once() } catch CurrentLocation.Failure.denied {
            return .failure(.locationDenied)
        } catch {
            return .failure(.locationUnavailable)
        }
        let client = PlacesClient(apiKey: key)
        settings.recordSearch()
        do {
            let places = try await client.search(query: intent.query, near: here,
                                                 mustContain: intent.nameMustContain, limit: shown)
            // 地図は無くても店の行は出せる。取れなければ枠に理由を出す。
            let map = places.isEmpty ? nil
                : try? await client.staticMap(center: here.coordinate, places: places, width: mapWidth, height: mapHeight)
            return .success(PlacesCard(query: intent.display, places: places, map: map, fetchedAt: Date()))
        } catch PlacesClient.Failure.rejected {
            return .failure(.rejected)
        } catch PlacesClient.Failure.quota {
            return .failure(.quota)
        } catch {
            return .failure(.network)
        }
    }
}
