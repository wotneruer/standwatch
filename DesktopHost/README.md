# StandWatch DesktopHost

Build from the `StandWatch` directory:

```powershell
dotnet publish .\DesktopHost\StandWatch.Desktop.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o .\DesktopHost\publish
```

Deployment requires `standwatch.exe`, `standwatch-server.exe`, `WebView2Loader.dll`
and the existing `data` directory. The Microsoft Edge WebView2 Runtime must be
installed (it is normally included with current Windows/Office installations).
