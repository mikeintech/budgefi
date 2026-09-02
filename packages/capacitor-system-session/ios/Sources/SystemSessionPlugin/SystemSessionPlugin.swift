import AuthenticationServices
import Capacitor
import Foundation
import UIKit

@objc(SystemSessionPlugin)
public final class SystemSessionPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "SystemSessionPlugin"
    public let jsName = "SystemSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    private var session: ASWebAuthenticationSession?

    @objc public func open(_ call: CAPPluginCall) {
        guard session == nil else {
            call.reject("A secure browser session is already active", "SESSION_ALREADY_ACTIVE")
            return
        }
        guard let rawURL = call.getString("url"), let url = URL(string: rawURL), url.scheme == "https" else {
            call.reject("A valid HTTPS URL is required", "INVALID_AUTH_URL")
            return
        }
        guard let callbackScheme = call.getString("callbackScheme"), !callbackScheme.isEmpty else {
            call.reject("A callback scheme is required", "INVALID_CALLBACK_SCHEME")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let authenticationSession = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { [weak self] callbackURL, error in
                defer { self?.session = nil }
                if let callbackURL {
                    call.resolve(["callbackUrl": callbackURL.absoluteString])
                    return
                }
                if let sessionError = error as? ASWebAuthenticationSessionError,
                   sessionError.code == .canceledLogin {
                    call.reject("The secure browser was closed", "SESSION_CANCELLED", error)
                    return
                }
                call.reject("The secure browser could not finish", "SESSION_FAILED", error)
            }
            authenticationSession.presentationContextProvider = self
            authenticationSession.prefersEphemeralWebBrowserSession = call.getBool("prefersEphemeralSession") ?? false
            self.session = authenticationSession
            if !authenticationSession.start() {
                self.session = nil
                call.reject("The secure browser could not start", "SESSION_START_FAILED")
            }
        }
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.session?.cancel()
            self?.session = nil
            call.resolve()
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? UIWindow()
    }
}
