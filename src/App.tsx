import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import YouTube from 'react-youtube'
import type { YouTubeEvent, YouTubePlayer } from 'react-youtube'
import './App.css'
import { deriveGridPublicKeys, deriveNamespacePublicKey } from './hdWallet'

type PointOfInterest = {
  id: string
  time: number
  row: number
  column: number
  xPercent: number
  yPercent: number
  note: string
}

type VideoTrack = {
  key: string
  videoId: string
  source: string
  namespace?: string
  points: PointOfInterest[]
}

type PlaybackState = {
  currentTime: number
  duration: number
}

type GraphTag = {
  publicKey: string
  memo: string
}

const waitForIdlePeriod = () =>
  new Promise<void>((resolve) => {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      ;(
        window as Window & { requestIdleCallback: (callback: IdleRequestCallback) => number }
      ).requestIdleCallback(() => resolve())
    } else {
      setTimeout(resolve, 16)
    }
  })

const GRID_PADDING_PERCENT = '177.78%'
const GRID_ASPECT_WIDTH = 9
const GRID_ASPECT_HEIGHT = 16
const TAG_GRID_ROWS = GRID_ASPECT_HEIGHT
const TAG_GRID_COLUMNS = GRID_ASPECT_WIDTH
const MIN_GRID_SCALE = 1
const MAX_GRID_SCALE = 4
const VISIBLE_POINT_WINDOW = 1.5

const DEFAULT_VIDEO_IDS = ['tVlzKzKXjRw', 'aqz-KE-bpKQ', 'M7lc1UVf-VE']
const GRAPH_SOCKET_URL =
  'wss://ungallant-unimpeding-kade.ngrok-free.dev/0000000e9894eb8fe2c8c5f330ff78210eb909bc683a2fe89a9e2233fabf5354'
const GRAPH_SOCKET_PROTOCOLS = ['consequence.1']
const GRAPH_REQUEST_BODY = {
  type: 'get_graph',
  body: {
    public_key: '0000000000000000000000000000000000000000000=',
  },
}

const extractVideoId = (value: string): string | null => {
  const trimmed = value.trim()
  if (!trimmed.length) {
    return null
  }

  if (/^[\w-]{11}$/.test(trimmed)) {
    return trimmed
  }

  try {
    const url = new URL(trimmed)
    if (url.hostname.includes('youtu.be')) {
      const potentialId = url.pathname.split('/').filter(Boolean).at(-1)
      if (potentialId && /^[\w-]{11}$/.test(potentialId)) {
        return potentialId
      }
    }

    if (url.hostname.includes('youtube.com')) {
      const searchId = url.searchParams.get('v')
      if (searchId && /^[\w-]{11}$/.test(searchId)) {
        return searchId
      }

      const pathSegments = url.pathname.split('/').filter(Boolean)
      const potentialId = pathSegments.at(-1)
      if (potentialId && /^[\w-]{11}$/.test(potentialId)) {
        return potentialId
      }
    }
  } catch {
    // Ignore invalid URL parsing errors.
  }

  const inlineMatch = value.match(/[\w-]{11}/)
  return inlineMatch ? inlineMatch[0] : null
}

const formatTimecode = (seconds: number): string => {
  const wholeSeconds = Math.floor(seconds)
  const minutes = Math.floor(wholeSeconds / 60)
  const remainingSeconds = wholeSeconds % 60
  const milliseconds = Math.round((seconds - wholeSeconds) * 1000)

  const paddedSeconds = remainingSeconds.toString().padStart(2, '0')
  const paddedMilliseconds = milliseconds.toString().padStart(3, '0')

  return `${minutes}:${paddedSeconds}.${paddedMilliseconds}`
}

const createVideoTrack = (videoId: string, source: string, namespace?: string): VideoTrack => {
  const keyBase = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)
  return {
    key: `video-${keyBase}`,
    videoId,
    source,
    namespace,
    points: [],
  }
}

const parseGraphNodes = (dotGraph: string): Record<string, string>[] =>
  Array.from(dotGraph.matchAll(/"[^"]+"\s*\[(.*?)\];/g)).map((match) => {
    const attributes = match[1]
    const parsedAttributes: Record<string, string> = {}

    for (const attribute of attributes.matchAll(/(\w+)="([^"]*)"/g)) {
      const [, key, value] = attribute
      parsedAttributes[key] = value
    }

    return parsedAttributes
  })

const parseGraphVideos = (dotGraph: string): VideoTrack[] => {
  const nodes = parseGraphNodes(dotGraph)

  return nodes
    .map((node) => {
      const namespace = node.namespace?.trim()
      const memo = node.memo?.trim()

      if (!namespace || !memo) {
        return null
      }

      const videoId = extractVideoId(memo)
      if (!videoId) {
        return null
      }

      return createVideoTrack(videoId, memo, namespace)
    })
    .filter((value): value is VideoTrack => Boolean(value))
}

const parseGraphTags = (dotGraph: string): GraphTag[] => {
  const nodes = parseGraphNodes(dotGraph)

  return nodes
    .map((node) => {
      const publicKey = node.pubkey?.trim()
      const memo = node.memo?.trim()

      if (!publicKey || !memo) {
        return null
      }

      return { publicKey, memo }
    })
    .filter((value): value is GraphTag => Boolean(value))
}

const deriveBasePublicKeyForNamespace = (namespace: string): string => {
  const [first] = deriveGridPublicKeys(namespace, 1, 1)
  return first?.publicKey ?? ''
}

const deriveKeyGridForSecond = (
  namespace: string,
  second: number,
): Map<
  string,
  {
    row: number
    column: number
    xPercent: number
    yPercent: number
    time: number
  }
> => {
  const timeScopedNamespace = `${namespace}/T+${second}s`
  const keyGrid = deriveGridPublicKeys(timeScopedNamespace, TAG_GRID_ROWS, TAG_GRID_COLUMNS)

  const gridMap = new Map<
    string,
    { row: number; column: number; xPercent: number; yPercent: number; time: number }
  >()

  keyGrid.forEach((entry) => {
    const columnIndex = entry.address
    const rowIndex = entry.account

    gridMap.set(entry.publicKey, {
      row: rowIndex + 1,
      column: columnIndex + 1,
      xPercent: ((columnIndex + 0.5) / TAG_GRID_COLUMNS) * 100,
      yPercent: ((rowIndex + 0.5) / TAG_GRID_ROWS) * 100,
      time: second,
    })
  })

  return gridMap
}

const correlateGraphTagsToPoints = async (
  namespace: string,
  durationSeconds: number,
  tags: GraphTag[],
  videoKey: string,
  signal?: AbortSignal,
): Promise<PointOfInterest[]> => {
  if (!tags.length || durationSeconds <= 0) {
    return []
  }

  const floorDuration = Math.max(0, Math.floor(durationSeconds))
  const taggedMemos = new Map(tags.map((tag) => [tag.publicKey, tag.memo]))
  const points: PointOfInterest[] = []

  for (let second = 0; second <= floorDuration; second += 1) {
    if (signal?.aborted) {
      return []
    }

    const gridForSecond = deriveKeyGridForSecond(namespace, second)
    gridForSecond.forEach((value, publicKey) => {
      const memo = taggedMemos.get(publicKey)
      if (memo === undefined) {
        return
      }

      taggedMemos.delete(publicKey)
      points.push({
        id: `${videoKey}-${publicKey}`,
        note: memo,
        ...value,
      })
    })

    if (!taggedMemos.size) {
      break
    }

    if (second % 2 === 0) {
      // Yield frequently so long-running correlations don't block the UI thread.
      await waitForIdlePeriod()
    }
  }

  return points.sort((first, second) => first.time - second.time)
}

const requestGraphForKey = async (publicKey: string, signal?: AbortSignal) =>
  new Promise<string | null>((resolve) => {
    if (!publicKey) {
      resolve(null)
      return
    }

    const socket = new WebSocket(GRAPH_SOCKET_URL, GRAPH_SOCKET_PROTOCOLS)
    let settled = false

    const closeSocket = () => {
      try {
        socket.close()
      } catch (error) {
        console.error('Error closing WebSocket', error)
      }
    }

    const timer = window.setTimeout(() => {
      closeSocket()
      if (!settled) {
        settled = true
        resolve(null)
      }
    }, 8000)

    if (signal) {
      signal.addEventListener('abort', () => {
        window.clearTimeout(timer)
        closeSocket()
        if (!settled) {
          settled = true
          resolve(null)
        }
      })
    }

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'get_graph',
          body: { public_key: publicKey },
        }),
      )
    })

    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data?.type === 'graph' && typeof data.body?.graph === 'string') {
          settled = true
          resolve(data.body.graph)
          window.clearTimeout(timer)
          closeSocket()
        }
      } catch (error) {
        console.error('Error parsing graph response', error)
        if (!settled) {
          settled = true
          resolve(null)
          window.clearTimeout(timer)
          closeSocket()
        }
      }
    })

    socket.addEventListener('error', (event) => {
      console.error('WebSocket error', event)
      if (!settled) {
        settled = true
        resolve(null)
        window.clearTimeout(timer)
        closeSocket()
      }
    })

    socket.addEventListener('close', () => {
      window.clearTimeout(timer)
      if (!settled) {
        settled = true
        resolve(null)
      }
    })
  })

function App() {
  const [videos, setVideos] = useState<VideoTrack[]>(
    DEFAULT_VIDEO_IDS.map((id) => createVideoTrack(id, `https://www.youtube.com/watch?v=${id}`)),
  )
  const [gridScale, setGridScale] = useState(1)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [videoInput, setVideoInput] = useState('')
  const [videoError, setVideoError] = useState<string | null>(null)
  const [activeVideoKey, setActiveVideoKey] = useState<string | null>(null)
  const [playbackStates, setPlaybackStates] = useState<Record<string, PlaybackState>>({})
  const [isFetchingTags, setIsFetchingTags] = useState(false)

  const containerRefs = useRef(new Map<string, HTMLDivElement | null>())
  const overlayRefs = useRef(new Map<string, HTMLDivElement | null>())
  const playerRefs = useRef(new Map<string, YouTubePlayer>())
  const fetchedTagsRef = useRef(new Set<string>())

  const publicKeysByVideoKey = useMemo(() => {
    const entries: Array<[string, string]> = []

    videos.forEach((video) => {
      if (video.namespace) {
        const { publicKey } = deriveNamespacePublicKey(video.namespace)
        entries.push([video.key, publicKey])
      }
    })

    return new Map(entries)
  }, [videos])

  const baseYouTubeOptions = useMemo(
    () => ({
      width: '100%',
      height: '100%',
      playerVars: {
        controls: 0,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        fs: 0,
        loop: 1,
      },
    }),
    [],
  )

  const rows = useMemo(() => GRID_ASPECT_HEIGHT * gridScale, [gridScale])
  const columns = useMemo(() => GRID_ASPECT_WIDTH * gridScale, [gridScale])

  const gridTemplateStyle = useMemo(
    () => ({
      gridTemplateRows: `repeat(${rows}, 1fr)`,
      gridTemplateColumns: `repeat(${columns}, 1fr)`,
    }),
    [rows, columns],
  )

  useEffect(() => {
    const allKeys = new Set(videos.map((video) => video.key))
    playerRefs.current.forEach((_, key) => {
      if (!allKeys.has(key)) {
        playerRefs.current.delete(key)
      }
    })
    overlayRefs.current.forEach((_, key) => {
      if (!allKeys.has(key)) {
        overlayRefs.current.delete(key)
      }
    })
    setPlaybackStates((previous) => {
      const next: Record<string, PlaybackState> = {}
      allKeys.forEach((key) => {
        if (previous[key]) {
          next[key] = previous[key]
        }
      })
      return next
    })
  }, [videos])

  useEffect(() => {
    if (activeVideoKey && videos.some((video) => video.key === activeVideoKey)) {
      return
    }

    const firstVideo = videos[0]
    setActiveVideoKey(firstVideo ? firstVideo.key : null)
  }, [activeVideoKey, videos])

  useEffect(() => {
    if (!videos.length) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntries = entries.filter((entry) => entry.isIntersecting)
        if (!visibleEntries.length) {
          return
        }

        const bestEntry = visibleEntries.reduce((best, current) =>
          current.intersectionRatio > best.intersectionRatio ? current : best,
        )

        const key = bestEntry.target.getAttribute('data-video-key')
        if (key && key !== activeVideoKey) {
          setActiveVideoKey(key)
        }
      },
      {
        threshold: [0.65],
      },
    )

    const observedNodes: Element[] = []

    videos.forEach((video) => {
      const node = containerRefs.current.get(video.key)
      if (node) {
        observer.observe(node)
        observedNodes.push(node)
      }
    })

    return () => {
      observedNodes.forEach((node) => observer.unobserve(node))
      observer.disconnect()
    }
  }, [videos, activeVideoKey])

  useEffect(() => {
    playerRefs.current.forEach((player, key) => {
      if (key === activeVideoKey) {
        player.playVideo?.()
      } else {
        player.pauseVideo?.()
      }
    })
  }, [activeVideoKey])

  useEffect(() => {
    if (!activeVideoKey) {
      return undefined
    }

    let frameId: number

    const update = () => {
      const player = playerRefs.current.get(activeVideoKey)
      if (player) {
        const currentTime = player.getCurrentTime?.() ?? 0
        const duration = player.getDuration?.() ?? 0

        setPlaybackStates((previous) => {
          const previousState = previous[activeVideoKey]
          if (
            !previousState ||
            Math.abs(previousState.currentTime - currentTime) > 0.05 ||
            Math.abs(previousState.duration - duration) > 0.1
          ) {
            return {
              ...previous,
              [activeVideoKey]: {
                currentTime,
                duration,
              },
            }
          }

          return previous
        })
      }

      frameId = requestAnimationFrame(update)
    }

    frameId = requestAnimationFrame(update)

    return () => {
      cancelAnimationFrame(frameId)
    }
  }, [activeVideoKey])

  useEffect(() => {
    const abortController = new AbortController()

    const pendingVideos = videos.filter((video) => {
      const duration = playbackStates[video.key]?.duration ?? 0
      return (
        Boolean(video.namespace) &&
        duration > 0 &&
        !fetchedTagsRef.current.has(video.key)
      )
    })

    if (!pendingVideos.length) {
      return () => abortController.abort()
    }

    setIsFetchingTags(true)

    const loadTags = async () => {
      try {
        for (const video of pendingVideos) {
          if (!video.namespace || abortController.signal.aborted) {
            return
          }

          const duration = playbackStates[video.key]?.duration ?? 0
          const basePublicKey = deriveBasePublicKeyForNamespace(video.namespace)
          const graph = await requestGraphForKey(basePublicKey, abortController.signal)

          if (!graph || abortController.signal.aborted) {
            fetchedTagsRef.current.add(video.key)
            continue
          }

          const tags = parseGraphTags(graph)
          const points = await correlateGraphTagsToPoints(
            video.namespace,
            duration,
            tags,
            video.key,
            abortController.signal,
          )

          if (abortController.signal.aborted) {
            return
          }

          setVideos((previous) =>
            previous.map((entry) => (entry.key === video.key ? { ...entry, points } : entry)),
          )

          fetchedTagsRef.current.add(video.key)

          await waitForIdlePeriod()
        }
      } catch (error) {
        console.error('Error loading tags', error)
      } finally {
        if (!abortController.signal.aborted) {
          setIsFetchingTags(false)
        }
      }
    }

    loadTags()

    return () => {
      abortController.abort()
      setIsFetchingTags(false)
    }
  }, [playbackStates, videos])

  const registerContainerRef = useCallback(
    (key: string) =>
      (node: HTMLDivElement | null) => {
        containerRefs.current.set(key, node)
      },
    [],
  )

  const registerOverlayRef = useCallback(
    (key: string) =>
      (node: HTMLDivElement | null) => {
        overlayRefs.current.set(key, node)
      },
    [],
  )

  const handlePlayerReady = useCallback(
    (key: string) =>
      (event: YouTubeEvent) => {
        const player = event.target
        player.mute()
        playerRefs.current.set(key, player)

        if (key === activeVideoKey) {
          player.playVideo?.()
        } else {
          player.pauseVideo?.()
        }
      },
    [activeVideoKey],
  )

  const handleVideoEnd = useCallback(
    (key: string) =>
      (event: YouTubeEvent) => {
        const player = event.target
        player.seekTo?.(0)

        if (key === activeVideoKey) {
          player.playVideo?.()
        } else {
          player.pauseVideo?.()
        }
      },
    [activeVideoKey],
  )

  const handleAddVideo = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()

      const id = extractVideoId(videoInput)
      if (!id) {
        setVideoError('Enter a valid YouTube URL or 11-character video ID.')
        return
      }

      setVideos((previous) => [createVideoTrack(id, videoInput), ...previous])
      setVideoInput('')
      setVideoError(null)
    },
    [videoInput],
  )

  const handleRemoveVideo = useCallback(
    (key: string) => {
      setVideos((previous) => previous.filter((video) => video.key !== key))
      setEditingPoint((previous) => {
        if (previous && previous.videoKey === key) {
          return null
        }
        return previous
      })
    },
    [],
  )

  useEffect(() => {
    let isActive = true

    requestGraphForKey(GRAPH_REQUEST_BODY.body.public_key)
      .then((graph) => {
        if (!isActive || !graph) {
          return
        }

        const graphVideos = parseGraphVideos(graph)
        if (graphVideos.length) {
          setVideos(graphVideos)
        }
      })
      .catch((error) => {
        console.error('Error fetching graph for videos', error)
      })

    return () => {
      isActive = false
    }
  }, [])

  const clampGridScale = useCallback(
    (scale: number) => Math.min(MAX_GRID_SCALE, Math.max(MIN_GRID_SCALE, scale)),
    [],
  )

  const handleRowsChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseInt(event.target.value, 10)
      if (Number.isNaN(value)) {
        return
      }

      const nextScale = clampGridScale(
        Math.max(MIN_GRID_SCALE, Math.round(value / GRID_ASPECT_HEIGHT)),
      )
      setGridScale(nextScale)
    },
    [clampGridScale],
  )

  const handleColumnsChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseInt(event.target.value, 10)
      if (Number.isNaN(value)) {
        return
      }

      const nextScale = clampGridScale(
        Math.max(MIN_GRID_SCALE, Math.round(value / GRID_ASPECT_WIDTH)),
      )
      setGridScale(nextScale)
    },
    [clampGridScale],
  )
  const gridCellsForVideo = useCallback(
    (videoKey: string) =>
      Array.from({ length: rows * columns }, (_, index) => {
        const rowIndex = Math.floor(index / columns)
        const columnIndex = index % columns

        return (
          <div
            key={`${videoKey}-${rowIndex}-${columnIndex}`}
            className="grid-cell"
            aria-label={`Row ${rowIndex + 1}, column ${columnIndex + 1}`}
            role="presentation"
          />
        )
      }),
    [columns, rows],
  )

  return (
    <div className="app">
      <header className="app__header">
        <h1>Vertical Video Annotator</h1>
        <p className="app__subtitle">
          Scroll through the feed, automatically focus on the active video, and tap the grid to
          capture annotations in real time.
        </p>
        {isFetchingTags ? <p className="app__status">Loading tags from the graph…</p> : null}
      </header>

      <div className="feed">
        {videos.map((video) => {
          const playback = playbackStates[video.key] ?? { currentTime: 0, duration: 0 }
          const activePoints = video.points.filter(
            (point) => Math.abs(point.time - playback.currentTime) <= VISIBLE_POINT_WINDOW / 2,
          )
          const publicKey = publicKeysByVideoKey.get(video.key)
          const timelineMarkers = playback.duration
            ? video.points.map((point) => ({
                id: point.id,
                left: (point.time / playback.duration) * 100,
                isActive:
                  Math.abs(point.time - playback.currentTime) <= VISIBLE_POINT_WINDOW / 2,
              }))
            : []
          const progressPercent = playback.duration
            ? Math.min(100, Math.max(0, (playback.currentTime / playback.duration) * 100))
            : 0

          return (
            <section
              key={video.key}
              ref={registerContainerRef(video.key)}
              data-video-key={video.key}
              className={
                activeVideoKey === video.key ? 'video-card video-card--active' : 'video-card'
              }
            >
              <div className="video-card__meta">
                <div className="video-card__heading">
                  {video.namespace ? (
                    <div className="video-card__namespace-group">
                      <span className="video-card__namespace">{video.namespace}</span>
                      {publicKey ? (
                        <div className="video-card__key">
                          <span className="video-card__key-label">ED25519 Public Key</span>
                          <span className="video-card__public-key">{publicKey}</span>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <a
                    className="video-card__link"
                    href={video.source}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {video.source}
                  </a>
                </div>
                <span className="video-card__status">
                  {activeVideoKey === video.key ? 'Now playing' : 'Paused'}
                </span>
              </div>

              <div className="video-stage">
                <div className="video-stage__frame" style={{ paddingTop: GRID_PADDING_PERCENT }}>
                  <YouTube
                    videoId={video.videoId}
                    opts={{
                      ...baseYouTubeOptions,
                      playerVars: {
                        ...(baseYouTubeOptions.playerVars ?? {}),
                        playlist: video.videoId,
                      },
                    }}
                    onReady={handlePlayerReady(video.key)}
                    onEnd={handleVideoEnd(video.key)}
                    className="video-stage__player"
                    iframeClassName="video-stage__player"
                  />
                </div>
                <div
                  ref={registerOverlayRef(video.key)}
                  className="video-grid"
                  style={gridTemplateStyle}
                  data-active={activeVideoKey === video.key}
                >
                  {gridCellsForVideo(video.key)}
                  {activePoints.map((point) => {
                    return (
                      <div
                        key={point.id}
                        className="poi-marker"
                        style={{
                          left: `${point.xPercent}%`,
                          top: `${point.yPercent}%`,
                        }}
                      >
                        <span className="poi-callout__time">{formatTimecode(point.time)}</span>
                        <div className="poi-callout__note">{point.note}</div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {playback.duration > 0 ? (
                <div className="timeline" aria-hidden="true">
                  <div className="timeline__track">
                    <div
                      className="timeline__progress"
                      style={{ width: `${progressPercent}%` }}
                    />
                    {timelineMarkers.map((marker) => (
                      <div
                        key={marker.id}
                        className={
                          marker.isActive
                            ? 'timeline__marker timeline__marker--active'
                            : 'timeline__marker'
                        }
                        style={{ left: `${marker.left}%` }}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

            </section>
          )
        })}
      </div>

      <button
        type="button"
        className="drawer-toggle"
        onClick={() => setIsDrawerOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={isDrawerOpen ? 'true' : 'false'}
      >
        Open settings
      </button>

      <div className={isDrawerOpen ? 'drawer drawer--open' : 'drawer'} role="presentation">
        <div className="drawer__backdrop" onClick={() => setIsDrawerOpen(false)} aria-hidden />
        <aside className="drawer__panel" role="dialog" aria-modal="true" aria-label="Settings">
          <header className="drawer__header">
            <h2>Feed settings</h2>
            <button type="button" className="drawer__close" onClick={() => setIsDrawerOpen(false)}>
              Close
            </button>
          </header>

          <section className="drawer__section">
            <h3>Add a video</h3>
            <form className="drawer__form" onSubmit={handleAddVideo}>
              <label className="field">
                <span className="field__label">YouTube URL or ID</span>
                <input
                  value={videoInput}
                  onChange={(event) => setVideoInput(event.target.value)}
                  placeholder="https://www.youtube.com/shorts/..."
                  className={videoError ? 'field__input field__input--error' : 'field__input'}
                  aria-invalid={videoError ? 'true' : 'false'}
                />
              </label>
              {videoError ? (
                <p className="field__error" role="alert">
                  {videoError}
                </p>
              ) : null}
              <button type="submit" className="button primary">
                Add video to feed
              </button>
            </form>
          </section>

          <section className="drawer__section">
            <h3>Grid size</h3>
            <div className="drawer__grid-controls">
              <label className="field compact">
                <span className="field__label">Rows</span>
                <input
                  type="number"
                  min={GRID_ASPECT_HEIGHT * MIN_GRID_SCALE}
                  max={GRID_ASPECT_HEIGHT * MAX_GRID_SCALE}
                  step={GRID_ASPECT_HEIGHT}
                  value={rows}
                  onChange={handleRowsChange}
                  className="field__input"
                />
              </label>
              <label className="field compact">
                <span className="field__label">Columns</span>
                <input
                  type="number"
                  min={GRID_ASPECT_WIDTH * MIN_GRID_SCALE}
                  max={GRID_ASPECT_WIDTH * MAX_GRID_SCALE}
                  step={GRID_ASPECT_WIDTH}
                  value={columns}
                  onChange={handleColumnsChange}
                  className="field__input"
                />
              </label>
            </div>
          </section>

          <section className="drawer__section">
            <h3>Feed order</h3>
            {videos.length ? (
              <ul className="drawer__video-list">
                {videos.map((video) => (
                  <li key={video.key} className="drawer__video-item">
                    <span className="drawer__video-label">{video.source}</span>
                    <button
                      type="button"
                      className="button button--danger"
                      onClick={() => handleRemoveVideo(video.key)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="drawer__empty">Add a YouTube Short to get started.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}

export default App
