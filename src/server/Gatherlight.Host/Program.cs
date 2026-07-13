using Gatherlight.Server;
using Gatherlight.Server.Modules.Core.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Hosting; // Start() / StopAsync(TimeSpan) sync host extensions

namespace Gatherlight.Host;

/// <summary>
/// Desktop management host — the "proper" way to run Gatherlight (instead of `dotnet run` from the
/// code repo). A WinForms tray app that hosts the Kestrel server IN-PROCESS via the same
/// <see cref="GatherlightApp.Build"/> composition root, then presents a management + health-monitor
/// console (<see cref="AppHost"/>). It is NOT the planner UI — users open that in a browser at the
/// shown URL. Closing minimizes to the tray; the server keeps serving. One instance per machine.
/// </summary>
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var restarted = args.Contains("--restarted");
        // One instance per machine — a second launch surfaces the running window (a "restart"
        // relaunch waits for the old instance to release the mutex).
        using var mutex = new Mutex(false, "Gatherlight.Host.Singleton");
        if (!mutex.WaitOne(restarted ? TimeSpan.FromSeconds(20) : TimeSpan.Zero))
        {
            AppHost.SignalShowExisting();
            return;
        }

        ApplicationConfiguration.Initialize();

        var dataPath = GatherlightServerOptions.ResolveDefaultDataPath();
        // Load config first so the persisted port applies before Kestrel binds (env still overrides).
        var config = new ServerConfigService(new GatherlightServerOptions { DataPath = dataPath });
        var options = new GatherlightServerOptions
        {
            DataPath = dataPath,
            Port = GatherlightServerOptions.ResolvePort(config.Current.Port),
        };

        WebApplication? server = null;
        try
        {
            server = GatherlightApp.Build(options, args: args, config: config);
            server.Start(); // Kestrel in-process, non-blocking; the form owns shutdown
            Application.Run(new AppHost(options));
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Gatherlight 启动失败:\n{ex.Message}", "Gatherlight",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            try { server?.StopAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); } catch { /* shutting down */ }
        }
    }
}
