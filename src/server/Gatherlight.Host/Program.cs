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
        var logsDir = Path.Combine(Path.GetFullPath(dataPath), "state", "logs");
        // Catch-all crash logging for the WinForms host boot path (outside the server's ILogger).
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Gatherlight.Server.Modules.Core.Logging.LogSink.Crash(logsDir, "Host", "Unhandled exception", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) =>
            Gatherlight.Server.Modules.Core.Logging.LogSink.Crash(logsDir, "Host", "Unobserved task exception", e.Exception);
        // Load config first so the persisted port applies before Kestrel binds (env still overrides).
        var config = new ServerConfigService(new GatherlightServerOptions { DataPath = dataPath });
        // Recompute options from the (possibly just-edited) settings on every build, so a Settings-tab
        // change applies on the next restart. Env vars still override the file.
        GatherlightServerOptions BuildOptions() => new()
        {
            DataPath = dataPath,
            Port = GatherlightServerOptions.ResolvePort(config.Current.Port),
            BindAddress = GatherlightServerOptions.ResolveBindAddress(config.Current.Security.BindAddress),
            AccessToken = GatherlightServerOptions.ResolveAccessToken(config.Current.Security.AccessToken),
            TrustLoopback = GatherlightServerOptions.ResolveTrustLoopback(config.Current.Security.TrustLoopback),
            AllowLanWithoutToken = GatherlightServerOptions.ResolveAllowLanWithoutToken(config.Current.Security.AllowLanWithoutToken),
            TlsEnabled = GatherlightServerOptions.ResolveTlsEnabled(config.Current.Security.Tls.Enabled),
            TlsCertPath = GatherlightServerOptions.ResolveTlsCertPath(config.Current.Security.Tls.CertPath),
            TlsCertPassword = GatherlightServerOptions.ResolveTlsCertPassword(config.Current.Security.Tls.CertPassword),
        };
        static string BaseUrl(GatherlightServerOptions o) => $"{(o.TlsEnabled ? "https" : "http")}://127.0.0.1:{o.Port}/";
        var options = BuildOptions();

        WebApplication? server = null;
        var gate = new SemaphoreSlim(1, 1);

        // Recycle the in-process Kestrel server on request — the desktop app's "restart server": stop +
        // dispose the running one, recompute options from the current settings, rebuild, and start. The
        // window stays open. Returns the (possibly new) base URL so the host re-points the WebView when
        // the port/scheme changed. Also serves as "start" if the server isn't currently up.
        async Task<string> RestartServerAsync()
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
                options = BuildOptions();
                var fresh = GatherlightApp.Build(options, args: args, config: config);
                await fresh.StartAsync();
                server = fresh;
                return BaseUrl(options);
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
            Gatherlight.Server.Modules.Core.Logging.LogSink.Crash(logsDir, "Host", "启动失败 / startup failed", ex);
            MessageBox.Show($"Gatherlight 启动失败:\n{ex.Message}\n\n详情见日志 / see logs:\n{logsDir}", "Gatherlight",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            try { server?.StopAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); } catch { /* shutting down */ }
        }
    }
}
