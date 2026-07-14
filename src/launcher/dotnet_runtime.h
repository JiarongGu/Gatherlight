// .NET runtime bootstrap — the launcher ensures the shared frameworks the framework-dependent host
// needs (Windows Desktop + ASP.NET Core, .NET 10) are installed before launching it.
#pragma once

// Ensure the required .NET 10 shared runtimes are present, installing the official Microsoft runtime
// installers (once, with a UAC prompt) if not. Returns true if they're present afterwards.
bool EnsureDotNetRuntime();
