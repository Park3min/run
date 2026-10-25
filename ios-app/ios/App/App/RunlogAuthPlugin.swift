import Foundation
import AuthenticationServices
import Capacitor

/// 스트라바 같은 공식 OAuth 연결 — iOS 의 보안 로그인 창(ASWebAuthenticationSession)을 띄우고,
/// 허락 뒤 돌아오는 주소(runlog://…?code=…)를 웹 화면에 넘긴다. 비밀번호는 앱이 보지 못한다.
/// JS: Capacitor.Plugins.RunlogAuth.start({ url, scheme: 'runlog' }) → { url }
@objc(RunlogAuthPlugin)
public class RunlogAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "RunlogAuthPlugin"
    public let jsName = "RunlogAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
    ]
    private var session: ASWebAuthenticationSession?

    @objc func start(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s), let scheme = call.getString("scheme") else {
            call.reject("연결 주소가 없어요"); return
        }
        DispatchQueue.main.async {
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { cb, err in
                self.session = nil
                if let cb = cb { call.resolve(["url": cb.absoluteString]); return }
                if let e = err as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    call.reject("연결을 취소했어요", "canceled"); return
                }
                call.reject(err?.localizedDescription ?? "연결하지 못했어요")
            }
            session.presentationContextProvider = self
            self.session = session
            if !session.start() { self.session = nil; call.reject("로그인 창을 열지 못했어요") }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
