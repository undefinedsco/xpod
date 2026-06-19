import SwiftUI
import WebKit

private let defaultVerifierUrl = "http://192.168.3.15:3000/app/inrupt-smoke.html"

struct ContentView: View {
    @State private var verifierUrl: String = defaultVerifierUrl
    @State private var loadedUrl: URL = URL(string: defaultVerifierUrl)!

    var body: some View {
        VStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Xpod Inrupt Smoke")
                    .font(.headline)
                Text("WKWebView shell for the shared Inrupt browser SDK verifier. Login Cloud, then session.fetch the SP resource from the loaded page.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                TextField("http://host:3000/app/inrupt-smoke.html?issuer=...&sp=...", text: $verifierUrl)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .keyboardType(.URL)
                    .textFieldStyle(.roundedBorder)
                Button("Open verifier") {
                    if let url = URL(string: verifierUrl) {
                        loadedUrl = url
                    }
                }
                .buttonStyle(.borderedProminent)
            }
            .padding([.horizontal, .top], 12)

            InruptSmokeWebView(url: loadedUrl)
        }
    }
}

struct InruptSmokeWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if webView.url != url {
            webView.load(URLRequest(url: url))
        }
    }
}
