// AdamWispr: Context awareness service
// Detects app, URL, surrounding text, and matches to style categories

import { NativeBridge } from "./NativeBridge";
import type { NativeContext } from "./NativeBridge";

export interface AppContext {
  appName: string;
  url?: string;
  pageTitle?: string;
  surroundingText?: string;
  category: string;
  detectionLevel: "url" | "hostname" | "title" | "app-only";
  isDenylisted: boolean;
}

const BROWSER_APPS = [
  "Google Chrome",
  "Safari",
  "Arc",
  "Firefox",
  "Microsoft Edge",
  "Brave Browser",
];

// Cache browser URL to avoid polling on every dictation
// Keyed by app name so switching browsers doesn't return stale data
let cachedBrowserContext: {
  appName?: string;
  url?: string;
  timestamp: number;
} = { timestamp: 0 };
const BROWSER_CACHE_TTL = 2000;

export class ContextService {
  static async getCurrentContext(): Promise<AppContext> {
    // Single native call for app name, window title, surrounding text, secure field check
    const native = await NativeBridge.getContext();
    const appName = native.appName;

    // Check denylist
    const isDenylisted = await this.isDenylisted(appName);
    const isSecure = native.isSecureField;

    if (isDenylisted || isSecure) {
      return {
        appName,
        category: await this.getCategory(appName),
        detectionLevel: "app-only",
        isDenylisted: true,
      };
    }

    let url: string | undefined;
    let pageTitle: string | undefined;
    let detectionLevel: AppContext["detectionLevel"] = "app-only";

    // Browser-specific detection with fallback chain
    if (BROWSER_APPS.includes(appName)) {
      const now = Date.now();
      const cacheValid =
        cachedBrowserContext.appName === appName &&
        now - cachedBrowserContext.timestamp < BROWSER_CACHE_TTL;

      if (cacheValid) {
        url = cachedBrowserContext.url;
      } else {
        url = (await NativeBridge.getBrowserUrl(appName)) ?? undefined;
        cachedBrowserContext = { appName, url, timestamp: now };
      }

      pageTitle = native.windowTitle ?? undefined;

      if (url) {
        detectionLevel = "url";
        // Check URL against denylist
        if (await this.isUrlDenylisted(url)) {
          return {
            appName,
            url,
            pageTitle,
            category: await this.getCategory(appName, url),
            detectionLevel,
            isDenylisted: true,
          };
        }
      } else if (pageTitle) {
        const hostnameMatch = pageTitle.match(/[-\w]+\.\w{2,}/);
        detectionLevel = hostnameMatch ? "hostname" : "title";
      }

      // Check for incognito/private browsing
      if (
        pageTitle?.endsWith(" - Incognito") ||
        pageTitle?.endsWith(" — Private Browsing") ||
        pageTitle?.startsWith("InPrivate")
      ) {
        return {
          appName,
          pageTitle,
          category: await this.getCategory(appName),
          detectionLevel,
          isDenylisted: true,
        };
      }
    } else {
      pageTitle = native.windowTitle ?? undefined;
      if (pageTitle) detectionLevel = "title";
    }

    // Surrounding text already from native context (capped at 500 chars in Swift helper)
    const surroundingText = native.surroundingText ?? undefined;

    const category = await this.getCategory(appName, url);

    return {
      appName,
      url,
      pageTitle,
      surroundingText,
      category,
      detectionLevel,
      isDenylisted: false,
    };
  }

  static async isDenylisted(appName: string, url?: string): Promise<boolean> {
    const denylist = await window.electronAPI.awGetDenylist();
    return denylist.some(
      (entry: { app_name: string; url_pattern: string }) =>
        (entry.app_name && appName.includes(entry.app_name)) ||
        (entry.url_pattern && url?.includes(entry.url_pattern))
    );
  }

  private static async isUrlDenylisted(url: string): Promise<boolean> {
    const denylist = await window.electronAPI.awGetDenylist();
    return denylist.some(
      (entry: { url_pattern: string }) =>
        entry.url_pattern && url.includes(entry.url_pattern)
    );
  }

  static async getCategory(appName: string, url?: string): Promise<string> {
    const categories = await window.electronAPI.awGetAppCategories();

    // URL match first (more specific)
    if (url) {
      const urlMatch = categories.find(
        (c: { url_pattern: string }) => c.url_pattern && url.includes(c.url_pattern)
      );
      if (urlMatch) return urlMatch.category;
    }

    // App name match
    const appMatch = categories.find(
      (c: { app_name: string; url_pattern: string }) =>
        c.app_name && !c.url_pattern && appName.includes(c.app_name)
    );
    if (appMatch) return appMatch.category;

    // Default
    const { useSettingsStore } = await import("../stores/settingsStore");
    return useSettingsStore.getState().awDefaultCategory || "Professional";
  }

  static invalidateCache(): void {
    cachedBrowserContext = { timestamp: 0 };
  }
}
