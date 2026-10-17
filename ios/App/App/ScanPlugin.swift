import ARKit
import AVFoundation
import Capacitor
import CoreImage
import QuickLook
import SceneKit
import UIKit

/// LIDAR — 3D SCAN (field feedback 10-13, item 5; Erik 2026-10-16, after Polycam: "collect all of
/// the pixels for all surfaces and render an image … i want that"; "lets group everything with a
/// title called Lidar … lets get the 3D scan working great"; and on the photogrammetry cut: "is
/// there a way to make it do micro images that cluster instead of full size images … PolyCam was
/// pretty good but i challenge you to do better").
///
/// ONE DOOR. scan3d opens OUR OWN capture screen: ARKit tracks the walk and draws the LiDAR mesh
/// blue; the phone keeps a frame of the camera feed every ~0.3 m or 10° of turn (and on the button),
/// and every face a frame saw turns clear — what is still blue is what the scan still needs. Finish
/// PAINTS the final mesh from the frames it kept (the Painter below: each face takes its pixels from
/// the frame that saw it best) and writes the USDZ — the way Polycam's LiDAR mode works: no
/// photogrammetry, no solver, nothing to fail on a plain wall, upright and life-size because the
/// mesh already lives in ARKit's metric, gravity-aligned world. The file can be tens of megabytes,
/// so it stays in the app's temp folder and the page pulls it through readChunk in 2 MB pieces
/// (never one giant string over the bridge), then discards it. No numbers come from this door: the
/// measurements are Measure's (MeasurePlugin), beside it under the Lidar title.
///
/// The site and room doors of cn-v1115 (tapped corners; Apple's room capture) and the photogrammetry
/// cut of cn-v1117–1119 (Apple's capture, then our 12 MP stills) are gone by Erik's decisions.
///
/// No network from here (the agent security framework). A phone that cannot scan rejects with ONE
/// plain sentence the page shows as-is (NOTHING SILENT); Cancel resolves {ok:false, cancelled:true}.
/// A LOCAL plugin like MeasurePlugin: ARKit and SceneKit ship with iOS. The shell has to be REBUILT
/// for it (the Debug build on the cabled phone).
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

    /// A painted model is the LiDAR mesh and the camera feed (ARKit), written by SceneKit.
    static var modelSupported: Bool {
        if #available(iOS 17.0, *) { return lidarPresent }
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

// MARK: - 3D SCAN (our own capture: the LiDAR mesh painted with the camera's own pixels)

/// One frame kept during the walk: its camera, and where its picture and depth map sit on disk.
struct Keyframe {
    let id: Int
    let transform: simd_float4x4
    let intrinsics: simd_float3x3
    let width: Float
    let height: Float
    let depthWidth: Int
    let depthHeight: Int
    let image: String
    let depth: String?
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
    /// A sphere round the anchor (world): a frame skips the anchors wholly out of its reach or behind it.
    let center: simd_float3
    let radius: Float

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
        var lo = verts.first ?? .zero, hi = lo
        for p in verts { lo = simd_min(lo, p); hi = simd_max(hi, p) }
        let mid = transform * simd_float4((lo + hi) / 2, 1)
        center = simd_float3(mid.x, mid.y, mid.z)
        radius = simd_length(hi - lo) / 2
    }

    func world(_ i: UInt32) -> simd_float3 {
        let p = transform * simd_float4(vertices[Int(i)], 1)
        return simd_float3(p.x, p.y, p.z)
    }

    func worldNormal(_ i: UInt32) -> simd_float3 {
        Int(i) < normals.count ? rotation * normals[Int(i)] : .zero
    }
}

/// What a frame saw: the camera it was taken with and the depth behind it, for the coverage test.
struct ShotView {
    let transform: simd_float4x4
    let intrinsics: simd_float3x3
    let width: Float
    let height: Float
    let depth: [Float]
    let depthWidth: Int
    let depthHeight: Int
}

/// A flag one thread sets and another reads (Cancel during the painting).
final class Flag {
    private let lock = NSLock()
    private var on = false
    func set() { lock.lock(); on = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return on }
}

/// THE PAINTER. Erik 2026-10-16: "is there a way to make it do micro images that cluster instead
/// of full size images" — yes: this is how Polycam's LiDAR mode works. The LiDAR mesh is the shape;
/// the camera's frames are the pixels. Every face of the final mesh is given to the keyframe that
/// saw it best (facing it, near, the whole face inside the picture, not behind something nearer per
/// the frame's depth map), and a small square of the texture atlas is painted for it straight out of
/// that frame. No photogrammetry, no solver, nothing to fail on a plain wall; the mesh is already
/// metric and gravity-aligned (ARKit's world), so the model stands upright at its real size.
@available(iOS 17.0, *)
enum Painter {
    /// A face in world space (metres), its vertices in the order the atlas cell maps them.
    struct Face {
        let a: simd_float3
        let b: simd_float3
        let c: simd_float3
        let normal: simd_float3
    }

    /// Whether a USDZ carries an image: its zip's central directory (always the true sizes, whatever
    /// the writer put in the local headers) names an image entry (SceneKit's is 0/texgen_0.png).
    static func carriesImage(_ url: URL) -> Bool {
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe), data.count > 22 else { return false }
        let u16 = { (i: Int) -> Int in Int(data[i]) | Int(data[i + 1]) << 8 }
        let u32 = { (i: Int) -> Int in u16(i) | u16(i + 2) << 16 }
        // The end-of-central-directory record sits in the last 64 KB + 22 bytes.
        var end = -1
        var i = data.count - 22
        let stop = Swift.max(0, data.count - 22 - 65_536)
        while i >= stop {
            if data[i] == 0x50, data[i + 1] == 0x4B, data[i + 2] == 0x05, data[i + 3] == 0x06 { end = i; break }
            i -= 1
        }
        guard end >= 0 else { return false }
        let entries = u16(end + 10)
        var at = u32(end + 16)
        for _ in 0..<entries {
            guard at + 46 <= data.count, data[at] == 0x50, data[at + 1] == 0x4B, data[at + 2] == 0x01, data[at + 3] == 0x02 else { return false }
            let nameLength = u16(at + 28), extraLength = u16(at + 30), commentLength = u16(at + 32)
            guard at + 46 + nameLength <= data.count else { return false }
            let name = String(decoding: data[(at + 46)..<(at + 46 + nameLength)], as: UTF8.self).lowercased()
            if [".png", ".jpg", ".jpeg", ".exr", ".heic", ".heif", ".tif", ".tiff"].contains(where: { name.hasSuffix($0) }) { return true }
            at += 46 + nameLength + extraLength + commentLength
        }
        return false
    }

    /// The texture: one square cell per face, `cell` texels on a side.
    struct Atlas {
        let size: Int
        let cell: Int
        var perRow: Int { size / cell }
    }

    /// 4096 texels across for a room, smaller for a nook; cells as big as the face count allows
    /// (eight or more texels across a 5 cm triangle is a photo; three is the floor).
    static func atlas(forFaces n: Int) -> Atlas {
        let side = Int(ceil(sqrt(Double(max(1, n)))))
        var size = 512
        while size < side * 8 && size < 4096 { size *= 2 }
        // Multiples of four: the viewer's smaller mip levels then stay inside a cell (no fringe).
        let cell = max(4, min(12, (size / max(1, side)) & ~3))
        return Atlas(size: size, cell: cell)
    }

    /// The most faces one atlas holds (4096² at four texels a cell): a house and its yard. Beyond
    /// it the scan is refused in words rather than painted wrong.
    static let maxFaces = 1_000_000
    /// How far from the eye a face still counts as seen (meters) — the blue and the painter share it.
    static let reach: Float = 6

    /// A world point in a frame's picture: (u, v) in its pixels, z the distance along the lens.
    @inline(__always)
    static func project(_ p: simd_float3, _ toCamera: simd_float4x4, _ k: simd_float3x3) -> (u: Float, v: Float, z: Float) {
        let c = toCamera * simd_float4(p, 1)
        let z = -c.z
        guard z > 0.05 else { return (-1, -1, z) }
        return (k.columns.0.x * (c.x / z) + k.columns.2.x, k.columns.1.y * (-c.y / z) + k.columns.2.y, z)
    }

    /// ONE RULE: how well a frame saw a face — 0 when it did not. Facing the lens (ARKit's normal),
    /// near, the whole face inside the picture with a margin, and its centre not behind something
    /// nearer per the frame's depth map. The coverage (the blue) and the painter both ask this, so
    /// the blue never clears where the painter would leave grey.
    @inline(__always)
    static func score(_ a: simd_float3, _ b: simd_float3, _ c: simd_float3, normal: simd_float3, toCamera: simd_float4x4, eye: simd_float3, k: simd_float3x3, width: Float, height: Float, depth: UnsafeBufferPointer<Float>?, depthWidth: Int, depthHeight: Int) -> Float {
        let margin: Float = 6
        let centre = (a + b + c) / 3
        let toEye = eye - centre
        let d = simd_length(toEye)
        guard d > 0.15, d < reach else { return 0 }
        let facing = simd_dot(normal, toEye / d)
        guard facing > 0.25 else { return 0 }
        let pa = project(a, toCamera, k)
        let pb = project(b, toCamera, k)
        let pc = project(c, toCamera, k)
        guard pa.z > 0.05, pb.z > 0.05, pc.z > 0.05,
              pa.u >= margin, pa.u < width - margin, pa.v >= margin, pa.v < height - margin,
              pb.u >= margin, pb.u < width - margin, pb.v >= margin, pb.v < height - margin,
              pc.u >= margin, pc.u < width - margin, pc.v >= margin, pc.v < height - margin else { return 0 }
        if let depth, depthWidth > 0, depthHeight > 0, depth.count == depthWidth * depthHeight {
            let pm = project(centre, toCamera, k)
            let du = min(depthWidth - 1, max(0, Int(pm.u / width * Float(depthWidth))))
            let dv = min(depthHeight - 1, max(0, Int(pm.v / height * Float(depthHeight))))
            let reading = depth[dv * depthWidth + du]
            if reading.isFinite, reading > 0, pm.z > reading + 0.08 + 0.06 * pm.z { return 0 }
        }
        return facing / (d + 0.3)
    }

    /// For every face, the keyframe that saw it best (-1: none did). Each frame's pass runs over
    /// the faces on every core (disjoint slices of `best` and `score`).
    @_optimize(speed)
    static func assign(_ faces: [Face], keyframes: [Keyframe], dir: URL, cancelled: Flag, progress: (Double) -> Void) -> [Int32] {
        var best = [Int32](repeating: -1, count: faces.count)
        var bestScore = [Float](repeating: 0, count: faces.count)
        let chunks = max(1, min(16, faces.count / 4096))
        let per = (faces.count + chunks - 1) / chunks
        for (k, kf) in keyframes.enumerated() {
            if cancelled.isSet { return best }
            let depth = kf.depth.flatMap { Scan3DViewController.depthFloats(at: dir.appendingPathComponent($0), count: kf.depthWidth * kf.depthHeight) }
            let toCamera = simd_inverse(kf.transform)
            let eye = Scan3DViewController.position(kf.transform)
            // The depth map in a plain buffer for the pass (the cores read it, nothing writes it).
            let dbuf = UnsafeMutableBufferPointer<Float>.allocate(capacity: max(1, depth?.count ?? 0))
            defer { dbuf.deallocate() }
            var dp: UnsafeBufferPointer<Float>? = nil
            if let depth {
                _ = dbuf.initialize(from: depth)
                dp = UnsafeBufferPointer(dbuf)
            }
            faces.withUnsafeBufferPointer { fp in
                best.withUnsafeMutableBufferPointer { bp in
                    bestScore.withUnsafeMutableBufferPointer { sp in
                        DispatchQueue.concurrentPerform(iterations: chunks) { chunk in
                            let lo = chunk * per, hi = min(fp.count, lo + per)
                            var i = lo
                            while i < hi {
                                let f = fp[i]
                                let v = score(f.a, f.b, f.c, normal: f.normal, toCamera: toCamera, eye: eye, k: kf.intrinsics, width: kf.width, height: kf.height, depth: dp, depthWidth: kf.depthWidth, depthHeight: kf.depthHeight)
                                if v > sp[i] {
                                    sp[i] = v
                                    bp[i] = Int32(k)
                                }
                                i += 1
                            }
                        }
                    }
                }
            }
            progress(Double(k + 1) / Double(max(1, keyframes.count)))
        }
        return best
    }

    /// The atlas, RGBA, row 0 at the top: every cell painted from its face's keyframe — the whole
    /// square, the texels outside the triangle clamped onto it, so filtering at the edges never
    /// pulls in a neighbour's colours. Faces no frame saw stay a quiet grey.
    @_optimize(speed)
    static func paint(_ faces: [Face], best: [Int32], keyframes: [Keyframe], dir: URL, atlas: Atlas, cancelled: Flag, progress: (Double) -> Void) -> [UInt8] {
        let size = atlas.size, cell = atlas.cell, perRow = atlas.perRow
        var pixels = [UInt8](repeating: 150, count: size * size * 4)
        var i = 3
        while i < pixels.count { pixels[i] = 255; i += 4 }
        var byFrame = [[Int]](repeating: [], count: keyframes.count)
        for (face, b) in best.enumerated() where b >= 0 { byFrame[Int(b)].append(face) }
        let span = Float(max(1, cell - 2))
        for (k, list) in byFrame.enumerated() {
            if cancelled.isSet { return pixels }
            defer { progress(Double(k + 1) / Double(max(1, keyframes.count))) }
            guard !list.isEmpty, let img = rgba(of: dir.appendingPathComponent(keyframes[k].image)) else { continue }
            let kf = keyframes[k]
            let toCamera = simd_inverse(kf.transform)
            let sx = Float(img.width) / kf.width, sy = Float(img.height) / kf.height
            let maxU = Float(img.width - 1), maxV = Float(img.height - 1)
            let chunks = max(1, min(16, list.count / 512))
            let per = (list.count + chunks - 1) / chunks
            pixels.withUnsafeMutableBufferPointer { pp in
                img.bytes.withUnsafeBufferPointer { ip in
                    DispatchQueue.concurrentPerform(iterations: chunks) { chunk in
                        let lo = chunk * per, hi = min(list.count, lo + per)
                        var n = lo
                        while n < hi {
                            let face = list[n]
                            n += 1
                            let f = faces[face]
                            let cx = (face % perRow) * cell, cy = (face / perRow) * cell
                            for ty in 0..<cell {
                                for tx in 0..<cell {
                                    var b1 = (Float(tx) + 0.5 - 1) / span
                                    var b2 = (Float(ty) + 0.5 - 1) / span
                                    b1 = max(0, b1)
                                    b2 = max(0, b2)
                                    if b1 + b2 > 1 {
                                        let s = b1 + b2
                                        b1 /= s
                                        b2 /= s
                                    }
                                    let p = (1 - b1 - b2) * f.a + b1 * f.b + b2 * f.c
                                    let pr = project(p, toCamera, kf.intrinsics)
                                    let u = Int(max(0, min(maxU, pr.u * sx))), v = Int(max(0, min(maxV, pr.v * sy)))
                                    let si = (v * img.width + u) * 4
                                    let di = ((cy + ty) * size + cx + tx) * 4
                                    pp[di] = ip[si]
                                    pp[di + 1] = ip[si + 1]
                                    pp[di + 2] = ip[si + 2]
                                }
                            }
                        }
                    }
                }
            }
        }
        return pixels
    }

    /// A frame's picture as RGBA bytes, row 0 at the top.
    static func rgba(of url: URL) -> (bytes: [UInt8], width: Int, height: Int)? {
        guard let cg = UIImage(contentsOfFile: url.path)?.cgImage else { return nil }
        let w = cg.width, h = cg.height
        guard w > 0, h > 0 else { return nil }
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        let ok: Bool = bytes.withUnsafeMutableBytes { buf in
            guard let base = buf.baseAddress, let ctx = CGContext(data: base, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        return ok ? (bytes, w, h) : nil
    }

    /// The atlas as an image for the USDZ (SceneKit's writer packs an image it is handed as a PNG;
    /// a file handed to it on iOS is left out).
    static func textureImage(_ pixels: inout [UInt8], size: Int) -> UIImage? {
        let image: CGImage? = pixels.withUnsafeMutableBytes { buf in
            guard let base = buf.baseAddress, let ctx = CGContext(data: base, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return nil }
            return ctx.makeImage()
        }
        guard let image else { return nil }
        return UIImage(cgImage: image)
    }

    /// The painted mesh: three vertices per face (each face owns its cell), normals, and the cell's
    /// corners as texture coordinates. SceneKit's own texture space runs TOP-DOWN like the atlas
    /// rows (its USD writer flips to USD's bottom-up itself — checked on the Mac with one triangle,
    /// 10-16, after the first painted model wore every other face's patch).
    static func geometry(_ faces: [Face], atlas: Atlas, texture: Any) -> SCNGeometry {
        let a = Float(atlas.size), n = Float(atlas.cell), perRow = atlas.perRow
        var pos = [simd_float3]()
        var nor = [simd_float3]()
        var uv = [simd_float2]()
        pos.reserveCapacity(faces.count * 3)
        nor.reserveCapacity(faces.count * 3)
        uv.reserveCapacity(faces.count * 3)
        for (i, f) in faces.enumerated() {
            pos.append(f.a); pos.append(f.b); pos.append(f.c)
            nor.append(f.normal); nor.append(f.normal); nor.append(f.normal)
            let cx = Float(i % perRow) * n, cy = Float(i / perRow) * n
            uv.append(simd_float2((cx + 1) / a, (cy + 1) / a))
            uv.append(simd_float2((cx + n - 1) / a, (cy + 1) / a))
            uv.append(simd_float2((cx + 1) / a, (cy + n - 1) / a))
        }
        var idx = [UInt32](repeating: 0, count: faces.count * 3)
        for i in 0..<idx.count { idx[i] = UInt32(i) }
        let vSrc = SCNGeometrySource(data: pos.withUnsafeBufferPointer { Data(buffer: $0) }, semantic: .vertex, vectorCount: pos.count, usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: MemoryLayout<simd_float3>.stride)
        let nSrc = SCNGeometrySource(data: nor.withUnsafeBufferPointer { Data(buffer: $0) }, semantic: .normal, vectorCount: nor.count, usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: MemoryLayout<simd_float3>.stride)
        let tSrc = SCNGeometrySource(data: uv.withUnsafeBufferPointer { Data(buffer: $0) }, semantic: .texcoord, vectorCount: uv.count, usesFloatComponents: true, componentsPerVector: 2, bytesPerComponent: 4, dataOffset: 0, dataStride: MemoryLayout<simd_float2>.stride)
        let el = SCNGeometryElement(data: idx.withUnsafeBufferPointer { Data(buffer: $0) }, primitiveType: .triangles, primitiveCount: faces.count, bytesPerIndex: 4)
        let g = SCNGeometry(sources: [vSrc, nSrc, tSrc], elements: [el])
        let m = SCNMaterial()
        m.lightingModel = .physicallyBased
        m.diffuse.contents = texture
        m.roughness.contents = 1.0
        m.metalness.contents = 0.0
        m.isDoubleSided = true
        g.materials = [m]
        return g
    }
}

/// THE SCAN ERIK ASKED FOR (10-16, after Polycam). ARKit tracks the walk and draws the LiDAR mesh
/// BLUE; the phone keeps a frame of the camera feed every ~0.3 m or 10° of turn (and on the
/// button), and every mesh face a frame saw — in front of the lens, within reach, facing it, and
/// not behind something per the depth map — turns CLEAR. What is still blue is what the scan still
/// needs. Finish paints the final mesh from the frames it kept (Painter) and writes the USDZ; the
/// file goes to the page in pieces (readChunk).
@available(iOS 17.0, *)
final class Scan3DViewController: ScanViewController, ARSessionDelegate {
    /// The painter wants a real walk: Finish opens at this many frames.
    static let minFrames = 10
    /// The most frames one scan keeps (~300 KB each on disk): 300 m of walking at 0.3 m a frame.
    /// Erik 2026-10-16: "more coverage area wins over fine detail on this one"; "if a contractor is
    /// stopped dead at 99 frames we'll probably have issues".
    static let maxFrames = 1000
    /// A new frame after this much walking, or this much turning, with at least this gap between two.
    static let moveStep: Float = 0.3
    static let turnStep: Float = 10 * .pi / 180
    static let frameGap: TimeInterval = 0.25
    /// The grid the coverage is kept on (meters); how far a frame reaches is `Painter.reach`.
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
    /// The frames' pictures and depth maps.
    private let imagesDir: URL
    private let outputURL: URL

    private var trackingNormal = false
    private var meshSeen = false
    /// When the camera last sent a picture, and whether its silence has been said (the walk can't go
    /// on without pictures; a stall must never be silent — the counter stopped at 99 on 2026-10-16).
    private var lastFrameSeen = CACurrentMediaTime()
    private var stalled = false
    private var stallTimer: Timer?
    private var keyframes: [Keyframe] = []
    /// Frame ids only ever go up (a failed write takes its frame out, never an id back).
    private var nextId = 0
    private var lastAt: TimeInterval = 0
    private var lastTransform: simd_float4x4?
    /// Frames still being written to disk; Finish waits for zero.
    private var pendingWrites = 0
    private var finishWaiting = false
    private var processing = false
    private let paintCancelled = Flag()

    /// The mesh as ARKit holds it (main thread), our copy of each anchor (refreshed for the anchors
    /// that changed, at most four times a second) and the node drawing each anchor's uncovered faces.
    private var meshes: [UUID: ARMeshAnchor] = [:]
    private var snaps: [UUID: MeshSnap] = [:]
    private var nodes: [UUID: SCNNode] = [:]
    private var dirty = Set<UUID>()
    private var flushScheduled = false
    /// The coverage work: the voxels a frame saw, read and written on this queue only.
    private let work = DispatchQueue(label: "north.scan3d.coverage", qos: .userInitiated)
    private var covered = Set<Int64>()
    private let encode = DispatchQueue(label: "north.scan3d.encode", qos: .userInitiated)
    private let paintQueue = DispatchQueue(label: "north.scan3d.paint", qos: .userInitiated)
    private let haptic = UIImpactFeedbackGenerator(style: .light)

    override init(done: @escaping (ScanOutcome) -> Void) {
        let stamp = UUID().uuidString
        let base = ScanPlugin.scanFolder
        folder = base.appendingPathComponent("capture-\(stamp)", isDirectory: true)
        imagesDir = folder.appendingPathComponent("frames", isDirectory: true)
        outputURL = base.appendingPathComponent("model-\(stamp).usdz")
        super.init(done: done)
    }

    // MARK: Screen

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        do {
            try FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true)
        } catch {
            // Said once the screen is up (ScanViewController.finish holds it until then).
            finish(.failed("Couldn't make room for the scan on this phone (\(error.localizedDescription)). Free some space and try again."))
            return
        }
        // A walk and a paint take minutes: the phone must not lock in the middle of them.
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
        shutter.accessibilityLabel = "Keep This View"
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
        buildTitle.text = "Painting the model…"
        buildTitle.font = .systemFont(ofSize: 22, weight: .bold)
        buildTitle.textColor = .white
        buildTitle.textAlignment = .center
        buildLabel.font = .systemFont(ofSize: 15, weight: .medium)
        buildLabel.textColor = UIColor.white.withAlphaComponent(0.8)
        buildLabel.textAlignment = .center
        buildLabel.numberOfLines = 2
        buildLabel.text = "0% — a minute or two on the phone; keep the app open"
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
        refreshCounter()
        say("Finding the surfaces — move the phone slowly")
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        guard pendingOutcome == nil else { return }
        haptic.prepare()
        run()
    }

    /// Once a second: two seconds without a picture from the camera is said, on the screen and in the log.
    private func watchForStall() {
        stallTimer?.invalidate()
        lastFrameSeen = CACurrentMediaTime()
        stallTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self, !self.finished, !self.processing, !self.finishWaiting, self.trackingNormal, self.meshSeen, !self.stalled else { return }
            let quiet = CACurrentMediaTime() - self.lastFrameSeen
            guard quiet > 2 else { return }
            self.stalled = true
            NSLog("[Scan3D] no camera frame for %.1f s at %d frames", quiet, self.keyframes.count)
            self.say("The camera stopped sending pictures — hold on; if it stays stopped, Cancel and scan again")
        }
    }

    /// World tracking with the LiDAR mesh and the depth map, from a fresh origin.
    private func run() {
        let config = ARWorldTrackingConfiguration()
        config.sceneReconstruction = .mesh
        config.environmentTexturing = .none
        config.worldAlignment = .gravity
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) { config.frameSemantics.insert(.smoothedSceneDepth) }
        else if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) { config.frameSemantics.insert(.sceneDepth) }
        sceneView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        watchForStall()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stallTimer?.invalidate()
        stallTimer = nil
        sceneView.session.pause()
    }

    override func finish(_ outcome: ScanOutcome) {
        UIApplication.shared.isIdleTimerDisabled = false
        super.finish(outcome)
    }

    private func say(_ s: String) {
        hint.text = "  \(s)  "
    }

    private func refreshCounter() {
        let n = keyframes.count
        counter.text = "  \(n) frame\(n == 1 ? "" : "s")  "
        finishButton.isEnabled = n >= Self.minFrames && !processing && !finishWaiting
    }

    private var walkHint: String {
        let n = keyframes.count
        if n >= Self.maxFrames { return "That's the most frames for one scan (\(Self.maxFrames)) — Finish." }
        if n >= Self.maxFrames - 100 {
            let left = Self.maxFrames - n
            return "Keep going until the blue is gone, then Finish — \(left) frame\(left == 1 ? "" : "s") left."
        }
        if n >= Self.minFrames { return "Keep going until the blue is gone, then Finish." }
        return "Walk slowly and point at every surface. Blue is what the scan still needs; it clears as the camera sees it."
    }

    // MARK: Buttons

    @objc private func shutterTapped() {
        guard !processing, !finishWaiting, keyframes.count < Self.maxFrames else { return }
        guard let frame = sceneView.session.currentFrame else { return }
        guard trackingNormal else {
            say("Hold on — the camera is still finding its place")
            return
        }
        keep(frame)
    }

    @objc private func finishTapped() {
        guard !finished, !processing, !finishWaiting, keyframes.count >= Self.minFrames else { return }
        finishWaiting = true
        finishButton.isEnabled = false
        shutter.isEnabled = false
        say("Finishing the walk…")
        startPaintWhenWritten()
    }

    /// Cancel with frames kept, or mid-paint, asks first: one tap must not throw away minutes of walking.
    @objc private func cancelTapped() {
        guard !finished else { return }
        if keyframes.isEmpty && !processing {
            dropScan()
            return
        }
        let n = keyframes.count
        let alert = UIAlertController(title: processing ? "Drop This Model?" : "Drop This Scan?", message: processing ? "The model is still being painted. Dropping it throws the walk away." : "\(n) frame\(n == 1 ? "" : "s") so far would be thrown away.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Keep Going", style: .cancel))
        alert.addAction(UIAlertAction(title: "Drop It", style: .destructive) { [weak self] _ in self?.dropScan() })
        (presentedViewController ?? self).present(alert, animated: true)
    }

    private func dropScan() {
        guard !finished else { return }
        paintCancelled.set()
        cleanup(keepModel: false)
        finish(.cancelled)
    }

    // MARK: The frames

    /// Every frame: a new keyframe once the walk has moved or turned enough since the last one.
    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        lastFrameSeen = CACurrentMediaTime()
        if stalled {
            stalled = false
            if trackingNormal, meshSeen, !processing, !finishWaiting, !finished { say(walkHint) }
        }
        guard trackingNormal, meshSeen, !processing, !finishWaiting, !finished, keyframes.count < Self.maxFrames else { return }
        guard frame.timestamp - lastAt >= Self.frameGap else { return }
        // A frame with no depth map cannot say what is behind what: not kept by itself.
        guard (frame.smoothedSceneDepth ?? frame.sceneDepth) != nil else { return }
        let t = frame.camera.transform
        if let last = lastTransform {
            let moved = simd_distance(Self.position(t), Self.position(last))
            let turned = Self.angle(Self.forward(t), Self.forward(last))
            guard moved >= Self.moveStep || turned >= Self.turnStep else { return }
        }
        keep(frame)
    }

    static func position(_ t: simd_float4x4) -> simd_float3 { simd_float3(t.columns.3.x, t.columns.3.y, t.columns.3.z) }
    static func forward(_ t: simd_float4x4) -> simd_float3 { -simd_float3(t.columns.2.x, t.columns.2.y, t.columns.2.z) }
    static func angle(_ a: simd_float3, _ b: simd_float3) -> Float { acos(max(-1, min(1, simd_dot(simd_normalize(a), simd_normalize(b))))) }

    /// A frame is kept: counted, felt, written off the main thread; the faces it saw go clear.
    private func keep(_ frame: ARFrame) {
        // ARKit lends the camera's pictures from a small pool and the camera stops when none comes back:
        // the picture is copied out here, before anything slow, never held while its JPEG is made.
        guard let image = Self.clone(frame.capturedImage) else {
            say("A frame couldn't be kept — the phone is low on memory.")
            return
        }
        lastAt = frame.timestamp
        lastTransform = frame.camera.transform
        nextId += 1
        let id = nextId
        let cam = frame.camera
        let depthMap = (frame.smoothedSceneDepth ?? frame.sceneDepth)?.depthMap
        let depth = depthMap.flatMap(Self.floats(of:))
        let imageName = String(format: "frame-%04d.jpg", id)
        let depthName = depth == nil ? nil : String(format: "frame-%04d.depth", id)
        let kf = Keyframe(id: id, transform: cam.transform, intrinsics: cam.intrinsics, width: Float(cam.imageResolution.width), height: Float(cam.imageResolution.height), depthWidth: depth?.width ?? 0, depthHeight: depth?.height ?? 0, image: imageName, depth: depthName)
        keyframes.append(kf)
        refreshCounter()
        haptic.impactOccurred()
        say(walkHint)

        let seen = ShotView(transform: cam.transform, intrinsics: cam.intrinsics, width: kf.width, height: kf.height, depth: depth?.floats ?? [], depthWidth: kf.depthWidth, depthHeight: kf.depthHeight)
        let snaps = Array(self.snaps.values)
        work.async { [weak self] in
            guard let self else { return }
            let changed = self.mark(seen, over: snaps)
            guard !changed.isEmpty else { return }
            DispatchQueue.main.async { self.redraw(changed) }
        }

        pendingWrites += 1
        let dir = imagesDir
        encode.async { [weak self] in
            var saved = false
            if let jpeg = Self.jpeg(of: image), (try? jpeg.write(to: dir.appendingPathComponent(imageName))) != nil {
                saved = true
                if let depth, let depthName { try? depth.data.write(to: dir.appendingPathComponent(depthName)) }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.pendingWrites -= 1
                if !saved {
                    self.keyframes.removeAll { $0.id == id }
                    if !self.finished {
                        self.refreshCounter()
                        self.say("A frame couldn't be saved. Free some space on the phone.")
                    }
                }
                if self.finishWaiting { self.startPaintWhenWritten() }
            }
        }
    }

    static let jpegContext = CIContext(options: [.useSoftwareRenderer: false])

    /// A copy of a camera picture in our own memory (row by row: the pool's rows may be padded),
    /// with the picture's colour tags (the YCbCr matrix, the primaries) carried over — without them
    /// Core Image would guess, and every painted texel could shift (skeptic #21).
    static func clone(_ src: CVPixelBuffer) -> CVPixelBuffer? {
        var made: CVPixelBuffer?
        let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary
        guard CVPixelBufferCreate(nil, CVPixelBufferGetWidth(src), CVPixelBufferGetHeight(src), CVPixelBufferGetPixelFormatType(src), attributes, &made) == kCVReturnSuccess, let dst = made else { return nil }
        CVBufferPropagateAttachments(src, dst)
        CVPixelBufferLockBaseAddress(src, .readOnly)
        CVPixelBufferLockBaseAddress(dst, [])
        defer {
            CVPixelBufferUnlockBaseAddress(dst, [])
            CVPixelBufferUnlockBaseAddress(src, .readOnly)
        }
        let planes = CVPixelBufferIsPlanar(src) ? CVPixelBufferGetPlaneCount(src) : 1
        for plane in 0..<planes {
            let planar = CVPixelBufferIsPlanar(src)
            guard let s = planar ? CVPixelBufferGetBaseAddressOfPlane(src, plane) : CVPixelBufferGetBaseAddress(src),
                  let d = planar ? CVPixelBufferGetBaseAddressOfPlane(dst, plane) : CVPixelBufferGetBaseAddress(dst) else { return nil }
            let sRow = planar ? CVPixelBufferGetBytesPerRowOfPlane(src, plane) : CVPixelBufferGetBytesPerRow(src)
            let dRow = planar ? CVPixelBufferGetBytesPerRowOfPlane(dst, plane) : CVPixelBufferGetBytesPerRow(dst)
            let rows = planar ? CVPixelBufferGetHeightOfPlane(src, plane) : CVPixelBufferGetHeight(src)
            let n = Swift.min(sRow, dRow)
            for y in 0..<rows { memcpy(d + y * dRow, s + y * sRow, n) }
        }
        return dst
    }

    static func jpeg(of image: CVPixelBuffer) -> Data? {
        let ci = CIImage(cvPixelBuffer: image)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        return jpegContext.jpegRepresentation(of: ci, colorSpace: space, options: [quality: 0.85])
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

    /// A depth map back off the disk; nil when the file is not the size it should be.
    static func depthFloats(at url: URL, count: Int) -> [Float]? {
        guard count > 0, let data = try? Data(contentsOf: url), data.count == count * 4 else { return nil }
        return data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }

    // MARK: Coverage (the `work` queue)

    /// A face a frame saw: its centre is in front of the lens, within reach, inside the picture,
    /// and — where the depth map has a reading there — not behind something nearer; where it has
    /// none, the face must at least face the lens (ARKit's own normals; a zero one is trusted).
    /// Only the anchors within the frame's reach and in front of it are visited (the mesh grows with
    /// the walk; the frame's view does not). It answers with the anchors to redraw: every anchor it
    /// visited when the pass cleared any cell at all (a face's cell may have been cleared by another
    /// anchor's face, now or in an earlier pass), none when it cleared nothing — never the whole
    /// mesh (a 99-frame room drew every anchor 99 times over).
    private func mark(_ v: ShotView, over snaps: [MeshSnap]) -> [UUID] {
        let toCamera = simd_inverse(v.transform)
        let eye = Self.position(v.transform)
        let ahead = Self.forward(v.transform)
        var visited: [UUID] = []
        var cleared = false
        v.depth.withUnsafeBufferPointer { dp in
            let depth: UnsafeBufferPointer<Float>? = v.depthWidth > 0 && dp.count == v.depthWidth * v.depthHeight ? dp : nil
            for snap in snaps {
                let toward = snap.center - eye
                if simd_length(toward) - snap.radius > Painter.reach { continue }
                if simd_dot(toward, ahead) < -snap.radius { continue }
                visited.append(snap.id)
                var i = 0
                while i + 2 < snap.faces.count {
                    let ia = snap.faces[i], ib = snap.faces[i + 1], ic = snap.faces[i + 2]
                    i += 3
                    let a = snap.world(ia), b = snap.world(ib), c = snap.world(ic)
                    var n = snap.worldNormal(ia) + snap.worldNormal(ib) + snap.worldNormal(ic)
                    var len = simd_length(n)
                    if len < 0.1 {
                        n = simd_cross(b - a, c - a)
                        len = simd_length(n)
                    }
                    guard len > 0 else { continue }
                    // The same rule the painter uses — plus a slightly longer reach for the blue.
                    if Painter.score(a, b, c, normal: n / len, toCamera: toCamera, eye: eye, k: v.intrinsics, width: v.width, height: v.height, depth: depth, depthWidth: v.depthWidth, depthHeight: v.depthHeight) > 0 {
                        if covered.insert(Self.key((a + b + c) / 3)).inserted { cleared = true }
                    }
                }
            }
        }
        return cleared ? visited : []
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
        cleanup(keepModel: false)
        finish(.failed("The camera couldn't scan (\(error.localizedDescription)). Try again."))
    }

    /// An interruption (a call, the app put away) can move the world origin: the mesh, the coverage
    /// and the frames kept before it would all sit in the old one, so the scan starts over — the
    /// session reset, the mesh and the frames dropped (skeptic #20).
    func sessionWasInterrupted(_ session: ARSession) {
        trackingNormal = false
        lastTransform = nil
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        guard !processing, !finished else { return }
        work.async { [weak self] in self?.covered.removeAll() }
        for node in nodes.values { node.removeFromParentNode() }
        nodes.removeAll()
        meshes.removeAll()
        snaps.removeAll()
        dirty.removeAll()
        meshSeen = false
        keyframes.removeAll()
        finishWaiting = false
        shutter.isEnabled = true
        let dir = imagesDir
        encode.async {
            try? FileManager.default.removeItem(at: dir)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        refreshCounter()
        run()
        say("Scanning was interrupted — the scan starts over")
    }

    func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { false }

    // MARK: The model

    private func startPaintWhenWritten() {
        guard finishWaiting, !processing, !finished, pendingWrites == 0 else { return }
        paintModel()
    }

    private func setProgress(_ fraction: Double) {
        buildBar.setProgress(Float(fraction), animated: true)
        buildLabel.text = "\(Int(fraction * 100))% — a minute or two on the phone; keep the app open"
    }

    /// The frames are on disk: the camera stops, the mesh goes, and the model is painted from them.
    private func paintModel() {
        guard !finished, !processing else { return }
        guard keyframes.count >= Self.minFrames else {
            finishWaiting = false
            shutter.isEnabled = true
            refreshCounter()
            let n = keyframes.count
            say("Only \(n) frame\(n == 1 ? " was" : "s were") saved — keep walking to at least \(Self.minFrames), then Finish.")
            return
        }
        processing = true
        sceneView.session.pause()
        for node in nodes.values { node.removeFromParentNode() }
        nodes.removeAll()
        sceneView.isHidden = true
        buildBox.isHidden = false
        // The final mesh, copied now, is what gets painted.
        let final = meshes.values.map(MeshSnap.init)
        let frames = keyframes
        let dir = imagesDir
        let output = outputURL
        let cancelled = paintCancelled
        paintQueue.async { [weak self] in
            func fail(_ sentence: String) {
                DispatchQueue.main.async {
                    guard let self, !self.finished else { return }
                    self.cleanup(keepModel: false)
                    self.finish(.failed(sentence))
                }
            }
            func progress(_ f: Double) {
                DispatchQueue.main.async { self?.setProgress(f) }
            }
            // Every face in world space, with its normal, then the whole lot set down on the floor.
            var faces: [Painter.Face] = []
            for snap in final {
                var i = 0
                while i + 2 < snap.faces.count {
                    let ia = snap.faces[i], ib = snap.faces[i + 1], ic = snap.faces[i + 2]
                    i += 3
                    let a = snap.world(ia)
                    var b = snap.world(ib), c = snap.world(ic)
                    var n = snap.worldNormal(ia) + snap.worldNormal(ib) + snap.worldNormal(ic)
                    var len = simd_length(n)
                    if len < 0.1 {
                        n = simd_cross(b - a, c - a)
                        len = simd_length(n)
                    }
                    guard len > 0, simd_length(a).isFinite, simd_length(b).isFinite, simd_length(c).isFinite else { continue }
                    // The winding follows the normal (into the open), so a viewer that draws one
                    // side sees the surfaces from inside the room.
                    if simd_dot(simd_cross(b - a, c - a), n) < 0 { swap(&b, &c) }
                    faces.append(Painter.Face(a: a, b: b, c: c, normal: n / len))
                }
            }
            guard !faces.isEmpty else {
                fail("The scan has no surfaces to paint. Walk the room again, slowly.")
                return
            }
            guard faces.count <= Painter.maxFaces else {
                fail("This scan is too big to paint on this phone. Scan a smaller area.")
                return
            }
            // The floor: the lowest percent of the vertices, not one stray point through a window.
            var lo = faces[0].a, hi = faces[0].a
            var ys: [Float] = []
            ys.reserveCapacity(min(faces.count, 60_000))
            let step = max(1, faces.count / 20_000)
            for (i, f) in faces.enumerated() {
                lo = simd_min(lo, simd_min(f.a, simd_min(f.b, f.c)))
                hi = simd_max(hi, simd_max(f.a, simd_max(f.b, f.c)))
                if i % step == 0 { ys.append(f.a.y); ys.append(f.b.y); ys.append(f.c.y) }
            }
            ys.sort()
            let floor = ys.isEmpty ? lo.y : ys[min(ys.count - 1, ys.count / 100)]
            let shift = simd_float3((lo.x + hi.x) / 2, floor, (lo.z + hi.z) / 2)
            let kept = frames.map { kf -> Keyframe in
                var t = kf.transform
                t.columns.3 = simd_float4(t.columns.3.x - shift.x, t.columns.3.y - shift.y, t.columns.3.z - shift.z, 1)
                return Keyframe(id: kf.id, transform: t, intrinsics: kf.intrinsics, width: kf.width, height: kf.height, depthWidth: kf.depthWidth, depthHeight: kf.depthHeight, image: kf.image, depth: kf.depth)
            }
            faces = faces.map { Painter.Face(a: $0.a - shift, b: $0.b - shift, c: $0.c - shift, normal: $0.normal) }
            let atlas = Painter.atlas(forFaces: faces.count)
            let best = Painter.assign(faces, keyframes: kept, dir: dir, cancelled: cancelled) { progress($0 * 0.45) }
            if cancelled.isSet { return }
            let seen = best.reduce(0) { $0 + ($1 >= 0 ? 1 : 0) }
            guard seen * 20 >= faces.count else {
                fail("The scan saw too little of the surfaces to paint them. Walk closer and slower, then try again.")
                return
            }
            var pixels = Painter.paint(faces, best: best, keyframes: kept, dir: dir, atlas: atlas, cancelled: cancelled) { progress(0.45 + $0 * 0.45) }
            if cancelled.isSet { return }
            // SceneKit's USDZ writer leaves out a texture handed to it as a file ("Failed to resolve
            // reference"; the first painted models carried theirs only through the image fallback):
            // the picture goes in as an image, and the file is read back for it before it counts.
            guard let image = Painter.textureImage(&pixels, size: atlas.size) else {
                fail("The model's picture couldn't be made on this phone. Try again.")
                return
            }
            pixels = []
            progress(0.92)
            let scene = SCNScene()
            scene.rootNode.addChildNode(SCNNode(geometry: Painter.geometry(faces, atlas: atlas, texture: image)))
            let wrote = scene.write(to: output, options: nil, delegate: nil, progressHandler: nil)
            if cancelled.isSet {
                try? FileManager.default.removeItem(at: output)
                return
            }
            let bytes = wrote ? ((try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? NSNumber)?.intValue ?? 0) : 0
            guard bytes > 0 else {
                fail("The model couldn't be written on this phone. Try again.")
                return
            }
            guard Painter.carriesImage(output) else {
                try? FileManager.default.removeItem(at: output)
                fail("The model was written without its picture. Try again.")
                return
            }
            DispatchQueue.main.async {
                guard let self, !self.finished else { return }
                self.cleanup(keepModel: true)
                self.finish(.scanned(["ok": true, "kind": "model", "path": output.path, "bytes": bytes, "mime": "model/vnd.usdz+zip", "shots": frames.count]))
            }
        }
    }

    /// The frames, depth maps and the picture go as soon as the model is written (or the scan is
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
