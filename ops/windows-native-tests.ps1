param([string]$ArtifactsPath = 'windows-native-artifacts.jsonl', [switch]$SelfTest)
$ErrorActionPreference = 'Stop'

function Get-NativeArtifacts([object[]]$Messages, [string]$PackageManifest) {
    $root = @($Messages | Where-Object {
        $_.reason -eq 'compiler-artifact' -and $_.manifest_path -and
        [IO.Path]::GetFullPath($_.manifest_path) -eq [IO.Path]::GetFullPath($PackageManifest)
    })
    $unit = @($root | Where-Object { $_.target.name -eq 'rimeward_lib' -and $_.target.kind -contains 'rlib' -and $_.profile.test -eq $true })
    $app = @($root | Where-Object { $_.target.name -eq 'rimeward' -and $_.target.kind -contains 'bin' -and $_.profile.test -eq $false })
    if ($unit.Count -ne 1 -or $app.Count -ne 1) { throw 'Expected one root library unit test and one normal Tauri app artifact' }
    if (-not $unit[0].package_id -or $unit[0].package_id -ne $app[0].package_id) { throw 'Native artifacts have different package identities' }
    foreach ($artifact in @($unit[0], $app[0])) {
        if (-not $artifact.executable -or -not [IO.Path]::IsPathRooted($artifact.executable) -or
            [IO.Path]::GetExtension($artifact.executable) -ne '.exe' -or
            $artifact.filenames -notcontains $artifact.executable -or
            -not (Test-Path -LiteralPath $artifact.executable -PathType Leaf)) { throw 'Native executable is missing or not the reported Cargo artifact' }
    }
    $testExe = (Resolve-Path -LiteralPath $unit[0].executable).Path
    $appExe = (Resolve-Path -LiteralPath $app[0].executable).Path
    if ($testExe -eq $appExe) { throw 'Native test and app must be different executables' }
    return @{ Test = $testExe; App = $appExe }
}

function Install-NativeManifest([string]$Source, [string]$TestExe) {
    $file = Get-Item -LiteralPath $Source
    if ($file.Length -eq 0 -or $file.Length -gt 65536) { throw 'Native manifest must be between 1 and 65536 bytes' }
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create($file.FullName, $settings)
    $xml = [Xml.XmlDocument]::new()
    try { $xml.Load($reader) } finally { $reader.Dispose() }
    $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
    $ns.AddNamespace('asm', 'urn:schemas-microsoft-com:asm.v1')
    $controls = @($xml.SelectNodes('/asm:assembly/asm:dependency/asm:dependentAssembly/asm:assemblyIdentity[@name="Microsoft.Windows.Common-Controls"]', $ns))
    if ($xml.DocumentElement.GetAttribute('manifestVersion') -ne '1.0' -or
        $controls.Count -ne 1 -or $controls[0].version -ne '6.0.0.0' -or
        $controls[0].type -ne 'win32' -or $controls[0].publicKeyToken -ne '6595b64144ccf1df') { throw 'Tauri manifest must declare Common Controls v6' }
    Copy-Item -LiteralPath $file.FullName -Destination ($TestExe + '.manifest')
}

if ($SelfTest) {
    $fixtureDir = Join-Path ([IO.Path]::GetTempPath()) ('rimeward-native-manifest-' + [Guid]::NewGuid())
    New-Item -ItemType Directory $fixtureDir | Out-Null
    try {
        $package = Join-Path $fixtureDir 'Cargo.toml'
        $unitExe = Join-Path $fixtureDir 'rimeward_lib-fixture.exe'
        $appExe = Join-Path $fixtureDir 'rimeward.exe'
        foreach ($path in @($package, $unitExe, $appExe)) { [IO.File]::WriteAllText($path, 'fixture') }
        $unit = @{ reason = 'compiler-artifact'; manifest_path = $package; package_id = 'fixture'; target = @{ name = 'rimeward_lib'; kind = @('staticlib', 'cdylib', 'rlib') }; profile = @{ test = $true }; executable = $unitExe; filenames = @($unitExe) }
        $app = @{ reason = 'compiler-artifact'; manifest_path = $package; package_id = 'fixture'; target = @{ name = 'rimeward'; kind = @('bin') }; profile = @{ test = $false }; executable = $appExe; filenames = @($appExe) }
        $unit = $unit | ConvertTo-Json -Depth 4 | ConvertFrom-Json
        $app = $app | ConvertTo-Json -Depth 4 | ConvertFrom-Json
        $paths = Get-NativeArtifacts @($unit, $app) $package
        if ($paths.Test -ne $unitExe -or $paths.App -ne $appExe) { throw 'Exact artifact selection failed' }
        foreach ($bad in @(@($unit, $unit, $app), @($unit), @($app))) {
            $rejected = $false
            try { Get-NativeArtifacts $bad $package | Out-Null } catch { $rejected = $true }
            if (-not $rejected) { throw 'Ambiguous or incomplete native artifacts accepted' }
        }
        $app.package_id = 'other-package'
        $rejected = $false
        try { Get-NativeArtifacts @($unit, $app) $package | Out-Null } catch { $rejected = $true }
        if (-not $rejected) { throw 'Different package identity accepted' }
        $app.package_id = 'fixture'
        $unit.filenames = @($appExe)
        $rejected = $false
        try { Get-NativeArtifacts @($unit, $app) $package | Out-Null } catch { $rejected = $true }
        if (-not $rejected) { throw 'Unreported executable path accepted' }
        $unit.filenames = @($unitExe)
        Remove-Item -LiteralPath $unitExe
        $rejected = $false
        try { Get-NativeArtifacts @($unit, $app) $package | Out-Null } catch { $rejected = $true }
        if (-not $rejected) { throw 'Missing executable accepted' }
        [IO.File]::WriteAllText($unitExe, 'fixture')
        $manifest = Join-Path $fixtureDir 'app.manifest'
        $v6 = '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" publicKeyToken="6595b64144ccf1df" processorArchitecture="*" language="*"/></dependentAssembly></dependency></assembly>'
        [IO.File]::WriteAllText($manifest, $v6)
        Install-NativeManifest $manifest $unitExe
        if ((Get-FileHash -LiteralPath ($unitExe + '.manifest')).Hash -ne (Get-FileHash -LiteralPath $manifest).Hash -or
            (Test-Path -LiteralPath ($appExe + '.manifest'))) { throw 'Exact unit sidecar copy failed' }
        foreach ($bad in @($v6.Replace('6.0.0.0', '5.82.0.0'), ('x' * 65537), '<!DOCTYPE assembly><assembly/>')) {
            [IO.File]::WriteAllText($manifest, $bad)
            $rejected = $false
            try { Install-NativeManifest $manifest $unitExe } catch { $rejected = $true }
            if (-not $rejected -or [IO.File]::ReadAllText($unitExe + '.manifest') -ne $v6) { throw 'Invalid manifest accepted or replaced the valid sidecar' }
        }
        Write-Output 'Windows native manifest self-check passed.'
    } finally { Remove-Item -LiteralPath $fixtureDir -Recurse -Force }
    exit 0
}

$messages = @(Get-Content -LiteralPath $ArtifactsPath | ForEach-Object { $_ | ConvertFrom-Json })
$finished = @($messages | Where-Object { $_.reason -eq 'build-finished' })
if ($finished.Count -ne 1 -or $finished[0].success -ne $true) { throw 'Native test preparation build did not finish successfully' }
$package = Join-Path $PSScriptRoot '../desktop/Cargo.toml'
$paths = Get-NativeArtifacts $messages $package
$sdk = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots').KitsRoot10
$versions = @(Get-ChildItem -LiteralPath (Join-Path $sdk 'bin') -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'x64/mt.exe') -PathType Leaf) } |
    Sort-Object { [Version]$_.Name } -Descending)
if ($versions.Count -eq 0) { throw 'Installed Windows SDK x64 mt.exe is unavailable' }
$mt = Join-Path $versions[0].FullName 'x64/mt.exe'
$extracted = $paths.Test + '.' + [Guid]::NewGuid() + '.manifest'
try {
    & $mt -nologo "-inputresource:$($paths.App);#1" "-out:$extracted"
    if ($LASTEXITCODE -ne 0) { throw "Tauri manifest extraction failed with exit $LASTEXITCODE" }
    Install-NativeManifest $extracted $paths.Test
    Write-Output "Prepared native unit manifest: $($paths.Test).manifest"
} finally {
    if (Test-Path -LiteralPath $extracted) { Remove-Item -LiteralPath $extracted }
}
