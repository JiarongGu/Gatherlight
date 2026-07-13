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
            BindAddress = GatherlightServerOptions.ResolveBindAddress(config.Current.Security.BindAddress),
            AccessToken = GatherlightServerOptions.ResolveAccessToken(config.Current.Security.AccessToken),
            TrustLoopback = GatherlightServerOptions.ResolveTrustLoopback(config.Current.Security.TrustLoopback),
            TlsEnabled = GatherlightServerOptions.ResolveTlsEnabled(config.Current.Security.Tls.Enabled),
            TlsCertPath = GatherlightServerOptions.ResolveTlsCertPath(config.Current.Security.Tls.CertPath),
            TlsCertPassword = GatherlightServerOptions.ResolveTlsCertPassword(config.Current.Security.Tls.CertPassword),
        };

        WebApplication? server = null;
        var gate = new SemaphoreSlim(1, 1);

        // Recycle the in-process Kestrel server on request — the desktop app's "restart server": stop +
        // dispose the running one, rebuild from the same composition root (re-reading settings/data),
        // and start fresh on the same port. The management window stays open; only the server bounces.
        // Also serves as "start" if the server isn't currently up (a prior start/restart failed).
        async Task RestartServerAsync()
        {
            await gate.WaitAsync();
            try
            {
                var old = server;
                server = null;
                if (old is not null)
                {
                    try { await old.StopAsync(TimeSpan.FromSeconds(5)); } catch { /* force on */ }
                    try { await old.DisposeAsync(); } catch { /* force on */ }
                    await Task.Delay(400); // let Kestrel release the port before rebinding
                }
                var fresh = GatherlightApp.Build(options, args: args, config: config);
                await fresh.StartAsync();
                server = fresh;
            }
            finally { gate.Release(); }
        }

        try
        {
            server = GatherlightApp.Build(options, args: args, config: config);
            server.Start(); // Kestrel in-process, non-blocking; the form owns shutdown
            Application.Run(new AppHost(options, RestartServerAsync));
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
