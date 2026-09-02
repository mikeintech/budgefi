import { registerPlugin, type Plugin } from "@capacitor/core";

export interface SystemSessionPlugin extends Plugin {
  open(options: {
    url: string;
    callbackScheme: string;
    prefersEphemeralSession?: boolean;
  }): Promise<{ callbackUrl: string }>;
  cancel(): Promise<void>;
}

export const SystemSession = registerPlugin<SystemSessionPlugin>("SystemSession");
