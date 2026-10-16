import ARKit
import AVFoundation
import Capacitor
import CoreImage
import CoreMotion
import ImageIO
import QuickLook
import RealityKit
import SceneKit
import UIKit

/// LIDAR — 3D SCAN (field feedback 10-13, item 5; Erik 2026-10-16, after Polycam: "collect all of
/// the pixels for all surfaces and render an image … i want that", and after Apple's own area
/// capture: "no dots and the scan came out all weird … lets group everything with a title called
/// Lidar, get rid of the site scan and scan the room and lets keep measurements and measure area and
/// 3d scan and lets get the 3D scan working great").
///
/// ONE DOOR. scan3d opens OUR OWN capture screen: ARKit tracks the walk and draws the LiDAR mesh
/// blue; the phone takes 12 MP photos by itself as the walker moves (and on the shutter), and every
/// face a photo saw turns clear — what is still blue is what the scan still needs. Finish hands the
/// photos, their depth maps and gravity to PhotogrammetrySession, which builds a TEXTURED model on
/// the phone — every surface wearing its real pixels — as a USDZ. The file can be tens of megabytes,
/// so it stays in the app's temp folder and the page pulls it through readChunk in 2 MB pieces
/// (never one giant string over the bridge), then discards it. No numbers come from this door: the
/// measurements are Measure's (MeasurePlugin), beside it under the Lidar title.
///
/// The site and room doors of cn-v1115 (tapped corners; Apple's room capture) are gone by Erik's
/// decision; rows they wrote keep their `scan` mark in the stored capture.
///
/// No network from here (the agent security framework). A phone that cannot scan rejects with ONE
/// plain sentence the page shows as-is (NOTHING SILENT); Cancel resolves {ok:false, cancelled:true}.
/// A LOCAL plugin like MeasurePlugin: ARKit, SceneKit and RealityKit ship with iOS. The shell has
/// to be REBUILT for it (the Debug build on the cabled phone).

@objc(ScanPlugin)
public class ScanPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScanPlugin"
    public let jsName = "Scan"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan3d", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discard", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stageFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stageChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "previewFile", returnType: CAPPluginReturnPromise),
    ]

    /// OPEN IN AR. A `rel="ar"` link is Safari's door and the app's web view ignores it (Erik, 10-16:
    /// "Open in AR doesn't do anything"). The page already holds the model's bytes (it drew them), so
    /// it STAGES them into the scan folder in pieces — the reverse of readChunk — and the shell opens
    /// Apple's own Quick Look viewer, which carries the AR tab. No network from here: the bytes come
    /// from the page. The staged file goes when the viewer closes.
    @objc func stageFile(_ call: CAPPluginCall) {
        let raw = (call.getString("name") ?? "model").replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
        let base = raw.lowercased().hasSuffix(".usdz") ? String(raw.dropLast(5)) : raw
        let url = Self.scanFolder.appendingPathComponent("stage-\(base.isEmpty ? "model" : base)-\(UUID().uuidString.prefix(8)).usdz")
        do {
            try FileManager.default.createDirectory(at: Self.scanFolder, withIntermediateDirectories: true)
            guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
            call.resolve(["path": url.path])
        } catch {
            call.reject("Couldn't make room for the model on this phone (\(error.localizedDescription)).")
        }
    }

    /// Appends one base64 piece to a staged file of ours.
    @objc func stageChunk(_ call: CAPPluginCall) {
        guard let url = Self.ownFile(call.getString("path")) else {
            call.reject("That file isn't a staged model of this app's.")
            return
        }
        guard let data = Data(base64Encoded: call.getString("data") ?? "") else {
            call.reject("That piece of the model wasn't readable.")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let handle = try FileHandle(forWritingTo: url)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
                call.resolve(["bytes": (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0])
            } catch {
                call.reject("Couldn't write the model on this phone (\(error.localizedDescription)).")
            }
        }
    }

    private var preview: ModelPreview?

    /// Opens a staged file in Quick Look (the AR tab is Apple's); resolves when it closes, and the file goes.
    @objc func previewFile(_ call: CAPPluginCall) {
        guard let url = Self.ownFile(call.getString("path")) else {
            call.reject("That file isn't a staged model of this app's.")
            return
        }
        Task { @MainActor in
            guard self.preview == nil else {
                call.reject("A model is already open. Close it first.")
                return
            }
            guard var top = self.bridge?.viewController else {
                call.reject("The app's screen isn't ready yet. Close and reopen the app, then try again.")
                return
            }
            while let presented = top.presentedViewController { top = presented }
            let preview = ModelPreview(url: url) { [weak self] in
                self?.preview = nil
                try? FileManager.default.removeItem(at: url)
                call.resolve()
            }
            self.preview = preview
            top.present(preview.controller, animated: true)
        }
    }

    /// One scan on screen at a time: a second call while one is up is answered, not stacked.
    private var presenting = false

    /// The sensor: the mesh the walk is drawn on and the depth behind every photo.
    static var lidarPresent: Bool {
        ARWorldTrackingConfiguration.isSupported && ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    }

    /// A textured model is our capture (ARKit's 12 MP stills, iOS 16) plus photogrammetry on the
    /// phone (iOS 17) over the LiDAR mesh.
    static var modelSupported: Bool {
        if #available(iOS 17.0, *) { return lidarPresent && PhotogrammetrySession.isSupported }
        return false
    }

    static let noLidarSentence = "3D Scan needs an iPhone with a LiDAR sensor (12 Pro or newer). Measure instead."
    static let no3dSentence = "3D Scan needs iOS 17 or newer on an iPhone with a LiDAR sensor. Update the iPhone."
    static let couldNotOpen = "The scan couldn't open over this screen. Close what's open and try again."

    /// Resolves { model: Bool, reason: String? } — `reason` is the sentence to show when the door is shut.
    @objc func isSupported(_ call: CAPPluginCall) {
        var out: [String: Any] = ["model": Self.modelSupported]
        if !Self.modelSupported { out["reason"] = Self.lidarPresent ? Self.no3dSentence : Self.noLidarSentence }
        call.resolve(out)
    }

    @objc func scan3d(_ call: CAPPluginCall) {
        guard Self.modelSupported else {
            call.reject(Self.lidarPresent ? Self.no3dSentence : Self.noLidarSentence)
            return
        }
        if #available(iOS 17.0, *) {
            Self.sweepOldScans()
            present(call) { done in Scan3DViewController(done: done) }
            return
        }
        call.reject(Self.no3dSentence)
    }

    /// A model the page never collected (the app was killed mid-build, the page reloaded) would sit
    /// in tmp for good: anything in the scan folder older than an hour goes before a new scan.
    static func sweepOldScans() {
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(at: scanFolder, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        for url in items {
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if Date().timeIntervalSince(modified) > 3600 { try? fm.removeItem(at: url) }
        }
    }

    /// The scan folder: every file this plugin hands the page lives here and nowhere else, so a
    /// path from the page is served only when it is one of ours (never an arbitrary file).
    static var scanFolder: URL { FileManager.default.temporaryDirectory.appendingPathComponent("north-scans", isDirectory: true) }

    static func ownFile(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        let url = URL(fileURLWithPath: raw).standardizedFileURL
        let folder = scanFolder.standardizedFileURL.path
        guard url.path.hasPrefix(folder + "/"), url.pathExtension.lowercased() == "usdz" else { return nil }
        return url
    }

    /// 2 MB base64 pieces of a scan file: { data, bytes, total }. The page assembles them.
    @objc func readChunk(_ call: CAPPluginCall) {
        guard let url = Self.ownFile(call.getString("path")) else {
            call.reject("That file isn't a scan of this app's.")
            return
        }
        let offset = max(0, call.getInt("offset") ?? 0)
        let length = min(max(1, call.getInt("length") ?? 2_000_000), 4_000_000)
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let total = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                try handle.seek(toOffset: UInt64(offset))
                let data = handle.readData(ofLength: length)
                call.resolve(["data": data.base64EncodedString(), "bytes": data.count, "total": total])
            } catch {
                call.reject("Couldn't read the scan file (\(error.localizedDescription)).")
            }
        }
    }

    /// The page has the bytes: the temp file goes. (Nothing else; a wrong path is a no-op.)
    @objc func discard(_ call: CAPPluginCall) {
        if let url = Self.ownFile(call.getString("path")) { try? FileManager.default.removeItem(at: url) }
        call.resolve()
    }

    /// The camera permission is asked here, in the tap that opened the scan (the iOS rule: the first
    /// ask rides a gesture), with the words from Info.plist's NSCameraUsageDescription. A screen
    /// mid-way in or out cannot present: UIKit drops the request without an error, so that is said
    /// instead of hanging, and a presentation that never came up is said after 1.5 s.
    private func present(_ call: CAPPluginCall, make: @escaping (@escaping (ScanOutcome) -> Void) -> ScanViewController) {
        AVCaptureDevice.requestAccess(for: .video) { granted in
            guard granted else {
                call.reject("North needs the camera to scan. Allow the camera for North in Settings → Apps → North, then try again.")
                return
            }
            Task { @MainActor in
                guard !self.presenting else {
                    call.reject("A scan is already open. Finish or cancel it first.")
                    return
                }
                guard var top = self.bridge?.viewController else {
                    call.reject("The app's screen isn't ready yet. Close and reopen the app, then try again.")
                    return
                }
                while let presented = top.presentedViewController { top = presented }
                guard !top.isBeingDismissed, !top.isBeingPresented else {
                    call.reject(Self.couldNotOpen)
                    return
                }
                self.presenting = true
                let vc = make { [weak self] outcome in
                    self?.presenting = false
                    switch outcome {
                    case .cancelled:
                        call.resolve(["ok": false, "cancelled": true])
                    case .failed(let sentence):
                        call.reject(sentence)
                    case .scanned(let payload):
                        call.resolve(payload)
                    }
                }
                vc.modalPresentationStyle = .fullScreen
                top.present(vc, animated: true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self, weak vc] in
                    guard let self, let vc, !vc.finished, vc.presentingViewController == nil else { return }
                    self.presenting = false
                    vc.finished = true
                    call.reject(Self.couldNotOpen)
                }
            }
        }
    }
}

enum ScanOutcome {
    case scanned([String: Any])
    case cancelled
    case failed(String)
}

/// What a scanning screen gets from the plugin: the one-shot outcome, the `finished` latch the plugin's timer
/// reads, portrait, and the button look Measure uses.
class ScanViewController: UIViewController {
    let done: (ScanOutcome) -> Void
    /// Set once the outcome is on its way (or the view never came up); every door checks it.
    var finished = false
    /// The screen is up (viewDidAppear). An outcome before that waits here: a dismiss during the
    /// presentation is dropped by UIKit and the promise would hang (skeptic #19).
    var appeared = false
    var pendingOutcome: ScanOutcome?

    init(done: @escaping (ScanOutcome) -> Void) {
        self.done = done
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    override var prefersStatusBarHidden: Bool { true }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        appeared = true
        if let pendingOutcome {
            self.pendingOutcome = nil
            finish(pendingOutcome)
        }
    }

    func finish(_ outcome: ScanOutcome) {
        guard !finished else { return }
        guard appeared else {
            if pendingOutcome == nil { pendingOutcome = outcome }
            return
        }
        finished = true
        // The presenter takes the whole stack down — an alert of ours on top would otherwise be the
        // only thing dismissed, leaving a dead screen up with the promise already answered.
        (presentingViewController ?? self).dismiss(animated: true) { [done] in done(outcome) }
    }

    static func style(_ b: UIButton, filled: Bool) {
        b.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        b.contentEdgeInsets = UIEdgeInsets(top: 10, left: 18, bottom: 10, right: 18)
        b.layer.cornerRadius = 22
        if filled {
            b.backgroundColor = .white
            b.setTitleColor(.black, for: .normal)
            b.setTitleColor(UIColor.black.withAlphaComponent(0.35), for: .disabled)
        } else {
            b.backgroundColor = UIColor.black.withAlphaComponent(0.45)
            b.setTitleColor(.white, for: .normal)
            b.setTitleColor(UIColor.white.withAlphaComponent(0.4), for: .disabled)
        }
    }
}

// MARK: - 3D SCAN (our own capture: ARKit photos with visible coverage → photogrammetry)

/// One photo on disk: its file, the gravity it was taken under (the device's frame, CoreMotion's
/// convention — what PhotogrammetrySample wants) and the size of its depth map.
struct ShotRecord {
    let id: Int
    let image: String
    let depth: String?
    let depthWidth: Int
    let depthHeight: Int
    let gravity: CMAcceleration
}

/// Hands the photos to PhotogrammetrySession ONE AT A TIME, read off disk as it asks (two hundred
/// 12 MP images would not fit in memory together): the image, the LiDAR depth map behind it (so the
/// model comes out at its real size) and gravity (so it stands up).
@available(iOS 17.0, *)
struct ShotSamples: Sequence, IteratorProtocol {
    let dir: URL
    let records: [ShotRecord]
    var at = 0

    mutating func next() -> PhotogrammetrySample? {
        while at < records.count {
            let r = records[at]
            at += 1
            guard let image = ShotSamples.pixels(jpeg: dir.appendingPathComponent(r.image)) else { continue }
            var s = PhotogrammetrySample(id: r.id, image: image)
            if let depth = r.depth, let map = ShotSamples.depth(file: dir.appendingPathComponent(depth), width: r.depthWidth, height: r.depthHeight) { s.depthDataMap = map }
            s.gravity = r.gravity
            return s
        }
        return nil
    }

    static let context = CIContext(options: [.useSoftwareRenderer: false])

    /// A JPEG → a BGRA pixel buffer (the format the session takes), scaled down where the session's
    /// own ceiling on an image's size is lower than the photo; nil when the file is unreadable.
    static func pixels(jpeg url: URL) -> CVPixelBuffer? {
        guard var ci = CIImage(contentsOf: url) else { return nil }
        let limit = PhotogrammetrySession.limits.maximumInputImageDimension
        let longest = Swift.max(ci.extent.width, ci.extent.height)
        if limit > 0, longest > CGFloat(limit) {
            let scale = CGFloat(limit) / longest
            ci = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }
        let w = Int(ci.extent.width.rounded(.down)), h = Int(ci.extent.height.rounded(.down))
        guard w > 0, h > 0 else { return nil }
        var pb: CVPixelBuffer?
        let attrs: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        guard CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pb) == kCVReturnSuccess, let pb else { return nil }
        context.render(ci, to: pb)
        return pb
    }

    /// Raw Float32 meters on disk → a DepthFloat32 pixel buffer.
    static func depth(file url: URL, width: Int, height: Int) -> CVPixelBuffer? {
        guard width > 0, height > 0, let data = try? Data(contentsOf: url), data.count == width * height * 4 else { return nil }
        var pb: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_DepthFloat32, nil, &pb) == kCVReturnSuccess, let pb else { return nil }
        CVPixelBufferLockBaseAddress(pb, [])
        defer { CVPixelBufferUnlockBaseAddress(pb, []) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
        let bpr = CVPixelBufferGetBytesPerRow(pb)
        data.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
            guard let s = src.baseAddress else { return }
            for row in 0..<height { memcpy(base.advanced(by: row * bpr), s.advanced(by: row * width * 4), width * 4) }
        }
        return pb
    }
}

/// A copy of one LiDAR mesh anchor, taken on the main thread so the coverage work can read it off
/// the main thread without touching ARKit's recycled Metal buffers.
struct MeshSnap {
    let id: UUID
    let transform: simd_float4x4
    let rotation: simd_float3x3
    let vertices: [simd_float3]
    /// ARKit's own normal at each vertex (out of the surface, into the open) — the facing test
    /// trusts these, not the winding of the face.
    let normals: [simd_float3]
    /// Three indices per face.
    let faces: [UInt32]

    init(_ anchor: ARMeshAnchor) {
        id = anchor.identifier
        transform = anchor.transform
        rotation = simd_float3x3(columns: (
            simd_float3(transform.columns.0.x, transform.columns.0.y, transform.columns.0.z),
            simd_float3(transform.columns.1.x, transform.columns.1.y, transform.columns.1.z),
            simd_float3(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z)))
        let g = anchor.geometry
        let v = g.vertices
        var verts = [simd_float3](repeating: .zero, count: v.count)
        let vBase = v.buffer.contents().advanced(by: v.offset)
        for i in 0..<v.count {
            let p = vBase.advanced(by: i * v.stride).assumingMemoryBound(to: Float.self)
            verts[i] = simd_float3(p[0], p[1], p[2])
        }
        vertices = verts
        let nm = g.normals
        var norms = [simd_float3](repeating: .zero, count: nm.count)
        let nBase = nm.buffer.contents().advanced(by: nm.offset)
        for i in 0..<nm.count {
            let p = nBase.advanced(by: i * nm.stride).assumingMemoryBound(to: Float.self)
            norms[i] = simd_float3(p[0], p[1], p[2])
        }
        normals = norms
        let f = g.faces
        let n = f.count * f.indexCountPerPrimitive
        var idx = [UInt32](repeating: 0, count: n)
        let fBase = f.buffer.contents()
        if f.bytesPerIndex == 4 {
            let p = fBase.assumingMemoryBound(to: UInt32.self)
            for i in 0..<n { idx[i] = p[i] }
        } else {
            let p = fBase.assumingMemoryBound(to: UInt16.self)
            for i in 0..<n { idx[i] = UInt32(p[i]) }
        }
        faces = idx
    }

    func world(_ i: UInt32) -> simd_float3 {
        let p = transform * simd_float4(vertices[Int(i)], 1)
        return simd_float3(p.x, p.y, p.z)
    }

    func worldNormal(_ i: UInt32) -> simd_float3 {
        Int(i) < normals.count ? rotation * normals[Int(i)] : .zero
    }
}

/// What a photo saw: the camera it was taken with and the depth behind it, for the coverage test.
struct ShotView {
    let transform: simd_float4x4
    let intrinsics: simd_float3x3
    let width: Float
    let height: Float
    let depth: [Float]
    let depthWidth: Int
    let depthHeight: Int
}

/// THE SCAN ERIK ASKED FOR (10-16, after Apple's area capture showed no coverage and built a weird
/// model): our own camera. ARKit tracks the walk and draws the LiDAR mesh BLUE; the phone takes a
/// 12 MP photo by itself every ~0.35 m or 15° of turn (and on the shutter), and every mesh face a
/// photo saw — in front of the lens, within reach, facing it, and not behind something per the depth
/// map — turns CLEAR. What is still blue is what the scan still needs. Finish (ten photos or more)
/// hands the photos, their depth maps and gravity to PhotogrammetrySession, which builds the
/// textured USDZ on the phone; the file goes to the page in pieces (readChunk).
@available(iOS 17.0, *)
final class Scan3DViewController: ScanViewController, ARSessionDelegate {
    /// Photogrammetry wants a real set of photos: Finish opens at this many.
    static let minShots = 10
    /// The most photos one scan takes (a reduced-detail build of 200 is minutes on the phone; Apple's
    /// own ceiling, where it is lower, wins).
    static let maxShots: Int = {
        let cap = PhotogrammetrySession.limits.maximumNumberOfInputImages
        return cap > 0 ? min(200, cap) : 200
    }()
    /// A new photo after this much walking, or this much turning, with at least this gap between two.
    static let moveStep: Float = 0.35
    static let turnStep: Float = 15 * .pi / 180
    static let shotGap: TimeInterval = 0.7
    /// How far a photo counts as covering (meters), and the grid the coverage is kept on.
    static let reach: Float = 5
    static let cell: Float = 0.1

    private let sceneView = ARSCNView()
    private let hint = UILabel()
    private let counter = UILabel()
    private let shutter = UIButton(type: .system)
    private let finishButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)
    private let buildBox = UIView()
    private let buildBar = UIProgressView(progressViewStyle: .default)
    private let buildLabel = UILabel()

    private let folder: URL
    private let checkpointDir: URL
    private let outputURL: URL

    private var trackingNormal = false
    private var meshSeen = false
    private var shotInFlight = false
    private var shots = 0
    /// Photo ids only ever go up (a failed write takes the count down, never an id back).
    private var nextId = 0
    /// Said once: this phone gave no 12 MP still, so the photos are the camera feed's size.
    private var saidLowRes = false
    private var lastShotAt: TimeInterval = 0
    private var lastShotTransform: simd_float4x4?
    /// Photos still being written to disk; Finish waits for zero.
    private var pendingWrites = 0
    private var finishWaiting = false
    private var records: [ShotRecord] = []
    private var processing = false
    private var photo: PhotogrammetrySession?
    /// The recommended high-resolution video format is tried first; if the session refuses it, the
    /// default format is tried once before the failure is said.
    private var formatRetried = false
    private var startedAt = Date()

    /// The mesh as ARKit holds it (main thread), our copy of each anchor (refreshed for the anchors
    /// that changed, at most four times a second — never every anchor on every photo) and the node
    /// drawing each anchor's uncovered faces.
    private var meshes: [UUID: ARMeshAnchor] = [:]
    private var snaps: [UUID: MeshSnap] = [:]
    private var nodes: [UUID: SCNNode] = [:]
    private var dirty = Set<UUID>()
    private var flushScheduled = false
    /// The coverage work: the voxels a photo saw, read and written on this queue only.
    private let work = DispatchQueue(label: "north.scan3d.coverage", qos: .userInitiated)
    private var covered = Set<Int64>()
    private let encode = DispatchQueue(label: "north.scan3d.encode", qos: .userInitiated)
    private let haptic = UIImpactFeedbackGenerator(style: .light)

    override init(done: @escaping (ScanOutcome) -> Void) {
        let stamp = UUID().uuidString
        let base = ScanPlugin.scanFolder
        folder = base.appendingPathComponent("capture-\(stamp)", isDirectory: true)
        checkpointDir = folder.appendingPathComponent("checkpoint", isDirectory: true)
        outputURL = base.appendingPathComponent("model-\(stamp).usdz")
        super.init(done: done)
    }

    // MARK: Screen

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        do {
            try FileManager.default.createDirectory(at: checkpointDir, withIntermediateDirectories: true)
        } catch {
            // Said once the screen is up (ScanViewController.finish holds it until then).
            finish(.failed("Couldn't make room for the scan on this phone (\(error.localizedDescription)). Free some space and try again."))
            return
        }
        // A capture and a build take minutes: the phone must not lock in the middle of them.
        UIApplication.shared.isIdleTimerDisabled = true

        sceneView.frame = view.bounds
        sceneView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        sceneView.session.delegate = self
        sceneView.automaticallyUpdatesLighting = false
        sceneView.rendersCameraGrain = false
        view.addSubview(sceneView)

        for label in [hint, counter] {
            label.translatesAutoresizingMaskIntoConstraints = false
            label.textAlignment = .center
            label.textColor = .white
            label.backgroundColor = UIColor.black.withAlphaComponent(0.45)
            label.layer.cornerRadius = 10
            label.layer.masksToBounds = true
            view.addSubview(label)
        }
        hint.font = .systemFont(ofSize: 15, weight: .medium)
        hint.numberOfLines = 3
        counter.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)

        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        Self.style(cancelButton, filled: false)
        finishButton.setTitle("Finish", for: .normal)
        finishButton.addTarget(self, action: #selector(finishTapped), for: .touchUpInside)
        Self.style(finishButton, filled: true)
        finishButton.isEnabled = false
        shutter.setImage(UIImage(systemName: "camera.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 28, weight: .semibold)), for: .normal)
        shutter.tintColor = .black
        shutter.backgroundColor = .white
        shutter.layer.cornerRadius = 36
        shutter.accessibilityLabel = "Take A Photo"
        shutter.addTarget(self, action: #selector(shutterTapped), for: .touchUpInside)
        for b in [cancelButton, finishButton, shutter] {
            b.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(b)
        }

        buildBox.translatesAutoresizingMaskIntoConstraints = false
        buildBox.backgroundColor = UIColor.black.withAlphaComponent(0.88)
        buildBox.isHidden = true
        view.addSubview(buildBox)
        let buildTitle = UILabel()
        buildTitle.text = "Building the model…"
        buildTitle.font = .systemFont(ofSize: 22, weight: .bold)
        buildTitle.textColor = .white
        buildTitle.textAlignment = .center
        buildLabel.font = .systemFont(ofSize: 15, weight: .medium)
        buildLabel.textColor = UIColor.white.withAlphaComponent(0.8)
        buildLabel.textAlignment = .center
        buildLabel.numberOfLines = 2
        buildLabel.text = "0% — a few minutes on the phone; keep the app open"
        buildBar.progressTintColor = .white
        buildBar.trackTintColor = UIColor.white.withAlphaComponent(0.25)
        let buildCancel = UIButton(type: .system)
        buildCancel.setTitle("Cancel", for: .normal)
        buildCancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        Self.style(buildCancel, filled: false)
        let stack = UIStackView(arrangedSubviews: [buildTitle, buildBar, buildLabel, buildCancel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        buildBox.addSubview(stack)

        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            cancelButton.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            cancelButton.topAnchor.constraint(equalTo: g.topAnchor, constant: 12),
            cancelButton.heightAnchor.constraint(equalToConstant: 44),
            counter.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            counter.centerYAnchor.constraint(equalTo: cancelButton.centerYAnchor),
            counter.heightAnchor.constraint(equalToConstant: 36),
            counter.widthAnchor.constraint(greaterThanOrEqualToConstant: 110),

            shutter.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            shutter.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -24),
            shutter.widthAnchor.constraint(equalToConstant: 72),
            shutter.heightAnchor.constraint(equalToConstant: 72),
            finishButton.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            finishButton.centerYAnchor.constraint(equalTo: shutter.centerYAnchor),
            finishButton.heightAnchor.constraint(equalToConstant: 44),

            hint.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            hint.bottomAnchor.constraint(equalTo: shutter.topAnchor, constant: -18),
            hint.widthAnchor.constraint(lessThanOrEqualTo: g.widthAnchor, constant: -32),
            hint.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),

            buildBox.topAnchor.constraint(equalTo: view.topAnchor),
            buildBox.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            buildBox.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            buildBox.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.centerXAnchor.constraint(equalTo: buildBox.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: buildBox.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: buildBox.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: buildBox.trailingAnchor, constant: -32),
            buildBar.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        counter.text = "  0 photos  "
        say("Finding the surfaces — move the phone slowly")
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        guard pendingOutcome == nil else { return }
        haptic.prepare()
        run(highResolution: true)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sceneView.session.pause()
    }

    override func finish(_ outcome: ScanOutcome) {
        UIApplication.shared.isIdleTimerDisabled = false
        super.finish(outcome)
    }

    /// World tracking with the LiDAR mesh, the depth map and — first try — the video format that
    /// gives 12 MP stills (iOS 16's captureHighResolutionFrame).
    private func run(highResolution: Bool) {
        let config = ARWorldTrackingConfiguration()
        config.sceneReconstruction = .mesh
        config.environmentTexturing = .none
        config.worldAlignment = .gravity
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) { config.frameSemantics.insert(.smoothedSceneDepth) }
        else if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) { config.frameSemantics.insert(.sceneDepth) }
        if highResolution, let format = ARWorldTrackingConfiguration.recommendedVideoFormatForHighResolutionFrameCapturing { config.videoFormat = format }
        startedAt = Date()
        sceneView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
    }

    private func say(_ s: String) {
        hint.text = "  \(s)  "
    }

    private func refreshCounter() {
        counter.text = "  \(shots) photo\(shots == 1 ? "" : "s")  "
        finishButton.isEnabled = shots >= Self.minShots && !processing && !finishWaiting
    }

    private var walkHint: String {
        if shots >= Self.maxShots { return "That's the most photos for one scan — Finish." }
        if shots >= Self.minShots { return "Keep going until the blue is gone, then Finish." }
        return "Walk slowly and point at every surface. Blue is what the scan still needs; it clears as photos land."
    }

    // MARK: Buttons

    @objc private func shutterTapped() {
        guard !processing, !finishWaiting, !shotInFlight, shots < Self.maxShots else { return }
        guard let frame = sceneView.session.currentFrame else { return }
        guard trackingNormal else {
            say("Hold on — the camera is still finding its place")
            return
        }
        takeShot(frame)
    }

    @objc private func finishTapped() {
        guard !finished, !processing, !finishWaiting, shots >= Self.minShots else { return }
        finishWaiting = true
        finishButton.isEnabled = false
        shutter.isEnabled = false
        say("Finishing the capture…")
        startBuildWhenWritten()
    }

    /// Cancel with photos taken, or mid-build, asks first: one tap must not throw away minutes of walking.
    @objc private func cancelTapped() {
        guard !finished else { return }
        if shots == 0 && !processing {
            dropScan()
            return
        }
        let alert = UIAlertController(title: processing ? "Drop This Model?" : "Drop This Scan?", message: processing ? "The model is still building. Dropping it throws the photos away." : "\(shots) photo\(shots == 1 ? "" : "s") so far would be thrown away.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Keep Going", style: .cancel))
        alert.addAction(UIAlertAction(title: "Drop It", style: .destructive) { [weak self] _ in self?.dropScan() })
        (presentedViewController ?? self).present(alert, animated: true)
    }

    private func dropScan() {
        guard !finished else { return }
        if processing { photo?.cancel() }
        cleanup(keepModel: false)
        finish(.cancelled)
    }

    // MARK: The photos

    /// Every frame: a new photo once the walk has moved or turned enough since the last one.
    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard trackingNormal, !shotInFlight, !processing, !finishWaiting, !finished, shots < Self.maxShots else { return }
        guard frame.timestamp - lastShotAt >= Self.shotGap else { return }
        let t = frame.camera.transform
        if let last = lastShotTransform {
            let moved = simd_distance(Self.position(t), Self.position(last))
            let turned = Self.angle(Self.forward(t), Self.forward(last))
            guard moved >= Self.moveStep || turned >= Self.turnStep else { return }
        } else if !meshSeen {
            return
        }
        takeShot(frame)
    }

    static func position(_ t: simd_float4x4) -> simd_float3 { simd_float3(t.columns.3.x, t.columns.3.y, t.columns.3.z) }
    static func forward(_ t: simd_float4x4) -> simd_float3 { -simd_float3(t.columns.2.x, t.columns.2.y, t.columns.2.z) }
    static func angle(_ a: simd_float3, _ b: simd_float3) -> Float { acos(max(-1, min(1, simd_dot(simd_normalize(a), simd_normalize(b))))) }

    /// Asks ARKit for the 12 MP still; the frame in hand is the fallback (its 1920×1440 image) and
    /// the pose the coverage is judged from.
    private func takeShot(_ frame: ARFrame) {
        shotInFlight = true
        lastShotAt = frame.timestamp
        lastShotTransform = frame.camera.transform
        sceneView.session.captureHighResolutionFrame { [weak self] hi, _ in
            DispatchQueue.main.async { self?.landShot(hi ?? frame, pose: frame) }
        }
    }

    /// The photo is in hand: counted, felt, written off the main thread; the faces it saw go clear.
    /// `frame` is the photo (its own camera judges what it saw); `pose` is the frame the request
    /// rode, kept for its depth map when the photo carries none.
    private func landShot(_ frame: ARFrame, pose: ARFrame) {
        shotInFlight = false
        guard !finished, !processing else { return }
        shots += 1
        nextId += 1
        let id = nextId
        refreshCounter()
        haptic.impactOccurred()
        if frame === pose, !saidLowRes {
            saidLowRes = true
            say("This phone gave no full-size photo — the scan uses the camera feed's; the model will be rougher.")
        } else {
            say(walkHint)
        }

        let image = frame.capturedImage
        let depthMap = (frame.smoothedSceneDepth ?? frame.sceneDepth ?? pose.smoothedSceneDepth ?? pose.sceneDepth)?.depthMap
        let depth = depthMap.flatMap(Self.floats(of:))
        let cam = frame.camera
        let gravity = Self.gravity(in: cam.transform)
        let seen = ShotView(transform: cam.transform, intrinsics: cam.intrinsics, width: Float(cam.imageResolution.width), height: Float(cam.imageResolution.height), depth: depth?.floats ?? [], depthWidth: depth?.width ?? 0, depthHeight: depth?.height ?? 0)
        let snaps = Array(self.snaps.values)
        work.async { [weak self] in
            guard let self else { return }
            self.mark(seen, over: snaps)
            DispatchQueue.main.async { self.redrawAll() }
        }

        pendingWrites += 1
        let dir = folder
        encode.async { [weak self] in
            let name = String(format: "shot-%04d.jpg", id)
            var record: ShotRecord?
            if let jpeg = Self.jpeg(of: image) {
                do {
                    try jpeg.write(to: dir.appendingPathComponent(name))
                    var depthName: String?
                    if let depth {
                        let dn = String(format: "shot-%04d.depth", id)
                        if (try? depth.data.write(to: dir.appendingPathComponent(dn))) != nil { depthName = dn }
                    }
                    record = ShotRecord(id: id, image: name, depth: depthName, depthWidth: depth?.width ?? 0, depthHeight: depth?.height ?? 0, gravity: gravity)
                } catch {
                    record = nil
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.pendingWrites -= 1
                if let record { self.records.append(record) }
                else if !self.finished {
                    self.shots = max(0, self.shots - 1)
                    self.refreshCounter()
                    self.say("A photo couldn't be saved. Free some space on the phone.")
                }
                if self.finishWaiting { self.startBuildWhenWritten() }
            }
        }
    }

    static let jpegContext = CIContext(options: [.useSoftwareRenderer: false])

    static func jpeg(of image: CVPixelBuffer) -> Data? {
        let ci = CIImage(cvPixelBuffer: image)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        return jpegContext.jpegRepresentation(of: ci, colorSpace: space, options: [quality: 0.92])
    }

    /// The depth map's meters, copied out of ARKit's buffer: raw bytes for the disk, floats for the test.
    static func floats(of map: CVPixelBuffer) -> (data: Data, floats: [Float], width: Int, height: Int)? {
        guard CVPixelBufferGetPixelFormatType(map) == kCVPixelFormatType_DepthFloat32 else { return nil }
        CVPixelBufferLockBaseAddress(map, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
        let w = CVPixelBufferGetWidth(map), h = CVPixelBufferGetHeight(map), bpr = CVPixelBufferGetBytesPerRow(map)
        guard w > 0, h > 0, let base = CVPixelBufferGetBaseAddress(map) else { return nil }
        var data = Data(capacity: w * h * 4)
        for row in 0..<h { data.append(Data(bytes: base.advanced(by: row * bpr), count: w * 4)) }
        let floats = data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        return (data, floats, w, h)
    }

    /// Gravity in the device's frame (CoreMotion's: x out the right edge, y out the top, z out of
    /// the screen). ARKit's camera frame has x running from the front camera toward the bottom of the
    /// phone and y across it, so world "down" is carried into the camera frame and turned.
    static func gravity(in camera: simd_float4x4) -> CMAcceleration {
        let r = simd_float3x3(columns: (
            simd_float3(camera.columns.0.x, camera.columns.0.y, camera.columns.0.z),
            simd_float3(camera.columns.1.x, camera.columns.1.y, camera.columns.1.z),
            simd_float3(camera.columns.2.x, camera.columns.2.y, camera.columns.2.z)))
        let g = r.transpose * simd_float3(0, -1, 0)
        return CMAcceleration(x: Double(g.y), y: Double(-g.x), z: Double(g.z))
    }

    // MARK: Coverage (the `work` queue)

    /// A face a photo saw: its centre is in front of the lens, within reach, inside the picture,
    /// facing the lens, and — where the depth map has a reading there — not behind something nearer.
    private func mark(_ v: ShotView, over snaps: [MeshSnap]) {
        let toCamera = simd_inverse(v.transform)
        let fx = v.intrinsics.columns.0.x, fy = v.intrinsics.columns.1.y
        let cx = v.intrinsics.columns.2.x, cy = v.intrinsics.columns.2.y
        let eye = Self.position(v.transform)
        let hasDepth = v.depthWidth > 0 && v.depth.count == v.depthWidth * v.depthHeight
        for snap in snaps {
            var i = 0
            while i + 2 < snap.faces.count {
                let ia = snap.faces[i], ib = snap.faces[i + 1], ic = snap.faces[i + 2]
                i += 3
                let a = snap.world(ia), b = snap.world(ib), c = snap.world(ic)
                let centre = (a + b + c) / 3
                let p = toCamera * simd_float4(centre, 1)
                let z = -p.z
                guard z > 0.1, z < Self.reach else { continue }
                let u = fx * (p.x / z) + cx
                let w = fy * (-p.y / z) + cy
                guard u >= 0, u < v.width, w >= 0, w < v.height else { continue }
                // Behind something nearer, per the depth map; where the map has no reading there,
                // the face must at least face the lens (ARKit's own normals — a zero one is trusted).
                var reading: Float = 0
                if hasDepth {
                    let du = min(v.depthWidth - 1, Int(u / v.width * Float(v.depthWidth)))
                    let dv = min(v.depthHeight - 1, Int(w / v.height * Float(v.depthHeight)))
                    let d = v.depth[dv * v.depthWidth + du]
                    if d.isFinite, d > 0 { reading = d }
                }
                if reading > 0 {
                    if z > reading + 0.08 + 0.06 * z { continue }
                } else {
                    let normal = snap.worldNormal(ia) + snap.worldNormal(ib) + snap.worldNormal(ic)
                    if normal != .zero, simd_dot(normal, eye - centre) <= 0 { continue }
                }
                covered.insert(Self.key(centre))
            }
        }
    }

    /// The grid cell a point is in, packed into one integer (21 bits per axis, ±100 km at 10 cm).
    static func key(_ p: simd_float3) -> Int64 {
        guard p.x.isFinite, p.y.isFinite, p.z.isFinite else { return .min }
        let bias: Int64 = 1 << 20
        let mask: Int64 = (1 << 21) - 1
        let x = (Int64(floor(p.x / cell)) + bias) & mask
        let y = (Int64(floor(p.y / cell)) + bias) & mask
        let z = (Int64(floor(p.z / cell)) + bias) & mask
        return (x << 42) | (y << 21) | z
    }

    /// The geometry of one anchor's UNCOVERED faces (the covered ones are not drawn: that is the clear).
    private func uncovered(_ snap: MeshSnap) -> SCNGeometry? {
        var idx: [UInt32] = []
        idx.reserveCapacity(snap.faces.count)
        var i = 0
        while i + 2 < snap.faces.count {
            let a = snap.world(snap.faces[i]), b = snap.world(snap.faces[i + 1]), c = snap.world(snap.faces[i + 2])
            if !covered.contains(Self.key((a + b + c) / 3)) { idx.append(contentsOf: snap.faces[i..<i + 3]) }
            i += 3
        }
        guard !idx.isEmpty else { return nil }
        let vData = snap.vertices.withUnsafeBufferPointer { Data(buffer: $0) }
        let vSrc = SCNGeometrySource(data: vData, semantic: .vertex, vectorCount: snap.vertices.count, usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: MemoryLayout<Float>.size, dataOffset: 0, dataStride: MemoryLayout<simd_float3>.stride)
        let el = SCNGeometryElement(data: idx.withUnsafeBufferPointer { Data(buffer: $0) }, primitiveType: .triangles, primitiveCount: idx.count / 3, bytesPerIndex: 4)
        let g = SCNGeometry(sources: [vSrc], elements: [el])
        g.materials = [Self.blue]
        return g
    }

    static let blue: SCNMaterial = {
        let m = SCNMaterial()
        m.diffuse.contents = UIColor(red: 0.25, green: 0.55, blue: 1, alpha: 0.5)
        m.lightingModel = .constant
        m.isDoubleSided = true
        m.blendMode = .alpha
        m.writesToDepthBuffer = true
        m.readsFromDepthBuffer = true
        return m
    }()

    // MARK: The mesh (main thread)

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        for case let mesh as ARMeshAnchor in anchors {
            meshes[mesh.identifier] = mesh
            let node = SCNNode()
            node.simdTransform = mesh.transform
            nodes[mesh.identifier] = node
            sceneView.scene.rootNode.addChildNode(node)
            dirty.insert(mesh.identifier)
        }
        if !meshSeen, !meshes.isEmpty {
            meshSeen = true
            if trackingNormal { say(walkHint) }
        }
        scheduleFlush()
    }

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        for case let mesh as ARMeshAnchor in anchors {
            meshes[mesh.identifier] = mesh
            nodes[mesh.identifier]?.simdTransform = mesh.transform
            dirty.insert(mesh.identifier)
        }
        scheduleFlush()
    }

    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        for case let mesh as ARMeshAnchor in anchors {
            meshes.removeValue(forKey: mesh.identifier)
            snaps.removeValue(forKey: mesh.identifier)
            nodes.removeValue(forKey: mesh.identifier)?.removeFromParentNode()
            dirty.remove(mesh.identifier)
        }
    }

    /// Mesh updates come several times a second; the redraw runs at most four times a second.
    private func scheduleFlush() {
        guard !flushScheduled, !processing else { return }
        flushScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self else { return }
            self.flushScheduled = false
            for id in self.dirty { if let mesh = self.meshes[id] { self.snaps[id] = MeshSnap(mesh) } }
            self.redraw(Array(self.dirty))
            self.dirty.removeAll()
        }
    }

    private func redrawAll() { redraw(Array(snaps.keys)) }

    /// The cached copies (main), the uncovered faces found on `work`, the nodes updated back here.
    private func redraw(_ ids: [UUID]) {
        guard !processing else { return }
        let snaps = ids.compactMap { self.snaps[$0] }
        guard !snaps.isEmpty else { return }
        work.async { [weak self] in
            guard let self else { return }
            let built = snaps.map { ($0.id, $0.transform, self.uncovered($0)) }
            DispatchQueue.main.async {
                for (id, transform, g) in built {
                    guard let node = self.nodes[id] else { continue }
                    node.simdTransform = transform
                    node.geometry = g
                }
            }
        }
    }

    // MARK: Tracking

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        if case .normal = camera.trackingState { trackingNormal = true } else { trackingNormal = false }
        switch camera.trackingState {
        case .notAvailable:
            say("The camera can't track right now — hold still")
        case .limited(let reason):
            switch reason {
            case .excessiveMotion: say("Slow down — the camera lost its place")
            case .insufficientFeatures: say("Too dark or too plain here — add light or step back")
            case .initializing: say("Finding the surfaces — move the phone slowly")
            case .relocalizing: say("Finding its place again — hold still")
            @unknown default: say("Finding the surfaces — move the phone slowly")
            }
        case .normal:
            say(meshSeen ? walkHint : "Finding the surfaces — move the phone slowly")
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        // The high-resolution video format refused at start: once more with the default one.
        if !formatRetried, !processing, Date().timeIntervalSince(startedAt) < 5 {
            formatRetried = true
            run(highResolution: false)
            return
        }
        cleanup(keepModel: false)
        finish(.failed("The camera couldn't scan (\(error.localizedDescription)). Try again."))
    }

    /// An interruption (a call, the app put away) can move the world origin: the coverage is judged
    /// in that origin, so the blue starts over; the photos are kept (the model does not care).
    func sessionWasInterrupted(_ session: ARSession) {
        trackingNormal = false
        lastShotTransform = nil
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        work.async { [weak self] in self?.covered.removeAll() }
        redrawAll()
        say("Scanning was interrupted — the photos are kept; the blue starts over")
    }

    func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { false }

    // MARK: The model

    private func startBuildWhenWritten() {
        guard finishWaiting, !processing, !finished, !shotInFlight, pendingWrites == 0 else { return }
        buildModel()
    }

    /// Photogrammetry's errors in plain words (the raw ones read "The operation couldn't be completed").
    static func buildSentence(_ error: Error) -> String {
        if let e = error as? PhotogrammetrySession.Error {
            switch e {
            case .insufficientStorage: return "This phone is out of space for the model. Free some space and try again."
            case .invalidImages: return "The photos couldn't be used for a model. Try again with more light and a slower walk."
            case .invalidOutput: return "The model couldn't be written on this phone. Try again."
            @unknown default: break
            }
        }
        return "The model didn't build. Try again with more light, a slower walk and at least 10 photos."
    }

    /// The photos are on disk: the camera stops, the mesh goes, and the model builds from them.
    private func buildModel() {
        guard !finished, !processing else { return }
        guard records.count >= Self.minShots else {
            finishWaiting = false
            shutter.isEnabled = true
            refreshCounter()
            say("Only \(records.count) photo\(records.count == 1 ? " was" : "s were") saved — take at least \(Self.minShots), then Finish.")
            return
        }
        processing = true
        sceneView.session.pause()
        for node in nodes.values { node.removeFromParentNode() }
        nodes.removeAll()
        sceneView.isHidden = true
        buildBox.isHidden = false
        let shots = records.count
        var config = PhotogrammetrySession.Configuration()
        // A room or a site, not one thing on a table: nothing is cut away as "background". The
        // photos come in walking order, which the session can use.
        config.isObjectMaskingEnabled = false
        config.sampleOrdering = .sequential
        config.checkpointDirectory = checkpointDir
        let photo: PhotogrammetrySession
        do {
            photo = try PhotogrammetrySession(input: ShotSamples(dir: folder, records: records.sorted { $0.id < $1.id }), configuration: config)
        } catch {
            cleanup(keepModel: false)
            finish(.failed("The phone couldn't start building the model (\(error.localizedDescription)). Try again."))
            return
        }
        self.photo = photo
        let output = outputURL
        Task { [weak self] in
            do {
                try photo.process(requests: [.modelFile(url: output, detail: .reduced)])
                for try await o in photo.outputs {
                    switch o {
                    case .requestProgress(_, let fraction):
                        await MainActor.run {
                            self?.buildBar.setProgress(Float(fraction), animated: true)
                            self?.buildLabel.text = "\(Int(fraction * 100))% — a few minutes on the phone; keep the app open"
                        }
                    case .requestError(_, let error):
                        await MainActor.run {
                            guard let self, !self.finished else { return }
                            self.cleanup(keepModel: false)
                            self.finish(.failed(Self.buildSentence(error)))
                        }
                        return
                    case .processingCancelled:
                        // A cancel of ours set `finished` first; any other end is said.
                        await MainActor.run { self?.buildEnded() }
                        return
                    case .requestComplete(_, .modelFile):
                        await MainActor.run {
                            guard let self, !self.finished else { return }
                            let bytes = (try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? NSNumber)?.intValue ?? 0
                            self.cleanup(keepModel: true)
                            guard bytes > 0 else {
                                self.finish(.failed("The model came out empty. Try again with more light and a slower walk."))
                                return
                            }
                            self.finish(.scanned(["ok": true, "kind": "model", "path": output.path, "bytes": bytes, "mime": "model/vnd.usdz+zip", "shots": shots]))
                        }
                        return
                    default:
                        break
                    }
                }
                // The stream closed without a model, an error or a cancel.
                await MainActor.run { self?.buildEnded() }
            } catch {
                await MainActor.run {
                    guard let self, !self.finished else { return }
                    self.cleanup(keepModel: false)
                    self.finish(.failed(Self.buildSentence(error)))
                }
            }
        }
    }

    /// The build stopped with nothing to show (the system cancelled it, the stream closed): said,
    /// so the screen never sits on "Building the model…" for good (skeptic #19).
    private func buildEnded() {
        guard !finished else { return }
        cleanup(keepModel: false)
        finish(.failed("The model didn't finish building. Try again."))
    }

    /// The photos, depth maps and checkpoints go as soon as the model is built (or the scan is
    /// dropped); the model stays for the page to read, and goes on its discard.
    private func cleanup(keepModel: Bool) {
        try? FileManager.default.removeItem(at: folder)
        if !keepModel { try? FileManager.default.removeItem(at: outputURL) }
    }
}

// MARK: - Quick Look for a model (Open In AR)

/// Holds a QLPreviewController and its one file for as long as it is up; the closure runs on dismiss.
final class ModelPreview: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    let controller = QLPreviewController()
    private let url: URL
    private let closed: () -> Void
    private var done = false

    init(url: URL, closed: @escaping () -> Void) {
        self.url = url
        self.closed = closed
        super.init()
        controller.dataSource = self
        controller.delegate = self
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    func previewControllerDidDismiss(_ controller: QLPreviewController) {
        guard !done else { return }
        done = true
        closed()
    }
}
