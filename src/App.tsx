import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import YouTube from 'react-youtube'
import type { YouTubeEvent, YouTubePlayer } from 'react-youtube'
import './App.css'
import { deriveNamespacePublicKey } from './hdWallet'

type PointOfInterest = {
  id: string
  time: number
  row: number
  column: number
  xPercent: number
  yPercent: number
  note: string
  isReadOnly?: boolean
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

const GRID_PADDING_PERCENT = '177.78%'
const GRID_ASPECT_WIDTH = 9
const GRID_ASPECT_HEIGHT = 16
const MIN_GRID_SCALE = 1
const MAX_GRID_SCALE = 4
const VISIBLE_POINT_WINDOW = 1.5

const DEFAULT_VIDEO_IDS = ['tVlzKzKXjRw', 'aqz-KE-bpKQ', 'M7lc1UVf-VE']
const DEFAULT_GRAPH_SOCKET_URL =
  'wss://ungallant-unimpeding-kade.ngrok-free.dev/00000063e8951c027db2a54567aa9798c71b1820cffdb096a61e72fe82f6d8e0'
const GRAPH_SOCKET_PROTOCOLS = ['consequence.1']
const DEFAULT_GRAPH_REQUEST_PUBLIC_KEY = '0000000000000000000000000000000000000000000='

type GraphNode = Record<string, string>

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
  } catch (error) {
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

const parseGraphNodes = (dotGraph: string): GraphNode[] =>
  Array.from(dotGraph.matchAll(/"[^"]+"\s*\[(.*?)\];/g)).map((match) => {
    const attributes = match[1]
    const parsedAttributes: GraphNode = {}

    for (const attribute of attributes.matchAll(/(\w+)="([^"]*)"/g)) {
      const [, key, value] = attribute
      parsedAttributes[key] = value
    }

    return parsedAttributes
  })

const parseGraphVideos = (nodes: GraphNode[]): VideoTrack[] => {
  const tracks: VideoTrack[] = []

  nodes.forEach((node) => {
    const namespace = node.namespace?.trim()
    const memo = node.memo?.trim()

    if (!namespace || !memo) {
      return
    }

    const videoId = extractVideoId(memo)
    if (videoId) {
      tracks.push(createVideoTrack(videoId, memo, namespace))
    }
  })

  return tracks
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const parseTagPointsForNamespace = (nodes: GraphNode[], namespace?: string): PointOfInterest[] => {
  if (!namespace) {
    return []
  }

  const pattern = new RegExp(`^${escapeRegExp(namespace)}/T\\+(\\d+)s/(\\d+)x(\\d+)/`)

  return nodes
    .reduce<PointOfInterest[]>((points, node) => {
      const memo = node.memo?.trim()
      const pubkey = node.pubkey?.trim()

      if (!memo || !pubkey) {
        return points
      }

      const match = pubkey.match(pattern)
      if (!match) {
        return points
      }

      const [, timeString, columnString, rowString] = match
      const time = Number.parseInt(timeString, 10)
      const column = Number.parseInt(columnString, 10)
      const row = Number.parseInt(rowString, 10)

      if (Number.isNaN(time) || Number.isNaN(column) || Number.isNaN(row)) {
        return points
      }

      const xPercent = ((column - 0.5) / GRID_ASPECT_WIDTH) * 100
      const yPercent = ((row - 0.5) / GRID_ASPECT_HEIGHT) * 100

      points.push({
        id: pubkey,
        time,
        row,
        column,
        xPercent,
        yPercent,
        note: memo,
        isReadOnly: true,
      })

      return points
    }, [])
    .sort((a, b) => a.time - b.time)
}

const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const formatMemoHtml = (memo: string): string => {
  const escaped = escapeHtml(memo)
  const withBold = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  const withItalics = withBold.replace(/(^|\s)_(.+?)_([^\w]|$)/g, '$1<em>$2</em>$3').replace(/\*(.+?)\*/g, '<em>$1</em>')
  const withLinks = withItalics.replace(
    /(https?:\/\/[\w\-.~%/?#[\]@!$&'()*+,;=:]+)|(www\.[\w\-.~%/?#[\]@!$&'()*+,;=:]+)/gi,
    (match) => {
      const href = match.startsWith('http') ? match : `https://${match}`
      return `<a href="${href}" target="_blank" rel="noreferrer">${match}</a>`
    },
  )
  return withLinks.replace(/\n/g, '<br />')
}

const normalizeSocketUrl = (value: string): string | null => {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const hasProtocol = trimmed.startsWith('ws://') || trimmed.startsWith('wss://')
  const candidate = hasProtocol ? trimmed : `wss://${trimmed}`

  try {
    const url = new URL(candidate)
    if (!url.protocol.startsWith('ws')) {
      return null
    }
    return url.toString()
  } catch (error) {
    return null
  }
}

function App() {
  const [videos, setVideos] = useState<VideoTrack[]>(
    DEFAULT_VIDEO_IDS.map((id) => createVideoTrack(id, `https://www.youtube.com/watch?v=${id}`)),
  )
  const [gridScale, setGridScale] = useState(1)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [isAnnotationLocked, setIsAnnotationLocked] = useState(false)
  const [isShiftHeld, setIsShiftHeld] = useState(false)
  const [videoInput, setVideoInput] = useState('')
  const [videoError, setVideoError] = useState<string | null>(null)
  const [activeVideoKey, setActiveVideoKey] = useState<string | null>(null)
  const [editingPoint, setEditingPoint] = useState<{
    videoKey: string
    pointId: string
  } | null>(null)
  const [playbackStates, setPlaybackStates] = useState<Record<string, PlaybackState>>({})
  const [socketUrl, setSocketUrl] = useState(DEFAULT_GRAPH_SOCKET_URL)
  const [socketUrlInput, setSocketUrlInput] = useState(DEFAULT_GRAPH_SOCKET_URL)
  const [socketVersion, setSocketVersion] = useState(0)
  const [socketError, setSocketError] = useState<string | null>(null)

  const containerRefs = useRef(new Map<string, HTMLDivElement | null>())
  const overlayRefs = useRef(new Map<string, HTMLDivElement | null>())
  const playerRefs = useRef(new Map<string, YouTubePlayer>())
  const socketRef = useRef<WebSocket | null>(null)
  const requestedPublicKeysRef = useRef(new Set<string>())

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

  const isAnnotationInteractionEnabled = useMemo(
    () => isAnnotationLocked || isShiftHeld || Boolean(editingPoint),
    [isAnnotationLocked, isShiftHeld, editingPoint],
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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setIsShiftHeld(true)
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setIsShiftHeld(false)
      }
    }

    const handleWindowBlur = () => setIsShiftHeld(false)

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleWindowBlur)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [])

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
    const normalizedUrl = normalizeSocketUrl(socketUrl)
    if (!normalizedUrl) {
      setSocketError('Enter a valid WebSocket URL to load graph data.')
      return undefined
    }

    let socket: WebSocket | null = null

    try {
      socket = new WebSocket(normalizedUrl, GRAPH_SOCKET_PROTOCOLS)
      setSocketError(null)
    } catch (error) {
      console.error('Error creating WebSocket', error)
      setSocketError('Unable to connect with the provided WebSocket URL.')
      return undefined
    }

    socketRef.current = socket
    requestedPublicKeysRef.current.clear()

    const sendGraphRequest = (publicKey: string) => {
      socket?.send(
        JSON.stringify({
          type: 'get_graph',
          body: {
            public_key: publicKey,
          },
        }),
      )
    }

    socket.addEventListener('open', () => {
      sendGraphRequest(DEFAULT_GRAPH_REQUEST_PUBLIC_KEY)
      publicKeysByVideoKey.forEach((publicKey) => {
        sendGraphRequest(publicKey)
        requestedPublicKeysRef.current.add(publicKey)
      })
    })

    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data?.type === 'graph' && typeof data.body?.graph === 'string') {
          const nodes = parseGraphNodes(data.body.graph)

          setVideos((previous) => {
            const graphVideos = parseGraphVideos(nodes)
            const baseVideos = graphVideos.length ? graphVideos : previous

            return baseVideos.map((video) => {
              const tagPoints = parseTagPointsForNamespace(nodes, video.namespace)
              if (tagPoints.length) {
                return {
                  ...video,
                  points: tagPoints,
                }
              }

              return video
            })
          })
        }
      } catch (error) {
        console.error('Error parsing graph message', error)
      }
    })

    socket.addEventListener('error', (event) => {
      console.error('WebSocket error', event)
      setSocketError('WebSocket connection error. Check the URL and try again.')
    })

    socket.addEventListener('close', () => {
      setSocketError((previous) => previous ?? 'WebSocket connection closed.')
    })

    return () => {
      socket?.close()
      socketRef.current = null
    }
  }, [socketUrl, socketVersion])

  useEffect(() => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return
    }

    publicKeysByVideoKey.forEach((publicKey) => {
      if (requestedPublicKeysRef.current.has(publicKey)) {
        return
      }

      socket.send(
        JSON.stringify({
          type: 'get_graph',
          body: {
            public_key: publicKey,
          },
        }),
      )
      requestedPublicKeysRef.current.add(publicKey)
    })
  }, [publicKeysByVideoKey])

  const handleSocketSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const normalizedUrl = normalizeSocketUrl(socketUrlInput)

      if (!normalizedUrl) {
        setSocketError('Enter a valid WebSocket URL to load graph data.')
        return
      }

      setSocketUrl(normalizedUrl)
      setSocketVersion((previous) => previous + 1)
      setSocketError(null)
    },
    [socketUrlInput],
  )

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

  const logVideoPoints = useCallback((videoKey: string, points: PointOfInterest[]) => {
    console.log(`Annotations for ${videoKey}`, points)
  }, [])

  const updatePointNote = useCallback(
    (videoKey: string, pointId: string, note: string) => {
      setVideos((previous) => {
        const next = previous.map((video) =>
          video.key === videoKey
            ? {
                ...video,
                points: video.points.map((point) =>
                  point.id === pointId && !point.isReadOnly
                    ? {
                        ...point,
                        note,
                      }
                    : point,
                ),
              }
            : video,
        )

        const target = next.find((video) => video.key === videoKey)
        if (target) {
          logVideoPoints(videoKey, target.points)
        }

        return next
      })
    },
    [logVideoPoints],
  )

  const removePoint = useCallback(
    (videoKey: string, pointId: string) => {
      setVideos((previous) => {
        const next = previous.map((video) =>
          video.key === videoKey
            ? {
                ...video,
                points: video.points.filter((point) => point.id !== pointId),
              }
            : video,
        )

        const target = next.find((video) => video.key === videoKey)
        if (target) {
          logVideoPoints(videoKey, target.points)
        }

        return next
      })
    },
    [logVideoPoints],
  )

  const resumeVideoIfNeeded = useCallback(
    (videoKey: string) => {
      const player = playerRefs.current.get(videoKey)
      if (player && activeVideoKey === videoKey) {
        player.playVideo?.()
      }
    },
    [activeVideoKey],
  )

  const startEditingPoint = useCallback((videoKey: string, pointId: string) => {
    const player = playerRefs.current.get(videoKey)
    player?.pauseVideo?.()
    setEditingPoint({ videoKey, pointId })
  }, [])

  const stopEditingPoint = useCallback(
    (videoKey: string, pointId: string) => {
      setEditingPoint((previous) => {
        if (previous && previous.videoKey === videoKey && previous.pointId === pointId) {
          resumeVideoIfNeeded(videoKey)
          return null
        }

        return previous
      })
    },
    [resumeVideoIfNeeded],
  )

  const registerPoint = useCallback(
    (videoKey: string, rowIndex: number, columnIndex: number) =>
      (event: React.MouseEvent<HTMLButtonElement>) => {
        if (!isAnnotationInteractionEnabled) {
          return
        }

        const player = playerRefs.current.get(videoKey)
        if (!player) {
          return
        }

        const overlay = overlayRefs.current.get(videoKey)
        const currentTime = player.getCurrentTime?.() ?? 0
        const overlayRect = overlay?.getBoundingClientRect()
        const clickX = event.clientX
        const clickY = event.clientY

        let xPercent = ((columnIndex + 0.5) / columns) * 100
        let yPercent = ((rowIndex + 0.5) / rows) * 100

        if (overlayRect && overlayRect.width > 0 && overlayRect.height > 0) {
          xPercent = ((clickX - overlayRect.left) / overlayRect.width) * 100
          yPercent = ((clickY - overlayRect.top) / overlayRect.height) * 100
        }

        const id = `${videoKey}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`

        const newPoint: PointOfInterest = {
          id,
          time: currentTime,
          row: rowIndex + 1,
          column: columnIndex + 1,
          xPercent,
          yPercent,
          note: '',
        }

        setVideos((previous) => {
          const next = previous.map((video) =>
            video.key === videoKey
              ? {
                  ...video,
                  points: [...video.points, newPoint].sort((a, b) => a.time - b.time),
                }
              : video,
          )

          const target = next.find((video) => video.key === videoKey)
          if (target) {
            logVideoPoints(videoKey, target.points)
          }

          return next
        })

        startEditingPoint(videoKey, id)
      },
    [columns, rows, logVideoPoints, startEditingPoint, isAnnotationInteractionEnabled],
  )

  const gridCellsForVideo = useCallback(
    (videoKey: string) =>
      Array.from({ length: rows * columns }, (_, index) => {
        const rowIndex = Math.floor(index / columns)
        const columnIndex = index % columns

        return (
          <button
            key={`${videoKey}-${rowIndex}-${columnIndex}`}
            type="button"
            className="grid-cell"
            onClick={registerPoint(videoKey, rowIndex, columnIndex)}
            aria-label={`Mark row ${rowIndex + 1}, column ${columnIndex + 1}`}
          />
        )
      }),
    [columns, rows, registerPoint],
  )

  return (
    <div className="app">
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
                  data-annotation-active={isAnnotationInteractionEnabled ? 'true' : 'false'}
                >
                  {gridCellsForVideo(video.key)}
                  {activePoints.map((point) => {
                    const isEditing =
                      editingPoint?.videoKey === video.key && editingPoint.pointId === point.id
                    const canEdit = !point.isReadOnly

                    const calloutContent = (
                      <>
                        <span className="poi-callout__time">{formatTimecode(point.time)}</span>
                        <span
                          className="poi-callout__note"
                          dangerouslySetInnerHTML={{
                            __html: formatMemoHtml(point.note || 'Add a note'),
                          }}
                        />
                      </>
                    )

                    return (
                      <div
                        key={point.id}
                        className={isEditing ? 'poi-marker poi-marker--editing' : 'poi-marker'}
                        style={{
                          left: `${point.xPercent}%`,
                          top: `${point.yPercent}%`,
                        }}
                      >
                        {canEdit && isEditing ? (
                          <div className="poi-editor">
                            <input
                              autoFocus
                              type="text"
                              className="poi-editor__input"
                              value={point.note}
                              placeholder="Add a note"
                              onChange={(event) =>
                                updatePointNote(video.key, point.id, event.target.value)
                              }
                              onBlur={() => stopEditingPoint(video.key, point.id)}
                            />
                            <div className="poi-editor__actions">
                              <button
                                type="button"
                                className="poi-editor__remove"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  stopEditingPoint(video.key, point.id)
                                  removePoint(video.key, point.id)
                                }}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        ) : canEdit ? (
                          <button
                            type="button"
                            className="poi-marker__trigger"
                            onClick={() => startEditingPoint(video.key, point.id)}
                          >
                            {calloutContent}
                          </button>
                        ) : (
                          <div className="poi-marker__content">{calloutContent}</div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="annotation-controls">
                <div className="annotation-controls__status">
                  <span className="annotation-controls__mode">
                    {isAnnotationInteractionEnabled ? 'Annotation mode active' : 'Playback-first mode'}
                  </span>
                  <span className="annotation-controls__hint">
                    Hold Shift to place or edit annotations without blocking the YouTube player.
                  </span>
                </div>
                <button
                  type="button"
                  className={
                    isAnnotationLocked
                      ? 'annotation-controls__toggle annotation-controls__toggle--active'
                      : 'annotation-controls__toggle'
                  }
                  onClick={() => setIsAnnotationLocked((previous) => !previous)}
                >
                  {isAnnotationLocked ? 'Disable annotation lock' : 'Lock annotation mode'}
                </button>
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
            <h3>WebSocket</h3>
            <form className="drawer__form" onSubmit={handleSocketSubmit}>
              <label className="field">
                <span className="field__label">Graph WebSocket URL</span>
                <input
                  value={socketUrlInput}
                  onChange={(event) => setSocketUrlInput(event.target.value)}
                  placeholder={DEFAULT_GRAPH_SOCKET_URL}
                  className={socketError ? 'field__input field__input--error' : 'field__input'}
                />
              </label>
              {socketError ? (
                <p className="field__error" role="alert">
                  {socketError}
                </p>
              ) : null}
              <button type="submit" className="button primary">
                Apply WebSocket URL
              </button>
            </form>
          </section>

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
