/**
 * Which commit to install. research-workbench/release.json on the branch names the last commit whose
 * tests passed; the installer downloads that exact commit from codeload, so later pushes to the branch
 * never reach users before they are tested.
 */
import { APP_SUBDIR, BRANCH, REPO } from './layout.mjs';

export const rawUrl = (ref, rel) => `https://raw.githubusercontent.com/${REPO}/${ref}/${APP_SUBDIR}/${rel}`;
export const releaseUrl = () => rawUrl(BRANCH, 'release.json');
export const tarballUrl = (commit) => `https://codeload.github.com/${REPO}/tar.gz/${commit}`;

export class ReleaseError extends Error {
  /** @param {'PENDING' | 'INVALID'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const isCommit = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);

/** Parse release.json text: `{ "commit": "<40 hex>", "date": "…" }`. `"pending"` means no tested release yet. */
export function parseRelease(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ReleaseError('INVALID', 'release.json is not valid JSON');
  }
  const commit = json && typeof json === 'object' ? json.commit : undefined;
  if (commit === 'pending') {
    throw new ReleaseError('PENDING', 'release.json has no tested commit yet ("pending")');
  }
  if (!isCommit(commit)) throw new ReleaseError('INVALID', `release.json "commit" is not a full commit sha: ${JSON.stringify(commit)}`);
  return { commit, short: commit.slice(0, 7), date: typeof json.date === 'string' ? json.date : null };
}

/**
 * tar arguments that extract only `organism-<sha>/research-workbench/` from a codeload tarball into
 * `dest` (its contents land directly in dest). Works with both bsdtar (macOS) and GNU tar.
 */
export function tarExtractArgs(archive, dest, commit) {
  const repoName = REPO.split('/')[1];
  return ['-xzf', archive, '-C', dest, '--strip-components=2', `${repoName}-${commit}/${APP_SUBDIR}`];
}
