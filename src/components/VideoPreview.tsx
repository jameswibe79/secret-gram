import { Eye, EyeOff, Maximize, Minimize, Pause, Pin, PinOff, Play, Volume2, VolumeX } from 'lucide-react'
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

const AUTO_HIDE_DELAY_MS = 2_500

export function VideoPreview({ url, name, variant }: VideoPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const hideTimerRef = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [controlsPinned, setControlsPinned] = useState(false)
  const [controlsManuallyHidden, setControlsManuallyHidden] = useState(false)
  const [error, setError] = useState('')

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) return
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }, [])

  const scheduleAutoHide = useCallback(() => {
    clearHideTimer()
    if (!playing || controlsPinned || controlsManuallyHidden) return
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      if (containerRef.current?.contains(document.activeElement)) return
      setControlsVisible(false)
    }, AUTO_HIDE_DELAY_MS)
  }, [clearHideTimer, controlsManuallyHidden, controlsPinned, playing])

  const revealControls = useCallback(() => {
    if (controlsManuallyHidden) return
    setControlsVisible(true)
    scheduleAutoHide()
  }, [controlsManuallyHidden, scheduleAutoHide])

  useEffect(() => {
    const video = videoRef.current
    setPlaying(false)
    setDuration(0)
    setCurrentTime(0)
    setControlsVisible(true)
    setControlsPinned(false)
    setControlsManuallyHidden(false)
    setError('')
    return () => {
      clearHideTimer()
      if (video && !video.paused) video.pause()
    }
  }, [clearHideTimer, url])

  useEffect(() => {
    clearHideTimer()
    if (controlsManuallyHidden) {
      setControlsVisible(false)
      return
    }
    if (!playing || controlsPinned) {
      setControlsVisible(true)
      return
    }
    scheduleAutoHide()
    return clearHideTimer
  }, [clearHideTimer, controlsManuallyHidden, controlsPinned, playing, scheduleAutoHide])

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
      setControlsManuallyHidden(false)
      setControlsVisible(true)
    }
  }, [])

  function seek(nextTime: number) {
    const video = videoRef.current
    if (!video) return
    video.currentTime = nextTime
    setCurrentTime(nextTime)
    revealControls()
  }

  function toggleMute() {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    setMuted(video.muted)
    revealControls()
  }

  function toggleControlsPin() {
    setControlsVisible(true)
    setControlsPinned((current) => !current)
  }

  function hideControls() {
    clearHideTimer()
    setControlsManuallyHidden(true)
    setControlsVisible(false)
  }

  function showControls() {
    setControlsManuallyHidden(false)
    setControlsVisible(true)
  }

  function handleVideoClick() {
    if (!controlsVisible && !controlsManuallyHidden) {
      revealControls()
      return
    }
    void togglePlayback()
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
      setControlsVisible(true)
    }
  }

  return (
    <div
      ref={containerRef}
      className={`video-preview ${variant === 'viewer' ? 'viewer-video-preview' : 'modal-video-preview'}${controlsVisible ? '' : ' controls-hidden'}`}
      onPointerMove={revealControls}
      onPointerLeave={scheduleAutoHide}
      onFocusCapture={revealControls}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        scheduleAutoHide()
      }}
    >
      <video
        ref={videoRef}
        src={url}
        playsInline
        preload="metadata"
        tabIndex={0}
        aria-label={`${name} video preview`}
        onClick={handleVideoClick}
        onKeyDown={(event) => {
          if (event.key !== ' ' && event.key !== 'Enter') return
          event.preventDefault()
          if (!controlsVisible && !controlsManuallyHidden) {
            revealControls()
            return
          }
          void togglePlayback()
        }}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
        onError={() => {
          setError('This MP4 could not be played by this browser.')
          setControlsManuallyHidden(false)
          setControlsVisible(true)
        }}
      />

      {!playing && !error && (
        <button
          type="button"
          className="video-center-play"
          aria-label={`Play ${name}`}
          onClick={() => void togglePlayback()}
        >
          <Play aria-hidden="true" />
        </button>
      )}

      <div
        className={`video-controls${controlsVisible ? '' : ' is-hidden'}${controlsPinned ? ' is-pinned' : ''}`}
        aria-label={`${name} playback controls`}
        aria-hidden={!controlsVisible}
        onPointerEnter={clearHideTimer}
        onPointerLeave={scheduleAutoHide}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="video-control-button"
          aria-label={playing ? 'Pause video' : 'Play video'}
          title={playing ? 'Pause' : 'Play'}
          onClick={() => void togglePlayback()}
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
          title={muted ? 'Unmute' : 'Mute'}
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
          aria-label={controlsPinned ? 'Use auto-hide controls' : 'Pin controls'}
          title={controlsPinned ? 'Use auto-hide' : 'Pin controls'}
          aria-pressed={controlsPinned}
          onClick={toggleControlsPin}
        >
          {controlsPinned ? <PinOff /> : <Pin />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="video-control-button"
          aria-label="Hide video controls"
          title="Hide controls"
          onClick={hideControls}
        >
          <EyeOff />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="video-control-button"
          aria-label={fullscreen ? 'Exit full screen' : 'Enter full screen'}
          title={fullscreen ? 'Exit full screen' : 'Enter full screen'}
          onClick={() => void toggleFullscreen()}
        >
          {fullscreen ? <Minimize /> : <Maximize />}
        </Button>
      </div>

      {!controlsVisible && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="video-show-controls"
          aria-label="Show video controls"
          title="Show controls"
          onClick={showControls}
        >
          <Eye />
        </Button>
      )}

      {error && <p className="video-error" role="alert">{error}</p>}
    </div>
  )
}
