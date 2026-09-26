import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // A fresh process holds no picked file, so every copy a past one left behind can go.
        AppDelegate.sweepPickedFileCopies(olderThan: 0)
        // A long-lived process keeps today's copies (a form may still hold one) and drops the rest.
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification,
                                               object: nil, queue: nil) { _ in
            AppDelegate.sweepPickedFileCopies(olderThan: 24 * 60 * 60)
        }
        return true
    }

    // ── THE CAMERA'S LEFTOVERS ────────────────────────────────────────────────────────────────
    // Every photo taken or picked through an <input type=file> is copied by WebKit into
    // tmp/WKWebFileUpload-XXXX/ and never removed. On Erik's phone (2026-09-25) that was 26
    // photos, 74 MB, back to 9/11, and it only grows. Only those folders are touched: the rest of
    // tmp belongs to WebKit and the Stripe reader.
    static func sweepPickedFileCopies(olderThan age: TimeInterval) {
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            let tmp = fm.temporaryDirectory
            guard let names = try? fm.contentsOfDirectory(atPath: tmp.path) else { return }
            let cutoff = Date().addingTimeInterval(-age)
            for name in names where name.hasPrefix("WKWebFileUpload-") {
                let url = tmp.appendingPathComponent(name)
                let made = (try? fm.attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? .distantPast
                if age > 0 && made > cutoff { continue }
                try? fm.removeItem(at: url)
            }
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    // ── APNs, forwarded to Capacitor's PushNotifications plugin ──────────────────────────────
    // The plugin cannot see UIApplicationDelegate callbacks on its own; the OS hands the device
    // token here and Capacitor listens on these two notifications. Without this pair the JS
    // `registration` event never fires and register() hangs silently — which is exactly the
    // failure mode that looks like "push doesn't work in the app".
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications,
                                        object: deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications,
                                        object: error)
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
