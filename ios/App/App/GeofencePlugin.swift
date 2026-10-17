import Capacitor
import CoreLocation
import UserNotifications

/// THE JOB'S FENCE, WITH THE SCREEN OFF (field feedback 10-13, item 4; Chris 2026-10-14 351e2be4
/// "use geo tracking to remember when I left jobsite"; the 07-06 and 07-17 requests).
///
/// The page already owns the whole fence (components/geofence-monitor.tsx): the anchor, the prompt
/// sheet, the payroll boundary (a human states the time; the live auto-fallback writes the last
/// GPS-observed at-site time), snooze, the wake exit-check, the server push. Its one hole is
/// physics: an iOS WebView gets no background location, so a tech who drives off with the phone
/// in a pocket is not asked until the next time the app is opened — the 30-hour shift.
///
/// THIS FILLS THAT HOLE AND NOTHING ELSE. One CLCircularRegion around the clock-in anchor, Always
/// authorization, iOS watches it with the app asleep or gone, and on exit the app is woken to:
///   1. remember the exit (entry id + the time iOS observed it) in UserDefaults, and
///   2. post ONE local notification: "Looks like you left <the job> — still on the clock?"
/// The next open — a tap on that notification, or any open — reads the pending exit through
/// readPendingExit() and the page opens its own sheet with that time filled in, for the person to
/// confirm or change. Nothing is written to the clock from here, there is no network from here,
/// and nothing is recorded between arriving and leaving: a region monitor is a tripwire, not a
/// track. disarm() at clock-out removes the region.
///
/// RELAUNCH: iOS starts the app in the background for a region event. GeofenceCore is created in
/// AppDelegate.didFinishLaunching so a delegate exists before any bridge or web view does.
final class GeofenceCore: NSObject, CLLocationManagerDelegate {
    static let shared = GeofenceCore()
    static let regionId = "cn.job-fence"
    private static let pendingKey = "cn.geofence.pending"
    private static let armedKey = "cn.geofence.armed"
    /// When the lock-screen alert last went: one site exit must not ring on every GPS flicker.
    private static let notifiedKey = "cn.geofence.notified"
    static let notifyEvery: TimeInterval = 30 * 60

    /// A device that cannot monitor regions at all (an old iPad, a simulator): arm() refuses and says so.
    static func monitorable() -> Bool { CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) }

    private let manager = CLLocationManager()
    /// The page attached to a live app, when there is one, to hear exits straight away.
    var onExit: (([String: Any]) -> Void)?

    private override init() {
        super.init()
        manager.delegate = self
        manager.allowsBackgroundLocationUpdates = true
        manager.pausesLocationUpdatesAutomatically = false
    }

    /// Called once at launch: the delegate is what CoreLocation wakes.
    func start() {
        _ = manager.monitoredRegions
    }

    /// `notify`: whether an exit posts the lock-screen alert — the page says false for the office,
    /// the same techs-only rule the server's push keeps (audit v1120, class 6). False = not armed.
    @discardableResult
    func arm(entryId: String, lat: Double, lng: Double, radiusM: Double, label: String, notify: Bool) -> Bool {
        guard GeofenceCore.monitorable() else {
            print("[Geofence] region monitoring is not available on this device")
            return false
        }
        let status = manager.authorizationStatus
        if status == .notDetermined || status == .authorizedWhenInUse {
            manager.requestAlwaysAuthorization()
        }
        for r in manager.monitoredRegions where r.identifier == GeofenceCore.regionId {
            manager.stopMonitoring(for: r)
        }
        let radius = min(max(radiusM, 100), manager.maximumRegionMonitoringDistance)
        let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: lat, longitude: lng), radius: radius, identifier: GeofenceCore.regionId)
        region.notifyOnEntry = false
        region.notifyOnExit = true
        manager.startMonitoring(for: region)
        UserDefaults.standard.set(["entryId": entryId, "label": label, "lat": lat, "lng": lng, "radiusM": radius, "notify": notify, "armedAt": ISO8601DateFormatter().string(from: Date())], forKey: GeofenceCore.armedKey)
        print("[Geofence] armed \(entryId) r=\(Int(radius))m auth=\(status.rawValue) notify=\(notify)")
        return true
    }

    func disarm() {
        for r in manager.monitoredRegions where r.identifier == GeofenceCore.regionId {
            manager.stopMonitoring(for: r)
        }
        UserDefaults.standard.removeObject(forKey: GeofenceCore.armedKey)
        UserDefaults.standard.removeObject(forKey: GeofenceCore.pendingKey)
        UserDefaults.standard.removeObject(forKey: GeofenceCore.notifiedKey)
        print("[Geofence] disarmed")
    }

    func armed() -> [String: Any]? {
        UserDefaults.standard.dictionary(forKey: GeofenceCore.armedKey)
    }

    func pending(clear: Bool) -> [String: Any]? {
        let p = UserDefaults.standard.dictionary(forKey: GeofenceCore.pendingKey)
        if clear, p != nil { UserDefaults.standard.removeObject(forKey: GeofenceCore.pendingKey) }
        return p
    }

    func authorization() -> String {
        switch manager.authorizationStatus {
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "whenInUse"
        case .denied: return "denied"
        case .restricted: return "restricted"
        default: return "notDetermined"
        }
    }

    // MARK: CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        guard region.identifier == GeofenceCore.regionId else { return }
        let armed = UserDefaults.standard.dictionary(forKey: GeofenceCore.armedKey) ?? [:]
        let exitedAt = ISO8601DateFormatter().string(from: Date())
        let pending: [String: Any] = [
            "entryId": armed["entryId"] as? String ?? "",
            "label": armed["label"] as? String ?? "the job site",
            "exitedAt": exitedAt,
        ]
        UserDefaults.standard.set(pending, forKey: GeofenceCore.pendingKey)
        print("[Geofence] exit at \(exitedAt) for \(pending["entryId"] ?? "")")
        if let onExit { onExit(pending) }
        // THE ALERT IS THE TECH'S, AND AT MOST ONE PER HALF HOUR: the page arms the office with
        // notify=false (the server's push is techs-only too), and a boundary GPS flickers across
        // must not ring the phone on every step (audit v1120, class 6). The exit itself is kept above
        // either way, for the sheet.
        guard armed["notify"] as? Bool ?? true else { return }
        if let last = UserDefaults.standard.object(forKey: GeofenceCore.notifiedKey) as? Date, Date().timeIntervalSince(last) < GeofenceCore.notifyEvery { return }
        UserDefaults.standard.set(Date(), forKey: GeofenceCore.notifiedKey)
        let content = UNMutableNotificationContent()
        content.title = "Still on the clock?"
        content.body = "Looks like you left \(pending["label"] as? String ?? "the job site"). Open North to clock out or keep going."
        content.sound = .default
        content.userInfo = ["url": "/timeclock", "cn": "geofence-exit"]
        let request = UNNotificationRequest(identifier: "cn.geofence.exit", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { err in
            if let err { print("[Geofence] notification: \(err)") }
        }
    }

    func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        print("[Geofence] monitoring failed: \(error.localizedDescription)")
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        print("[Geofence] authorization: \(authorization())")
    }
}

/// The page's door to the fence: window.Capacitor.Plugins.Geofence.
@objc(GeofencePlugin)
public class GeofencePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GeofencePlugin"
    public let jsName = "Geofence"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "arm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disarm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readPendingExit", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
    ]

    public override func load() {
        GeofenceCore.shared.onExit = { [weak self] pending in
            self?.notifyListeners("exit", data: pending)
        }
    }

    @objc func arm(_ call: CAPPluginCall) {
        guard let entryId = call.getString("entryId"), !entryId.isEmpty,
              let lat = call.getDouble("lat"), let lng = call.getDouble("lng") else {
            return call.reject("entryId, lat and lng are needed")
        }
        let radius = call.getDouble("radiusM") ?? 150
        let label = call.getString("label") ?? "the job site"
        let notify = call.getBool("notify") ?? true
        DispatchQueue.main.async {
            let ok = GeofenceCore.shared.arm(entryId: entryId, lat: lat, lng: lng, radiusM: radius, label: label, notify: notify)
            call.resolve(["ok": ok, "authorization": GeofenceCore.shared.authorization(), "monitorable": GeofenceCore.monitorable()])
        }
    }

    @objc func disarm(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            GeofenceCore.shared.disarm()
            call.resolve(["ok": true])
        }
    }

    @objc func readPendingExit(_ call: CAPPluginCall) {
        let clear = call.getBool("clear") ?? false
        DispatchQueue.main.async {
            let p = GeofenceCore.shared.pending(clear: clear)
            call.resolve(["pending": p as Any])
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve([
                "authorization": GeofenceCore.shared.authorization(),
                "armed": GeofenceCore.shared.armed() as Any,
                "monitorable": GeofenceCore.monitorable(),
            ])
        }
    }
}
