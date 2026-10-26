/** Prepare at a fixed position before either participant track is allowed to advance. */
export async function prepareRatingPlayback(video: HTMLVideoElement, seconds: number): Promise<void> {
  video.pause()
  if (video.error) video.load()
  await waitForMedia(video, () => video.readyState >= 1, ['loadedmetadata'])
  if (Math.abs(video.currentTime - seconds) > 0.01) video.currentTime = seconds
  await waitForMedia(video, () => !video.seeking && video.readyState >= 3, ['seeked', 'canplay', 'loadeddata'])
}

function waitForMedia(video: HTMLVideoElement, ready: () => boolean, events: string[]): Promise<void> {
  if (video.error) return Promise.reject(new Error('The recording cannot be played. Ask the researcher to check the video file.'))
  if (ready()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      for (const event of events) video.removeEventListener(event, check)
      video.removeEventListener('error', failed)
      error ? reject(error) : resolve()
    }
    const check = () => { if (ready()) finish() }
    const failed = () => finish(new Error('The recording cannot be played. Ask the researcher to check the video file.'))
    const timer = setTimeout(() => finish(new Error('The recording is still loading. Check the drive connection, then continue playback.')), 10000)
    for (const event of events) video.addEventListener(event, check)
    video.addEventListener('error', failed)
  })
}
