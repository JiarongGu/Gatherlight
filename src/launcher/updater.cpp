// Auto-update — APPLY phase.
//
// The running app (Gatherlight.Host) downloads + extracts the update itself and stages it under
// {install}/.update/ (staged/ + ready.json), because a running .NET app can't replace its own exe.
// On the next startup the launcher — which runs BEFORE the host — applies that staged update here:
//   1. If {install}/.update/ready.json is absent, do nothing (no network, no prompt).
//   2. Otherwise back up the current program files, overlay {install}/.update/staged over the install
//      with robocopy (EXCEPT the launcher itself), and — on success — delete files dropped from the new
//      manifest. If the overlay fails partway, restore the backup so the install stays bootable. Then
//      clear the staging dir.
// The launcher never checks GitHub or prompts — that's the app's job (UpdateService). Non-fatal
// throughout: any failure still launches the host on the current version.
#include "updater.h"
#include <windows.h>
#include <shlwapi.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <string>
#include <set>
#include <vector>
#include <cctype>
#include <fstream>
#include <sstream>

#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "shell32.lib")

namespace {

// The launcher basename (lower-case) is never deleted by the manifest-diff removal step, and is
// excluded from the overlay (a running exe can't overwrite itself).
constexpr auto kLauncherBasename = "gatherlight.exe";

std::string ReadFileUtf8(const std::wstring& path)
{
    std::ifstream f(path, std::ios::binary);
    if (!f) return {};
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// Extract every "path": "value" entry (the manifest's file list), as-is (forward-slash normalized).
std::set<std::string> ExtractPaths(const std::string& json)
{
    std::set<std::string> out;
    const std::string needle = "\"path\"";
    size_t pos = 0;
    while ((pos = json.find(needle, pos)) != std::string::npos)
    {
        size_t colon = json.find(':', pos + needle.size());
        if (colon == std::string::npos) break;
        size_t q1 = json.find('"', colon + 1);
        if (q1 == std::string::npos) break;
        size_t q2 = json.find('"', q1 + 1);
        if (q2 == std::string::npos) break;
        out.insert(json.substr(q1 + 1, q2 - q1 - 1));
        pos = q2 + 1;
    }
    return out;
}

std::wstring Utf8ToW(const std::string& s)
{
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}

// Run a hidden process and wait; returns its exit code (or -1 on failure to start).
int RunHidden(const std::wstring& cmdLine)
{
    std::wstring mutableCmd = cmdLine;
    if (mutableCmd.empty()) return -1;
    STARTUPINFOW si = { sizeof(STARTUPINFOW) };
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(nullptr, &mutableCmd[0], nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi))
    {
        return -1;
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return (int)code;
}

// Mirror `src` into `dst` (recursive, overwriting) with robocopy, plus any extra exclude args.
// robocopy exit codes < 8 = success (0 = nothing to copy, 1–7 = copied/extra/mismatch, all fine).
bool RobocopyTree(const std::wstring& src, const std::wstring& dst, const std::wstring& extra)
{
    std::wstring cmd = L"\"" + System32Exe(L"robocopy.exe") + L"\" \"" + src + L"\" \"" + dst + L"\" /E " + extra +
        L" /NJH /NJS /NP /NFL /NDL /R:2 /W:1";
    int rc = RunHidden(cmd);
    return rc >= 0 && rc < 8;
}

void DeleteDirRecursive(const std::wstring& dir)
{
    if (!PathFileExistsW(dir.c_str())) return;
    std::wstring from = dir;
    from.push_back(L'\0'); // double-null terminated for SHFileOperation
    SHFILEOPSTRUCTW op = {};
    op.wFunc = FO_DELETE;
    op.pFrom = from.c_str();
    op.fFlags = FOF_NO_UI | FOF_NOCONFIRMATION | FOF_SILENT;
    SHFileOperationW(&op);
}

HWND ShowStatus(const wchar_t* text)
{
    return CreateWindowW(L"STATIC", text, WS_VISIBLE | WS_POPUP | SS_CENTER,
                         (GetSystemMetrics(SM_CXSCREEN) - 420) / 2,
                         (GetSystemMetrics(SM_CYSCREEN) - 90) / 2,
                         420, 90, nullptr, nullptr, GetModuleHandle(nullptr), nullptr);
}

// Force-close any running host instance under the install so its exe unlocks before the overlay.
// (A normal update-restart already exits the host; this is the safety net for a hung/zombie one.)
void CloseRunningHost(const std::wstring& installDir)
{
    const std::wstring hostPath = installDir + L"\\libs\\Gatherlight.Host.exe";
    const DWORD selfPid = GetCurrentProcessId();

    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return;

    std::vector<HANDLE> terminated;
    PROCESSENTRY32W pe = { sizeof(PROCESSENTRY32W) };
    if (Process32FirstW(snap, &pe))
    {
        do {
            if (pe.th32ProcessID == selfPid) continue;
            HANDLE hProc = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE,
                FALSE, pe.th32ProcessID);
            if (!hProc) continue;

            // Large buffer, not MAX_PATH: a deep install path (>260 chars) would otherwise truncate the
            // query, the host wouldn't match, it wouldn't be killed, and the overlay would hit a locked
            // exe and fail every launch. 32K covers any Windows path length.
            wchar_t imgPath[32768];
            DWORD sz = ARRAYSIZE(imgPath);
            bool match = QueryFullProcessImageNameW(hProc, 0, imgPath, &sz)
                && _wcsicmp(imgPath, hostPath.c_str()) == 0;
            if (match && TerminateProcess(hProc, 0))
                terminated.push_back(hProc); // keep the handle to wait for exit below
            else
                CloseHandle(hProc);
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);

    // Bounded wait so the killed process's exe lock actually releases before robocopy runs.
    for (HANDLE h : terminated)
    {
        WaitForSingleObject(h, 4000);
        CloseHandle(h);
    }
}

std::wstring OwnExeBasename()
{
    wchar_t path[32768]; // long-path safe (see CloseRunningHost) so the basename isn't truncated
    GetModuleFileNameW(nullptr, path, ARRAYSIZE(path));
    return std::wstring(PathFindFileNameW(path));
}

// Absolute path to a System32 executable — never invoke robocopy by bare name (a planted robocopy.exe
// in the cwd would be found first via CreateProcessW's search order).
std::wstring System32Exe(const wchar_t* exe)
{
    wchar_t sys[MAX_PATH];
    UINT n = GetSystemDirectoryW(sys, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return exe;   // fallback: bare name
    return std::wstring(sys, n) + L"\\" + exe;
}

// A manifest path is unsafe if it escapes the install root — a `..` path segment, or an absolute/drive
// (`C:\`) / rooted (`\` or `/`) prefix. Deleting such a path would touch files outside the install.
bool IsUnsafeRel(const std::string& p)
{
    if (p.empty()) return true;
    if (p[0] == '/' || p[0] == '\\') return true;            // rooted
    if (p.size() >= 2 && p[1] == ':') return true;           // drive-qualified
    size_t start = 0;
    for (size_t i = 0; i <= p.size(); ++i)
        if (i == p.size() || p[i] == '/' || p[i] == '\\')
        {
            if (i - start == 2 && p[start] == '.' && p[start + 1] == '.') return true;
            start = i + 1;
        }
    return false;
}

} // namespace

bool ApplyPendingUpdate(const std::wstring& installDir)
{
    const std::wstring stagingRoot = installDir + L"\\.update";
    const std::wstring readyMarker = stagingRoot + L"\\ready.json";
    const std::wstring stagedDir = stagingRoot + L"\\staged";

    // 1. Nothing staged -> nothing to do (no network, no prompt).
    if (!PathFileExistsW(readyMarker.c_str()))
        return true;

    // Marker without staged files -> corrupt; clear it so we don't loop.
    if (!PathFileExistsW(stagedDir.c_str()))
    {
        DeleteDirRecursive(stagingRoot);
        return true;
    }

    HWND status = ShowStatus(L"Installing update...\n\nThis will only take a moment.");

    // Read old + new manifests BEFORE the overlay (robocopy overwrites manifest.json).
    std::string oldManifest = ReadFileUtf8(installDir + L"\\manifest.json");
    std::string newManifest = ReadFileUtf8(stagedDir + L"\\manifest.json");

    CloseRunningHost(installDir);

    std::wstring launcherName = OwnExeBasename();

    // 2. Back up the current program files — everything EXCEPT the (untouched) user data, the staging
    //    dir, and the launcher — so a failed overlay can be rolled back. Without this, a robocopy that
    //    dies partway (disk full, a locked DLL) would leave a half-updated, possibly unbootable install
    //    with no way back. The backup lives under .update/ so step 5 clears it with everything else.
    const std::wstring backupDir = stagingRoot + L"\\backup";
    DeleteDirRecursive(backupDir);
    std::wstring backupExcl = L"/XD \"" + stagingRoot + L"\" \"" + installDir + L"\\data\" /XF \"" + launcherName + L"\"";
    bool backedUp = RobocopyTree(installDir, backupDir, backupExcl);

    // 3. Overlay staged files onto the install, EXCLUDING the running launcher's own image (it can't
    //    be overwritten while running, and never self-updates). robocopy /E mirrors subdirs; /XF
    //    excludes; exit codes < 8 = success.
    std::wstring copy = L"\"" + System32Exe(L"robocopy.exe") + L"\" \"" + stagedDir + L"\" \"" + installDir +
        L"\" /E /XF \"" + launcherName + L"\" /NJH /NJS /NP /NFL /NDL /R:3 /W:1";
    int rc = RunHidden(copy);
    bool ok = (rc >= 0 && rc < 8);

    if (ok)
    {
        // 4. Removals: files the old manifest listed but the new one no longer does (never the
        //    launcher or the manifest itself — those are handled separately).
        std::set<std::string> oldPaths = ExtractPaths(oldManifest);
        std::set<std::string> newPaths = ExtractPaths(newManifest);
        for (const auto& p : oldPaths)
        {
            if (newPaths.count(p)) continue;
            if (IsUnsafeRel(p)) continue;   // zip-slip: a hostile manifest path must not delete outside the install

            std::string base = p;
            size_t slash = base.find_last_of("/\\");
            if (slash != std::string::npos) base = base.substr(slash + 1);
            for (auto& c : base) c = (char)std::tolower((unsigned char)c);
            if (base == kLauncherBasename) continue;

            std::wstring rel = Utf8ToW(p);
            for (auto& ch : rel) if (ch == L'/') ch = L'\\';
            std::wstring full = installDir + L"\\" + rel;
            DeleteFileW(full.c_str());
        }
    }
    else if (backedUp)
    {
        // Overlay failed partway → restore the pre-overlay program files from the backup so the
        // current version still starts cleanly. (The removal step is skipped when !ok, so restoring
        // the overwritten files is enough; any extra files the partial overlay added are harmless.)
        RobocopyTree(backupDir, installDir, L"/XF \"" + launcherName + L"\"");
    }

    // 5. Clear staging (backup included) regardless (avoid re-applying on every launch).
    DeleteDirRecursive(stagingRoot);
    if (status) DestroyWindow(status);

    if (!ok)
    {
        MessageBoxW(nullptr,
            L"The downloaded update could not be applied. The current version will start instead.\n\n"
            L"It will be retried the next time an update is downloaded.",
            L"Gatherlight - Update", MB_OK | MB_ICONWARNING);
    }
    return true;
}
