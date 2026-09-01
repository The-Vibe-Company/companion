import Foundation

enum CompanionMacAppConfig {
    static let productionAPIURL = URL(string: "https://api.thecompanion.sh")!
    static let productionWebURL = URL(string: "https://thecompanion.sh")!

    static var apiURL: URL {
#if DEBUG
        if let environmentURL = validURL(ProcessInfo.processInfo.environment["COMPANION_API_URL"]) {
            return environmentURL
        }
        if let configuredURL = validURL(Bundle.main.object(forInfoDictionaryKey: "CompanionAPIURL") as? String) {
            return configuredURL
        }
#endif
        return productionAPIURL
    }

    static var webURL: URL {
#if DEBUG
        if let environmentURL = validURL(ProcessInfo.processInfo.environment["COMPANION_WEB_URL"]) {
            return environmentURL
        }
        if let apiComponents = URLComponents(url: apiURL, resolvingAgainstBaseURL: false),
           let host = apiComponents.host,
           host == "127.0.0.1" || host == "localhost" {
            var webComponents = apiComponents
            if let port = apiComponents.port, port > 0 {
                webComponents.port = port - 1
            }
            if let url = webComponents.url {
                return url
            }
        }
#endif
        return productionWebURL
    }

    static var callbackScheme: String {
        Bundle.main.object(forInfoDictionaryKey: "CompanionURLScheme") as? String
            ?? "companion-mac"
    }

    private static func validURL(_ value: String?) -> URL? {
        guard let value,
              let url = URL(string: value),
              let scheme = url.scheme,
              url.host != nil,
              scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }
}
