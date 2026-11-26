'use strict';
const { lookup } = require('node:dns');
const { BlockList, isIP } = require('node:net');

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3]
]) blocked.addSubnet(address, prefix);
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}
const ipv6Global = new BlockList();
ipv6Global.addSubnet('2000::', 3, 'ipv6');

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address);
  return family === 6 && ipv6Global.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function parseCallbackUrl(value) {
  if (typeof value !== 'string') return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const domain = hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href.length > 2048) return null;
  if (isIP(hostname) ? !isPublicAddress(hostname) : !domain.includes('.') || /\.(localhost|local|internal|home\.arpa)$/.test(domain)) return null;
  return url;
}

function publicLookup(resolve = lookup) {
  return (hostname, options, done) => {
    // Pass only vetted DNS answers back to the socket to avoid a second resolution.
    resolve(hostname, { all: true, family: options.family, hints: options.hints }, (error, addresses) => {
      if (error) return done(error);
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        return done(Object.assign(new Error('Callback host must resolve to public IP addresses.'), { code: 'CALLBACK_ADDRESS_BLOCKED' }));
      }
      if (options.all) return done(null, addresses);
      return done(null, addresses[0].address, addresses[0].family);
    });
  };
}

module.exports = { parseCallbackUrl, publicLookup };
