const { handleWindowsDownloadConfigRoutes } = require('./download/downloadWindowsConfigController');
const { handleAndroidDownloadConfigRoutes } = require('./download/downloadAndroidConfigController');
const { handleSharedDownloadConfigRoutes } = require('./download/downloadSharedConfigController');

function handleDownloadConfigRoutes(scope) {
  if (handleWindowsDownloadConfigRoutes(scope)) return true;
  if (handleAndroidDownloadConfigRoutes(scope)) return true;
  if (handleSharedDownloadConfigRoutes(scope)) return true;
  return false;
}

module.exports = {
  handleDownloadConfigRoutes,
};
