import Capacitor

// The shell's root view controller. Capacitor only knows about a local plugin if it is
// registered on the bridge before the web view loads, and the hook for that is
// capacitorDidLoad() on a CAPBridgeViewController subclass — a plain CAPBridgeViewController
// never learns about TapToPayEducation, and the hosted page's
// window.Capacitor.Plugins.TapToPayEducation is simply undefined.
//
// Both places that create the root view controller must name THIS class: SceneDelegate
// (which builds it in code and replaces whatever the storyboard made) and Main.storyboard.
// A mismatch registers the plugin on a view controller that is never on screen — no error,
// no log line, just a missing plugin.
class NorthBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(TapToPayEducationPlugin())
    }
}
