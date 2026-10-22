export interface ReleaseUpdate {
  status: 'available' | 'up_to_date' | 'unavailable'
  latestVersion?: string
  downloadUrl?: string
  releaseUrl?: string
}
const releasesUrl =
  'https://github.com/alexmueller07/niedenthal-ducksoup-research-video-conferencing/releases/latest'

export async function checkReleaseUpdate(
  currentVersion: string,
  platform: string,
): Promise<ReleaseUpdate> {
  try {
    const response = await fetch(
      'https://api.github.com/repos/alexmueller07/niedenthal-ducksoup-research-video-conferencing/releases/latest',
      {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000),
      },
    )
    if (!response.ok) return { status: 'unavailable' }
    const release = (await response.json()) as {
      tag_name?: string
      name?: string
      prerelease?: boolean
      draft?: boolean
      assets?: { name: string; browser_download_url: string }[]
    }
    if (release.prerelease || release.draft) return { status: 'unavailable' }
    const version =
      (release.tag_name || '').match(
        /(?:^|[^\d])(\d+\.\d+\.\d+)(?:$|[^\d.-])/,
      )?.[1] || (release.name || '').match(/(\d+\.\d+\.\d+)/)?.[1]
    if (!version) return { status: 'unavailable' }
    const next = version.split('.').map(Number)
    const current = currentVersion.split('.').map(Number)
    const different = next.findIndex((n, i) => n !== current[i])
    const newer = different >= 0 && next[different] > current[different]
    const extension =
      platform === 'win32'
        ? /\.exe$/i
        : platform === 'darwin'
          ? /\.dmg$/i
          : /\.AppImage$/i
    const asset =
      platform === 'browser'
        ? undefined
        : release.assets?.find((a) => extension.test(a.name))
    return {
      status: newer ? 'available' : 'up_to_date',
      latestVersion: version,
      downloadUrl: asset?.browser_download_url,
      releaseUrl: releasesUrl,
    }
  } catch {
    return { status: 'unavailable' }
  }
}
