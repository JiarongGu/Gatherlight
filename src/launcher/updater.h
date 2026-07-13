// Auto-update — APPLY phase (the launcher's half of the two-phase update flow).
#pragma once

#include <windows.h>
#include <string>

// Apply a pending update the app already downloaded + staged under {installDir}/.update/. Runs before
// the host launches (a running exe can't replace itself). No-op when nothing is staged — the launcher
// never checks GitHub or prompts; that is the app's job (Modules/Update/UpdateService). Never fatal:
// any failure still lets the host start on the current version. Returns true when done.
bool ApplyPendingUpdate(const std::wstring& installDir);
