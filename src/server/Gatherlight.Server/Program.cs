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
};
var app = GatherlightApp.Build(options, args: args, config: config);
app.Logger.LogInformation("Gatherlight server on http://127.0.0.1:{Port} (data: {Data})",
    options.Port, options.DataPath);
app.Run();
