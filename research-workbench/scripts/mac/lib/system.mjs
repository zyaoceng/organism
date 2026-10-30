/**
 * Which Node the installer bundles for which Mac. install.sh embeds the same versions and checksums
 * (a unit test keeps the two in sync); install.mjs uses them for --doctor.
 */

/** Official nodejs.org .tar.gz files and their SHA-256 (from SHASUMS256.txt). */
export const NODE_RELEASES = {
  '24.22.2': {
    'darwin-arm64': 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
    'darwin-x64': 'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52',
    'linux-x64': '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9',
  },
  '22.23.4': {
    'darwin-arm64': 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
    'darwin-x64': 'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819',
    'linux-x64': 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406',
  },
};

/** Compare dotted versions numerically: versionAtLeast('13.5.1', '13.5') === true; missing parts count as 0. */
export function versionAtLeast(version, min) {
  const a = String(version).split('.').map((x) => Number.parseInt(x, 10) || 0);
  const b = String(min).split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** Node 24 needs macOS 13.5; Node 22 runs on macOS 11 and later; older systems are refused. */
export function nodeForMacos(version) {
  if (versionAtLeast(version, '13.5')) return '24.22.2';
  if (versionAtLeast(version, '11')) return '22.23.4';
  return null;
}
