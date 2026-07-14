// Gatherlight.Resources ships NO code — it is a content-only NuGet package used as heavy-resource
// storage (the Playwright driver slice, etc.; see README.md). This empty type only keeps the SDK
// build happy so `dotnet pack` produces a valid package; the assembly is excluded from the .nupkg
// (IncludeBuildOutput=false).
namespace Gatherlight.Resources
{
    internal static class Package
    {
    }
}
