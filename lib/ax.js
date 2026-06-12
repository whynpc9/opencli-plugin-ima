import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { activateImaApp, getImaRuntimeConfig } from './platform.js';
import { inspectImaWindowsUiAutomation } from './uia.js';

const BUNDLE_ID = getImaRuntimeConfig().identifiers.bundleId || 'com.tencent.imamac';
const DISPLAY_NAME = getImaRuntimeConfig().displayName || 'ima.copilot';
const SWIFT_BUFFER = 50 * 1024 * 1024;
const SWIFT_TIMEOUT_MS = 10000;

export function activateIma() {
  activateImaApp();
}

export function inspectIma({ activate = false } = {}) {
  const runtime = getImaRuntimeConfig();
  if (!runtime.capabilities.uiTransport) {
    if (runtime.os === 'windows') {
      return inspectImaWindowsUiAutomation({
        processPattern: runtime.commands.processPattern,
      });
    }
    return {
      running: false,
      trusted: false,
      title: '',
      knowledgeBase: '',
      composerReady: false,
      texts: [],
      error: `ima UI transport is not implemented for ${runtime.label}.`,
    };
  }
  if (activate) activateIma();
  try {
    return runSwiftJson(AX_STATUS_SCRIPT);
  } catch (error) {
    return {
      running: false,
      trusted: false,
      title: '',
      knowledgeBase: '',
      composerReady: false,
      texts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function askIma({ question, kb = '', timeout = 120 }) {
  activateIma();
  const timeoutMs = Math.max(Number(process.env.IMA_SWIFT_TIMEOUT_MS || SWIFT_TIMEOUT_MS), (Number(timeout) + 15) * 1000);
  return runSwiftJson(AX_ASK_SCRIPT, [question, kb, String(timeout)], { timeoutMs });
}

export function listImaDocumentsUi({ kb = '', path = '', limit = 50 } = {}) {
  activateIma();
  const result = runSwiftJson(AX_LIST_SCRIPT, [String(kb || ''), String(path || ''), String(limit || 50)], {
    timeoutMs: Math.max(Number(process.env.IMA_SWIFT_TIMEOUT_MS || SWIFT_TIMEOUT_MS), 15000),
  });
  const items = parseKnowledgeListTexts(result.texts || [], { path });
  return {
    status: result.status || 'success',
    knowledgeBase: result.knowledgeBase || kb || '',
    path: result.path || normalizeKnowledgePath(path),
    items: items.slice(0, Math.max(1, Number(limit || 50))),
    textCount: result.textCount || 0,
  };
}

export function dumpIma(outputPath = '/tmp/ima-a11y.json') {
  const runtime = getImaRuntimeConfig();
  if (!runtime.capabilities.uiTransport) {
    throw new Error(`ima Accessibility dump is not implemented for ${runtime.label}.`);
  }
  const dump = runSwiftJson(AX_DUMP_SCRIPT);
  fs.writeFileSync(outputPath, JSON.stringify(dump, null, 2));
  return outputPath;
}

function runSwiftJson(script, args = [], { timeoutMs = Number(process.env.IMA_SWIFT_TIMEOUT_MS || SWIFT_TIMEOUT_MS) } = {}) {
  const raw = execFileSync('swift', ['-', ...args], {
    input: script,
    encoding: 'utf8',
    maxBuffer: SWIFT_BUFFER,
    timeout: timeoutMs,
  }).trim();
  return raw ? JSON.parse(raw) : {};
}

const SWIFT_COMMON = String.raw`
import Cocoa
import ApplicationServices

let bundleId = ${JSON.stringify(BUNDLE_ID)}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return nil }
    return value as AnyObject?
}

func s(_ el: AXUIElement, _ name: String) -> String? {
    if let v = attr(el, name) as? String, !v.isEmpty { return v }
    return nil
}

func normalize(_ value: String) -> String {
    value.replacingOccurrences(of: "\u{00a0}", with: " ")
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func elementText(_ el: AXUIElement) -> String {
    normalize([
        s(el, kAXDescriptionAttribute as String) ?? "",
        s(el, kAXTitleAttribute as String) ?? "",
        s(el, kAXValueAttribute as String) ?? "",
        s(el, kAXHelpAttribute as String) ?? ""
    ].filter { !$0.isEmpty }.joined(separator: " "))
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    var out: [AXUIElement] = []
    var seen = Set<CFHashCode>()
    for key in [kAXChildrenAttribute as String, "AXVisibleChildren", "AXContents"] {
        for child in (attr(el, key) as? [AnyObject] ?? []).compactMap({ $0 as! AXUIElement? }) {
            let key = CFHash(child)
            if seen.contains(key) { continue }
            seen.insert(key)
            out.append(child)
        }
    }
    return out
}

func isEnabled(_ el: AXUIElement) -> Bool {
    (attr(el, kAXEnabledAttribute as String) as? Bool) ?? true
}

func role(_ el: AXUIElement) -> String {
    s(el, kAXRoleAttribute as String) ?? ""
}

func frame(_ el: AXUIElement) -> CGRect? {
    guard let posValue = attr(el, kAXPositionAttribute as String),
          let sizeValue = attr(el, kAXSizeAttribute as String) else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(posValue as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

func jsonPrint(_ object: Any) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [])
    print(String(data: data, encoding: .utf8)!)
}

func focusedWindow() -> (NSRunningApplication, AXUIElement)? {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
        return nil
    }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    if let focused = attr(axApp, kAXFocusedWindowAttribute as String) {
        return (app, focused as! AXUIElement)
    }
    if let windows = attr(axApp, kAXWindowsAttribute as String) as? [AXUIElement], !windows.isEmpty {
        return (app, windows.first!)
    }
    return nil
}

func collectTexts(_ el: AXUIElement, into out: inout [String], depth: Int = 0) {
    var visited = Set<CFHashCode>()
    collectTextsInner(el, into: &out, depth: depth, visited: &visited)
}

func collectTextsInner(_ el: AXUIElement, into out: inout [String], depth: Int, visited: inout Set<CFHashCode>) {
    guard depth < 60 else { return }
    let id = CFHash(el)
    if visited.contains(id) { return }
    visited.insert(id)
    let text = elementText(el)
    let r = role(el)
    if !text.isEmpty && ["AXStaticText", "AXButton", "AXTextField", "AXTextArea", "AXHeading", "AXCell", "AXRow", "AXColumn", "AXGroup"].contains(r) {
        if out.last != text { out.append(text) }
    }
    for child in children(el) { collectTextsInner(child, into: &out, depth: depth + 1, visited: &visited) }
}

func collectInputs(_ el: AXUIElement, into out: inout [AXUIElement], depth: Int = 0) {
    var visited = Set<CFHashCode>()
    collectInputsInner(el, into: &out, depth: depth, visited: &visited)
}

func collectInputsInner(_ el: AXUIElement, into out: inout [AXUIElement], depth: Int, visited: inout Set<CFHashCode>) {
    guard depth < 30 else { return }
    let id = CFHash(el)
    if visited.contains(id) { return }
    visited.insert(id)
    let r = role(el)
    if (r == kAXTextAreaRole as String || r == kAXTextFieldRole as String || r == "AXTextArea" || r == "AXTextField") && isEnabled(el) {
        out.append(el)
    }
    for child in children(el) { collectInputsInner(child, into: &out, depth: depth + 1, visited: &visited) }
}

func scoreInput(_ el: AXUIElement) -> Double {
    let text = elementText(el)
    var score = 0.0
    if text.contains("基于知识库提问") || text.contains("提问") || text.localizedCaseInsensitiveContains("message") {
        score += 10000
    }
    if role(el) == "AXTextArea" { score += 1000 }
    if let f = frame(el) {
        score += Double(f.minY)
        if f.width > 200 { score += 200 }
    }
    return score
}

func findComposer(_ win: AXUIElement) -> AXUIElement? {
    var inputs: [AXUIElement] = []
    collectInputs(win, into: &inputs)
    return inputs.max { scoreInput($0) < scoreInput($1) }
}

func findExactText(_ el: AXUIElement, _ target: String, depth: Int = 0) -> AXUIElement? {
    guard depth < 30 else { return nil }
    let text = normalize(elementText(el))
    if text == target {
        return el
    }
    for child in children(el) {
        if let found = findExactText(child, target, depth: depth + 1) { return found }
    }
    return nil
}

func clickElement(_ el: AXUIElement) -> Bool {
    guard let f = frame(el), f.width > 0, f.height > 0 else { return false }
    _ = AXUIElementPerformAction(el, kAXPressAction as CFString)
    let x = f.midX
    let y = f.midY
    let src = CGEventSource(stateID: .combinedSessionState)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?.post(tap: .cghidEventTap)
    return true
}

func clickText(_ win: AXUIElement, _ target: String) -> Bool {
    guard let el = findExactText(win, target) else { return false }
    return clickElement(el)
}

func pressReturn(pid: pid_t) {
    let src = CGEventSource(stateID: .combinedSessionState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: 0x24, keyDown: true)
    down?.postToPid(pid)
    let up = CGEvent(keyboardEventSource: src, virtualKey: 0x24, keyDown: false)
    up?.postToPid(pid)
}

func isGenerating(_ joined: String) -> Bool {
    joined.contains("停止生成") || joined.contains("正在生成") || joined.contains("生成中") || joined.contains("思考中") || joined.contains("正在搜索知识库资料")
}

func extractReferences(_ text: String) -> Int? {
    let pattern = #"找到了\s*(\d+)\s*篇知识库资料"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    let matches = regex.matches(in: text, range: range)
    guard let last = matches.last, let r = Range(last.range(at: 1), in: text) else { return nil }
    return Int(text[r])
}

func answerAfterQuestion(_ texts: [String], question: String) -> String {
    var joined = texts.joined(separator: "\n")
    if let historyRange = joined.range(of: "问答历史") {
        joined = String(joined[..<historyRange.lowerBound])
    }
    guard let questionRange = joined.range(of: question, options: .backwards) else {
        return ""
    }
    var answer = String(joined[questionRange.upperBound...])
    if let imaRange = answer.range(of: "ima") {
        answer = String(answer[imaRange.upperBound...])
    }
    answer = answer.replacingOccurrences(of: #"找到了\s*\d+\s*篇知识库资料"#, with: "", options: .regularExpression)
    for stop in ["生成脑图", "基于知识库提问", "对话模式", "DS 深度", "内容由AI生成仅供参考"] {
        if let stopRange = answer.range(of: stop) {
            answer = String(answer[..<stopRange.lowerBound])
        }
    }
    return normalize(answer)
}

func inferKnowledgeBase(title: String, texts: [String]) -> String {
    let normalizedTitle = normalize(title)
    if !normalizedTitle.isEmpty && normalizedTitle != "ima.copilot" {
        return normalizedTitle.replacingOccurrences(of: " - ima.copilot", with: "")
    }
    return texts.first(where: { $0.hasSuffix("知识库") }) ?? ""
}
`;

const AX_STATUS_SCRIPT = `${SWIFT_COMMON}
guard let (app, win) = focusedWindow() else {
    jsonPrint([
        "running": false,
        "trusted": AXIsProcessTrusted(),
        "title": "",
        "knowledgeBase": "",
        "composerReady": false,
        "texts": []
    ])
    exit(0)
}

var texts: [String] = []
collectTexts(win, into: &texts)
let title = s(win, kAXTitleAttribute as String) ?? ""
jsonPrint([
    "running": true,
    "pid": Int(app.processIdentifier),
    "trusted": AXIsProcessTrusted(),
    "title": title,
    "knowledgeBase": inferKnowledgeBase(title: title, texts: texts),
    "composerReady": findComposer(win) != nil,
    "generating": isGenerating(texts.joined(separator: "\\n")),
    "referencesFound": extractReferences(texts.joined(separator: "\\n")) as Any,
    "textCount": texts.count
])
`;

const AX_DUMP_SCRIPT = `${SWIFT_COMMON}
func dumpNode(_ el: AXUIElement, depth: Int = 0) -> [String: Any] {
    var object: [String: Any] = [
        "role": role(el),
        "text": elementText(el)
    ]
    if let f = frame(el) {
        object["frame"] = ["x": f.minX, "y": f.minY, "width": f.width, "height": f.height]
    }
    if depth < 12 {
        let kids = children(el).map { dumpNode($0, depth: depth + 1) }
        if !kids.isEmpty { object["children"] = kids }
    }
    return object
}

guard let (_, win) = focusedWindow() else {
    jsonPrint(["running": false, "trusted": AXIsProcessTrusted(), "tree": [:]])
    exit(0)
}
jsonPrint(["running": true, "trusted": AXIsProcessTrusted(), "tree": dumpNode(win)])
`;

const AX_LIST_SCRIPT = `${SWIFT_COMMON}
let args = CommandLine.arguments
let kb = args.count > 1 ? normalize(args[1]) : ""
let requestedPath = args.count > 2 ? normalize(args[2]) : ""

guard let (_, win) = focusedWindow() else {
    fputs("ima.copilot is not running or no accessible window was found\\n", stderr)
    exit(1)
}

if !AXIsProcessTrusted() {
    fputs("Accessibility permission is not granted for this terminal/OpenCLI process\\n", stderr)
    exit(1)
}

if !kb.isEmpty {
    var initialTexts: [String] = []
    collectTexts(win, into: &initialTexts)
    let title = s(win, kAXTitleAttribute as String) ?? ""
    let currentKb = inferKnowledgeBase(title: title, texts: initialTexts)
    if normalize(currentKb) != kb {
        _ = clickText(win, "知识库")
        Thread.sleep(forTimeInterval: 0.4)
        guard clickText(win, kb) else {
            fputs("Could not find knowledge base named \\(kb) in ima UI\\n", stderr)
            exit(1)
        }
        Thread.sleep(forTimeInterval: 1.0)
    }
}

let parts = requestedPath.split(separator: "/").map { normalize(String($0)) }.filter { !$0.isEmpty && $0 != "." }
for part in parts {
    guard clickText(win, part) else {
        fputs("Could not navigate to knowledge path part \\(part) in ima UI\\n", stderr)
        exit(1)
    }
    Thread.sleep(forTimeInterval: 0.8)
}

var texts: [String] = []
collectTexts(win, into: &texts)
let title = s(win, kAXTitleAttribute as String) ?? ""
jsonPrint([
    "status": "success",
    "knowledgeBase": kb.isEmpty ? inferKnowledgeBase(title: title, texts: texts) : kb,
    "path": requestedPath,
    "textCount": texts.count,
    "texts": texts
])
`;

const AX_ASK_SCRIPT = `${SWIFT_COMMON}
let args = CommandLine.arguments
guard args.count > 1 else {
    fputs("Missing question\\n", stderr)
    exit(1)
}
let question = args[1]
let kb = args.count > 2 ? normalize(args[2]) : ""
let timeout = args.count > 3 ? max(1, Int(args[3]) ?? 120) : 120

guard let (app, win) = focusedWindow() else {
    fputs("ima.copilot is not running or no accessible window was found\\n", stderr)
    exit(1)
}

if !AXIsProcessTrusted() {
    fputs("Accessibility permission is not granted for this terminal/OpenCLI process\\n", stderr)
    exit(1)
}

if !kb.isEmpty {
    _ = clickText(win, "知识库")
    Thread.sleep(forTimeInterval: 0.4)
    guard clickText(win, kb) else {
        fputs("Could not find knowledge base named \\(kb) in ima UI\\n", stderr)
        exit(1)
    }
    Thread.sleep(forTimeInterval: 1.0)
}

var beforeTexts: [String] = []
collectTexts(win, into: &beforeTexts)
let beforeJoined = beforeTexts.joined(separator: "\\n")
let beforeAnswer = answerAfterQuestion(beforeTexts, question: question)

guard let input = findComposer(win) else {
    fputs("Could not find ima question composer\\n", stderr)
    exit(1)
}

AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, true as CFTypeRef)
let setResult = AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, question as CFTypeRef)
guard setResult == .success else {
    fputs("Failed to set ima composer value\\n", stderr)
    exit(1)
}
Thread.sleep(forTimeInterval: 0.2)
pressReturn(pid: app.processIdentifier)

let start = Date()
var lastAnswer = ""
var stableSamples = 0
var finalTexts: [String] = []
var finalAnswer = ""

while Date().timeIntervalSince(start) < Double(timeout) {
    Thread.sleep(forTimeInterval: 1.0)
    var texts: [String] = []
    collectTexts(win, into: &texts)
    let joined = texts.joined(separator: "\\n")
    let answer = answerAfterQuestion(texts, question: question)
    let changed = joined != beforeJoined || answer != beforeAnswer

    if changed && !answer.isEmpty {
        if answer == lastAnswer {
            stableSamples += 1
        } else {
            lastAnswer = answer
            stableSamples = 1
        }
        if stableSamples >= 3 && !isGenerating(joined) {
            finalTexts = texts
            finalAnswer = answer
            break
        }
    }
}

if finalAnswer.isEmpty {
    fputs("No stable ima answer appeared before timeout\\n", stderr)
    exit(2)
}

let title = s(win, kAXTitleAttribute as String) ?? ""
let joined = finalTexts.joined(separator: "\\n")
jsonPrint([
    "status": "success",
    "knowledgeBase": kb.isEmpty ? inferKnowledgeBase(title: title, texts: finalTexts) : kb,
    "question": question,
    "answer": finalAnswer,
    "referencesFound": extractReferences(finalAnswer) ?? extractReferences(joined) as Any
])
`;

function parseKnowledgeListTexts(texts, { path = '' } = {}) {
  const normalized = texts.map(cleanText).filter(Boolean);
  const listTexts = sliceVisibleListTexts(normalized);
  const rows = [];

  for (let index = 0; index < listTexts.length; index += 1) {
    const splitMeta = parseSplitListMetadata(listTexts, index);
    if (splitMeta) {
      rows.push({
        name: listTexts[index],
        kind: splitMeta.kind,
        mediaType: splitMeta.mediaType,
        mediaId: '',
        folderId: '',
        updateTime: '',
        createTime: '',
        timeWording: splitMeta.timeWording,
        fileSize: '',
        path: joinKnowledgePath(path, listTexts[index]),
      });
      continue;
    }

    const meta = parseListMetadata(listTexts[index]);
    if (!meta) continue;
    const name = findPreviousListName(listTexts, index);
    if (!name) continue;
    rows.push({
      name,
      kind: meta.kind,
      mediaType: meta.mediaType,
      mediaId: '',
      folderId: '',
      updateTime: '',
      createTime: '',
      timeWording: meta.timeWording,
      fileSize: '',
      path: joinKnowledgePath(path, name),
    });
  }

  return dedupeRows(rows);
}

function sliceVisibleListTexts(texts) {
  const start = texts.findIndex((text) => /^内容\(\d+\)$/.test(text));
  if (start === -1) return texts;

  const stopTexts = ['没有更多内容了', '基于文件夹问答或创建任务', '基于知识库提问', '基于当前文件夹提问', '问答历史'];
  const end = texts.findIndex((text, index) => index > start && stopTexts.some((stop) => text.includes(stop)));
  return texts.slice(start + 1, end === -1 ? undefined : end);
}

function parseListMetadata(value) {
  const text = cleanText(value);
  const folder = text.match(/^(\d+)\s*项\s+(.+?更新)$/);
  if (folder) {
    return {
      kind: 'folder',
      mediaType: 'folder',
      timeWording: folder[2],
    };
  }

  const file = text.match(/^([A-Za-z0-9]+)\s+(\d{1,2}\/\d{1,2}(?:\s+\d{1,2}:\d{2})?)$/);
  if (file) {
    return {
      kind: 'file',
      mediaType: file[1].toUpperCase(),
      timeWording: file[2],
    };
  }

  return null;
}

function parseSplitListMetadata(texts, index) {
  const name = cleanText(texts[index]);
  const first = cleanText(texts[index + 1]);
  const second = cleanText(texts[index + 2]);
  const third = cleanText(texts[index + 3]);
  if (!name || shouldSkipListName(name) || parseListMetadata(name)) return null;

  if (/^\d+$/.test(first) && second === '项' && /^\d{1,2}\/\d{1,2}更新$/.test(third)) {
    return {
      kind: 'folder',
      mediaType: 'folder',
      timeWording: third,
    };
  }

  if (/^[A-Za-z0-9]{2,8}$/.test(first) && /^\d{1,2}\/\d{1,2}(?:\s+\d{1,2}:\d{2})?$/.test(second)) {
    return {
      kind: 'file',
      mediaType: first.toUpperCase(),
      timeWording: second,
    };
  }

  return null;
}

function findPreviousListName(texts, metadataIndex) {
  for (let index = metadataIndex - 1; index >= 0; index -= 1) {
    const text = cleanText(texts[index]);
    if (!text || shouldSkipListName(text) || parseListMetadata(text)) continue;
    return text;
  }
  return '';
}

function shouldSkipListName(text) {
  return /^内容\(\d+\)$/.test(text) ||
    text === '没有更多内容了' ||
    text.includes('基于文件夹问答') ||
    text.includes('基于知识库提问') ||
    text.includes('问答历史') ||
    text.includes('上传时间：') ||
    text.startsWith('AI摘要:');
}

function dedupeRows(rows) {
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const key = `${row.name}\n${row.kind}\n${row.timeWording}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKnowledgePath(value) {
  return String(value || '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.')
    .join('/');
}

function joinKnowledgePath(parent, name) {
  const cleanParent = normalizeKnowledgePath(parent);
  const cleanName = String(name || '').replace(/^\/+|\/+$/g, '');
  if (!cleanParent) return cleanName;
  if (!cleanName) return cleanParent;
  return `${cleanParent}/${cleanName}`;
}

export const __test__ = {
  BUNDLE_ID,
  DISPLAY_NAME,
  AX_STATUS_SCRIPT,
  AX_DUMP_SCRIPT,
  AX_ASK_SCRIPT,
  AX_LIST_SCRIPT,
  parseKnowledgeListTexts,
  parseListMetadata,
};
