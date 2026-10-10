param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$failurePattern = 'process didn''t exit successfully: `([^`]+\.exe)` \(exit code: 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND\)'
$dllPattern = '^\s+([A-Za-z0-9_.-]+\.dll)\s*$'
if ($SelfTest) {
    $fixture = 'process didn''t exit successfully: `D:\a\rimeward\rimeward\desktop\target\debug\deps\rimeward_lib-test.exe` (exit code: 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND)'
    $matches = [regex]::Matches($fixture, $failurePattern)
    if ($matches.Count -ne 1 -or $matches[0].Groups[1].Value -ne 'D:\a\rimeward\rimeward\desktop\target\debug\deps\rimeward_lib-test.exe') { throw 'Loader path fixture failed' }
    if ([regex]::IsMatch($fixture.Replace('0xc0000139', '0xc0000005'), $failurePattern)) { throw 'Wrong exit code accepted' }
    foreach ($dll in @('    ntdll.dll', '    api-ms-win-core-libraryloader-l1-2-0.dll')) {
        if (-not [regex]::IsMatch($dll, $dllPattern)) { throw 'Valid DLL rejected' }
    }
    foreach ($other in @('    RtlGetVersion', '    ..\outside.dll', '    C:\outside.dll')) {
        if ([regex]::IsMatch($other, $dllPattern)) { throw 'Non-DLL import accepted' }
    }
    Write-Output 'Windows loader diagnostic self-check passed.'
    exit 0
}
$out = Join-Path $env:RUNNER_TEMP 'rimeward-windows-loader'
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item desktop-native-check.log $out
"COMMIT=$env:GITHUB_SHA IMAGE=$env:ImageOS VERSION=$env:ImageVersion OS=$([Environment]::OSVersion.Version)" |
    Set-Content (Join-Path $out 'runner.txt')
$nativeLog = Get-Content desktop-native-check.log -Raw
if ($nativeLog -notmatch 'STATUS_ENTRYPOINT_NOT_FOUND') { exit 0 }
$failures = [regex]::Matches($nativeLog, $failurePattern)
if ($failures.Count -ne 1) { throw 'Expected one exact Windows loader failure path' }
$exe = (Resolve-Path -LiteralPath $failures[0].Groups[1].Value).Path
$deps = (Resolve-Path desktop/target/debug/deps).Path + [IO.Path]::DirectorySeparatorChar
if (-not $exe.StartsWith($deps, [StringComparison]::OrdinalIgnoreCase)) { throw 'Failed executable is outside native test deps' }
Get-FileHash -Algorithm SHA256 -LiteralPath $exe | Format-List | Out-File (Join-Path $out 'test-executable.txt')
Copy-Item -LiteralPath $exe -Destination (Join-Path $out 'failed-native-test.exe')
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$dumpbin = @(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC/Tools/MSVC/**/bin/Hostx64/x64/dumpbin.exe') | Select-Object -First 1
if (-not $dumpbin -or -not (Test-Path -LiteralPath $dumpbin)) { throw 'Installed x64 dumpbin is unavailable' }
$imports = @(& $dumpbin /nologo /imports $exe)
if ($LASTEXITCODE -ne 0) { throw 'dumpbin imports failed' }
$imports | Set-Content (Join-Path $out 'imports.txt')
& $dumpbin /nologo /dependents $exe | Set-Content (Join-Path $out 'dependents.txt')
if ($LASTEXITCODE -ne 0) { throw 'dumpbin dependents failed' }
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RimewardLoaderDiagnostic {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  public static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  public static extern uint GetModuleFileNameW(IntPtr module, StringBuilder file, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool FreeLibrary(IntPtr module);
}
'@
$dlls = @($imports | ForEach-Object { if ($_ -match $dllPattern) { $Matches[1] } } | Sort-Object -Unique)
if ($dlls.Count -eq 0) { throw 'No imported DLLs found' }
'Paths below describe this System32-only diagnostic process, not the failed executable loader search.' |
    Set-Content (Join-Path $out 'modules.txt')
foreach ($dll in $dlls) {
    # Restrict diagnostic loads to system libraries; never load test-directory DLLs.
    $module = [RimewardLoaderDiagnostic]::LoadLibraryExW($dll, [IntPtr]::Zero, 0x800)
    $loadError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($module -eq [IntPtr]::Zero) {
        "DLL=$dll SYSTEM32_LOAD_ERROR=$loadError" | Add-Content (Join-Path $out 'modules.txt')
        $path = Join-Path ([Environment]::SystemDirectory) $dll
        if (-not (Test-Path -LiteralPath $path)) { continue }
    } else {
        try {
            $buffer = [Text.StringBuilder]::new(32768)
            $length = [RimewardLoaderDiagnostic]::GetModuleFileNameW($module, $buffer, 32768)
            if ($length -eq 0 -or $length -ge 32768) { throw "Module path unavailable: $dll" }
            $path = $buffer.ToString()
        } finally { [void][RimewardLoaderDiagnostic]::FreeLibrary($module) }
    }
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
    "DLL=$dll PATH=$path VERSION=$version SHA256=$hash" | Add-Content (Join-Path $out 'modules.txt')
    & $dumpbin /nologo /exports $path | Set-Content (Join-Path $out ($dll + '.exports.txt'))
    if ($LASTEXITCODE -ne 0) { throw "dumpbin exports failed: $dll" }
}
