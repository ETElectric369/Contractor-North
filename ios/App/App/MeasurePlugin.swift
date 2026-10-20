import ARKit
import AVFoundation
import Capacitor
import SceneKit
import UIKit

/// MEASURE WITH THE CAMERA — LiDAR rung 1 (field feedback 10-13, item 5; Erik: "in the task itself
/// is where we will be needing photos, measurements, materials and labor and Lidar").
///
/// Apple's Measure app is the model: a crosshair in the middle of the camera view, Add Point drops a
/// point on whatever surface the crosshair rests on, two points are a length, three or more close an
/// area, Done hands the figure back. ARKit does the work: world tracking with plane detection, and —
/// on a phone with the sensor (iPhone 12 Pro and up) — LiDAR scene reconstruction, which is what
/// makes a point on a bare wall or a driveway land where it looks like it lands. A phone without the
/// sensor still measures off detected planes, a little less surely; the web side says which it got.
///
/// THE RESULT IS A NUMBER AND A PICTURE, NEVER A GUESS. `measure` resolves {ok, mode, meters |
/// squareMeters, points, photo} — the page converts to feet and lands it as a measurement row on the
/// task, with the snapshot placed beside it so the office can see what was measured. Cancel resolves
/// {ok:false, cancelled:true}; a phone that cannot measure rejects with ONE plain sentence naming the
/// reason, which the page shows as-is (NOTHING SILENT). No network from here (the agent security
/// framework): the bytes go to the page, which uploads them with its own session.
///
/// A LOCAL plugin, like ScreenTurn and NortAudio: all it needs is ARKit + SceneKit, which ship with
/// iOS. The shell has to be REBUILT for it (the Debug build on the cabled phone).
@objc(MeasurePlugin)
public class MeasurePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MeasurePlugin"
    public let jsName = "Measure"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "measure", returnType: CAPPluginReturnPromise),
    ]

    /// One measurement on screen at a time: a second call while one is up is answered, not stacked.
    private var presenting = false

    /// Resolves { supported: Bool, lidar: Bool, reason: String? }. `lidar` is Apple's own answer
    /// (scene reconstruction with a mesh needs the sensor); `reason` is the sentence to show when
    /// `supported` is false.
    @objc func isSupported(_ call: CAPPluginCall) {
        let supported = ARWorldTrackingConfiguration.isSupported
        let lidar = supported && ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        var result: [String: Any] = ["supported": supported, "lidar": lidar]
        if !supported { result["reason"] = Self.unsupportedSentence }
        call.resolve(result)
    }

    static let unsupportedSentence = "This iPhone can't measure with its camera — Measure needs an iPhone that supports ARKit (an iPhone with a LiDAR sensor, 12 Pro or newer, measures best). Type the measurement instead."

    /// Opens the measuring view. `mode` is "length" (the default) or "area".
    @objc func measure(_ call: CAPPluginCall) {
        let mode = (call.getString("mode") ?? "length") == "area" ? MeasureMode.area : MeasureMode.length
        guard ARWorldTrackingConfiguration.isSupported else {
            call.reject(Self.unsupportedSentence)
            return
        }
        // The camera permission is asked here, in the tap that opened Measure (the iOS rule: the
        // first ask rides a gesture), with the words from Info.plist's NSCameraUsageDescription.
        AVCaptureDevice.requestAccess(for: .video) { granted in
            guard granted else {
                call.reject("North needs the camera to measure. Allow the camera for North in Settings → Apps → North, then try again.")
                return
            }
            Task { @MainActor in
                guard !self.presenting else {
                    call.reject("A measurement is already open. Finish or cancel it first.")
                    return
                }
                guard var top = self.bridge?.viewController else {
                    call.reject("The app's screen isn't ready yet. Close and reopen the app, then try again.")
                    return
                }
                while let presented = top.presentedViewController { top = presented }
                // A screen mid-way in or out (the photo picker just closing) cannot present: UIKit
                // drops the request without an error, and the promise would hang forever.
                guard !top.isBeingDismissed, !top.isBeingPresented else {
                    call.reject("Measure couldn't open over this screen. Close what's open and try again.")
                    return
                }
                self.presenting = true
                let vc = MeasureViewController(mode: mode) { [weak self] outcome in
                    self?.presenting = false
                    switch outcome {
                    case .cancelled:
                        call.resolve(["ok": false, "cancelled": true])
                    case .failed(let sentence):
                        call.reject(sentence)
                    case .measured(let r):
                        var out: [String: Any] = ["ok": true, "mode": r.mode == .area ? "area" : "length", "points": r.points, "lidar": r.lidar]
                        if r.mode == .area { out["squareMeters"] = r.value } else { out["meters"] = r.value }
                        if let photo = r.photo {
                            out["photo"] = photo.base64EncodedString()
                            out["photoMime"] = "image/jpeg"
                        }
                        call.resolve(out)
                    }
                }
                vc.modalPresentationStyle = .fullScreen
                top.present(vc, animated: true)
                // If it never came up (a presentation UIKit refused), say so instead of hanging.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self, weak vc] in
                    guard let self, let vc, !vc.finished, vc.presentingViewController == nil else { return }
                    self.presenting = false
                    vc.finished = true
                    call.reject("Measure couldn't open over this screen. Close what's open and try again.")
                }
            }
        }
    }
}

enum MeasureMode { case length, area }

struct MeasureReading {
    let mode: MeasureMode
    /// Meters for a length (the polyline's total), square meters for an area.
    let value: Double
    let points: Int
    let lidar: Bool
    let photo: Data?
}

enum MeasureOutcome {
    case measured(MeasureReading)
    case cancelled
    case failed(String)
}

/// THE MEASURING VIEW. Portrait, full screen, over the web view. The crosshair is the cursor; the
/// big button (or a tap anywhere on the camera view) drops a point where it rests; Undo takes the
/// last one back; Done hands the reading over. The running figure is drawn at the top in feet and
/// inches (Erik's units) with the metric figure under it, and a status line says what the camera
/// is doing when it cannot place a point ("Finding surfaces — move the phone slowly"), because a
/// tap that lands nowhere must never be silent.
final class MeasureViewController: UIViewController, ARSCNViewDelegate, ARSessionDelegate {
    private let mode: MeasureMode
    private let done: (MeasureOutcome) -> Void
    /// Set once the outcome is on its way (or the view never came up); every door checks it.
    var finished = false
    /// The screen is up (viewDidAppear). An outcome before that waits in `pendingOutcome`: UIKit drops
    /// a dismiss asked of a screen still animating in, the completion never runs, and the page's
    /// promise would hang on a frozen camera with dead buttons (the same hole ScanViewController
    /// closed, skeptic #19).
    private var appeared = false
    private var pendingOutcome: MeasureOutcome?
    /// Points are taken only while tracking is NORMAL: a point dropped while the camera is still
    /// finding its place (or after an interruption moved the world origin) is in another frame, and a
    /// length across two frames is a wrong number with a confident face (skeptic #16, M11).
    private var trackingNormal = false

    private let sceneView = ARSCNView()
    private let readout = UILabel()
    private let metric = UILabel()
    private let status = UILabel()
    private let crosshair = UIView()
    private let doneButton = UIButton(type: .system)
    private let undoButton = UIButton(type: .system)
    private let addButton = UIButton(type: .system)

    private var points: [SCNVector3] = []
    private var pointNodes: [SCNNode] = []
    private var lineNodes: [SCNNode] = []
    private var closingLine: SCNNode?
    private var surfaceSeen = false
    private let lidar = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)

    init(mode: MeasureMode, done: @escaping (MeasureOutcome) -> Void) {
        self.mode = mode
        self.done = done
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        sceneView.frame = view.bounds
        sceneView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        sceneView.delegate = self
        sceneView.session.delegate = self
        sceneView.automaticallyUpdatesLighting = true
        view.addSubview(sceneView)
        // No tap-anywhere: a brush against the readout must not change the figure. The + button adds.

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
        readout.font = .monospacedDigitSystemFont(ofSize: 34, weight: .bold)
        metric.font = .monospacedDigitSystemFont(ofSize: 15, weight: .medium)
        metric.textColor = UIColor.white.withAlphaComponent(0.8)
        status.font = .systemFont(ofSize: 15, weight: .medium)
        status.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        status.layer.cornerRadius = 10
        status.layer.masksToBounds = true

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        style(cancel, filled: false)
        undoButton.setTitle("Undo", for: .normal)
        undoButton.addTarget(self, action: #selector(undoTapped), for: .touchUpInside)
        style(undoButton, filled: false)
        doneButton.setTitle("Done", for: .normal)
        doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        style(doneButton, filled: true)
        addButton.setTitle("+", for: .normal)
        addButton.titleLabel?.font = .systemFont(ofSize: 34, weight: .semibold)
        addButton.addTarget(self, action: #selector(addPoint), for: .touchUpInside)
        addButton.backgroundColor = .white
        addButton.setTitleColor(.black, for: .normal)
        addButton.layer.cornerRadius = 36
        addButton.accessibilityLabel = "Add Point"
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
        status.layoutMargins = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        refresh()
        say("Finding surfaces — move the phone slowly")
    }

    private func style(_ b: UIButton, filled: Bool) {
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

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal, .vertical]
        if lidar { config.sceneReconstruction = .mesh }
        sceneView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        appeared = true
        if let pendingOutcome {
            self.pendingOutcome = nil
            finish(pendingOutcome)
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sceneView.session.pause()
    }

    // MARK: - Points

    /// Where the crosshair rests, in world space: the LiDAR mesh or a detected plane first, an
    /// estimated plane as the fallback. Nil when the camera has not found a surface there yet.
    private func hit() -> SCNVector3? {
        let center = CGPoint(x: sceneView.bounds.midX, y: sceneView.bounds.midY)
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

    @objc private func addPoint() {
        guard !finished else { return }
        guard trackingNormal else {
            say("Hold on — the camera is still finding its place")
            return
        }
        guard let p = hit() else {
            say("Point the circle at a surface and try again")
            return
        }
        surfaceSeen = true
        points.append(p)
        let node = SCNNode(geometry: SCNSphere(radius: 0.006))
        node.geometry?.firstMaterial?.diffuse.contents = UIColor.white
        node.geometry?.firstMaterial?.emission.contents = UIColor.white
        node.position = p
        sceneView.scene.rootNode.addChildNode(node)
        pointNodes.append(node)
        if points.count >= 2 {
            let line = Self.lineNode(from: points[points.count - 2], to: p)
            sceneView.scene.rootNode.addChildNode(line)
            lineNodes.append(line)
        }
        refresh()
    }

    @objc private func undoTapped() {
        guard !finished, !points.isEmpty else { return }
        points.removeLast()
        pointNodes.popLast()?.removeFromParentNode()
        lineNodes.popLast()?.removeFromParentNode()
        refresh()
    }

    @objc private func cancelTapped() {
        finish(.cancelled)
    }

    @objc private func doneTapped() {
        guard let value = reading() else { return }
        let photo = Self.downscaled(sceneView.snapshot(), maxSide: 1600).jpegData(compressionQuality: 0.6)
        finish(.measured(MeasureReading(mode: mode, value: value, points: points.count, lidar: lidar, photo: photo)))
    }

    private func finish(_ outcome: MeasureOutcome) {
        guard !finished else { return }
        guard appeared else {
            // Decided while the screen is still coming up (ARKit can fail inside the animation):
            // stop the camera and the buttons now, answer from viewDidAppear.
            if pendingOutcome == nil {
                pendingOutcome = outcome
                sceneView.session.pause()
                view.isUserInteractionEnabled = false
            }
            return
        }
        finished = true
        sceneView.session.pause()
        // The presenter takes the whole stack down. With no presenter the screen is already off
        // (taken down from outside), there is nothing to dismiss and UIKit would never call back:
        // answer now.
        guard let presenter = presentingViewController else {
            done(outcome)
            return
        }
        presenter.dismiss(animated: true) { [done] in done(outcome) }
    }

    // MARK: - The figure

    /// Meters along the points (a length), or square meters inside them (an area); nil until there
    /// are enough points to be one.
    private func reading() -> Double? {
        switch mode {
        case .length:
            guard points.count >= 2 else { return nil }
            var total = 0.0
            for i in 1..<points.count { total += Self.distance(points[i - 1], points[i]) }
            // Two points on the same spot are not a length (half a centimetre is the floor).
            return total >= 0.005 ? total : nil
        case .area:
            guard points.count >= 3 else { return nil }
            let area = Self.polygonArea(points)
            return area >= 0.0005 ? area : nil
        }
    }

    private func refresh() {
        let value = reading()
        doneButton.isEnabled = value != nil
        undoButton.isEnabled = !points.isEmpty
        // The area closes itself on screen once it is one, so what is drawn is what is measured.
        closingLine?.removeFromParentNode()
        closingLine = nil
        if mode == .area, points.count >= 3, let first = points.first, let last = points.last {
            let line = Self.lineNode(from: last, to: first)
            sceneView.scene.rootNode.addChildNode(line)
            closingLine = line
        }
        if let v = value {
            if mode == .area {
                readout.text = Self.squareFeetText(v)
                metric.text = String(format: "%.2f m²", v)
            } else {
                readout.text = Self.feetInchesText(v)
                metric.text = String(format: "%.2f m", v)
            }
            say(mode == .area ? "Add more points, or Done" : "Add another point, or Done")
        } else {
            readout.text = mode == .area ? "Area" : "Length"
            metric.text = mode == .area ? (points.isEmpty ? "Add the corners, 3 or more" : "\(points.count) of 3 corners") : (points.isEmpty ? "Add the first point" : "Add the second point")
            if surfaceSeen { say(points.isEmpty ? "Point the circle at the start and tap +" : "Point the circle at the next spot and tap +") }
        }
    }

    private func say(_ text: String) {
        status.text = "  \(text)  "
    }

    // MARK: - Session

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        if case .normal = camera.trackingState { trackingNormal = true } else { trackingNormal = false }
        switch camera.trackingState {
        case .notAvailable:
            say("The camera can't track right now")
        case .limited(let reason):
            switch reason {
            case .excessiveMotion: say("Slow down — the camera lost its place")
            case .insufficientFeatures: say("Too dark or too plain here — add light or step back")
            case .initializing: say("Finding surfaces — move the phone slowly")
            case .relocalizing: say("Finding its place again — hold still")
            @unknown default: say("Finding surfaces — move the phone slowly")
            }
        case .normal:
            if !surfaceSeen { say("Ready — point the circle at a surface and tap +") }
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        finish(.failed("The camera couldn't measure (\(error.localizedDescription)). Try again, or type the measurement."))
    }

    /// An interruption (a call, the app put away) can move the world origin: the points taken before
    /// it would be in another frame than the ones after. They are cleared, and said so.
    func sessionWasInterrupted(_ session: ARSession) {
        trackingNormal = false
        clearPoints()
        say("Measuring was interrupted — start again")
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        say("Ready — point the circle at the start and tap +")
    }

    /// No relocalising to a frame we no longer hold points in: a fresh origin is fine, the points are gone.
    func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { false }

    private func clearPoints() {
        points.removeAll()
        pointNodes.forEach { $0.removeFromParentNode() }
        pointNodes.removeAll()
        lineNodes.forEach { $0.removeFromParentNode() }
        lineNodes.removeAll()
        refresh()
    }

    // MARK: - Geometry

    static func distance(_ a: SCNVector3, _ b: SCNVector3) -> Double {
        let dx = Double(a.x - b.x), dy = Double(a.y - b.y), dz = Double(a.z - b.z)
        return (dx * dx + dy * dy + dz * dz).squareRoot()
    }

    /// Newell's method: the area of a polygon in 3D is half the length of the sum of the cross
    /// products of consecutive vertices — exact for a flat polygon, and the honest answer for
    /// corners that are nearly flat (a driveway, a deck footprint).
    static func polygonArea(_ pts: [SCNVector3]) -> Double {
        guard pts.count >= 3 else { return 0 }
        var nx = 0.0, ny = 0.0, nz = 0.0
        for i in 0..<pts.count {
            let a = pts[i], b = pts[(i + 1) % pts.count]
            nx += Double(a.y * b.z - a.z * b.y)
            ny += Double(a.z * b.x - a.x * b.z)
            nz += Double(a.x * b.y - a.y * b.x)
        }
        return 0.5 * (nx * nx + ny * ny + nz * nz).squareRoot()
    }

    static func feetInchesText(_ meters: Double) -> String {
        let inches = meters * 39.3701
        var ft = Int(inches / 12)
        var rounded = ((inches - Double(ft) * 12) * 10).rounded() / 10
        if rounded >= 12 { ft += 1; rounded = 0 }
        if ft == 0 { return String(format: "%.1f in", rounded) }
        return String(format: "%d ft %.1f in", ft, rounded)
    }

    /// The snapshot at a size the bridge and the upload are happy with (the page downscales again).
    static func downscaled(_ image: UIImage, maxSide: CGFloat) -> UIImage {
        let w = image.size.width, h = image.size.height
        let longest = max(w, h)
        guard longest > maxSide, longest > 0 else { return image }
        let scale = maxSide / longest
        let size = CGSize(width: (w * scale).rounded(), height: (h * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }

    static func squareFeetText(_ squareMeters: Double) -> String {
        String(format: "%.1f sq ft", squareMeters * 10.7639)
    }

    /// A thin cylinder from a to b: its axis is Y, so look(at:) with the local front set to the
    /// node's up turns the axis onto the segment.
    static func lineNode(from a: SCNVector3, to b: SCNVector3) -> SCNNode {
        let d = CGFloat(distance(a, b))
        let cyl = SCNCylinder(radius: 0.0015, height: d)
        cyl.firstMaterial?.diffuse.contents = UIColor.white
        cyl.firstMaterial?.emission.contents = UIColor.white
        let node = SCNNode(geometry: cyl)
        node.position = SCNVector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
        // `up` must not run along the segment itself (a wall-height line): then a sideways up.
        let vertical = d > 0 && abs(Double(b.y - a.y)) / Double(d) > 0.9
        node.look(at: b, up: vertical ? SCNVector3(1, 0, 0) : SCNVector3(0, 1, 0), localFront: SCNVector3(0, 1, 0))
        return node
    }
}
