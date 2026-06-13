import { execFileSync } from 'node:child_process';

const UIA_TIMEOUT_MS = 4000;
const UIA_BUFFER = 2 * 1024 * 1024;

export function inspectImaWindowsUiAutomation({ processPattern = '', timeoutMs = UIA_TIMEOUT_MS } = {}) {
  try {
    const raw = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      UIA_STATUS_SCRIPT,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OPENCLI_IMA_PROCESS_PATTERN: processPattern,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: UIA_BUFFER,
      windowsHide: true,
    }).trim();
    return raw ? JSON.parse(raw) : baseStatus({ error: 'Windows UI Automation returned no output.' });
  } catch (error) {
    return baseStatus({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function baseStatus(extra = {}) {
  return {
    running: false,
    trusted: true,
    title: '',
    knowledgeBase: '',
    composerReady: false,
    texts: [],
    automationAvailable: false,
    processCount: 0,
    windowCount: 0,
    candidateInputCount: 0,
    ...extra,
  };
}

const UIA_STATUS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$processPattern = [string]$env:OPENCLI_IMA_PROCESS_PATTERN
$imageName = [IO.Path]::GetFileNameWithoutExtension($processPattern)
if ([string]::IsNullOrWhiteSpace($imageName)) {
  $imageName = 'ima.copilot'
}

$result = [ordered]@{
  running = $false
  trusted = $true
  title = ''
  knowledgeBase = ''
  composerReady = $false
  texts = @()
  automationAvailable = $false
  processCount = 0
  windowCount = 0
  candidateInputCount = 0
  error = ''
}

$processes = @(Get-Process -Name $imageName -ErrorAction SilentlyContinue)
if ($processes.Count -eq 0 -and $imageName -ne 'ima.copilot') {
  $processes = @(Get-Process -Name 'ima.copilot' -ErrorAction SilentlyContinue)
}

$result.processCount = $processes.Count
$result.running = $processes.Count -gt 0

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $result.automationAvailable = $true
} catch {
  $result.error = 'Windows UI Automation assemblies are unavailable.'
  $result | ConvertTo-Json -Compress
  exit 0
}

$root = [Windows.Automation.AutomationElement]::RootElement
foreach ($process in $processes) {
  $condition = New-Object Windows.Automation.PropertyCondition(
    [Windows.Automation.AutomationElement]::ProcessIdProperty,
    $process.Id
  )
  $windows = $root.FindAll([Windows.Automation.TreeScope]::Children, $condition)
  $result.windowCount += $windows.Count

  foreach ($window in $windows) {
    $editCondition = New-Object Windows.Automation.PropertyCondition(
      [Windows.Automation.AutomationElement]::ControlTypeProperty,
      [Windows.Automation.ControlType]::Edit
    )
    $edits = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $editCondition)
    $result.candidateInputCount += $edits.Count

    foreach ($edit in $edits) {
      $name = [string]$edit.Current.Name
      $helpText = [string]$edit.Current.HelpText
      if ($name -match '提问|知识库|message|ask|question' -or $helpText -match '提问|知识库|message|ask|question') {
        $result.composerReady = $true
      }
    }
  }
}

$result | ConvertTo-Json -Compress
`;

export const __test__ = {
  UIA_STATUS_SCRIPT,
};
