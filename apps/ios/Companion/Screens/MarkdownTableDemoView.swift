#if DEBUG
import SwiftUI

struct MarkdownTableDemoView: View {
    @Environment(\.colorScheme) private var colorScheme
    private let fixtures = MarkdownTableDemoFixture.samples

    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        ForEach(fixtures) { fixture in
                            VStack(alignment: .leading, spacing: 10) {
                                Text(fixture.title)
                                    .font(.headline)
                                    .foregroundStyle(Color.companionInk)
                                    .accessibilityAddTraits(.isHeader)

                                MarkdownMessageView(
                                    document: fixture.document,
                                    linkColor: .companionAccent
                                )
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityIdentifier("markdown-table-demo.\(fixture.id)")
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Markdown tables")
            .navigationBarTitleDisplayMode(.inline)
        }
        .accessibilityIdentifier("markdown-table-demo.gallery")
        .accessibilityValue(colorScheme == .dark ? "Dark appearance" : "Light appearance")
    }
}

private struct MarkdownTableDemoFixture: Identifiable {
    let id: String
    let title: String
    let document: MarkdownDocument

    init(id: String, title: String, markdown: String) {
        self.id = id
        self.title = title
        document = MarkdownDocument(markdown: markdown)
    }

    static let samples: [MarkdownTableDemoFixture] = [
        .init(
            id: "simple",
            title: "Simple two-column table",
            markdown: """
            | Service | Status |
            | :-- | :-- |
            | API | Healthy |
            | Runtime | Degraded |
            """
        ),
        .init(
            id: "wide",
            title: "Wide six-column table",
            markdown: """
            | Service | Owner | Region | Version | Deployments | Status |
            | :-- | :-- | :--: | --: | --: | :-- |
            | Runtime | Priya Ramanathan | us-west-2 | 2026.08.26 | 128 | Healthy |
            | API | Mateo Silva | eu-central-1 | 2026.08.24 | 94 | Degraded |
            """
        ),
        .init(
            id: "long-content",
            title: "Long wrapping content",
            markdown: """
            | Check | Detail |
            | :-- | :-- |
            | Dispatch safety | Ambiguous dispatches are never replayed; exact cleanup and FIFO continuation happen automatically. |
            | Workspace | [Open the deterministic Companion workspace](conductor://workspace/companion-layout-regression-evidence) |
            | Durable path | `companion/runtime/transcripts/2026/08/26/layout-regression-evidence.json` |
            """
        ),
        .init(
            id: "alignment",
            title: "Column alignment",
            markdown: """
            | Left | Center | Right |
            | :-- | :-: | --: |
            | Alpha | [Beta](conductor://workspace/example) | 1,024 |
            | Gamma | Delta | 8 |
            """
        ),
        .init(
            id: "single-row",
            title: "Single data row",
            markdown: """
            | Result | Value |
            | :-- | --: |
            | Passed | 1 |
            """
        ),
    ]
}

#Preview("Markdown tables") {
    MarkdownTableDemoView()
}
#endif
