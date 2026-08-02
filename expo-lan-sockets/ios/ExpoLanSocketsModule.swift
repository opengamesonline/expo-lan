import ExpoModulesCore

public class ExpoLanSocketsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoLanSockets")

    Constant("capabilities") {
      return [
        "tcpServer": false,
        "tcpClient": false,
        "serviceDiscovery": false
      ]
    }
  }
}
