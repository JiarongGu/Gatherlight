// Gatherlight launcher — a tiny native C++ bootstrapper that IS the top-level Gatherlight.exe the
// user runs. It carries the app icon, resolves the install root, points the app at the bundle's
// data/ folder (auto-seeding memory if a bundle was dropped in), and launches the desktop host in
// libs/. The host is published SELF-CONTAINED (bundles the .NET runtime), so — unlike a
// framework-dependent app — there is no runtime check/install to do here. Modeled on the
// D3dxSkinManager launcher, trimmed to what a self-contained bundle needs.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlwapi.h>
#include <string>
#include "updater.h"

#pragma comment(lib, "shlwapi.lib")

// The self-contained desktop host lives in libs/ (with data/ + res/ as siblings of libs/ at the
// install root — the layout the host's path resolver expects).
constexpr auto HOST_EXE = L"libs\\Gatherlight.Host.exe";

// Directory the launcher exe lives in = the install root.
static std::wstring LauncherDir()
{
    wchar_t path[MAX_PATH];
    GetModuleFileNameW(nullptr, path, MAX_PATH);
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
