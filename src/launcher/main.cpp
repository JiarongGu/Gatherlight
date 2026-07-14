// Gatherlight launcher — a tiny native C++ bootstrapper that IS the top-level Gatherlight.exe the
// user runs. It carries the app icon, resolves the install root, applies any staged update, ensures
// the .NET 10 runtime is present (the host is FRAMEWORK-DEPENDENT — small bundle + small updates),
// points the app at the bundle's data/ folder (auto-seeding memory if a bundle was dropped in), and
// launches the desktop host in libs/. Modeled on the D3dxSkinManager launcher.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlwapi.h>
#include <string>
#include "updater.h"
#include "dotnet_runtime.h"

#pragma comment(lib, "shlwapi.lib")

// The self-contained desktop host lives in libs/ (with data/ + res/ as siblings of libs/ at the
// install root — the layout the host's path resolver expects).
constexpr auto HOST_EXE = L"libs\\Gatherlight.Host.exe";

// Directory the launcher exe lives in = the install root. Long-path-safe buffer: installDir is
// derived from this and used to build every other path, so truncation here would break the whole
// launch/update on a deep install path (>260 chars).
static std::wstring LauncherDir()
{
    wchar_t path[32768];
    GetModuleFileNameW(nullptr, path, ARRAYSIZE(path));
    PathRemoveFileSpecW(path);
    return std::wstring(path);
}

int WINAPI wWinMain(
    _In_ HINSTANCE hInstance,
    _In_opt_ HINSTANCE hPrevInstance,
    _In_ LPWSTR lpCmdLine,
    _In_ int nShowCmd)
{
    UNREFERENCED_PARAMETER(hInstance);
    UNREFERENCED_PARAMETER(hPrevInstance);
    UNREFERENCED_PARAMETER(nShowCmd);

    const std::wstring root = LauncherDir();
    const std::wstring hostPath = root + L"\\" + HOST_EXE;

    // Test/diagnostic seam: apply any staged update against this dir and exit WITHOUT launching the
    // host (no MessageBox on the happy path). Lets a harness exercise the real apply on a sandbox
    // install (devtools/scripts/e2e-p19). Not used in normal launches.
    if (lpCmdLine != nullptr && wcsstr(lpCmdLine, L"--apply-and-exit") != nullptr)
    {
        ApplyPendingUpdate(root);
        return 0;
    }

    // Apply a pending update the host already downloaded + staged (before launching it). No-op if
    // nothing is staged; the launcher never checks GitHub itself (the host does).
    ApplyPendingUpdate(root);

    if (!PathFileExistsW(hostPath.c_str()))
    {
        std::wstring msg = L"Gatherlight application not found:\n" + hostPath +
            L"\n\nThe install looks incomplete — re-extract the bundle.";
        MessageBoxW(nullptr, msg.c_str(), L"Gatherlight", MB_OK | MB_ICONERROR);
        return 1;
    }

    // Ensure the .NET 10 shared runtimes the framework-dependent host needs are installed (one-time,
    // with a UAC prompt). Best-effort: if it reports failure we still try to launch — the host's own
    // apphost shows a clearer "runtime not found" dialog + download link if it's genuinely missing.
    if (!EnsureDotNetRuntime())
    {
        MessageBoxW(nullptr,
            L"The .NET 10 runtime could not be installed automatically.\n\n"
            L"If Gatherlight does not start, install the .NET 10 Desktop Runtime and ASP.NET Core "
            L"Runtime (x64) from https://dotnet.microsoft.com/download/dotnet/10.0 and try again.",
            L"Gatherlight", MB_OK | MB_ICONWARNING);
    }

    // Point the app at the bundle's data/ folder (mirrors the old Gatherlight.cmd) and auto-seed
    // memory if an exported bundle was dropped next to the launcher. The child inherits these.
    const std::wstring dataDir = root + L"\\data";
    SetEnvironmentVariableW(L"GATHERLIGHT_DATA", dataDir.c_str());
    const std::wstring seed = root + L"\\seed-memory.json";
    if (PathFileExistsW(seed.c_str()))
        SetEnvironmentVariableW(L"GATHERLIGHT_SEED_MEMORY", seed.c_str());

    // Child command line: "host" [forwarded args].
    std::wstring cmd = L"\"" + hostPath + L"\"";
    if (lpCmdLine != nullptr && *lpCmdLine != L'\0')
    {
        cmd += L" ";
        cmd += lpCmdLine;
    }

    STARTUPINFOW si = { sizeof(STARTUPINFOW) };
    PROCESS_INFORMATION pi = {};

    // cwd = install root so any relative path the app touches lands in the bundle, not libs/.
    if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, 0, nullptr, root.c_str(), &si, &pi))
    {
        const DWORD err = GetLastError();
        wchar_t buf[512];
        swprintf_s(buf, L"Failed to launch Gatherlight.\n\n%s\n\nError code: %lu", hostPath.c_str(), err);
        MessageBoxW(nullptr, buf, L"Gatherlight", MB_OK | MB_ICONERROR);
        return 1;
    }

    // Let the host run on its own; the launcher's job is done.
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}
