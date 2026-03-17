// AdamWispr Context Helper
// Standalone Swift binary for macOS context detection using AXUIElement APIs
// Communicates via stdout JSON, invoked by main process
// Usage: adamwispr-context-helper get-context

import Cocoa
import ApplicationServices

struct ContextResult: Codable {
    let appName: String
    let windowTitle: String?
    let surroundingText: String?
    let isSecureField: Bool
    let fieldRole: String?
    let fieldSubrole: String?
}

func getContext() -> ContextResult {
    let workspace = NSWorkspace.shared
    guard let frontApp = workspace.frontmostApplication else {
        return ContextResult(
            appName: "Unknown", windowTitle: nil,
            surroundingText: nil, isSecureField: false,
            fieldRole: nil, fieldSubrole: nil
        )
    }

    let appName = frontApp.localizedName ?? "Unknown"
    let pid = frontApp.processIdentifier
    let appElement = AXUIElementCreateApplication(pid)

    // Get window title
    var windowTitle: String? = nil
    var windowRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowRef) == .success {
        var titleRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(windowRef as! AXUIElement, kAXTitleAttribute as CFString, &titleRef) == .success {
            windowTitle = titleRef as? String
        }
    }

    // Get focused element info
    var focusedRef: CFTypeRef?
    var isSecure = false
    var surroundingText: String? = nil
    var fieldRole: String? = nil
    var fieldSubrole: String? = nil

    if AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
       let focused = focusedRef {
        let focusedElement = focused as! AXUIElement

        // Check role
        var roleRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(focusedElement, kAXRoleAttribute as CFString, &roleRef) == .success {
            fieldRole = roleRef as? String
        }

        // Check subrole
        var subroleRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(focusedElement, kAXSubroleAttribute as CFString, &subroleRef) == .success {
            fieldSubrole = subroleRef as? String
        }

        // Detect secure text fields (password inputs)
        isSecure = (fieldSubrole == "AXSecureTextField") || (fieldRole == "AXSecureTextField")

        // Only read value if not secure
        if !isSecure {
            var valueRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(focusedElement, kAXValueAttribute as CFString, &valueRef) == .success {
                if let text = valueRef as? String {
                    if text.count <= 500 {
                        surroundingText = text
                    } else {
                        // Try to get selected range to grab text near cursor
                        var rangeRef: CFTypeRef?
                        if AXUIElementCopyAttributeValue(focusedElement, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
                           let rangeValue = rangeRef {
                            var range = CFRange()
                            if AXValueGetValue(rangeValue as! AXValue, .cfRange, &range) {
                                let start = max(0, range.location - 250)
                                let end = min(text.count, range.location + 250)
                                let startIdx = text.index(text.startIndex, offsetBy: start)
                                let endIdx = text.index(text.startIndex, offsetBy: end)
                                surroundingText = String(text[startIdx..<endIdx])
                            }
                        }
                        if surroundingText == nil {
                            // Fallback: last 500 chars
                            surroundingText = String(text.suffix(500))
                        }
                    }
                }
            }
        }
    }

    return ContextResult(
        appName: appName, windowTitle: windowTitle,
        surroundingText: surroundingText, isSecureField: isSecure,
        fieldRole: fieldRole, fieldSubrole: fieldSubrole
    )
}

// Main entry point
let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : "get-context"

switch command {
case "get-context":
    let result = getContext()
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(result),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("{\"appName\":\"Unknown\",\"windowTitle\":null,\"surroundingText\":null,\"isSecureField\":false,\"fieldRole\":null,\"fieldSubrole\":null}")
    }
default:
    print("{\"error\":\"unknown command: \(command)\"}")
    exit(1)
}
