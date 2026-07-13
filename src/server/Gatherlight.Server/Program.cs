using Gatherlight.Server;
using Gatherlight.Server.Modules.Core.Services;

// Headless entry point (`dotnet run`) — serves the API + built client on loopback.
var dataPath = GatherlightServerOptions.ResolveDefaultDataPath();
// Load config first so the persisted port applies (GATHERLIGHT_PORT still overrides for dev/e2e).
var config = new ServerConfigService(new GatherlightServerOptions { DataPath = dataPath });
var options = new GatherlightServerOptions
{
    DataPath = dataPath,
    Port = GatherlightServerOptions.ResolvePort(config.Current.Port),
    BindAddress = GatherlightServerOptions.ResolveBindAddress(config.Current.Security.BindAddress),
    AccessToken = GatherlightServerOptions.ResolveAccessToken(config.Current.Security.AccessToken),
    TrustLoopback = GatherlightServerOptions.ResolveTrustLoopback(config.Current.Security.TrustLoopback),
};
var app = GatherlightApp.Build(options, args: args, config: config);
app.Logger.LogInformation("Gatherlight server on http://{Bind}:{Port} (data: {Data}, auth: {Auth})",
    options.BindAddress, options.Port, options.DataPath,
    string.IsNullOrEmpty(options.AccessToken) ? "off · loopback-trusted" : "token required for remote");
app.Run();
