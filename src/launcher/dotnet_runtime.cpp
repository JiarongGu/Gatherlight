// .NET runtime bootstrap. The host (Gatherlight.Host.exe) is published FRAMEWORK-DEPENDENT — it needs
// two shared frameworks present on the machine: Microsoft.WindowsDesktop.App (WinForms UI) and
// Microsoft.AspNetCore.App (the in-process Kestrel server), both .NET 10. On a machine that has
// neither, we download + run Microsoft's official runtime installers once (a one-time UAC prompt).
// This keeps the shipped bundle small (~20 MB app instead of ~110 MB with a bundled runtime) and,
// more importantly, keeps AUTO-UPDATES small — the runtime installs once and survives every update.
#include "dotnet_runtime.h"
#include <windows.h>
#include <urlmon.h>
#include <shlwapi.h>
#include <string>

#pragma comment(lib, "urlmon.lib")
#pragma comment(lib, "shlwapi.lib")

namespace {

// aka.ms redirectors to the latest .NET 10 runtime installers (x64). The Windows Desktop installer
// carries Microsoft.NETCore.App + Microsoft.WindowsDesktop.App; the ASP.NET Core installer carries
// Microsoft.NETCore.App + Microsoft.AspNetCore.App — together they cover all three the host needs.
constexpr auto kDesktopUrl = L"https://aka.ms/dotnet/10.0/windowsdesktop-runtime-win-x64.exe";
constexpr auto kAspNetUrl = L"https://aka.ms/dotnet/10.0/aspnetcore-runtime-win-x64.exe";

// Run `dotnet --list-runtimes` and return its stdout (empty if dotnet isn't installed at all).
std::string ListRuntimes()
{
    SECURITY_ATTRIBUTES sa = { sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE };
    HANDLE readPipe = nullptr, writePipe = nullptr;
    if (!CreatePipe(&readPipe, &writePipe, &sa, 0)) return {};
    SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW si = { sizeof(STARTUPINFOW) };
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.hStdOutput = writePipe;
    si.hStdError = writePipe;
    si.wShowWindow = SW_HIDE;

    wchar_t cmd[] = L"dotnet --list-runtimes";
    PROCESS_INFORMATION pi = {};
    if (!CreateProcessW(nullptr, cmd, nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi))
    {
        CloseHandle(readPipe);
        CloseHandle(writePipe);
        return {}; // dotnet not found → treat as nothing installed
    }
    CloseHandle(writePipe); // so ReadFile ends at EOF when the child exits

    std::string out;
    char buf[4096];
    DWORD n = 0;
    while (ReadFile(readPipe, buf, sizeof(buf), &n, nullptr) && n > 0)
        out.append(buf, n);

    CloseHandle(readPipe);
    WaitForSingleObject(pi.hProcess, INFINITE);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return out;
}

// True if `list` shows a 10.x of the given shared framework (roll-forward makes any 10.x acceptable).
bool HasFramework(const std::string& list, const char* framework)
{
    return list.find(std::string(framework) + " 10.") != std::string::npos;
}

HWND ShowStatus(const wchar_t* text)
{
    return CreateWindowW(L"STATIC", text, WS_VISIBLE | WS_POPUP | SS_CENTER,
                         (GetSystemMetrics(SM_CXSCREEN) - 460) / 2,
                         (GetSystemMetrics(SM_CYSCREEN) - 110) / 2,
                         460, 110, nullptr, nullptr, GetModuleHandle(nullptr), nullptr);
}

// Download an installer to %TEMP% and run it silently. The installer's own manifest requests
// elevation, so Windows shows the UAC prompt. Returns true on success (0) or reboot-required (3010).
bool DownloadAndInstall(const wchar_t* url, const wchar_t* filename)
{
    wchar_t tempPath[MAX_PATH];
    if (GetTempPathW(MAX_PATH, tempPath) == 0) return false;
    std::wstring path = std::wstring(tempPath) + filename;

    if (FAILED(URLDownloadToFileW(nullptr, url, path.c_str(), 0, nullptr))) return false;

    std::wstring cmd = L"\"" + path + L"\" /install /quiet /norestart";
    STARTUPINFOW si = { sizeof(STARTUPINFOW) };
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_SHOW;
    PROCESS_INFORMATION pi = {};
    std::wstring mutableCmd = cmd;
    if (!CreateProcessW(nullptr, &mutableCmd[0], nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi))
    {
        DeleteFileW(path.c_str());
        return false;
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    DeleteFileW(path.c_str());
    return code == 0 || code == 3010; // 3010 = success, reboot required (runtime is usable now)
}

} // namespace

bool EnsureDotNetRuntime()
{
    auto list = ListRuntimes();
    bool desktop = HasFramework(list, "Microsoft.WindowsDesktop.App");
    bool aspnet = HasFramework(list, "Microsoft.AspNetCore.App");
    if (desktop && aspnet) return true;

    HWND status = ShowStatus(L"Setting up the .NET 10 runtime (one-time)…\n\n"
                             L"This may take a few minutes and needs administrator approval.");

    if (!desktop) DownloadAndInstall(kDesktopUrl, L"gatherlight-windowsdesktop-runtime.exe");
    if (!aspnet)  DownloadAndInstall(kAspNetUrl, L"gatherlight-aspnetcore-runtime.exe");

    if (status) DestroyWindow(status);

    // Re-check against a fresh dotnet process so we report the real post-install state.
    list = ListRuntimes();
    return HasFramework(list, "Microsoft.WindowsDesktop.App") && HasFramework(list, "Microsoft.AspNetCore.App");
}
