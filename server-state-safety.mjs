const keyBelongsToServer = (key, serverName) => String(key || '').startsWith(`${serverName}|`);

export function collectServerRenameBlockers({ serverName, catalog = {}, plans = [], transactions = [] }) {
  const matchingPlans = plans.filter(value => value?.server === serverName);
  const matchingTransactions = transactions.filter(value => value?.server === serverName);
  const catalogKeys = [
    ...Object.keys(catalog.installRoots || {}),
    ...Object.keys(catalog.filePolicies || {}),
    ...Object.keys(catalog.groupInstaller || {}),
  ].filter(key => keyBelongsToServer(key, serverName));
  const projectBinding = Object.prototype.hasOwnProperty.call(catalog.serverProjects || {}, serverName);

  return {
    plans: matchingPlans.length,
    transactions: matchingTransactions.length,
    catalogKeys: catalogKeys.length + (projectBinding ? 1 : 0),
    blocked: matchingPlans.length > 0 || matchingTransactions.length > 0,
  };
}

