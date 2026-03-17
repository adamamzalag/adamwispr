// AdamWispr: Native bridge service
// Wraps IPC calls to Swift helper and platform APIs

export interface NativeContext {
  appName: string;
  windowTitle: string | null;
  surroundingText: string | null;
  isSecureField: boolean;
  fieldRole: string | null;
  fieldSubrole: string | null;
}

export interface PasteboardState {
  items: Array<{ type: string; data: unknown }>;
  textFingerprint: string;
  formatFingerprint: string;
}

export interface PostPasteFingerprint {
  textFingerprint: string;
  formatFingerprint: string;
}

export class NativeBridge {
  /**
   * Get full context via Swift helper.
   * Returns app name, window title, surrounding text, secure field check.
   * TODO: Implement Swift helper in Task 6
   */
  static async getContext(): Promise<NativeContext> {
    try {
      return await window.electronAPI.awGetContext();
    } catch {
      return {
        appName: "Unknown",
        windowTitle: null,
        surroundingText: null,
        isSecureField: false,
        fieldRole: null,
        fieldSubrole: null,
      };
    }
  }

  /**
   * Get Chrome/Safari URL via AppleScript (main process IPC).
   */
  static async getBrowserUrl(appName: string): Promise<string | null> {
    try {
      return await window.electronAPI.awGetBrowserUrl(appName);
    } catch {
      return null;
    }
  }

  /**
   * Save the current pasteboard state (for clipboard preservation).
   */
  static async savePasteboard(): Promise<PasteboardState> {
    try {
      return await window.electronAPI.awSavePasteboard();
    } catch {
      return { items: [], textFingerprint: "", formatFingerprint: "" };
    }
  }

  /**
   * Take a fingerprint of the clipboard immediately after paste.
   */
  static async takePostPasteFingerprint(): Promise<PostPasteFingerprint> {
    try {
      return await window.electronAPI.awTakePostPasteFingerprint();
    } catch {
      return { textFingerprint: "", formatFingerprint: "" };
    }
  }

  /**
   * Restore a previously saved pasteboard state.
   */
  static async restorePasteboard(
    state: PasteboardState,
    postPasteFingerprint: PostPasteFingerprint
  ): Promise<boolean> {
    try {
      return await window.electronAPI.awRestorePasteboard(
        state,
        postPasteFingerprint
      );
    } catch {
      return false;
    }
  }

  /**
   * Capture the currently focused app for text field tracking.
   */
  static async captureFieldReference(): Promise<string | null> {
    try {
      return await window.electronAPI.awCaptureFieldReference();
    } catch {
      return null;
    }
  }

  /**
   * Refocus a previously captured app.
   */
  static async refocusField(): Promise<boolean> {
    try {
      return await window.electronAPI.awRefocusCapturedField();
    } catch {
      return false;
    }
  }
}
