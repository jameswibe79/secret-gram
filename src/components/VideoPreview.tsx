import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from './ui/button'

interface VideoPreviewProps {
  url: string
  name: string
  variant: 'viewer' | 'modal'
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const wholeSeconds = Math.floor(seconds)
  const minutes = Math.floor(wholeSeconds / 60)
  const remainingSeconds = wholeSeconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

export function VideoPreview({ url, name, variant }: VideoPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const video = videoRef.current
    setPlaying(false)
    setDuration(0)
    setCurrentTime(0)
    setError('')
    return () => {
      if (video && !video.paused) video.pause()
    }
  }, [url])

  useEffect(() => {
    function syncFullscreen() {
      setFullscreen(document.fullscreenElement === containerRef.current)
    }
    document.addEventListener('fullscreenchange', syncFullscreen)
    return () => document.removeEventListener('fullscreenchange', syncFullscreen)
  }, [])

  const togglePlayback = useCallback(async () => {
    const video = videoRef.current
    if (!video) return
    if (!video.paused) {
      video.pause()
      return
    }
    try {
      await video.play()
    } catch {
      setError('Playback could not start in this browser.')
    }
  }, [])

  function seek(nextTime: number) {
    const video = videoRef.current
    if (!video) return
    video.currentTime = nextTime
    setCurrentTime(nextTime)
  }

  function toggleMute() {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    setMuted(video.muted)
  }

  async function toggleFullscreen() {
    const container = containerRef.current
    if (!container) return
    try {
      if (document.fullscreenElement === container) {
        await document.exitFullscreen()
        return
      }
      await container.requestFullscreen()
    } catch {
      setError('Full screen is unavailable in this browser.')
    }
  }

  return (
    <div
      ref={containerRef}
      className={`video-preview ${variant === 'viewer' ? 'viewer-video-preview' : 'modal-video-preview'}`}
    >
      <video
        ref={videoRef}
        src={url}
        playsInline
        preload="metadata"
        tabIndex={0}
        aria-label={`${name} video preview`}
        onClick={togglePlayback}
        onKeyDown={(event) => {
          if (event.key !== ' ' && event.key !== 'Enter') return
          event.preventDefault()
          void togglePlayback()
        }}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
        onError={() => setError('This MP4 could not be played by this browser.')}
      />

      {!playing && !error && (
        <button
          type="button"
          className="video-center-play"
          aria-label={`Play ${name}`}
          onClick={togglePlayback}
        >
          <Play aria-hidden="true" />
        </button>
      )}

      <div className="video-controls" aria-label={`${name} playback controls`}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="video-control-button"
          aria-label={playing ? 'Pause video' : 'Play video'}
          onClick={togglePlayback}
        >
          {playing ? <Pause /> : <Play />}
        </Button>
        <input
          className="video-timeline"
          type="range"
          min={0}
          max={duration || 0}
          step="0.01"
          value={Math.min(currentTime, duration || 0)}
          aria-label={`${name} playback position`}
          onChange={(event) => seek(event.currentTarget.valueAsNumber)}
        />
        <output className="video-time" aria-live="off">
          {formatTime(currentTime)} / {formatTime(duration)}
        </output>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="video-control-button"
          aria-label={muted ? 'Unmute video' : 'Mute video'}
          aria-pressed={muted}
          onClick={toggleMute}
        >
          {muted ? <VolumeX /> : <Volume2 />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="video-control-button"
          aria-label={fullscreen ? 'Exit full screen' : 'Enter full screen'}
          onClick={() => void toggleFullscreen()}
        >
          {fullscreen ? <Minimize /> : <Maximize />}
        </Button>
      </div>

      {error && <p className="video-error" role="alert">{error}</p>}
    </div>
  )
}
