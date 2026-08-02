import { registerWebModule, NativeModule } from 'expo';

// ExpoLanSocketsModule is not available on the web platform.
class ExpoLanSocketsModule extends NativeModule<{}> {}

export default registerWebModule(ExpoLanSocketsModule, 'ExpoLanSocketsModule');
