/// <reference types="@capacitor/push-notifications" />
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.budgefi.app",
  appName: "Budgefi",
  webDir: "dist",
  backgroundColor: "#f3eedf",
  loggingBehavior: "none",
  zoomEnabled: true,
  ios: {
    contentInset: "never",
    allowsLinkPreview: false,
    backgroundColor: "#f3eedf",
    scheme: "App",
  },
  android: {
    allowMixedContent: false,
    backgroundColor: "#f3eedf",
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: "https",
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "banner", "list", "sound"],
    },
    SplashScreen: {
      launchShowDuration: 3000,
      launchAutoHide: false,
      backgroundColor: "#f3eedfff",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      overlaysWebView: true,
      backgroundColor: "#f3eedf",
    },
  },
};

export default config;
