import Foundation
import UIKit
import Capacitor

/// 만든 이미지·영상을 iOS 공유 시트로 넘긴다 ('이미지/비디오 저장', 인스타그램 등).
/// 웹의 navigator.share 는 영상처럼 만드는 데 몇 초 걸리면 '사용자 동작' 시간이 지나 막히므로 앱에서 직접 연다.
/// JS: Capacitor.Plugins.RunlogShare.share({ data: base64, name: '파일명.mp4' }) → { completed, activity }
@objc(RunlogSharePlugin)
public class RunlogSharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RunlogSharePlugin"
    public let jsName = "RunlogShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise),
    ]

    @objc func share(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.reject("파일 내용이 없어요"); return
        }
        let name = (call.getString("name") ?? "runlog").replacingOccurrences(of: "/", with: "-")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            call.reject("파일을 만들지 못했어요"); return
        }
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else { call.reject("화면을 찾지 못했어요"); return }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = vc.view
            sheet.completionWithItemsHandler = { activity, completed, _, _ in
                try? FileManager.default.removeItem(at: url)
                call.resolve(["completed": completed, "activity": activity?.rawValue ?? ""])
            }
            vc.present(sheet, animated: true)
        }
    }
}
