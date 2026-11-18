import type { IceServer, ServerMessage, VoiceParticipant } from '@pulse/protocol';
import { toast, usePulse } from '../store';
import { send } from './client';

/**
 * Group voice: a full mesh of peer-to-peer WebRTC audio connections (fine up to ~8 people; larger rooms need an SFU).
 * The server only relays signalling (SDP + ICE) between members of the same voice channel; audio never touches it.
 * Negotiation follows the W3C "perfect negotiation" pattern so simultaneous offers can't deadlock.
 */

type Peer = {
  id: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  audio: HTMLAudioElement;
  /** Serialises signal handling so candidates never race their description. */
  queue: Promise<void>;
  analyser: AnalyserNode | null;
};

const store = () => usePulse.getState();
const peers = new Map<string, Peer>();
let localStream: MediaStream | null = null;
let localAnalyser: AnalyserNode | null = null;
let iceServers: RTCIceServer[] = [];
let selfId: string | null = null;
let audioCtx: AudioContext | null = null;
let levelTimer: ReturnType<typeof setInterval> | null = null;

/* ------------------------------------------------------------------ public actions */

export async function joinVoice(roomId: string): Promise<void> {
  const current = store().voice;
  if (current?.roomId === roomId) return;
  if (current) leaveVoice();
  if (!navigator.mediaDevices?.getUserMedia) { toast('Voice needs a secure (HTTPS) connection and a browser with microphone support', 'error'); return; }
  store().set({ voice: { roomId, muted: false, connecting: true, selfId: null } });
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch (err) {
    store().set({ voice: null });
    const name = (err as DOMException).name;
    toast(name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in your browser settings to join voice.' : name === 'NotFoundError' ? 'No microphone found' : `Could not start the microphone: ${(err as Error).message}`, 'error');
    return;
  }
  audioCtx ??= new AudioContext();
  void audioCtx.resume();
  localAnalyser = analyse(localStream);
  startLevels();
  if (!send({ type: 'voice.join', requestId: `voice:${roomId}`, payload: { roomId, muted: false } })) {
    toast('You are offline', 'error');
    teardown();
  }
}

export function leaveVoice(): void {
  send({ type: 'voice.leave', requestId: 'voice-leave' });
  teardown();
}

export function toggleMute(): void {
  const voice = store().voice;
  if (!voice || !localStream) return;
  const muted = !voice.muted;
  for (const track of localStream.getAudioTracks()) track.enabled = !muted;
  store().set({ voice: { ...voice, muted } });
  send({ type: 'voice.mute', requestId: 'mute', payload: { muted } });
}

/* ------------------------------------------------------------------ server events (called from client.ts) */

export function onVoiceJoined(payload: Extract<ServerMessage, { type: 'voice.joined' }>['payload']): void {
  const voice = store().voice;
  if (!voice || voice.roomId !== payload.roomId) { send({ type: 'voice.leave', requestId: 'voice-stale' }); return; }
  selfId = payload.sessionId;
  iceServers = payload.iceServers.map(toRtcIceServer);
  store().set({ voice: { ...voice, connecting: false, selfId: payload.sessionId } });
  if (voice.muted) send({ type: 'voice.mute', requestId: 'mute', payload: { muted: true } });
  syncPeers(store().voiceRooms[payload.roomId] ?? []);
}

export function onVoiceState(payload: Extract<ServerMessage, { type: 'voice.state' }>['payload']): void {
  store().set((s) => ({ voiceRooms: { ...s.voiceRooms, [payload.roomId]: payload.participants } }));
  if (store().voice?.roomId === payload.roomId && selfId) syncPeers(payload.participants);
}

export function onVoiceLeft(payload: { roomId: string }): void {
  if (store().voice?.roomId === payload.roomId && !store().voice?.connecting) teardown();
}

export function onSignal(payload: Extract<ServerMessage, { type: 'rtc.signal' }>['payload']): void {
  if (!store().voice || !selfId || !localStream) return;
  const peer = peers.get(payload.from) ?? createPeer(payload.from);
  peer.queue = peer.queue.then(() => handleSignal(peer, payload)).catch((err) => console.warn('[voice] signal error', err));
}

/** The WebSocket reconnected with a new session: drop old peer links and rejoin with the same microphone. */
export function onReconnected(): void {
  const voice = store().voice;
  if (!voice || !localStream) return;
  for (const id of [...peers.keys()]) closePeer(id);
  selfId = null;
  store().set({ voice: { ...voice, connecting: true, selfId: null } });
  send({ type: 'voice.join', requestId: `voice:${voice.roomId}`, payload: { roomId: voice.roomId, muted: voice.muted } });
}

/* ------------------------------------------------------------------ peers */

function syncPeers(participants: VoiceParticipant[]): void {
  const ids = new Set(participants.map((p) => p.sessionId));
  for (const id of ids) if (id !== selfId && !peers.has(id)) createPeer(id);
  for (const id of [...peers.keys()]) if (!ids.has(id)) closePeer(id);
}

function signal(to: string, data: { description?: RTCSessionDescriptionInit | null; candidate?: RTCIceCandidateInit | null }): void {
  const payload: Extract<import('@pulse/protocol').ClientMessage, { type: 'rtc.signal' }>['payload'] = { to };
  if (data.description) payload.description = { type: data.description.type as 'offer' | 'answer', sdp: data.description.sdp };
  if (data.candidate !== undefined) payload.candidate = data.candidate ? { candidate: data.candidate.candidate ?? '', sdpMid: data.candidate.sdpMid ?? null, sdpMLineIndex: data.candidate.sdpMLineIndex ?? null, usernameFragment: data.candidate.usernameFragment ?? null } : null;
  send({ type: 'rtc.signal', requestId: 'rtc', payload });
}

function createPeer(id: string): Peer {
  const pc = new RTCPeerConnection({ iceServers });
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.setAttribute('playsinline', '');
  audio.dataset.peer = id;
  audio.hidden = true;
  document.body.append(audio);
  const peer: Peer = { id, pc, polite: (selfId ?? '') < id, makingOffer: false, ignoreOffer: false, audio, queue: Promise.resolve(), analyser: null };
  peers.set(id, peer);
  for (const track of localStream?.getTracks() ?? []) pc.addTrack(track, localStream!);

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      signal(id, { description: pc.localDescription });
    } catch (err) { console.warn('[voice] negotiation failed', err); } finally { peer.makingOffer = false; }
  };
  pc.onicecandidate = ({ candidate }) => signal(id, { candidate: candidate ? candidate.toJSON() : null });
  pc.ontrack = ({ streams, track }) => {
    const stream = streams[0] ?? new MediaStream([track]);
    audio.srcObject = stream;
    void audio.play().catch(() => toast('Tap anywhere to enable voice audio'));
    peer.analyser = analyse(stream);
  };
  // Network change (Wi-Fi ↔ mobile data) or a dropped path: renegotiate ICE instead of giving up.
  pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.restartIce(); };
  pc.onconnectionstatechange = () => {
    store().set((s) => ({ peerStates: { ...s.peerStates, [id]: pc.connectionState } }));
  };
  return peer;
}

async function handleSignal(peer: Peer, { description, candidate }: Extract<ServerMessage, { type: 'rtc.signal' }>['payload']): Promise<void> {
  const { pc } = peer;
  if (description) {
    const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    await pc.setRemoteDescription(description as RTCSessionDescriptionInit);
    if (description.type === 'offer') {
      await pc.setLocalDescription();
      signal(peer.id, { description: pc.localDescription });
    }
  } else if (candidate !== undefined) {
    try { await pc.addIceCandidate(candidate ? (candidate as RTCIceCandidateInit) : undefined); } catch (err) { if (!peer.ignoreOffer) throw err; }
  }
}

function closePeer(id: string): void {
  const peer = peers.get(id);
  if (!peer) return;
  peers.delete(id);
  peer.pc.close();
  peer.audio.srcObject = null;
  peer.audio.remove();
  store().set((s) => {
    const { [id]: _p, ...peerStates } = s.peerStates;
    const { [id]: _s, ...speaking } = s.speaking;
    return { peerStates, speaking };
  });
}

function teardown(): void {
  for (const id of [...peers.keys()]) closePeer(id);
  for (const track of localStream?.getTracks() ?? []) track.stop();
  localStream = null;
  localAnalyser = null;
  selfId = null;
  if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
  lastLoud.clear();
  store().set({ voice: null, speaking: {}, peerStates: {} });
}

/* ------------------------------------------------------------------ speaking detection */

function analyse(stream: MediaStream): AnalyserNode | null {
  if (!audioCtx) return null;
  try {
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048; // ~45 ms window per sample
    source.connect(analyser);
    return analyser;
  } catch { return null; }
}

function level(analyser: AnalyserNode | null): number {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
  return Math.sqrt(sum / data.length);
}

/** Last time each stream was above the speaking threshold; 'speaking' is held briefly so short sounds and pauses don't flicker. */
const lastLoud = new Map<string, number>();
const SPEAKING_THRESHOLD = 0.03;
const SPEAKING_HOLD_MS = 400;

function isSpeaking(id: string, analyser: AnalyserNode | null, now: number): boolean {
  if (level(analyser) > SPEAKING_THRESHOLD) lastLoud.set(id, now);
  return now - (lastLoud.get(id) ?? 0) < SPEAKING_HOLD_MS;
}

function startLevels(): void {
  if (levelTimer) return;
  levelTimer = setInterval(() => {
    const voice = store().voice;
    const now = performance.now();
    const next: Record<string, boolean> = { self: !voice?.muted && isSpeaking('self', localAnalyser, now) };
    for (const [id, peer] of peers) next[id] = isSpeaking(id, peer.analyser, now);
    const prev = store().speaking;
    if (Object.keys(next).some((k) => next[k] !== !!prev[k]) || Object.keys(prev).length !== Object.keys(next).length) store().set({ speaking: next });
  }, 100);
}

function toRtcIceServer(s: IceServer): RTCIceServer {
  return { urls: s.urls, ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: s.credential } : {}) };
}

/** Exposed for diagnostics/E2E. */
export function voiceDebug(): { selfId: string | null; peers: Record<string, RTCPeerConnectionState> } {
  return { selfId, peers: Object.fromEntries([...peers].map(([id, p]) => [id, p.pc.connectionState])) };
}
(globalThis as { __pulseVoiceDebug?: typeof voiceDebug }).__pulseVoiceDebug = voiceDebug;
