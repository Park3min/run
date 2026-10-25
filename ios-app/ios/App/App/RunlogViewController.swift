import UIKit
import Capacitor

/// 앱 안에 둔 네이티브 플러그인을 등록하는 화면 (웹 화면이 뜨기 전에 등록해야 JS 에서 보인다)
class RunlogViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        let health = RunlogHealthPlugin()
        bridge?.registerPluginInstance(health)
        bridge?.registerPluginInstance(RunlogSharePlugin())
        #if DEBUG
        // 개발용 예시 기록: xcrun simctl launch <기기> com.park3min.runlog -seedHealthDemo YES
        // 권한 창은 화면이 뜬 뒤에만 나타나므로 잠시 뒤에 요청한다
        if UserDefaults.standard.bool(forKey: "seedHealthDemo") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { health.seedDemo() }
        }
        #endif
    }
}
