import ARKit
import AVFoundation
import Capacitor
import SceneKit
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

    static let noLidarSentence = "Scanning needs an iPhone with a LiDAR sensor (12 Pro or newer). Measure or type the measurements instead."
    static let noRoomPlanSentence = "Scan The Room needs iOS 16 or newer. Update the iPhone, or Scan The Site."
    static let couldNotOpen = "The scan couldn't open over this screen. Close what's open and try again."

    /// Resolves { site: Bool, room: Bool, reason: String? } — `reason` is the sentence to show when
    /// neither door exists.
    @objc func isSupported(_ call: CAPPluginCall) {
        var out: [String: Any] = ["site": Self.siteSupported, "room": Self.roomSupported]
        if !Self.siteSupported { out["reason"] = Self.noLidarSentence }
        call.resolve(out)
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
