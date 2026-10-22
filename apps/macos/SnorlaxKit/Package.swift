// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SnorlaxKit",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "SnorlaxKit", targets: ["SnorlaxKit"]),
    ],
    targets: [
        .target(name: "SnorlaxKit"),
        .testTarget(name: "SnorlaxKitTests", dependencies: ["SnorlaxKit"]),
    ]
)
