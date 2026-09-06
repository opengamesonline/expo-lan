const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const socketsRoot = path.resolve(projectRoot, '../..');
const multiplayerRoot = path.resolve(projectRoot, '../../../expo-lan-multiplayer');
const config = getDefaultConfig(projectRoot);

config.watchFolders = [socketsRoot, multiplayerRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(projectRoot, 'node_modules/expo/node_modules'),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.extraNodeModules = {
  '@opengamesonline/expo-lan-sockets': socketsRoot,
  '@opengamesonline/expo-lan-multiplayer': multiplayerRoot,
};

module.exports = config;
