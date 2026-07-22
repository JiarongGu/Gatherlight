@echo off
rem A .cmd shim over the node MCP stub — stands in for an npx/npm-launched MCP server, so e2e-p35
rem can exercise the Windows "launch a .cmd shell shim via cmd.exe" path (ResolveLaunch).
node "%~dp0mcp-stub-server.mjs" %*
