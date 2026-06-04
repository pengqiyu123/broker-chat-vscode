import { execFile } from "child_process";
import { promisify } from "util";
import {
  FocusElementSnapshot,
  FocusIdentification,
  FocusProbeResult,
  FocusIdentifiedAgent
} from "../types";

const execFileAsync = promisify(execFile);

export async function identifyFocusedElement(): Promise<FocusIdentification> {
  return identifyFocusProbe(await runFocusProbe());
}

export async function runFocusProbe(): Promise<FocusProbeResult> {
  if (process.platform !== "win32") {
    return {
      parentChain: [],
      timestamp: Date.now()
    };
  }

  const script = [
    "Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue",
    "function Convert-BrokerFocusElement($element) {",
    "  if ($null -eq $element) { return $null }",
    "  $current = $element.Current",
    "  [PSCustomObject]@{",
    "    name = $current.Name",
    "    className = $current.ClassName",
    "    automationId = $current.AutomationId",
    "    controlType = $current.ControlType.ProgrammaticName",
    "    frameworkId = $current.FrameworkId",
    "    processId = [int]$current.ProcessId",
    "  }",
    "}",
    "$focused = [System.Windows.Automation.AutomationElement]::FocusedElement",
    "$items = @()",
    "$currentElement = $focused",
    "$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker",
    "for ($index = 0; $null -ne $currentElement -and $index -lt 16; $index++) {",
    "  $items += Convert-BrokerFocusElement $currentElement",
    "  $currentElement = $walker.GetParent($currentElement)",
    "}",
    "$json = [PSCustomObject]@{ currentElement = if ($items.Count -gt 0) { $items[0] } else { $null }; parentChain = $items; timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Depth 6 -Compress",
    "$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)",
    "[Convert]::ToBase64String($bytes)"
  ].join("\n");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }
  );

  const json = Buffer.from(stdout.trim(), "base64").toString("utf8");
  const parsed = JSON.parse(json) as {
    currentElement?: Partial<FocusElementSnapshot> | null;
    parentChain?: Array<Partial<FocusElementSnapshot>>;
    timestamp?: number;
  };

  return {
    currentElement: parsed.currentElement ? normalizeElement(parsed.currentElement) : undefined,
    parentChain: Array.isArray(parsed.parentChain) ? parsed.parentChain.map(normalizeElement) : [],
    timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now()
  };
}

export function identifyFocusProbe(probe: FocusProbeResult): FocusIdentification {
  const current = probe.currentElement;
  const parentChain = probe.parentChain || [];
  const currentClass = current?.className ?? "";
  const currentName = current?.name ?? "";
  const currentType = current?.controlType ?? "";
  const chainText = parentChain.map(elementText).join(" ").toLowerCase();

  let identifiedAgent: FocusIdentifiedAgent = "unknown";
  let rule = "未命中已知焦点特征。";

  if (!current) {
    rule = "没有 UIAutomation 当前元素。";
  } else if (chainText.includes("claudestatusdetector") || chainText.includes("状态检测器")) {
    identifiedAgent = "detector";
    rule = "父级链路包含检测器名称。";
  } else if (isClaudeInput(current)) {
    identifiedAgent = "claude";
    rule = "当前元素是 Message input + messageInput_* + ControlType.Edit。";
  } else if (isCodexInput(current, parentChain)) {
    identifiedAgent = "codex";
    rule = "当前元素包含 ProseMirror-focused，父级链路包含 Codex RootWebArea/active-frame。";
  } else if (currentClass.includes("ProseMirror")) {
    rule = "当前元素包含 ProseMirror，但未找到 Codex 父级标识。";
  } else if (currentName === "Message input" || currentClass.startsWith("messageInput_")) {
    rule = "当前元素像消息输入框，但不满足完整 ClaudeCode 特征。";
  }

  return {
    ...probe,
    identifiedAgent,
    rule,
    currentSummary: summarizeElement(current),
    chainSummary: summarizeChain(parentChain)
  };
}

function isClaudeInput(element: FocusElementSnapshot): boolean {
  return (
    element.name === "Message input" &&
    element.className.startsWith("messageInput_") &&
    element.controlType === "ControlType.Edit"
  );
}

function isCodexInput(current: FocusElementSnapshot, parentChain: FocusElementSnapshot[]): boolean {
  return (
    current.className.includes("ProseMirror-focused") &&
    parentChain.some(
      (entry) =>
        entry.name === "Codex" &&
        (entry.automationId === "RootWebArea" || entry.automationId === "active-frame")
    )
  );
}

function normalizeElement(element: Partial<FocusElementSnapshot>): FocusElementSnapshot {
  return {
    name: String(element.name ?? ""),
    className: String(element.className ?? ""),
    automationId: String(element.automationId ?? ""),
    controlType: String(element.controlType ?? ""),
    frameworkId: String(element.frameworkId ?? ""),
    processId: Number.isFinite(Number(element.processId)) ? Number(element.processId) : 0
  };
}

function elementText(element: FocusElementSnapshot): string {
  return [
    element.name,
    element.className,
    element.automationId,
    element.controlType,
    element.frameworkId
  ]
    .filter(Boolean)
    .join(" ");
}

function summarizeElement(element: FocusElementSnapshot | undefined): string {
  if (!element) {
    return "none";
  }

  return [
    `type=${element.controlType || "none"}`,
    `name=${summarizeValue(element.name)}`,
    `class=${summarizeValue(element.className)}`,
    `id=${summarizeValue(element.automationId)}`,
    `pid=${element.processId || "none"}`
  ].join(", ");
}

function summarizeChain(parentChain: FocusElementSnapshot[]): string {
  return parentChain
    .slice(0, 8)
    .map(
      (entry, index) =>
        `${index}:${entry.controlType || "none"}:${summarizeValue(entry.name)}:${summarizeValue(entry.className)}:${summarizeValue(entry.automationId)}`
    )
    .join(" -> ");
}

function summarizeValue(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "none";
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}
