import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { hmac } from '@noble/hashes/hmac.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import nacl from 'tweetnacl'
import YouTube from 'react-youtube'
import type { YouTubeEvent, YouTubePlayer } from 'react-youtube'
import './App.css'

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

type GraphNode = {
  namespace?: string
  memo?: string
  pubkey?: string
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
const GRAPH_SOCKET_URL =
  'wss://ungallant-unimpeding-kade.ngrok-free.dev/0000000e9894eb8fe2c8c5f330ff78210eb909bc683a2fe89a9e2233fabf5354'
const GRAPH_SOCKET_PROTOCOLS = ['consequence.1']
const GRAPH_REQUEST_BODY = {
  type: 'get_graph',
  body: {
    public_key: '0000000000000000000000000000000000000000000=',
  },
}

const NUM_TAG_ACCOUNTS = GRID_ASPECT_HEIGHT
const NUM_TAG_ADDRESSES = GRID_ASPECT_WIDTH

const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))

// Simple HMAC-SHA512 HD key derivation
const deriveHDSeed = (seed: Uint8Array, account: number, address: number): Uint8Array => {
  const label = new TextEncoder().encode('necessitated/premises')
  const indexBytes = new Uint8Array([account, address])
  const input = new Uint8Array([...seed, ...indexBytes])
  const digest = hmac(sha512, label, input)
  return digest.slice(0, 32)
}

const generateHDKeypair = (mnemonic: string, account: number, address: number) => {
  const masterSeed = mnemonicToSeedSync(mnemonic)
  const derivedSeed = deriveHDSeed(new Uint8Array(masterSeed), account, address)
  const keypair = nacl.sign.keyPair.fromSeed(derivedSeed)
  return {
    path: `m/${account}/${address}`,
    publicKey: toBase64(keypair.publicKey),
  }
}

const generateMnemonic = (passphrase: string): string => {
  const hash = sha512(utf8ToBytes(passphrase))
  const entropy = hash.slice(0, 32)
  return entropyToMnemonic(entropy, wordlist)
}

const buildKeyGrid = (mnemonic: string, accounts: number, addresses: number) =>
  Array.from({ length: accounts }).flatMap((_, accountIndex) =>
    Array.from({ length: addresses }).map((__, addressIndex) => ({
      accountIndex,
      addressIndex,
      ...generateHDKeypair(mnemonic, accountIndex, addressIndex),
    })),
  )

const publicKeyForNamespace = (namespace: string): string => {
  const mnemonic = generateMnemonic(namespace)
  return generateHDKeypair(mnemonic, 0, 0).publicKey
}

const keyGridForSecond = (namespace: string, second: number) =>
  buildKeyGrid(generateMnemonic(`${namespace}/T+${second}s`), NUM_TAG_ACCOUNTS, NUM_TAG_ADDRESSES)

const parseGraphNodes = (dotGraph: string): GraphNode[] =>
  Array.from(dotGraph.matchAll(/"[^"]+"\s*\[(.*?)\];/g)).map((match) => {
    const attributes = match[1]
    const parsedAttributes: Record<string, string> = {}

    for (const attribute of attributes.matchAll(/(\w+)="([^"]*)"/g)) {
      const [, key, value] = attribute
      parsedAttributes[key] = value
    }

    return parsedAttributes
  })

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

const parseGraphVideos = (dotGraph: string): VideoTrack[] =>
  parseGraphNodes(dotGraph)
    .map((node) => ({ namespace: node.namespace?.trim(), memo: node.memo?.trim() }))
    .filter((node): node is { namespace: string; memo: string } => Boolean(node.namespace && node.memo))
    .reduce<VideoTrack[]>((tracks, { namespace, memo }) => {
      const videoId = extractVideoId(memo)
      if (videoId) {
        tracks.push(createVideoTrack(videoId, memo, namespace))
      }
      return tracks
    }, [])

const requestGraph = (publicKey: string, signal?: AbortSignal): Promise<string | null> =>
  new Promise((resolve) => {
    let isSettled = false
    const socket = new WebSocket(GRAPH_SOCKET_URL, GRAPH_SOCKET_PROTOCOLS)

    const settle = (graph: string | null) => {
      if (isSettled) {
        return
      }
      isSettled = true
      resolve(graph)
      socket.close()
    }

    const abortListener = () => settle(null)
    signal?.addEventListener('abort', abortListener, { once: true })

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          ...GRAPH_REQUEST_BODY,
          body: {
            ...GRAPH_REQUEST_BODY.body,
            public_key: publicKey,
          },
        }),
      )
    })

    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data?.type === 'graph' && typeof data.body?.graph === 'string') {
          settle(data.body.graph)
        }
      } catch (error) {
        console.error('Error parsing graph message', error)
      }
    })

    socket.addEventListener('error', (event) => {
      console.error('WebSocket error', event)
      settle(null)
    })

    socket.addEventListener('close', () => {
      settle(null)
    })
  })

const pointPositionPercent = (index: number, total: number) => ((index + 0.5) / total) * 100

const correlateGraphTags = (
  namespace: string,
  durationSeconds: number,
  nodes: GraphNode[],
): PointOfInterest[] => {
  const pubkeyToMemo = new Map<string, string>()
  nodes.forEach((node) => {
    if (node.pubkey) {
      pubkeyToMemo.set(node.pubkey.trim(), node.memo?.trim() ?? '')
    }
  })

  if (!pubkeyToMemo.size) {
    return []
  }

  const points: PointOfInterest[] = []

  for (let second = 0; second <= durationSeconds; second += 1) {
    const keyGrid = keyGridForSecond(namespace, second)
    keyGrid.forEach(({ accountIndex, addressIndex, publicKey }) => {
      const memo = pubkeyToMemo.get(publicKey)
      if (!memo) {
        return
      }

      const column = addressIndex + 1
      const row = accountIndex + 1

      points.push({
        id: `tag-${namespace}-${second}-${row}-${column}`,
        time: second,
        row,
        column,
        xPercent: pointPositionPercent(addressIndex, NUM_TAG_ADDRESSES),
        yPercent: pointPositionPercent(accountIndex, NUM_TAG_ACCOUNTS),
        note: memo,
      })

      pubkeyToMemo.delete(publicKey)
    })

    if (!pubkeyToMemo.size) {
      break
    }
  }

  return points.sort((a, b) => a.time - b.time)
}

function App() {
  const [videos, setVideos] = useState<VideoTrack[]>(
    DEFAULT_VIDEO_IDS.map((id) => createVideoTrack(id, `https://www.youtube.com/watch?v=${id}`)),
  )
  const [gridScale, setGridScale] = useState(1)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [videoInput, setVideoInput] = useState('')
  const [videoError, setVideoError] = useState<string | null>(null)
  const [activeVideoKey, setActiveVideoKey] = useState<string | null>(null)
  const [editingPoint, setEditingPoint] = useState<{
    videoKey: string
    pointId: string
  } | null>(null)
  const [playbackStates, setPlaybackStates] = useState<Record<string, PlaybackState>>({})
  const [graphVersion, setGraphVersion] = useState(0)

  const containerRefs = useRef(new Map<string, HTMLDivElement | null>())
  const overlayRefs = useRef(new Map<string, HTMLDivElement | null>())
  const playerRefs = useRef(new Map<string, YouTubePlayer>())
  const namespaceGraphs = useRef(new Map<string, GraphNode[]>())
  const computedTagDurations = useRef(new Set<string>())

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
    const controller = new AbortController()

    requestGraph(GRAPH_REQUEST_BODY.body.public_key, controller.signal)
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
        console.error('Error fetching video graph', error)
      })

    return () => {
      isActive = false
      controller.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    videos.forEach((video) => {
      if (!video.namespace || namespaceGraphs.current.has(video.namespace)) {
        return
      }

      const graphKey = publicKeyForNamespace(video.namespace)
      requestGraph(graphKey, controller.signal)
        .then((graph) => {
          if (!graph || controller.signal.aborted || !video.namespace) {
            return
          }

          namespaceGraphs.current.set(video.namespace, parseGraphNodes(graph))
          setGraphVersion((previous) => previous + 1)
        })
        .catch((error) => {
          console.error(`Error fetching tag graph for namespace ${video.namespace}`, error)
        })
    })

    return () => {
      controller.abort()
    }
  }, [videos])

  useEffect(() => {
    computedTagDurations.current.clear()
  }, [graphVersion])

  useEffect(() => {
    const updates: Record<string, PointOfInterest[]> = {}

    videos.forEach((video) => {
      if (!video.namespace) {
        return
      }

      const nodes = namespaceGraphs.current.get(video.namespace)
      if (!nodes?.length) {
        return
      }

      const durationSeconds = Math.floor(playbackStates[video.key]?.duration ?? 0)
      if (durationSeconds <= 0) {
        return
      }

      const computeKey = `${video.key}:${durationSeconds}`
      if (computedTagDurations.current.has(computeKey)) {
        return
      }

      const tagPoints = correlateGraphTags(video.namespace, durationSeconds, nodes)
      computedTagDurations.current.add(computeKey)
      updates[video.key] = tagPoints
    })

    const updateKeys = Object.keys(updates)
    if (!updateKeys.length) {
      return
    }

    setVideos((previous) =>
      previous.map((video) => {
        const tagPoints = updates[video.key]
        if (!tagPoints) {
          return video
        }

        const manualPoints = video.points.filter((point) => !point.id.startsWith('tag-'))
        const mergedPoints = [...tagPoints, ...manualPoints].sort((a, b) => a.time - b.time)

        return {
          ...video,
          points: mergedPoints,
        }
      }),
    )
  }, [videos, playbackStates, graphVersion])

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
                  point.id === pointId
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
    [columns, rows, logVideoPoints, startEditingPoint],
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
      <header className="app__header">
        <h1>Vertical Video Annotator</h1>
        <p className="app__subtitle">
          Scroll through the feed, automatically focus on the active video, and tap the grid to
          capture annotations in real time.
        </p>
      </header>

      <div className="feed">
        {videos.map((video) => {
          const playback = playbackStates[video.key] ?? { currentTime: 0, duration: 0 }
          const activePoints = video.points.filter(
            (point) => Math.abs(point.time - playback.currentTime) <= VISIBLE_POINT_WINDOW / 2,
          )
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
                    <span className="video-card__namespace">{video.namespace}</span>
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
                    const isEditing =
                      editingPoint?.videoKey === video.key && editingPoint.pointId === point.id

                    return (
                      <div
                        key={point.id}
                        className={isEditing ? 'poi-marker poi-marker--editing' : 'poi-marker'}
                        style={{
                          left: `${point.xPercent}%`,
                          top: `${point.yPercent}%`,
                        }}
                      >
                        <span className="poi-callout__time">{formatTimecode(point.time)}</span>
                        {isEditing ? (
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
                        ) : (
                          <button
                            type="button"
                            className="poi-marker__trigger"
                            onClick={() => startEditingPoint(video.key, point.id)}
                          >
                            <span className="poi-callout__note">
                              {point.note ? point.note : 'Add a note'}
                            </span>
                          </button>
                        )}
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
