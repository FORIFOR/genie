import CoreLocation
import Foundation

/// Google Maps Platform への唯一の出口（`scripts/verify-privacy-egress.sh` の規則 9）。
///
/// - Places API (New) Text Search: 検索語と現在地の緯度経度だけを送る。キーはヘッダー（`X-Goog-Api-Key`）。
/// - Maps Static API: 店の座標と現在地の地図画像。Google の仕様でキーが URL に載るので、
///   その URL はログにも記録にも画面にも出さない（このファイルはログを持たない）。
struct PlacesClient {
    enum Failure: Error, Equatable {
        /// キーが違う・API が有効でない（403 / 400 の API キー）。
        case rejected
        /// 呼び出しの上限（429）。
        case quota
        case network
    }

    static let searchEndpoint = URL(string: "https://places.googleapis.com/v1/places:searchText")!
    static let staticMapEndpoint = "https://maps.googleapis.com/maps/api/staticmap"
    /// 返してもらう項目。要らないものは頼まない（課金の段も項目で決まる）。
    static let fieldMask = [
        "places.id", "places.displayName", "places.formattedAddress", "places.location",
        "places.rating", "places.userRatingCount", "places.currentOpeningHours.openNow", "places.googleMapsUri",
    ].joined(separator: ",")

    let apiKey: String
    var session: URLSession = .shared

    /// 近い順の Text Search。半径 `radius` m の円を優先し、日本語で返してもらう。
    static func searchRequest(query: String, near: CLLocationCoordinate2D, radius: Double = 3000,
                              maxResults: Int = 5, apiKey: String) -> URLRequest {
        var request = URLRequest(url: searchEndpoint, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "X-Goog-Api-Key")
        request.setValue(fieldMask, forHTTPHeaderField: "X-Goog-FieldMask")
        let body: [String: Any] = [
            "textQuery": query,
            "languageCode": "ja",
            "regionCode": "JP",
            "rankPreference": "DISTANCE",
            "maxResultCount": maxResults,
            "locationBias": ["circle": ["center": ["latitude": near.latitude, "longitude": near.longitude],
                                        "radius": radius]],
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return request
    }

    /// 店を探す。名前に `mustContain` のどれかを含む店だけを、近い順で返す（同名の別の店を混ぜない）。
    func search(query: String, near: CLLocation, mustContain: [String], limit: Int) async throws -> [PlacesCard.Place] {
        let request = Self.searchRequest(query: query, near: near.coordinate, apiKey: apiKey)
        let data = try await send(request)
        return try Self.places(from: data, near: near, mustContain: mustContain, limit: limit)
    }

    static func places(from data: Data, near: CLLocation, mustContain: [String], limit: Int) throws -> [PlacesCard.Place] {
        let response = try JSONDecoder().decode(SearchResponse.self, from: data)
        let needles = mustContain.map { $0.lowercased() }
        return (response.places ?? [])
            .compactMap { p -> PlacesCard.Place? in
                guard let name = p.displayName?.text, let location = p.location,
                      needles.contains(where: { name.lowercased().contains($0) }) else { return nil }
                let here = CLLocation(latitude: location.latitude, longitude: location.longitude)
                let maps = p.googleMapsUri.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
                return PlacesCard.Place(id: p.id, name: name, address: p.formattedAddress ?? "",
                                        latitude: location.latitude, longitude: location.longitude,
                                        rating: p.rating, ratingCount: p.userRatingCount,
                                        openNow: p.currentOpeningHours?.openNow, mapsURL: maps,
                                        distance: near.distance(from: here))
            }
            .sorted { $0.distance < $1.distance }
            .prefix(limit)
            .map { $0 }
    }

    /// 地図画像の URL。番号 1…n のピンと、現在地の青い点。**キーが載るのはここだけ。**
    static func staticMapURL(center: CLLocationCoordinate2D, places: [PlacesCard.Place],
                             width: Int, height: Int, apiKey: String) -> URL {
        var items = [
            URLQueryItem(name: "size", value: "\(width)x\(height)"),
            URLQueryItem(name: "scale", value: "2"),
            URLQueryItem(name: "language", value: "ja"),
            URLQueryItem(name: "region", value: "JP"),
            URLQueryItem(name: "markers", value: "size:small|color:0x1C7FA8|\(center.latitude),\(center.longitude)"),
        ]
        for (i, p) in places.enumerated() {
            items.append(URLQueryItem(name: "markers", value: "color:red|label:\(i + 1)|\(p.latitude),\(p.longitude)"))
        }
        items.append(URLQueryItem(name: "key", value: apiKey))
        var components = URLComponents(string: staticMapEndpoint)!
        components.queryItems = items
        return components.url!
    }

    /// 地図画像を取る。メモリにだけ持つ（disk のキャッシュにも残さない）。
    func staticMap(center: CLLocationCoordinate2D, places: [PlacesCard.Place], width: Int, height: Int) async throws -> Data {
        var request = URLRequest(url: Self.staticMapURL(center: center, places: places, width: width, height: height, apiKey: apiKey),
                                 cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.httpMethod = "GET"
        return try await send(request)
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: request) } catch { throw Failure.network }
        switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
        case 200..<300: return data
        case 429: throw Failure.quota
        case 400, 401, 403: throw Failure.rejected
        default: throw Failure.network
        }
    }

    private struct SearchResponse: Decodable {
        struct Place: Decodable {
            struct Text: Decodable { let text: String }
            struct Location: Decodable { let latitude: Double; let longitude: Double }
            struct Hours: Decodable { let openNow: Bool? }
            let id: String
            let displayName: Text?
            let formattedAddress: String?
            let location: Location?
            let rating: Double?
            let userRatingCount: Int?
            let currentOpeningHours: Hours?
            let googleMapsUri: String?
        }
        let places: [Place]?
    }
}
