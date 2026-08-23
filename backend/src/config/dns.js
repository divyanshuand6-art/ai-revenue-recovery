const dns = require('node:dns');

function configureDnsServers() {
  const configuredServers = process.env.DNS_SERVERS;

  if (!configuredServers) {
    return;
  }

  const servers = configuredServers
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);

  if (servers.length === 0) {
    throw new Error('DNS_SERVERS must contain at least one DNS server address.');
  }

  dns.setServers(servers);
  console.info(`Custom DNS servers configured: ${servers.join(', ')}.`);
}

module.exports = { configureDnsServers };
