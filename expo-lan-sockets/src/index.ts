// Reexport the native module. On web, it will be resolved to ExpoLanSocketsModule.web.ts
// and on native platforms to ExpoLanSocketsModule.ts
export { default } from './ExpoLanSocketsModule';
export * from './ExpoLanSockets.types';
