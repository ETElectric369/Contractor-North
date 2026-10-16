import ARKit
import AVFoundation
import Capacitor
import RealityKit
import SceneKit
import SwiftUI
import UIKit
#if canImport(RoomPlan)
import RoomPlan
#endif

/// SCAN THE SITE / SCAN THE ROOM — LiDAR rung 2 (field feedback 10-13, item 5; Erik 2026-10-16:
/// "go for the scan … not being able to scan outside is what my brother specifically asked for").
///
/// TWO DOORS, ONE PLUGIN.
///   scanSite — OUTDOORS (Chris's decks and driveways). Apple's RoomPlan only knows walls, so a
///     site is scanned the way Measure Area already works: walk the edge, point the circle at each
///     corner and tap +, and ARKit's LiDAR mesh is kept while walking. Done hands back the corners
///     (meters, world space), every side, the area and the perimeter — ALL FROM THE TAPPED CORNERS,
///     never read off the mesh — plus a snapshot and the mesh as a USDZ file (Apple's own 3D
///     format: the phone opens it in AR Quick Look, the office's Mac in Preview).
///   scanRoom — INDOORS (iOS 16+, RoomPlan). Apple's scanning view does the walk; Done hands back
///     the walls (length, height, both ends), the doors, windows and openings, the ceiling height,
///     the floor outline where iOS 17 gives one, and the room as a USDZ.
///   scan3d — THE PICTURE (iOS 17+, Object Capture + on-phone photogrammetry). Erik 2026-10-16,
///     after Polycam: "collect all of the pixels for all surfaces and render an image … i want
///     that." Apple's capture view walks the room or the site (its own Area mode on iOS 18),
///     takes the photos itself, and PhotogrammetrySession builds a TEXTURED model on the phone —
///     every surface wearing its real pixels — as a USDZ. The file can be tens of megabytes, so it
///     stays in the app's temp folder and the page pulls it through readChunk in 2 MB pieces
///     (never one giant string over the bridge), then discards it. No numbers come from this door:
///     the measurements are Measure's and the other two scans'.
///
/// THE PAGE DRAWS THE PLAN. The numbers cross the bridge in meters; the web side turns them into
/// feet, draws the to-scale plan (lib/scan/plan-svg), lands the rows on the task and uploads the
/// files with its own session. No network from here (the agent security framework). A phone that
/// cannot scan rejects with ONE plain sentence the page shows as-is (NOTHING SILENT); Cancel
/// resolves {ok:false, cancelled:true}.
///
/// A LOCAL plugin like MeasurePlugin: ARKit, SceneKit and RoomPlan ship with iOS. The shell has to
/// be REBUILT for it (the Debug build on the cabled phone).
@objc(ScanPlugin)
public class ScanPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScanPlugin"
    public let jsName = "Scan"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanSite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanRoom", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan3d", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discard", returnType: CAPPluginReturnPromise),
    ]

    /// One scan on screen at a time: a second call while one is up is answered, not stacked.
    private var presenting = false

    /// A site scan needs the sensor: the mesh is what makes a corner land where it looks like it lands.
    static var siteSupported: Bool {
        ARWorldTrackingConfiguration.isSupported && ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    }

    /// A room scan is Apple's RoomPlan: iOS 16 and the sensor.
    static var roomSupported: Bool {
        #if canImport(RoomPlan)
        if #available(iOS 16.0, *) { return RoomCaptureSession.isSupported }
        #endif
        return false
    }

    /// A textured model is Object Capture (the guided photos) plus photogrammetry on the phone: iOS 17
    /// and the sensor. Apple's answer lives on the main actor, so the askers hop there.
    @MainActor static var modelSupported: Bool {
        // iOS 18: an AREA capture (a room, a site) starts straight from the ready state — there is no
        // object-detection step and no mode switch in the API (checked against the 18.5 SDK).
        if #available(iOS 18.0, *) { return ObjectCaptureSession.isSupported && PhotogrammetrySession.isSupported }
        return false
    }

    static let noLidarSentence = "Scanning needs an iPhone with a LiDAR sensor (12 Pro or newer). Measure or type the measurements instead."
    static let no3dSentence = "Scan In 3D needs iOS 18 or newer on an iPhone with a LiDAR sensor. Update the iPhone, or Scan The Room."
    static let noRoomPlanSentence = "Scan The Room needs iOS 16 or newer. Update the iPhone, or Scan The Site."
    static let couldNotOpen = "The scan couldn't open over this screen. Close what's open and try again."

    /// Resolves { site: Bool, room: Bool, reason: String? } — `reason` is the sentence to show when
    /// neither door exists.
    @objc func isSupported(_ call: CAPPluginCall) {
        Task { @MainActor in
            var out: [String: Any] = ["site": Self.siteSupported, "room": Self.roomSupported, "model": Self.modelSupported]
            if !Self.siteSupported { out["reason"] = Self.noLidarSentence }
            call.resolve(out)
        }
    }

    @objc func scanSite(_ call: CAPPluginCall) {
        guard Self.siteSupported else {
            call.reject(Self.noLidarSentence)
            return
        }
        present(call) { done in SiteScanViewController(done: done) }
    }

    @objc func scanRoom(_ call: CAPPluginCall) {
        guard Self.roomSupported else {
            call.reject(Self.siteSupported ? Self.noRoomPlanSentence : Self.noLidarSentence)
            return
        }
        #if canImport(RoomPlan)
        if #available(iOS 16.0, *) {
            present(call) { done in RoomScanViewController(done: done) }
            return
        }
        #endif
        call.reject(Self.noRoomPlanSentence)
    }

    @objc func scan3d(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard Self.modelSupported else {
                call.reject(Self.siteSupported ? Self.no3dSentence : Self.noLidarSentence)
                return
            }
            if #available(iOS 18.0, *) {
                Self.sweepOldScans()
                self.present(call) { done in Scan3DViewController(done: done) }
                return
            }
            call.reject(Self.no3dSentence)
        }
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

/// What both scanning screens share: the one-shot outcome, the `finished` latch the plugin's timer
/// reads, portrait, and the button look Measure uses.
class ScanViewController: UIViewController {
    let done: (ScanOutcome) -> Void
    /// Set once the outcome is on its way (or the view never came up); every door checks it.
    var finished = false

    init(done: @escaping (ScanOutcome) -> Void) {
        self.done = done
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    override var prefersStatusBarHidden: Bool { true }

    func finish(_ outcome: ScanOutcome) {
        guard !finished else { return }
        finished = true
        dismiss(animated: true) { [done] in done(outcome) }
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

    /// The USDZ bytes of a scene, written to a temp file and read back; nil when SceneKit refused.
    static func usdz(of scene: SCNScene, name: String) -> Data? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString).usdz")
        defer { try? FileManager.default.removeItem(at: url) }
        guard scene.write(to: url, options: nil, delegate: nil, progressHandler: nil) else { return nil }
        return try? Data(contentsOf: url)
    }

    /// Newell's method over a flat-ish polygon in meters (MeasureViewController.polygonArea on vectors).
    static func area(_ pts: [SCNVector3]) -> Double { MeasureViewController.polygonArea(pts) }
}

// MARK: - SCAN THE SITE (outdoors)

/// Walk the edge of the deck, the driveway, the footprint: point the circle at a corner and tap +.
/// The LiDAR mesh is drawn as it is found (a faint wireframe) so the walker sees what the file will
/// hold, and a corner lands ON the mesh where there is one (a SceneKit hit on the mesh nodes), else
/// on a detected or estimated plane. Points are taken only while tracking is NORMAL; an interruption
/// clears the corners and says so (the world origin may have moved); no relocalising.
final class SiteScanViewController: ScanViewController, ARSCNViewDelegate, ARSessionDelegate {
    /// The most faces the 3D file carries: the mesh nearest the footprint is kept, the rest dropped
    /// and said so. ~3 MB of USDZ, a few seconds over the bridge.
    static let maxFaces = 150_000
    /// SceneKit's category bit for the mesh nodes, so a corner's hit test sees only the mesh.
    static let meshMask = 2

    private let sceneView = ARSCNView()
    private let readout = UILabel()
    private let metric = UILabel()
    private let status = UILabel()
    private let crosshair = UIView()
    private let doneButton = UIButton(type: .system)
    private let undoButton = UIButton(type: .system)
    private let addButton = UIButton(type: .system)

    private var corners: [SCNVector3] = []
    private var cornerNodes: [SCNNode] = []
    private var lineNodes: [SCNNode] = []
    private var closingLine: SCNNode?
    private var trackingNormal = false
    private var surfaceSeen = false
    /// Done pressed: the corners are frozen while the file builds (an Undo now would resurrect
    /// a corner in the file that the sheet never saw — skeptic #17).
    private var building = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        sceneView.frame = view.bounds
        sceneView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        sceneView.delegate = self
        sceneView.session.delegate = self
        sceneView.automaticallyUpdatesLighting = true
        view.addSubview(sceneView)

        crosshair.translatesAutoresizingMaskIntoConstraints = false
        crosshair.layer.borderColor = UIColor.white.cgColor
        crosshair.layer.borderWidth = 2
        crosshair.layer.cornerRadius = 12
        crosshair.backgroundColor = UIColor.white.withAlphaComponent(0.15)
        crosshair.isUserInteractionEnabled = false
        view.addSubview(crosshair)

        for label in [readout, metric, status] {
            label.translatesAutoresizingMaskIntoConstraints = false
            label.textAlignment = .center
            label.textColor = .white
            label.numberOfLines = 2
            view.addSubview(label)
        }
        readout.font = .monospacedDigitSystemFont(ofSize: 30, weight: .bold)
        metric.font = .monospacedDigitSystemFont(ofSize: 15, weight: .medium)
        metric.textColor = UIColor.white.withAlphaComponent(0.8)
        status.font = .systemFont(ofSize: 15, weight: .medium)
        status.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        status.layer.cornerRadius = 10
        status.layer.masksToBounds = true

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        Self.style(cancel, filled: false)
        undoButton.setTitle("Undo", for: .normal)
        undoButton.addTarget(self, action: #selector(undoTapped), for: .touchUpInside)
        Self.style(undoButton, filled: false)
        doneButton.setTitle("Done", for: .normal)
        doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        Self.style(doneButton, filled: true)
        addButton.setTitle("+", for: .normal)
        addButton.titleLabel?.font = .systemFont(ofSize: 34, weight: .semibold)
        addButton.addTarget(self, action: #selector(addCorner), for: .touchUpInside)
        addButton.backgroundColor = .white
        addButton.setTitleColor(.black, for: .normal)
        addButton.layer.cornerRadius = 36
        addButton.accessibilityLabel = "Add Corner"
        for b in [cancel, undoButton, doneButton, addButton] {
            b.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(b)
        }

        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            crosshair.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            crosshair.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            crosshair.widthAnchor.constraint(equalToConstant: 24),
            crosshair.heightAnchor.constraint(equalToConstant: 24),

            cancel.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            cancel.topAnchor.constraint(equalTo: g.topAnchor, constant: 12),
            cancel.heightAnchor.constraint(equalToConstant: 44),

            readout.topAnchor.constraint(equalTo: cancel.bottomAnchor, constant: 12),
            readout.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            readout.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            metric.topAnchor.constraint(equalTo: readout.bottomAnchor, constant: 2),
            metric.leadingAnchor.constraint(equalTo: readout.leadingAnchor),
            metric.trailingAnchor.constraint(equalTo: readout.trailingAnchor),

            status.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            status.bottomAnchor.constraint(equalTo: addButton.topAnchor, constant: -18),
            status.widthAnchor.constraint(lessThanOrEqualTo: g.widthAnchor, constant: -32),
            status.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),

            addButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            addButton.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -24),
            addButton.widthAnchor.constraint(equalToConstant: 72),
            addButton.heightAnchor.constraint(equalToConstant: 72),

            undoButton.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            undoButton.centerYAnchor.constraint(equalTo: addButton.centerYAnchor),
            undoButton.heightAnchor.constraint(equalToConstant: 44),
            doneButton.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            doneButton.centerYAnchor.constraint(equalTo: addButton.centerYAnchor),
            doneButton.heightAnchor.constraint(equalToConstant: 44),
        ])
        refresh()
        say("Finding the ground — move the phone slowly")
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal, .vertical]
        config.sceneReconstruction = .mesh
        config.environmentTexturing = .none
        sceneView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sceneView.session.pause()
    }

    // MARK: The mesh, drawn as it is found

    func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
        guard let mesh = anchor as? ARMeshAnchor else { return nil }
        let node = SCNNode(geometry: Self.wireframe(Self.geometry(of: mesh.geometry)))
        node.categoryBitMask = Self.meshMask
        return node
    }

    func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
        guard let mesh = anchor as? ARMeshAnchor else { return }
        node.geometry = Self.wireframe(Self.geometry(of: mesh.geometry))
    }

    static func wireframe(_ g: SCNGeometry) -> SCNGeometry {
        let m = SCNMaterial()
        m.fillMode = .lines
        m.diffuse.contents = UIColor.white.withAlphaComponent(0.35)
        m.lightingModel = .constant
        m.isDoubleSided = true
        g.materials = [m]
        return g
    }

    /// ARKit's mesh → SceneKit geometry, with the vertex, normal and face bytes COPIED out of the
    /// Metal buffers: SceneKit's USDZ writer reads data it owns, not a buffer ARKit recycles.
    static func geometry(of mesh: ARMeshGeometry) -> SCNGeometry {
        let v = mesh.vertices
        let vData = Data(bytes: v.buffer.contents().advanced(by: v.offset), count: v.stride * v.count)
        let vSrc = SCNGeometrySource(data: vData, semantic: .vertex, vectorCount: v.count, usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: MemoryLayout<Float>.size, dataOffset: 0, dataStride: v.stride)
        let n = mesh.normals
        let nData = Data(bytes: n.buffer.contents().advanced(by: n.offset), count: n.stride * n.count)
        let nSrc = SCNGeometrySource(data: nData, semantic: .normal, vectorCount: n.count, usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: MemoryLayout<Float>.size, dataOffset: 0, dataStride: n.stride)
        let f = mesh.faces
        let fData = Data(bytes: f.buffer.contents(), count: f.count * f.indexCountPerPrimitive * f.bytesPerIndex)
        let el = SCNGeometryElement(data: fData, primitiveType: .triangles, primitiveCount: f.count, bytesPerIndex: f.bytesPerIndex)
        return SCNGeometry(sources: [vSrc, nSrc], elements: [el])
    }

    // MARK: Corners

    /// Where the circle rests: on the mesh where there is one (exact, the sensor's surface), else a
    /// detected plane, else an estimated one. Nil when nothing is there yet.
    private func hit() -> SCNVector3? {
        let center = CGPoint(x: sceneView.bounds.midX, y: sceneView.bounds.midY)
        if let on = sceneView.hitTest(center, options: [.categoryBitMask: Self.meshMask, .searchMode: SCNHitTestSearchMode.closest.rawValue]).first {
            return on.worldCoordinates
        }
        var queries: [ARRaycastQuery] = []
        if let q = sceneView.raycastQuery(from: center, allowing: .existingPlaneGeometry, alignment: .any) { queries.append(q) }
        if let q = sceneView.raycastQuery(from: center, allowing: .estimatedPlane, alignment: .any) { queries.append(q) }
        for q in queries {
            if let r = sceneView.session.raycast(q).first {
                let t = r.worldTransform.columns.3
                return SCNVector3(t.x, t.y, t.z)
            }
        }
        return nil
    }

    @objc private func addCorner() {
        guard !finished, !building else { return }
        guard trackingNormal else {
            say("Hold on — the camera is still finding its place")
            return
        }
        guard let p = hit() else {
            say("Point the circle at the ground or an edge and try again")
            return
        }
        surfaceSeen = true
        corners.append(p)
        let node = SCNNode(geometry: SCNSphere(radius: 0.01))
        node.geometry?.firstMaterial?.diffuse.contents = UIColor.white
        node.geometry?.firstMaterial?.emission.contents = UIColor.white
        node.position = p
        sceneView.scene.rootNode.addChildNode(node)
        cornerNodes.append(node)
        if corners.count >= 2 {
            let line = MeasureViewController.lineNode(from: corners[corners.count - 2], to: p)
            sceneView.scene.rootNode.addChildNode(line)
            lineNodes.append(line)
        }
        refresh()
    }

    @objc private func undoTapped() {
        guard !finished, !building, !corners.isEmpty else { return }
        corners.removeLast()
        cornerNodes.popLast()?.removeFromParentNode()
        lineNodes.popLast()?.removeFromParentNode()
        refresh()
    }

    @objc private func cancelTapped() {
        finish(.cancelled)
    }

    private func clearCorners() {
        corners.removeAll()
        cornerNodes.forEach { $0.removeFromParentNode() }
        cornerNodes.removeAll()
        lineNodes.forEach { $0.removeFromParentNode() }
        lineNodes.removeAll()
        refresh()
    }

    // MARK: The figure

    private var sides: [Double] {
        guard corners.count >= 2 else { return [] }
        var out: [Double] = []
        for i in 1..<corners.count { out.append(MeasureViewController.distance(corners[i - 1], corners[i])) }
        if corners.count >= 3 { out.append(MeasureViewController.distance(corners[corners.count - 1], corners[0])) }
        return out
    }

    /// A footprint is three or more corners that enclose something (half a square centimetre is the floor).
    private var footprint: (area: Double, perimeter: Double)? {
        guard corners.count >= 3 else { return nil }
        let a = Self.area(corners)
        guard a >= 0.0005 else { return nil }
        return (a, sides.reduce(0, +))
    }

    private func refresh() {
        let fp = footprint
        doneButton.isEnabled = fp != nil && !building
        undoButton.isEnabled = !corners.isEmpty && !building
        closingLine?.removeFromParentNode()
        closingLine = nil
        if corners.count >= 3, let first = corners.first, let last = corners.last {
            let line = MeasureViewController.lineNode(from: last, to: first)
            sceneView.scene.rootNode.addChildNode(line)
            closingLine = line
        }
        if let fp {
            readout.text = MeasureViewController.squareFeetText(fp.area)
            metric.text = "\(corners.count) corners · \(MeasureViewController.feetInchesText(fp.perimeter)) around"
            say("Add the next corner, or Done")
        } else {
            readout.text = "Site"
            metric.text = corners.isEmpty ? "Walk the edge: add each corner, 3 or more" : "\(corners.count) of 3 corners"
            if surfaceSeen { say(corners.isEmpty ? "Point the circle at the first corner and tap +" : "Point the circle at the next corner and tap +") }
        }
    }

    private func say(_ text: String) {
        status.text = "  \(text)  "
    }

    // MARK: Done — the corners, the picture, the mesh

    @objc private func doneTapped() {
        guard !finished, !building, let fp = footprint else { return }
        building = true
        doneButton.isEnabled = false
        undoButton.isEnabled = false
        addButton.isEnabled = false
        say("Building the 3D file…")
        let photo = MeasureViewController.downscaled(sceneView.snapshot(), maxSide: 1600).jpegData(compressionQuality: 0.6)
        let anchors = (sceneView.session.currentFrame?.anchors ?? []).compactMap { $0 as? ARMeshAnchor }
        let corners = self.corners
        let sides = self.sides
        sceneView.session.pause()
        // The mesh is built off the main thread (a walk's worth of anchors takes a second or two).
        let picked = Self.nearest(anchors, to: corners, maxFaces: Self.maxFaces)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let model = Self.usdz(of: picked.anchors)
            DispatchQueue.main.async {
                guard let self, !self.finished else { return }
                var out: [String: Any] = [
                    "ok": true,
                    "kind": "site",
                    "corners": corners.map { [Double($0.x), Double($0.y), Double($0.z)] },
                    "sides": sides,
                    "squareMeters": fp.area,
                    "perimeterMeters": fp.perimeter,
                    "lidar": true,
                    "meshFaces": picked.faces,
                ]
                if let photo {
                    out["photo"] = photo.base64EncodedString()
                    out["photoMime"] = "image/jpeg"
                }
                if let model {
                    out["model"] = model.base64EncodedString()
                    out["modelMime"] = "model/vnd.usdz+zip"
                    if picked.dropped > 0 { out["modelNote"] = "The 3D file holds the \(picked.anchors.count) pieces of mesh nearest the footprint; \(picked.dropped) farther away were left out." }
                } else {
                    out["modelNote"] = picked.anchors.isEmpty ? "No mesh was scanned yet, so there is no 3D file — walk closer to the ground next time." : "The 3D file didn't come out of this scan; the plan and the measurements did."
                }
                self.finish(.scanned(out))
            }
        }
    }

    /// The anchors nearest the footprint's centre, up to `maxFaces` faces in all.
    static func nearest(_ anchors: [ARMeshAnchor], to corners: [SCNVector3], maxFaces: Int) -> (anchors: [ARMeshAnchor], faces: Int, dropped: Int) {
        guard !corners.isEmpty else { return ([], 0, anchors.count) }
        let n = Float(corners.count)
        let cx = corners.map(\.x).reduce(0, +) / n, cy = corners.map(\.y).reduce(0, +) / n, cz = corners.map(\.z).reduce(0, +) / n
        let sorted = anchors.sorted { a, b in
            let pa = a.transform.columns.3, pb = b.transform.columns.3
            let da = (pa.x - cx) * (pa.x - cx) + (pa.y - cy) * (pa.y - cy) + (pa.z - cz) * (pa.z - cz)
            let db = (pb.x - cx) * (pb.x - cx) + (pb.y - cy) * (pb.y - cy) + (pb.z - cz) * (pb.z - cz)
            return da < db
        }
        var out: [ARMeshAnchor] = []
        var faces = 0
        for a in sorted {
            let f = a.geometry.faces.count
            if faces + f > maxFaces { break }
            faces += f
            out.append(a)
        }
        return (out, faces, anchors.count - out.count)
    }

    /// The scanned mesh as one scene, each anchor's geometry at its world transform, a plain grey
    /// lit material so Quick Look shows shape, not darkness.
    static func usdz(of anchors: [ARMeshAnchor]) -> Data? {
        guard !anchors.isEmpty else { return nil }
        let scene = SCNScene()
        for a in anchors {
            let g = geometry(of: a.geometry)
            let m = SCNMaterial()
            m.diffuse.contents = UIColor(white: 0.82, alpha: 1)
            m.isDoubleSided = true
            g.materials = [m]
            let node = SCNNode(geometry: g)
            node.simdTransform = a.transform
            scene.rootNode.addChildNode(node)
        }
        return usdz(of: scene, name: "site")
    }

    // MARK: Session

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        if case .normal = camera.trackingState { trackingNormal = true } else { trackingNormal = false }
        switch camera.trackingState {
        case .notAvailable:
            say("The camera can't track right now")
        case .limited(let reason):
            switch reason {
            case .excessiveMotion: say("Slow down — the camera lost its place")
            case .insufficientFeatures: say("Too dark or too plain here — add light or step back")
            case .initializing: say("Finding the ground — move the phone slowly")
            case .relocalizing: say("Finding its place again — hold still")
            @unknown default: say("Finding the ground — move the phone slowly")
            }
        case .normal:
            if !surfaceSeen { say("Ready — point the circle at the first corner and tap +") }
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        finish(.failed("The camera couldn't scan (\(error.localizedDescription)). Try again, or Measure instead."))
    }

    /// An interruption (a call, the app put away) can move the world origin: corners taken before it
    /// would be in another frame than the ones after. They are cleared, and said so.
    func sessionWasInterrupted(_ session: ARSession) {
        trackingNormal = false
        clearCorners()
        say("Scanning was interrupted — start again")
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        say("Ready — point the circle at the first corner and tap +")
    }

    func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { false }
}

// MARK: - SCAN THE ROOM (indoors, RoomPlan)

#if canImport(RoomPlan)
/// Apple's RoomCaptureView does the walk (its own coaching, its own live model). Done stops the
/// session, RoomPlan processes the room, and the result crosses the bridge as walls, counts and
/// the USDZ. Cancel is a cancel.
@available(iOS 16.0, *)
final class RoomScanViewController: ScanViewController, RoomCaptureViewDelegate, RoomCaptureSessionDelegate {
    private var captureView: RoomCaptureView!
    private let doneButton = UIButton(type: .system)
    private let status = UILabel()
    private var wallsSeen = 0
    private var stopping = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        captureView = RoomCaptureView(frame: view.bounds)
        captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        captureView.delegate = self
        captureView.captureSession.delegate = self
        view.addSubview(captureView)

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        Self.style(cancel, filled: false)
        doneButton.setTitle("Done", for: .normal)
        doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        Self.style(doneButton, filled: true)
        doneButton.isEnabled = false
        status.translatesAutoresizingMaskIntoConstraints = false
        status.textAlignment = .center
        status.textColor = .white
        status.numberOfLines = 2
        status.font = .systemFont(ofSize: 15, weight: .medium)
        status.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        status.layer.cornerRadius = 10
        status.layer.masksToBounds = true
        for b in [cancel, doneButton] {
            b.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(b)
        }
        view.addSubview(status)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            cancel.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            cancel.topAnchor.constraint(equalTo: g.topAnchor, constant: 12),
            cancel.heightAnchor.constraint(equalToConstant: 44),
            doneButton.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            doneButton.topAnchor.constraint(equalTo: g.topAnchor, constant: 12),
            doneButton.heightAnchor.constraint(equalToConstant: 44),
            status.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            status.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -24),
            status.widthAnchor.constraint(lessThanOrEqualTo: g.widthAnchor, constant: -32),
            status.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
        ])
        say("Walk the room slowly, pointing the phone at each wall")
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
    }

    private func say(_ text: String) {
        status.text = "  \(text)  "
    }

    @objc private func cancelTapped() {
        guard !finished else { return }
        captureView.captureSession.stop()
        finish(.cancelled)
    }

    @objc private func doneTapped() {
        guard !finished, !stopping, wallsSeen > 0 else { return }
        stopping = true
        doneButton.isEnabled = false
        say("Building the room…")
        captureView.captureSession.stop()
        // RoomPlan's processing normally takes seconds; if its result never comes, say so instead
        // of a screen stuck on "Building" with only Cancel alive.
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { [weak self] in
            guard let self, !self.finished else { return }
            self.finish(.failed("The room didn't finish processing. Try again."))
        }
    }

    // RoomCaptureSessionDelegate — the live room, so Done opens once a wall exists.
    // Every callback touches UIKit, so each hops to main (the delegate's queue is RoomPlan's to choose).
    func captureSession(_ session: RoomCaptureSession, didUpdate room: CapturedRoom) {
        let walls = room.walls.count
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.wallsSeen = walls
            self.doneButton.isEnabled = walls > 0 && !self.stopping
            if !self.stopping { self.say(walls == 0 ? "Walk the room slowly, pointing the phone at each wall" : "\(walls) wall\(walls == 1 ? "" : "s") so far — keep going, or Done") }
        }
    }

    func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?) {
        guard let error else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.finished, self.stopping else { return }
            self.finish(.failed("The room scan stopped (\(error.localizedDescription)). Try again."))
        }
    }

    // RoomCaptureViewDelegate — RoomPlan processes the room, then hands the result over.
    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        let room = processedResult
        if let error, room.walls.isEmpty {
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.finished else { return }
                self.finish(.failed("The room scan didn't come out (\(error.localizedDescription)). Try again."))
            }
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let model = Self.usdz(of: room)
            DispatchQueue.main.async {
                guard let self, !self.finished else { return }
                var out = Self.payload(of: room)
                if let model {
                    out["model"] = model.base64EncodedString()
                    out["modelMime"] = "model/vnd.usdz+zip"
                } else {
                    out["modelNote"] = "The 3D file didn't come out of this scan; the plan and the measurements did."
                }
                self.finish(.scanned(out))
            }
        }
    }

    /// Walls as two ends on the floor (x, z in meters), with length and height; the counts; the
    /// tallest wall (said as that, never "the ceiling": a gable); every floor's area summed and the
    /// outline when there is one floor, where iOS 17 gives them.
    static func payload(of room: CapturedRoom) -> [String: Any] {
        var walls: [[String: Any]] = []
        var tallest = 0.0
        for w in room.walls {
            let c = w.transform.columns.3
            let x = w.transform.columns.0
            let half = w.dimensions.x / 2
            let a = [Double(c.x - x.x * half), Double(c.z - x.z * half)]
            let b = [Double(c.x + x.x * half), Double(c.z + x.z * half)]
            walls.append(["meters": Double(w.dimensions.x), "height": Double(w.dimensions.y), "a": a, "b": b])
            tallest = max(tallest, Double(w.dimensions.y))
        }
        var out: [String: Any] = [
            "ok": true,
            "kind": "room",
            "walls": walls,
            "doors": room.doors.count,
            "windows": room.windows.count,
            "openings": room.openings.count,
            "tallestWallMeters": tallest,
            "lidar": true,
        ]
        if #available(iOS 17.0, *) {
            let floors = room.floors.filter { $0.polygonCorners.count >= 3 }
            let outlines = floors.map { f in f.polygonCorners.map { f.transform * simd_float4($0.x, $0.y, $0.z, 1) } }
            let total = outlines.reduce(0.0) { $0 + area($1.map { SCNVector3($0.x, $0.y, $0.z) }) }
            if total > 0 { out["floorSquareMeters"] = total }
            if outlines.count == 1, let one = outlines.first { out["floorCorners"] = one.map { [Double($0.x), Double($0.z)] } }
        }
        return out
    }

    static func usdz(of room: CapturedRoom) -> Data? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("room-\(UUID().uuidString).usdz")
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            if #available(iOS 17.0, *) {
                try room.export(to: url, exportOptions: .mesh)
            } else {
                try room.export(to: url)
            }
            return try Data(contentsOf: url)
        } catch {
            return nil
        }
    }
}
#endif

// MARK: - SCAN IN 3D (Object Capture + photogrammetry on the phone)

/// A UIKit shell around Apple's SwiftUI capture view. The view walks the person through the
/// capture (Continue → Start Capture → walk → Finish; Area mode is Apple's own switch on iOS 18);
/// when the session completes, PhotogrammetrySession builds the textured model from the photos in
/// the scan folder, with a progress screen and a Cancel that stops it. The result is a path in the
/// scan folder (never the bytes): the page reads it in pieces.
@available(iOS 18.0, *)
final class Scan3DViewController: ScanViewController {
    private let session = ObjectCaptureSession()
    private var photo: PhotogrammetrySession?
    private var host: UIHostingController<Scan3DScreen>?
    private let progress = Scan3DProgress()
    private let imagesDir: URL
    private let checkpointDir: URL
    private let outputURL: URL
    private var processing = false
    /// A failure found while the screen is still being presented is said once it is up (a dismiss
    /// mid-present is dropped by UIKit, and the promise would hang).
    private var pendingFailure: String?

    override init(done: @escaping (ScanOutcome) -> Void) {
        let stamp = UUID().uuidString
        let folder = ScanPlugin.scanFolder
        imagesDir = folder.appendingPathComponent("capture-\(stamp)/images", isDirectory: true)
        checkpointDir = folder.appendingPathComponent("capture-\(stamp)/checkpoint", isDirectory: true)
        outputURL = folder.appendingPathComponent("model-\(stamp).usdz")
        super.init(done: done)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        do {
            try FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: checkpointDir, withIntermediateDirectories: true)
        } catch {
            pendingFailure = "Couldn't make room for the scan on this phone (\(error.localizedDescription))."
            return
        }
        // A capture and a build take minutes: the phone must not lock in the middle of them.
        UIApplication.shared.isIdleTimerDisabled = true
        var config = ObjectCaptureSession.Configuration()
        config.checkpointDirectory = checkpointDir
        config.isOverCaptureEnabled = false
        session.start(imagesDirectory: imagesDir, configuration: config)
        let screen = Scan3DScreen(session: session, progress: progress, onCancel: { [weak self] in self?.cancelTapped() }, onFinished: { [weak self] in self?.buildModel() })
        let host = UIHostingController(rootView: screen)
        self.host = host
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.view.backgroundColor = .black
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let pendingFailure { finish(.failed(pendingFailure)) }
    }

    override func finish(_ outcome: ScanOutcome) {
        UIApplication.shared.isIdleTimerDisabled = false
        super.finish(outcome)
    }

    /// Cancel with photos taken, or mid-build, asks first: one tap must not throw away minutes of walking.
    private func cancelTapped() {
        guard !finished else { return }
        if session.numberOfShotsTaken == 0 && !processing {
            dropScan()
            return
        }
        let alert = UIAlertController(title: processing ? "Drop This Model?" : "Drop This Scan?", message: processing ? "The model is still building. Dropping it throws the photos away." : "\(session.numberOfShotsTaken) photos so far would be thrown away.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Keep Going", style: .cancel))
        alert.addAction(UIAlertAction(title: "Drop It", style: .destructive) { [weak self] _ in self?.dropScan() })
        (presentedViewController ?? self).present(alert, animated: true)
    }

    private func dropScan() {
        guard !finished else { return }
        if processing { photo?.cancel() } else { session.cancel() }
        cleanup(keepModel: false)
        finish(.cancelled)
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

    /// The capture is complete: the photos are on disk; build the model from them.
    private func buildModel() {
        guard !finished, !processing else { return }
        processing = true
        let shots = session.numberOfShotsTaken
        var config = PhotogrammetrySession.Configuration()
        // A room or a site, not one thing on a table: nothing is cut away as "background".
        config.isObjectMaskingEnabled = false
        config.checkpointDirectory = checkpointDir
        let photo: PhotogrammetrySession
        do {
            photo = try PhotogrammetrySession(input: imagesDir, configuration: config)
        } catch {
            cleanup(keepModel: false)
            finish(.failed("The phone couldn't start building the model (\(error.localizedDescription))."))
            return
        }
        self.photo = photo
        progress.building = true
        let output = outputURL
        Task { [weak self] in
            do {
                try photo.process(requests: [.modelFile(url: output, detail: .reduced)])
                for try await o in photo.outputs {
                    switch o {
                    case .requestProgress(_, let fraction):
                        await MainActor.run { self?.progress.fraction = fraction }
                    case .requestError(_, let error):
                        await MainActor.run {
                            guard let self, !self.finished else { return }
                            self.cleanup(keepModel: false)
                            self.finish(.failed(Self.buildSentence(error)))
                        }
                        return
                    case .processingCancelled:
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
            } catch {
                await MainActor.run {
                    guard let self, !self.finished else { return }
                    self.cleanup(keepModel: false)
                    self.finish(.failed(Self.buildSentence(error)))
                }
            }
        }
    }

    /// The photos and checkpoints go as soon as the model is built (or the scan is dropped); the
    /// model stays for the page to read, and goes on its discard.
    private func cleanup(keepModel: Bool) {
        try? FileManager.default.removeItem(at: imagesDir.deletingLastPathComponent())
        if !keepModel { try? FileManager.default.removeItem(at: outputURL) }
    }
}

/// What the building screen shows: owned by the controller, observed by the SwiftUI view.
@available(iOS 18.0, *)
final class Scan3DProgress: ObservableObject {
    @Published var building = false
    @Published var fraction = 0.0
}

/// Apple's capture view with our bar: Cancel; Start Capture from the ready state (an AREA
/// capture — a room, a site — has no detection step on iOS 18); Finish once ten photos are in;
/// the shot count while walking; and the building screen with its progress once the photos are in.
@available(iOS 18.0, *)
struct Scan3DScreen: View {
    /// Photogrammetry wants a real set of photos: Finish opens at this many.
    static let minShots = 10
    let session: ObjectCaptureSession
    @ObservedObject var progress: Scan3DProgress
    let onCancel: () -> Void
    let onFinished: () -> Void
    @State private var state: ObjectCaptureSession.CaptureState = .initializing
    @State private var shots = 0
    @State private var passDone = false

    var body: some View {
        ZStack {
            if progress.building {
                VStack(spacing: 16) {
                    Text("Building the model…").font(.title2.bold()).foregroundStyle(.white)
                    ProgressView(value: progress.fraction).tint(.white).padding(.horizontal, 40)
                    Text("\(Int(progress.fraction * 100))% — a few minutes on the phone; keep the app open").font(.callout).foregroundStyle(.white.opacity(0.8))
                    Button("Cancel", action: onCancel).buttonStyle(.bordered).tint(.white).padding(.top, 8)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)
            } else {
                // Apple's area-mode guidance: no object reticle frame (there is no bounding-box step);
                // the dot is a brush — Apple paints the surfaces it has captured as it moves over them.
                ObjectCaptureView(session: session)
                    .hideObjectReticle(true)
                    .ignoresSafeArea()
                VStack {
                    HStack {
                        Button("Cancel", action: onCancel).buttonStyle(.borderedProminent).tint(.black.opacity(0.6))
                        Spacer()
                        if case .capturing = state, shots >= Self.minShots {
                            Button("Finish") { session.finish() }.buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black)
                        }
                    }
                    .padding(16)
                    Spacer()
                    VStack(spacing: 10) {
                        Text(hint).font(.callout.weight(.medium)).foregroundStyle(.white).multilineTextAlignment(.center)
                            .padding(.horizontal, 12).padding(.vertical, 8).background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
                        if case .ready = state {
                            Button("Start Capture") { session.startCapturing() }.buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black)
                        }
                    }
                    .padding(.bottom, 28)
                }
            }
        }
        // The update streams carry CHANGES, not the value as it stands: the session is started in
        // viewDidLoad and is often already `.ready` by the time these loops begin (Erik's screen stuck
        // on "Starting the camera…" with Apple's feed live behind it, 10-16). Seed from the current
        // values first, then follow the streams.
        .task {
            apply(session.state)
            for await s in session.stateUpdates { apply(s) }
        }
        .task {
            shots = session.numberOfShotsTaken
            for await n in session.numberOfShotsTakenUpdates { shots = n }
        }
        .task {
            passDone = session.userCompletedScanPass
            for await p in session.userCompletedScanPassUpdates { passDone = p }
        }
    }

    private func apply(_ s: ObjectCaptureSession.CaptureState) {
        state = s
        switch s {
        case .completed: onFinished()
        case .failed(let error): failure = error.localizedDescription
        default: break
        }
    }

    @State private var failure: String? = nil

    private var hint: String {
        if let failure { return "The capture stopped: \(failure). Cancel and try again." }
        switch state {
        case .initializing: return "Starting the camera…"
        case .ready: return "Stand where you can see the room or the site, then Start Capture."
        case .capturing:
            if shots < Self.minShots { return "Move the dot slowly over every surface like a brush — it takes the photos itself (\(shots) so far)." }
            return passDone ? "Pass complete — Finish, or keep brushing for more." : "\(shots) photos. Keep brushing every surface you want in the model, then Finish."
        case .finishing: return "Finishing the capture…"
        case .completed: return "Captured. Building the model…"
        case .failed: return "The capture stopped. Cancel and try again."
        default: return "Frame the area, then Start Capture."
        }
    }
}
