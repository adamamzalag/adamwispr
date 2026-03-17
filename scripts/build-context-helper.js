// Build script for AdamWispr context helper (macOS only)
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const SWIFT_SOURCE = path.join(__dirname, "..", "resources", "adamwispr-context-helper.swift");
const OUTPUT_PATH = path.join(__dirname, "..", "resources", "bin", "adamwispr-context-helper");
const MODULE_CACHE = path.join(__dirname, "..", "resources", "bin", ".swift-module-cache");

if (process.platform !== "darwin") {
  console.log("[context-helper] Skipping — macOS only");
  process.exit(0);
}

if (!fs.existsSync(SWIFT_SOURCE)) {
  console.log("[context-helper] Swift source not found, skipping");
  process.exit(0);
}

try {
  const cmd = `xcrun swiftc ${SWIFT_SOURCE} -O -target arm64-apple-macosx11.0 -module-cache-path ${MODULE_CACHE} -o ${OUTPUT_PATH}`;
  console.log(`[context-helper] Compiling with ${cmd.split(" ").slice(0, 3).join(" ")}...`);
  execSync(cmd, { stdio: "inherit" });
  console.log("[context-helper] Successfully built AdamWispr context helper (arm64).");
} catch (error) {
  console.error("[context-helper] Build failed:", error.message);
  process.exit(1);
}
