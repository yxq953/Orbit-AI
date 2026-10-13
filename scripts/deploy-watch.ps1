param(
    [string]$Project = (Join-Path $PSScriptRoot '../examples/hello-world'),
    [string]$Serial,
    [ValidateSet('com.mi.health', 'com.xiaomi.wearable')]
    [string]$FitnessPackage = 'com.mi.health',
    [string]$LauncherDex = (Join-Path $PSScriptRoot '../tmp/launcher/dex/classes.dex'),
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'

function Invoke-Phone {
    param([string[]]$AdbArgs)
    # adb writes successful push progress to stderr; Windows PowerShell 5 treats
    # merged native stderr as terminating errors under ErrorActionPreference=Stop.
    $savedErrorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $result = @(& adb -s $script:Serial @AdbArgs 2>&1)
        $adbExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorPreference
    }
    if ($adbExit -ne 0) { throw "ADB failed: $result" }
    return $result
}

function Get-PhoneUi {
    $result = Invoke-Phone -AdbArgs @('shell', 'uiautomator dump /sdcard/hello-world-ui.xml >/dev/null; cat /sdcard/hello-world-ui.xml')
    $xmlText = ($result -join "`n")
    $start = $xmlText.IndexOf('<?xml')
    if ($start -lt 0) { throw "Cannot read phone UI: $xmlText" }
    return [xml]$xmlText.Substring($start)
}

function Tap-UiNode {
    param([xml]$Ui, [string]$ResourceId)
    $nodes = @($Ui.SelectNodes('//node') | Where-Object { $_.'resource-id' -eq $ResourceId })
    if ($nodes.Count -ne 1) { throw "Expected one visible UI element: $ResourceId" }
    if ($nodes[0].bounds -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') {
        throw "Invalid UI bounds: $ResourceId"
    }
    $x = [int](([int]$Matches[1] + [int]$Matches[3]) / 2)
    $y = [int](([int]$Matches[2] + [int]$Matches[4]) / 2)
    Invoke-Phone -AdbArgs @('shell', 'input', 'tap', "$x", "$y") | Out-Null
}

$Project = (Resolve-Path -LiteralPath $Project).Path
$manifest = Get-Content -LiteralPath (Join-Path $Project 'src/manifest.json') -Raw | ConvertFrom-Json
if ($manifest.package -notmatch '^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$') {
    throw 'Invalid app package name'
}
if (-not $Serial) {
    $devices = @(& adb devices | Where-Object { $_ -match '^\S+\s+device$' })
    if ($devices.Count -ne 1) { throw 'Connect one phone, or specify -Serial explicitly.' }
    $script:Serial = ($devices[0] -split '\s+')[0]
}
Invoke-Phone -AdbArgs @('get-state') | Out-Null
if (-not (Test-Path -LiteralPath $LauncherDex -PathType Leaf)) {
    throw "Launcher DEX missing: $LauncherDex. See examples/hello-world/README.md."
}
$apkLines = @(Invoke-Phone -AdbArgs @('shell', 'pm', 'path', $FitnessPackage))
$baseApk = @($apkLines | Where-Object { $_ -match '^package:.*/base\.apk$' })
if ($baseApk.Count -ne 1) { throw "Cannot find $FitnessPackage base APK" }
$apkPath = $baseApk[0].Substring(8).Trim()
if (-not $NoBuild) {
    Push-Location $Project
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'RPK build failed' }
    } finally { Pop-Location }
}
$rpkName = '{0}.debug.{1}.rpk' -f $manifest.package, $manifest.versionName
$rpkPath = Join-Path $Project "dist/$rpkName"
if (-not (Test-Path -LiteralPath $rpkPath -PathType Leaf)) { throw "RPK missing: $rpkPath" }
$remoteRpk = '/sdcard/Download/RedmiWatch/' + $manifest.package + '.rpk'
$remoteDex = '/data/local/tmp/redmi-hello-launch.dex'
Invoke-Phone -AdbArgs @('shell', 'mkdir -p /sdcard/Download/RedmiWatch') | Out-Null
Invoke-Phone -AdbArgs @('push', $rpkPath, $remoteRpk) | Write-Host
Invoke-Phone -AdbArgs @('push', $LauncherDex, $remoteDex) | Write-Host
$launch = Invoke-Phone -AdbArgs @('shell', "CLASSPATH=$remoteDex app_process / LaunchFragment $apkPath $FitnessPackage")
if (($launch -join "`n") -notmatch 'SUCCESS:') { throw "Cannot launch install page: $launch" }

Tap-UiNode (Get-PhoneUi) "${FitnessPackage}:id/inputPackageName"
$dialogUi = Get-PhoneUi
Tap-UiNode $dialogUi "${FitnessPackage}:id/pkgNameView"
Invoke-Phone -AdbArgs @('shell', 'input', 'text', $manifest.package) | Out-Null
Invoke-Phone -AdbArgs @('shell', 'input', 'keyevent', '4') | Out-Null
$dialogUi = Get-PhoneUi
$inputNode = $dialogUi.SelectNodes('//node') | Where-Object { $_.'resource-id' -eq "${FitnessPackage}:id/pkgNameView" }
if ($inputNode.text -ne $manifest.package) { throw 'Package entry differs from manifest; correct it on the phone.' }
Tap-UiNode $dialogUi 'android:id/button1'
$installUi = Get-PhoneUi
$shownPackage = $installUi.SelectNodes('//node') | Where-Object { $_.'resource-id' -eq "${FitnessPackage}:id/showPackageName" }
if ($shownPackage.text -ne $manifest.package) { throw 'Unexpected package name on install page.' }
Tap-UiNode $installUi "${FitnessPackage}:id/installThirdApp"
Write-Host "Select Download/RedmiWatch/$($manifest.package).rpk on the phone."
Write-Host 'Then check the installation status and the app list on the watch.'
Write-Host 'Opening the file picker does not confirm that installation succeeded.'
