import { NativeModule, requireNativeModule } from 'expo';

declare class ExpoLanSocketsModule extends NativeModule<{}> {}

export default requireNativeModule<ExpoLanSocketsModule>('ExpoLanSockets');
